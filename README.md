# 台鐵公車捷運時刻 PWA

台鐵起迄站查詢、高雄公車（即時到站、地圖、站站時刻表）、高雄捷運與輕軌（車站即時到站看板）。會記住上次查詢的路線與常用項目。資料來源：交通部 TDX。

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
- Worker 提供 `/api/bus/routes`、`stops`、`eta`、`pos`（即時座標）、`shape`（路線形狀）、`vehicle`、`schedule`（班表），參數為 `city`、`route`。
- 站站時刻表：優先使用 TDX 班表；TDX 沒有該路線班表時，改用 `docs/schedule-local.json`（手動維護，目前收錄 60、60區間，資料來自高雄市公車處）。新增路線時，依既有格式加入即可。路線名稱會寬鬆比對：完全相同優先，其次是 `aliases` 別名，再其次是路線名稱以該鍵開頭（例如 TDX 的「60覺民幹線」可對上鍵「60」，但「600」「60A」不會）。若某路線顯示不出手動班表，打開瀏覽器 Console 會看到可用的鍵與實際路線名稱。

手動班表的寫法有兩種，可以混用：
- **發車時間 + offset**（如 60）：寫起點站的 `times`，每站只寫 `offset`（距離起點的分鐘數），時間由程式推算。
- **每站直接寫時間**（如 50）：每個站牌自己的 `"times": [...]`，適合每站班次不規則或來源本來就是「站別時刻表」的路線。
- 群組可加 `"to": "終點站名稱"`，程式會用目前方向的終點站去對應，不依賴 `"0"` / `"1"` 的編號，不怕方向編號搞反。
- 群組的 `days` 寫「平常日」或「例假日」時，今天適用的那組會排在前面並標示「今天」（只依週一到五 / 週六日判斷，國定假日請以公車處公告為準）。
- 到站時間每 20 秒自動更新（僅在公車分頁可見時）。

## 記憶功能（localStorage）

`tra.lastRoute` 上次路線、`tra.favorites` 常用路線（最多 8）、`tra.history` 最近查詢（最多 8）、`tra.stations` 車站清單快取（7 天）。
公車：`tra.bus.favRoutes` 常用路線、`tra.bus.favStops` 常用站牌、`tra.bus.history` 最近查詢、`tra.bus.last` 上次路線、`tra.bus.routes` 路線清單快取（7 天）。
換瀏覽器或清除網站資料後會消失。

## 公車地圖

- 地圖使用 Leaflet（從 unpkg CDN 於第一次顯示時載入），底圖為 OpenStreetMap 官方圖磚（免金鑰），深色模式用 CSS 濾鏡反相。OSM 圖磚適合小量使用；流量變大請改用自己的圖資供應商，並在 `docs/config.js` 設定 `window.TRA_MAP_TILE_URL` 與 `window.TRA_MAP_ATTRIBUTION`。
- Worker 的 `/api/bus/pos`（TDX `RealTimeByFrequency`）提供公車座標與車號；`/api/bus/shape` 提供路線形狀。
- 路線形狀與班表每條路線只抓一次，自動更新（每 20 秒）只更新公車位置。

## 捷運與輕軌

- 高雄捷運（`KRTC`）與高雄輕軌（`KLRT`），前端為 `docs/metro.js`。
- Worker 提供 `/api/metro/stations`（路線與車站，快取 1 天）與 `/api/metro/live`（即時到站看板，快取 15 秒），參數為 `op`。
- 即時資料不會被 Service Worker 快取。

## YouBike（一般版）

- 分頁「YouBike」：站名或地址搜尋、「找附近的站點」（依手機定位排序）、常用站點、即時可借 / 可還數量（每 30 秒更新）、Google 地圖步行導航連結。
- Worker：`/api/bike/stations`（站點清單，快取 1 天）、`/api/bike/availability`（即時數量，整個縣市一次回傳，快取 30 秒），參數 `city`（預設 `Kaohsiung`）。
- 前端：`docs/bike.js`。Yayu 版沒有這個分頁。
- 資料欄位依 TDX 公共自行車 API（`/v2/Bike/Station/City/{City}`、`/v2/Bike/Availability/City/{City}`）撰寫；若 TDX 回傳欄位不同，到 `bike.js` 的 `parseStations`、`refreshAvail` 調整。

