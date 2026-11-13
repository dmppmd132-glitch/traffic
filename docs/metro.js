// 高雄捷運 / 高雄輕軌：車站查詢 + 即時到站（資料來自 TDX，經 Cloudflare Worker 代理）
(() => {
  'use strict';

  // 個人版（如 yayu）：同網域下各版本的 localStorage 用前綴分開，一般版維持原本的鍵名
  const PROFILE = window.TRA_PROFILE || {};
  const PFX = PROFILE.prefix || '';
  const $ = (id) => document.getElementById(id);
  const norm = (s) => (s || '').trim().replace(/台/g, '臺');
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(PFX + key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(key, val) { try { localStorage.setItem(PFX + key, JSON.stringify(val)); } catch { /* 忽略 */ }
    },
  };
  const KEY = {
    op: 'tra.metro.op',
    last: 'tra.metro.last',                 // {op, id, name}
    favs: 'tra.metro.favs',                 // [{op, id, name}]
    stations: (op) => `tra.metro.stations.${op}`, // {t, lines}
  };
  const STATIONS_TTL = 7 * 24 * 3600 * 1000;
  const REFRESH_MS = 45000;
  const MAX_FAV = 10;
  // 營運商：一般版為高雄；個人版由 profile.metroOps 指定（TDX 代碼 → 顯示名稱）
  const OPS = PROFILE.metroOps || { KRTC: '高雄捷運', KLRT: '高雄輕軌' };
  const FIRST_OP = Object.keys(OPS)[0];

  async function api(path, ms = 15000) {
    const base = (window.TRA_API_BASE || '').replace(/\/$/, '');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(base + path, { signal: ctrl.signal });
      if (!res.ok) {
        let msg = '伺服器回應 ' + res.status;
        try { const b = await res.json(); if (b && b.status) msg += `（TDX ${b.status} ${b.path || ''} ${String(b.detail || '').slice(0, 80)}）`; } catch { /* 忽略 */ }
        throw new Error(msg);
      }
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

  // ---------- 狀態 ----------
  let op = store.get(KEY.op, FIRST_OP);
  if (!OPS[op]) op = FIRST_OP;
  let lines = [];            // [{id, name, color, stations:[{id,name}]}]
  let activeLine = '';       // 目前顯示哪一條線的車站
  let cur = null;            // 目前選的車站 {op, id, name}
  let liveList = null;       // 最近一次即時資料（整個營運商）
  let started = false;
  let loadSeq = 0;

  // 各路線的官方代表色（以 LineID 比對）：臺北捷運 BL/R/G/O/BR、環狀線 Y
  const LINE_COLORS = { BL: '#0070bd', R: '#e3002c', G: '#008659', O: '#f8b61c', BR: '#c48c31', Y: '#d4aa00' };
  const lineColor = (id, name) => {
    if (LINE_COLORS[String(id || '').toUpperCase()] && PROFILE.metroOps) return LINE_COLORS[String(id).toUpperCase()];
    const s = `${id || ''}${name || ''}`;
    if (/^R|紅/.test(s)) return '#d9392b';
    if (/^O|橘/.test(s)) return '#f08a00';
    if (/^C|環/.test(s)) return '#3a9b5c';
    return '#4c8dff';
  };

  // ---------- 車站清單 ----------
  function parseLines(data) {
    const arr = pickArray(data);
    // 正常格式：每筆是一條路線，裡面有 Stations
    if (arr.some((l) => Array.isArray(l.Stations))) {
      return arr.map((l) => {
        const id = l.LineID || l.LineNo || '';
        const name = nm(l.LineName) || id;
        const stations = (l.Stations || [])
          .map((s) => ({ id: s.StationID, name: nm(s.StationName), seq: Number(s.Sequence) || 0 }))
          .filter((s) => s.id && s.name)
          .sort((a, b) => a.seq - b.seq);
        return { id, name, color: lineColor(id, name), stations };
      }).filter((l) => l.stations.length);
    }
    // 備援格式：單純的車站清單，依站號開頭字母分線（R 紅線、O 橘線、C 環狀輕軌）
    const NAMES = { R: '紅線', O: '橘線', C: '環狀輕軌', BL: '板南線', G: '松山新店線', BR: '文湖線', Y: '環狀線', V: '淡海輕軌', K: '安坑輕軌' };
    const groups = new Map();
    for (const s of arr) {
      const id = s.StationID;
      const name = nm(s.StationName);
      if (!id || !name) continue;
      const code = (/^[A-Za-z]+/.exec(id) || ['其他'])[0].toUpperCase();
      if (!groups.has(code)) groups.set(code, []);
      groups.get(code).push({ id, name, seq: parseInt(String(id).replace(/\D/g, ''), 10) || 0 });
    }
    return [...groups.entries()].map(([code, list]) => ({
      id: code,
      name: NAMES[code] || code,
      color: lineColor(code, NAMES[code]),
      stations: list.sort((a, b) => a.seq - b.seq),
    }));
  }

  async function loadLines(o) {
    const cached = store.get(KEY.stations(o), null);
    if (cached && Date.now() - cached.t < STATIONS_TTL && cached.lines.length) return cached.lines;
    try {
      const data = await api(`/api/metro/stations?op=${o}`);
      const list = parseLines(data);
      if (list.length) store.set(KEY.stations(o), { t: Date.now(), lines: list });
      return list;
    } catch (err) {
      if (cached && cached.lines.length) return cached.lines;
      throw err;
    }
  }

  // ---------- 畫面：營運商 / 路線 / 車站 ----------
  function setMsg(t, info) {
    const el = $('metroMsg');
    el.textContent = t || '';
    el.classList.toggle('info', !!info);
  }

  function renderOps() {
    document.querySelectorAll('#metroOps button').forEach((b) => b.classList.toggle('on', b.dataset.op === op));
  }

  function renderLines() {
    const box = $('metroLines');
    box.replaceChildren(...lines.map((l) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (l.id === activeLine ? ' on' : '');
      b.innerHTML = `<span class="dot" style="background:${l.color}"></span>`;
      b.append(l.name);
      b.addEventListener('click', () => { activeLine = l.id; $('metroInput').value = ''; renderLines(); renderStations(); });
      return b;
    }));
  }

  function stationChip(s, color) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (cur && cur.id === s.id ? ' on' : '');
    b.innerHTML = `<span class="dot" style="background:${color}"></span>`;
    b.append(s.name);
    b.addEventListener('click', () => selectStation({ op, id: s.id, name: s.name }));
    return b;
  }

  function renderStations() {
    const q = norm($('metroInput').value);
    const box = $('metroSuggest');
    let chips = [];
    if (q) {
      const seen = new Set();
      for (const l of lines) for (const s of l.stations) {
        if (norm(s.name).includes(q) || s.id.toLowerCase() === q.toLowerCase()) {
          if (seen.has(s.id)) continue;
          seen.add(s.id);
          chips.push(stationChip(s, l.color));
        }
      }
      if (!chips.length) setMsg('找不到符合的車站', false); else setMsg('');
    } else {
      setMsg('');
      const l = lines.find((x) => x.id === activeLine) || lines[0];
      if (l) chips = l.stations.map((s) => stationChip(s, l.color));
    }
    box.replaceChildren(...chips.slice(0, 60));
  }

  // ---------- 常用 / 記憶 ----------
  const sameSt = (a, b) => a.op === b.op && a.id === b.id;
  const isFav = (st) => store.get(KEY.favs, []).some((f) => sameSt(f, st));
  function toggleFav(st) {
    let favs = store.get(KEY.favs, []);
    favs = favs.some((f) => sameSt(f, st)) ? favs.filter((f) => !sameSt(f, st)) : [st, ...favs].slice(0, MAX_FAV);
    store.set(KEY.favs, favs);
  }
  function renderFavs() {
    const favs = store.get(KEY.favs, []);
    $('metroFavCard').hidden = favs.length === 0;
    $('metroFavs').replaceChildren(...favs.map((f) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = `${OPS[f.op] || f.op}・${f.name}`;
      b.addEventListener('click', async () => {
        if (f.op !== op) await switchOp(f.op, true);
        selectStation(f);
      });
      return b;
    }));
    const btn = $('metroFavBtn');
    const on = !!cur && isFav(cur);
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? '★ 已加入' : '☆ 常用';
  }

  // ---------- 即時到站 ----------
  function parseEta(v) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
    return v > 120 ? Math.round(v / 60) : v; // 通常是分鐘；若資料是秒數則換算
  }
  const etaText = (m) => (m === null ? '—' : m <= 0 ? '進站中' : `${m} 分`);
  const etaClass = (m) => (m === null ? 'none' : m <= 0 ? 'now' : m <= 2 ? 'soon' : '');

  function renderBoard() {
    const box = $('metroBoard');
    if (!cur) return;
    const rows = (liveList || []).filter((r) => r.StationID === cur.id);
    if (!rows.length) {
      box.innerHTML = '<p class="empty">目前沒有列車資訊（可能已收班或資料暫缺）</p>';
      return;
    }
    const groups = new Map();
    for (const r of rows) {
      let head = r.TripHeadSign || nm(r.DestinationStationName) || '';
      head = head.replace(/^往\s*/, '');
      const key = head || '—';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(parseEta(r.EstimateTime));
    }
    const els = [...groups.entries()].map(([head, etas]) => {
      etas.sort((a, b) => (a === null) - (b === null) || a - b);
      const row = document.createElement('div');
      row.className = 'stoprow';
      const name = document.createElement('span');
      name.className = 'stopname';
      name.textContent = `往 ${head}`;
      row.append(name);
      etas.slice(0, 3).forEach((m) => {
        const e = document.createElement('span');
        e.className = 'eta ' + etaClass(m);
        e.textContent = etaText(m);
        row.append(e);
      });
      return row;
    });
    box.replaceChildren(...els);
    const t = new Date();
    $('metroUpdated').textContent = `更新時間 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}（每 20 秒自動更新）`;
  }

  async function refreshLive() {
    if (!cur) return;
    const seq = ++loadSeq;
    try {
      const data = await api(`/api/metro/live?op=${cur.op}`);
      if (seq !== loadSeq) return;
      liveList = pickArray(data);
      if (!liveList.length) console.info('metro live empty', cur.op, data);
      renderBoard();
    } catch (err) {
      if (seq !== loadSeq) return;
      $('metroBoard').innerHTML = `<p class="empty">到站資料載入失敗（${err.message}），請稍後再試。</p>`;
    }
  }

  function selectStation(st) {
    cur = st;
    store.set(KEY.last, st);
    $('metroBoardCard').hidden = false;
    $('metroStationTitle').textContent = `${OPS[st.op] || st.op}・${st.name}`;
    $('metroUpdated').textContent = '載入中…';
    $('metroBoard').replaceChildren();
    liveList = null;
    renderStations();
    renderFavs();
    refreshLive();
  }

  // ---------- 切換營運商 ----------
  async function switchOp(o, silent) {
    op = o;
    store.set(KEY.op, o);
    renderOps();
    lines = [];
    $('metroLines').replaceChildren();
    $('metroSuggest').replaceChildren();
    if (!silent) { cur = null; $('metroBoardCard').hidden = true; }
    setMsg('載入車站中…', true);
    try {
      lines = await loadLines(o);
      activeLine = (lines[0] && lines[0].id) || '';
      setMsg('');
      renderLines();
      renderStations();
      if (!lines.length) setMsg('沒有取得車站資料');
    } catch (err) {
      setMsg('無法載入車站清單：' + err.message);
    }
  }

  async function start() {
    if (started) return;
    started = true;
    renderOps();
    renderFavs();
    await switchOp(op, true);
    const last = store.get(KEY.last, null);
    if (last && last.op === op && lines.some((l) => l.stations.some((s) => s.id === last.id))) selectStation(last);
  }

  // ---------- 事件 ----------
  const isVisible = () => !$('metroView').hidden && !document.hidden;

  document.querySelectorAll('#metroOps button').forEach((b) => {
    b.addEventListener('click', () => { if (b.dataset.op !== op) { $('metroInput').value = ''; switchOp(b.dataset.op, false); } });
  });
  $('metroInput').addEventListener('input', renderStations);
  $('metroFavBtn').addEventListener('click', () => { if (cur) { toggleFav(cur); renderFavs(); } });

  document.addEventListener('tabchange', (e) => {
    if (e.detail && e.detail.tab === 'metro') { started ? refreshLive() : start(); }
  });
  document.addEventListener('visibilitychange', () => { if (isVisible() && cur) refreshLive(); });
  setInterval(() => { if (isVisible() && cur) refreshLive(); }, REFRESH_MS);

  if (!$('metroView').hidden) start();
})();
