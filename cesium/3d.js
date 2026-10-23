/* ═══════════════════════════════════════════════════════════════════
   GOD'S EYE VIEW · 全球航班实时监视
   ───────────────────────────────────────────────────────────────────
   渲染层移植自 gods-eye-view (MIT) 的视觉语言：
     · 飞机图标 = aircraftIcons.js 的机型剪影（10 类）
     · 机型分类 = aircraftClass.js
     · 配色/玻璃 HUD = foundation.css 的 dark sci-fi token
   渲染实现走 Cesium 原生 primitive（BillboardCollection /
   PolylineCollection），不用 Entity API：万级目标下 Entity 的
   Property 开销过大，且 primitive 对 billboard 生命周期控制更直接。
   ═══════════════════════════════════════════════════════════════════ */

import { aircraftIcon } from "../js/gev-icons.js";
import { classifyAircraft, CLASS_SCALE_2D } from "../js/gev-class.js";

// 数据走同站点相对路径（GitHub Pages），不依赖 raw.githubusercontent.com
const DATA_URL   = "../data/flights.json";
const TRACKS_URL = "../data/tracks.json";

// ── 主题色（与 3d.html 的 CSS token 对齐）─────────────────────────
const C_AIR   = Cesium.Color.fromCssColorString("#00d4ff");        // 飞行中
const C_GND   = Cesium.Color.fromCssColorString("#5c6779");        // 地面/低空
const C_SEL   = Cesium.Color.fromCssColorString("#ffb020");        // 选中
const C_TRAIL = Cesium.Color.fromCssColorString("#00d4ff");
const C_TRAIL_SEL = Cesium.Color.fromCssColorString("#ffb020");

// ── DOM ───────────────────────────────────────────────────────────
const el = {
  q: document.getElementById("q"),
  go: document.getElementById("go"),
  clear: document.getElementById("clear"),
  list: document.getElementById("list"),
  count: document.getElementById("count"),
  hudCount: document.getElementById("hudCount"),
  hudTime: document.getElementById("hudTime"),
  status: document.getElementById("status"),
  gen: document.getElementById("gen"),
  auto: document.getElementById("auto"),
  boot: document.getElementById("boot"),
  rLat: document.getElementById("rLat"),
  rLon: document.getElementById("rLon"),
  rAlt: document.getElementById("rAlt"),
  rFps: document.getElementById("rFps"),
  detail: document.getElementById("detail"),
  dtCs: document.getElementById("dtCs"),
  dtAir: document.getElementById("dtAir"),
  dtBody: document.getElementById("dtBody"),
  dtClose: document.getElementById("dtClose"),
  quickTags: document.getElementById("quickTags"),
};

// ── 运行时状态 ────────────────────────────────────────────────────
let viewer = null;
let billboards = null;      // Cesium.BillboardCollection
let trails = null;          // Cesium.PolylineCollection
let selRing = null;         // 选中光环 billboard
let satLayerRef = null;     // 卫星底图图层（用于按高度调节明暗）

let flights = [];           // 当前快照全量
let tracks = {};            // callsign -> [{lat,lon,alt,t}]
let matchedList = [];       // 当前筛选结果

const planeMap = new Map(); // callsign -> billboard
const trailMap = new Map(); // callsign -> polyline
const iconCache = new Map();// kind -> canvas

let selected = null;
let refreshTimer = null;
let lastSnapshot = null;   // 上次处理的快照标识，用于跳过无变化的重绘

// ═══════════════════════════════════════════════════════════════════
// 1. 图标光栅化
//    gev-icons 产出 SVG data URI；Cesium 的 billboard 纹理走
//    <img> 解码路径，直接喂 SVG 在部分内核上会静默失败（这正是
//    旧版 1097 架飞机全部不显示的根因）。这里先用 canvas 光栅化
//    成位图再交给 billboard，跨内核稳定。
// ═══════════════════════════════════════════════════════════════════
const ICON_PX = 96;

function rasterizeSvg(svgUri, px) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = px; c.height = px;
        c.getContext("2d").drawImage(img, 0, 0, px, px);
        resolve(c);
      } catch (e) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = svgUri;
  });
}

