// 汐灯证券 · 前端逻辑
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const TF_SECONDS = { '1m': 12, '5m': 60, '15m': 180, '1h': 720, '4h': 2880 };

const state = {
  token: localStorage.getItem('xd_token') || '',
  market: null,
  me: null,
  code: 'TGW',
  tf: '1m',
  side: 'long',
  chart: null,
  candleSeries: null,
  maSeries: {},
  maVisible: { 5: true, 10: true, 30: false },
  candles: [],
  adminToken: localStorage.getItem('xd_admin') || '',
  adminSelected: new Set(),
  prevPrices: {},
  myTrades: [],
  stream: null
};

// ---------------- 工具 ----------------
function money(v) {
  if (!Number.isFinite(v)) return '$0';
  const neg = v < 0;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (neg ? '-$' : '$') + s;
}
function moneyShort(v) {
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
  if (a >= 1e4) return (v / 1e4).toFixed(2) + ' 万';
  return v.toFixed(0);
}
function pct(v) {
  if (!Number.isFinite(v)) return '0.00%';
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
}
function cls(v) {
  if (v > 0.0001) return 'up';
  if (v < -0.0001) return 'down';
  return 'flat';
}
// 按当前 K 线周期取涨跌幅（后端已经算好 5 个周期）
function stockChange(st) {
  if (!st) return 0;
  if (st.changes && st.changes[state.tf] !== undefined) return st.changes[state.tf];
  return st.changePct || 0;
}

function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = 'toast ' + type), 2600);
}
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

// ---------------- 登录 ----------------
function showLogin() {
  $('#loginView').classList.remove('hidden');
  $('#mainView').classList.add('hidden');
}
function showMain() {
  $('#loginView').classList.add('hidden');
  $('#mainView').classList.remove('hidden');
}

async function doLogin() {
  const nickname = $('#loginNick').value.trim();
  const pin = $('#loginPin').value.trim();
  const msg = $('#loginMsg');
  msg.textContent = '';
  if (!nickname) { msg.textContent = '先填个昵称'; return; }
  if (!/^\d{6}$/.test(pin)) { msg.textContent = 'PIN 必须是 6 位数字'; return; }
  $('#loginBtn').disabled = true;
  try {
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ nickname, pin }) });
    if (r.needPinUpgrade) {
      state.upgradeToken = r.token;
      $('.login-form').classList.add('hidden');
      $('#pinUpgrade').classList.remove('hidden');
      $('#newPin').focus();
      return;
    }
    state.token = r.token;
    localStorage.setItem('xd_token', r.token);
    state.me = r.player;
    await enterGame();
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    $('#loginBtn').disabled = false;
  }
}

async function upgradePin() {
  const p1 = $('#newPin').value.trim();
  const p2 = $('#newPin2').value.trim();
  const msg = $('#pinUpgradeMsg');
  msg.textContent = '';
  if (!/^\d{6}$/.test(p1)) { msg.textContent = 'PIN 必须是 6 位数字'; return; }
  if (p1 !== p2) { msg.textContent = '两次输入不一致'; return; }
  $('#pinUpgradeBtn').disabled = true;
  try {
    const res = await fetch('/api/pin/upgrade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.upgradeToken },
      body: JSON.stringify({ pin: p1 })
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || '修改失败');
    state.token = r.token;
    localStorage.setItem('xd_token', r.token);
    state.upgradeToken = '';
    state.me = r.player;
    const mt = await api('/api/market');
    state.market = mt;
    await enterGame();
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    $('#pinUpgradeBtn').disabled = false;
  }
}

async function enterGame() {
  showMain();
  await refreshMarket();
  buildChart();
  selectStock(state.code);
  connectStream();
  switchView('market');
}

// ---------------- 行情 ----------------
async function refreshMarket() {
  const d = await api('/api/market');
  state.market = d;
  state.me = d.me;
  renderTopbar();
  renderClosed();
  renderNews();
  renderStockList();
  renderPositions();
  syncLeverageLimits();
  if (d.config) $('#startingCashHint').textContent = money(d.config.startingCash || 100000);
}

function renderClosed() {
  const closed = state.market && state.market.marketOpen === false;
  const banner = $('#closedBanner');
  if (banner) banner.classList.toggle('hidden', !closed);
  // 按钮文案统一交给 updateCostPreview 处理，避免每 tick 被刷回去
  updateCostPreview();
}

function renderTopbar() {
  const m = state.market;
  if (!m) return;
  $('#indexValue').textContent = m.index.value.toFixed(2);
  const idxSeries = m.index.series;
  const prevIdx = idxSeries.length > 1 ? idxSeries[idxSeries.length - 2] : m.index.value;
  const idxChg = (m.index.changes && m.index.changes[state.tf] !== undefined)
    ? m.index.changes[state.tf]
    : (prevIdx ? ((m.index.value - prevIdx) / prevIdx) * 100 : 0);
  const ie = $('#indexChange');
  ie.textContent = pct(idxChg);
  ie.className = 'index-change ' + cls(idxChg);

  const me = m.me;
  if (me) {
    $('#equityValue').textContent = money(me.equity);
    $('#equityValue').className = 'cash-value';
    $('#nickDisplay').textContent = me.nickname;
    const img = $('#avatarImg');
    if (me.avatar) {
      img.src = me.avatar;
      img.classList.add('on');
    } else {
      img.classList.remove('on');
    }
  }
  $('#tickInfo').textContent = '第 ' + m.tick + ' 轮 · ' + (m.tickMs / 1000) + 's';
}

function renderStockList() {
  const m = state.market;
  if (!m) return;
  const wrap = $('#stockList');
  const list = Object.values(m.stocks);
  wrap.innerHTML = '';
  for (const st of list) {
    const chg = stockChange(st);
    const div = document.createElement('div');
    div.className = 'stock-item' + (st.code === state.code ? ' active' : '') + (st.status !== 'normal' ? ' suspended' : '');
    div.dataset.code = st.code;
    const statusTag = st.status === 'suspended' ? ' · 停牌' : st.status === 'delisted' ? ' · 退市' : '';
    div.innerHTML = `
      <img class="stock-icon" src="${st.icon || ''}" alt="${st.name}" loading="lazy" />
      <div class="stock-main">
        <div class="stock-name">${st.name}<span class="stock-code">${st.code}${statusTag}</span></div>
      </div>
      <div class="stock-right">
        <div class="stock-price ${cls(chg)}" data-price="${st.code}">${st.price.toFixed(2)}</div>
        <div class="stock-chg ${cls(chg)}" data-chg="${st.code}">${pct(chg)}</div>
      </div>`;
    div.addEventListener('click', () => selectStock(st.code));
    wrap.appendChild(div);
  }
}

