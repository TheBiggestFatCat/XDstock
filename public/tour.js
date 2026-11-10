// 锦标赛前端（原生 ES Module，零依赖）

const TOKEN_KEY = 'xd_token';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  data: null,
  tab: 'home',
  side: 'long',
  lev: 20,
  qtyManual: false,
  busy: false,
  timer: null
};

// ---------- 工具 ----------
function money(v) {
  const n = Number(v) || 0;
  return '¥' + Math.round(n).toLocaleString('en-US');
}

function money2(v) {
  const n = Number(v) || 0;
  return '¥' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function price2(v) {
  return (Number(v) || 0).toFixed(2);
}

/** 杠杆上限以后端 maxLeverage 为准，前端不写死数字 */
function maxLev() {
  const m = Number(state.data?.maxLeverage);
  return m > 0 ? m : 100;
}

/**
 * 开赛时间文案：M/D HH:MM（服务器本地时间）。
 * 时间以服务端 startAt 为准，别在前端写死 21:00 —— 改赛程只用改数据。
 */
function fmtStart(ts) {
  const n = Number(ts) || 0;
  if (!n) return '--';
  const d = new Date(n);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pct(v, digit = 1) {
  const raw = Number(v) || 0;
  // 浮点误差会算出 -0.0000001，显示成「-0.00%」很怪：按显示精度归零
  const n = Number(raw.toFixed(digit)) === 0 ? 0 : raw;
  return (n > 0 ? '+' : '') + n.toFixed(digit) + '%';
}

/** 涨跌配色：0 用灰色，避免「0.00% 却是红的」 */
function chgClass(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) < 0.005) return 'chg muted';
  return n > 0 ? 'chg up' : 'chg down';
}