## 個人版（Yayu）與主題

同一套程式、同一個 Worker，用子資料夾提供不同介面：

| 版本 | 網址 | 內容 |
|---|---|---|
| 一般版 | `/traffic/` | 台鐵 + 高雄公車 + 高雄捷運輕軌 |
| Yayu 版 | `/traffic/yayu/` | 台鐵 + 台北／新北公車 + 台北捷運、新北捷運、淡海輕軌、安坑輕軌，小豬主題 |

- 設定在 `docs/yayu/profile.js`：縣市（`cities`）、捷運營運商（`metroOps`，TDX 代碼）、主題（`theme`：`pig` 小豬或 `bunny` 兔子）、地圖公車圖示（`busEmoji`）。
- 換成兔子：把 `theme` 改成 `'bunny'`、`busEmoji` 改 `'🐰'`，。主畫面圖示目前是使用者提供的「PIG BUS」插畫（`yayu/icon-*.png`、`apple-touch-icon.png`）；要換成兔子，改 `yayu/manifest.webmanifest` 與 `yayu/index.html` 的圖示檔名即可（兔子圖示備用檔為 `icon-bunny-192.png`、`icon-bunny-512.png`，原稿 `icon-bunny.svg`）。
- 主題樣式在 `docs/themes.css`，一般版沒有 `data-theme`，不受影響。
- 各版的 localStorage 用前綴分開（Yayu 為 `yayu.`），常用路線不會互相混在一起；公車的路線、常用、最近查詢再依縣市分開。
- 新增另一個人的版本：複製 `docs/yayu/` 資料夾、改 `profile.js`、改 `index.html` 的標題與捷運按鈕，並把新檔案加進 `docs/sw.js` 的 `SHELL_FILES`。
- 手動班表（`schedule-local.json`）只有高雄；台北、新北的站站時刻依 TDX 資料，沒有資料時會顯示「沒有提供」。
- Worker 的捷運營運商：`KRTC`、`KLRT`、`TRTC`、`NTMC`、`NTDLRT`、`NTALRT`。改了 Worker 要重新貼到 Cloudflare 並 Deploy。

## Token 共用（KV，建議）

TDX 對取得 token 有頻率限制，多個 Worker 實例同時取會遇到 429。綁定 KV 後 token 會跨實例共用：

1. 建立 KV 命名空間（目前名稱 `tra-token`）。
2. 在 Worker 的 Settings → Bindings 新增 KV namespace，變數名稱必須是 `TOKEN_KV`。
3. 驗證：呼叫一次 API 後，KV 裡會出現 `tdx_token` 這筆。沒綁定時會退回每個實例各自取 token。

目前線上狀態：`TOKEN_KV`（tra-token）與 `DB`（tra-timetable，已建立 `bus_schedule_cache`）皆已在網頁上綁定。

## 班表快取（D1，選用）

公車班表資料量大，第一次查詢可能較慢。啟用 Cloudflare D1 後，Worker 會把班表存起來，24 小時內直接回傳：

1. 建立資料庫並匯入結構：`wrangler d1 create tra-timetable`，再執行 `wrangler d1 execute tra-timetable --remote --file=worker/schema.sql`。
2. 在 `worker/wrangler.toml` 取消 `[[d1_databases]]` 區塊的註解並填入 `database_id`。若你是在 Cloudflare 網頁上綁定，請同步寫進這個檔案，否則下次用 `wrangler deploy` 會覆蓋掉網頁上的綁定。
3. 沒有綁定時，Worker 會自動退回直接向 TDX 取得，功能不受影響。

## 部署後的檢查

修改 `worker/src/worker.js` 後，必須重新部署 Worker（`wrangler deploy`，或在 Cloudflare 網頁貼上並 Deploy），前端新功能才有對應的 API。