function selectStock(code) {
  state.code = code;
  $$('.stock-item').forEach((el) => el.classList.toggle('active', el.dataset.code === code));
  const st = state.market.stocks[code];
  if (!st) return;
  const chg0 = stockChange(st);
  $('#chartName').textContent = st.name;
  $('#chartCode').textContent = st.code;
  $('#chartIcon').src = st.icon || '';
  $('#chartPrice').textContent = st.price.toFixed(2);
  $('#chartPrice').className = 'big-price ' + cls(chg0);
  const ce = $('#chartChange');
  ce.textContent = pct(chg0);
  ce.className = 'big-change ' + cls(chg0);
  updateCostPreview();
  loadMyTrades();
  loadCandles();
}

// ---------------- 市场快讯 ----------------
// 注意：假消息和晚消息都用和普通消息一样的徽章，
// 否则玩家一眼就能看出哪条会被辟谣，假消息机制就白做了。
// 线索只藏在文案里（「网传」「传」「自称」）。
const NEWS_BADGE = {
  global: { up: ['利好', 'badge-up'], down: ['利空', 'badge-down'] },
  local: { up: ['突发·利好', 'badge-hot'], down: ['突发·利空', 'badge-hot-bad'] },
  debunk: { up: ['辟谣', 'badge-debunk'], down: ['辟谣', 'badge-debunk'] }
};

function newsBadge(ev) {
  // 只按消息本身的方向标利好/利空。
  // 绝不暴露「之后会反转」——那是未来信息，会让人提前埋伏。
  const up = Number(ev.dir ?? 1) > 0;
  const [label, klass] = up ? NEWS_BADGE.global.up : NEWS_BADGE.global.down;
  return `<span class="news-badge ${klass}">${label}</span>`;
}

function renderNews() {
  const feed = $('#newsFeed');
  if (!feed) return;
  const notices = (state.market?.notices || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  const list = (state.market?.events || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const cnt = $('#newsCount');
  const total = notices.length + list.length;
  if (cnt) cnt.textContent = total ? `${total} 条` : '';

  if (!total) {
    feed.innerHTML = '<div class="news-empty">暂无消息，市场风平浪静</div>';
    return;
  }

  // 公告永远排在最前面，且不参与行情
  const noticeHtml = notices.slice(0, 3).map((n) => `
    <div class="news-item news-notice">
      <span class="news-badge badge-notice">公告</span>
      <span class="news-text">${escapeHtml(n.text)}</span>
    </div>`).join('');

  const newsHtml = list.slice(0, Math.max(1, 4 - Math.min(3, notices.length))).map((ev) => `
    <div class="news-item">
      ${newsBadge(ev)}
      <span class="news-text">${ev.text}</span>
    </div>`).join('');

  feed.innerHTML = noticeHtml + newsHtml;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---------------- 图表 ----------------
function buildChart() {
  const el = $('#chart');
  const chart = LightweightCharts.createChart(el, {
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: '#5b7671',
      fontFamily: 'inherit'
    },
    grid: {
      vertLines: { color: 'rgba(230,240,237,.7)' },
      horzLines: { color: 'rgba(230,240,237,.7)' }
    },
    rightPriceScale: { borderColor: 'rgba(230,240,237,.9)' },
    timeScale: { borderColor: 'rgba(230,240,237,.9)', timeVisible: true, secondsVisible: false },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: 'rgba(20,184,166,.4)', labelBackgroundColor: '#14b8a6' },
      horzLine: { color: 'rgba(20,184,166,.4)', labelBackgroundColor: '#14b8a6' }
    },
    handleScale: { axisPressedMouseMove: true }
  });
  const candle = chart.addCandlestickSeries({
    upColor: '#f04b4b',
    downColor: '#12b886',
    borderVisible: false,
    wickUpColor: '#f04b4b',
    wickDownColor: '#12b886'
  });
  state.chart = chart;
  state.candleSeries = candle;

  for (const period of [5, 10, 30]) {
    state.maSeries[period] = chart.addLineSeries({
      color: period === 5 ? '#f59e0b' : period === 10 ? '#3b82f6' : '#a855f7',
      lineWidth: 1.5,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      visible: state.maVisible[period]
    });
  }

  const ro = new ResizeObserver(() => {
    chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
  });
  ro.observe(el);
  chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
}

async function loadMyTrades() {
  try {
    const d = await api(`/api/trades?code=${encodeURIComponent(state.code)}&limit=300`);
    state.myTrades = d.rows || [];
  } catch {
    state.myTrades = [];
  }
  updateMarkers();
}

async function loadCandles() {
  const code = state.code;
  const tf = state.tf;
  try {
    const d = await api(`/api/candles?code=${encodeURIComponent(code)}&tf=${tf}`);
    state.candles = d.candles || [];
    state.candleSeries.setData(state.candles);
    renderMAs();
    state.plSig = null;
    updatePriceLines();
    updateMarkers();
    // 只显示最近一段，K 线不至于挤成一条线
    const n = state.candles.length;
    if (n > 12) {
      state.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 70), to: n + 3 });
    } else {
      state.chart.timeScale().fitContent();
    }
    $('#chartEmpty').classList.toggle('hidden', state.candles.length > 0);
  } catch (e) {
    toast('K 线加载失败：' + e.message, 'err');
  }
}

function renderMAs() {
  for (const period of [5, 10, 30]) {
    const series = state.maSeries[period];
    if (!series) continue;
    // 关键：visible:false 创建出来的线，setData 不会自动显示，必须显式切可见性
    series.applyOptions({ visible: !!state.maVisible[period] });
    if (!state.maVisible[period]) {
      series.setData([]);
      continue;
    }
    const src = state.candles;
    const out = [];
    let sum = 0;
    for (let i = 0; i < src.length; i++) {
      sum += src[i].close;
      if (i >= period) sum -= src[i - period].close;
      if (i >= period - 1) {
        out.push({ time: src[i].time, value: Number((sum / period).toFixed(4)) });
      }
    }
    series.setData(out);
  }
}

