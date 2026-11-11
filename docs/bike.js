// YouBike（公共自行車）：站名搜尋、找附近站點、常用站點、即時可借 / 可還數量
// 資料來自 TDX，經 Cloudflare Worker 代理（/api/bike/stations、/api/bike/availability）
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const norm = (s) => (s || '').trim().replace(/台/g, '臺').toLowerCase();
  const PROFILE = window.TRA_PROFILE || {};
  const PFX = PROFILE.prefix || '';
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(PFX + key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(key, val) { try { localStorage.setItem(PFX + key, JSON.stringify(val)); } catch { /* 忽略 */ } },
  };
  const CITY = window.TRA_BIKE_CITY || 'Kaohsiung';
  const KEY = {
    stations: 'tra.bike.stations', // {t, list}
    favs: 'tra.bike.favs',         // [StationUID]
    q: 'tra.bike.q',               // 上次搜尋的站名
  };
  const STATIONS_TTL = 7 * 24 * 3600 * 1000;
  const REFRESH_MS = 30000;
  const MAX_FAV = 15;
  const MAX_SHOW = 30;

  async function api(path, ms = 20000) {
    const base = (window.TRA_API_BASE || '').replace(/\/$/, '');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(base + path, { signal: ctrl.signal });
      if (!res.ok) throw new Error('伺服器回應 ' + res.status);
      return await res.json();
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? '連線逾時' : e.message);
    } finally { clearTimeout(timer); }
  }
  function pickArray(data) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') for (const k of Object.keys(data)) if (Array.isArray(data[k])) return data[k];
    return [];
  }
  const nm = (o) => (o && (o.Zh_tw || o.En)) || (typeof o === 'string' ? o : '');
  const q = (name) => `/api/bike/${name}?city=${encodeURIComponent(CITY)}`;

  // ---------- 狀態 ----------
  let stations = [];          // [{uid, id, name, addr, lat, lon, cap, type}]
  let avail = new Map();      // uid -> {status, rent, ret, t}
  let availFailed = false;
  let mode = 'search';        // 'search' 依站名 / 'near' 依我的位置
  let here = null;            // {lat, lon}
  let started = false;
  let updatedAt = null;

  const cleanName = (n) => n.replace(/^YouBike\s*\d(\.\d)?\s*[_＿-]\s*/i, '');

  function parseStations(data) {
    const out = [];
    for (const s of pickArray(data)) {
      const uid = s.StationUID || s.StationID;
      const name = cleanName(nm(s.StationName));
      const pos = s.StationPosition || {};
      const lat = Number(pos.PositionLat), lon = Number(pos.PositionLon);
      if (!uid || !name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      out.push({
        uid: String(uid), id: String(s.StationID || ''), name,
        addr: nm(s.StationAddress), lat, lon, cap: Number(s.BikesCapacity) || 0,
        type: s.ServiceType === 2 || /2\.0/.test(nm(s.StationName)) ? '2.0' : (s.ServiceType === 1 ? '1.0' : ''),
      });
    }
    return out;
  }

  async function loadStations() {
    const cached = store.get(KEY.stations, null);
    if (cached && Date.now() - cached.t < STATIONS_TTL && cached.list.length) return cached.list;
    try {
      const list = parseStations(await api(q('stations'), 40000));
      if (list.length) store.set(KEY.stations, { t: Date.now(), list });
      return list;
    } catch (err) {
      if (cached && cached.list.length) return cached.list;
      throw err;
    }
  }

  async function refreshAvail() {
    try {
      const m = new Map();
      for (const a of pickArray(await api(q('availability')))) {
        const uid = String(a.StationUID || a.StationID || '');
        if (!uid) continue;
        m.set(uid, {
          status: a.ServiceStatus,
          rent: Number.isFinite(Number(a.AvailableRentBikes)) ? Number(a.AvailableRentBikes) : null,
          ret: Number.isFinite(Number(a.AvailableReturnBikes)) ? Number(a.AvailableReturnBikes) : null,
        });
      }
      avail = m;
      availFailed = false;
      updatedAt = new Date();
    } catch (err) {
      availFailed = true; // 保留上一次的數字，下次自動更新會再試
      console.info('bike availability failed', err.message);
    }
    render();
  }

  // ---------- 小工具 ----------
  function dist(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} 公尺` : `${(m / 1000).toFixed(1)} 公里`);
  const pad = (n) => String(n).padStart(2, '0');

  function setMsg(t, info) {
    const el = $('bikeMsg');
    el.textContent = t || '';
    el.classList.toggle('info', !!info);
  }

  // ---------- 常用 ----------
  const isFav = (uid) => store.get(KEY.favs, []).includes(uid);
  function toggleFav(uid) {
    let f = store.get(KEY.favs, []);
    f = f.includes(uid) ? f.filter((x) => x !== uid) : [uid, ...f].slice(0, MAX_FAV);
    store.set(KEY.favs, f);
  }

  // ---------- 畫面 ----------
  function countEl(label, n, kind) {
    const e = document.createElement('span');
    const cls = n === null ? 'none' : n === 0 ? 'zero' : n <= 2 ? 'low' : 'ok';
    e.className = `bike-n ${kind} ${cls}`;
    const b = document.createElement('b');
    b.textContent = n === null ? '—' : String(n);
    e.append(label, b);
    return e;
  }

  function stationRow(s, d) {
    const row = document.createElement('div');
    row.className = 'bike-row';

    const info = document.createElement('div');
    info.className = 'bike-info';
    const name = document.createElement('div');
    name.className = 'bike-name';
    name.textContent = s.name + (s.type ? `（${s.type}）` : '');
    const sub = document.createElement('div');
    sub.className = 'bike-sub';
    sub.textContent = [d != null ? fmtDist(d) : '', s.addr].filter(Boolean).join('・');
    info.append(name, sub);

    const a = avail.get(s.uid);
    const nums = document.createElement('div');
    nums.className = 'bike-nums';
    if (a && a.status !== undefined && a.status !== null && Number(a.status) !== 1) {
      const t = document.createElement('span');
      t.className = 'bike-n none';
      t.textContent = '暫停服務';
      nums.append(t);
    } else {
      nums.append(countEl('可借 ', a ? a.rent : null, 'rent'), countEl('可還 ', a ? a.ret : null, 'ret'));
    }

    const act = document.createElement('div');
    act.className = 'bike-act';
    const fav = document.createElement('button');
    fav.type = 'button';
    fav.className = 'link';
    fav.textContent = isFav(s.uid) ? '★' : '☆';
    fav.setAttribute('aria-label', '常用');
    fav.addEventListener('click', () => { toggleFav(s.uid); render(); });
    const nav = document.createElement('a');
    nav.className = 'link';
    nav.textContent = '導航';
    nav.target = '_blank';
    nav.rel = 'noopener';
    nav.href = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=walking`;
    act.append(fav, nav);

    row.append(info, nums, act);
    return row;
  }

  function render() {
    if (!started) return;
    const byUid = new Map(stations.map((s) => [s.uid, s]));

    // 常用
    const favs = store.get(KEY.favs, []).map((u) => byUid.get(u)).filter(Boolean);
    $('bikeFavCard').hidden = favs.length === 0;
    $('bikeFavs').replaceChildren(...favs.map((s) => stationRow(s, here ? dist(here, s) : null)));

    // 結果
    let list = [], head = '';
    const text = norm($('bikeInput').value);
    if (mode === 'near' && here) {
      list = stations.map((s) => [s, dist(here, s)]).sort((a, b) => a[1] - b[1]).slice(0, 15);
      head = '離我最近的站點';
    } else if (text) {
      list = stations.filter((s) => norm(s.name).includes(text) || norm(s.addr).includes(text))
        .slice(0, MAX_SHOW).map((s) => [s, here ? dist(here, s) : null]);
      head = `搜尋結果（${list.length}）`;
      if (!list.length) setMsg('找不到符合的站點', false);
    }
    if (list.length) setMsg('');
    const box = $('bikeResults');
    if (!list.length) { box.replaceChildren(); }
    else {
      const card = document.createElement('section');
      card.className = 'card';
      const h = document.createElement('h2');
      h.textContent = head;
      card.append(h, ...list.map(([s, d]) => stationRow(s, d)));
      box.replaceChildren(card);
    }

    const parts = [];
    if (updatedAt) parts.push(`更新時間 ${pad(updatedAt.getHours())}:${pad(updatedAt.getMinutes())}:${pad(updatedAt.getSeconds())}（每 30 秒自動更新）`);
    if (availFailed) parts.push('即時數量暫時無法取得，顯示上次資料');
    $('bikeUpdated').textContent = parts.join('　');
  }

  function locate() {
    if (!navigator.geolocation) { setMsg('這個瀏覽器不支援定位'); return; }
    setMsg('定位中…', true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        here = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        mode = 'near';
        $('bikeInput').value = '';
        syncClear();
        setMsg('');
        render();
      },
      () => setMsg('無法取得位置，請允許網站使用定位，或改用站名搜尋'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  }

  const syncClear = () => { $('bikeClear').hidden = !$('bikeInput').value; };

  async function start() {
    if (started) return;
    started = true;
    setMsg('載入站點中…', true);
    try {
      stations = await loadStations();
    } catch (err) {
      started = false; // 下次切換分頁時可重試
      setMsg('無法載入站點清單：' + err.message);
      return;
    }
    setMsg('');
    $('bikeInput').value = store.get(KEY.q, '');
    syncClear();
    render();
    refreshAvail();
  }

  // ---------- 事件 ----------
  const isVisible = () => !$('bikeView').hidden && !document.hidden;

  $('bikeInput').addEventListener('input', () => {
    mode = 'search';
    store.set(KEY.q, $('bikeInput').value);
    syncClear();
    setMsg('');
    render();
  });
  $('bikeClear').addEventListener('click', () => {
    $('bikeInput').value = '';
    store.set(KEY.q, '');
    mode = 'search';
    syncClear();
    setMsg('');
    render();
    $('bikeInput').focus();
  });
  $('bikeNear').addEventListener('click', locate);

  document.addEventListener('tabchange', (e) => {
    if (e.detail && e.detail.tab === 'bike') { started ? refreshAvail() : start(); }
  });
  document.addEventListener('visibilitychange', () => { if (started && isVisible()) refreshAvail(); });
  setInterval(() => { if (started && isVisible()) refreshAvail(); }, REFRESH_MS);

  if (!$('bikeView').hidden) start();
})();
