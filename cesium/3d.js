// 3D 航班动态核心 · 移植 god-eye-view 渲染逻辑到 Cesium 静态页
import { aircraftIcon, TRACKED_ICON_PX } from "../js/gev-icons.js";
import { classifyAircraft, CLASS_SCALE_2D } from "../js/gev-class.js";

const DATA_URL = "https://raw.githubusercontent.com/makacy-999/flight-tracker/main/data/flights.json";
const TRACKS_URL = "https://raw.githubusercontent.com/makacy-999/flight-tracker/main/data/tracks.json";

const el = {
  q: document.getElementById("q"), go: document.getElementById("go"),
  list: document.getElementById("list"), count: document.getElementById("count"),
  status: document.getElementById("status"), gen: document.getElementById("gen"),
  auto: document.getElementById("auto"), clear: document.getElementById("clear")
};

// ── Cesium Viewer（由 startApp 在 Cesium 引擎就绪后初始化）──
let viewer = null;

function startApp() {
  if (!window.Cesium) return false;
  window.CESIUM_BASE_URL = window.__CESIUM_BASE || "https://cdn.jsdelivr.net/npm/cesium@1.124.0/Build/Cesium";
  viewer = new Cesium.Viewer("cesiumContainer", {
    animation: false, timeline: false, baseLayerPicker: false,
    geocoder: false, homeButton: false, sceneModePicker: false,
    navigationHelpButton: false, fullscreenButton: true,
    infoBox: false, selectionIndicator: false,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
  });
  viewer.scene.globe.enableLighting = true;
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#0a0f1e");
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#04040a");
  // god-eye-view 氛围：大气辉光 + 夜光
  viewer.scene.globe.showGroundAtmosphere = true;
  viewer.scene.globe.atmosphereLightIntensity = 1.2;
  viewer.scene.globe.atmosphereHazeRatio = 0.6;
  viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(106, 35, 2800000) });

  // 高德底图（国内可用）—— {s} 子域语法，{1-4} 是无效语法会导致底图空白
  const gaode = new Cesium.UrlTemplateImageryProvider({
    url: "https://webrd{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}",
    subdomains: ["0", "1", "2", "3"],
    maximumLevel: 18,
  });
  viewer.imageryLayers.addImageryProvider(gaode);
  startApp.__started = true;
  return true;
}

// 等 Cesium 引擎就绪后启动（html 的 fallback loader 会触发，或自轮询）
// 只有一个启动路径：startApp() 成功后必须接着 run() 去加载数据、渲染飞机。
function boot() {
  if (startApp.__started) { run(); return; }
  if (window.Cesium && startApp()) { run(); }
}
window.__GEVINIT = boot;
// 若 Cesium 尚未就绪（module 先于动态 script 执行），注册就绪回调并短暂轮询兜底
if (!window.Cesium) {
  window.__GEVINIT = function () { boot(); };
  setTimeout(boot, 500);
} else {
  setTimeout(boot, 50);
}

// ── 状态 ─────────────────────────────────────────────────────
let flights = [];
let tracks = {};        // callsign -> Array<{lat,lon,alt,vel,track,t}>
let billboards = {};    // callsign -> entity
let trackEntities = []; // 轨迹 entity
const seenCalls = new Set();
let selected = null;

// ── 获取数据 ───────────────────────────────────────────────
async function fetchJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function loadTracks() {
  try {
    const d = await fetchJson(TRACKS_URL);
    tracks = d.tracks || {};
    el.gen.textContent = "轨迹快照：" + (d.generated || "").slice(0, 16);
  } catch { /* 轨迹缺失不阻塞 */ }
}

async function loadFlights() {
  setStatus("loading", "加载航班数据…");
  try {
    const d = await fetchJson(DATA_URL);
    flights = d.flights || [];
    updateGen(d.generated);
    setStatus("ok", `已获取 ${flights.length} 架航班 · 时间 ${(d.time||"").slice ? d.time : ts(d.time)}`);
    renderAll();
  } catch (e) {
    setStatus("error", "获取数据失败：" + e.message);
  }
}

function updateGen(g) { if (g) el.gen.textContent = "数据时间：" + g.slice(0, 16); }

