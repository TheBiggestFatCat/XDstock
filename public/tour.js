// 锦标赛前端（原生 ES Module，零依赖）

const TOKEN_KEY = 'xd_token';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  data: null,
  tab: 'home',
  mode: 'open',        // 开仓 / 平仓
  side: 'long',
  lev: 20,
  ttab: 'order',       // 下单 / 成交记录
  tf: 1,               // K 线周期（分钟）
  bars: [],            // 当前周期的 K 线（后端 /api/tour/candles 给的 OHLC）
  barsTf: '',          // state.bars 属于哪个周期，切周期时据此判定要不要先清空
  barsChg: 0,          // 后端算的该周期涨跌幅（K 线还没回来时的兜底）
  barsAt: 0,           // 上次拉到 K 线的时间（毫秒）
  ma: { 5: true, 10: true, 30: false },
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

/** 报价 3 位小数，跟 AUD/JPY 的零售报价对齐（109.018） */
function price3(v) {
  return (Number(v) || 0).toFixed(3);
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

/** 涨跌配色：0 用灰色，避免「0.000% 却是红的」（3 位小数，阈值同步收到 0.0005） */
function chgClass(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) < 0.0005) return 'chg muted';
  return n > 0 ? 'chg up' : 'chg down';
}

/** 当前周期最后一根 K 线的涨跌幅：和图上那根、悬停读数完全同一个口径 */
function lastBarChg(bars) {
  if (!Array.isArray(bars) || bars.length < 2) return null;
  const prev = Number(bars[bars.length - 2].close) || 0;
  const last = Number(bars[bars.length - 1].close) || 0;
  if (!(prev > 0)) return null;
  return ((last - prev) / prev) * 100;
}

/** 主站那套 up / down / flat 三态（.big-price、表格里用） */
function cls(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) < 1e-9) return 'flat';
  return n > 0 ? 'up' : 'down';
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

function tfKey() {
  return `${state.tf}m`;
}

let candlesSeq = 0;
/** 拉某个周期的 K 线：历史包 + 实时聚合都在后端算好，前端只画 */
async function loadCandles(reset = false) {
  const tf = tfKey();
  const seq = ++candlesSeq;
  try {
    const r = await api(`/api/tour/candles?tf=${tf}`);
    if (seq !== candlesSeq) return;      // 连点周期，丢掉过期的响应
    if (tf !== tfKey()) return;
    state.bars = Array.isArray(r.candles) ? r.candles : [];
    state.barsTf = tf;
    state.barsAt = Date.now();
    state.barsChg = Number(r.changePct) || 0;
    drawChart(state.bars, reset);
  } catch (e) {
    console.error('[tour] K 线拉取失败', e);
  }
}

/**
 * 每 2 秒只拉一次快照，里面不带 K 线；用最新价把最后一根补上，
 * 这样整根图不用为每个 tick 重新请求，10 秒左右再整包对齐一次。
 */
function patchLastBar(price) {
  const px = Number(price) || 0;
  const bars = state.bars;
  if (!(px > 0) || !Array.isArray(bars) || !bars.length) return;
  const last = bars[bars.length - 1];
  if (px > last.high) last.high = px;
  if (px < last.low) last.low = px;
  last.close = px;
}

