// 公車功能（預設高雄）：路線搜尋、站序與即時到站、常用路線 / 站牌、最近查詢
// 同時負責「台鐵 / 公車」分頁切換
(() => {
  'use strict';

  // ---------- 小工具 ----------
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');

  // localStorage 安全讀寫（私密模式可能丟例外）
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v ? JSON.parse(v) : fallback;
      } catch { return fallback; }
    },
    set(key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* 忽略 */ }
    },
  };

  const CITY = window.TRA_BUS_CITY || 'Kaohsiung'; // 之後要支援其他縣市，改這裡或 config.js
  const KEY = {
    tab: 'tra.tab',              // 上次使用的分頁
    routes: 'tra.bus.routes',    // 路線清單快取 {t, list}
    last: 'tra.bus.last',        // 上次查看的路線 {route, dir, sub}
    favRoutes: 'tra.bus.favRoutes', // 常用路線 [路線名稱]
    favStops: 'tra.bus.favStops',   // 常用站牌 [{route, dir, sub, uid, name, label}]
    hist: 'tra.bus.history',     // 最近查詢 [路線名稱]
  };
  const ROUTES_TTL = 7 * 24 * 3600 * 1000; // 路線清單快取 7 天
  const MAX_FAV_ROUTES = 10;
  const MAX_FAV_STOPS = 10;
  const MAX_HIST = 8;
  const REFRESH_MS = 20000; // 到站時間自動更新間隔

  async function api(path) {
    const base = (window.TRA_API_BASE || '').replace(/\/$/, '');
    const res = await fetch(base + path);
    if (!res.ok) throw new Error('伺服器回應 ' + res.status);
    return res.json();
  }

  // 回應可能是陣列或物件包陣列，統一取出陣列
  function pickArray(data) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      for (const k of Object.keys(data)) if (Array.isArray(data[k])) return data[k];
    }
    return [];
  }

  const apiQ = (name, route) =>
    `/api/bus/${name}?city=${encodeURIComponent(CITY)}` +
    (route ? `&route=${encodeURIComponent(route)}` : '');

  // ---------- 狀態 ----------
  let routes = [];      // [{name, from, to}]
  let cur = null;       // 目前開啟的路線 {route, entries, active, etaMap, updated}
  let started = false;  // 公車分頁是否已初始化
  let openSeq = 0;      // 連續點選路線時，只採用最後一次的結果
  const normQ = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, '');

  function setMsg(text, info = false) {
    const el = $('busMsg');
    el.textContent = text || '';
    el.classList.toggle('info', info);
  }

  // ---------- 路線清單 ----------
  async function loadRoutes() {
    const cached = store.get(KEY.routes, null);
    if (cached && Date.now() - cached.t < ROUTES_TTL && cached.list.length) return cached.list;
    try {
      const data = await api(apiQ('routes'));
      const seen = new Set();
      const list = [];
      for (const r of pickArray(data)) {
        const name = r.RouteName && r.RouteName.Zh_tw;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        list.push({ name, from: r.DepartureStopNameZh || '', to: r.DestinationStopNameZh || '' });
      }
      // 以數字自然排序（2、10、99 而不是 10、2、99）
      list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant', { numeric: true }));
      if (list.length) store.set(KEY.routes, { t: Date.now(), list });
      return list;
    } catch (err) {
      if (cached && cached.list.length) return cached.list; // 失敗時退回過期快取
      throw err;
    }
  }

  // 依輸入文字找路線：完全相同 > 開頭相同 > 包含
  function matchRoutes(q) {
    const k = normQ(q);
    if (!k) return [];
    const scored = [];
    for (const r of routes) {
      const n = normQ(r.name);
      if (n === k) scored.push([0, r]);
      else if (n.startsWith(k)) scored.push([1, r]);
      else if (n.includes(k)) scored.push([2, r]);
    }
    scored.sort((a, b) => a[0] - b[0]);
    return scored.slice(0, 12).map((x) => x[1]);
  }

  function renderSuggest() {
    const list = matchRoutes($('busInput').value);
    $('busSuggest').replaceChildren(
      ...list.map((r) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = r.name;
        b.title = r.from && r.to ? `${r.from} ↔ ${r.to}` : '';
        b.addEventListener('click', () => openRoute(r.name));
        return b;
      })
    );
    if ($('busInput').value.trim() && !list.length && routes.length) {
      setMsg('找不到符合的路線');
    } else if ($('busMsg').textContent === '找不到符合的路線') {
      setMsg('');
    }
  }

  // ---------- 路線站序 ----------
  // 把 TDX 的站序資料整理成「每個方向 / 支線一組」
  function parseStops(data, routeName) {
    let list = pickArray(data);
    // 路線名稱必須完全相同（避免 TDX 回傳名稱相近的其他路線）
    const exact = list.filter((e) => e.RouteName && e.RouteName.Zh_tw === routeName);
    if (exact.length) list = exact;

    const entries = list
      .map((e) => {
        const stops = (e.Stops || [])
          .map((s) => ({
            uid: s.StopUID,
            name: (s.StopName && s.StopName.Zh_tw) || '',
            seq: s.StopSequence,
          }))
          .filter((s) => s.uid && s.name)
          .sort((a, b) => a.seq - b.seq);
        return {
          sub: e.SubRouteUID || '',
          subName: (e.SubRouteName && e.SubRouteName.Zh_tw) || '',
          dir: e.Direction,
          stops,
        };
      })
      .filter((e) => e.stops.length);

    // 方向小的在前；同方向時站數多的（主線）在前
    entries.sort((a, b) => a.dir - b.dir || b.stops.length - a.stops.length);

    // 標籤：往 終點站；若有重複再補上支線名稱
    for (const e of entries) e.label = `往 ${e.stops[e.stops.length - 1].name}`;
    for (const e of entries) {
      const dup = entries.filter((x) => x.label === e.label).length > 1;
      if (dup && e.subName) e.label += `（${e.subName}）`;
    }
    return entries;
  }

  // ---------- 到站時間 ----------
  function buildEtaMap(data) {
    const map = new Map();
    for (const r of pickArray(data)) {
      if (!r.StopUID) continue;
      map.set(`${r.SubRouteUID || ''}|${r.Direction}|${r.StopUID}`, r);
      const loose = `|${r.Direction}|${r.StopUID}`; // 備用鍵：找不到支線時只比對方向與站牌
      if (!map.has(loose)) map.set(loose, r);
    }
    return map;
  }

  function lookupEta(map, entry, uid) {
    if (!map) return null;
    return map.get(`${entry.sub}|${entry.dir}|${uid}`) || map.get(`|${entry.dir}|${uid}`) || null;
  }

  // 把一筆到站資料轉成要顯示的文字與樣式
  function etaInfo(rec) {
    if (!rec) return { text: '—', cls: 'none' };
    switch (rec.StopStatus) {
      case 1: {
        const t = (rec.NextBusTime || '').slice(11, 16); // ISO 時間的 HH:MM
        return { text: t ? `${t} 發車` : '尚未發車', cls: 'none' };
      }
      case 2: return { text: '交管不停靠', cls: 'none' };
      case 3: return { text: '末班車已過', cls: 'none' };
      case 4: return { text: '今日未營運', cls: 'none' };
      default: {
        const s = rec.EstimateTime;
        if (s == null) return { text: '—', cls: 'none' };
        if (s <= 60) return { text: '進站中', cls: 'now' };
        const m = Math.ceil(s / 60);
        return { text: `${m} 分`, cls: m <= 3 ? 'soon' : '' };
      }
    }
  }

  function etaBadge(rec) {
    const info = etaInfo(rec);
    const el = document.createElement('span');
    el.className = 'eta ' + info.cls;
    el.textContent = info.text;
    return el;
  }

  async function fetchEta(route) {
    try {
      return buildEtaMap(await api(apiQ('eta', route)));
    } catch {
      return null; // 到站時間失敗不影響站序顯示
    }
  }

  // ---------- 記憶：常用路線 / 常用站牌 / 最近查詢 ----------
  const isFavRoute = (name) => store.get(KEY.favRoutes, []).includes(name);

  function toggleFavRoute(name) {
    let list = store.get(KEY.favRoutes, []);
    list = list.includes(name) ? list.filter((n) => n !== name) : [name, ...list].slice(0, MAX_FAV_ROUTES);
    store.set(KEY.favRoutes, list);
  }

  const sameStop = (a, b) => a.route === b.route && a.dir === b.dir && a.uid === b.uid;
  const isFavStop = (s) => store.get(KEY.favStops, []).some((x) => sameStop(x, s));

  function toggleFavStop(s) {
    let list = store.get(KEY.favStops, []);
    list = list.some((x) => sameStop(x, s))
      ? list.filter((x) => !sameStop(x, s))
      : [s, ...list].slice(0, MAX_FAV_STOPS);
    store.set(KEY.favStops, list);
  }

  function pushHist(name) {
    const list = store.get(KEY.hist, []).filter((n) => n !== name);
    list.unshift(name);
    store.set(KEY.hist, list.slice(0, MAX_HIST));
  }

  function routeChips(container, names) {
    container.replaceChildren(
      ...names.map((n) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = n;
        b.addEventListener('click', () => openRoute(n));
        return b;
      })
    );
  }

  function renderQuick() {
    const favR = store.get(KEY.favRoutes, []);
    const hist = store.get(KEY.hist, []);
    const favS = store.get(KEY.favStops, []);

    routeChips($('busFavRoutes'), favR);
    routeChips($('busHist'), hist);
    $('busFavRouteBlock').hidden = favR.length === 0;
    $('busHistBlock').hidden = hist.length === 0;
    $('busFavStopBlock').hidden = favS.length === 0;
    $('busQuick').hidden = !favR.length && !hist.length && !favS.length;
  }

  // 常用站牌：每個站牌一列，顯示路線、方向、站名與即時到站
  let favEtaMaps = new Map(); // route -> etaMap

  function renderFavStops() {
    const favS = store.get(KEY.favStops, []);
    $('busFavStops').replaceChildren(
      ...favS.map((s) => {
        const row = document.createElement('div');
        row.className = 'stoprow fav';

        const main = document.createElement('button');
        main.type = 'button';
        main.className = 'stopmain';
        const t1 = document.createElement('span');
        t1.className = 'stopname';
        t1.textContent = s.name;
        const t2 = document.createElement('span');
        t2.className = 'stopsub';
        t2.textContent = `${s.route} ${s.label}`;
        main.append(t1, t2);
        main.addEventListener('click', () => openRoute(s.route, { dir: s.dir, sub: s.sub, uid: s.uid }));

        const map = favEtaMaps.get(s.route);
        const rec = map && (map.get(`${s.sub || ''}|${s.dir}|${s.uid}`) || map.get(`|${s.dir}|${s.uid}`));
        const eta = etaBadge(map ? rec : null);

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'star on';
        del.textContent = '★';
        del.setAttribute('aria-label', '移除常用站牌');
        del.addEventListener('click', () => {
          toggleFavStop(s);
          renderQuick();
          renderFavStops();
          renderStopList();
        });

        row.append(main, eta, del);
        return row;
      })
    );
  }

  // 重新抓常用站牌所屬路線的到站時間（同一路線只抓一次）
  async function refreshFavEta() {
    const routesNeeded = [...new Set(store.get(KEY.favStops, []).map((s) => s.route))];
    if (!routesNeeded.length) return;
    const results = await Promise.all(routesNeeded.map((r) => fetchEta(r)));
    routesNeeded.forEach((r, i) => { if (results[i]) favEtaMaps.set(r, results[i]); });
    renderFavStops();
  }

  // ---------- 開啟路線 ----------
  async function openRoute(name, opts = {}) {
    const seq = ++openSeq;
    $('busInput').value = name;
    $('busSuggest').replaceChildren();
    setMsg('載入中…', true);
    $('busRoute').hidden = true;

    try {
      // 站序與到站時間同時載入
      const [stopsData, etaMap] = await Promise.all([api(apiQ('stops', name)), fetchEta(name)]);
      if (seq !== openSeq) return;

      const entries = parseStops(stopsData, name);
      if (!entries.length) {
        setMsg('找不到這條路線的站牌資料');
        return;
      }

      // 決定預設方向：從常用站牌進來 > 上次看的方向 > 第一個
      const last = store.get(KEY.last, null);
      let active = 0;
      const want = opts.dir != null ? opts : last && last.route === name ? last : null;
      if (want) {
        const i = entries.findIndex(
          (e) => e.dir === want.dir && (!want.sub || e.sub === want.sub) && (!opts.uid || e.stops.some((s) => s.uid === opts.uid))
        );
        if (i >= 0) active = i;
      }

      cur = { route: name, entries, active, etaMap, updated: new Date(), focusUid: opts.uid || null };
      setMsg('');
      pushHist(name);
      store.set(KEY.last, { route: name, dir: entries[active].dir, sub: entries[active].sub });
      renderRoute();
      renderQuick();
      $('busRoute').scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (err) {
      setMsg(navigator.onLine ? '載入失敗：' + err.message : '目前離線，無法查詢');
    }
  }

  function renderRoute() {
    if (!cur) return;
    $('busRoute').hidden = false;
    $('busRouteTitle').textContent = cur.route;
    refreshFavRouteBtn();

    // 方向分頁
    $('busDirTabs').replaceChildren(
      ...cur.entries.map((e, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip' + (i === cur.active ? ' on' : '');
        b.textContent = e.label;
        b.addEventListener('click', () => {
          cur.active = i;
          cur.focusUid = null;
          store.set(KEY.last, { route: cur.route, dir: e.dir, sub: e.sub });
          renderRoute();
        });
        return b;
      })
    );
    renderStopList();
  }

  function renderStopList() {
    if (!cur) return;
    const entry = cur.entries[cur.active];
    const time = cur.updated;
    $('busUpdated').textContent = `更新時間 ${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}（每 ${REFRESH_MS / 1000} 秒自動更新）`;

    $('busStops').replaceChildren(
      ...entry.stops.map((s) => {
        const row = document.createElement('div');
        row.className = 'stoprow' + (s.uid === cur.focusUid ? ' hl' : '');
        row.dataset.uid = s.uid;

        const seq = document.createElement('span');
        seq.className = 'seq';
        seq.textContent = s.seq;
        const name = document.createElement('span');
        name.className = 'stopname';
        name.textContent = s.name;
        const eta = etaBadge(cur.etaMap ? lookupEta(cur.etaMap, entry, s.uid) : null);

        const fav = { route: cur.route, dir: entry.dir, sub: entry.sub, uid: s.uid, name: s.name, label: entry.label };
        const star = document.createElement('button');
        star.type = 'button';
        const on = isFavStop(fav);
        star.className = 'star' + (on ? ' on' : '');
        star.textContent = on ? '★' : '☆';
        star.setAttribute('aria-label', on ? '移除常用站牌' : '加入常用站牌');
        star.addEventListener('click', () => {
          toggleFavStop(fav);
          renderQuick();
          renderFavStops();
          renderStopList();
          refreshFavEta();
        });

        row.append(seq, name, eta, star);
        return row;
      })
    );

    // 從常用站牌進來時，捲動到該站
    if (cur.focusUid) {
      const el = $('busStops').querySelector(`[data-uid="${CSS.escape(cur.focusUid)}"]`);
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      cur.focusUid = null;
    }
  }

  function refreshFavRouteBtn() {
    if (!cur) return;
    const on = isFavRoute(cur.route);
    const b = $('busFavRouteBtn');
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? '★ 已加入' : '☆ 常用';
  }

  // 只更新到站時間，不重新載入站序
  async function refreshEta() {
    if (!cur) return;
    const route = cur.route;
    const map = await fetchEta(route);
    if (!cur || cur.route !== route || !map) return;
    cur.etaMap = map;
    cur.updated = new Date();
    renderStopList();
  }

  // ---------- 分頁切換 ----------
  function isBusVisible() {
    return !$('busView').hidden && !document.hidden;
  }

  async function startBus() {
    if (started) return;
    started = true;
    renderQuick();
    renderFavStops();
    refreshFavEta();
    setMsg('載入路線清單…', true);
    try {
      routes = await loadRoutes();
      setMsg('');
      renderSuggest();
    } catch (err) {
      started = false; // 下次切換分頁時可重試
      setMsg('無法載入路線清單：' + err.message);
      return;
    }
    // 還原上次看的路線
    const last = store.get(KEY.last, null);
    if (last && routes.some((r) => r.name === last.route)) openRoute(last.route, last);
  }

  function setTab(tab) {
    $('railView').hidden = tab !== 'rail';
    $('busView').hidden = tab !== 'bus';
    document.querySelectorAll('.tabs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === tab);
    });
    store.set(KEY.tab, tab);
    if (tab === 'bus') {
      const wasStarted = started;
      startBus();
      // 第一次進入時 startBus 已會載入；之後再切回來才需要手動更新
      if (wasStarted) { refreshEta(); refreshFavEta(); }
    }
  }

  // ---------- 事件 ----------
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.addEventListener('click', () => setTab(b.dataset.tab));
  });

  $('busInput').addEventListener('input', renderSuggest);
  $('busInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const list = matchRoutes($('busInput').value);
    if (list.length) openRoute(list[0].name);
  });

  $('busFavRouteBtn').addEventListener('click', () => {
    if (!cur) return;
    toggleFavRoute(cur.route);
    refreshFavRouteBtn();
    renderQuick();
  });

  $('busClearHist').addEventListener('click', () => {
    store.set(KEY.hist, []);
    renderQuick();
  });

  // 定時更新到站時間（只在公車分頁可見時）
  setInterval(() => {
    if (!isBusVisible() || !started) return;
    refreshEta();
    refreshFavEta();
  }, REFRESH_MS);

  // 回到前景時立即更新一次
  document.addEventListener('visibilitychange', () => {
    if (isBusVisible() && started) { refreshEta(); refreshFavEta(); }
  });

  // 還原上次使用的分頁
  setTab(store.get(KEY.tab, 'rail') === 'bus' ? 'bus' : 'rail');
})();
