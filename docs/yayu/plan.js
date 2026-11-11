// 路線規劃（Yayu 版）：輸入起點、終點，比較火車 / 捷運 / 公車，並列出走法
// 資料：Worker 的 /api/plan（TDX 運具整合路徑規劃）與 /api/geocode（地名搜尋）
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const PROFILE = window.TRA_PROFILE || {};
  const PFX = PROFILE.prefix || '';
  const store = {
    get(k, f) { try { const v = localStorage.getItem(PFX + k); return v ? JSON.parse(v) : f; } catch { return f; } },
    set(k, v) { try { localStorage.setItem(PFX + k, JSON.stringify(v)); } catch { /* 忽略 */ } },
  };
  const KEY = { recent: 'tra.plan.recent' }; // 最近的起訖 [{from, to}]
  const pad = (n) => String(n).padStart(2, '0');

  async function api(path, ms = 25000) {
    const base = (window.TRA_API_BASE || '').replace(/\/$/, '');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(base + path, { signal: ctrl.signal });
      let body = null;
      try { body = await res.json(); } catch { /* 忽略 */ }
      if (!res.ok) {
        const e = new Error('伺服器回應 ' + res.status + (body && body.status ? `（TDX ${body.status}）` : ''));
        e.body = body;
        throw e;
      }
      return body;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('連線逾時');
      throw err;
    } finally { clearTimeout(timer); }
  }

  // ---------- 解析規劃結果（欄位名稱容錯，格式不同時也盡量顯示） ----------
  const get = (o, ...keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
  const toMs = (v) => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  };
  const hhmm = (ms) => { if (ms === null) return ''; const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const nm = (v) => (v && typeof v === 'object' ? v.Zh_tw || v.zh_tw || v.name || v.En || '' : v || '');

  function modeOf(sec) {
    const t = get(sec, 'transport') || {};
    // 不放 type（常是 "transit" 這種泛稱，會誤判成 tra…in）
    const s = [get(sec, 'mode'), get(sec, 'travelMode'), t.mode, t.category, t.type, nm(t.name), get(sec, 'type') === 'pedestrian' ? 'pedestrian' : ''].filter(Boolean).join(' ').toLowerCase();
    if (/pedestrian|walk|步行/.test(s)) return 'walk';
    if (/subway|metro|mrt|lightrail|light_rail|monorail|捷運|輕軌/.test(s)) return 'metro';
    if (/highspeed|high_speed|thsr|高鐵/.test(s)) return 'hsr';
    if (/bus|公車|客運/.test(s)) return 'bus';
    if (/train|rail|\btra\b|臺鐵|台鐵|火車|intercity|regional|區間|自強|莒光|普悠瑪|太魯閣/.test(s)) return 'train';
    return 'other';
  }
  const ICON = { walk: '🚶', bus: '🚌', metro: '🚇', train: '🚆', hsr: '🚄', other: '🚐' };
  const MODE_NAME = { walk: '步行', bus: '公車', metro: '捷運', train: '台鐵', hsr: '高鐵', other: '其他' };

  function findRoutes(data) {
    if (!data) return [];
    const cands = [data.routes, data.data && data.data.routes, data.Routes, data.data, data.result && data.result.routes, data];
    for (const c of cands) if (Array.isArray(c) && c.length) return c;
    return [];
  }

  function parseRoute(r) {
    const secs = get(r, 'sections', 'legs', 'Sections', 'steps') || [];
    const parts = secs.map((s) => {
      const dep = get(s, 'departure', 'origin') || {};
      const arr = get(s, 'arrival', 'destination') || {};
      const t = get(s, 'transport') || {};
      const dMs = toMs(get(dep, 'time', 'Time', 'departureTime') ?? get(s, 'departure_time', 'start_time', 'departureTime'));
      const aMs = toMs(get(arr, 'time', 'Time', 'arrivalTime') ?? get(s, 'arrival_time', 'end_time', 'arrivalTime'));
      const sum = get(s, 'travelSummary', 'summary') || {};
      let dur = Number(get(sum, 'duration', 'travel_time') ?? get(s, 'duration', 'travel_time'));
      if (!Number.isFinite(dur) || dur <= 0) dur = dMs !== null && aMs !== null ? Math.round((aMs - dMs) / 1000) : 0;
      const mode = modeOf(s);
      const place = (x) => nm(x.place && (x.place.name || x.place)) || nm(x.name) || nm(x.stop) || nm(x.station) || '';
      return {
        mode,
        line: nm(t.name) || nm(t.shortName) || nm(get(s, 'line', 'route', 'routeName', 'name')) || '',
        head: nm(t.headsign) || nm(get(s, 'headsign', 'direction')) || '',
        from: place(dep), to: place(arr), dMs, aMs, dur,
      };
    }).filter((p) => p.mode !== 'other' || p.line || p.from || p.to);

    const first = parts.find((p) => p.dMs !== null), last = [...parts].reverse().find((p) => p.aMs !== null);
    let total = first && last ? Math.round((last.aMs - first.dMs) / 1000) : 0;
    if (!total) total = Number(get(r, 'travel_time', 'duration', 'travelTime', 'total_time')) || parts.reduce((a, p) => a + p.dur, 0);
    const rides = parts.filter((p) => p.mode !== 'walk');
    const walk = parts.filter((p) => p.mode === 'walk').reduce((a, p) => a + p.dur, 0);
    return {
      parts, total, walk, transfers: Math.max(0, rides.length - 1),
      start: first ? first.dMs : null, end: last ? last.aMs : null,
      fare: get(r, 'fare', 'price', 'total_fare'),
      modes: [...new Set(rides.map((p) => p.mode))],
    };
  }

  // 依主要運具標示「火車方便 / 捷運方便 / 公車方便」
  function kindLabel(rt) {
    if (!rt.modes.length) return '步行';
    const names = rt.modes.map((m) => MODE_NAME[m]);
    return names.join(' + ');
  }

  // ---------- 畫面 ----------
  let from = null, to = null;      // {name, lat, lon}
  let lastRaw = null;

  const minutes = (sec) => { const m = Math.max(1, Math.round(sec / 60)); return m >= 60 ? `${Math.floor(m / 60)} 小時 ${m % 60} 分` : `${m} 分`; };

  function setMsg(t, info) { const el = $('planMsg'); el.textContent = t || ''; el.classList.toggle('info', !!info); }

  function routeCard(rt, tags) {
    const card = document.createElement('details');
    card.className = 'plan-card';
    const sum = document.createElement('summary');
    const top = document.createElement('div');
    top.className = 'plan-top';
    const t = document.createElement('b');
    t.className = 'plan-total';
    t.textContent = minutes(rt.total);
    const span = document.createElement('span');
    span.className = 'plan-time';
    span.textContent = rt.start !== null && rt.end !== null ? `${hhmm(rt.start)} → ${hhmm(rt.end)}` : '';
    top.append(t, span, ...tags.map((x) => { const e = document.createElement('em'); e.textContent = x; return e; }));
    const chips = document.createElement('div');
    chips.className = 'plan-chips';
    for (const p of rt.parts) {
      const c = document.createElement('span');
      c.className = 'plan-chip ' + p.mode;
      c.textContent = `${ICON[p.mode]} ${p.mode === 'walk' ? minutes(p.dur) : (p.line || MODE_NAME[p.mode])}`;
      chips.append(c);
    }
    const meta = document.createElement('div');
    meta.className = 'plan-meta';
    meta.textContent = [kindLabel(rt), rt.transfers ? `轉乘 ${rt.transfers} 次` : '不用轉乘', rt.walk ? `步行 ${minutes(rt.walk)}` : '', rt.fare ? `票價 ${rt.fare}` : ''].filter(Boolean).join('・');
    sum.append(top, chips, meta);
    card.append(sum);

    const steps = document.createElement('ol');
    steps.className = 'plan-steps';
    for (const p of rt.parts) {
      const li = document.createElement('li');
      const what = p.mode === 'walk'
        ? `步行 ${minutes(p.dur)}${p.to ? ` 到 ${p.to}` : ''}`
        : `搭${p.line ? ` ${p.line}` : MODE_NAME[p.mode]}${p.head ? ` 往 ${p.head}` : ''}${p.from ? `，在「${p.from}」上車` : ''}${p.to ? `，「${p.to}」下車` : ''}`;
      li.textContent = `${ICON[p.mode]} ${p.dMs !== null ? hhmm(p.dMs) + ' ' : ''}${what}（${minutes(p.dur)}）`;
      steps.append(li);
    }
    card.append(steps);
    return card;
  }

  function showResults(data) {
    lastRaw = data;
    const routes = findRoutes(data).map(parseRoute).filter((r) => r.parts.length);
    const box = $('planResults');
    box.replaceChildren();
    if (!routes.length) {
      setMsg('這段路線沒有找到可搭乘的方式，或資料格式無法辨識。', false);
      renderRaw();
      return;
    }
    setMsg('');
    const fastest = Math.min(...routes.map((r) => r.total));
    const fewest = Math.min(...routes.map((r) => r.transfers));
    const leastWalk = Math.min(...routes.map((r) => r.walk));
    routes.sort((a, b) => a.total - b.total);
    box.append(...routes.map((rt) => {
      const tags = [];
      if (rt.total === fastest) tags.push('最快');
      if (rt.transfers === fewest) tags.push('轉乘最少');
      if (rt.walk === leastWalk && routes.length > 1) tags.push('走路最少');
      return routeCard(rt, tags);
    }));
    box.firstChild.open = true;
    renderRaw();
  }

  // 原始資料（排查用）：格式與預期不同時，可複製給開發者
  function renderRaw() {
    const d = $('planRaw');
    d.hidden = !lastRaw;
    $('planRawText').textContent = lastRaw ? JSON.stringify(lastRaw, null, 1).slice(0, 6000) : '';
  }

  function googleUrl() {
    const o = from ? `${from.lat},${from.lon}` : '', d = to ? `${to.lat},${to.lon}` : '';
    return `https://www.google.com/maps/dir/?api=1&origin=${o}&destination=${d}&travelmode=transit`;
  }

  async function search() {
    if (!from || !to) { setMsg('請先選好起點與終點（輸入地名後，從下方選單點選）'); return; }
    setMsg('規劃路線中…', true);
    $('planResults').replaceChildren();
    $('planGoogle').hidden = true;
    lastRaw = null; renderRaw();
    const recent = store.get(KEY.recent, []).filter((r) => !(r.from.name === from.name && r.to.name === to.name));
    store.set(KEY.recent, [{ from, to }, ...recent].slice(0, 6));
    renderRecent();
    try {
      const data = await api(`/api/plan?olat=${from.lat}&olon=${from.lon}&dlat=${to.lat}&dlon=${to.lon}`, 40000);
      showResults(data);
    } catch (err) {
      let msg = '路線規劃失敗：' + err.message;
      if (err.body && err.body.detail) { lastRaw = err.body; renderRaw(); }
      setMsg(msg);
    }
    $('planGoogle').hidden = false;
    $('planGoogle').href = googleUrl();
  }

  // ---------- 地名搜尋（自訂選單） ----------
  function bindPlace(id, setPlace, getPlace) {
    const el = $(id);
    const pop = document.createElement('div');
    pop.className = 'st-pop';
    pop.hidden = true;
    el.parentElement.classList.add('st-wrap');
    el.parentElement.append(pop);
    pop.addEventListener('mousedown', (e) => e.preventDefault());
    let timer = null, seq = 0;

    const show = (items, note) => {
      pop.replaceChildren();
      if (note) { const n = document.createElement('div'); n.className = 'st-empty'; n.textContent = note; pop.append(n); }
      for (const it of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'st-item';
        b.textContent = it.label ? `${it.name}　${it.label}` : it.name;
        b.addEventListener('click', () => { setPlace({ name: it.name, lat: it.lat, lon: it.lon }); el.value = it.name; pop.hidden = true; el.blur(); });
        pop.append(b);
      }
      pop.hidden = !pop.childNodes.length;
    };

    el.addEventListener('input', () => {
      setPlace(null);
      clearTimeout(timer);
      const q = el.value.trim();
      if (q.length < 2) { pop.hidden = true; return; }
      timer = setTimeout(async () => {
        const my = ++seq;
        show([], '搜尋中…');
        try {
          const list = await api('/api/geocode?q=' + encodeURIComponent(q), 15000);
          if (my !== seq) return;
          show(list, list.length ? '' : '找不到這個地點，試試加上縣市或更完整的名稱');
        } catch (err) { if (my === seq) show([], '地名搜尋失敗：' + err.message); }
      }, 450);
    });
    el.addEventListener('blur', () => { pop.hidden = true; });
    el.addEventListener('focus', () => { if (!getPlace() && el.value.trim().length >= 2) el.dispatchEvent(new Event('input')); });
  }

  function locate() {
    if (!navigator.geolocation) { setMsg('這個瀏覽器不支援定位'); return; }
    setMsg('定位中…', true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { from = { name: '我的位置', lat: pos.coords.latitude, lon: pos.coords.longitude }; $('planFrom').value = '我的位置'; setMsg(''); if (to) search(); },
      () => setMsg('無法取得位置，請允許網站使用定位，或直接輸入起點'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  }

  function renderRecent() {
    const list = store.get(KEY.recent, []);
    $('planRecentBlock').hidden = !list.length;
    $('planRecent').replaceChildren(...list.map((r) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = `${r.from.name} → ${r.to.name}`;
      b.addEventListener('click', () => { from = r.from; to = r.to; $('planFrom').value = from.name; $('planTo').value = to.name; search(); });
      return b;
    }));
  }

  // ---------- 開啟 / 關閉 ----------
  let prevTab = 'rail';
  const mains = ['railView', 'busView', 'metroView', 'bikeView'];
  function open() {
    const on = document.querySelector('.tabs button.on');
    prevTab = (on && on.dataset.tab) || 'rail';
    for (const id of mains) { const m = $(id); if (m) m.hidden = true; }
    document.querySelector('.tabs').hidden = true;
    $('planView').hidden = false;
    $('planBtn').hidden = true;
    window.scrollTo(0, 0);
  }
  function close() {
    $('planView').hidden = true;
    document.querySelector('.tabs').hidden = false;
    $('planBtn').hidden = false;
    const b = document.querySelector(`.tabs button[data-tab="${prevTab}"]`);
    if (b) b.click(); // 回到原本的分頁
  }

  $('planBtn').addEventListener('click', open);
  $('planBack').addEventListener('click', close);
  $('planSearch').addEventListener('click', search);
  $('planLocate').addEventListener('click', locate);
  $('planSwap').addEventListener('click', () => {
    [from, to] = [to, from];
    const a = $('planFrom').value; $('planFrom').value = $('planTo').value; $('planTo').value = a;
    if (from && to) search();
  });
  bindPlace('planFrom', (v) => { from = v; }, () => from);
  bindPlace('planTo', (v) => { to = v; }, () => to);
  renderRecent();
})();