// ---------- 渲染 ----------
function render() {
  const d = state.data;
  if (!d) return;
  const me = d.me;
  const status = d.status;

  // 顶栏
  const chip = $('#topStatus');
  // 休市中沿用「筹备中」那颗琥珀色 chip（灰底也行，只是状态一眼能分开）
  chip.className = 'chip ' + (status === 'ended' ? 'chip-ended' : status === 'running' ? 'chip-live' : 'chip-pending');
  chip.textContent = status === 'ended' ? '已结束'
    : status === 'running' ? '进行中'
      : status === 'closed' ? '休市中' : '筹备中';
  $('#topCount').textContent = `${d.players} 人参赛`;

  // 状态卡
  $('#statusText').textContent = status === 'ended'
    ? '冠军已产生，行情冻结'
    : status === 'closed'
      ? '休市中，暂停交易'
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
    $('#jobNote').textContent = status === 'ended'
      ? '赛区已冻结'
      : status === 'closed' ? '休市中，暂停打工' : '开赛后才能打工';
  } else if (me.cash >= d.startCash) {
    $('#jobNote').textContent = `现金 ${money(me.cash)}，已经够 30 万，不用打工`;
  } else {
    $('#jobNote').textContent = `现金只剩 ${money(me.cash)}，打一次工补齐到 ${money(d.startCash)}（第 ${me.jobs + 1} 次）`;
  }

  // 涨跌幅：跟「玩家所选周期最后一根 K 线」完全一致（悬停最后一根看到的也是这个数）；
  // K 线还没拉回来时退回后端按 1 分钟算的值
  const chgV = lastBarChg(state.bars)
    ?? (state.barsTf === tfKey() && Number.isFinite(Number(state.barsChg))
      ? Number(state.barsChg)
      : Number(d.stock.changePct) || 0);

  // 首页标的
  const px = Number(d.stock.price) || 0;
  $('#homePrice').textContent = px > 0 ? price3(px) : '--';
  const chg = $('#homeChg');
  chg.textContent = px > 0 ? pct(chgV, 3) : '';
  chg.className = 'tiny ' + chgClass(chgV);

  // 行情头
  $('#chartPrice').textContent = px > 0 ? price3(px) : '—';
  $('#chartPrice').className = 'big-price ' + cls(chgV);
  const mchg = $('#chartChange');
  mchg.textContent = px > 0 ? pct(chgV, 3) : '—';
  mchg.className = 'big-change ' + cls(chgV);
  // 价格就是汇率，不再重复显示一遍数字；这里只标数据来自哪儿
  const src = String(d.stock.fxSource || '');
  const srcName = src === 'swissquote' ? 'Swissquote' : src === 'fxratesapi' ? 'fxratesapi' : '';
  $('#fxSource').textContent = px > 0 ? (srcName || '已接上') : '连接中';
  $('#frozenTag').textContent = status === 'ended'
    ? '行情已冻结'
    : status === 'closed'
      ? '休市中'
      : status === 'running'
        ? (d.stock.fxStale ? '汇率更新中断' : '行情实时')
        : (px > 0 ? '赛前走势' : '连接汇率中');
  // K 线走独立接口，这里只把最新价补到最后一根上
  patchLastBar(px);
  drawChart(state.bars);

  // 交易面板
  renderTrade(me, status);
  renderTradeLog(me);

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
  renderPositionsTable(me, status);
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
  } else if (d.status === 'closed') {
    // 休市不是结束：轮次不涨、价格不动，管理员恢复后从这一轮接着跑
    clock.textContent = `第 ${d.tick} 轮`;
    hint.textContent = '休市中 · 行情与交易已暂停';
  } else {
    clock.textContent = d.winner ? d.winner.nickname : '已结束';
    hint.textContent = d.winner
      ? `冠军权益 ${money(d.winner.equity)} · 第 ${d.winner.tick} 轮达成`
      : '赛区已冻结';
  }
}

/** 杠杆越低越绿、越高越红：滑条和数字同色，一眼看出自己开了多大 */
function levColor(lev, levMax) {
  const t = levMax > 1 ? (lev - 1) / (levMax - 1) : 0;
  if (t < 0.25) return '#16a34a';
  if (t < 0.5) return '#84cc16';
  if (t < 0.7) return '#eab308';
  if (t < 0.9) return '#f97316';
  return '#dc2626';
}

