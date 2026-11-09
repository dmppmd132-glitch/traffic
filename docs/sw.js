// Service Worker：App 外殼快取 + API 網路優先
// 每次改了前端檔案，記得把 VERSION 加一，舊快取才會被清掉
const VERSION = 'v16';
const SHELL = `tra-shell-${VERSION}`;
const DATA = `tra-data-${VERSION}`;

const SHELL_FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'bus.js',
  'config.js',
  'manifest.webmanifest',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL && k !== DATA)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // API 可能在另一個網域（Cloudflare Worker），用路徑判斷
  const isApi = url.pathname.startsWith('/api/');
  if (url.origin !== location.origin && !isApi) return;

  // 即時資料（台鐵誤點、公車到站）：不快取，直接走網路
  const live = ['/api/delay', '/api/bus/eta', '/api/bus/pos'];
  if (live.includes(url.pathname)) return;

  // 車站、時刻表：網路優先，失敗時退回上次的快取（離線也能看查過的路線）
  if (isApi) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(DATA).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 靜態檔案（HTML / CSS / JS）：網路優先，確保各檔案版本一致；離線時才用快取
  // cache: 'no-cache' 會向伺服器確認是否有新版（沒變就回 304，很快），不會吃到瀏覽器的舊快取
  e.respondWith(
    fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }))
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
  );
});
