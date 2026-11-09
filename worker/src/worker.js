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
async function tdxGet(env, ctx, path, ttl, query = '') {
  const cache = caches.default;
  const cacheKey = new Request('https://cache.local' + path + '?' + query);

  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const token = await getToken(env);
  const upstream = await fetch(`${TDX_BASE}${path}?%24format=JSON${query ? '&' + query : ''}`, {
    headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'gzip' },
  });

  if (!upstream.ok) {
    return json({ error: 'TDX 回應錯誤', status: upstream.status }, 502);
  }

  const res = new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${ttl}`,
    },
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
          env, ctx, `/v2/Bus/Vehicle/City/${city}/${name}`, 15,
          '%24select=PlateNumb,RouteUID,RouteName,SubRouteUID,Direction,Position,Speed,Azimuth,UpdateTime'
        );
      }

      // 路線預定時刻：用於站站時刻表（快取一天）
      if (p === '/api/bus/schedule') {
        return await tdxGet(
          env, ctx, `/v2/Bus/Schedule/City/${city}/${name}`, 86400,
          '%24select=RouteName,SubRouteUID,SubRouteName,Direction,Timetables'
        );
      }

      // 即時到站時間：/api/bus/eta?city=Kaohsiung&route=紅9（資料很即時，只快取 15 秒）
      if (p === '/api/bus/eta') {
        return await tdxGet(
          env, ctx, `/v2/Bus/EstimatedTimeOfArrival/City/${city}/${name}`, 15,
          '%24select=RouteName,SubRouteUID,Direction,StopUID,StopStatus,EstimateTime,NextBusTime,UpdateTime'
        );
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