function renderTrade(me, status) {
  const d = state.data;
  const price = Number(d.stock.price) || 0;
  const cash = me ? Number(me.cash) || 0 : 0;
  const levMax = maxLev();
  if (state.lev > levMax) state.lev = levMax;   // 后端调低上限时别让滑条越界
  const lev = state.lev;
  const pos = me ? me.position : null;

  // 开仓 / 平仓
  const isClose = state.mode === 'close';
  $$('#modeSwitch .mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  $('#openFields').classList.toggle('hidden', isClose);
  $('#closeInfo').classList.toggle('hidden', !isClose);

  // 做多 / 做空
  $$('#sideSwitch .side-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.side === state.side);
  });

  // 杠杆：标签、滑条填充、档位色
  const levEl = $('#orderLev');
  if (levEl) {
    if (Number(levEl.max) !== levMax) levEl.max = String(levMax);
    if (Number(levEl.value) !== lev) levEl.value = String(lev);
    levEl.style.setProperty('--lev-color', levColor(lev, levMax));
  }
  const levLabel = $('#levLabel');
  levLabel.textContent = lev + 'x';
  levLabel.style.color = levColor(lev, levMax);
  $('#levHint').textContent = `（1~${levMax} 倍）`;

  // 可开数量：只有保证金占款，零手续费
  const perUnit = price / lev;
  const maxQty = perUnit > 0 ? Math.floor(cash / perUnit) : 0;
  const qtyEl = $('#orderQty');
  // 默认给 1/4 仓，别一进来就是满仓满杠杆
  if (!state.qtyManual) qtyEl.value = maxQty > 0 ? Math.floor(maxQty * 0.25) : 0;
  const typed = Math.floor(Number(qtyEl.value) || 0);
  const qty = maxQty > 0 ? Math.min(typed, maxQty) : typed;

  const notional = qty * price;
  const margin = lev > 0 ? notional / lev : 0;
  $('#costNotional').textContent = money2(notional);
  $('#costMargin').textContent = money2(margin);

  // 保证金亏到 5% 就强平：价格逆向走 0.95 / 杠杆。1000 倍下只有 0.095%，必须让玩家看见
  const liqMove = 0.95 / Math.max(1, lev);
  const liqPx = state.side === 'long' ? price * (1 - liqMove) : price * (1 + liqMove);
  $('#costLiq').textContent = price > 0 ? price3(liqPx) : '—';

  // 平仓区：这一仓现在到底值多少
  if (pos) {
    const roe = pos.margin > 0 ? (pos.pnl / pos.margin) * 100 : 0;
    $('#closeSide').textContent = `${pos.side === 'long' ? '多单' : '空单'} · ${pos.leverage}×`;
    $('#closeSide').className = pos.side === 'long' ? 'up' : 'down';
    $('#closeQty').textContent = `${pos.qty.toLocaleString('en-US')} 份`;
    $('#closeEntry').textContent = price3(pos.entry);
    const pnlEl = $('#closePnl');
    pnlEl.textContent = `${pos.pnl >= 0 ? '+' : '-'}${money(Math.abs(pos.pnl))}（${pct(roe)}）`;
    pnlEl.className = pos.pnl >= 0 ? 'up' : 'down';
  } else {
    $('#closeSide').textContent = '—';
    $('#closeSide').className = '';
    $('#closeQty').textContent = '—';
    $('#closeEntry').textContent = '—';
    const pnlEl = $('#closePnl');
    pnlEl.textContent = '—';
    pnlEl.className = '';
  }

  // 下单按钮
  const btn = $('#orderBtn');
  const canTrade = !!me && status === 'running' && !state.busy;
  if (isClose) {
    btn.textContent = pos
      ? (pos.side === 'long' ? '市价平多' : '市价平空')
      : '没有持仓可平';
    btn.disabled = !canTrade || !pos;
  } else {
    btn.textContent = state.side === 'long' ? '市价开多' : '市价开空';
    btn.disabled = !canTrade || !(qty > 0) || margin > cash + 1e-6;
  }

  // 说明文字
  const note = [];
  if (!state.token) note.push('先登录才能下单');
  if (status === 'pending') note.push('开赛前只能看，不能下单');
  if (status === 'ended') note.push('赛区已冻结，无法交易');
  if (status === 'closed') note.push('休市中，暂停交易');
  if (me && pos && !isClose) {
    note.push(pos.side === state.side
      ? '已有同向持仓，再开是加仓'
      : '手上有反向持仓，先平掉才能反手');
  }
  if (me && me.liquidations > 0) note.push(`已爆仓 ${me.liquidations} 次`);
  if (!isClose && price > 0 && maxQty <= 0 && me) note.push('现金不够开一仓，去打工');
  $('#orderHint').textContent = note.join(' · ');
}

/** 成交记录（下单栏第二页） */
function renderTradeLog(me) {
  const box = $('#stockTradeList');
  if (!me || !me.log || !me.log.length) {
    box.innerHTML = '<p class="st-hint">还没有成交，去下单试试</p>';
    return;
  }
  const label = { open: '开仓', close: '平仓', liquidate: '强平' };
  box.innerHTML = me.log.map((r) => {
    const isLiq = r.action === 'liquidate';
    const sideCls = isLiq ? 'liq' : (r.action === 'open'
      ? (r.side === 'short' ? 'sell' : 'buy')
      : (r.side === 'short' ? 'buy' : 'sell'));
    const pnl = Number(r.pnl);
    const hasPnl = r.action !== 'open' && Number.isFinite(pnl);
    const at = new Date(Number(r.at) || 0);
    return `<div class="st-row">
      <span class="st-side ${sideCls}">${label[r.action] || r.action}</span>
      <span class="st-main">${r.side === 'short' ? '空' : '多'} ${Number(r.qty).toLocaleString('en-US')} 份 @${price3(r.price)}</span>
      <span class="st-time">${pad2(at.getHours())}:${pad2(at.getMinutes())}</span>
      <span class="st-pnl ${hasPnl ? (pnl >= 0 ? 'up' : 'down') : 'flat'}">
        ${hasPnl ? (pnl >= 0 ? '+' : '-') + money(Math.abs(pnl)) : '—'}
      </span>
    </div>`;
  }).join('');
}