// ---------------- K线上的买卖点 ----------------
// 做多开仓 / 平空 = 买入(B)，做空开仓 / 平多 = 卖出(S)
function tradeIsBuy(t) {
  if (t.action === 'open') return t.side === 'long';
  return t.side === 'short';
}

function buildMarkers(trades) {
  const candles = state.candles;
  if (!candles.length || !trades.length) return [];

  // 每根 K 线上，B 和 S 各只放一个，多的标 ×N
  const buckets = new Map();
  for (const t of trades) {
    const sec = Math.floor(Number(t.at) / 1000);
    // 找到 time <= sec 的最后一根 K 线
    let idx = -1;
    for (let i = candles.length - 1; i >= 0; i--) {
      if (candles[i].time <= sec) { idx = i; break; }
    }
    if (idx < 0) continue;
    const key = candles[idx].time;
    const buy = tradeIsBuy(t);
    if (!buckets.has(key)) buckets.set(key, { buy: 0, sell: 0 });
    const b = buckets.get(key);
    if (buy) b.buy += 1;
    else b.sell += 1;
  }

  const markers = [];
  for (const [time, b] of [...buckets.entries()].sort((x, y) => x[0] - y[0])) {
    if (b.buy > 0) {
      markers.push({
        time,
        position: 'belowBar',
        color: '#f04b4b',
        shape: 'circle',
        size: 1,
        text: b.buy > 1 ? `B×${b.buy}` : 'B'
      });
    }
    if (b.sell > 0) {
      markers.push({
        time,
        position: 'aboveBar',
        color: '#12b886',
        shape: 'circle',
        size: 1,
        text: b.sell > 1 ? `S×${b.sell}` : 'S'
      });
    }
  }
  return markers;
}

function updateMarkers() {
  if (!state.candleSeries || typeof state.candleSeries.setMarkers !== 'function') return;
  const markers = buildMarkers(state.myTrades || []);
  state.candleSeries.setMarkers(markers);
  const hint = $('#bsHint');
  if (hint) {
    hint.classList.toggle('hidden', markers.length === 0);
  }
}

function applyTickToChart(price) {
  if (!state.candleSeries) return;
  const group = TF_SECONDS[state.tf] || 12;
  const tickMs = state.market?.tickMs || 5000;
  const tick = state.market?.tick || 0;
  const bucket = Math.floor(tick / group);
  const base = state.market?.startedAt || 0;
  const time = Math.floor((base + bucket * group * tickMs) / 1000);
  const last = state.candles[state.candles.length - 1];
  if (!last || last.time < time) {
    const c = { time, open: price, high: price, low: price, close: price };
    state.candles.push(c);
    if (state.candles.length > 400) state.candles.shift();
    state.candleSeries.update(c);
    renderMAs();
  } else {
    last.close = price;
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    state.candleSeries.update(last);
    // MA 只更新最后一个点
    for (const period of [5, 10, 30]) {
      if (!state.maVisible[period]) continue;
      const n = state.candles.length;
      if (n < period) continue;
      let sum = 0;
      for (let i = n - period; i < n; i++) sum += state.candles[i].close;
      state.maSeries[period].update({ time: last.time, value: Number((sum / period).toFixed(4)) });
    }
  }
}

// ---------------- K 线上的止盈止损 ----------------
function renderChartLegend(pos) {
  const el = $('#chartLegend');
  if (!el) return;
  if (!pos) {
    el.innerHTML = '<span class="bs-note">B 买入 · S 卖出</span>';
    return;
  }
  el.innerHTML = `
    <span class="bs-note">B 买入 · S 卖出</span>
    <span><i style="background:#64748b"></i>成本 ${pos.entry.toFixed(2)}</span>
    ${pos.tp ? `<span><i style="background:#22c55e"></i>止盈 ${Number(pos.tp).toFixed(2)}</span>` : ''}
    ${pos.sl ? `<span><i style="background:#ef4444"></i>止损 ${Number(pos.sl).toFixed(2)}</span>` : ''}
    ${(pos.leverage || 1) > 1 ? `<span><i style="background:#f97316"></i>爆仓 ${(pos.side === 'long' ? pos.entry * (1 - 1 / (pos.leverage || 1)) : pos.entry * (1 + 1 / (pos.leverage || 1))).toFixed(2)}</span>` : ''}
    <span class="legend-hint">${pos.side === 'long' ? '做多' : '做空'} ${pos.qty} 股 · ${(pos.leverage || 1).toFixed(1)}x</span>`;
}

function updatePriceLines() {
  if (!state.candleSeries) return;
  if (!Array.isArray(state.priceLines)) state.priceLines = [];
  const pos = state.market?.me?.positions?.[state.code];
  const sig = pos ? `${pos.entry}|${pos.tp}|${pos.sl}|${pos.side}|${pos.qty}` : 'none';
  if (sig === state.plSig) return;
  state.plSig = sig;

  for (const pl of state.priceLines) {
    try { state.candleSeries.removePriceLine(pl); } catch { /* ignore */ }
  }
  state.priceLines = [];

  renderChartLegend(pos || null);
  if (!pos) return;

  const add = (price, color, title) => {
    if (!price || !Number.isFinite(Number(price))) return;
    state.priceLines.push(state.candleSeries.createPriceLine({
      price: Number(price),
      color,
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title
    }));
  };
  add(pos.entry, '#64748b', '成本');
  add(pos.tp, '#22c55e', '止盈');
  add(pos.sl, '#ef4444', '止损');
  // 爆仓价：保证金亏光的位置
  const lev = pos.leverage || 1;
  if (lev > 1) {
    const liq = pos.side === 'long'
      ? pos.entry * (1 - 1 / lev)
      : pos.entry * (1 + 1 / lev);
    add(liq, '#f97316', '爆仓');
  }
}

// ---------------- SSE ----------------
function connectStream() {
  if (state.stream) state.stream.close();
  const es = new EventSource('/api/stream?token=' + encodeURIComponent(state.token));
  state.stream = es;
  es.onmessage = (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    if (d.type !== 'tick') return;
    onTick(d);
  };
  es.onerror = () => {
    // 浏览器会自动重连
  };
}

