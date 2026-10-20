# 冷链物流 · 航班实时动态监控

> 借鉴 [god-eye-view](https://github.com/bilawalsidhu/gods-eye-view) 的数据源思路，为冷链物流运力监控定制的**轻量航班实时查询页**。

输入航班号或航司，地图上实时显示飞机位置与运行状态（高度/速度/航向/垂直速率），支持自动刷新跟踪轨迹。

## ✈️ 功能
- **按航班号查询**：如 `CCA1654`、`CA1654`
- **按航司查询**：如 `国航`、`南航`、`CA`、`CCA`、`MU`（支持 ICAO 三字码 / IATA 二字码 / 中文 / 简称）
- **地图实时展示**：飞行中（蓝）/ 地面（灰）标记
- **航班详情**：点击标记或卡片，显示高度、速度、航向、经纬度、更新时间
- **自动刷新**：默认每 10 秒更新，持续跟踪

## 🚀 在线 Demo
GitHub Pages 部署后访问：`https://<用户名>.github.io/<仓库名>/`

## 🛠 技术栈
- 原生 HTML / CSS / JavaScript（零依赖、无构建）
- [Leaflet 1.9.4](https://leafletjs.com/) + OpenStreetMap 免费瓦片
- 数据源：[OpenSky Network](https://opensky-network.org/) 免费实时接口（浏览器 CORS 可直接访问，无需 Key）

## 📖 本地运行
```bash
cd flight-tracker
python3 -m http.server 8000
# 打开 http://localhost:8000
```

## 💡 说明
- 数据来自 OpenSky Network 免费公开接口，覆盖约 8 千架空域民航飞机，仅作运力监控参考，非实时管制数据。
- 本项目的定位是轻量聚焦的航班查询，未采用 god-eye-view 的完整 3D 地球、船舶/卫星/地震等重型功能（其需自备 Node/Docker 服务器，GitHub Pages 无法承载）。

## 📂 目录
```
flight-tracker/
├── index.html        # 页面骨架
├── css/style.css     # 样式
├── js/
│   ├── airlines.js   # 航司字典
│   └── app.js        # 核心逻辑
└── docs/设计文档.md   # 需求与设计文档
```

## 📄 License
MIT