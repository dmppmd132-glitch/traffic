// Cloudflare Worker：TDX API 代理（前端在 GitHub Pages，這裡只負責 /api/*）
// 前端不直接碰 TDX 金鑰，所有 TDX 請求都由這裡轉發並快取。
// 需要的機密變數（用 wrangler secret put 設定）：TDX_ID、TDX_SECRET

const TDX_BASE = 'https://tdx.transportdata.tw/api/basic';
const TOKEN_URL =
  'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';

// token 快取在 isolate 記憶體中（有效期約 24 小時，這裡提前 5 分鐘更新）
let tokenCache = { token: null, exp: 0 };
// 同一時間有多個請求要 token 時，共用同一次取得，避免被 TDX 限流（429）
let tokenPromise = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 向 TDX 取得新的 token；遇到 429 或 5xx 會稍等後重試，最多 3 次
async function fetchToken(env) {
  let lastStatus = 0;
  for (let i = 0; i < 3; i++) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.TDX_ID,
        client_secret: env.TDX_SECRET,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      return {
        token: data.access_token,
        exp: Date.now() + (data.expires_in - 300) * 1000,
      };
    }
    lastStatus = res.status;
    if (res.status !== 429 && res.status < 500) break; // 401、400 等重試也沒用
    await sleep(800 * (i + 1));
  }
  throw new Error('TDX 取得 token 失敗：' + lastStatus);
}

async function getToken(env) {
  const now = Date.now();
  if (tokenCache.token && tokenCache.exp > now) return tokenCache.token;

  // 選用：若有綁定 KV（變數名稱 TOKEN_KV），token 會跨 isolate 共用，最能避免 429
  if (env.TOKEN_KV) {
    try {
      const saved = await env.TOKEN_KV.get('tdx_token', 'json');
      if (saved && saved.exp > now) {
        tokenCache = saved;
        return saved.token;
      }
    } catch { /* KV 失敗就退回直接取 token */ }
  }

  if (!tokenPromise) {
    tokenPromise = fetchToken(env)
      .then(async (t) => {
        tokenCache = t;
        if (env.TOKEN_KV) {
          try {
            const ttl = Math.max(60, Math.floor((t.exp - Date.now()) / 1000));
            await env.TOKEN_KV.put('tdx_token', JSON.stringify(t), { expirationTtl: ttl });
          } catch { /* 忽略 */ }
        }
        return t;
      })
      .finally(() => { tokenPromise = null; });
  }
  return (await tokenPromise).token;
}

