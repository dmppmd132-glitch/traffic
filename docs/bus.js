// 公車功能（預設高雄）：路線搜尋、站序與即時到站、常用路線 / 站牌、最近查詢
// 同時負責「台鐵 / 公車」分頁切換
(() => {
  'use strict';

  // ---------- 小工具 ----------
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');

  // 個人版（如 yayu）：同網域下各版本的 localStorage 用前綴分開，一般版維持原本的鍵名
  const PROFILE = window.TRA_PROFILE || {};
  const PFX = PROFILE.prefix || '';

  // localStorage 安全讀寫（私密模式可能丟例外）
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(PFX + key);
        return v ? JSON.parse(v) : fallback;
      } catch { return fallback; }
    },
    set(key, val) {
      try { localStorage.setItem(PFX + key, JSON.stringify(val)); } catch { /* 忽略 */ }
    },
  };

  // 縣市：一般版固定高雄；個人版可在 profile 設定多個縣市並在畫面上切換
  const CITIES = Array.isArray(PROFILE.cities) && PROFILE.cities.length ? PROFILE.cities : null;
  const DEFAULT_CENTER = [22.63, 120.3]; // 高雄市區
  let CITY = (CITIES && CITIES[0].id) || window.TRA_BUS_CITY || 'Kaohsiung';
  if (CITIES) {
    try {
      const saved = JSON.parse(localStorage.getItem(PFX + 'tra.bus.city') || 'null');
      if (CITIES.some((c) => c.id === saved)) CITY = saved;
    } catch { /* 忽略 */ }
  }
  const cityCenter = () => ((CITIES || []).find((c) => c.id === CITY) || {}).center || DEFAULT_CENTER;
  // 多縣市時，路線、常用、最近查詢依縣市分開記憶
  const ck = (base) => (CITIES ? `${base}.${CITY}` : base);
  const KEY = {
    tab: 'tra.tab',              // 上次使用的分頁
    get routes() { return ck('tra.bus.routes'); },       // 路線清單快取 {t, list}
    get last() { return ck('tra.bus.last'); },           // 上次查看的路線 {route, dir, sub}
    get favRoutes() { return ck('tra.bus.favRoutes'); }, // 常用路線 [路線名稱]
    get favStops() { return ck('tra.bus.favStops'); },   // 常用站牌 [{route, dir, sub, uid, name, label}]
    get hist() { return ck('tra.bus.history'); },        // 最近查詢 [路線名稱]
  };
  const BUS_EMOJI = PROFILE.busEmoji || '🚌';
  const ROUTES_TTL = 7 * 24 * 3600 * 1000; // 路線清單快取 7 天
  const MAX_FAV_ROUTES = 10;
  const MAX_FAV_STOPS = 10;
  const MAX_HIST = 8;
  const REFRESH_MS = 20000; // 到站時間自動更新間隔

  async function api(path, ms = 20000) {
    const base = (window.TRA_API_BASE || '').replace(/\/$/, '');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms); // 逾時就中止，讓畫面能顯示錯誤而不是一直轉圈
    try {
      const res = await fetch(base + path, { signal: ctl.signal });
      if (!res.ok) throw new Error('伺服器回應 ' + res.status);
      return await res.json();
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error('連線逾時：' + path.split('?')[0].replace('/api/', ''));
      throw err;
    } finally {
      clearTimeout(timer);
    }
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
  let busMap = null;   // Leaflet 地圖物件（第一次顯示時才建立）
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

  // 有輸入內容才顯示清除按鈕
  function syncClearBtn() {
    $('busClearInput').hidden = !$('busInput').value;
  }

  // 清除輸入與目前路線畫面，方便查詢下一筆
  function clearBusSearch() {
    openSeq++;           // 取消還在載入中的路線
    cur = null;          // 停止到站與車輛的定時更新
    $('busInput').value = '';
    $('busSuggest').replaceChildren();
    $('busRoute').hidden = true;
    if (!ttSheet.hidden) closeTimetable();
    setMsg('');
    syncClearBtn();
    $('busInput').focus();
  }

  function renderSuggest() {
    syncClearBtn();
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
            lat: Number(s.StopPosition && s.StopPosition.PositionLat),
            lon: Number(s.StopPosition && s.StopPosition.PositionLon),
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

  // 路線形狀：回傳多條線，每條 [[緯度, 經度], ...]，並記下方向
  function parseGeometry(data, routeName) {
    const lines = [];
    for (const item of pickArray(data)) {
      const nm = item.RouteName && item.RouteName.Zh_tw;
      if (routeName && nm && nm !== routeName) continue;
      const g = item.Geometry;
      if (!g) continue;
      let line = [];
      if (typeof g === 'string') {
        // WKT：LINESTRING(經度 緯度, ...)，MULTILINESTRING 也能處理
        const re = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g;
        let m;
        while ((m = re.exec(g))) line.push([parseFloat(m[2]), parseFloat(m[1])]);
      } else {
        const coords = g.coordinates || g.Coordinates; // GeoJSON：[經度, 緯度]
        if (Array.isArray(coords)) {
          line = coords
            .map((p) => (Array.isArray(p) ? [Number(p[1]), Number(p[0])] : [Number(p.PositionLat || p.Lat), Number(p.PositionLon || p.Lon)]))
            .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
        }
      }
      if (line.length > 1) {
        line.dir = item.Direction;
        line.sub = item.SubRouteUID || '';
        lines.push(line);
      }
    }
    return lines;
  }

  // 公車即時座標：只留本方向、營運中、有座標的車
  const BUS_STATUS = { 1: '車禍', 2: '故障', 3: '塞車', 4: '緊急求援', 5: '加油', 100: '客滿' };
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  function parsePositions(data, entry) {
    return pickArray(data)
      .map((b) => ({
        plate: b.PlateNumb || '',
        dir: b.Direction,
        sub: b.SubRouteUID || '',
        lat: b.BusPosition && b.BusPosition.PositionLat,
        lon: b.BusPosition && b.BusPosition.PositionLon,
        status: b.BusStatus,
        duty: b.DutyStatus,
      }))
      .filter((b) => isNum(b.lat) && isNum(b.lon))
      .filter((b) => b.dir === entry.dir && (!entry.sub || !b.sub || b.sub === entry.sub))
      .filter((b) => b.status !== 99 && b.duty !== 2); // 非營運 / 已收班
  }

  const DAY_KEYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const DAY_ZH = { Monday: '一', Tuesday: '二', Wednesday: '三', Thursday: '四', Friday: '五', Saturday: '六', Sunday: '日' };
  // Premium 的 ServiceDay 是 {ServiceTag:'平日'|'周末'}；轉成與基本班表相同的星期旗標，之後的篩選與標籤就能共用
  const normService = (sd) => {
    if (!sd || typeof sd !== 'object' || !sd.ServiceTag) return sd || null;
    const tag = String(sd.ServiceTag);
    const on = (days) => Object.fromEntries(DAY_KEYS.map((k) => [k, days.includes(k) ? 1 : 0]));
    if (/平日/.test(tag)) return on(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);
    if (/[周週]末|假日/.test(tag)) return on(['Saturday', 'Sunday']);
    return null; // 不認得的標籤：視為每天都行駛
  };
  const runsOn = (sd, key) => !sd || sd[key] === 1 || sd[key] === true;
  const dayLabel = (sd) => {
    if (!sd) return '';
    const days = WEEK.filter((k) => runsOn(sd, k));
    if (days.length === 7) return '每日';
    if (days.length === 5 && !runsOn(sd, 'Saturday') && !runsOn(sd, 'Sunday')) return '平日';
    if (days.length === 2 && runsOn(sd, 'Saturday') && runsOn(sd, 'Sunday')) return '假日';
    return days.length ? '週' + days.map((k) => DAY_ZH[k]).join('') : '';
  };

  function parseSchedule(data) {
    const rows = [];
    const freqs = [];
    const today = DAY_KEYS[new Date().getDay()];
    // Basic Schedule 使用 ArrivalTime / DepartureTime；Premium v3 使用 HistoricalEstArrivalTime。
    const stopTime = (s) => (
      s && (s.DepartureTime || s.ArrivalTime || s.HistoricalEstArrivalTime || s.EstimatedArrivalTime) || ''
    ).slice(0, 5);
    // Premium 的結構多一層：[{RouteName, Schedules:[{SubRouteUID, Direction, Timetables}]}]，先攤平成「每個方向一組」
    const groups = [];
    for (const g of pickArray(data)) {
      if (g && Array.isArray(g.Schedules)) {
        for (const sg of g.Schedules) groups.push({ ...sg, SubRouteName: sg.SubRouteName || g.RouteName });
      } else groups.push(g);
    }
    const nameOf = (n) => (n && typeof n === 'object' ? n.Zh_tw : n); // Premium 的名稱是字串，Basic 是 {Zh_tw}
    for (const group of groups) {
      const direction = group.Direction;
      const timetables = group.Timetables || group.Trips || [];
      for (const trip of timetables) {
        const stops = trip.StopTimes || trip.Stops || [];
        const first = stops.find((s) => Number(s.StopSequence) === 1) || stops[0];
        const last = stops[stops.length - 1];
        const dep = stopTime(first);
        if (!dep) continue;
        rows.push({
          direction,
          sub: group.SubRouteUID || '',
          label: nameOf(group.SubRouteName),
          service: normService(trip.ServiceDay || group.ServiceDay),
          dep,
          end: stopTime(last),
          stopTimes: stops.map((s) => ({
            uid: s.StopUID || s.StopID || '',
            seq: Number(s.StopSequence),
            time: stopTime(s),
          })).filter((s) => s.time),
        });
      }
      // 班距式班表（例如「每 10–15 分鐘一班」），沒有逐站時間
      for (const f of group.Frequencys || group.Frequencies || []) {
        freqs.push({
          direction,
          sub: group.SubRouteUID || '',
          start: (f.StartTime || '').slice(0, 5),
          end: (f.EndTime || '').slice(0, 5),
          min: f.MinHeadwayMins,
          max: f.MaxHeadwayMins,
          service: f.ServiceDay || group.ServiceDay || null,
        });
      }
    }
    // 只留今天有行駛的班次；若篩完沒有，就保留全部避免整個空白
    const todayRows = rows.filter((r) => runsOn(r.service, today));
    const out = (todayRows.length ? todayRows : rows)
      .sort((a, b) => a.direction - b.direction || a.dep.localeCompare(b.dep));
    const todayFreqs = freqs.filter((f) => runsOn(f.service, today));
    out.freqs = (todayFreqs.length ? todayFreqs : freqs)
      .sort((a, b) => a.direction - b.direction || a.start.localeCompare(b.start));
    return out;
  }

  // ---------- 手動時刻表（schedule-local.json）：公開資料沒有該路線班表時使用 ----------
  let localSchedulePromise = null;
  function loadLocalSchedule() {
    if (!localSchedulePromise) {
      localSchedulePromise = fetch('schedule-local.json', { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}));
    }
    return localSchedulePromise;
  }

  // 依路線名稱找手動班表：完全相同 > aliases 別名 > 名稱以某個鍵開頭
  // 例如 TDX 的路線名稱是「60覺民幹線」，檔案裡寫「60」也能對上；取最長的鍵，
  // 且鍵後面不能接數字或英文字母（避免「600」「60A」誤對到「60」）
  function findLocalSchedule(local, route) {
    if (!local || !route) return null;
    if (local[route]) return local[route];
    const keys = Object.keys(local);
    for (const k of keys) {
      const al = local[k] && local[k].aliases;
      if (Array.isArray(al) && al.includes(route)) return local[k];
    }
    let best = null;
    for (const k of keys) {
      if (!route.startsWith(k)) continue;
      const rest = route.slice(k.length);
      // 數字基礎路線可套用 A/B/D 等支線（例如本地「70」對應 TDX「70A」）；
      // 但不能把「60」誤套到「600」或「60A」以外的其他數字路線。
      const numericBase = /^\d+$/.test(k);
      const isLetterVariant = numericBase && /^[A-Za-z](?:[^0-9]*)/.test(rest);
      const isExactBase = !rest;
      if ((isExactBase || isLetterVariant || !/[0-9A-Za-z]/.test(rest.charAt(0))) && (!best || k.length > best.length)) best = k;
    }
    return best ? local[best] : null;
  }

  const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(t); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const fmtMin = (n) => `${String(Math.floor(n / 60) % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

  // 站名比對用：去掉空白與括號符號，「台」「臺」視為相同
  const normName = (v) => String(v || '').replace(/[()（）\s]/g, '').replace(/台/g, '臺');

  // 挑出要顯示的班次群組：
  // 群組若有 "to"（終點站名稱），就用目前方向的終點站去比對，不依賴 0 / 1 的編號（避免方向編號搞反）；
  // 沒有 "to" 或比對不到時，才用 directions 的 0 / 1 編號
  function pickLocalGroups(info, entry) {
    const dirs = info.directions || {};
    const all = Object.values(dirs).flat();
    const lastStop = entry.stops && entry.stops.length ? normName(entry.stops[entry.stops.length - 1].name) : '';
    if (lastStop && all.some((g) => g.to)) {
      const hit = all.filter((g) => {
        const to = normName(g.to);
        return to && (to.includes(lastStop) || lastStop.includes(to));
      });
      if (hit.length) return hit;
    }
    return dirs[String(entry.dir)] || dirs[entry.dir] || [];
  }

  // 班次群組是否適用今天：標題含「例假日」= 週六日、「平常日」= 週一到週五；其他標題一律視為適用
  // （國定假日與補班日無法判斷，請以公車處公告為準）
  function localGroupIsToday(g) {
    const weekend = [0, 6].includes(new Date().getDay());
    const d = String(g.days || '');
    if (/例假日|假日/.test(d)) return weekend;
    if (/平常日|平日/.test(d)) return !weekend;
    return true;
  }

  function renderLocalSchedule(info, entry) {
    const box = $('busTimetable');
    const picked = pickLocalGroups(info, entry);
    if (!picked.length) return false;
    const groups = [...picked].sort((a, b) => Number(localGroupIsToday(b)) - Number(localGroupIsToday(a))); // 今天適用的排前面（穩定排序）
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const chips = (list, today = true) => list.map((t) => {
      const m = toMin(t);
      return `<span class="t${today && m !== null && m < nowMin ? ' past' : ''}">${t}</span>`;
    }).join('');
    const rows = [];
    if (info.from) {
      const head = document.createElement('div');
      head.className = 'schedule-row stop-schedule';
      head.innerHTML = `<span class="stop-seq"></span><span class="schedule-end">${info.updated ? '資料日期 ' + info.updated : '手動班表'}</span>`;
      rows.push(head);
    }
    for (const g of groups) {
      const today = localGroupIsToday(g);
      const isDayTyped = /例假日|假日|平常日|平日/.test(String(g.days || ''));
      const title = document.createElement('div');
      title.className = 'schedule-row stop-schedule local-title';
      title.innerHTML = `<span class="stop-seq"></span><span class="schedule-stop-name">${g.days || '班次'}${isDayTyped && today ? '（今天）' : ''}${g.note ? '　<small>' + g.note + '</small>' : ''}</span>`;
      rows.push(title);
      const stops = g.stops || [];
      if (stops.length) {
        // 逐站時間：每站可直接寫 times，或只寫 offset（距離起點發車的分鐘數），由發車時間自動推算
        stops.forEach((st, i) => {
          let list = st.times;
          if (!list || !list.length) {
            const off = Number(st.offset) || 0;
            list = (g.times || []).map((t) => { const m = toMin(t); return m === null ? t : fmtMin(m + off); });
          }
          const row = document.createElement('div');
          row.className = 'schedule-row stop-schedule';
          row.innerHTML = `<span class="stop-seq">${i + 1}</span><span class="schedule-stop-name">${st.name || `第 ${i + 1} 站`}</span><span class="schedule-times">${chips(list, today)}</span>`;
          rows.push(row);
        });
      } else {
        const row = document.createElement('div');
        row.className = 'schedule-row stop-schedule';
        row.innerHTML = `<span class="stop-seq"></span><span class="schedule-stop-name">${info.from ? info.from + ' 發車' : '發車時間'}</span><span class="schedule-times">${chips(g.times || [], today)}</span>`;
        rows.push(row);
      }
    }
    box.replaceChildren(...rows);
    $('busScheduleStatus').textContent = '手動班表';
    return true;
  }

  function renderTimetable(rows) {
    const box = $('busTimetable');
    const entry = cur.entries[cur.active];
    if (!rows.length) {
      const all = rows.freqs || [];
      const fr = all.filter((f) => f.direction === entry.dir && (!f.sub || !entry.sub || f.sub === entry.sub));
      const list = fr.length ? fr : all.filter((f) => f.direction === entry.dir);
      if (list.length) {
        box.replaceChildren(...list.map((f) => {
          const row = document.createElement('div');
          row.className = 'schedule-row';
          const gap = f.min && f.max && f.min !== f.max ? `${f.min}–${f.max}` : (f.min || f.max || '');
          row.innerHTML = `<span class="schedule-time">${f.start}</span><span>${f.end ? '至 ' + f.end : ''}　${gap ? '約每 ' + gap + ' 分鐘一班' : ''}</span><span class="schedule-end">${dayLabel(f.service)}</span>`;
          return row;
        }));
        $('busScheduleStatus').textContent = '班距式班表';
        return;
      }
      box.innerHTML = '<p class="empty">此路線的公開資料沒有提供站站時刻，請以即時到站為準。</p>';
      $('busScheduleStatus').textContent = '無資料';
      console.info('bus schedule empty for', cur.route, cur.scheduleData);
      return;
    }
    const shown = rows.filter((r) => r.direction === entry.dir && (!r.sub || r.sub === entry.sub));
    const use = shown.length ? shown : rows.filter((r) => r.direction === entry.dir);
    const selected = use.length ? use : rows;
    const byStop = new Map();
    selected.forEach((trip) => trip.stopTimes.forEach((stop) => {
      const key = stop.uid || String(stop.seq);
      if (!byStop.has(key)) byStop.set(key, { uid: stop.uid, seq: stop.seq, times: [] });
      byStop.get(key).times.push(stop.time);
    }));
    const rowsByStop = [...byStop.values()].sort((a, b) => a.seq - b.seq);
    box.replaceChildren(...rowsByStop.map((s) => {
      const station = entry.stops.find((x) => (s.uid && x.uid === s.uid) || x.seq === s.seq);
      const row = document.createElement('div');
      row.className = 'schedule-row stop-schedule';
      const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
      const times = [...s.times].sort().map((t) => {
        const m = /^(\d{1,2}):(\d{2})/.exec(t);
        const past = m && (Number(m[1]) * 60 + Number(m[2])) < nowMin;
        return `<span class="t${past ? ' past' : ''}">${t}</span>`;
      }).join('');
      row.innerHTML = `<span class="stop-seq">${s.seq}</span><span class="schedule-stop-name">${station ? station.name : `第 ${s.seq} 站`}</span><span class="schedule-times">${times}</span>`;
      return row;
    }));
    $('busScheduleStatus').textContent = `${rowsByStop.length} 站／${selected.length} 班`;
  }

  // ---------- 地圖（Leaflet 街道地圖，第一次顯示時才載入）----------
  const LEAFLET_SOURCES = [
    ['https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'],
    ['https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css', 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'],
  ];
  let leafletReady = null;
  let tiles = null;
  let routeLayer = null;
  let busLayer = null;
  let meLayer = null;
  let mapKey = '';

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      const timer = setTimeout(() => { sc.remove && sc.remove(); reject(new Error('逾時')); }, 12000);
      sc.src = src;
      sc.onload = () => { clearTimeout(timer); resolve(); };
      sc.onerror = () => { clearTimeout(timer); sc.remove && sc.remove(); reject(new Error('失敗')); };
      document.head.append(sc);
    });
  }

  // 依序嘗試 unpkg、cdnjs 兩個來源
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletReady) return leafletReady;
    leafletReady = (async () => {
      for (const [css, js] of LEAFLET_SOURCES) {
        try {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = css;
          document.head.append(link);
          await loadScript(js);
          if (window.L) return;
        } catch { /* 換下一個來源 */ }
      }
      throw new Error('地圖元件載入失敗，請檢查網路');
    })().catch((err) => { leafletReady = null; throw err; });
    return leafletReady;
  }

  // 底圖：預設使用 Esri 灰階簡易街道圖（免金鑰，道路加淡色路名，沒有雜色）
  // 淺色 / 深色模式會依系統設定自動切換對應圖磚
  // 想換成其他圖磚，可在 config.js 設定 window.TRA_MAP_TILE_URL 與 window.TRA_MAP_ATTRIBUTION
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
  const darkMQ = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function setTiles() {
    if (!busMap) return;
    if (tiles) busMap.removeLayer(tiles);
    if (window.TRA_MAP_TILE_URL) {
      const attribution = window.TRA_MAP_ATTRIBUTION || '';
      tiles = L.tileLayer(window.TRA_MAP_TILE_URL, { maxZoom: 19, attribution }).addTo(busMap);
      return;
    }
    const dark = !!(darkMQ && darkMQ.matches);
    const name = dark ? 'World_Dark_Gray' : 'World_Light_Gray';
    const opt = { maxZoom: 19, maxNativeZoom: 16 };
    tiles = L.layerGroup([
      L.tileLayer(`${ESRI}${name}_Base/MapServer/tile/{z}/{y}/{x}`, {
        ...opt,
        attribution: 'Tiles &copy; Esri, HERE, Garmin, OpenStreetMap contributors'
      }),
      // 路名與地標文字（淡灰色，不搶眼）；不想要文字可刪掉這一個圖層
      L.tileLayer(`${ESRI}${name}_Reference/MapServer/tile/{z}/{y}/{x}`, { ...opt, pane: 'shadowPane' })
    ]).addTo(busMap);
  }
  if (darkMQ && darkMQ.addEventListener) darkMQ.addEventListener('change', () => setTiles());

  function ensureMap() {
    if (busMap) return;
    const box = $('busMap');
    box.replaceChildren(); // 清掉「載入中」之類的文字
    busMap = L.map(box, { zoomControl: true }).setView(cityCenter(), 12);
    setTiles();
    routeLayer = L.layerGroup().addTo(busMap);
    busLayer = L.layerGroup().addTo(busMap);
    meLayer = L.layerGroup().addTo(busMap);
  }

  const divIcon = (html, cls) => L.divIcon({ className: cls, html, iconSize: [0, 0], iconAnchor: [0, 0] });

  // 畫公車：圓形圖示 + 車號；回傳車輛數
  function drawBuses(entry, posData) {
    busLayer.clearLayers();
    const list = parsePositions(posData, entry);
    for (const b of list) {
      const bad = BUS_STATUS[b.status] && b.status !== 100;
      const html = `<div class="bm${bad ? ' warn' : ''}"><div class="bi">${BUS_EMOJI}</div><div class="bp"></div></div>`;
      const m = L.marker([b.lat, b.lon], { icon: divIcon(html, 'bm-icon'), zIndexOffset: 1000, keyboard: false }).addTo(busLayer);
      // 車號用 textContent 寫入，避免特殊字元造成問題
      const el = m.getElement && m.getElement();
      const bp = el && el.querySelector('.bp');
      if (bp) bp.textContent = b.plate || '公車';
    }
    return list.length;
  }

  function renderMap(entry, shapeData, posData) {
    const stops = entry.stops.filter((x) => isNum(x.lat) && isNum(x.lon));
    const all = parseGeometry(shapeData, cur.route);
    const mine = all.filter((l) => l.dir === entry.dir && (!entry.sub || !l.sub || l.sub === entry.sub));
    const sameDir = all.filter((l) => l.dir === entry.dir);
    const lines = mine.length ? mine : sameDir.length ? sameDir : all;

    if (!lines.length && !stops.length) {
      $('busMapStatus').textContent = '無座標資料';
      return;
    }

    ensureMap();
    busMap.invalidateSize();
    setTimeout(() => busMap && busMap.invalidateSize(), 150); // 容器剛顯示時，等排版完成再校正一次

    // 路線與站牌：只在路線或方向改變時重畫並縮放
    const key = `${cur.route}|${entry.dir}|${entry.sub}`;
    if (key !== mapKey) {
      mapKey = key;
      routeLayer.clearLayers();
      const drawn = lines.length ? lines : [stops.map((x) => [x.lat, x.lon])];
      for (const line of drawn) L.polyline(line, { color: '#3d86c6', weight: 7, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(routeLayer);

      for (const st of stops) {
        L.circleMarker([st.lat, st.lon], { radius: 5, color: '#2f80d0', weight: 2, fillColor: '#ffffff', fillOpacity: 1 })
          .addTo(routeLayer)
          .bindPopup(() => {
            const box = document.createElement('div');
            box.className = 'stoppop';
            const b = document.createElement('b');
            b.textContent = `${st.seq}. ${st.name}`;
            const sp = document.createElement('span');
            const info = cur && cur.etaMap ? etaInfo(lookupEta(cur.etaMap, entry, st.uid)) : null;
            sp.textContent = info ? info.text : '—';
            box.append(b, sp);
            return box;
          });
      }
      if (stops.length > 1) {
        const a = stops[0];
        const z = stops[stops.length - 1];
        L.marker([a.lat, a.lon], { icon: divIcon('<div class="endmark start">起</div>', 'bm-icon'), keyboard: false }).addTo(routeLayer);
        L.marker([z.lat, z.lon], { icon: divIcon('<div class="endmark">終</div>', 'bm-icon'), keyboard: false }).addTo(routeLayer);
      }
      const pts = drawn.flat();
      if (pts.length) busMap.fitBounds(pts, { padding: [30, 30] });
    }

    if (posData === undefined) {
      $('busMapStatus').textContent = '載入公車位置…'; // 路線先畫出來，公車稍後補上
      return;
    }
    showBuses(entry, posData);
  }

  // 畫公車並更新狀態文字（posData 為 null 代表取得失敗）
  function showBuses(entry, posData) {
    if (!posData) {
      // 保留畫面上原有的公車圖示，下次自動更新（20 秒）會再試
      $('busMapStatus').textContent = '公車位置暫時無法取得，稍後自動重試';
      return;
    }
    const n = drawBuses(entry, posData);
    $('busMapStatus').textContent = n ? `${n} 輛公車行駛中` : '目前沒有行駛中的公車';
  }

  // 只更新公車位置（不重畫路線），每次自動更新時呼叫
  async function refreshVehicles() {
    if (!cur || !busMap) return;
    const entry = cur.entries[cur.active];
    const route = cur.route;
    const pos = await api(apiQ('pos', route)).catch(() => null);
    if (!cur || cur.route !== route || cur.entries[cur.active] !== entry) return;
    if (!pos) { $('busMapStatus').textContent = '公車位置暫時無法取得，稍後自動重試'; return; }
    showBuses(entry, pos);
  }

  // 定位：在地圖上標出你的位置
  function locateMe() {
    if (!busMap) return;
    if (!navigator.geolocation) { alert('這個瀏覽器不支援定位'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const ll = [pos.coords.latitude, pos.coords.longitude];
        meLayer.clearLayers();
        L.circle(ll, { radius: pos.coords.accuracy, color: '#4c8dff', weight: 1, fillOpacity: 0.12 }).addTo(meLayer);
        L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#4c8dff', fillOpacity: 1 }).addTo(meLayer);
        busMap.setView(ll, Math.max(busMap.getZoom(), 16));
      },
      () => alert('無法取得位置，請確認已允許定位權限'),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  // 載入地圖與時刻表：兩者各自獨立，一邊慢或失敗不會卡住另一邊
  // 路線形狀與班表每條路線只抓一次，之後的自動更新只更新公車位置
  async function loadMapAndSchedule(entry) {
    const route = cur.route;
    const stale = () => !cur || cur.route !== route || cur.entries[cur.active] !== entry;
    $('busMapStatus').textContent = '載入地圖中…';
    $('busScheduleStatus').textContent = '載入中…';

    const mapTask = (async () => {
      try {
        // 公車位置、路線形狀同時開始抓，彼此不等待
        let pos;
        let posDone = false;
        const posP = api(apiQ('pos', route)).catch(() => null);
        const shapeP = cur.shapeData ? Promise.resolve(cur.shapeData) : api(apiQ('shape', route)).catch(() => []);
        const draw = (shape) => {
          renderMap(entry, shape, undefined);          // 畫路線與站牌（沒有形狀時用站牌連線）
          if (posDone) showBuses(entry, pos);          // 公車位置若已先到，補畫上去
        };

        await loadLeaflet();
        if (stale()) return;
        draw(cur.shapeData || []);                     // 先畫出來，不必等路線形狀

        posP.then((v) => {
          pos = v;
          posDone = true;
          if (!stale() && busLayer) showBuses(entry, pos);
        });

        if (!cur.shapeData) {
          const shape = await shapeP;
          if (stale()) return;
          if (pickArray(shape).length) {
            cur.shapeData = shape;                     // 有資料才快取，失敗時下次會重試
            mapKey = '';                               // 換成真實路線並重新縮放
            draw(shape);
          }
        }
        await posP;
      } catch (err) {
        if (stale()) return;
        // 不能動 #busMap 的內容（Leaflet 在裡面），只更新狀態文字
        $('busMapStatus').textContent = '地圖載入失敗：' + err.message;
        console.error('bus map render failed', err);
      }
    })();

    const scheduleTask = (async () => {
      try {
        // 手動班表（高雄公車處官方資料，只有高雄有）
        const tryLocal = async () => {
          const local = await loadLocalSchedule();
          if (stale()) return false;
          const info = findLocalSchedule(local, route);
          if (info && renderLocalSchedule(info, entry)) return true;
          if (!info) console.info('手動班表沒有對應的路線：', route, '（可用的鍵：', Object.keys(local).join('、'), '）');
          return false;
        };
        // TDX Premium v3 歷史推估站站班表（近 3 個月公車動態推算，非官方班表）
        const tryPremium = async () => {
          const premium = await api(apiQ('schedule-premium', route), 60000).catch(() => []);
          if (stale()) return false;
          const premiumParsed = parseSchedule(premium);
          if (!premiumParsed.length && !(premiumParsed.freqs || []).length) return false;
          premiumParsed._source = 'premium';
          renderTimetable(premiumParsed);
          $('busScheduleStatus').textContent += '（TDX 推估）';
          return true;
        };

        // 高雄：基本班表幾乎都是空的（白白浪費 TDX 額度），所以順序為
        // 手動班表（官方）→ Premium 推估 → 基本班表；其他縣市：基本班表 → Premium 推估
        if (CITY === 'Kaohsiung') {
          if (await tryLocal()) return;
          if (stale() || (await tryPremium())) return;
          if (stale()) return;
        }

        // 基本班表失敗（TDX 暫時錯誤、限流等）不算致命：當作沒有資料，再試其他來源
        let basicErr = null;
        const schedule = cur.scheduleData || (await api(apiQ('schedule', route), 60000).catch((e) => { basicErr = e; return []; }));
        if (stale()) return;
        if (basicErr) console.info('基本班表讀取失敗：', basicErr.message);
        if (pickArray(schedule).length) cur.scheduleData = schedule;
        const parsed = parseSchedule(schedule);
        const hasBasic = parsed.length || (parsed.freqs || []).length;

        if (!hasBasic && CITY !== 'Kaohsiung') {
          if (await tryPremium()) return;
          if (stale()) return;
        }
        if (basicErr && !hasBasic) {
          $('busTimetable').innerHTML = `<p class="empty">時刻表載入失敗（${basicErr.message}），請稍後再試。</p>`;
          $('busScheduleStatus').textContent = '讀取失敗';
          return;
        }
        renderTimetable(parsed);
      } catch (err) {
        if (stale()) return;
        $('busTimetable').innerHTML = `<p class="empty">時刻表載入失敗（${err.message}），請稍後再試。</p>`;
        $('busScheduleStatus').textContent = '讀取失敗';
        console.error('bus timetable render failed', err);
      }
    })();

    await Promise.all([mapTask, scheduleTask]);
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
    syncClearBtn();
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
    loadMapAndSchedule(cur.entries[cur.active]);
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
    refreshVehicles(); // 公車位置獨立更新
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
    renderCities();
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

  // ---------- 縣市切換（個人版多縣市才會有） ----------
  function renderCities() {
    const box = $('busCities');
    if (!box || !CITIES) return;
    box.hidden = false;
    box.replaceChildren(...CITIES.map((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (c.id === CITY ? ' on' : '');
      b.textContent = c.name;
      b.addEventListener('click', () => switchCity(c.id));
      return b;
    }));
  }

  async function switchCity(id) {
    if (id === CITY) return;
    CITY = id;
    try { localStorage.setItem(PFX + 'tra.bus.city', JSON.stringify(id)); } catch { /* 忽略 */ }
    openSeq++; cur = null; routes = []; favEtaMaps = new Map(); mapKey = '';
    if (busMap) busMap.setView(cityCenter(), 12);
    $('busInput').value = '';
    $('busSuggest').replaceChildren();
    $('busRoute').hidden = true;
    if (!ttSheet.hidden) closeTimetable();
    syncClearBtn();
    renderCities();
    renderQuick();
    renderFavStops();
    refreshFavEta();
    setMsg('載入路線清單…', true);
    try {
      routes = await loadRoutes();
      if (id !== CITY) return;
      setMsg('');
      renderSuggest();
    } catch (err) {
      if (id === CITY) setMsg('無法載入路線清單：' + err.message);
    }
  }

  function setTab(tab) {
    $('railView').hidden = tab !== 'rail';
    $('busView').hidden = tab !== 'bus';
    const mv = $('metroView');
    if (mv) mv.hidden = tab !== 'metro';
    const bv = $('bikeView');
    if (bv) bv.hidden = tab !== 'bike';
    document.querySelectorAll('.tabs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === tab);
    });
    store.set(KEY.tab, tab);
    document.dispatchEvent(new CustomEvent('tabchange', { detail: { tab } }));
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
  $('busClearInput').addEventListener('click', clearBusSearch);
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

  $('busLocate').addEventListener('click', locateMe);

  // 站站時刻表：點按鈕開啟 / 關閉面板
  const ttSheet = $('busTimetableSheet');
  const openTimetable = () => { ttSheet.hidden = false; document.body.style.overflow = 'hidden'; };
  const closeTimetable = () => { ttSheet.hidden = true; document.body.style.overflow = ''; };
  $('busTimetableBtn').addEventListener('click', openTimetable);
  $('busTimetableClose').addEventListener('click', closeTimetable);
  ttSheet.addEventListener('click', (e) => { if (e.target === ttSheet) closeTimetable(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !ttSheet.hidden) closeTimetable(); });

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
  const savedTab = store.get(KEY.tab, 'rail');
  setTab(['bus', 'metro', 'bike'].includes(savedTab) && $(savedTab + 'View') ? savedTab : 'rail');
})();
