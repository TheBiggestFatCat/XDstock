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

/** 涨跌配色：0 用灰色，避免「0.00% 却是红的」 */
function chgClass(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) < 0.005) return 'chg muted';
  return n > 0 ? 'chg up' : 'chg down';
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
  const px = Number(d.stock.price) || 0;
  $('#homePrice').textContent = px > 0 ? price3(px) : '--';
  const chg = $('#homeChg');
  chg.textContent = px > 0 ? pct(d.stock.changePct, 2) : '';
  chg.className = 'tiny ' + chgClass(d.stock.changePct);

  // 行情头
  $('#chartPrice').textContent = px > 0 ? price3(px) : '—';
  $('#chartPrice').className = 'big-price ' + cls(d.stock.changePct);
  const mchg = $('#chartChange');
  mchg.textContent = px > 0 ? pct(d.stock.changePct, 2) : '—';
  mchg.className = 'big-change ' + cls(d.stock.changePct);
  // 价格就是汇率，不再重复显示一遍数字；这里只标数据来自哪儿
  const src = String(d.stock.fxSource || '');
  const srcName = src === 'swissquote' ? 'Swissquote' : src === 'fxratesapi' ? 'fxratesapi' : '';
  $('#fxSource').textContent = px > 0 ? (srcName || '已接上') : '连接中';
  $('#frozenTag').textContent = status === 'ended'
    ? '行情已冻结'
    : status === 'running'
      ? (d.stock.fxStale ? '汇率更新中断' : '行情实时')
      : (px > 0 ? '赛前走势' : '连接汇率中');
  drawChart(d.stock.series, d.stock.seriesAt);

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
// 一根 K 线 = 12 个 tick ≈ 1 分钟，和主站 1m 周期同口径；5分/15分由它再合并
const KLINE_POINTS = 12;
const MA_DEFS = [
  { n: 5, color: '#f59e0b' },
  { n: 10, color: '#3b82f6' },
  { n: 30, color: '#a855f7' }
];

let chart = null;
let candle = null;
const maSeries = {};

function p2(n) {
  return String(n).padStart(2, '0');
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
    handleScale: { axisPressedMouseMove: true },
    // 手机上图表只有一屏高的一部分，手指几乎避不开：别让它抢走页面的滑动
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: window.innerWidth >= 760,
      vertTouchDrag: false
    },
    autoSize: true
  });
  candle = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: '#f04b4b',
    downColor: '#12b886',
    borderVisible: false,
    wickUpColor: '#f04b4b',
    wickDownColor: '#12b886',
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
  return chart;
}

/** 5 秒一个的报价点 → 指定周期的 OHLC */
function toCandles(series, seriesAt, tickMs, mult = 1) {
  if (!Array.isArray(series) || !series.length || !Array.isArray(seriesAt)) return [];
  const tf = Math.max(10, Math.round((Number(tickMs) || 5000) / 1000) * KLINE_POINTS * Math.max(1, mult));
  const byTime = new Map();
  const out = [];
  for (let i = 0; i < series.length; i++) {
    const ts = Number(seriesAt[i]);
    const px = Number(series[i]);
    if (!(ts > 0) || !(px > 0)) continue;
    const time = Math.floor(ts / 1000 / tf) * tf;
    let b = byTime.get(time);
    if (!b) {
      b = { time, open: px, high: px, low: px, close: px };
      byTime.set(time, b);
      out.push(b);
    } else {
      if (px > b.high) b.high = px;
      if (px < b.low) b.low = px;
      b.close = px;
    }
  }
  return out;
}

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

function drawChart(series, seriesAt, reset = false) {
  const hint = $('#chartHint');
  const bars = toCandles(series, seriesAt, state.data?.tickMs, state.tf);
  // 一根 K 线画面没意义（还在攒第一根），继续显示提示。
  // 注意得先把图清空：否则切到 5 分/15 分时会留着上一个周期的柱子，
  // 提示文字叠在旧 K 线上，看起来像卡住了。
  if (bars.length < 2) {
    if (candle) {
      candle.setData([]);
      for (const m of MA_DEFS) maSeries[m.n]?.setData([]);
    }
    if (hint) {
      hint.classList.remove('hidden');
      hint.textContent = Array.isArray(series) && series.length
        ? '正在攒第一根 K 线…'
        : '正在连接实时汇率…';
    }
    return;
  }
  if (hint) hint.classList.add('hidden');
  const c = ensureChart();
  if (!c || !candle) return;
  candle.setData(bars);
  for (const m of MA_DEFS) {
    const s = maSeries[m.n];
    if (s) s.setData(state.ma[m.n] ? maLine(bars, m.n) : []);
  }
  // 数据还没铺满一屏时手动定视野（默认从「最新一根往前 80 根」开始，左边空一大块）；
  // 左右各留一点空，最后一根不贴边，价格轴上的现价标签和时间轴刻度才不被裁
  const el = $('#chart');
  const visible = Math.max(1, (el?.clientWidth || 0) - 60);
  if (bars.length * 6 < visible) {
    c.timeScale().setVisibleLogicalRange({ from: -0.5, to: bars.length + 1.5 });
  } else if (reset) {
    c.timeScale().fitContent();
  }
}

// ---------- 交互 ----------
function switchTab(name) {
  state.tab = name;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
  if (name === 'market') requestAnimationFrame(() => drawChart(state.data?.stock?.series, state.data?.stock?.seriesAt, true));
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
    drawChart(state.data?.stock?.series, state.data?.stock?.seriesAt, true);
  });

  // 均线开关
  $('#maGroup').addEventListener('change', (e) => {
    const inp = e.target.closest('input[data-ma]');
    if (!inp) return;
    state.ma[Number(inp.dataset.ma)] = inp.checked;
    drawChart(state.data?.stock?.series, state.data?.stock?.seriesAt);
  });

  window.addEventListener('resize', () => {
    syncTopHeight();
    drawChart(state.data?.stock?.series, state.data?.stock?.seriesAt);
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
  }, 2000);
}

boot();
