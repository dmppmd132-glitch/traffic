// 台鐵時刻 PWA 前端
// 功能：起迄站查詢、記住上次路線、常用路線、最近查詢、即時誤點
(() => {
  'use strict';

  // ---------- 小工具 ----------
  const $ = (id) => document.getElementById(id);
  const norm = (s) => (s || '').trim().replace(/台/g, '臺'); // 「台」「臺」視為相同

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

  const KEY = {
    last: 'tra.lastRoute',     // 上次查詢的路線 {from, to}
    favs: 'tra.favorites',     // 常用路線 [{from, to}]
    hist: 'tra.history',       // 最近查詢 [{from, to}]
    stations: 'tra.stations',  // 車站清單快取 {t, list}
  };
  const MAX_FAV = 8;
  const MAX_HIST = 8;
  const STATION_TTL = 7 * 24 * 3600 * 1000; // 車站清單快取 7 天

  // ---------- 狀態 ----------
  let stations = [];          // [{id, name}]
  let byName = new Map();     // 正規化名稱 -> id
  let byId = new Map();       // id -> 名稱
  let lastRows = [];          // 最近一次的查詢結果（用來刷新誤點）
  let lastQuery = null;

  // ---------- 日期時間 ----------
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const nowStr = () => {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const toMin = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };

  // ---------- API ----------
  async function api(path) {
    // API 網址前綴由 config.js 設定（前端放 GitHub Pages、後端在 Cloudflare Worker）
    const base = (window.TRA_API_BASE || '').replace(/\/$/, '');
    const res = await fetch(base + path);
    if (!res.ok) throw new Error('伺服器回應 ' + res.status);
    return res.json();
  }

  // 回應可能是陣列，或是 {某欄位: [...]} 的物件，這裡統一取出陣列
  function pickArray(data, preferKey) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data[preferKey])) return data[preferKey];
    if (data && typeof data === 'object') {
      for (const k of Object.keys(data)) if (Array.isArray(data[k])) return data[k];
    }
    return [];
  }

  async function loadStations() {
    const cached = store.get(KEY.stations, null);
    if (cached && Date.now() - cached.t < STATION_TTL && cached.list.length) {
      return cached.list;
    }
    try {
      const data = await api('/api/stations');
      const list = pickArray(data, 'Stations')
        .map((s) => ({
          id: s.StationID,
          name: s.StationName && (s.StationName.Zh_tw || s.StationName.En),
        }))
        .filter((s) => s.id && s.name);
      if (list.length) store.set(KEY.stations, { t: Date.now(), list });
      return list;
    } catch (err) {
      // 網路失敗時，退回使用過期的快取
      if (cached && cached.list.length) return cached.list;
      throw err;
    }
  }

  function applyStations(list) {
    stations = list;
    byName = new Map(list.map((s) => [norm(s.name), s.id]));
    byId = new Map(list.map((s) => [s.id, s.name]));
    const dl = $('stationList');
    dl.replaceChildren(
      ...list.map((s) => {
        const o = document.createElement('option');
        o.value = s.name;
        return o;
      })
    );
  }

  // ---------- 路線記憶 ----------
  const sameRoute = (a, b) => a.from === b.from && a.to === b.to;

  function pushHistory(route) {
    const hist = store.get(KEY.hist, []).filter((r) => !sameRoute(r, route));
    hist.unshift(route);
    store.set(KEY.hist, hist.slice(0, MAX_HIST));
  }

  function isFav(route) {
    return store.get(KEY.favs, []).some((r) => sameRoute(r, route));
  }

  function toggleFav(route) {
    let favs = store.get(KEY.favs, []);
    if (favs.some((r) => sameRoute(r, route))) {
      favs = favs.filter((r) => !sameRoute(r, route));
    } else {
      favs.unshift(route);
      favs = favs.slice(0, MAX_FAV);
    }
    store.set(KEY.favs, favs);
  }

  function currentRoute() {
    const from = byName.get(norm($('fromInput').value));
    const to = byName.get(norm($('toInput').value));
    return from && to ? { from, to } : null;
  }

  function fillRoute(route) {
    $('fromInput').value = byId.get(route.from) || '';
    $('toInput').value = byId.get(route.to) || '';
    refreshFavButton();
  }

  function refreshFavButton() {
    const r = currentRoute();
    const on = !!r && isFav(r);
    const btn = $('favBtn');
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? '★ 已加入' : '☆ 常用';
  }

  function renderChips() {
    const favs = store.get(KEY.favs, []).filter((r) => byId.has(r.from) && byId.has(r.to));
    const hist = store.get(KEY.hist, []).filter((r) => byId.has(r.from) && byId.has(r.to));

    const build = (container, list) => {
      container.replaceChildren(
        ...list.map((r) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'chip';
          b.textContent = `${byId.get(r.from)} → ${byId.get(r.to)}`;
          b.addEventListener('click', () => {
            fillRoute(r);
            search();
          });
          return b;
        })
      );
    };

    build($('favList'), favs);
    build($('histList'), hist);
    $('favBlock').hidden = favs.length === 0;
    $('histBlock').hidden = hist.length === 0;
    $('quickCard').hidden = favs.length === 0 && hist.length === 0;
  }

  // ---------- 查詢與顯示 ----------
  function setMsg(text, info = false) {
    const el = $('msg');
    el.textContent = text || '';
    el.classList.toggle('info', info);
  }

  // 從 TDX 回傳的時刻表中，取出起迄站之間的班次
  function parseTimetable(data, fromId, toId) {
    const list = pickArray(data, 'TrainTimetables');
    const rows = [];
    for (const t of list) {
      const info = t.TrainInfo || {};
      const stops = t.StopTimes || [];
      const a = stops.find((s) => s.StationID === fromId);
      const b = stops.find((s) => s.StationID === toId);
      if (!a || !b || a.StopSequence >= b.StopSequence) continue; // 方向不對就略過

      const dep = (a.DepartureTime || a.ArrivalTime || '').slice(0, 5);
      const arr = (b.ArrivalTime || b.DepartureTime || '').slice(0, 5);
      if (!dep || !arr) continue;

      let dur = toMin(arr) - toMin(dep);
      if (dur < 0) dur += 24 * 60; // 跨午夜
      rows.push({
        no: String(info.TrainNo || ''),
        type: (info.TrainTypeName && info.TrainTypeName.Zh_tw) || '',
        dep, arr, dur,
      });
    }
    rows.sort((x, y) => toMin(x.dep) - toMin(y.dep));
    return rows;
  }

  function typeClass(name) {
    if (/自強|太魯閣|普悠瑪|新自強/.test(name)) return 't-express';
    if (/莒光/.test(name)) return 't-chukuang';
    if (/區間/.test(name)) return 't-local';
    return '';
  }

  const fmtDur = (m) => (m >= 60 ? `${Math.floor(m / 60)} 小時 ${m % 60} 分` : `${m} 分`);

  function renderResults(rows, query, delayMap) {
    const box = $('results');
    const nowMin = toMin(nowStr());
    const isToday = query.date === todayStr();

    // 只顯示「選定時間之後」的班次
    const startMin = toMin(query.time);
    const shown = rows.filter((r) => toMin(r.dep) >= startMin);

    if (!shown.length) {
      box.replaceChildren(
        Object.assign(document.createElement('p'), {
          className: 'empty',
          textContent: rows.length ? '這個時間之後沒有班次了' : '找不到班次',
        })
      );
      return;
    }

    box.replaceChildren(
      ...shown.map((r) => {
        const card = document.createElement('div');
        card.className = 'train' + (isToday && toMin(r.dep) < nowMin ? ' past' : '');

        const row1 = document.createElement('div');
        row1.className = 'row1';
        const times = document.createElement('div');
        times.className = 'times';
        times.innerHTML = '';
        times.append(r.dep);
        const arrow = document.createElement('span');
        arrow.className = 'arrow';
        arrow.textContent = '→';
        times.append(arrow, r.arr);
        row1.append(times);

        const meta = document.createElement('div');
        meta.className = 'meta';
        const tag = document.createElement('span');
        tag.className = 'tag ' + typeClass(r.type);
        tag.textContent = r.type || '列車';
        const no = document.createElement('span');
        no.textContent = `${r.no} 次`;
        const dur = document.createElement('span');
        dur.textContent = fmtDur(r.dur);
        meta.append(tag, no, dur);

        // 誤點資訊（只有今天、且列車目前有在即時資料裡才顯示）
        if (isToday && delayMap && delayMap.has(r.no)) {
          const d = delayMap.get(r.no);
          const el = document.createElement('span');
          el.className = 'delay ' + (d > 0 ? 'late' : 'ontime');
          el.textContent = d > 0 ? `誤點 ${d} 分` : '準點';
          meta.append(el);
        }

        card.append(row1, meta);
        return card;
      })
    );
  }

  async function fetchDelays() {
    try {
      const data = await api('/api/delay');
      const list = pickArray(data, 'LiveTrainDelay');
      const map = new Map();
      for (const d of list) {
        if (d.TrainNo != null) map.set(String(d.TrainNo), Number(d.DelayTime) || 0);
      }
      return map;
    } catch {
      return null; // 誤點資料抓不到就不顯示，不影響主要功能
    }
  }

  async function search() {
    const route = currentRoute();
    if (!route) {
      setMsg('請從清單中選擇正確的車站名稱');
      return;
    }
    if (route.from === route.to) {
      setMsg('出發與抵達不能是同一站');
      return;
    }
    const date = $('dateInput').value || todayStr();
    const time = $('timeInput').value || '00:00';

    setMsg('查詢中…', true);
    $('results').replaceChildren();

    try {
      const data = await api(`/api/timetable?from=${route.from}&to=${route.to}&date=${date}`);
      const rows = parseTimetable(data, route.from, route.to);
      const delayMap = date === todayStr() ? await fetchDelays() : null;

      lastRows = rows;
      lastQuery = { ...route, date, time };
      renderResults(rows, lastQuery, delayMap);
      setMsg('');

      // 記住這次的路線
      store.set(KEY.last, route);
      pushHistory(route);
      renderChips();
      refreshFavButton();
    } catch (err) {
      setMsg(navigator.onLine ? '查詢失敗：' + err.message : '目前離線，無法查詢');
    }
  }

  // 每 60 秒刷新一次誤點（只在頁面可見、且查的是今天時）
  setInterval(async () => {
    if (document.hidden || !lastQuery || lastQuery.date !== todayStr()) return;
    const delayMap = await fetchDelays();
    if (delayMap) renderResults(lastRows, lastQuery, delayMap);
  }, 60000);

  // ---------- 事件 ----------
  function bindEvents() {
    $('searchBtn').addEventListener('click', search);

    $('swapBtn').addEventListener('click', () => {
      const a = $('fromInput').value;
      $('fromInput').value = $('toInput').value;
      $('toInput').value = a;
      refreshFavButton();
      if (currentRoute()) search();
    });

    $('nowBtn').addEventListener('click', () => {
      $('dateInput').value = todayStr();
      $('timeInput').value = nowStr();
      if (currentRoute()) search();
    });

    $('favBtn').addEventListener('click', () => {
      const r = currentRoute();
      if (!r) { setMsg('請先選擇起訖站'); return; }
      toggleFav(r);
      refreshFavButton();
      renderChips();
    });

    $('clearHist').addEventListener('click', () => {
      store.set(KEY.hist, []);
      renderChips();
    });

    for (const id of ['fromInput', 'toInput']) {
      $(id).addEventListener('input', refreshFavButton);
      // 選到清單項目後，若兩站都有效就自動查詢
      $(id).addEventListener('change', () => { if (currentRoute()) search(); });
    }

    // 回到前景時，把時間更新到現在（只在使用者沒改過日期時）
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && $('dateInput').value === todayStr()) {
        $('timeInput').value = nowStr();
      }
    });

    // 離線 / 上線提示
    const updateNet = () => { $('netStatus').hidden = navigator.onLine; };
    window.addEventListener('online', updateNet);
    window.addEventListener('offline', updateNet);
    updateNet();
  }

  // ---------- 啟動 ----------
  async function init() {
    bindEvents();
    $('dateInput').value = todayStr();
    $('timeInput').value = nowStr();

    try {
      applyStations(await loadStations());
    } catch (err) {
      setMsg('無法載入車站清單：' + err.message);
      return;
    }

    renderChips();

    // 還原上次路線，並自動查詢
    const last = store.get(KEY.last, null);
    if (last && byId.has(last.from) && byId.has(last.to)) {
      fillRoute(last);
      search();
    }
  }

  init();

  // 註冊 Service Worker（讓 App 可安裝、可離線開啟）
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* 忽略 */ });
    });
  }
})();
