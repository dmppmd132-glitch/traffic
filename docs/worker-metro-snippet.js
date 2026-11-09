    // ---------- 高雄捷運 / 輕軌（KRTC = 高雄捷運，KLRT = 高雄輕軌）----------
    // 請貼在 worker.js 的 route() 裡，放在最後那行 `return json({ error: 'Not found' }, 404);` 的「前面」
    if (p.startsWith('/api/metro/')) {
      const op = url.searchParams.get('op') || 'KRTC';
      if (!/^(KRTC|KLRT)$/.test(op)) return json({ error: '營運商參數錯誤' }, 400);

      // 各路線與車站（一天快取）：/api/metro/stations?op=KRTC
      if (p === '/api/metro/stations') {
        return await tdxGet(env, ctx, `/v2/Rail/Metro/StationOfLine/${op}`, 86400);
      }

      // 即時到站看板（整個營運商一次回傳，快取 15 秒）：/api/metro/live?op=KRTC
      if (p === '/api/metro/live') {
        return await tdxGet(env, ctx, `/v2/Rail/Metro/LiveBoard/${op}`, 15);
      }
    }