/** 行情页下方的持仓表（主站同款表格） */
function renderPositionsTable(me, status) {
  const wrap = $('#positionsTable');
  if (!wrap) return;
  const pos = me ? me.position : null;
  const cash = me ? Number(me.cash) || 0 : 0;
  const price = Number(state.data?.stock?.price) || 0;

  $('#posSub').textContent = status === 'ended'
    ? '赛区已冻结'
    : status === 'closed'
      ? '休市中'
      : pos ? `持仓中 · ${pos.leverage}×` : '空仓';

  const cashRow = `<tr class="cash-row" data-cash><td colspan="9">💵 现金 <b>${money(cash)}</b><span class="cash-sub">可随时用于开仓</span></td></tr>`;

  if (!pos) {
    wrap.innerHTML = `<table><tbody>
      <tr class="empty-row"><td>还没有持仓，去上面开一仓</td></tr>
      ${cashRow}
    </tbody></table>`;
    return;
  }

  const lev = pos.leverage || 1;
  const liq = pos.side === 'long' ? pos.entry * (1 - 0.95 / lev) : pos.entry * (1 + 0.95 / lev);
  const roe = pos.margin > 0 ? (pos.pnl / pos.margin) * 100 : 0;
  wrap.innerHTML = `<table>
    <thead><tr>
      <th>标的</th><th>方向</th><th>数量</th><th>杠杆</th><th>成本</th>
      <th>现价</th><th>浮动盈亏</th><th>保证金</th><th>爆仓价</th>
    </tr></thead>
    <tbody>
      <tr>
        <td><img class="stock-icon-sm" src="/assets/stocks/LMFX.jpeg" alt="" />留美外汇 <span class="code">LMFX</span></td>
        <td><span class="pill ${pos.side}">${pos.side === 'long' ? '多' : '空'}</span></td>
        <td>${pos.qty.toLocaleString('en-US')}</td>
        <td>${lev.toFixed(1)}x</td>
        <td>${price3(pos.entry)}</td>
        <td>${price > 0 ? price3(price) : '—'}</td>
        <td><span class="${cls(pos.pnl)}">${pos.pnl >= 0 ? '+' : '-'}${money(Math.abs(pos.pnl))} <small>(${pct(roe)})</small></span></td>
        <td>${money(pos.margin)}</td>
        <td class="down">${price3(liq)}</td>
      </tr>
      ${cashRow}
    </tbody>
  </table>`;
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
      <span>均价 <b>${price3(p.entry)}</b></span>
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
      <span class="mono">${side} ${Number(r.qty).toLocaleString('en-US')} @${price3(r.price)}</span>
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
    const clsName = ['rank-row'];
    if (r.id === meId) clsName.push('me');
    if (r.rank === 1) clsName.push('top1');
    if (r.rank === 2) clsName.push('top2');
    if (r.rank === 3) clsName.push('top3');
    const isWinner = d.winner && d.winner.id === r.id;
    return `<div class="${clsName.join(' ')}">
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

// ---------- 走势图（与主站同一套 lightweight-charts 样式）----------
// K 线由后端 /api/tour/candles 直接给（历史包 + 实时聚合），根数照抄主站：300/300/192
const MA_DEFS = [
  { n: 5, color: '#f59e0b' },
  { n: 10, color: '#3b82f6' },
  { n: 30, color: '#a855f7' }
];

let chart = null;
let candle = null;
const maSeries = {};
// 视野只自动定一次（首绘/切 tab/换周期），之后交给用户拖；
// 否则每 5 秒一次的重绘会把刚拖到的位置又拉回去
let viewFitted = false;

function p2(n) {
  return String(n).padStart(2, '0');
}

/** 手指操作（手机/平板）：十字光标抬手就收，读数要留着 */
function coarsePointer() {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return window.innerWidth < 760;
  }
}

/** 时间轴标签：HH:MM */
function hmLabel(sec) {
  const d = new Date(sec * 1000);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function ensureChart() {
  const el = $('#chart');
  if (!el || chart) return chart;
  if (typeof LightweightCharts === 'undefined') return null;
  // 容器还没布局（比如当前停在首页 tab）就等下一次 render 再建
  if (!el.clientWidth) return null;
  chart = LightweightCharts.createChart(el, {
    localization: { timeFormatter: (t) => hmLabel(t) },
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: '#5b7671',
      fontFamily: 'inherit',
      attributionLogo: false
    },
    grid: {
      vertLines: { color: 'rgba(230,240,237,.7)' },
      horzLines: { color: 'rgba(230,240,237,.7)' }
    },
    rightPriceScale: { borderColor: 'rgba(230,240,237,.9)' },
    timeScale: {
      borderColor: 'rgba(230,240,237,.9)',
      timeVisible: true,
      secondsVisible: false,
      tickMarkFormatter: (t) => hmLabel(t)
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: 'rgba(20,184,166,.4)', labelBackgroundColor: '#14b8a6' },
      horzLine: { color: 'rgba(20,184,166,.4)', labelBackgroundColor: '#14b8a6' }
    },
    // 主站没写这段（默认全开）；这里显式打开：刻度可拖、手机单指横拖看历史。
    // vertTouchDrag 平时关着，手指落在图上竖滑照样滚页面（见下方价格轴特判）
    handleScale: { axisPressedMouseMove: { time: true, price: true }, pinch: true },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false
    },
    // 手机上松手后惯性滑一段，和原生列表手感一致
    kineticScroll: { touch: true, mouse: false },
    autoSize: true
  });
  candle = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: '#f04b4b',
    downColor: '#0d9caa',
    borderVisible: false,
    wickUpColor: '#f04b4b',
    wickDownColor: '#0d9caa',
    priceFormat: { type: 'price', precision: 3, minMove: 0.001 }
  });
  // 均线：主站那三根，颜色照抄
  for (const m of MA_DEFS) {
    maSeries[m.n] = chart.addSeries(LightweightCharts.LineSeries, {
      color: m.color,
      lineWidth: 1.5,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false
    });
  }
  // 指到某根 K 线时在图上方显示这根的开高低收
  bindHover(chart);
  // 右侧价格刻度：触摸下只有开着 vertTouchDrag 才拖得动（库的既有行为），
  // 但全局开它，手指落在图上竖滑就滚不动页面了。
  // 折中：按下点落在刻度条上时临时打开，抬手（rAF 后，别抢库自己的 touchend）再关回去
  const setVertDrag = (on) => {
    chart.applyOptions({
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: on }
    });
  };
  let onAxis = false;
  const inAxis = (t) => {
    if (!t) return false;
    const w = chart.priceScale('right').width();
    if (!(w > 0)) return false;
    return t.clientX >= el.getBoundingClientRect().right - w - 6;
  };
  el.addEventListener(
    'touchstart',
    (e) => {
      if (onAxis || !inAxis(e.touches[0])) return;
      onAxis = true;
      setVertDrag(true);
    },
    { capture: true, passive: true }
  );
  const axisEnd = () => {
    if (!onAxis) return;
    requestAnimationFrame(() => {
      if (!onAxis) return;
      onAxis = false;
      setVertDrag(false);
    });
  };
  el.addEventListener('touchend', axisEnd, { capture: true, passive: true });
  el.addEventListener('touchcancel', axisEnd, { capture: true, passive: true });
  return chart;
}

/** 十字光标读数：指到哪根 K 线就显示哪根的开高低收，和主站一模一样 */
function bindHover(c) {
  if (!c || c.__hoverBound) return;
  c.__hoverBound = true;
  c.subscribeCrosshairMove((param) => {
    const box = $('#hoverInfo');
    if (!box) return;
    const bars = state.bars;
    const bar = param && param.time && param.point && param.seriesData
      ? param.seriesData.get(candle)
      : null;
    if (!bar || !Array.isArray(bars) || !bars.length) {
      // 手机上抬手后库会把十字光标收掉，读数留着，方便看完这根再继续滑；
      // 桌面鼠标移出图就清空，和主站一致
      if (!coarsePointer()) box.innerHTML = '';
      return;
    }
    let idx = -1;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].time === param.time) { idx = i; break; }
    }
    const prevClose = idx > 0 ? bars[idx - 1].close : bar.open;
    const chg = prevClose ? ((bar.close - prevClose) / prevClose) * 100 : 0;
    const amp = prevClose ? ((bar.high - bar.low) / prevClose) * 100 : 0;
    const cls = chg > 0 ? 'up' : chg < 0 ? 'down' : 'flat';
    const d = new Date(param.time * 1000);
    const sameDay = new Date().toDateString() === d.toDateString();
    const when = sameDay
      ? `${p2(d.getHours())}:${p2(d.getMinutes())}`
      : `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    // 汇率的日内波动比股票小两个数量级，涨跌幅/振幅给到 3 位小数才看得出差别
    box.innerHTML = `
      <span class="hi-time">${when}</span>
      <span>开 <b>${price3(bar.open)}</b></span>
      <span>高 <b class="up">${price3(bar.high)}</b></span>
      <span>低 <b class="down">${price3(bar.low)}</b></span>
      <span>收 <b>${price3(bar.close)}</b></span>
      <span class="hi-chg ${cls}">${chg >= 0 ? '+' : ''}${chg.toFixed(3)}%</span>
      <span class="hi-amp">振幅 ${amp.toFixed(3)}%</span>`;
  });
}