let toastTimer = null;
function toast(text, kind = 'ok') {
  const el = $('#toast');
  el.textContent = text;
  el.className = 'toast show' + (kind === 'err' ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  const res = await fetch(path, { ...opts, headers });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = (body && body.error) || `请求失败 (${res.status})`;
    throw new Error(msg);
  }
  return body;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function clockText(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

// ---------- 取数 ----------
async function load() {
  try {
    const d = await api('/api/tour');
    state.data = d;
    if (!state.token) state.token = '';
    render();
  } catch (e) {
    console.error('[tour] 拉取失败', e);
  }
}

// ---------- 渲染 ----------
function render() {
  const d = state.data;
  if (!d) return;
  const me = d.me;
  const status = d.status;

  // 顶栏
  const chip = $('#topStatus');
  chip.className = 'chip ' + (status === 'ended' ? 'chip-ended' : status === 'running' ? 'chip-live' : 'chip-pending');
  chip.textContent = status === 'ended' ? '已结束' : status === 'running' ? '进行中' : '筹备中';
  $('#topCount').textContent = `${d.players} 人参赛`;

  // 状态卡
  $('#statusText').textContent = status === 'ended'
    ? '冠军已产生，行情冻结'
    : status === 'running'
      ? '比赛进行中'
      : `${fmtStart(d.startAt)} 开赛`;
  renderClock();

  // 进度
  const eq = me ? me.equity : 0;
  const p = Math.max(0, Math.min(1, eq / d.target));
  $('#progressNum').textContent = `${money(eq)} / ${money(d.target)}`;
  $('#progressBar').style.width = (p * 100).toFixed(2) + '%';
  $('#progressPct').textContent = (p * 100).toFixed(p < 0.1 ? 2 : 1) + '%';
  $('#progressLeft').textContent = me
    ? (eq >= d.target ? '已达标' : `还差 ${money(d.target - eq)}`)
    : '登录后显示自己的进度';

  // 打工
  const jobBtn = $('#jobBtn');
  const canJob = !!me && status === 'running' && me.cash < d.startCash;
  jobBtn.disabled = !canJob;
  if (!me) {
    $('#jobNote').textContent = '登录后可以打工';
  } else if (status !== 'running') {
    $('#jobNote').textContent = status === 'ended' ? '赛区已冻结' : '开赛后才能打工';
  } else if (me.cash >= d.startCash) {
    $('#jobNote').textContent = `现金 ${money(me.cash)}，已经够 30 万，不用打工`;
  } else {
    $('#jobNote').textContent = `现金只剩 ${money(me.cash)}，打一次工补齐到 ${money(d.startCash)}（第 ${me.jobs + 1} 次）`;
  }

  // 首页标的
  $('#homePrice').textContent = price2(d.stock.price);
  const chg = $('#homeChg');
  chg.textContent = pct(d.stock.changePct, 2);
  chg.className = 'tiny ' + chgClass(d.stock.changePct);

  // 行情
  $('#mktPrice').textContent = price2(d.stock.price);
  const mchg = $('#mktChg');
  mchg.textContent = pct(d.stock.changePct, 2);
  mchg.className = chgClass(d.stock.changePct);
  $('#fxRate').textContent = Number(d.stock.fxRate).toFixed(2);
  $('#frozenTag').textContent = status === 'ended' ? '行情已冻结' : status === 'running' ? '行情实时' : '等待开赛';
  drawChart(d.stock.series);

  // 交易面板
  renderTrade(me, status);

  // 我的
  $('#meCash').textContent = me ? money(me.cash) : '--';
  $('#meEquity').textContent = me ? money(me.equity) : '--';
  const ret = $('#meRet');
  ret.textContent = me ? pct(me.retPct) : '--';
  ret.className = me ? chgClass(me.retPct) : '';
  $('#meRank').textContent = me && me.rank ? `#${me.rank}` : '--';
  if (me) {
    $('#recOpens').textContent = me.opens;
    $('#recCloses').textContent = me.closes;
    $('#recLiq').textContent = me.liquidations;
    $('#recJobs').textContent = me.jobs;
  }

  renderPosition(me);
  renderLog(me);
  renderRank(d);
  renderHomeRank(d);
}

function renderClock() {
  const d = state.data;
  if (!d) return;
  const clock = $('#clock');
  const hint = $('#clockHint');
  if (d.status === 'pending') {
    clock.textContent = clockText(d.startAt - Date.now());
    hint.textContent = `距开赛（${fmtStart(d.startAt)}，服务器时间）`;
    // 到点后主动拉一次，让状态尽快切过来
    if (Date.now() >= d.startAt) load();
  } else if (d.status === 'running') {
    clock.textContent = `第 ${d.tick} 轮`;
    hint.textContent = `行情进行中 · 每 ${Math.round((d.tickMs || 5000) / 1000)} 秒一轮`;
  } else {
    clock.textContent = d.winner ? d.winner.nickname : '已结束';
    hint.textContent = d.winner
      ? `冠军权益 ${money(d.winner.equity)} · 第 ${d.winner.tick} 轮达成`
      : '赛区已冻结';
  }
}

function renderTrade(me, status) {
  const d = state.data;
  const price = Number(d.stock.price) || 0;
  const cash = me ? Number(me.cash) || 0 : 0;
  const feeRate = Number(d.feeRate) || 0;
  const levMax = maxLev();
  if (state.lev > levMax) state.lev = levMax;   // 后端调低上限时别让滑条越界
  const lev = state.lev;

  // 可开数量：保证金 + 手续费 <= 现金
  const perUnit = price * (1 / lev + feeRate);
  const maxQty = perUnit > 0 ? Math.floor((cash * 0.995) / perUnit) : 0;
  $('#qtyHint').textContent = state.token
    ? (maxQty > 0 ? `最多 ${maxQty.toLocaleString('en-US')} 份` : '现金不够开仓')
    : '登录后可交易';

  // 滑块已选区的填充比例（自绘轨道用）
  const levEl = $('#lev');
  if (levEl) {
    if (Number(levEl.max) !== levMax) levEl.max = String(levMax);
    levEl.style.setProperty('--p', (((lev - 1) / Math.max(1, levMax - 1)) * 100).toFixed(1) + '%');
  }

  const qtyEl = $('#qty');
  // 默认给 1/4 仓，别一进来就是满仓满杠杆
  if (!state.qtyManual) qtyEl.value = maxQty > 0 ? Math.floor(maxQty * 0.25) : 0;

  let qty = Math.floor(Number(qtyEl.value) || 0);
  if (qty > maxQty && maxQty > 0) qty = maxQty;
  const notional = qty * price;
  const margin = lev > 0 ? notional / lev : 0;
  const fee = notional * feeRate;
  $('#calcNotional').textContent = money2(notional);
  $('#calcMargin').textContent = money2(margin);
  $('#calcFee').textContent = money2(fee);
  $('#calcCash').textContent = money2(cash);

  const openBtn = $('#openBtn');
  const canOpen = !!me && status === 'running' && qty > 0 && margin + fee <= cash + 1e-6;
  openBtn.disabled = !canOpen || state.busy;
  openBtn.textContent = state.side === 'long'
    ? `开多 · ${lev}×`
    : `开空 · ${lev}×`;

  const closeBtn = $('#closeBtn');
  closeBtn.disabled = !me || !me.position || status !== 'running' || state.busy;

  const note = [];
  if (status === 'pending') note.push('开赛前只能看，不能下单');
  if (status === 'ended') note.push('赛区已冻结，无法交易');
  if (me && me.position) {
    note.push(me.position.side === state.side
      ? '已有同向持仓，再开是加仓'
      : '手上有反向持仓，先平掉才能反手');
  }
  if (me && me.liquidations > 0) note.push(`已爆仓 ${me.liquidations} 次`);
  $('#tradeNote').textContent = note.join(' · ');
}

function renderPosition(me) {
  const box = $('#posBox');
  if (!me || !me.position) {
    box.className = 'pos-empty';
    box.textContent = state.token ? '还没有持仓' : '登录后可以参赛';
    return;
  }
  const p = me.position;
  const dir = p.side === 'long' ? 1 : -1;
  const pnlCls = p.pnl >= 0 ? 'up' : 'down';
  const roe = p.margin > 0 ? (p.pnl / p.margin) * 100 : 0;
  box.className = 'pos';
  box.innerHTML = `
    <div class="pos-top">
      <span class="pos-side ${p.side === 'long' ? 'long' : 'short'}">${p.side === 'long' ? '多单' : '空单'} · ${p.leverage}×</span>
      <span class="pos-pnl ${pnlCls}">${p.pnl >= 0 ? '+' : '-'}${money(Math.abs(p.pnl))}</span>
    </div>
    <div class="pos-grid">
      <span>数量 <b>${p.qty.toLocaleString('en-US')} 份</b></span>
      <span>均价 <b>${price2(p.entry)}</b></span>
      <span>保证金 <b>${money(p.margin)}</b></span>
      <span>收益率 <b class="${pnlCls === 'up' ? 'chg up' : 'chg down'}">${pct(roe)}</b></span>
    </div>
    <p class="tiny muted" style="margin:8px 0 0">
      方向 ${dir > 0 ? '做多' : '做空'} · 保证金剩 5% 时会被强制平仓
    </p>`;
}

function renderLog(me) {
  const box = $('#logBox');
  if (!me || !me.log || !me.log.length) {
    box.innerHTML = '<p class="tiny muted">暂无成交</p>';
    return;
  }
  const label = { open: '开仓', close: '平仓', liquidate: '强平' };
  box.innerHTML = me.log.map((r) => {
    const side = r.side === 'short' ? '空' : '多';
    const pnl = Number(r.pnl);
    const hasPnl = r.action !== 'open' && Number.isFinite(pnl);
    const at = new Date(Number(r.at) || 0);
    const hh = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
    return `<div class="log-row">
      <span class="log-when">
        <span class="log-tag">${label[r.action] || r.action}</span>
        <span class="log-time">${hh}</span>
      </span>
      <span class="mono">${side} ${Number(r.qty).toLocaleString('en-US')} @${price2(r.price)}</span>
      <span class="mono ${hasPnl ? (pnl >= 0 ? 'chg up' : 'chg down') : 'muted'}">
        ${hasPnl ? (pnl >= 0 ? '+' : '-') + money(Math.abs(pnl)) : '—'}
      </span>
    </div>`;
  }).join('');
}

function renderRank(d) {
  const box = $('#rankBox');
  $('#rankCount').textContent = `${d.ranks.length} 人`;
  if (!d.ranks.length) {
    box.innerHTML = '<p class="tiny muted">还没有人参赛，第一个进场的直接第一名</p>';
    return;
  }
  const meId = d.me ? d.me.id : '';
  box.innerHTML = d.ranks.map((r) => {
    const cls = ['rank-row'];
    if (r.id === meId) cls.push('me');
    if (r.rank === 1) cls.push('top1');
    if (r.rank === 2) cls.push('top2');
    if (r.rank === 3) cls.push('top3');
    const isWinner = d.winner && d.winner.id === r.id;
    return `<div class="${cls.join(' ')}">
      <span class="rank-no">${r.rank}</span>
      <span class="rank-name">
        <b>${escapeHtml(r.nickname)}${isWinner ? ' · 冠军' : ''}</b>
        <span>${r.inPosition ? '持仓中' : '空仓'} · 打工 ${r.jobs} 次</span>
      </span>
      <span class="rank-val">
        <b>${money(r.equity)}</b>
        <span class="${chgClass(r.retPct)}">${pct(r.retPct)}</span>
      </span>
    </div>`;
  }).join('');
}

/** 首页侧栏的迷你榜单：只放前三名，完整榜单点进去看 */
function renderHomeRank(d) {
  const box = $('#homeRank');
  if (!box) return;
  const list = (d.ranks || []).slice(0, 3);
  if (!list.length) {
    box.innerHTML = '<p class="tiny muted">还没有人参赛，第一个进场的直接第一名</p>';
    return;
  }
  const meId = d.me ? d.me.id : '';
  box.innerHTML = list.map((r) => `
    <div class="mini-rank-row${r.id === meId ? ' me' : ''}">
      <span class="mini-no n${Math.min(3, r.rank)}">${r.rank}</span>
      <span class="mini-name">${escapeHtml(r.nickname)}</span>
      <span class="mini-val">
        <b>${money(r.equity)}</b>
        <span class="${chgClass(r.retPct)}">${pct(r.retPct)}</span>
      </span>
    </div>`).join('');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ---------- 走势图 ----------
function drawChart(series) {
  const canvas = $('#chart');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 320;
  // 高度交给 CSS（移动 150 / 桌面 360），这里只负责把像素缓冲对齐
  const h = canvas.clientHeight || 150;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // 还没开赛：画条虚线 + 提示，别留一块纯白
  if (!Array.isArray(series) || series.length < 2) {
    ctx.strokeStyle = 'rgba(15,42,38,.13)';
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(10, h / 2);
    ctx.lineTo(w - 10, h / 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(15,42,38,.40)';
    ctx.font = '13px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('开赛后这里显示 LMFX 的实时走势', w / 2, h / 2 - 16);
    return;
  }

  const pad = 6;
  let lo = Math.min(...series);
  let hi = Math.max(...series);
  // 股价 1:1 跟随汇率后单轮波动只有 0.09%，序列短的时候别把 0.05% 画成崩盘
  const MIN_SPAN = 0.6;
  if (hi - lo < MIN_SPAN) {
    const mid = (hi + lo) / 2;
    lo = mid - MIN_SPAN / 2;
    hi = mid + MIN_SPAN / 2;
  }
  const span = hi - lo;
  lo -= span * 0.08;
  hi += span * 0.08;

  const x = (i) => pad + (i / (series.length - 1)) * (w - pad * 2);
  const y = (v) => h - pad - ((v - lo) / (hi - lo)) * (h - pad * 2);

  const up = series[series.length - 1] >= series[0];
  const color = up ? '#f04b4b' : '#12b886';

  // 面积
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, up ? 'rgba(240,75,75,.18)' : 'rgba(18,184,134,.18)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.beginPath();
  ctx.moveTo(x(0), y(series[0]));
  for (let i = 1; i < series.length; i++) ctx.lineTo(x(i), y(series[i]));
  ctx.lineTo(x(series.length - 1), h - pad);
  ctx.lineTo(x(0), h - pad);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // 折线
  ctx.beginPath();
  ctx.moveTo(x(0), y(series[0]));
  for (let i = 1; i < series.length; i++) ctx.lineTo(x(i), y(series[i]));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // 最新价圆点
  const lastX = x(series.length - 1);
  const lastY = y(series[series.length - 1]);
  ctx.beginPath();
  ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

// ---------- 交互 ----------
function switchTab(name) {
  state.tab = name;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
  if (name === 'market') requestAnimationFrame(() => drawChart(state.data?.stock?.series));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function refresh() {
  const d = await api('/api/tour');
  state.data = d;
  render();
  return d;
}

async function doOpen() {
  if (state.busy) return;
  const qty = Math.floor(Number($('#qty').value) || 0);
  if (!(qty > 0)) { toast('先填数量', 'err'); return; }
  state.busy = true;
  render();
  try {
    const r = await api('/api/tour/order', {
      method: 'POST',
      body: JSON.stringify({ action: 'open', side: state.side, qty, leverage: state.lev })
    });
    state.data = r.state;
    toast(`成交：${state.side === 'long' ? '做多' : '做空'} ${qty.toLocaleString('en-US')} 份 @${price2(r.price)}`);
    render();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    state.busy = false;
    render();
  }
}

async function doClose() {
  if (state.busy) return;
  const me = state.data?.me;
  if (!me || !me.position) return;
  state.busy = true;
  render();
  try {
    const r = await api('/api/tour/order', {
      method: 'POST',
      body: JSON.stringify({ action: 'close' })
    });
    state.data = r.state;
    const pnl = Number(r.pnl) || 0;
    toast(`平仓 ${pnl >= 0 ? '盈利' : '亏损'} ${money(Math.abs(pnl))}`, pnl >= 0 ? 'ok' : 'err');
    render();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    state.busy = false;
    render();
  }
}

async function doJob() {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    const r = await api('/api/tour/job', { method: 'POST' });
    state.data = r.state;
    toast(`打工完成，现金 +${money(r.gained)}`);
    render();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    state.busy = false;
    render();
  }
}

function syncTopHeight() {
  const h = $('.top')?.offsetHeight || 51;
  document.documentElement.style.setProperty('--topH', h + 'px');
}

function bind() {
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (b) switchTab(b.dataset.tab);
  });
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]');
    if (g) switchTab(g.dataset.goto);
  });

  $('#sideSeg').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    state.side = b.dataset.side;
    $$('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    state.qtyManual = false;
    render();
  });

  $('#lev').addEventListener('input', (e) => {
    state.lev = Math.max(1, Math.min(maxLev(), Number(e.target.value) || 1));
    $('#levVal').textContent = state.lev;
    state.qtyManual = false;
    render();
  });

  $('#qty').addEventListener('input', () => {
    state.qtyManual = true;
    render();
  });

  $('#frac').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-frac]');
    if (!b) return;
    const d = state.data;
    if (!d || !d.me) { toast('先登录', 'err'); return; }
    const price = Number(d.stock.price) || 0;
    const perUnit = price * (1 / state.lev + (Number(d.feeRate) || 0));
    const max = perUnit > 0 ? Math.floor((d.me.cash * 0.995) / perUnit) : 0;
    const frac = Number(b.dataset.frac) || 1;
    $('#qty').value = Math.max(0, Math.floor(max * frac));
    state.qtyManual = true;
    render();
  });

  $('#openBtn').addEventListener('click', doOpen);
  $('#closeBtn').addEventListener('click', doClose);
  $('#jobBtn').addEventListener('click', doJob);

  window.addEventListener('resize', () => {
    syncTopHeight();
    drawChart(state.data?.stock?.series);
  });
}

async function boot() {
  bind();
  syncTopHeight();
  const levEl = $('#lev');
  if (levEl) {
    levEl.max = String(maxLev());
    levEl.value = String(state.lev);
  }
  $('#levVal').textContent = state.lev;

  if (!state.token) {
    $('#gate').classList.add('show');
  }

  await load();
  if (state.token && state.data && !state.data.me) {
    // token 过期：清掉，免得一直 401
    state.token = '';
    localStorage.removeItem(TOKEN_KEY);
    $('#gate').classList.add('show');
  }

  // 秒表 + 轮询
  state.timer = setInterval(() => {
    if (state.data) renderClock();
  }, 1000);
  setInterval(() => {
    if (!document.hidden) load();
  }, 2000);
}

boot();