function onTick(d) {
  const m = state.market;
  if (!m) return;
  m.tick = d.tick;
  m.index.value = d.index;
  m.index.series.push(d.index);
  if (m.index.series.length > 600) m.index.series.shift();
  m.events = d.events || [];

  if (d.closed !== undefined) m.marketOpen = !d.closed;
  // 后台改了参数（杠杆上限等），下一轮就同步过来
  if (d.config) m.config = { ...(m.config || {}), ...d.config };
  renderClosed();

  for (const [code, s] of Object.entries(d.stocks)) {
    if (!m.stocks[code]) continue;
    m.stocks[code].price = s.price;
    m.stocks[code].changePct = s.changePct;
    m.stocks[code].status = s.status;
  }
  if (d.me) {
    m.me = { ...m.me, ...d.me };
    state.me = m.me;
  }

  renderTopbar();
  renderNews();
  updatePriceCells();
  syncLeverageLimits();
  const st = m.stocks[state.code];
  if (st) {
    const chgNow = stockChange(st);
    $('#chartPrice').textContent = st.price.toFixed(2);
    $('#chartPrice').className = 'big-price ' + cls(chgNow);
    const ce = $('#chartChange');
    ce.textContent = pct(chgNow);
    ce.className = 'big-change ' + cls(chgNow);
    if (d.closed !== true) applyTickToChart(st.price);
  }
  updateCostPreview();
  updatePriceLines();
  renderPositions();
  if ($('#view-portfolio').classList.contains('active')) renderPortfolio();
  if ($('#view-rank').classList.contains('active')) loadRank();
  if ($('#view-work').classList.contains('active')) renderWork();
  if (d.closes && d.closes.length) handleCloses(d.closes);
}

function updatePriceCells() {
  const m = state.market;
  for (const [code, s] of Object.entries(m.stocks)) {
    const priceEl = document.querySelector(`[data-price="${code}"]`);
    const chgEl = document.querySelector(`[data-chg="${code}"]`);
    if (!priceEl) continue;
    const prev = state.prevPrices[code];
    const chg = stockChange(s);
    priceEl.textContent = s.price.toFixed(2);
    priceEl.className = 'stock-price ' + cls(chg);
    if (chgEl) {
      chgEl.textContent = pct(chg);
      chgEl.className = 'stock-chg ' + cls(chg);
    }
    if (prev !== undefined && Math.abs(prev - s.price) > 1e-9) {
      const item = priceEl.closest('.stock-item');
      if (item) {
        item.classList.remove('flash-up', 'flash-down');
        void item.offsetWidth;
        item.classList.add(s.price > prev ? 'flash-up' : 'flash-down');
      }
    }
  }
  for (const [code, s] of Object.entries(m.stocks)) state.prevPrices[code] = s.price;
}

function handleCloses(list) {
  for (const c of list) {
    const name = state.market.stocks[c.code]?.name || c.code;
    const reasonMap = {
      tp: '止盈触发',
      sl: '止损触发',
      liquidated: '爆仓强平',
      delisted: '退市强平'
    };
    const r = reasonMap[c.reason] || '自动平仓';
    const pnl = c.pnl || 0;
    toast(`${name} ${r}，${pnl >= 0 ? '盈利' : '亏损'} ${money(Math.abs(pnl))}`, pnl >= 0 ? 'ok' : 'err');
  }
  if (state.market?.me) renderPositions();
}

// ---------------- 下单 ----------------
// 让杠杆滑条的范围跟随后台设置，后台改了立刻生效
function syncLeverageLimits() {
  const cfg = state.market?.config || {};
  const el = $('#orderLev');
  if (!el) return;
  let min = Number(cfg.minLeverage ?? 1);
  let max = Number(cfg.maxLeverage ?? 20);
  if (!(min >= 1)) min = 1;
  if (!(max >= min)) max = min;
  if (el.min !== String(min)) el.min = String(min);
  if (el.max !== String(max)) el.max = String(max);
  el.step = '1';
  let v = Number(el.value) || min;
  if (v < min) v = min;
  if (v > max) v = max;
  if (String(v) !== el.value) el.value = String(v);
  updateCostPreview();
}

function updateCostPreview() {
  const st = state.market?.stocks?.[state.code];
  if (!st) return;
  const qty = Number($('#orderQty').value) || 0;
  const lev = Number($('#orderLev').value) || 1;
  const cfg = state.market.config || {};
  const notional = qty * st.price;
  const margin = notional / lev;
  const fee = notional * (cfg.feeRate || 0);
  const stamp = state.side === 'short' ? notional * (cfg.stampDuty || 0) : 0;
  $('#costNotional').textContent = money(notional);
  $('#costMargin').textContent = money(margin + fee + stamp);
  $('#costFee').textContent = money(fee + stamp);
  const levMin = Number(cfg.minLeverage ?? 1);
  const levMax = Number(cfg.maxLeverage ?? 20);
  $('#levLabel').textContent = `${lev}x（${levMin}~${levMax} 倍）`;
  // 爆仓价：保证金亏光的位置 = 现价 ×(1 ∓ 1/杠杆)
  const liqPx = state.side === 'long' ? st.price * (1 - 1 / lev) : st.price * (1 + 1 / lev);
  if (liqPx <= 0.01) {
    $('#costLiq').textContent = '不会爆仓';
    $('#costLiq').className = 'flat';
  } else {
    $('#costLiq').textContent = liqPx.toFixed(2) + `（跌/涨 ${(100 / lev).toFixed(1)}% 就爆）`;
    $('#costLiq').className = 'down';
  }
  const btn = $('#orderBtn');
  const closed = state.market?.marketOpen === false;
  btn.disabled = closed;
  btn.textContent = closed
    ? '休市中，暂停交易'
    : (state.side === 'long' ? '买入开多' : '卖出开空');
  $('.trade-panel')?.classList.toggle('is-closed', closed);
}

async function placeOrder() {
  const st = state.market?.stocks?.[state.code];
  if (!st) return;
  if (st.status !== 'normal') { toast('该标的当前不可交易', 'err'); return; }
  const qty = Math.floor(Number($('#orderQty').value) || 0);
  const lev = Number($('#orderLev').value) || 1;
  const tp = $('#orderTp').value ? Number($('#orderTp').value) : null;
  const sl = $('#orderSl').value ? Number($('#orderSl').value) : null;
  if (qty <= 0) { toast('数量必须是正整数', 'err'); return; }
  const msg = $('#orderMsg');
  msg.textContent = '';
  $('#orderBtn').disabled = true;
  try {
    const r = await api('/api/order', {
      method: 'POST',
      body: JSON.stringify({ code: state.code, side: state.side, qty, leverage: lev, tp, sl })
    });
    state.market.me = r.player;
    renderPositions();
    renderTopbar();
    updatePriceLines();
    if ($('#view-portfolio').classList.contains('active')) loadTrades();
    loadMyTrades();
    toast(`${state.side === 'long' ? '开多' : '开空'} ${qty} 股 ${st.name}`, 'ok');
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    $('#orderBtn').disabled = false;
  }
}

