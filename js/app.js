/* 航班实时动态监控 - 核心逻辑
 * 数据源：OpenSky Network 免费接口（浏览器 CORS 可访问）
 * 地图：Leaflet + OpenStreetMap
 */
(function () {
  "use strict";

  // ---------- 配置 ----------
  // 数据来源：GitHub Actions 定时抓取的静态 JSON（来自 OpenSky，规避其 CORS 限制）
  const DATA_URL = "data/flights.json";
  const TRACKS_URL = "data/tracks.json";
  const REFRESH_MS = 30000;   // 前端定时刷新读取最新 JSON
  const MATCH_CACHE_TTL = 60000;

  // ---------- 状态 ----------
  let map = null;
  let markers = [];            // 当前地图上的 L.Marker
  let currentResults = [];     // 匹配到的航班 states
  let pendingQuery = "";       // 当前查询输入
  let selectedIcao = null;     // 选中的飞机 icao24
  let refreshTimer = null;
  let lastFetchAt = 0;         // 上次抓取（用于提示数据新鲜度）
  let generatedTime = null;    // 数据文件生成时间（Actions 抓取时刻）
  let trackLines = [];         // 轨迹 polyline 图层
  let currentTracks = {};      // 最新轨迹数据
  let localObserved = {};      // 本地观察到的航班位置点（页面存活期间累积）

  // ---------- DOM ----------
  const elInput = document.getElementById("queryInput");
  const elSearch = document.getElementById("searchBtn");
  const elClear = document.getElementById("clearBtn");
  const elAuto = document.getElementById("autoRefresh");
  const elList = document.getElementById("flightList");
  const elCount = document.getElementById("resultCount");
  const elStatus = document.getElementById("statusText");
  const elLast = document.getElementById("lastUpdate");
  const elDetail = document.getElementById("flightDetail");

  // ---------- 工具函数 ----------
  const $ = (sel) => document.querySelector(sel);

  function fmtTime(ts) {
    if (!ts) return "—";
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString("zh-CN", { hour12: false }) + " " + d.toLocaleDateString("zh-CN");
  }

  function fmtAlt(feet) {
    if (feet == null) return "地面/未知";
    const m = Math.round(feet * 0.3048);
    return `${Math.round(feet)} ft (~${m} m)`;
  }

  function fmtSpeed(kn) {
    if (kn == null) return "—";
    return `${Math.round(kn)} kn (~${Math.round(kn * 1.852)} km/h)`;
  }

  function fmtRate(fpm) {
    if (fpm == null) return "—";
    const v = Math.round(fpm * 0.3048);
    return fpm > 0 ? `↑${v} m/min` : fpm < 0 ? `↓${Math.abs(v)} m/min` : "平飞";
  }

  function status(msg, kind) {
    elStatus.textContent = msg;
    elStatus.className = "status " + (kind || "");
  }

  // ---------- 地图初始化 ----------
  function initMap() {
    map = L.map("map", { zoomControl: true }).setView([32, 112], 4);

    // 国内可稳定访问的高德瓦片（OSM 在国内被阻断，导致地图无法加载）
    // 矢量底图：多子域名负载均衡
    const amapVec = L.tileLayer(
      "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}",
      { subdomains: "1234", maxZoom: 18, attribution: "&copy; 高德地图" }
    );
    // 卫星底图
    const amapSat = L.tileLayer(
      "https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}",
      { subdomains: "1234", maxZoom: 18, attribution: "&copy; 高德地图" }
    );
    // 卫星+中文标注叠加层
    const amapSatLabel = L.tileLayer(
      "https://webst0{s}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}",
      { subdomains: "1234", maxZoom: 18, attribution: "&copy; 高德地图" }
    );

    amapVec.addTo(map);
    L.control.layers({
      "标准地图": amapVec,
      "卫星地图": amapSat,
      "卫星+标注": L.layerGroup([amapSat, amapSatLabel]),
    }).addTo(map);
  }

  function fmtGenerated() {
    if (!generatedTime) return "数据时间未知";
    const d = new Date(generatedTime);
    return "数据抓取于 " + d.toLocaleTimeString("zh-CN", { hour12: false }) + "（每10分钟更新）";
  }

  // ---------- 数据获取：从 GitHub 仓库读取 Actions 定时抓取的 JSON ----------
  async function fetchStates() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(DATA_URL, { signal: ctrl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      lastFetchAt = Date.now();
      generatedTime = data.generated || null;
      // 把精简的 flights 数组还原为与原 states 数组兼容的结构
      return (data.flights || []).map((f) => {
        const arr = new Array(17).fill(null);
        arr[S.ICAO24] = f.icao24;
        arr[S.CALLSIGN] = f.callsign;
        arr[S.ORIGIN] = f.country;
        arr[S.TIME_POS] = f.t;
        arr[S.LAST_CONTACT] = f.t;
        arr[S.LON] = f.lon;
        arr[S.LAT] = f.lat;
        arr[S.BARO_ALT] = f.alt;
        arr[S.ON_GROUND] = (f.alt == null || f.alt <= 0) && (f.vel == null || f.vel < 5);
        arr[S.VELOCITY] = f.vel;
        arr[S.TRACK] = f.track;
        arr[S.V_RATE] = f.vrate;
        return arr;
      });
    } catch (e) {
      throw new Error("获取数据失败: " + (e.message || e));
    } finally {
      clearTimeout(timer);
    }
  }

  // OpenSky states 字段索引
  const S = {
    ICAO24: 0, CALLSIGN: 1, ORIGIN: 2, TIME_POS: 3, LAST_CONTACT: 4,
    LON: 5, LAT: 6, BARO_ALT: 7, ON_GROUND: 8, VELOCITY: 9,
    TRACK: 10, V_RATE: 11, GEO_ALT: 13
  };

  // 判断某航班是否匹配当前查询（航班号 or 航司前缀）
  function matchQuery(st, query) {
    const cs = (st[S.CALLSIGN] || "").trim();
    if (!cs) return false;
    return cs === query || cs.startsWith(query);
  }

  // 读取历史轨迹数据
  async function fetchTracks() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(TRACKS_URL, { signal: ctrl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      return data.tracks || {};
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- 渲染 ----------
  function clearMarkers() {
    markers.forEach((m) => { try { map.removeLayer(m); } catch (e) {} });
    markers = [];
  }

  function renderResults(states, query) {
    currentResults = states;
    clearMarkers();
    clearTrackLines();
    renderList();
    // 本地累积观察点（页面存活期间记录每个航班位置，与服务器轨迹合并显示）
    const nowTs = Math.floor(Date.now() / 1000);
    states.forEach((st) => {
      const cs = (st[S.CALLSIGN] || "").trim();
      if (!cs) return;
      const lat = st[S.LAT], lon = st[S.LON];
      if (lat == null || lon == null) return;
      const arr = localObserved[cs] || [];
      // 距上一点 >60s 才追加，避免刷屏
      if (!arr.length || (nowTs - arr[arr.length - 1].t) > 60) {
        arr.push({ lat, lon, alt: st[S.BARO_ALT], vel: st[S.VELOCITY], track: st[S.TRACK], t: nowTs });
        if (arr.length > 32) arr.shift();
        localObserved[cs] = arr;
      }
    });
    // 画所有匹配航班轨迹（服务器轨迹 + 本地观察合并）
    states.forEach((st) => {
      const cs = (st[S.CALLSIGN] || "").trim();
      if (cs) drawCombinedTrack(cs);
    });
    // 重新渲染选中标记
    if (selectedIcao) drawMarkerFor(selectedIcao);
  }

  function makePlaneIcon(kind, track) {
    // 飞机 SVG 图标，带航向旋转；地面灰、飞行中绿
    const color = kind === "ground" ? "#9aa0a6" : "#22c55e";
    const rot = (track != null ? track : 0);
    return L.divIcon({
      className: "plane-icon",
      html: `<div style="transform:rotate(${rot}deg);width:22px;height:22px;">
        <svg viewBox="0 0 48 48" width="22" height="22">
          <path d="M24 2 L28 18 L44 24 L28 30 L24 46 L20 30 L4 24 L20 18 Z"
            fill="${color}" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
        </svg>
      </div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
  }

  // 清除轨迹线
  function clearTrackLines() {
    trackLines.forEach((l) => { try { map.removeLayer(l); } catch (e) {} });
    trackLines = [];
  }

  // 为指定 callsign 画轨迹线（合并服务器历史轨迹 + 本地观察点）
  function drawCombinedTrack(callsign) {
    const serverPts = (currentTracks && currentTracks[callsign]) || [];
    const localPts = localObserved[callsign] || [];
    // 合并：服务器点在前，本地点在最后
    const all = [...serverPts, ...localPts];
    const latlngs = all.map((p) => [p.lat, p.lon]).filter((c) => c[0] != null && c[1] != null);
    if (latlngs.length < 2) return null;
    const line = L.polyline(latlngs, {
      color: "#f59e0b",
      weight: 3,
      opacity: 0.85,
      dashArray: "6 4",
    }).addTo(map);
    trackLines.push(line);
    return line;
  }

  function drawMarkerFor(icao24) {
    const st = currentResults.find((s) => s[S.ICAO24] === icao24);
    if (!st) return;
    clearMarkers();
    const lat = st[S.LAT], lon = st[S.LON];
    if (lat == null || lon == null) return;
    const kind = st[S.ON_GROUND] ? "ground" : "air";
    clearTrackLines();
    // 画选中航班轨迹
    const cs = (st[S.CALLSIGN] || "").trim();
    if (cs) drawCombinedTrack(cs);
    const mk = L.marker([lat, lon], { icon: makePlaneIcon(kind, st[S.TRACK]) }).addTo(map);
    mk.on("click", () => showDetail(st));
    markers.push(mk);
    map.panTo([lat, lon], { animate: true });
  }

  function buildFlightCard(st) {
    const cs = (st[S.CALLSIGN] || "未知").trim();
    const div = document.createElement("div");
    div.className = "flight-card" + (st[S.ICAO24] === selectedIcao ? " selected" : "");
    div.innerHTML = `
      <div class="fc-top">
        <span class="fc-callsign">${cs}</span>
        <span class="fc-airline">${airlineName(cs.slice(0, 3))}</span>
        <span class="fc-state ${st[S.ON_GROUND] ? "ground" : "air"}">${st[S.ON_GROUND] ? "地面" : "飞行中"}</span>
      </div>
      <div class="fc-grid">
        <div><label>高度</label>${fmtAlt(st[S.BARO_ALT])}</div>
        <div><label>速度</label>${fmtSpeed(st[S.VELOCITY])}</div>
        <div><label>航向</label>${st[S.TRACK] != null ? Math.round(st[S.TRACK]) + "°" : "—"}</div>
        <div><label>垂直速率</label>${fmtRate(st[S.V_RATE])}</div>
        <div><label>位置</label>${st[S.LAT] != null ? st[S.LAT].toFixed(2) + ", " + st[S.LON].toFixed(2) : "—"}</div>
        <div><label>更新时间</label>${fmtTime(st[S.LAST_CONTACT])}</div>
      </div>`;
    div.onclick = () => {
      selectedIcao = st[S.ICAO24];
      drawMarkerFor(selectedIcao);
      renderList();
    };
    return div;
  }

  function renderList() {
    elCount.textContent = currentResults.length;
    elList.innerHTML = "";
    if (currentResults.length === 0) {
      elList.innerHTML = '<div class="empty">未找到匹配航班。<br>试试 CCA1654（国航）、CSN（南航）或直接输入航司代码。</div>';
      return;
    }
    currentResults.sort((a, b) => (a[S.CALLSIGN] || "").localeCompare(b[S.CALLSIGN] || ""));
    currentResults.forEach((st) => elList.appendChild(buildFlightCard(st)));
  }

  function showDetail(st) {
    const cs = (st[S.CALLSIGN] || "未知").trim();
    elDetail.classList.remove("hidden");
    elDetail.innerHTML = `
      <div class="det-head">
        <span class="det-cs">${cs}</span>
        <button class="btn-close" id="detailClose">✕</button>
      </div>
      <div class="det-body">
        <div><label>机型注册号(icao24)</label>${st[S.ICAO24]}</div>
        <div><label>所属/注册国</label>${st[S.ORIGIN] || "—"}</div>
        <div><label>经纬度</label>${st[S.LAT] != null ? st[S.LAT].toFixed(4) + "°, " + st[S.LON].toFixed(4) + "°" : "—"}</div>
        <div><label>气压高度</label>${fmtAlt(st[S.BARO_ALT])}</div>
        <div><label>几何高度</label>${fmtAlt(st[S.GEO_ALT])}</div>
        <div><label>地速</label>${fmtSpeed(st[S.VELOCITY])}</div>
        <div><label>垂直速率</label>${fmtRate(st[S.V_RATE])}</div>
        <div><label>航向</label>${st[S.TRACK] != null ? Math.round(st[S.TRACK]) + "°" : "—"}</div>
        <div><label>数据时间</label>${fmtTime(st[S.TIME_POS])}</div>
      </div>`;
    elDetail.querySelector("#detailClose").onclick = () => {
      elDetail.classList.add("hidden");
      selectedIcao = null;
    };
  }

  // ---------- 查询主流程 ----------
  async function doSearch() {
    const raw = elInput.value;
    const prefix = resolveAirlinePrefix(raw);

    if (!prefix) {
      status("无法识别查询内容，请输入航班号（如 CCA1654）或航司代码", "error");
      return;
    }
    pendingQuery = prefix;
    status("正在查询「" + prefix + "」的实时航班…", "loading");
    elSearch.disabled = true;
    try {
      const [states, tracks] = await Promise.all([fetchStates(), fetchTracks()]);
      currentTracks = tracks;
      // 匹配：完整航班号精确（统一转 ICAO，如 CA1654→CCA1654），否则按航司前缀
      const upraw = raw.trim().toUpperCase();
      const isFullFlight = /^[A-Z]{2,3}\d{1,4}$/.test(upraw);
      // 完整航班号：用解析出的 ICAO 前缀 + 数字 作为精确 callsign
      const fullCallsign = isFullFlight ? prefix + upraw.replace(/^[A-Za-z]+/, "") : null;
      const matched = states.filter((s) => {
        const cs = (s[S.CALLSIGN] || "").trim();
        if (!cs) return false;
        return fullCallsign ? cs === fullCallsign : cs.startsWith(prefix);
      });
      renderResults(matched, prefix);
      const airInfo = airlineName(prefix);
      status(`查询完成：${matched.length} 架「${airInfo}」在空/地面`, "ok");
      elLast.textContent = fmtGenerated();
      setupAutoRefresh();
    } catch (e) {
      status(e.message, "error");
    } finally {
      elSearch.disabled = false;
    }
  }

  function setupAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    if (elAuto.checked && pendingQuery) {
      refreshTimer = setInterval(async () => {
        try {
          const [states, tracks] = await Promise.all([fetchStates(), fetchTracks()]);
          currentTracks = tracks;
          const matched = states.filter((s) => matchQuery(s, pendingQuery));
          renderResults(matched, pendingQuery);
          elLast.textContent = fmtGenerated();
        } catch (e) {
          // 静默，不打断用户
        }
      }, REFRESH_MS);
    }
  }

  // ---------- 事件绑定 ----------
  function bind() {
    elSearch.addEventListener("click", doSearch);
    elInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
    elClear.addEventListener("click", () => {
      selectedIcao = null;
      elDetail.classList.add("hidden");
      clearMarkers();
      clearTrackLines();
      renderList();
    });
    elAuto.addEventListener("change", setupAutoRefresh);
    window.addEventListener("resize", () => { if (map) map.invalidateSize(); });
  }

  // ---------- 启动 ----------
  function init() {
    initMap();
    bind();
    // 初次加载：抓取一次统计全国数量（不限匹配）
    fetchStates().then((st) => {
      const total = st.filter((s) => s[S.CALLSIGN] && s[S.CALLSIGN].trim()).length;
      status(`数据已就绪，当前区域约 ${total} 架航班可查。输入航班号或航司开始。`, "ok");
      elLast.textContent = fmtGenerated();
      // 预加载轨迹数据
      fetchTracks().then((t) => { currentTracks = t; }).catch(() => {});
    }).catch((e) => status(e.message, "error"));
  }

  document.addEventListener("DOMContentLoaded", init);
})();