async function buildIcons() {
  const kinds = Object.keys(CLASS_SCALE_2D);
  await Promise.all(kinds.map(async (k) => {
    const canvas = await rasterizeSvg(aircraftIcon(k, ICON_PX), ICON_PX);
    if (canvas) iconCache.set(k, canvas);
  }));
  // 兜底：任何机型缺失都用窄体客机
  if (!iconCache.size) {
    const c = await rasterizeSvg(aircraftIcon("airliner", ICON_PX), ICON_PX);
    if (c) iconCache.set("airliner", c);
  }
  return iconCache.size;
}

// 选中光环：径向渐变圆环
function buildRing() {
  const S = 128, c = document.createElement("canvas");
  c.width = S; c.height = S;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.20, S / 2, S / 2, S * 0.48);
  g.addColorStop(0, "rgba(255,176,32,0)");
  g.addColorStop(0.72, "rgba(255,176,32,0.55)");
  g.addColorStop(0.9, "rgba(255,176,32,0.95)");
  g.addColorStop(1, "rgba(255,176,32,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

// ═══════════════════════════════════════════════════════════════════
// 2. 场景初始化
// ═══════════════════════════════════════════════════════════════════
function initViewer() {
  viewer = new Cesium.Viewer("cesiumContainer", {
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: true,
    infoBox: false,
    selectionIndicator: false,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    // 不加载 Cesium 默认的 Bing/ION 底图（需 token，会 401）
    baseLayer: false,
  });

  const scene = viewer.scene;
  scene.backgroundColor = Cesium.Color.fromCssColorString("#05060a");
  scene.globe.baseColor = Cesium.Color.fromCssColorString("#0a1018");

  // 大气与光照：关掉太阳直射光照，改用压暗的影像 + 大气辉光，
  // 得到 god-eye-view 那种"监视屏"观感（否则白天半球过曝、夜间全黑）
  scene.globe.showGroundAtmosphere = true;
  scene.globe.enableLighting = false;
  scene.globe.atmosphereLightIntensity = 26.0;
  scene.globe.atmosphereBrightnessShift = 0.02;
  scene.globe.atmosphereSaturationShift = 0.35;
  scene.skyAtmosphere.brightnessShift = -0.22;
  scene.skyAtmosphere.saturationShift = 0.25;
  scene.fog.enabled = true;
  scene.fog.density = 0.00002;

  // 星空
  scene.skyBox.show = true;

  // ── 发光后处理（god-eye-view 的光晕来源）───────────────────────
  const bloom = scene.postProcessStages.bloom;
  bloom.enabled = true;
  bloom.uniforms.glowOnly = false;
  bloom.uniforms.contrast = 156;
  bloom.uniforms.brightness = -0.42;
  bloom.uniforms.delta = 1.0;
  bloom.uniforms.sigma = 3.4;
  bloom.uniforms.stepSize = 3.0;

  // 抗锯齿，避免细轨迹线出现阶梯
  scene.postProcessStages.fxaa.enabled = true;

  addImagery();

  // 相机：欧亚大陆俯视，略带倾斜（god-eye-view 的标志性视角）
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(104, 28, 6_800_000),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-72),
      roll: 0,
    },
  });

  billboards = scene.primitives.add(new Cesium.BillboardCollection({ scene }));
  trails = scene.primitives.add(new Cesium.PolylineCollection());

  selRing = billboards.add({
    position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
    image: buildRing(),
    width: 96, height: 96,
    show: false,
    color: Cesium.Color.WHITE,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  });

  bindSceneEvents();
  startReadout();
}

function addImagery() {
  // 高德卫星影像 —— 子域必须是 webst01~webst04（两位数字）。
  // 旧代码用 ["0","1","2","3"] 拼成 webrd0.is.autonavi.com，域名不存在，
  // 导致所有瓦片 ERR_NAME_NOT_RESOLVED、地球全黑。
  const sat = new Cesium.UrlTemplateImageryProvider({
    url: "https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}",
    subdomains: ["1", "2", "3", "4"],
    maximumLevel: 18,
    credit: "高德地图",
  });
  const satLayer = viewer.imageryLayers.addImageryProvider(sat);
  satLayerRef = satLayer;
  // 压暗 + 降饱和，让地表退到背景，飞机与轨迹的发光成为主体
  satLayer.brightness = 0.40;
  satLayer.contrast = 1.30;
  satLayer.saturation = 0.22;
  satLayer.gamma = 0.86;
  // 色相转向冷蓝：卫星图原始偏灰绿，旋到蓝青区间才像"夜视监视屏"
  satLayer.hue = 2.15; // 初始即全球视角

  // 半透明路网叠加：补出城市与国界，强化"监控底图"的层次
  const road = new Cesium.UrlTemplateImageryProvider({
    url: "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
    subdomains: ["1", "2", "3", "4"],
    maximumLevel: 18,
  });
  const layer = viewer.imageryLayers.addImageryProvider(road);
  layer.alpha = 0.22;
  layer.brightness = 0.4;
  layer.saturation = 0.15;
}