function setStatus(k, m) {
  el.status.className = "status" + (k === "ok" ? " ok" : k === "error" ? " error" : k === "loading" ? " loading" : "");
  el.status.textContent = m;
}

// 机型展示名
function classLabel(k) {
  const m = { light:"轻型机", glider:"滑翔机", turboprop:"涡桨", airliner:"窄体客机",
    widebody:"宽体客机", quadjet:"四发喷气", helicopter:"直升机", fastjet:"先进喷气", bizjet:"公务机", uav:"无人机" };
  return m[k] || k;
}

// ── 3D 渲染 ─────────────────────────────────────────────────
function renderPlanes(list) {
  // 重新构建本次航集，供清理判断（修复此前 seenCalls 从来不为空导致每次全删重建的闪烁）
  seenCalls.clear();
  for (const f of list) if (f && f.callsign) seenCalls.add(f.callsign);
  // 移除不在当前集的 billboard
  for (const cs of Object.keys(billboards)) {
    if (!seenCalls.has(cs)) {
      viewer.entities.remove(billboards[cs]);
      delete billboards[cs];
    }
  }
  for (const f of list) {
    if (!isFinite(f.lon) || !isFinite(f.lat)) continue;
    const cls = classifyAircraft({ category: f.cat });
    const kind = cls;
    const scale = (CLASS_SCALE_2D[cls] || 0.85) * (f.alt > 1500 ? 1.0 : 0.7);
    const uri = aircraftIcon(kind, TRACKED_ICON_PX);
    const isSel = selected && f.callsign === selected;
    let ent = billboards[f.callsign];
    if (!ent) {
      ent = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, f.alt * 0.3048 * 1.2),
        billboard: {
          image: uri,
          width: 42 * scale, height: 42 * scale,
          rotation: Cesium.Math.toRadians(-f.track),  // god-eye-view 航向旋转
          alignedAxis: Cesium.Cartesian3.UNIT_Z,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          color: isSel ? Cesium.Color.fromCssColorString("#23c9a0")
                       : (f.alt > 1500 ? Cesium.Color.fromCssColorString("#4ee3bd")
                                       : Cesium.Color.fromCssColorString("#8a8fb0")),
        },
        properties: { callsign: f.callsign },
      });
      billboards[f.callsign] = ent;
    } else {
      ent.position = Cesium.Cartesian3.fromDegrees(f.lon, f.lat, f.alt * 0.3048 * 1.2);
      ent.billboard.rotation = Cesium.Math.toRadians(-f.track);
      ent.billboard.width = 42 * scale;
      ent.billboard.height = 42 * scale;
      ent.billboard.color = isSel ? Cesium.Color.fromCssColorString("#23c9a0")
        : (f.alt > 1500 ? Cesium.Color.fromCssColorString("#4ee3bd")
                        : Cesium.Color.fromCssColorString("#8a8fb0"));
    }
  }
}

function renderTracks(list) {
  viewer.entities.removeAll(trackEntities);
  trackEntities = [];
  for (const f of list) {
    const tr = tracks[f.callsign] || [];
    const pts = tr.map(p => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, (p.alt||0)*0.3048*1.2));
    // 加当前点
    if (isFinite(f.lon) && isFinite(f.lat)) pts.push(Cesium.Cartesian3.fromDegrees(f.lon, f.lat, (f.alt||0)*0.3048*1.2));
    if (pts.length < 2) continue;
    const e = viewer.entities.add({
      polyline: {
        positions: pts,
        width: isSel(f.callsign) ? 3 : 1.6,
        material: isSel(f.callsign)
          ? Cesium.Color.fromCssColorString("#23c9a0").withAlpha(0.9)
          : Cesium.Color.fromCssColorString("#4ee3bd").withAlpha(0.4),
        clampToGround: true,
      },
    });
    trackEntities.push(e);
  }
}

function isSel(cs) { return selected && cs === selected; }

function renderAll() { renderPlanes(matched(flights)); renderTracks(matched(flights)); flySel(); }

// ── 筛选 ─────────────────────────────────────────────────────
function matched(arr) {
  const q = normQuery(el.q.value);
  if (!q) return arr;
  return arr.filter(f => matchFn(f, q));
}