async function closePos(code) {
  try {
    const r = await api('/api/close', { method: 'POST', body: JSON.stringify({ code }) });
    state.market.me = r.player;
    renderPositions();
    renderTopbar();
    updatePriceLines();
    if ($('#view-portfolio').classList.contains('active')) loadTrades();
    loadMyTrades();
    const pnl = r.result.pnl;
    toast(`平仓 ${r.result.code}，${pnl >= 0 ? '盈利' : '亏损'} ${money(Math.abs(pnl))}`, pnl >= 0 ? 'ok' : 'err');
  } catch (e) {
    toast(e.message, 'err');
  }
}

function positionSignature(pos) {
  return pos
    .map((p) => `${p.code}:${p.qty}:${p.side}:${(p.leverage || 1).toFixed(1)}`)
    .sort()
    .join('|');
}

function updatePositionCells(pos) {
  const wrap = $('#positionsTable');
  if (!wrap) return;
  const byCode = new Map(pos.map((p) => [p.code, p]));
  wrap.querySelectorAll('tr[data-pos]').forEach((tr) => {
    const p = byCode.get(tr.dataset.pos);
    if (!p) return;
    const set = (cell, html) => {
      const el = tr.querySelector(`[data-cell="${cell}"]`);
      if (el) el.innerHTML = html;
    };
    set('price', p.price.toFixed(2));
    const pctVal = p.pnlPct !== undefined ? p.pnlPct : (p.margin > 0 ? (p.pnl / p.margin) * 100 : 0);
    set('pnl', `<span class="${cls(p.pnl)}">${money(p.pnl)} <small>(${pct(pctVal)})</small></span>`);
    set('qty', String(p.qty));
    set('margin', money(p.margin));
  });
}

function renderPositions(force = false) {
  const wrap = $('#positionsTable');
  const me = state.market?.me;
  if (!wrap) return;
  const pos = me ? Object.values(me.positions || {}) : [];

  if (!pos.length) {
    wrap.innerHTML = '<table><tbody><tr class="empty-row"><td>还没有持仓，挑一只票试试手气</td></tr></tbody></table>';
    state.posSig = '';
    return;
  }

  const sig = positionSignature(pos);
  if (!force && sig === state.posSig && wrap.querySelector('tr[data-pos]')) {
    updatePositionCells(pos);
    return;
  }
  state.posSig = sig;

  wrap.innerHTML = `
    <table>
      <thead><tr>
        <th>标的</th><th>方向</th><th>数量</th><th>杠杆</th><th>成本</th>
        <th>现价</th><th>浮动盈亏</th><th>保证金</th><th>爆仓价</th><th>止盈/止损</th><th>操作</th>
      </tr></thead>
      <tbody>
        ${pos.map((p) => {
          const name = state.market.stocks[p.code]?.name || p.code;
          const lev = p.leverage || 1;
          const liq = p.side === 'long' ? p.entry * (1 - 1 / lev) : p.entry * (1 + 1 / lev);
          const icon = state.market.stocks[p.code]?.icon || '';
          return `<tr data-pos="${p.code}">
            <td><img class="stock-icon-sm" src="${icon}" alt="" />${name} <span class="stock-code">${p.code}</span></td>
            <td><span class="pill ${p.side}">${p.side === 'long' ? '多' : '空'}</span></td>
            <td data-cell="qty">${p.qty}</td>
            <td>${lev.toFixed(1)}x</td>
            <td>${p.entry.toFixed(2)}</td>
            <td data-cell="price">${p.price.toFixed(2)}</td>
            <td data-cell="pnl"><span class="${cls(p.pnl)}">${money(p.pnl)} <small>(${pct(p.margin > 0 ? (p.pnl / p.margin) * 100 : 0)})</small></span></td>
            <td data-cell="margin">${money(p.margin)}</td>
            <td class="down">${liq > 0 ? liq.toFixed(2) : '—'}</td>
            <td>
              <input class="tpsl-input" data-code="${p.code}" data-field="tp" type="number" step="0.01" value="${p.tp ?? ''}" placeholder="止盈" />
              <input class="tpsl-input" data-code="${p.code}" data-field="sl" type="number" step="0.01" value="${p.sl ?? ''}" placeholder="止损" />
            </td>
            <td><button class="mini-btn danger" data-close="${p.code}">平仓</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  wrap.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => closePos(b.dataset.close));
  });
  wrap.querySelectorAll('.tpsl-input').forEach((inp) => {
    inp.addEventListener('change', async () => {
      const code = inp.dataset.code;
      const tpEl = wrap.querySelector(`.tpsl-input[data-code="${code}"][data-field="tp"]`);
      const slEl = wrap.querySelector(`.tpsl-input[data-code="${code}"][data-field="sl"]`);
      try {
        await api('/api/tpsl', {
          method: 'POST',
          body: JSON.stringify({
            code,
            tp: tpEl.value ? Number(tpEl.value) : null,
            sl: slEl.value ? Number(slEl.value) : null
          })
        });
        updatePriceLines();
        toast('止盈止损已更新', 'ok');
      } catch (e) {
        toast(e.message, 'err');
      }
    });
  });
}