// ═══════════════════════════════════════════════════════════════════
// 3. 数据加载
// ═══════════════════════════════════════════════════════════════════
async function fetchJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

function setStatus(kind, msg) {
  el.status.className = "status-line" + (kind ? " " + kind : "");
  el.status.textContent = msg;
}

async function loadTracks() {
  try {
    const d = await fetchJson(TRACKS_URL);
    tracks = d.tracks || {};
    el.gen.textContent = "轨迹 " + Object.keys(tracks).length;
  } catch (e) {
    /* 轨迹缺失不阻塞主流程 */
  }
}

async function loadFlights(force) {
  try {
    const d = await fetchJson(DATA_URL);

    // 后端每 15 分钟才更新一次快照，10 秒轮询大多拿到同一份数据。
    // 快照没变就不重绘——否则列表 DOM 每 10 秒重建一次，
    // 用户正在滚动或点击时会被打断。
    if (!force && d.generated && d.generated === lastSnapshot) {
      el.hudTime.textContent = fmtTime(d.time || d.generated);
      return;
    }
    lastSnapshot = d.generated || lastSnapshot;

    flights = (d.flights || []).filter(
      (f) => f && f.callsign && Number.isFinite(f.lat) && Number.isFinite(f.lon)
    );
    el.hudTime.textContent = fmtTime(d.time || d.generated);
    render();
    setStatus("ok", `已锁定 ${flights.length} 架 · 快照 ${fmtShort(d.generated)}`);
  } catch (e) {
    setStatus("err", "数据获取失败：" + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 4. 筛选
// ═══════════════════════════════════════════════════════════════════
function normQuery() {
  return (el.q.value || "").trim().toUpperCase();
}

function matchFlight(f, q) {
  if (!q) return true;
  const cs = (f.callsign || "").toUpperCase();

  // 完整航班号（CCA1501 / CA1501）：只按号码匹配。
  // 若继续往下展开成航司前缀，输入 CCA1501 会把全部国航都命中。
  if (/^[A-Z0-9]{2,3}\d{1,4}$/.test(q)) return cs.startsWith(q);

  if (cs === q || cs.startsWith(q)) return true;
  const prefix = window.resolveAirlinePrefix ? window.resolveAirlinePrefix(q) : null;
  if (prefix && cs.startsWith(prefix)) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════════
// 5. 渲染：飞机 / 轨迹 / 列表
// ═══════════════════════════════════════════════════════════════════
function altMeters(f) {
  // 数据里 alt 已经是米（OpenSky baro_altitude 单位 m）。
  // 旧代码误按英尺换算 *0.3048，把 10668 m 压成 3.2 km，飞机贴地。
  return Number.isFinite(f.alt) ? f.alt : 0;
}

function planeSize(f) {
  const cls = classifyAircraft({ category: f.cat });
  const base = CLASS_SCALE_2D[cls] || 0.85;
  return 26 * base * (altMeters(f) > 1500 ? 1 : 0.8);
}

function render() {
  const q = normQuery();
  matchedList = flights.filter((f) => matchFlight(f, q));
  updatePlanes(matchedList);
  updateTrails();
  renderList();
  el.count.textContent = matchedList.length;
  el.hudCount.textContent = flights.length;
}

function updatePlanes(list) {
  const alive = new Set();

  for (const f of list) {
    const cls = classifyAircraft({ category: f.cat });
    const img = iconCache.get(cls) || iconCache.get("airliner");
    if (!img) continue;

    const cs = f.callsign;
    alive.add(cs);
    const isSel = cs === selected;
    const size = planeSize(f) * (isSel ? 1.35 : 1);
    const pos = Cesium.Cartesian3.fromDegrees(f.lon, f.lat, altMeters(f) + 400);

    let bb = planeMap.get(cs);
    if (!bb) {
      bb = billboards.add({
        position: pos,
        image: img,
        width: size, height: size,
        rotation: Cesium.Math.toRadians(-(f.track || 0)),
        alignedAxis: Cesium.Cartesian3.UNIT_Z,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        color: altMeters(f) > 1500 ? C_AIR : C_GND,
        disableDepthTestDistance: 0,
        // 远景自动缩小：全球视角下密集空域不会糊成一团光斑
        scaleByDistance: new Cesium.NearFarScalar(8e5, 1.15, 9e6, 0.42),
        id: cs,
      });
      planeMap.set(cs, bb);
    } else {
      bb.position = pos;
      bb.width = size;
      bb.height = size;
      bb.rotation = Cesium.Math.toRadians(-(f.track || 0));
      bb.color = isSel ? C_SEL : altMeters(f) > 1500 ? C_AIR : C_GND;
      bb.image = img;
    }
  }

  // 移除已不在结果集的飞机
  for (const [cs, bb] of planeMap) {
    if (!alive.has(cs)) {
      billboards.remove(bb);
      planeMap.delete(cs);
    }
  }

  // 选中光环
  const sf = flights.find((x) => x.callsign === selected);
  if (sf) {
    selRing.show = true;
    selRing.position = Cesium.Cartesian3.fromDegrees(sf.lon, sf.lat, altMeters(sf) + 400);
    selRing.width = planeSize(sf) * 3.2;
    selRing.height = planeSize(sf) * 3.2;
  } else {
    selRing.show = false;
  }
}

function updateTrails() {
  const alive = new Set();

  for (const f of matchedList) {
    const tr = tracks[f.callsign];
    if (!tr || tr.length < 2) continue;

    const isSel = f.callsign === selected;
    const pts = [];
    for (const p of tr) {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
      pts.push(p.lon, p.lat, (Number.isFinite(p.alt) ? p.alt : 0) + 300);
    }
    if (!Number.isFinite(f.lon) || !Number.isFinite(f.lat)) continue;
    pts.push(f.lon, f.lat, altMeters(f) + 300);
    if (pts.length < 6) continue;

    alive.add(f.callsign);

    const positions = Cesium.Cartesian3.fromDegreesArrayHeights(pts);
    let pl = trailMap.get(f.callsign);

    if (!pl) {
      pl = trails.add({
        positions,
        width: isSel ? 2.4 : 0.9,
        material: Cesium.Material.fromType("Color", {
          color: isSel ? C_TRAIL_SEL.withAlpha(0.95) : C_TRAIL.withAlpha(0.30),
        }),
      });
      trailMap.set(f.callsign, pl);
    } else {
      pl.positions = positions;
      pl.width = isSel ? 2.6 : 1.1;
      pl.material = Cesium.Material.fromType("Color", {
        color: isSel ? C_TRAIL_SEL.withAlpha(0.95) : C_TRAIL.withAlpha(0.30),
      });
    }
  }

  for (const [cs, pl] of trailMap) {
    if (!alive.has(cs)) {
      trails.remove(pl);
      trailMap.delete(cs);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// 6. 列表 / 详情
// ═══════════════════════════════════════════════════════════════════
const CLASS_CN = {
  light: "轻型机", glider: "滑翔机", turboprop: "涡桨", airliner: "窄体客机",
  widebody: "宽体客机", quadjet: "四发喷气", helicopter: "直升机",
  fastjet: "先进喷气", bizjet: "公务机", uav: "无人机",
};

function renderList() {
  const n = matchedList.length;
  el.count.textContent = n;

  if (!n) {
    el.list.innerHTML = '<div class="empty">无匹配目标<br>换个航班号或航司代码试试</div>';
    return;
  }

  // 选中项置顶；其余按高度降序（正在飞行的优先）
  const arr = matchedList.slice().sort((a, b) => {
    if (a.callsign === selected) return -1;
    if (b.callsign === selected) return 1;
    return altMeters(b) - altMeters(a);
  });

  const LIMIT = 120; // 列表只渲染前 120 条，避免 DOM 过重
  const frag = document.createDocumentFragment();

  for (const f of arr.slice(0, LIMIT)) {
    const cls = classifyAircraft({ category: f.cat });
    const on = f.callsign === selected;
    const flying = altMeters(f) > 1500;
    // 数据源未提供 category/typecode 时，机型一栏改显示注册国，信息量更大
    const typeCell = Number.isFinite(f.cat) ? (CLASS_CN[cls] || cls) : (f.country || "—");

    const card = document.createElement("div");
    card.className = "fcard" + (on ? " on" : "");
    card.dataset.cs = f.callsign;
    card.innerHTML =
      `<div class="fc-top">
         <span class="fc-cs">${esc(f.callsign)}</span>
         <span class="fc-air">${esc(airlineCn(f.callsign))}</span>
         <span class="fc-st ${flying ? "air" : "gnd"}">${flying ? "AIR" : "GND"}</span>
       </div>
       <div class="fc-grid">
         <div><span class="k">${Number.isFinite(f.cat) ? "机型" : "注册国"}</span><span class="v">${esc(typeCell)}</span></div>
         <div><span class="k">高度</span><span class="v">${(altMeters(f) / 1000).toFixed(1)} km</span></div>
         <div><span class="k">地速</span><span class="v">${velKmh(f) || "—"} km/h</span></div>
         <div><span class="k">航向</span><span class="v">${Number.isFinite(f.track) ? Math.round(f.track) + "°" : "—"}</span></div>
       </div>`;
    frag.appendChild(card);
  }

  if (arr.length > LIMIT) {
    const more = document.createElement("div");
    more.className = "empty";
    more.textContent = `仅显示前 ${LIMIT} 条（共 ${arr.length} 条），请细化筛选条件`;
    frag.appendChild(more);
  }

  el.list.innerHTML = "";
  el.list.appendChild(frag);
}

function showDetail(f) {
  if (!f) { el.detail.classList.remove("show"); return; }
  const cls = classifyAircraft({ category: f.cat });
  el.dtCs.textContent = f.callsign;
  el.dtAir.textContent = airlineCn(f.callsign) || f.country || "未知航司";
  el.detail.classList.add("show");

  const cells = [
    ["机型", CLASS_CN[cls] || cls],
    ["高度", `${(altMeters(f) / 1000).toFixed(2)} <small>km</small>`],
    ["地速", `${velKmh(f) || "—"} <small>km/h</small>`],
    ["航向", `${Number.isFinite(f.track) ? Math.round(f.track) : "—"} <small>°</small>`],
    ["经纬度", `${f.lat.toFixed(2)}, ${f.lon.toFixed(2)}`],
    ["ICAO24", f.icao24 ? String(f.icao24).toUpperCase() : "—"],
  ];
  el.dtBody.innerHTML = cells
    .map(([k, v]) => `<div class="cell"><span class="k">${k}</span><span class="v">${v}</span></div>`)
    .join("");
}

function select(cs, fly) {
  selected = selected === cs ? null : cs;
  render();
  if (selected) {
    const f = flights.find((x) => x.callsign === selected);
    showDetail(f);
    if (fly && f) flyTo(f);
  } else {
    showDetail(null);
  }
}

function flyTo(f) {
  // 相机放在目标侧后方：向南偏移 0.22° 再压低俯角，
  // 既能看到地面细节，又保留"斜视地球"的立体感（god-eye-view 的跟拍机位）。
  const alt = altMeters(f);
  const height = Math.max(alt * 2.2, 18_000);
  const dLat = Math.min(0.45, height / 450_000);

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(f.lon, f.lat - dLat, height),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-74), roll: 0 },
    duration: 1.6,
  });
}

// ═══════════════════════════════════════════════════════════════════
// 7. 工具
// ═══════════════════════════════════════════════════════════════════
function velKmh(f) {
  // vel 单位 m/s → km/h
  return Number.isFinite(f.vel) && f.vel > 0 ? Math.round(f.vel * 3.6) : 0;
}

function airlineCn(cs) {
  if (!cs) return "";
  const air = window.AIRLINE_KEYS;
  if (!air) return "";
  const code = String(cs).toUpperCase();
  const hit = air.get(code.slice(0, 3)) || air.get(code.slice(0, 2));
  return (hit && hit.cn) || "";
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

function fmtTime(t) {
  if (!t) return "—";
  const d = typeof t === "number" ? new Date(t * 1000) : new Date(t);
  if (isNaN(d)) return "—";
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

function fmtShort(t) {
  if (!t) return "—";
  return String(t).replace("T", " ").slice(0, 16);
}

// ═══════════════════════════════════════════════════════════════════
// 8. 交互
// ═══════════════════════════════════════════════════════════════════
function bindSceneEvents() {
  const scene = viewer.scene;
  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);

  handler.setInputAction((e) => {
    const picked = scene.pick(e.position);
    if (picked && picked.id && typeof picked.id === "string") {
      select(picked.id, true);
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // hover 变手型，给出可点击暗示
  handler.setInputAction((e) => {
    const picked = scene.pick(e.endPosition);
    scene.canvas.style.cursor =
      picked && picked.id && typeof picked.id === "string" ? "pointer" : "default";
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
}

let lastFpsT = 0, lastFpsN = 0;

function startReadout() {
  viewer.scene.postRender.addEventListener(() => {
    const now = performance.now();
    const carto = viewer.camera.positionCartographic;
    el.rLat.textContent = Cesium.Math.toDegrees(carto.latitude).toFixed(2) + "°";
    el.rLon.textContent = Cesium.Math.toDegrees(carto.longitude).toFixed(2) + "°";
    el.rAlt.textContent = (carto.height / 1000).toFixed(0) + " km";

    // 地表明暗随视高自适应：远景压暗出氛围，近景提亮看清地面细节
    if (satLayerRef) {
      const h = carto.height;
      const t = Math.min(1, Math.max(0, (h - 120_000) / 2_400_000)); // 0=贴近地面 1=全球
      satLayerRef.brightness = 0.84 - 0.46 * t;
      satLayerRef.saturation = 0.42 - 0.20 * t;
      satLayerRef.contrast = 1.10 + 0.20 * t;
      // 色相：全球视角旋向冷蓝（夜视感），贴近地面时归零还原真实地貌
      satLayerRef.hue = 2.15 * t;
    }

    lastFpsN++;
    if (now - lastFpsT > 800) {
      el.rFps.textContent = Math.round((lastFpsN * 1000) / (now - lastFpsT));
      lastFpsT = now;
      lastFpsN = 0;
    }
  });
}

function bindUI() {
  el.go.onclick = () => {
    selected = null;
    showDetail(null);
    render();
    const first = matchedList[0];
    if (first && normQuery()) flyTo(first);
  };

  el.q.addEventListener("keydown", (e) => {
    if (e.key === "Enter") el.go.click();
  });

  // 输入即筛（防抖）
  let t = null;
  el.q.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => { selected = null; render(); }, 220);
  });

  el.clear.onclick = () => {
    selected = null;
    el.q.value = "";
    showDetail(null);
    render();
  };

  el.list.addEventListener("click", (e) => {
    const card = e.target.closest(".fcard");
    if (card && card.dataset.cs) select(card.dataset.cs, true);
  });

  el.dtClose.onclick = () => { selected = null; showDetail(null); render(); };

  el.quickTags.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    el.q.value = chip.dataset.q || "";
    [...el.quickTags.children].forEach((c) => c.classList.toggle("on", c === chip));
    selected = null;
    showDetail(null);
    render();
    if (matchedList[0] && el.q.value) flyTo(matchedList[0]);
  });

  el.auto.addEventListener("change", scheduleRefresh);
}

function scheduleRefresh() {
  clearInterval(refreshTimer);
  if (el.auto.checked) refreshTimer = setInterval(() => loadFlights(false), 10_000);
}

// ═══════════════════════════════════════════════════════════════════
// 9. 启动
// ═══════════════════════════════════════════════════════════════════
async function boot() {
  try {
    if (!window.Cesium) throw new Error("Cesium 未加载");
    initViewer();
    bindUI();

    const iconCount = await buildIcons();
    if (!iconCount) throw new Error("机型图标光栅化失败");

    await loadTracks();
    await loadFlights();
    scheduleRefresh();

    el.boot.classList.add("hide");
  } catch (e) {
    console.error(e);
    setStatus("err", "启动失败：" + (e && e.message ? e.message : e));
    el.boot.querySelector(".boot-title").textContent = "ENGINE ERROR";
    el.boot.querySelector(".boot-sub").textContent = String(e && e.message ? e.message : e);
    el.boot.querySelector(".ring").style.borderTopColor = "#ff5b5b";
  }
}

boot();