/** 5 秒一个的报价点 → 指定周期的 OHLC 现在由后端算（/api/tour/candles），
 *  前端只负责画图和算均线 —— 条数和主站一致，见 TOUR_TFS */

/** 均线点：不足周期就不出点，别从第 1 根就开始画 */
function maLine(bars, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= n) sum -= bars[i - n].close;
    if (i >= n - 1) out.push({ time: bars[i].time, value: sum / n });
  }
  return out;
}

function drawChart(bars, reset = false) {
  const hint = $('#chartHint');
  const list = Array.isArray(bars) ? bars : [];
  // 换周期 / 切 tab 时把读数清掉，别留着上一个周期的数字
  if (reset) {
    const box = $('#hoverInfo');
    if (box) box.innerHTML = '';
  }
  // 一根 K 线画面没意义，继续显示提示。
  // 注意得先把图清空：否则切到 5 分/15 分时会留着上一个周期的柱子，
  // 提示文字叠在旧 K 线上，看起来像卡住了。
  if (list.length < 2) {
    // 数据被清空了，等下次拉回来再重新定视野
    viewFitted = false;
    if (candle) {
      candle.setData([]);
      for (const m of MA_DEFS) maSeries[m.n]?.setData([]);
    }
    if (hint) {
      hint.classList.remove('hidden');
      hint.textContent = list.length ? '正在攒第一根 K 线…' : '正在连接实时汇率…';
    }
    return;
  }
  if (hint) hint.classList.add('hidden');
  const c = ensureChart();
  if (!c || !candle) return;
  candle.setData(list);
  for (const m of MA_DEFS) {
    const s = maSeries[m.n];
    if (s) s.setData(state.ma[m.n] ? maLine(list, m.n) : []);
  }
  // 数据还没铺满一屏时手动定视野（默认从「最新一根往前 80 根」开始，左边空一大块）；
  // 左右各留一点空，最后一根不贴边，价格轴上的现价标签和时间轴刻度才不被裁。
  // 只在首绘 / 切 tab / 换周期时定一次：定时重绘不再覆盖用户拖出来的视野
  if (reset || !viewFitted) {
    const el = $('#chart');
    const visible = Math.max(1, (el?.clientWidth || 0) - 60);
    if (list.length * 6 < visible) {
      c.timeScale().setVisibleLogicalRange({ from: -0.5, to: list.length + 1.5 });
    } else {
      c.timeScale().fitContent();
    }
    viewFitted = true;
  }
}