// ---------------- 我的 ----------------
function renderPortfolio() {
  const me = state.market?.me;
  if (!me) return;
  const pos = Object.values(me.positions || {});
  const marginTotal = pos.reduce((s, p) => s + p.margin, 0);
  const pnlTotal = pos.reduce((s, p) => s + p.pnl, 0);
  $('#statGrid').innerHTML = `
    <div class="stat-card"><div class="stat-label">总资产</div><div class="stat-value">${money(me.equity)}</div><div class="stat-sub">现金 + 保证金 + 浮盈亏</div></div>
    <div class="stat-card"><div class="stat-label">可用现金</div><div class="stat-value">${money(me.cash)}</div><div class="stat-sub">可用于开新仓</div></div>
    <div class="stat-card"><div class="stat-label">占用保证金</div><div class="stat-value">${money(marginTotal)}</div><div class="stat-sub">${pos.length} 个持仓</div></div>
    <div class="stat-card"><div class="stat-label">浮动盈亏</div><div class="stat-value ${cls(pnlTotal)}">${money(pnlTotal)}</div><div class="stat-sub">实时结算</div></div>`;

  const wrap = $('#portfolioTable');
  if (!pos.length) {
    wrap.innerHTML = '<table><tbody><tr class="empty-row"><td>暂无持仓</td></tr></tbody></table>';
    return;
  }
  wrap.innerHTML = `
    <table>
      <thead><tr><th>标的</th><th>方向</th><th>数量</th><th>杠杆</th><th>开仓价</th><th>现价</th><th>浮盈亏</th><th>保证金</th><th>操作</th></tr></thead>
      <tbody>
        ${pos.map((p) => {
          const name = state.market.stocks[p.code]?.name || p.code;
          return `<tr>
            <td>${name} <span class="stock-code">${p.code}</span></td>
            <td><span class="pill ${p.side}">${p.side === 'long' ? '多' : '空'}</span></td>
            <td>${p.qty}</td>
            <td>${(p.leverage || 1).toFixed(1)}x</td>
            <td>${p.entry.toFixed(2)}</td>
            <td>${p.price.toFixed(2)}</td>
            <td class="${cls(p.pnl)}">${money(p.pnl)}</td>
            <td>${money(p.margin)}</td>
            <td><button class="mini-btn danger" data-close="${p.code}">平仓</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  wrap.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => closePos(b.dataset.close));
  });
}