function normQuery(v) {
  v = (v || "").trim().toUpperCase();
  if (!v) return "";
  return v;
}

function matchFn(f, q) {
  const cs = (f.callsign || "").toUpperCase();
  if (!cs) return false;
  if (cs === q) return true;
  // 航班号前缀匹配（如 CCA1654 或 CCA 或 国航/中文航司名）
  const prefix = window.resolveAirlinePrefix ? window.resolveAirlinePrefix(q) : null;   // airlines.js 提供的全局函数
  if (prefix) return cs.startsWith(prefix);
  // q 本身可能就是前缀
  if (/^[A-Z]{2,3}$/.test(q) && cs.startsWith(q)) return true;
  return false;
}

// ── 列表 ─────────────────────────────────────────────────────
function renderList() {
  const list = matched(flights);
  el.count.textContent = list.length;
  if (!list.length) {
    el.list.innerHTML = `<div class="empty">未找到匹配航班。</div>`;
    return;
  }
  el.list.innerHTML = "";
  // 排序：优先选中
  list.sort((a, b) => (b.callsign === selected) - (a.callsign === selected));
  for (const f of list) {
    const cls = classifyAircraft({ category: f.cat });
    const card = document.createElement("div");
    card.className = "card" + (f.callsign === selected ? " on" : "");
    const air = airlineName(f.callsign);
    const altKm = f.alt ? (f.alt * 0.3048 / 1000).toFixed(1) : "—";
    card.innerHTML = `<div class="crtop"><span class="cs">${esc(f.callsign)}</span>
      <span class="air">${esc(air)}</span>
      <span class="st ${f.alt > 1500 ? 'air' : 'ground'}">${f.alt > 1500 ? '飞行' : '地面'}</span></div>
      <div class="cgrid">
        <div><label>机型</label>${classLabel(cls)}</div>
        <div><label>高度</label>${altKm} km</div>
        <div><label>速度</label>${f.vel ? Math.round(f.vel * 1.852) : "—"} km/h</div>
        <div><label>航向</label>${f.track != null ? Math.round(f.track) + "°" : "—"}</div>
      </div>`;
    card.onclick = () => { select(f.callsign); };
    el.list.appendChild(card);
  }
}

function select(cs) {
  selected = (selected === cs) ? null : cs;
  renderAll(); renderList();
  flySel();
}

function flySel() {
  if (!selected) return;
  const f = flights.find(x => x.callsign === selected);
  if (f && isFinite(f.lon) && isFinite(f.lat)) {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, Math.max(f.alt * 0.3048 * 3, 8000)),
      duration: 1.5,
    });
  }
}

function airlineName(cs) {
  // 用同一前缀映射回中文名
  const K = window.AIRLINE_KEYS;
  if (!K) return "";
  const a = K.get(String(cs.slice(0, 3)).trim()) || K.get(String(cs.slice(0, 2)).trim());
  return (a && a.cn) || "";
}

function esc(s) { return String(s || "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c])); }
function ts(x) { if (!x) return "—"; const d = new Date(x * 1000); return d.toLocaleTimeString("zh-CN", { hour12: false }); }

// ── 事件 ─────────────────────────────────────────────────────
el.go.onclick = () => { selected = null; renderAll(); renderList(); if (el.q.value.trim()) flySearch(); };
el.q.addEventListener("keydown", e => { if (e.key === "Enter") el.go.click(); });
el.clear.onclick = () => { selected = null; el.q.value = ""; renderAll(); renderList(); };

function flySearch() {
  const f = matched(flights)[0];
  if (f && isFinite(f.lon) && isFinite(f.lat)) {
    viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, 400000), duration: 2 });
  }
}

// 自动刷新
let timer = null;
function schedule() {
  clearInterval(timer);
  if (el.auto.checked) timer = setInterval(() => { loadFlights(); }, 10000);
}
el.auto.addEventListener("change", schedule);

// ── 启动 ─────────────────────────────────────────────────────
// 数据部分不依赖 Cesium，可立即执行；3D 渲染等 Cesium 就绪后由 startApp 驱动
function run() {
  renderList();
  loadTracks();
  loadFlights();
  schedule();
}
ensureStart();