// ---------- 交互 ----------
function switchTab(name) {
  state.tab = name;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
  // 图表容器在隐藏的 tab 里没有宽度，建不出来；切过来时再建图 + 拉一次 K 线
  if (name === 'market') {
    requestAnimationFrame(() => {
      viewFitted = false;
      drawChart(state.bars, true);
      loadCandles(true);
    });
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function refresh() {
  const d = await api('/api/tour');
  state.data = d;
  render();
  return d;
}

function setMode(mode) {
  state.mode = mode;
  render();
}

async function doOrder() {
  if (state.busy) return;
  const msg = $('#orderMsg');
  msg.textContent = '';
  state.busy = true;
  render();
  try {
    if (state.mode === 'close') {
      const r = await api('/api/tour/order', {
        method: 'POST',
        body: JSON.stringify({ action: 'close' })
      });
      state.data = r.state;
      const pnl = Number(r.pnl) || 0;
      toast(`平仓 ${pnl >= 0 ? '盈利' : '亏损'} ${money(Math.abs(pnl))}`, pnl >= 0 ? 'ok' : 'err');
    } else {
      const qty = Math.floor(Number($('#orderQty').value) || 0);
      if (!(qty > 0)) { throw new Error('先填数量'); }
      const r = await api('/api/tour/order', {
        method: 'POST',
        body: JSON.stringify({ action: 'open', side: state.side, qty, leverage: state.lev })
      });
      state.data = r.state;
      toast(`成交：${state.side === 'long' ? '做多' : '做空'} ${qty.toLocaleString('en-US')} 份 @${price3(r.price)}`);
    }
    state.qtyManual = false;
    render();
  } catch (e) {
    msg.textContent = e.message;
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

  // 下单 / 成交记录
  $('#tradeTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.trade-tab');
    if (!b) return;
    state.ttab = b.dataset.ttab;
    $$('#tradeTabs .trade-tab').forEach((x) => x.classList.toggle('active', x === b));
    $('#orderPane').classList.toggle('hidden', state.ttab !== 'order');
    $('#logPane').classList.toggle('hidden', state.ttab !== 'log');
  });

  // 开仓 / 平仓
  $('#modeSwitch').addEventListener('click', (e) => {
    const b = e.target.closest('.mode-btn');
    if (b) setMode(b.dataset.mode);
  });

  // 做多 / 做空（平仓模式下方向由持仓决定，点了不生效）
  $('#sideSwitch').addEventListener('click', (e) => {
    const b = e.target.closest('.side-btn');
    if (!b) return;
    if (state.mode === 'close') return;
    state.side = b.dataset.side;
    state.qtyManual = false;
    render();
  });

  $('#orderLev').addEventListener('input', (e) => {
    state.lev = Math.max(1, Math.min(maxLev(), Number(e.target.value) || 1));
    state.qtyManual = false;
    render();
  });

  // 1~1000 的滑条太难精确拖到中间档，给几个常用值
  $('#levQuick').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-lev]');
    if (!b) return;
    state.lev = Math.max(1, Math.min(maxLev(), Number(b.dataset.lev) || 1));
    state.qtyManual = false;
    render();
  });

  $('#orderQty').addEventListener('input', () => {
    state.qtyManual = true;
    render();
  });

  $('#quickQty').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-frac]');
    if (!b) return;
    const d = state.data;
    if (!d || !d.me) { toast('先登录', 'err'); return; }
    const price = Number(d.stock.price) || 0;
    const perUnit = price / state.lev;
    const max = perUnit > 0 ? Math.floor(d.me.cash / perUnit) : 0;
    const frac = Number(b.dataset.frac) || 1;
    $('#orderQty').value = String(Math.max(0, Math.floor(max * frac)));
    state.qtyManual = true;
    render();
  });

  $('#orderBtn').addEventListener('click', doOrder);
  $('#jobBtn').addEventListener('click', doJob);

  // K 线周期
  $('#tfGroup').addEventListener('click', (e) => {
    const b = e.target.closest('.tf');
    if (!b) return;
    state.tf = Math.max(1, Number(b.dataset.tf) || 1);
    $$('#tfGroup .tf').forEach((x) => x.classList.toggle('active', x === b));
    // 先把上一个周期的柱子清掉，别让新周期的提示叠在旧图上
    state.bars = [];
    state.barsTf = '';
    state.barsChg = 0;
    drawChart(state.bars, true);
    loadCandles(true);
  });

  // 均线开关
  $('#maGroup').addEventListener('change', (e) => {
    const inp = e.target.closest('input[data-ma]');
    if (!inp) return;
    state.ma[Number(inp.dataset.ma)] = inp.checked;
    drawChart(state.bars);
  });

  window.addEventListener('resize', () => {
    syncTopHeight();
    drawChart(state.bars);
  });
}

async function boot() {
  bind();
  syncTopHeight();

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
    // 行情 tab 上每 10 秒把 K 线整包对齐一次（其余时间靠 patchLastBar 打补丁）
    if (!document.hidden && state.tab === 'market' && Date.now() - state.barsAt > 10000) loadCandles();
  }, 2000);
}

boot();