// ---------------- 交易记录 ----------------
const REASON_LABEL = {
  manual: ['手动', 'pill gray'],
  tp: ['止盈', 'pill long'],
  sl: ['止损', 'pill short'],
  liquidated: ['爆仓', 'pill short'],
  delisted: ['退市', 'pill short']
};

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function loadTrades() {
  const wrap = $('#tradeTable');
  if (!wrap) return;
  try {
    const d = await api('/api/trades?limit=100');
    if (!d.rows.length) {
      wrap.innerHTML = '<table><tbody><tr class="empty-row"><td>还没有成交记录</td></tr></tbody></table>';
      return;
    }
    wrap.innerHTML = `
      <table>
        <thead><tr>
          <th>时间</th><th>标的</th><th>动作</th><th>方向</th><th>数量</th>
          <th>成交价</th><th>杠杆</th><th>金额</th><th>手续费</th><th>盈亏</th><th>备注</th>
        </tr></thead>
        <tbody>
          ${d.rows.map((t) => {
            const [label, klass] = REASON_LABEL[t.reason] || ['手动', 'pill gray'];
            const isOpen = t.action === 'open';
            const pnlCell = t.action === 'close'
              ? `<span class="${cls(t.pnl)}">${money(t.pnl)}</span>`
              : '<span class="stock-code">—</span>';
            // 手续费 = 交易手续费 + 印花税（做空开仓、平多卖出时才有印花税）
            const feeTotal = (Number(t.fee) || 0) + (Number(t.stamp) || 0);
            const feeCell = feeTotal > 0
              ? `<span class="fee-cell" title="手续费 ${money(t.fee)} + 印花税 ${money(t.stamp)}">${money(feeTotal)}</span>`
              : '<span class="stock-code">—</span>';
            const amountCell = t.action === 'close'
              ? money(t.returned ?? 0)
              : money(t.margin ?? 0);
            return `<tr>
              <td class="stock-code">${fmtTime(t.at)}</td>
              <td>${t.name || t.code} <span class="stock-code">${t.code}</span></td>
              <td>${isOpen ? '开仓' : '平仓'}</td>
              <td><span class="pill ${t.side}">${t.side === 'long' ? '多' : '空'}</span></td>
              <td>${t.qty}</td>
              <td>${Number(t.price).toFixed(2)}</td>
              <td>${(t.leverage || 1).toFixed(1)}x</td>
              <td>${amountCell}</td>
              <td>${feeCell}</td>
              <td>${pnlCell}</td>
              <td><span class="${klass}">${label}</span></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      <p class="trade-foot">
        共 ${d.total} 笔，显示最近 ${d.rows.length} 笔　·　
        手续费 ${((state.market?.config?.feeRate || 0) * 100).toFixed(3)}%，印花税（卖出方向）${((state.market?.config?.stampDuty || 0) * 100).toFixed(3)}%
      </p>`;
  } catch (e) {
    wrap.innerHTML = `<table><tbody><tr class="empty-row"><td>${e.message}</td></tr></tbody></table>`;
  }
}

// ---------------- 打工 ----------------
function renderWork() {
  const me = state.market?.me;
  const cfg = state.market?.config || {};
  const reward = cfg.workReward ?? 1000;

  const btn = $('#workBtn');
  const hint = $('#workHint');
  if (!btn) return;

  const queued = !!me?.workQueued;
  btn.classList.toggle('is-queued', queued);
  btn.disabled = queued;

  if (hint) {
    hint.textContent = queued ? '已打卡 · 等这一轮结算' : '点一下开始搬砖';
    hint.classList.toggle('is-queued', queued);
  }

  const total = $('#workTotal');
  if (total) total.textContent = money(me?.workEarned || 0);

  const round = $('#workRound');
  if (round) {
    round.textContent = queued ? '已打卡' : '待打卡';
    round.className = queued ? 'down' : '';
  }

  const sub = btn.querySelector('.work-sub');
  if (sub) sub.textContent = `+${money(reward)} / 轮`;
}

async function pressWork() {
  const btn = $('#workBtn');
  if (!btn || btn.disabled) return;
  btn.classList.remove('pop');
  void btn.offsetWidth;
  btn.classList.add('pop');
  try {
    const r = await api('/api/work/press', { method: 'POST' });
    if (state.market?.me) state.market.me.workQueued = true;
    if (state.market?.config && r.reward) state.market.config.workReward = r.reward;
    renderWork();
  } catch (e) {
    toast(e.message, 'err');
    if (state.market?.me) state.market.me.workQueued = true;
    renderWork();
  }
}

// ---------------- 排行榜 ----------------
async function loadRank(force = false) {
  try {
    const d = await api('/api/leaderboard');
    const wrap = $('#rankTable');
    const sig = d.rows
      .map((r) => `${r.id}:${Math.round(r.equity)}:${r.cash.toFixed(0)}:${r.positions.length}`)
      .join('|');
    if (!force && sig === state.rankSig && wrap.querySelector('table')) {
      const t = $('#rankTime');
      if (t) t.textContent = '刚刚同步';
      return;
    }
    state.rankSig = sig;
    wrap.innerHTML = `
      <table>
        <thead><tr><th>#</th><th>玩家</th><th>总资产</th><th>现金</th><th>持仓</th></tr></thead>
        <tbody>
          ${d.rows.map((r, i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '';
            const mine = r.id === state.market?.me?.id ? 'rank-row-me' : '';
            const hold = r.positions.length
              ? r.positions.map((p) => `<span class="pill ${p.side}">${p.name} ${p.side === 'long' ? '多' : '空'} ×${p.qty} @${(p.leverage || 1).toFixed(0)}x</span>`).join(' ')
              : '<span class="stock-code">空仓</span>';
            return `<tr class="${mine}">
              <td><span class="rank-medal">${medal || i + 1}</span></td>
              <td>${r.nickname}</td>
              <td class="${cls(r.equity - 100000)}">${money(r.equity)}</td>
              <td>${money(r.cash)}</td>
              <td style="text-align:left">${hold}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ---------------- 管理 ----------------
async function adminLogin() {
  const pin = $('#adminPin').value.trim();
  try {
    const r = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ pin }) });
    state.adminToken = r.token;
    localStorage.setItem('xd_admin', r.token);
    $('#adminLock').classList.add('hidden');
    $('#adminPanel').classList.remove('hidden');
    loadAdmin();
  } catch (e) {
    $('#adminMsg').textContent = e.message;
  }
}

async function adminApi(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.adminToken },
    body: JSON.stringify(body || {})
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || '操作失败');
  return d;
}

async function loadAdmin() {
  const res = await fetch('/api/admin/state', { headers: { Authorization: 'Bearer ' + state.adminToken } });
  if (!res.ok) {
    $('#adminLock').classList.remove('hidden');
    $('#adminPanel').classList.add('hidden');
    return;
  }
  const d = await res.json();
  $('#adminLock').classList.add('hidden');
  $('#adminPanel').classList.remove('hidden');

  // 公告
  const notices = (d.notices || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  const nl = $('#noticeList');
  if (nl) {
    nl.innerHTML = notices.length
      ? notices.map((n) => `<div class="notice-row">
          <span class="notice-text">${escapeHtml(n.text)}</span>
          <button class="mini-btn danger" data-del-notice="${n.id}">删除</button>
        </div>`).join('')
      : '<div class="notice-empty">还没有公告</div>';
    nl.querySelectorAll('[data-del-notice]').forEach((b) => {
      b.addEventListener('click', async () => {
        try {
          await adminApi('/api/admin/announce/delete', { id: b.dataset.delNotice });
          toast('公告已删除', 'ok');
          loadAdmin();
          refreshMarket();
        } catch (e) { toast(e.message, 'err'); }
      });
    });
  }

  // 标的
  $('#adminStocks').innerHTML = d.stocks.map((s) => `
    <div class="admin-stock">
      <div>
        <b>${s.name}</b> <span class="stock-code">${s.code}</span>
        <span class="pill ${s.status === 'normal' ? 'gray' : 'short'}">${s.status === 'normal' ? '正常' : s.status === 'suspended' ? '停牌' : '退市'}</span>
        <div class="book-meta">$${s.price.toFixed(2)} · ${s.traitName}</div>
      </div>
      <div class="as-actions">
        <button class="mini-btn" data-act="suspend" data-code="${s.code}">停牌</button>
        <button class="mini-btn" data-act="resume" data-code="${s.code}">复牌</button>
        <button class="mini-btn danger" data-act="delist" data-code="${s.code}">退市</button>
      </div>
    </div>`).join('');
  $$('#adminStocks [data-act]').forEach((b) => {
    b.addEventListener('click', async () => {
      try {
        await adminApi('/api/admin/stock', { action: b.dataset.act, code: b.dataset.code, hours: 1 });
        toast('操作成功', 'ok');
        loadAdmin();
        refreshMarket();
      } catch (e) { toast(e.message, 'err'); }
    });
  });

  // 市场控制
  const isOpen = d.marketOpen !== false;
  const ms = $('#marketState');
  if (ms) {
    ms.textContent = isOpen ? '🟢 开市中' : '🔴 休市中（行情冻结）';
    ms.className = 'mc-state ' + (isOpen ? 'open' : 'closed');
  }
  const mtb = $('#marketToggleBtn');
  if (mtb) {
    mtb.textContent = isOpen ? '立即休市' : '恢复开市';
    mtb.className = 'btn ' + (isOpen ? 'btn-danger' : 'btn-primary');
    mtb.onclick = async () => {
      try {
        await adminApi('/api/admin/market', { open: !isOpen });
        toast(!isOpen ? '已开市' : '已休市，行情冻结', 'ok');
        await loadAdmin();
        await refreshMarket();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  }

  // 新闻标的
  $('#newsStocks').innerHTML = d.stocks.map((s) =>
    `<button class="chip-toggle" data-code="${s.code}">${s.name}</button>`).join('') +
    `<button class="chip-toggle" data-code="ALL">全市场</button>`;
  $$('#newsStocks .chip-toggle').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.code === 'ALL') {
        state.adminSelected.clear();
        $$('#newsStocks .chip-toggle').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        state.adminAll = true;
      } else {
        state.adminAll = false;
        $$('#newsStocks .chip-toggle[data-code="ALL"]').forEach((x) => x.classList.remove('on'));
        b.classList.toggle('on');
        if (b.classList.contains('on')) state.adminSelected.add(b.dataset.code);
        else state.adminSelected.delete(b.dataset.code);
      }
    });
  });

  // 活跃事件
  $('#activeEvents').innerHTML = (d.events || []).length
    ? d.events.map((e) => `<div class="active-event">${e.text.slice(0, 40)}</div>`).join('')
    : '<div class="active-event">当前没有活跃新闻</div>';

  // 参数
  const cfgFields = [
    ['tickMs', 'tick 间隔(ms)'], ['baseVolatility', '基础波动率'], ['meanReversion', '均值回归'],
    ['feeRate', '手续费率'], ['stampDuty', '印花税率'], ['maxLeverage', '最大杠杆'],
    ['maxOrdersPerTick', '每轮最多下单次数'],
    ['eventChance', '新闻概率/tick'],
    ['workReward', '每次打工工资'],
    ['adminPin', '管理员口令', 'text'], ['allowRegister', '开放注册(1/0)']
  ];
  $('#configForm').innerHTML = cfgFields.map(([k, label, type]) => {
    let v = d.config[k];
    if (typeof v === 'boolean') v = v ? 1 : 0;
    return `<label class="field"><span>${label}</span>
      <input type="${type || 'number'}" ${type === 'text' ? '' : 'step="0.0001"'} data-cfg="${k}" value="${v}" />
    </label>`;
  }).join('');
}

async function saveConfig() {
  const patch = {};
  $$('#configForm [data-cfg]').forEach((inp) => {
    const k = inp.dataset.cfg;
    if (k === 'adminPin') patch[k] = String(inp.value);
    else if (k === 'allowRegister') patch[k] = Boolean(Number(inp.value));
    else patch[k] = Number(inp.value);
  });
  try {
    await adminApi('/api/admin/config', { patch });
    toast('参数已保存', 'ok');
    const m = await api('/api/market');
    state.market.config = m.config;
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function publishNotice() {
  const text = $('#noticeText').value.trim();
  if (!text) { toast('写点什么', 'err'); return; }
  try {
    await adminApi('/api/admin/announce', { text });
    toast('公告已发布', 'ok');
    $('#noticeText').value = '';
    loadAdmin();
    refreshMarket();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function publishNews() {
  const text = $('#newsText').value.trim();
  if (!text) { toast('写点什么', 'err'); return; }
  const companies = state.adminAll ? [] : Array.from(state.adminSelected);
  try {
    await adminApi('/api/admin/news', {
      text,
      companies,
      dir: Number($('#newsDir').value),
      duration: Number($('#newsDuration').value)
    });
    toast('新闻已发布', 'ok');
    $('#newsText').value = '';
    loadAdmin();
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ---------------- 视图切换 ----------------
function switchView(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  if (name === 'portfolio') { renderPortfolio(); loadTrades(); }
  if (name === 'work') renderWork();
  if (name === 'rank') loadRank(true);
  if (name === 'admin') {
    if (state.adminToken) loadAdmin();
    else {
      $('#adminLock').classList.remove('hidden');
      $('#adminPanel').classList.add('hidden');
    }
  }
}

// ---------------- 头像 ----------------
async function handleAvatarFile(file) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = async () => {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const side = Math.min(img.width, img.height);
    ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
    const dataUrl = canvas.toDataURL('image/png');
    URL.revokeObjectURL(url);
    try {
      const r = await api('/api/avatar', { method: 'POST', body: JSON.stringify({ dataUrl }) });
      state.market.me.avatar = r.avatar;
      const el = $('#avatarImg');
      el.src = r.avatar;
      el.classList.add('on');
      toast('头像已更新', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  img.src = url;
}

// ---------------- 事件绑定 ----------------
function bind() {
  $('#loginBtn').addEventListener('click', doLogin);
  $('#pinUpgradeBtn').addEventListener('click', upgradePin);
  $('#newPin2').addEventListener('keydown', (e) => { if (e.key === 'Enter') upgradePin(); });
  $('#loginPin').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('#loginNick').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#loginPin').focus(); });

  $('#logoutBtn').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
    localStorage.removeItem('xd_token');
    state.token = '';
    if (state.stream) state.stream.close();
    location.reload();
  });

  $$('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

  $$('#tfGroup .tf').forEach((b) => {
    b.addEventListener('click', () => {
      $$('#tfGroup .tf').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.tf = b.dataset.tf;
      state.candles = [];
      renderStockList();
      renderTopbar();
      const cur = state.market?.stocks?.[state.code];
      if (cur) {
        const c = stockChange(cur);
        $('#chartPrice').className = 'big-price ' + cls(c);
        const ce2 = $('#chartChange');
        ce2.textContent = pct(c);
        ce2.className = 'big-change ' + cls(c);
      }
      loadCandles();
    });
  });

  $$('#maGroup input').forEach((inp) => {
    inp.addEventListener('change', () => {
      state.maVisible[Number(inp.dataset.ma)] = inp.checked;
      renderMAs();
    });
  });

  $$('#sideSwitch .side-btn').forEach((b) => {
    b.addEventListener('click', () => {
      state.side = b.dataset.side;
      $$('#sideSwitch .side-btn').forEach((x) => x.classList.toggle('active', x === b));
      updateCostPreview();
    });
  });

  $$('.quick-qty button').forEach((b) => {
    b.addEventListener('click', () => {
      const st = state.market?.stocks?.[state.code];
      const lev = Number($('#orderLev').value) || 1;
      if (b.dataset.qty === 'max') {
        if (!st) return;
        const cash = state.market?.me?.cash || 0;
        const cfg = state.market?.config || {};
        // 先算清每 1 股要花多少钱：保证金 + 手续费 + 卖出方向的印花税
        const perShare = st.price / lev
          + st.price * (cfg.feeRate || 0)
          + st.price * (state.side === 'short' ? (cfg.stampDuty || 0) : 0);
        // 留 0.5% 余量，避免浮点误差和结算时价格跳动导致「现金不足」
        const qty = Math.floor((cash * 0.995) / perShare);
        $('#orderQty').value = Math.max(1, qty);
      } else {
        $('#orderQty').value = b.dataset.qty;
      }
      updateCostPreview();
    });
  });

  ['#orderQty', '#orderLev', '#orderTp', '#orderSl'].forEach((sel) => {
    $(sel).addEventListener('input', updateCostPreview);
  });
  $('#orderBtn').addEventListener('click', placeOrder);

  $('#avatarBtn').addEventListener('click', () => $('#avatarInput').click());
  $('#avatarInput').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) handleAvatarFile(f);
    e.target.value = '';
  });

  $('#refreshTrades')?.addEventListener('click', loadTrades);
  $('#adminLoginBtn').addEventListener('click', adminLogin);
  $('#newsBtn').addEventListener('click', publishNews);
  $('#noticeBtn')?.addEventListener('click', publishNotice);
  $('#workBtn')?.addEventListener('click', pressWork);
  $('#configSaveBtn').addEventListener('click', saveConfig);

  // 定时刷新「我的」与「排行」，保证不靠 SSE 也准确
  setInterval(() => {
    if ($('#view-work').classList.contains('active')) renderWork();
  }, 1000);
}

// ---------------- 启动 ----------------
async function boot() {
  bind();
  if (state.token) {
    try {
      const d = await api('/api/market');
      if (!d.me) throw new Error('未登录');
      state.market = d;
      state.me = d.me;
      await enterGame();
      return;
    } catch {
      localStorage.removeItem('xd_token');
      state.token = '';
    }
  }
  showLogin();
}

boot();
