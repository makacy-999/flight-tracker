// pages/index/index.js —— 航班实时监视主页面
const { resolveAirlinePrefix, airlineCn } = require('../../utils/airline');
const { classify, CLASS_CN, planeIcon } = require('../../utils/classify');

const app = getApp();

// 单屏最多渲染的飞机数量：小程序 map 的 marker 过千会明显掉帧，
// 用视野过滤 + 上限截断来保住流畅度，筛选/搜索时再放开。
const MAX_MARKERS = 200;

Page({
  data: {
    // 地图
    centerLat: 33.5,
    centerLon: 108.5,
    scale: 4,
    markers: [],
    polyline: [],

    // 状态
    query: '',
    loading: true,
    statusText: '正在接入航班数据…',
    dataTime: '—',
    total: 0,
    shown: 0,

    // 选中
    selected: null,
    detail: null,

    // 搜索建议列表
    showList: false,
    resultList: [],
  },

  // 非渲染态数据放实例上，避免 setData 传输大对象
  allFlights: [],
  allTracks: {},
  markerIndex: {},   // markerId(number) -> callsign
  region: null,      // 当前视野
  debounceTimer: null,
  refreshTimer: null,

  onLoad() {
    this.loadAll();
  },

  onUnload() {
    clearTimeout(this.debounceTimer);
    clearInterval(this.refreshTimer);
  },

  // ── 数据加载 ──────────────────────────────────────────────────
  loadAll() {
    const g = app.globalData;
    wx.showLoading({ title: '接入数据流', mask: true });

    Promise.all([
      this.fetchJson(g.DATA_URL),
      this.fetchJson(g.TRACKS_URL).catch(() => ({ tracks: {} })),
    ])
      .then(([flightsRes, tracksRes]) => {
        const list = (flightsRes.flights || []).filter(
          (f) => f && f.callsign && typeof f.lat === 'number' && typeof f.lon === 'number'
        );
        this.allFlights = list;
        this.allTracks = tracksRes.tracks || {};
        this.generated = flightsRes.generated || '';

        this.setData({
          loading: false,
          total: list.length,
          statusText: `已锁定 ${list.length} 架航班`,
          dataTime: this.fmtTime(flightsRes.generated),
        });
        this.rebuild();
        wx.hideLoading();

        // 每 10 秒重新拉一次快照（后端 15 分钟更新，这里只是保持新鲜）
        clearInterval(this.refreshTimer);
        this.refreshTimer = setInterval(() => this.refresh(), 10000);
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({
          loading: false,
          statusText: '数据获取失败：' + (err.errMsg || err.message || '网络异常'),
        });
        wx.showToast({ title: '数据加载失败', icon: 'none' });
      });
  },

  fetchJson(url) {
    return new Promise((resolve, reject) => {
      wx.request({
        url,
        method: 'GET',
        timeout: 15000,
        success: (res) => {
          if (res.statusCode === 200) resolve(res.data);
          else reject(new Error('HTTP ' + res.statusCode));
        },
        fail: reject,
      });
    });
  },

  refresh() {
    const g = app.globalData;
    this.fetchJson(g.DATA_URL)
      .then((res) => {
        const list = (res.flights || []).filter(
          (f) => f && f.callsign && typeof f.lat === 'number' && typeof f.lon === 'number'
        );
        this.allFlights = list;
        this.setData({
          total: list.length,
          dataTime: this.fmtTime(res.generated),
          statusText: `已锁定 ${list.length} 架航班`,
        });
        this.rebuild();
      })
      .catch(() => {});
  },

  // ── 筛选 ──────────────────────────────────────────────────────
  matchList() {
    const q = (this.data.query || '').trim().toUpperCase();
    if (!q) return this.allFlights;

    // 输入本身是完整航班号（CCA1501 / CA1501）时，只按号码精确前缀匹配，
    // 不再展开成航司前缀——否则输 CCA1501 会把所有国航都捞出来。
    if (/^[A-Z0-9]{2,3}\d{1,4}$/.test(q)) {
      return this.allFlights.filter((f) => (f.callsign || '').toUpperCase().indexOf(q) === 0);
    }

    const prefix = resolveAirlinePrefix(q);
    return this.allFlights.filter((f) => {
      const cs = (f.callsign || '').toUpperCase();
      if (cs === q || cs.indexOf(q) === 0) return true;
      if (prefix && cs.indexOf(prefix) === 0) return true;
      return false;
    });
  },

  // ── 生成 markers / polyline ───────────────────────────────────
  rebuild() {
    const matched = this.matchList();
    const r = this.region;
    const markers = [];
    const index = {};

    // 有视野信息时优先只画视野内的，否则全画（截断）
    let pool = matched;
    if (r && r.southwest) {
      const inView = matched.filter(
        (f) =>
          f.lat >= r.southwest.latitude &&
          f.lat <= r.northeast.latitude &&
          f.lon >= r.southwest.longitude &&
          f.lon <= r.northeast.longitude
      );
      // 视野内太少时（缩小后）回退全量，避免出现"空图"
      pool = inView.length > 0 ? inView : matched;
    }

    // 飞行中的优先展示
    pool = pool
      .slice()
      .sort((a, b) => (b.alt || 0) - (a.alt || 0))
      .slice(0, MAX_MARKERS);

    pool.forEach((f, i) => {
      const cls = classify(f.cat);
      const flying = (f.alt || 0) > 1500;
      const isSel = this.data.selected && this.data.selected.callsign === f.callsign;

      markers.push({
        id: i,
        latitude: f.lat,
        longitude: f.lon,
        iconPath: planeIcon(cls),
        width: isSel ? 38 : 26,
        height: isSel ? 38 : 26,
        rotate: f.track || 0,              // 小程序 marker.rotate 为顺时针度数，与航向角同向
        anchor: { x: 0.5, y: 0.5 },
        alpha: flying ? 1 : 0.55,
        zIndex: isSel ? 99 : 1,
      });
      index[i] = f.callsign;
    });

    this.markerIndex = index;
    this.setData({ markers, shown: markers.length });
  },

  buildPolyline() {
    const sel = this.data.selected;
    if (!sel) return this.setData({ polyline: [] });

    const tr = this.allTracks[sel.callsign] || [];
    const points = tr
      .filter((p) => typeof p.lat === 'number' && typeof p.lon === 'number')
      .map((p) => ({ latitude: p.lat, longitude: p.lon }));
    points.push({ latitude: sel.lat, longitude: sel.lon });

    if (points.length < 2) return this.setData({ polyline: [] });

    this.setData({
      polyline: [
        {
          points,
          color: '#FFB020CC',
          width: 4,
          arrowLine: true,
          borderWidth: 1,
          borderColor: '#FFB02033',
        },
      ],
    });
  },

  // ── 交互 ──────────────────────────────────────────────────────
  onRegionChange(e) {
    // regionchange 在拖动/缩放过程中会连续触发，只有 type=end 时 detail.region 完整
    if (e.type !== 'end') return;
    if (!e.detail || !e.detail.region) return;

    this.region = e.detail.region;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.rebuild(), 260);
  },

  onMarkerTap(e) {
    const cs = this.markerIndex[e.markerId] || this.markerIndex[String(e.markerId)];
    if (!cs) return;
    const f = this.allFlights.find((x) => x.callsign === cs);
    if (!f) return;
    this.selectFlight(f);
  },

  selectFlight(f) {
    const cls = classify(f.cat);
    const detail = {
      callsign: f.callsign,
      airline: airlineCn(f.callsign) || f.country || '未知航司',
      type: CLASS_CN[cls] || cls,
      altKm: ((f.alt || 0) / 1000).toFixed(2),
      speed: f.vel ? Math.round(f.vel * 3.6) : 0,
      heading: typeof f.track === 'number' ? Math.round(f.track) : '—',
      lat: f.lat.toFixed(3),
      lon: f.lon.toFixed(3),
      icao: f.icao24 ? String(f.icao24).toUpperCase() : '—',
      country: f.country || '—',
      flying: (f.alt || 0) > 1500,
    };

    this.setData(
      {
        selected: f,
        detail,
        showList: false,
        centerLat: f.lat,
        centerLon: f.lon,
        scale: 7,
      },
      () => {
        this.buildPolyline();
        this.rebuild();
      }
    );
  },

  clearSelect() {
    this.setData({ selected: null, detail: null, polyline: [], scale: 5 }, () => this.rebuild());
  },

  onSearchInput(e) {
    const q = e.detail.value;
    this.setData({ query: q });
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.rebuild();
      this.buildResultList();
    }, 240);
  },

  onSearchConfirm() {
    this.rebuild();
    this.buildResultList();
  },

  buildResultList() {
    const matched = this.matchList();
    const list = matched
      .slice()
      .sort((a, b) => (b.alt || 0) - (a.alt || 0))
      .slice(0, 30)
      .map((f) => ({
        callsign: f.callsign,
        airline: airlineCn(f.callsign) || f.country || '',
        altKm: ((f.alt || 0) / 1000).toFixed(1),
        speed: f.vel ? Math.round(f.vel * 3.6) : 0,
        flying: (f.alt || 0) > 1500,
        cs: f.callsign,
      }));

    this.setData({ resultList: list, showList: list.length > 0 });

    // 命中唯一航班时直接定位
    if (list.length === 1) {
      const f = matched[0];
      if (f) this.selectFlight(f);
    }
  },

  onListItemTap(e) {
    const cs = e.currentTarget.dataset.cs;
    const f = this.allFlights.find((x) => x.callsign === cs);
    if (f) this.selectFlight(f);
  },

  onQuickTap(e) {
    const q = e.currentTarget.dataset.q || '';
    this.setData({ query: q });
    this.rebuild();
    this.buildResultList();
  },

  closeList() {
    this.setData({ showList: false });
  },

  onMapTap() {
    if (this.data.showList) this.setData({ showList: false });
  },

  // ── 工具 ──────────────────────────────────────────────────────
  fmtTime(t) {
    if (!t) return '—';
    // 后端给的是 ISO 字符串（UTC），转成本地时间显示
    const d = new Date(t);
    if (isNaN(d.getTime())) return String(t).slice(0, 16);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },
});
