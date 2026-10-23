// app.js
// 数据源配置：默认走 GitHub Pages 上的航班快照（同仓库 data/ 目录，
// 由 .github/workflows/update-flights.yml 每 15 分钟更新一次）。
const DATA_BASE = 'https://makacy-999.github.io/flight-tracker/data';

App({
  globalData: {
    // 快照数据（15 分钟粒度，稳定可用）
    DATA_URL: `${DATA_BASE}/flights.json`,
    TRACKS_URL: `${DATA_BASE}/tracks.json`,
    // OpenSky 官方接口：真正的实时源，但匿名访问有速率限制（约 10 秒/次），
    // 且国内直连不稳定。需要更实时的位置时把 USE_REALTIME 改为 true。
    OPENSKY_URL: 'https://opensky-network.org/api/states/all',
    USE_REALTIME: false,
    flights: [],
    tracks: {},
    generated: '',
  },
});