// 呼叫 TDX 並用 Cache API 快取結果，減少 API 次數（TDX 有呼叫額度限制）
// query：額外的 OData 參數（例如 %24select=...），用來縮小回傳資料量
// skipEmpty：回傳空陣列 [] 時不快取（避免 TDX 之後補上資料還拿到舊的空結果）
async function tdxGet(env, ctx, path, ttl, query = '', skipEmpty = false) {
  const cache = caches.default;
  const cacheKey = new Request('https://cache.local' + path + '?' + query);
  const staleKey = new Request('https://cache.local/stale' + path + '?' + query);

  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const url = `${TDX_BASE}${path}?%24format=JSON${query ? '&' + query : ''}`;
  const call = async () => fetch(url, {
    headers: { authorization: `Bearer ${await getToken(env)}`, 'accept-encoding': 'gzip' },
  });

  let upstream = await call();
  // 暫時性錯誤自動重試一次：429（太頻繁）、5xx（TDX 暫時異常）；401 代表 token 失效，清掉後重取
  if (upstream.status === 401) {
    tokenCache = { token: null, exp: 0 };
    if (env.TOKEN_KV) { try { await env.TOKEN_KV.delete('tdx_token'); } catch { /* 忽略 */ } }
    upstream = await call();
  } else if (upstream.status === 429 || upstream.status >= 500) {
    await sleep(700);
    upstream = await call();
  }

  if (!upstream.ok) {
    // 即時資料（快取 ≤ 60 秒）遇到 429 / 5xx 時，若有上一次成功的資料就先回舊的，使用者不會看到錯誤
    if (ttl <= 60 && (upstream.status === 429 || upstream.status >= 500)) {
      const old = await cache.match(staleKey);
      if (old) {
        const r = new Response(old.body, old);
        r.headers.set('x-stale', '1');
        r.headers.set('cache-control', 'no-store');
        return r;
      }
    }
    let detail = '';
    try { detail = (await upstream.text()).slice(0, 200); } catch { /* 忽略 */ }
    return json({ error: 'TDX 回應錯誤', status: upstream.status, path, detail }, 502);
  }

  // 空結果：直接回傳、不放進快取（回應標頭也不要求瀏覽器快取）
  if (skipEmpty) {
    const text = await upstream.text();
    if (text.trim().length <= 2) {
      return new Response(text, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    const res = new Response(text, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': `public, max-age=${ttl}`,
      },
    });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  }

  const res = new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${ttl}`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  if (ttl <= 60) {
    const keep = new Response(res.clone().body, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=600' },
    });
    ctx.waitUntil(cache.put(staleKey, keep));
  }
  return res;
}

async function scheduleGet(env, ctx, city, route, name) {
  const cacheKey = `${city}|${route}`;
  if (env.DB) {
    try {
      const row = await env.DB.prepare(
        'SELECT payload FROM bus_schedule_cache WHERE cache_key = ? AND updated_at > ? AND length(payload) > 2'
      ).bind(cacheKey, Date.now() - 86400000).first();
      // 直接回傳存好的文字，不再解析後重新轉換，省下 CPU 時間
      if (row && row.payload) {
        return new Response(row.payload, {
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
    } catch { /* D1 尚未建立時，退回 TDX */ }
  }
  const upstream = await tdxGet(
    env, ctx, `/v2/Bus/Schedule/City/${city}/${name}`, 86400,
    '%24select=RouteName,SubRouteUID,SubRouteName,Direction,Timetables',
    true
  );
  // 先把結果回給使用者；寫入 D1 放到背景進行，不讓使用者等待（空結果不寫入）
  if (env.DB && upstream.ok) {
    const copy = upstream.clone();
    ctx.waitUntil((async () => {
      try {
        const payload = await copy.text();
        if (payload.trim().length <= 2) return;
        await env.DB.prepare(
          'INSERT OR REPLACE INTO bus_schedule_cache (cache_key, city, route, payload, updated_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(cacheKey, city, route, payload, Date.now()).run();
      } catch { /* D1 寫入失敗不影響回應 */ }
    })());
  }
  return upstream;
}

// ---------- 路線規劃（TDX 運具整合路徑規劃）----------
// 網址可用環境變數 PLAN_URL 覆寫（TDX 若調整版本，不用改程式）
// TDX MaaS「公共運輸旅運規劃功能模組」：https://tdx.transportdata.tw/api/maas/routing
const PLAN_URL_DEFAULT = 'https://tdx.transportdata.tw/api/maas/routing';
// TDX 規定 gc 與 transit 為必填。transit 的預設值取自他人實測（運具代碼），
// 若要調整運具，可用環境變數 PLAN_TRANSIT 覆寫（例如 "1,2,3,4,5,6,7"），不用改程式
const PLAN_TRANSIT_DEFAULT = '3,4,5,6,7';

async function planGet(env, ctx, url) {
  const num = (k) => { const v = url.searchParams.get(k); return v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null; };
  const olat = num('olat'), olon = num('olon'), dlat = num('dlat'), dlon = num('dlon');
  const okLat = (v) => v !== null && v > 20 && v < 27;
  const okLon = (v) => v !== null && v > 117 && v < 124;
  if (!okLat(olat) || !okLat(dlat) || !okLon(olon) || !okLon(dlon)) {
    return json({ error: '座標參數錯誤（需為台灣範圍內的經緯度）' }, 400);
  }
  const r5 = (v) => v.toFixed(5);
  // 即時規劃：相同起訖 60 秒內共用結果，減少 TDX 呼叫次數
  const minute = Math.floor(Date.now() / 60000);
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.local/plan?${r5(olat)},${r5(olon)}>${r5(dlat)},${r5(dlon)}&m=${minute}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const base = env.PLAN_URL || PLAN_URL_DEFAULT;
  const transit = encodeURIComponent((env.PLAN_TRANSIT || PLAN_TRANSIT_DEFAULT).trim());
  // 出發時間：台北時間「現在 + 5 分鐘」進位到整分（TDX 不接受「現在」或過去的時間），格式 YYYY-MM-DDTHH:mm:ss
  const t = new Date(Math.ceil((Date.now() + 5 * 60000) / 60000) * 60000 + 8 * 3600000);
  const p2 = (n) => String(n).padStart(2, '0');
  const depart = `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}T${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}:00`;
  const od = `origin=${r5(olat)},${r5(olon)}&destination=${r5(dlat)},${r5(dlon)}`;
  const call = async (extra) => fetch(`${base}?${od}${extra}`, {
    headers: { authorization: `Bearer ${await getToken(env)}`, 'accept-encoding': 'gzip' },
  });
  // 必填：gc、transit。先用完整參數；被拒絕（400 / 404 / 422）就改用精簡參數（仍保留必填項）再試，並保留第一次的錯誤方便排查
  const full = `&gc=1&top=5&transit=${transit}&first_mile_mode=0&last_mile_mode=0&depart=${depart}`;
  const lean = `&gc=1&transit=${transit}&depart=${depart}`;
  let upstream = await call(full);
  let firstErr = '';
  if (upstream.status === 400 || upstream.status === 404 || upstream.status === 422) {
    try { firstErr = (await upstream.text()).slice(0, 200); } catch { /* 忽略 */ }
    upstream = await call(lean);
  }
  if (upstream.status === 429 || upstream.status >= 500) { await sleep(700); upstream = await call(lean); }
  if (!upstream.ok) {
    let detail = '';
    try { detail = (await upstream.text()).slice(0, 300); } catch { /* 忽略 */ }
    return json({ error: 'TDX 路線規劃回應錯誤', status: upstream.status, base, depart, detail, firstErr }, 502);
  }
  const res = new Response(upstream.body, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// 地名搜尋（OpenStreetMap Nominatim，限台灣）：回傳 [{name, label, lat, lon}]
// OSM 的台灣門牌資料不完整，帶門牌號碼（如「新建南路1號」）常查不到，所以依序放寬：
//   依序：原文 → 去掉門牌號 → 去掉弄 → 去掉巷（只查路名／地名），並在縣市區後補空格
// 搜尋範圍以台北、新北為優先（viewbox 只影響排序，不會排除其他縣市）。
// 有結果才快取一天；空結果不快取，避免一次查不到就好幾天都查不到。
const GEO_VIEWBOX = '121.3,25.3,122.0,24.65'; // 左經度,上緯度,右經度,下緯度（涵蓋台北市、新北市）
const GEO_UA = 'yayu-transit-planner (personal PWA; github.com/dmppmd132-glitch/traffic)';

async function geocodeGet(ctx, url) {
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 1 || q.length > 60 || /[\u0000-\u001F\u007F]/.test(q)) return json({ error: '搜尋文字格式錯誤' }, 400);
  const cache = caches.default;
  const cacheKey = new Request('https://cache.local/geocode4?q=' + encodeURIComponent(q));
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const search = async (text) => {
    const api = 'https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=tw&limit=6&accept-language=zh-TW'
      + '&viewbox=' + GEO_VIEWBOX + '&q=' + encodeURIComponent(text);
    const r = await fetch(api, { headers: { 'user-agent': GEO_UA } });
    if (!r.ok) throw new Error('nominatim ' + r.status);
    return (await r.json()).map((x) => ({
      name: (x.name || (x.display_name || '').split(',')[0] || '').trim(),
      label: (x.display_name || '').split(',').slice(0, 4).map((s) => s.trim()).join('、'),
      lat: Number(x.lat), lon: Number(x.lon),
    })).filter((x) => x.name && Number.isFinite(x.lat) && Number.isFinite(x.lon));
  };

  // 逐步放寬：原文 → 去門牌號 → 去弄 → 去巷（只剩路名）。
  // 另外把「縣市／區」與路名之間補上空格（Nominatim 不會自己切開中文，「板橋區金門街」會被當成一個詞而查不到）。
  const spaced = (t) => {
    const m = t.match(/^(\S{2,3}[縣市])?(\S{1,3}[區鄉鎮])?(.*)$/);
    return m ? [m[1], m[2], m[3]].filter(Boolean).join(' ').trim() : t;
  };
  const noNumber = q.replace(/\s*[0-9０-９]+(?:之[0-9０-９]+)?\s*號.*$/, '').trim();
  const noAlley = noNumber.replace(/\s*[0-9０-９]+\s*弄.*$/, '').trim();
  const noLane = noAlley.replace(/\s*[0-9０-９]+\s*巷.*$/, '').trim();
  const attempts = [];
  for (const t of [q, noNumber, noAlley, noLane]) {
    const v = spaced(t);
    if (v && !attempts.includes(v)) attempts.push(v);
  }

  let list = [];
  try {
    for (let i = 0; i < attempts.length; i++) {
      if (i > 0) await sleep(1100); // Nominatim 限制每秒 1 次
      list = await search(attempts[i]);
      if (list.length) break;
    }
  } catch (err) {
    return json({ error: '地名搜尋失敗', detail: String(err.message || err) }, 502);
  }

  if (!list.length) {
    return new Response('[]', {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const res = new Response(JSON.stringify(list), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=86400' },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// 路由處理：回傳 Response（錯誤也包成 JSON）
async function route(env, ctx, url) {
  const p = url.pathname;
  if (!p.startsWith('/api/')) return json({ error: 'Not found' }, 404);

  try {
    // 車站清單（一天快取）
    if (p === '/api/stations') {
      return await tdxGet(env, ctx, '/v3/Rail/TRA/Station', 86400);
    }

    // 起迄站時刻表：/api/timetable?from=1000&to=4400&date=2026-11-09
    if (p === '/api/timetable') {
      const from = url.searchParams.get('from') || '';
      const to = url.searchParams.get('to') || '';
      const date = url.searchParams.get('date') || '';
      if (!/^\d{4}$/.test(from) || !/^\d{4}$/.test(to) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return json({ error: '參數格式錯誤' }, 400);
      }
      return await tdxGet(env, ctx, `/v3/Rail/TRA/DailyTrainTimetable/OD/${from}/to/${to}/${date}`, 3600);
    }

    // 列車即時誤點（快取 30 秒）
    if (p === '/api/delay') {
      return await tdxGet(env, ctx, '/v2/Rail/TRA/LiveTrainDelay', 30);
    }

    // 路線規劃與地名搜尋：/api/plan?olat=&olon=&dlat=&dlon=、/api/geocode?q=
    if (p === '/api/plan') return await planGet(env, ctx, url);
    if (p === '/api/geocode') return await geocodeGet(ctx, url);

    // ---------- 公車（預設高雄 Kaohsiung）----------
    if (p.startsWith('/api/bus/')) {
      const city = url.searchParams.get('city') || 'Kaohsiung';
      if (!/^[A-Za-z]{3,30}$/.test(city)) return json({ error: '縣市參數錯誤' }, 400);

      // 路線清單：/api/bus/routes?city=Kaohsiung（只取需要的欄位，縮小資料量）
      if (p === '/api/bus/routes') {
        return await tdxGet(
          env, ctx, `/v2/Bus/Route/City/${city}`, 86400,
          '%24select=RouteUID,RouteName,DepartureStopNameZh,DestinationStopNameZh'
        );
      }

      // 路線名稱：TDX 路線可能含空白、頓號、全形標點與括號；只拒絕控制字元
      const route = url.searchParams.get('route') || '';
      if (!route || route.length > 80 || /[\u0000-\u001F\u007F]/.test(route)) {
        return json({ error: '路線名稱格式錯誤' }, 400);
      }
      const name = encodeURIComponent(route);

      // 路線站序：/api/bus/stops?city=Kaohsiung&route=紅9
      if (p === '/api/bus/stops') {
        return await tdxGet(
          env, ctx, `/v2/Bus/StopOfRoute/City/${city}/${name}`, 3600,
          '%24select=RouteName,SubRouteUID,SubRouteName,Direction,Stops'
        );
      }

      // 路線線形：用於地圖繪製實際路線（快取一天）
      if (p === '/api/bus/shape') {
        return await tdxGet(
          env, ctx, `/v2/Bus/Shape/City/${city}/${name}`, 86400,
          '%24select=RouteName,SubRouteUID,Direction,Geometry'
        );
      }

      // 路線車輛位置：用於地圖上的公車圖示（快取 15 秒）
      if (p === '/api/bus/vehicle') {
        return await tdxGet(
          env, ctx, `/v2/Bus/Vehicle/City/${city}/${name}`, 20,
          '%24select=PlateNumb,RouteUID,RouteName,SubRouteUID,Direction,Position,Speed,Azimuth,UpdateTime'
        );
      }

      // 公車即時座標（RealTimeByFrequency）：地圖上的公車圖示與車號
      if (p === '/api/bus/pos') {
        return await tdxGet(
          env, ctx, `/v2/Bus/RealTimeByFrequency/City/${city}/${name}`, 20,
          '%24select=RouteName,SubRouteUID,Direction,PlateNumb,BusPosition,BusStatus,DutyStatus'
        );
      }

      // 路線預定時刻：用於站站時刻表（快取一天）
      if (p === '/api/bus/schedule') {
        return await scheduleGet(env, ctx, city, route, name);
      }

      // 即時到站時間：/api/bus/eta?city=Kaohsiung&route=紅9（資料很即時，只快取 15 秒）
      if (p === '/api/bus/eta') {
        return await tdxGet(
          env, ctx, `/v2/Bus/EstimatedTimeOfArrival/City/${city}/${name}`, 20,
          '%24select=RouteName,SubRouteUID,Direction,StopUID,StopStatus,EstimateTime,NextBusTime,UpdateTime'
        );
      }
    }

    // ---------- 公共自行車（YouBike）----------
    if (p.startsWith('/api/bike/')) {
      const city = url.searchParams.get('city') || 'Kaohsiung';
      if (!/^[A-Za-z]{3,30}$/.test(city)) return json({ error: '縣市參數錯誤' }, 400);

      // 站點清單（位置、地址、車柱數）：一天快取，只取需要的欄位
      if (p === '/api/bike/stations') {
        return await tdxGet(
          env, ctx, `/v2/Bike/Station/City/${city}`, 86400,
          '%24select=StationUID,StationID,StationName,StationPosition,StationAddress,BikesCapacity,ServiceType'
        );
      }

      // 即時可借 / 可還數量（整個縣市一次回傳，快取 30 秒）
      if (p === '/api/bike/availability') {
        return await tdxGet(
          env, ctx, `/v2/Bike/Availability/City/${city}`, 30,
          '%24select=StationUID,StationID,ServiceStatus,AvailableRentBikes,AvailableReturnBikes,UpdateTime'
        );
      }
    }

    // ---------- 捷運 / 輕軌 ----------
    // KRTC 高雄捷運、KLRT 高雄輕軌、TRTC 臺北捷運、NTMC 新北捷運（環狀線）、NTDLRT 淡海輕軌、NTALRT 安坑輕軌
    if (p.startsWith('/api/metro/')) {
      const op = url.searchParams.get('op') || 'KRTC';
      if (!/^(KRTC|KLRT|TRTC|NTMC|NTDLRT|NTALRT)$/.test(op)) return json({ error: '營運商參數錯誤' }, 400);

      // 各路線與車站（一天快取）：/api/metro/stations?op=KRTC
      if (p === '/api/metro/stations') {
        const r = await tdxGet(env, ctx, `/v2/Rail/Metro/StationOfLine/${op}`, 86400);
        if (r.ok) return r;
        // 備援：改抓單純的車站清單（前端會依站號字母自動分線）
        return await tdxGet(env, ctx, `/v2/Rail/Metro/Station/${op}`, 86400);
      }

      // 即時到站看板（整個營運商一次回傳，快取 15 秒）：/api/metro/live?op=KRTC
      if (p === '/api/metro/live') {
        return await tdxGet(env, ctx, `/v2/Rail/Metro/LiveBoard/${op}`, 15);
      }
    }

    return json({ error: 'Not found' }, 404);
  } catch (err) {
    return json({ error: String(err.message || err) }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    // CORS：只允許前端所在的網域（預設為此專案的 GitHub Pages，可用 ALLOWED_ORIGIN 變數覆寫）
    const allowed = env.ALLOWED_ORIGIN || 'https://dmppmd132-glitch.github.io';
    const cors = {
      'access-control-allow-origin': allowed,
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-max-age': '86400',
      vary: 'origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const res = await route(env, ctx, new URL(request.url));
    // 快取取出的 Response 標頭是唯讀的，複製一份再加 CORS 標頭
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};
