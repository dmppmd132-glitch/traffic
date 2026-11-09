# 台鐵公車時刻 PWA

台鐵起迄站查詢，以及高雄公車即時到站（路線搜尋、方向、站序、常用路線與常用站牌）。會記住上次查詢的路線。資料來源：交通部 TDX。

- `docs/`：前端 PWA，透過 GitHub Pages 發佈（https://dmppmd132-glitch.github.io/traffic/）
- `worker/`：Cloudflare Worker，保管 TDX 金鑰、換 token、快取，並提供 `/api/*`

GitHub Pages 只能放靜態檔，所以 API 要另外部署在 Cloudflare Worker，再把網址填進 `docs/config.js`。

## 部署 Worker

1. 到 https://tdx.transportdata.tw 註冊並建立應用程式，取得 Client ID / Secret。
2. 在 `worker/` 資料夾執行：
   ```
   npm i -g wrangler
   wrangler login
   wrangler secret put TDX_ID
   wrangler secret put TDX_SECRET
   wrangler deploy
   ```
3. 部署完成會得到網址，例如 `https://tra-timetable.<帳號>.workers.dev`。

## 設定前端

把上面的網址填進 `docs/config.js` 的 `window.TRA_API_BASE`（結尾不要加斜線），提交並推送，Pages 會自動更新。
修改前端後，記得把 `docs/sw.js` 的 `VERSION` 加一，使用者才會拿到新版。

## 本機測試

在 `worker/` 建立 `.dev.vars`（已被 .gitignore 排除）：
```
TDX_ID=xxx
TDX_SECRET=xxx
```
執行 `wrangler dev`，並把 `docs/config.js` 暫時指向 `http://localhost:8787`；
同時把 `ALLOWED_ORIGIN` 改成你本機前端的網址。

## 公車功能

- 預設縣市為高雄（`Kaohsiung`）。要改縣市，在 `docs/config.js` 加上 `window.TRA_BUS_CITY = 'Taipei';`（TDX 的縣市英文名）。
- Worker 提供 `/api/bus/routes`、`/api/bus/stops`、`/api/bus/eta`（參數 `city`、`route`）。
- 到站時間每 20 秒自動更新（僅在公車分頁可見時）。

## 記憶功能（localStorage）

`tra.lastRoute` 上次路線、`tra.favorites` 常用路線（最多 8）、`tra.history` 最近查詢（最多 8）、`tra.stations` 車站清單快取（7 天）。
公車：`tra.bus.favRoutes` 常用路線、`tra.bus.favStops` 常用站牌、`tra.bus.history` 最近查詢、`tra.bus.last` 上次路線、`tra.bus.routes` 路線清單快取（7 天）。
換瀏覽器或清除網站資料後會消失。

## 公車地圖

- 地圖使用 Leaflet（從 unpkg CDN 於第一次顯示時載入），底圖為 CARTO（資料來自 OpenStreetMap），依系統深色 / 淺色模式自動切換。這些底圖服務適合小量使用，流量變大時請改用自己的圖資供應商。
- Worker 的 `/api/bus/pos`（TDX `RealTimeByFrequency`）提供公車座標與車號；`/api/bus/shape` 提供路線形狀。
- 路線形狀與班表每條路線只抓一次，自動更新（每 20 秒）只更新公車位置。
