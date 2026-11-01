// 汐灯证券 · 前端逻辑
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const TF_SECONDS = { '1m': 12, '5m': 60, '15m': 180, '1h': 720, '4h': 2880 };

const state = {
  token: localStorage.getItem('xd_token') || '',
  market: null,
  me: null,
  code: 'DENG',
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
  build: null,
  eqChart: null,
  eqTotal: null,
  eqTrading: null,
  listTab: 'quotes',
  limitAuto: true,
  orderMode: 'open',
  tradeTab: 'order',
  stockTradesLoaded: false,
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
  renderMyOrders();
  if (state.listTab === 'positions') renderSidePositions();
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

// ---------------- 左侧卡片：实时行情 / 我的持仓 切换 ----------------
function switchListTab(name) {
  state.listTab = name;
  $$('.list-tab').forEach((b) => b.classList.toggle('active', b.dataset.ltab === name));
  $('#stockList')?.classList.toggle('hidden', name !== 'quotes');
  $('#sidePositions')?.classList.toggle('hidden', name !== 'positions');
  if (name === 'positions') renderSidePositions();
}

function renderSidePositions() {
  const wrap = $('#sidePositions');
  if (!wrap) return;
  const pos = Object.values(state.market?.me?.positions || {});
  const cnt = $('#posCount');
  if (cnt) cnt.textContent = pos.length ? String(pos.length) : '';

  if (!pos.length) {
    wrap.innerHTML = '<div class="side-empty">还没有持仓<br />在右边下单试试</div>';
    return;
  }

  wrap.innerHTML = pos.map((p) => {
    const st = state.market.stocks[p.code] || {};
    const icon = st.icon || '';
    const name = st.name || p.code;
    return `<div class="stock-item side-pos" data-pos="${p.code}">
      <img class="stock-icon-sm" src="${icon}" alt="" />
      <div class="stock-main">
        <div class="stock-name">${name} <span class="stock-code">${p.code}</span></div>
        <div class="side-pos-sub">
          <span class="pill ${p.side}">${p.side === 'long' ? '多' : '空'}</span>
          ${p.qty} 股 · ${(p.leverage || 1).toFixed(0)}x
        </div>
      </div>
      <div class="stock-price-box">
        <div class="stock-price ${cls(p.pnl)}">${p.pnl >= 0 ? '+' : ''}${money(p.pnl)}</div>
        <div class="stock-chg ${cls(p.pnl)}">${pct(p.margin > 0 ? (p.pnl / p.margin) * 100 : 0)}</div>
      </div>
    </div>`;
  }).join('');

  wrap.querySelectorAll('[data-pos]').forEach((el) => {
    el.addEventListener('click', () => selectStock(el.dataset.pos));
  });
}

// ---------------- 限价挂单 ----------------
// 挂单价默认跟随现价，玩家手动改过就不再覆盖
function syncLimitPrice(force = false) {
  const inp = $('#orderLimit');
  const st = state.market?.stocks?.[state.code];
  if (!inp || !st) return;
  if (force || state.limitAuto) {
    inp.value = st.price.toFixed(2);
    state.limitAuto = true;
  }
}

async function placeLimit() {
  const st = state.market?.stocks?.[state.code];
  if (!st) return;
  const limit = Number($('#orderLimit').value);
  if (!(limit > 0)) { toast('先填挂单价', 'err'); return; }

  const mode = state.orderMode || 'open';
  const pos = state.market?.me?.positions?.[state.code];

  let payload;
  if (mode === 'close') {
    if (!pos) { toast('这只票没有持仓可平', 'err'); return; }
    payload = { code: st.code, action: 'close', side: pos.side, limit };
  } else {
    payload = {
      code: st.code,
      action: 'open',
      side: state.side,
      qty: Number($('#orderQty').value),
      leverage: Number($('#orderLev').value) || 1,
      tp: Number($('#orderTp').value) || null,
      sl: Number($('#orderSl').value) || null,
      limit
    };
  }

  try {
    await api('/api/order/limit', { method: 'POST', body: JSON.stringify(payload) });
    toast(`挂单已提交：${mode === 'close' ? '平仓' : '开仓'} @ ${limit.toFixed(2)}`, 'ok');
    refreshMarket();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/** 开仓 / 平仓 模式切换 */
function switchOrderMode(mode) {
  state.orderMode = mode;
  $$('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));

  const isClose = mode === 'close';
  // 平仓不需要数量/杠杆/止盈止损
  ['#orderQty', '#orderLev', '#orderTp', '#orderSl'].forEach((sel) => {
    const el = $(sel);
    const field = el?.closest('.field') || el?.closest('.quick-qty');
    if (field) field.classList.toggle('hidden', isClose);
  });
  $('.quick-qty')?.classList.toggle('hidden', isClose);

  // 成本预估框在平仓模式下没意义，一起藏起来
  $('.cost-box')?.classList.toggle('hidden', isClose);

  const hint = $('#closeHint');
  const pos = state.market?.me?.positions?.[state.code];
  if (hint) {
    hint.classList.toggle('hidden', !isClose);
    if (isClose) {
      const perTick = Number(state.market?.config?.maxFillQtyPerTick ?? 1000);
      hint.textContent = pos
        ? `当前持仓：${pos.side === 'long' ? '多' : '空'} ${pos.qty} 股 · ${(pos.leverage || 1).toFixed(0)}x · 成本 ${pos.entry.toFixed(2)}；每轮最多成交 ${perTick} 股`
        : '这只票没有持仓';
    }
  }
  updateOrderBtnLabel();
}

function updateOrderBtnLabel() {
  const btn = $('#orderBtn');
  if (!btn) return;
  const mode = state.orderMode || 'open';
  if (mode === 'close') {
    const pos = state.market?.me?.positions?.[state.code];
    btn.textContent = pos ? (pos.side === 'long' ? '挂单平多' : '挂单平空') : '没有持仓';
    btn.disabled = !pos;
    return;
  }
  btn.textContent = state.side === 'long' ? '挂单开多' : '挂单开空';
  btn.disabled = false;
}

function renderMyOrders() {
  const box = $('#myOrders');
  if (!box) return;
  const list = state.market?.me?.orders || [];
  if (!list.length) {
    box.innerHTML = '';
    return;
  }
  const tickNow = state.market?.tick || 0;
  box.innerHTML = `<div class="my-orders-head">我的挂单 ${list.length}</div>` +
    list.map((o) => {
      const buy = (o.action === 'open' && o.side === 'long') || (o.action === 'close' && o.side === 'short');
      const left = Math.max(0, (o.expireTick || 0) - tickNow);
      const label = o.action === 'close' ? '平' : '开';
      return `<div class="mo-row">
        <span class="mo-side ${buy ? 'buy' : 'sell'}">${label}${buy ? '买' : '卖'}</span>
        <span class="mo-name">${o.name}</span>
        <span class="mo-qty">${o.qty}股</span>
        <span class="mo-price">@${Number(o.limit).toFixed(2)}</span>
        <span class="mo-left">${left}轮</span>
        <button class="mo-cancel" data-cancel="${o.id}">撤</button>
      </div>`;
    }).join('');

  box.querySelectorAll('[data-cancel]').forEach((b) => {
    b.addEventListener('click', async () => {
      try {
        await api('/api/order/cancel', { method: 'POST', body: JSON.stringify({ id: b.dataset.cancel }) });
        toast('已撤单', 'ok');
        refreshMarket();
      } catch (e) {
        toast(e.message, 'err');
        refreshMarket();
      }
    });
  });
}

async function placeLimitStub() {}

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
  syncLimitPrice(true);
  switchOrderMode(state.orderMode || 'open');
  loadMyTrades();
  loadCandles();
  state.stockTradesLoaded = false;
  if (state.tradeTab === 'log') loadStockTrades();
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

// ---------------- 下单卡片：下单 / 成交记录 切换 ----------------
function switchTradeTab(name) {
  state.tradeTab = name;
  document.querySelectorAll('.trade-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.ttab === name);
  });
  $('#orderPane')?.classList.toggle('hidden', name !== 'order');
  $('#logPane')?.classList.toggle('hidden', name !== 'log');
  if (name === 'log') loadStockTrades();
}

// 当天只显示时分秒，跨天带上月日
function tradeTime(at) {
  const d = new Date(Number(at) || 0);
  if (!Number(at)) return '—';
  const p2 = (n) => String(n).padStart(2, '0');
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  return sameDay ? hm : `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm.slice(0, 5)}`;
}

async function loadStockTrades() {
  const box = $('#stockTradeList');
  if (!box) return;
  if (!state.stockTradesLoaded) box.innerHTML = '<div class="st-empty">加载中…</div>';
  try {
    const d = await api(`/api/stock-trades?code=${encodeURIComponent(state.code)}&limit=50`);
    const rows = d.rows || [];
    state.stockTradesLoaded = true;
    if (!rows.length) {
      box.innerHTML = '<div class="st-empty">这只票还没有人成交</div>';
      return;
    }
    box.innerHTML = rows.map((r) => `
      <div class="st-row">
        ${rankAvatar(r)}
        <span class="st-side ${r.buy ? 'buy' : 'sell'}">${r.buy ? '买' : '卖'}</span>
        <span class="st-lev">${(Number(r.leverage) || 1).toFixed(0)}x</span>
        <span class="st-amt">${money(r.amount)}</span>
        <span class="st-time">${tradeTime(r.at)}</span>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div class="st-empty">${e.message}</div>`;
  }
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

  checkBuild(d.build);
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
  syncLimitPrice();
  updateOrderBtnLabel();
  updatePriceLines();
  renderPositions();
  renderMyOrders();
  if (state.listTab === 'positions') renderSidePositions();
  if ($('#view-portfolio').classList.contains('active')) {
    renderPortfolio();
    loadEquityCurve();
  }
  if ($('#view-rank').classList.contains('active')) loadRank();
  if ($('#view-work').classList.contains('active')) renderWork();
  if (state.tradeTab === 'log' && $('#logPane') && !$('#logPane').classList.contains('hidden')) {
    loadStockTrades();
  }
  if (d.closes && d.closes.length) handleCloses(d.closes);
  if (d.alerts && d.alerts.length) handleAlerts(d.alerts);
  if (d.orderEvents && d.orderEvents.length) handleOrderEvents(d.orderEvents);
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

function handleOrderEvents(list) {
  refreshMarket();
  for (const e of list) {
    if (e.type === 'fill') {
      const side = e.side === 'long' ? '多' : '空';
      toast(`✓ 挂单成交：${e.name} ${side} ${e.qty} 股 @ ${Number(e.price).toFixed(2)}`, 'ok');
    } else if (e.type === 'cancel') {
      toast(`挂单已撤销：${e.name}（${e.reason}）`, 'err');
    } else if (e.type === 'fail') {
      toast(`挂单未成交：${e.name}（${e.reason}）`, 'err');
    }
  }
}

function handleAlerts(list) {
  for (const a of list) {
    if (a.type !== 'steal') continue;
    if (!a.ok) {
      toast(`小偷空手而归：${a.target} 身上没现金`, 'err');
      continue;
    }
    if (a.mine) {
      const cdNote = a.cd ? `（冷却 ${a.cd} 轮）` : '';
      toast(`🥷 从 ${a.target} 那里偷到了 ${money(a.amount)}${cdNote}`, 'ok');
    }
    else toast(`🚨 ${a.from} 偷走了你 ${money(a.amount)}！`, 'err');
  }
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

/** 当前现金 + 当前杠杆下能买的最大股数（已扣手续费和印花税） */
function maxAffordableQty() {
  const st = state.market?.stocks?.[state.code];
  if (!st) return 0;
  const lev = Number($('#orderLev').value) || 1;
  const cash = state.market?.me?.cash || 0;
  const cfg = state.market?.config || {};
  // 每 1 股要花：保证金 + 手续费 + 卖出方向的印花税
  const perShare = st.price / lev
    + st.price * (cfg.feeRate || 0)
    + st.price * (state.side === 'short' ? (cfg.stampDuty || 0) : 0);
  if (!(perShare > 0)) return 0;
  // 留 0.5% 余量，避免浮点误差和结算时价格跳动导致「现金不足」
  return Math.max(0, Math.floor((cash * 0.995) / perShare));
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
    : (state.side === 'long' ? '挂单开多' : '挂单开空');
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
    if (state.listTab === 'positions') renderSidePositions();
    loadMyTrades();
    toast(`${state.side === 'long' ? '开多' : '开空'} ${qty} 股 ${st.name}`, 'ok');
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    $('#orderBtn').disabled = false;
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
            <td class="op-hint">用右上「平仓」挂单</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;

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
  const frozenCash = Number(me.frozen) || 0;
  $('#statGrid').innerHTML = `
    <div class="stat-card"><div class="stat-label">总资产</div><div class="stat-value">${money(me.equity)}</div><div class="stat-sub">现金 + 保证金 + 浮盈亏${frozenCash > 0 ? ' + 冻结押金' : ''}</div></div>
    <div class="stat-card"><div class="stat-label">可用现金</div><div class="stat-value">${money(me.cash)}</div><div class="stat-sub">${frozenCash > 0 ? `另有 ${money(frozenCash)} 冻结在挂单里` : '可用于开新仓'}</div></div>
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
            <td class="op-hint">用行情页「平仓」挂单</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

// ---------------- 交易记录 ----------------
const REASON_LABEL = {
  manual: ['手动', 'pill gray'],
  tp: ['止盈', 'pill long'],
  sl: ['止损', 'pill short'],
  liquidated: ['爆仓', 'pill short'],
  delisted: ['退市', 'pill short'],
  steal: ['偷来的', 'pill long'],
  stolen: ['被偷了', 'pill short']
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
            const isSteal = t.action === 'steal' || t.action === 'stolen';
            const isOpen = t.action === 'open';
            const pnlCell = (t.action === 'close' || isSteal)
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
              <td>${t.name || t.code}${t.code ? ` <span class="stock-code">${t.code}</span>` : ''}</td>
              <td>${isSteal ? (t.action === 'steal' ? '偷钱' : '被偷') : isOpen ? '开仓' : '平仓'}</td>
              <td>${isSteal ? '<span class="stock-code">—</span>' : `<span class="pill ${t.side}">${t.side === 'long' ? '多' : '空'}</span>`}</td>
              <td>${isSteal ? '—' : t.qty}</td>
              <td>${isSteal ? '—' : Number(t.price).toFixed(2)}</td>
              <td>${isSteal ? '—' : (t.leverage || 1).toFixed(1) + 'x'}</td>
              <td>${isSteal ? money(t.amount || 0) : amountCell}</td>
              <td>${isSteal ? '<span class="stock-code">—</span>' : feeCell}</td>
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

// ---------------- 收益曲线 ----------------
function ensureEquityChart() {
  if (state.eqChart) return state.eqChart;
  const box = $('#equityChart');
  if (!box || typeof LightweightCharts === 'undefined') return null;

  const chart = LightweightCharts.createChart(box, {
    layout: {
      background: { color: 'transparent' },
      textColor: '#8aa39c',
      fontFamily: 'inherit',
      fontSize: 10
    },
    grid: {
      vertLines: { color: 'rgba(15, 42, 38, .045)' },
      horzLines: { color: 'rgba(15, 42, 38, .045)' }
    },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.15, bottom: 0.12 } },
    leftPriceScale: { visible: true, borderVisible: false, scaleMargins: { top: 0.15, bottom: 0.12 } },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: 'rgba(13,148,136,.4)', width: 1, style: 2, labelBackgroundColor: '#0d9488' },
      horzLine: { color: 'rgba(13,148,136,.4)', labelBackgroundColor: '#0d9488' }
    },
    handleScale: { axisPressedMouseMove: false }
  });

  const total = chart.addLineSeries({
    color: '#0d9488',
    lineWidth: 2,
    priceScaleId: 'right',
    priceLineVisible: false,
    lastValueVisible: true,
    crosshairMarkerVisible: true
  });
  // 纯投资收益量级小得多，单独用左轴，否则会被压成一条直线
  const trading = chart.addLineSeries({
    color: '#f59e0b',
    lineWidth: 2,
    priceScaleId: 'left',
    priceLineVisible: false,
    lastValueVisible: true,
    crosshairMarkerVisible: true
  });

  state.eqChart = chart;
  state.eqTotal = total;
  state.eqTrading = trading;

  const ro = new ResizeObserver(() => {
    if ($('#equityChart')) chart.applyOptions({ width: box.clientWidth, height: box.clientHeight || 240 });
  });
  ro.observe(box);
  chart.applyOptions({ width: box.clientWidth, height: 240 });
  return chart;
}

async function loadEquityCurve() {
  const box = $('#equityChart');
  const empty = $('#equityEmpty');
  if (!box) return;
  try {
    const d = await api('/api/equity-curve');
    const pts = d.points || [];
    const chart = ensureEquityChart();
    if (!chart) return;

    if (empty) empty.classList.toggle('hidden', pts.length > 1);
    box.style.opacity = pts.length > 1 ? '1' : '0';
    if (pts.length <= 1) {
      const hint = $('#equityHint');
      if (hint) hint.textContent = '数据积累中';
      return;
    }

    // 同一秒只留最后一个点，时间必须严格递增否则图表会报错
    const totalData = [];
    const tradingData = [];
    const seen = new Map();
    for (const p of pts) {
      if (seen.has(p.time)) {
        const i = seen.get(p.time);
        totalData[i].value = p.equity;
        tradingData[i].value = p.trading;
        continue;
      }
      seen.set(p.time, totalData.length);
      totalData.push({ time: p.time, value: p.equity });
      tradingData.push({ time: p.time, value: p.trading });
    }
    state.eqTotal.setData(totalData);
    state.eqTrading.setData(tradingData);
    chart.timeScale().fitContent();

    const last = pts[pts.length - 1];
    const first = pts[0];
    const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
    const legend = $('#equityLegend');
    if (legend) {
      const dTotal = last.equity - first.equity;
      const dTrade = last.trading - first.trading;
      legend.innerHTML = `
        <span><i class="eq-dot" style="background:#0d9488"></i>总资产
          <b class="${cls(dTotal)}">${money(last.equity)}</b>
          <small class="${cls(dTotal)}">${dTotal >= 0 ? '+' : ''}${money(dTotal).replace('-', '')}</small>
        </span>
        <span><i class="eq-dot" style="background:#f59e0b"></i>纯投资收益
          <b class="${cls(last.trading)}">${money(last.trading)}</b>
          <small class="${cls(dTrade)}">${dTrade >= 0 ? '+' : ''}${money(dTrade).replace('-', '')}</small>
        </span>`;
    }
    const hint = $('#equityHint');
    if (hint) {
      const mins = Math.round((pts.length * (d.sampleTicks || 12) * (state.market?.tickMs || 5000)) / 60000);
      hint.textContent = `${pts.length} 个点 · 约 ${mins >= 60 ? (mins / 60).toFixed(1) + ' 小时' : mins + ' 分钟'}`;
    }
  } catch (e) {
    if (empty) {
      empty.classList.remove('hidden');
      empty.textContent = e.message;
    }
  }
}

// ---------------- 版本自动更新 ----------------
let buildReloading = false;

function checkBuild(build) {
  if (!build || buildReloading) return;
  if (!state.build) {
    state.build = build;
    return;
  }
  if (build === state.build) return;

  // 服务器换了新前端文件，本地还是旧的 —— 自动重新加载
  buildReloading = true;
  const bar = document.createElement('div');
  bar.className = 'update-bar';
  bar.innerHTML = '<span>发现新版本，正在更新…</span>';
  document.body.appendChild(bar);
  setTimeout(() => location.reload(), 1200);
}

// ---------------- 打工（自动积累） ----------------
function renderWork() {
  const me = state.market?.me;
  const cfg = state.market?.config || {};
  const rate = Number(cfg.workRatePerTick ?? 50);
  const mult = Number(cfg.workOnlineMultiplier ?? 2);
  const capTicks = Number(cfg.workBankTicks ?? 1440);
  const cap = rate * capTicks;

  const bank = Number(me?.workBank || 0);
  const full = cap > 0 && bank >= cap - 0.01;
  const online = !!me?.workOnline;

  const amount = $('#workAmount');
  if (amount) amount.textContent = money(bank);

  const rateLine = $('#workRateLine');
  if (rateLine) {
    rateLine.textContent = online
      ? `在线加成 · 每轮 +${money(rate * mult)}`
      : `离线积累 · 每轮 +${money(rate)}`;
    rateLine.classList.toggle('is-online', online);
    rateLine.classList.toggle('is-full', full);
  }

  const bar = $('#workBar');
  if (bar) {
    const p = cap > 0 ? Math.min(100, (bank / cap) * 100) : 0;
    bar.style.width = p.toFixed(1) + '%';
    bar.classList.toggle('is-full', full);
  }

  const btn = $('#workBtn');
  if (btn) {
    btn.disabled = bank < 1;
    btn.classList.toggle('is-empty', bank < 1);
  }

  const hint = $('#workHint');
  if (hint) {
    hint.textContent = full
      ? '钱袋满了，再不取就白攒了'
      : bank < 1
        ? '钱袋还是空的，等下一轮'
        : `还能再攒 ${money(cap - bank)}`;
    hint.classList.toggle('is-full', full);
  }

  const total = $('#workTotal');
  if (total) total.textContent = money(me?.workEarned || 0);

  const status = $('#workRound');
  if (status) {
    status.textContent = full ? '已满' : online ? '在线 2 倍' : '离线积累';
    status.className = full ? 'up' : '';
  }
}

async function collectWork() {
  const btn = $('#workBtn');
  if (!btn || btn.disabled) return;
  btn.classList.remove('pop');
  void btn.offsetWidth;
  btn.classList.add('pop');
  try {
    const r = await api('/api/work/collect', { method: 'POST' });
    if (state.market?.me) {
      state.market.me.workBank = 0;
      state.market.me.cash = r.cash;
      state.market.me.workEarned = r.workEarned;
      state.market.me.equity = (state.market.me.equity || 0);
    }
    toast(`💰 取出 ${money(r.amount)}`, 'ok');
    renderWork();
    refreshMarket();
  } catch (e) {
    toast(e.message, 'err');
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
        <thead><tr><th>#</th><th>玩家</th><th>总资产</th><th>现金</th><th>持仓</th><th>操作</th></tr></thead>
        <tbody>
          ${d.rows.map((r, i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '';
            const mine = r.id === state.market?.me?.id ? 'rank-row-me' : '';
            const hold = r.positions.length
              ? r.positions.map((p) => `<span class="pill ${p.side}">${p.name} ${p.side === 'long' ? '多' : '空'} ×${p.qty} @${(p.leverage || 1).toFixed(0)}x</span>`).join(' ')
              : '<span class="stock-code">空仓</span>';
            const cfg = state.market?.config || {};
            const meNow = state.market?.me || {};
            const queued = !!meNow.stealQueued;
            const isMe = r.id === meNow.id;
            const tickNow = state.market?.tick || 0;
            const cdLeft = Math.max(0, (Number(meNow.stealReadyAt) || 0) - tickNow);
            let actionCell = '<span class="stock-code">—</span>';
            if (!isMe) {
              if (cdLeft > 0) {
                actionCell = `<span class="steal-cd" title="冷却结束后可以再偷">冷却 ${cdLeft}</span>`;
              } else if (queued) {
                actionCell = '<span class="steal-done">已派出</span>';
              } else if (r.cash <= 0) {
                actionCell = '<span class="stock-code">没现金</span>';
              } else {
                const capByEquity = Math.floor(r.equity * Number(cfg.stealCapRatio ?? 0.001));
                const maxTake = Math.max(0, Math.min(capByEquity, r.cash));
                actionCell = `<button class="steal-btn" data-steal="${r.id}" data-name="${escapeHtml(r.nickname)}" title="总资产 0.1% = ${money(capByEquity)}，实际最多能拿走 ${money(maxTake)}">偷钱</button>`;
              }
            }
            return `<tr class="${mine}">
              <td><span class="rank-medal">${medal || i + 1}</span></td>
              <td><span class="rank-user">${rankAvatar(r)}<span class="rank-name">${r.nickname}</span></span></td>
              <td class="${cls(r.equity - 100000)}">${money(r.equity)}</td>
              <td>${money(r.cash)}</td>
              <td style="text-align:left">${hold}</td>
              <td>${actionCell}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
    wrap.querySelectorAll('[data-steal]').forEach((b) => {
      b.addEventListener('click', () => stealFrom(b.dataset.steal, b.dataset.name));
    });
  } catch (e) {
    toast(e.message, 'err');
  }
}

// 排行榜头像：有图用图，没图用昵称首字 + 稳定色
function rankAvatar(r) {
  // 首字永远垫在底下，图片加载失败就自动露出来
  const key = String(r.id || r.nickname || '');
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const hue = Math.round(((h % 1000) / 1000 * 137.508 * 2) % 360);
  const ch = (r.nickname || '?').trim().charAt(0) || '?';
  const img = r.avatar
    ? `<img src="${r.avatar}" alt="" loading="lazy" onerror="this.remove()" />`
    : '';
  return `<span class="rank-avatar rank-avatar-letter" style="--h:${hue}">${img}<span class="ra-ch">${ch}</span></span>`;
}

async function stealFrom(targetId, name) {
  try {
    const r = await api('/api/steal', { method: 'POST', body: JSON.stringify({ targetId }) });
    if (state.market?.me) state.market.me.stealQueued = { targetId };
    toast(`小偷已出发，准备偷 ${name}`, 'ok');
    if ($('#view-portfolio').classList.contains('active')) loadTrades();
    loadRank(true);
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

  // 个股设置
  renderTraitForm(d.stocks);

  // 参数（分组渲染）
  const CFG_GROUPS = [
    {
      title: '行情节奏',
      desc: '价格怎么动',
      fields: [
        ['tickMs', 'tick 间隔(ms)'],
        ['baseVolatility', '基础波动率'],
        ['meanReversion', '均值回归强度']
      ]
    },
    {
      title: '交易规则',
      desc: '开仓平仓的代价',
      fields: [
        ['startingCash', '新开户资金'],
        ['feeRate', '手续费率'],
        ['stampDuty', '印花税率'],
        ['minLeverage', '最小杠杆'],
        ['maxLeverage', '最大杠杆'],
        ['maxOrdersPerTick', '每轮最多下单'],
        ['maxFillQtyPerTick', '每轮最多成交(股)']
      ]
    },
    {
      title: '市场冲击',
      desc: '玩家大单怎么影响价格',
      fields: [
        ['playerImpactEnabled', '开关(1=开 0=关)'],
        ['playerImpactRef', '参考成交额'],
        ['playerImpactStrength', '推力系数'],
        ['playerImpactDecay', '每轮衰减'],
        ['playerImpactMax', '单轮最大影响'],
        ['playerImpactFlowMax', '压力上限']
      ]
    },
    {
      title: '新闻事件',
      desc: '消息怎么影响价格',
      fields: [
        ['eventChance', '新闻概率/tick'],
        ['eventImpactScale', '影响倍率(1=标准)'],
        ['eventDurationMin', '最短持续(轮)'],
        ['eventDurationMax', '最长持续(轮)']
      ]
    },
    {
      title: '打工',
      desc: '自动积累的钱袋',
      fields: [
        ['workRatePerTick', '每轮积累'],
        ['workOnlineMultiplier', '在线倍率(2=双倍)'],
        ['workBankTicks', '钱袋上限(轮)']
      ]
    },
    {
      title: '偷钱',
      desc: '从别人口袋里拿',
      fields: [
        ['stealMin', '最少金额'],
        ['stealMax', '最多金额'],
        ['stealCapRatio', '上限比例(占对方总资产)'],
        ['stealCooldownTicks', '冷却(轮)']
      ]
    },
    {
      title: '收益曲线',
      desc: '快照记录频率',
      fields: [
        ['equitySampleTicks', '采样间隔(轮)'],
        ['equityMaxPoints', '最多保留点数']
      ]
    },
    {
      title: '券商特质',
      desc: '小灯证券的业绩效应',
      fields: [
        ['brokerSensitivity', '灵敏度'],
        ['brokerCap', '单轮上限'],
        ['brokerMidpoint', '成交中枢'],
        ['brokerMidFloor', '中枢地板'],
        ['brokerAlpha', '追踪速度']
      ]
    },
    {
      title: '管理与账号',
      desc: '登录与注册',
      fields: [
        ['adminPin', '管理员口令', 'text'],
        ['pinLength', 'PIN 位数'],
        ['allowRegister', '开放注册(1/0)']
      ]
    }
  ];

  $('#configForm').innerHTML = CFG_GROUPS.map((g) => `
    <section class="cfg-group">
      <div class="cfg-group-head">
        <h4>${g.title}</h4>
        <span>${g.desc}</span>
      </div>
      <div class="cfg-grid">
        ${g.fields.map(([k, label, type]) => {
          let v = d.config[k];
          if (typeof v === 'boolean') v = v ? 1 : 0;
          if (v === undefined || v === null) v = '';
          return `<label class="field cfg-field">
            <span>${label}</span>
            <input type="${type || 'number'}"
                   ${type === 'text' ? '' : 'step="0.0001"'}
                   data-cfg="${k}" value="${v}" />
          </label>`;
        }).join('')}
      </div>
    </section>`).join('');
}

// ---------------- 个股特质 ----------------
const TRAIT_LABELS = {
  volMult: ['波动倍数', '越大越疯'],
  revMult: ['回归倍数', '越大越容易被拉回'],
  eventMult: ['新闻反应倍数', '有消息时放大几倍'],
  drift: ['每轮漂移', '正数慢慢涨，负数慢慢跌'],
  streak: ['连击阈值(轮)', '连涨/连跌多少轮触发反弹'],
  bounceLo: ['反弹下限', '如 0.04 = 4%'],
  bounceHi: ['反弹上限', '如 0.08 = 8%'],
  lotteryChance: ['彩票概率/轮', '如 0.00025'],
  lotteryLo: ['彩票涨幅下限', '如 0.25 = 25%'],
  lotteryHi: ['彩票涨幅上限', '如 0.6 = 60%'],
  floorRatio: ['护盘触发比例', '跌到初始价的几成开始托'],
  floorBoost: ['护盘加成', '每轮往上托多少']
};

function renderTraitForm(stocks) {
  const box = $('#traitForm');
  if (!box) return;
  const list = (stocks || []).filter((st) => !st.isIndex);
  if (!list.length) {
    box.innerHTML = '<div class="trait-empty">没有可配置的标的</div>';
    return;
  }

  box.innerHTML = list.map((st) => {
    const trait = st.trait || {};
    const keys = Object.keys(TRAIT_LABELS).filter((k) => typeof trait[k] === 'number');
    const fields = keys.map((k) => {
      const [label, hint] = TRAIT_LABELS[k];
      return `<label class="field cfg-field" title="${hint}">
        <span>${label}</span>
        <input type="number" step="0.00001"
               data-trait-code="${st.code}" data-trait-key="${k}"
               value="${trait[k]}" />
      </label>`;
    }).join('');

    return `<section class="trait-card">
      <div class="trait-head">
        <img class="stock-icon-sm" src="/assets/stocks/${st.code}.png" alt="" />
        <b>${st.name}</b>
        <span class="stock-code">${st.code}</span>
        <span class="trait-tag">${st.traitName || '—'}</span>
      </div>
      ${fields ? `<div class="cfg-grid">${fields}</div>` : '<div class="trait-empty">这只票没有可调参数</div>'}
    </section>`;
  }).join('');
}

async function saveTraits() {
  const byCode = new Map();
  $$('#traitForm [data-trait-code]').forEach((inp) => {
    const code = inp.dataset.traitCode;
    if (!byCode.has(code)) byCode.set(code, {});
    const v = inp.value.trim();
    if (v === '') return;
    const num = Number(v);
    if (Number.isFinite(num)) byCode.get(code)[inp.dataset.traitKey] = num;
  });

  try {
    let n = 0;
    for (const [code, patch] of byCode) {
      if (!Object.keys(patch).length) continue;
      await adminApi('/api/admin/stock-trait', { code, patch });
      n += 1;
    }
    toast(`个股设置已保存（${n} 只）`, 'ok');
    refreshMarket();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function saveConfig() {
  const patch = {};
  $$('#configForm [data-cfg]').forEach((inp) => {
    const k = inp.dataset.cfg;
    if (k === 'adminPin') patch[k] = String(inp.value);
    else if (k === 'allowRegister') patch[k] = Boolean(Number(inp.value));
    else if (inp.type === 'text') patch[k] = String(inp.value);
    else if (inp.value === '') return;
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

  // 快捷分仓：按当前现金和杠杆能买的最大股数，再取比例
  $$('.quick-qty button').forEach((b) => {
    b.addEventListener('click', () => {
      const frac = Number(b.dataset.frac) || 1;
      const maxQty = maxAffordableQty();
      // 再小的比例也至少给 1 股
      $('#orderQty').value = Math.max(1, Math.floor(maxQty * frac));
      updateCostPreview();
    });
  });

  ['#orderQty', '#orderLev', '#orderTp', '#orderSl'].forEach((sel) => {
    $(sel).addEventListener('input', updateCostPreview);
  });
  $('#orderLimit')?.addEventListener('input', () => { state.limitAuto = false; });
  $('#orderBtn').addEventListener('click', placeLimit);

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
  $('#workBtn')?.addEventListener('click', collectWork);
  document.querySelectorAll('.trade-tab').forEach((b) => {
    b.addEventListener('click', () => switchTradeTab(b.dataset.ttab));
  });
  document.querySelectorAll('.list-tab').forEach((b) => {
    b.addEventListener('click', () => switchListTab(b.dataset.ltab));
  });
  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.addEventListener('click', () => switchOrderMode(b.dataset.mode));
  });
  $('#indexBox')?.addEventListener('click', () => {
    switchView('market');
    selectStock('DENG');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('#configSaveBtn').addEventListener('click', saveConfig);
  $('#traitSaveBtn')?.addEventListener('click', saveTraits);

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
      if (d.build) state.build = d.build;
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
