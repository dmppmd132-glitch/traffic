// Cloudflare Worker：TDX 代理 + 靜態檔案服務
// 前端不直接碰 TDX 金鑰，所有 TDX 請求都由這裡轉發並快取。
// 需要的機密變數（用 wrangler secret put 設定）：TDX_ID、TDX_SECRET

const TDX_BASE = 'https://tdx.transportdata.tw/api/basic';
const TOKEN_URL =
  'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';

// token 快取在 isolate 記憶體中（有效期約 24 小時，這裡提前 5 分鐘更新）
let tokenCache = { token: null, exp: 0 };

async function getToken(env) {
  const now = Date.now();
  if (tokenCache.token && tokenCache.exp > now) return tokenCache.token;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.TDX_ID,
      client_secret: env.TDX_SECRET,
    }),
  });
  if (!res.ok) throw new Error('TDX 取得 token 失敗：' + res.status);

  const data = await res.json();
  tokenCache = {
    token: data.access_token,
    exp: now + (data.expires_in - 300) * 1000,
  };
  return tokenCache.token;
}

// 呼叫 TDX 並用 Cache API 快取結果，減少 API 次數（TDX 有呼叫額度限制）
async function tdxGet(env, ctx, path, ttl) {
  const cache = caches.default;
  const cacheKey = new Request('https://cache.local' + path);

  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const token = await getToken(env);
  const upstream = await fetch(`${TDX_BASE}${path}?%24format=JSON`, {
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
