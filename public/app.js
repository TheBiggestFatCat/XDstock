// 汐灯证券 · 前端逻辑
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// lightweight-charts 默认按 UTC 显示，这里强制用本地时间
const p2 = (n) => String(n).padStart(2, '0');
function fmtLocalTime(sec, withDate = false) {
  const d = new Date(sec * 1000);
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return withDate ? `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm}` : hm;
}

// K 线周期 → 一根 K 线聚合多少个 tick（必须和 src/config.js 的 TIMEFRAMES 一致）
const TF_SECONDS = { 'tick': 10, '1m': 12, '5m': 60, '15m': 180 };

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
  limitLine: null,
  orderMode: 'open',
  shopDir: 1,
  fakeNewsTargets: [],
  tradeTab: 'order',
  shopTier: 1,
  tickBucket: null,
  tickKey: '',
  eqFitted: false,
  eqLastCount: 0,
  eqLastTime: 0,
  eqLastValue: 0,
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

/** 不带小数点的金额（商城价格用） */
function money0(v) {
  if (!Number.isFinite(v)) return '$0';
  const neg = v < 0;
  const s = Math.abs(Math.round(v)).toLocaleString('en-US');
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
  if (st.changes && Number.isFinite(st.changes[state.tf])) return st.changes[state.tf];
  return Number.isFinite(st.changePct) ? st.changePct : 0;
}

/**
 * 行情列表用的涨跌幅：固定看 1 分钟，
 * 不跟着图表周期变（否则切到「逐 tick」时会显示 5 秒的涨跌，疯狂跳动）
 */
function listChange(st) {
  if (!st) return 0;
  const c = st.changes || {};
  for (const key of ['1m', '5m', '15m']) {
    if (Number.isFinite(c[key])) return c[key];
  }
  return Number.isFinite(st.changePct) ? st.changePct : 0;
}

/** 当前是不是手机宽度 */
function isMobile() {
  return window.matchMedia('(max-width: 760px)').matches;
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
  syncThemeFromServer();
  renderTopbar();
  if ($('#view-shop')?.classList.contains('active')) {
    renderShopTiers();
    renderLevelCard();
    renderRenameHint();
  }
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

  // 等级牌：顶栏每轮都更新，切不切商店都要变
  const lvNow = Math.max(1, Math.floor(Number(m.me?.level) || 1));
  const lvEl = $('#lvBadge');
  if (lvEl) {
    const c = LV_COLORS[Math.min(lvNow - 1, LV_COLORS.length - 1)];
    lvEl.textContent = `Lv.${lvNow}`;
    lvEl.style.setProperty('--lv', c);
  }
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

const ST_DEFAULT_PRICE = 3;

/** 图表上方的 ST / 退市提示条 */
/** 留美外汇专用的汇率信息条 */
function renderChartSub(st) {
  const el = $('#chartSub');
  if (!el) return;
  if (!st || st.trait?.id !== 'fx') {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  const fx = state.market?.fx || {};
  const cfg = state.market?.config || {};
  const rate = Number(fx.rate) || 0;
  const base = Number(fx.base) || rate || 0;
  el.classList.remove('hidden');
  if (!rate) {
    el.innerHTML = '<span class="cs-tag">AUD/JPY</span><b>获取中…</b>';
    return;
  }
  // 相对基准汇率的涨跌幅（股价就是按这个换算的）
  const chg = base > 0 ? (rate / base - 1) * 100 : 0;
  const cls2 = chg > 0 ? 'up' : chg < 0 ? 'down' : 'flat';
  el.innerHTML = `
    <span class="cs-tag">AUD/JPY</span>
    <b>${rate.toFixed(3)}</b>
    <span class="${cls2}" title="相对基准汇率 ${base.toFixed(3)}">${chg >= 0 ? '+' : ''}${chg.toFixed(3)}%</span>`;
}

function fmtMoney(v) {
  const n = Math.abs(v);
  if (n >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
  if (n >= 1e4) return (v / 1e4).toFixed(1) + ' 万';
  return v.toFixed(2);
}

function fmtAgo(ticks, tickMs) {
  const sec = Math.max(0, ticks) * (tickMs / 1000);
  if (sec < 60) return Math.round(sec) + ' 秒';
  const m = Math.floor(sec / 60);
  const s2 = Math.round(sec % 60);
  if (m < 60) return m + ' 分 ' + String(s2).padStart(2, '0') + ' 秒';
  return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
}

function renderReport() {
  const st = state.market?.stocks?.[state.code];
  const panel = $('#reportPanel');
  const nextEl = $('#reportNext');
  const tickMs = state.market?.tickMs || 5000;
  const tick = state.market?.tick || 0;

  const btn = $('#reportBtn');
  const capEl = $('#reportCap');

  if (!st) {
    if (panel) panel.classList.add('hidden');
    if (nextEl) nextEl.textContent = '';
    if (btn) btn.classList.add('hidden');
    if (capEl) capEl.textContent = '';
    return;
  }

  // 指数没有财报，只有成分权重
  if (st.isIndex) {
    // 两个指数各有自己的成分表
    const idx = st.code === 'DENGS'
      ? (state.market?.smallIndex || {})
      : (state.market?.index || {});
    if (btn) {
      btn.classList.remove('hidden');
      btn.textContent = '📊 成分权重';
    }
    if (capEl) capEl.textContent = '';
    const leftRb = (Number(idx.nextRebalanceTick) || 0) - tick;
    // 调仓规则说明，跟着倒计时一起显示
    const rule = st.code === 'DENGS'
      ? '每 3 小时换一次，只留市值最小的 7 家，按市值加权'
      : '每 3 小时重算一次，全市场按市值加权';
    if (nextEl) {
      nextEl.innerHTML = (leftRb > 0
        ? `距下次调仓 <b>${fmtAgo(leftRb, tickMs)}</b>`
        : '<b>即将调仓</b>')
        + `　·　${rule}`;
    }
    if (panel && !panel.classList.contains('hidden')) renderIndexWeights();
    return;
  }

  if (btn) {
    btn.classList.remove('hidden');
    btn.textContent = '📊 财报';
  }
  if (capEl) capEl.textContent = `市值 ${fmtMoney(st.marketCap || 0)}`;

  // 金融大鳄：提前 20 轮看到金融板块财报
  const pv = st.preview;

  const r = st.report || {};
  const left = (Number(st.nextReportTick) || 0) - tick;
  const isTycoonNow = state.market?.me?.theme === 'tycoon';
  const isFinance = ['broker', 'fx'].includes(st.trait?.id)
    || String(st.industry || '').includes('金融');
  if (nextEl) {
    if (left > 0) {
      nextEl.innerHTML = `距下期财报 <b>${fmtAgo(left, tickMs)}</b>`
        + (isTycoonNow && isFinance
          ? `　🐊 ${left > 20 ? `还需 ${left - 20} 轮可预览` : '预览已就绪'}`
          : '');
    } else {
      nextEl.innerHTML = '<b>财报已发布</b>';
    }
  }

  if (!panel || panel.classList.contains('hidden')) return;

  const prem = Number(r.premium) || 0;
  const cls2 = prem > 0 ? 'up' : prem < 0 ? 'down' : 'flat';
  const word = prem > 8 ? '高估' : prem < -8 ? '低估' : '接近合理';
  const g = Number(r.growth) || 0;

  panel.innerHTML = `
    <div class="rp-head">
      <span class="rp-ind">${escapeHtml(r.industry || '')}</span>
      <span class="rp-period">第 ${r.period} 期</span>
      <span class="rp-cap">总市值 <b>${fmtMoney(r.marketCap || 0)}</b></span>
    </div>
    <div class="rp-grid">
      <div><span>营业收入</span><b>${fmtMoney(r.revenue || 0)}</b></div>
      <div><span>净利润</span><b>${fmtMoney(r.netProfit || 0)}</b></div>
      <div><span>同比增速</span><b class="${g >= 0 ? 'up' : 'down'}">${g >= 0 ? '+' : ''}${(g * 100).toFixed(1)}%</b></div>
      <div><span>每股收益</span><b>$${Number(r.eps || 0).toFixed(3)}</b></div>
      <div><span>市盈率 PE</span><b>${Number(r.pe || 0).toFixed(1)}</b></div>
      <div><span>市净率 PB</span><b>${Number(r.pb || 0).toFixed(2)}</b></div>
      <div><span>ROE</span><b>${((r.roe || 0) * 100).toFixed(1)}%</b></div>
      <div><span>资产负债率</span><b>${((r.debt || 0) * 100).toFixed(0)}%</b></div>
    </div>
    ${renderReportChart(r.history)}
    ${(st.preview && state.market?.me?.theme === 'tycoon') ? `
      <div class="preview-box">
        <div class="preview-head">
          <span>🐊 提前看到的财报</span>
          <span>还有 ${st.preview.tickLeft} 轮公布</span>
        </div>
        <div class="preview-grid">
          <div><span>营业收入</span><b>${fmtMoney(st.preview.revenue)}</b></div>
          <div><span>净利润</span><b>${fmtMoney(st.preview.netProfit)}</b></div>
          <div><span>每股收益</span><b>$${Number(st.preview.eps).toFixed(3)}</b></div>
          <div><span>预期变化</span><b class="${st.preview.expectPct >= 0 ? 'up' : 'down'}">${st.preview.expectPct >= 0 ? '+' : ''}${st.preview.expectPct.toFixed(1)}%</b></div>
        </div>
      </div>` : ''}
  `;
}


/** 财报历史折线图（纯 SVG，不依赖图表库） */
function renderReportChart(hist) {
  const list = (hist || []).filter((h) => Number(h.revenue) > 0);
  if (list.length < 2) {
    return '<div class="rc-empty">财报记录还不够，再等一期就能画图了</div>';
  }
  const W = 560;
  const H = 118;
  const padL = 8;
  const padR = 8;
  const padT = 12;
  const padB = 18;
  const iw = W - padL - padR;
  const ih = H - padT - padB;

  const rev = list.map((h) => Number(h.revenue) || 0);
  const npAbs = list.map((h) => Number(h.netProfit) || 0);
  // 第二条线画「净利同比」：本期净利相对上一期的变化率（%）
  const np = npAbs.map((v, i) => {
    if (i === 0) return null;
    const prev = npAbs[i - 1];
    return prev > 0 ? (v / prev - 1) * 100 : 0;
  });

  // 营收和净利量级差太多（几千亿 vs 几百亿），各自拉满，看趋势而不是比大小
  const scaleOf = (arr) => {
    const hi = Math.max(...arr);
    const lo = Math.min(...arr);
    const pad = Math.max(1e-9, (hi - lo) * 0.15);
    return { lo: lo - pad, hi: hi + pad };
  };
  const sRev = scaleOf(rev);
  const npValid = np.filter((v) => v !== null);
  const sNp = scaleOf(npValid.length ? npValid : [0]);

  const x = (i) => padL + (list.length === 1 ? iw / 2 : (i / (list.length - 1)) * iw);
  const yOf = (v, sc) => padT + ih - ((v - sc.lo) / Math.max(1e-9, sc.hi - sc.lo)) * ih;
  const y = (v) => yOf(v, sRev);
  const yNp = (v) => yOf(v, sNp);

  const path = (arr) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${path(rev)} L${x(list.length - 1).toFixed(1)},${(padT + ih).toFixed(1)} L${x(0).toFixed(1)},${(padT + ih).toFixed(1)} Z`;

  const last = list[list.length - 1];
  const first = list[0];
  const revChg = Number(first.revenue) > 0
    ? (Number(last.revenue) / Number(first.revenue) - 1) * 100 : 0;

  const npPath = np
    .map((v, i) => (v === null ? null : `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yNp(v).toFixed(1)}`))
    .filter(Boolean)
    .join(' ')
    .replace(/^L/, 'M');

  const dots = list.map((h, i) => `
    <circle cx="${x(i).toFixed(1)}" cy="${y(Number(h.revenue)).toFixed(1)}" r="2.6" class="rc-dot" />
    ${np[i] === null ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${yNp(np[i]).toFixed(1)}" r="2.2" class="rc-dot np" />`}`).join('');

  return `
    <div class="rc-wrap">
      <div class="rc-head">
        <span class="rc-title">财报趋势 · 共 ${list.length} 期</span>
        <span class="rc-legend">
          <i class="rc-l1"></i>营收
          <i class="rc-l2"></i>净利同比
        </span>
      </div>
      <svg class="rc-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <line x1="${padL}" y1="${padT + ih}" x2="${W - padR}" y2="${padT + ih}" class="rc-axis" />
        <path d="${area}" class="rc-area" />
        <path d="${path(rev)}" class="rc-line" />
        <path d="${npPath}" class="rc-line np" />
        ${dots}
      </svg>
      <div class="rc-foot">
        <span>营收 ${revChg >= 0 ? '+' : ''}${revChg.toFixed(0)}%</span>
        <span>净利同比 ${(np[list.length - 1] ?? 0) >= 0 ? '+' : ''}${(np[list.length - 1] ?? 0).toFixed(1)}%</span>
        <span>营收 ${money0(last.revenue)} · 净利 ${money0(last.netProfit)}</span>
      </div>
    </div>`;
}

function renderIndexWeights() {
  const panel = $('#reportPanel');
  if (!panel) return;
  // 小灯指数看自己的成分表
  const idx = state.code === 'DENGS'
    ? (state.market?.smallIndex || {})
    : (state.market?.index || {});
  const list = idx.weights || [];
  if (!list.length) {
    panel.innerHTML = '<div class="field-hint">还没有权重数据，下一轮生成</div>';
    return;
  }
  panel.innerHTML = `
    <div class="rp-head">
      <span class="rp-ind">成分权重</span>
      <span class="rp-period">共 ${list.length} 只</span>
      <span class="rp-cap">季度调仓 · 期内权重冻结</span>
    </div>
    <div class="iw-list">
      ${list.map((w) => `
        <div class="iw-row">
          <span class="iw-name">${escapeHtml(w.name)}</span>
          <span class="iw-bar"><i style="width:${(w.weight * 100).toFixed(1)}%"></i></span>
          <span class="iw-pct">${(w.weight * 100).toFixed(2)}%</span>
          <span class="iw-cap">${fmtMoney(w.freeCap || 0)}</span>
        </div>`).join('')}
    </div>
  `;
}

function toggleReportPanel() {
  const panel = $('#reportPanel');
  if (!panel) return;
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) renderReport();
}

function renderStBanner(st) {
  let el = $('#stBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'stBanner';
    el.className = 'st-banner hidden';
    const head = document.querySelector('.chart-head');
    if (head && head.parentNode) head.parentNode.insertBefore(el, head.nextSibling);
  }
  if (!el || !st) return;

  const cfg = state.market?.config || {};
  const line = Number(cfg.stPrice ?? ST_DEFAULT_PRICE);
  const limit = Number(cfg.stDelistTicks ?? 100);
  const left = Math.max(0, limit - (st.stTicks || 0));

  if (st.status === 'delisted') {
    el.className = 'st-banner delisted';
    el.innerHTML = `🚫 已退市 · 该标的停止交易，持仓已按最后价强制平仓`;
    return;
  }
  if (!st.st) {
    el.className = 'st-banner hidden';
    el.innerHTML = '';
    return;
  }
  const pctLeft = limit > 0 ? Math.min(100, ((st.stTicks || 0) / limit) * 100) : 0;
  el.className = 'st-banner';
  el.innerHTML = `
    <span class="st-tag">ST</span>
    <span>股价已连续 <b>${st.stTicks}</b> 轮低于 ${line.toFixed(2)} 元</span>
    <span class="st-countdown">再连续 ${left} 轮不回到 ${line.toFixed(2)} 上方就退市</span>
    <span class="st-bar"><i style="width:${pctLeft.toFixed(1)}%"></i></span>`;
}

function renderStockList() {
  const m = state.market;
  if (!m) return;
  const wrap = $('#stockList');
  const list = Object.values(m.stocks);
  wrap.innerHTML = '';
  for (const st of list) {
    const chg = listChange(st);
    const div = document.createElement('div');
    div.className = 'stock-item' + (st.code === state.code ? ' active' : '') + (st.status !== 'normal' ? ' suspended' : '');
    div.dataset.code = st.code;
    const statusTag = st.status === 'suspended' ? ' · 停牌' : st.status === 'delisted' ? ' · 退市' : '';
    const stBadge = st.st && st.status !== 'delisted' ? '<span class="st-badge">ST</span>' : '';
    div.innerHTML = `
      <img class="stock-icon" src="${st.icon || ''}" alt="${st.name}" loading="lazy" />
      <div class="stock-main">
        <div class="stock-name">${stBadge}${st.name}<span class="stock-code">${st.code}${statusTag}</span></div>
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
        <div class="stock-name">${escapeHtml(name)} <span class="stock-code">${p.code}</span></div>
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


// ---------------- 账号等级 / 分级商店 ----------------
const LV_COLORS = ['#94a3b8', '#3b82f6', '#a855f7', '#f59e0b', '#ef4444'];

/** 等级牌子（顶栏、排行榜、卡片共用） */
function lvBadgeHtml(lv) {
  const n = Math.max(1, Math.floor(Number(lv) || 1));
  const c = LV_COLORS[Math.min(n - 1, LV_COLORS.length - 1)];
  return `<span class="lv-badge" style="--lv:${c}">Lv.${n}</span>`;
}

/** 商店按等级显示：低等级看不到高等级商品 */

/** 切换商店等级 */
function switchShopTier(n) {
  state.shopTier = Math.max(1, Math.min(3, Number(n) || 1));
  renderShopTiers();
}

/** 把三个商店网格都挂到 #view-shop 下（防止 HTML 嵌套导致隐藏时连带被藏） */
function normalizeShopDom() {
  const view = $('#view-shop');
  if (!view) return;
  document.querySelectorAll('.shop-grid[data-tier]').forEach((el) => {
    if (el.parentElement !== view) view.appendChild(el);
  });
}

function renderShopTiers() {
  normalizeShopDom();
  const lv = Math.max(1, Math.floor(Number(state.market?.me?.level) || 1));
  const cur = Math.max(1, Math.min(3, Number(state.shopTier) || 1));

  // 顶部三个等级按钮：没解锁的显示锁，并且不可点
  document.querySelectorAll('[data-tier-tab]').forEach((b) => {
    const need = Number(b.dataset.tierTab) || 1;
    const locked = lv < need;
    b.classList.toggle('locked', locked);
    b.textContent = locked ? `🔒 Lv.${need} 商店` : `Lv.${need} 商店`;
    b.classList.toggle('active', need === cur);
  });

  // 只显示当前这一档（display 用 inline style 兜底，避免被 .shop-grid 的 grid 覆盖）
  document.querySelectorAll('.shop-grid[data-tier]').forEach((el) => {
    const need = Number(el.dataset.tier) || 1;
    const on = need === cur && lv >= need;
    el.classList.toggle('hidden', !on);
    el.style.display = on ? '' : 'none';
  });

  // 等级不够：显示提示，不显示任何商品
  const lockBox = $('#shopLocked');
  const lockText = $('#shopLockedText');
  const need = cur;
  if (lv < need) {
    if (lockText) {
      lockText.textContent = `Lv.${need} 商店需要账号等级 ${need}，你现在是 Lv.${lv}`;
    }
    lockBox?.classList.remove('hidden');
  } else {
    lockBox?.classList.add('hidden');
  }
  const badge = $('#lvBadge');
  if (badge) {
    const c = LV_COLORS[Math.min(lv - 1, LV_COLORS.length - 1)];
    badge.textContent = `Lv.${lv}`;
    badge.style.setProperty('--lv', c);
  }
}

/** 升级卡片 */
function renderLevelCard() {
  const me = state.market?.me || {};
  const cfg = state.market?.config || {};
  const lv = Math.max(1, Math.floor(Number(me.level) || 1));
  const base = Number(cfg.levelBaseAsset ?? 10000000);
  const growth = Math.max(1, Number(cfg.levelGrowth ?? 2));
  const need = base * Math.pow(growth, lv - 1);
  const ratio = Number(cfg.levelUpRatio ?? 0.6);
  const ratioEl = $('#levelRatio');
  if (ratioEl) ratioEl.textContent = `${Math.round(ratio * 100)}%`;
  // 每个等级多给多少「每轮单笔成交上限」
  const fillBonus = Math.max(0, Number(cfg.levelFillBonus ?? 1000000));
  const fillEl = $('#levelFillText');
  if (fillEl) fillEl.textContent = `+${fillBonus.toLocaleString('en-US')}`;
  const equity = Number(me.equity) || 0;
  const cost = Math.floor(equity * ratio);

  const now = $('#levelNow');
  if (now) now.outerHTML = lvBadgeHtml(lv).replace('class="lv-badge"', 'id="levelNow" class="lv-badge"');
  const priceEl = $('#levelPrice');
  if (priceEl) priceEl.textContent = money0(cost);
  const hint = $('#levelHint');
  if (hint) {
    const cashNow = Number(me.cash) || 0;
    if (equity < need) {
      hint.textContent = `还差 ${money0(need - equity)} 总资产才能升到 Lv.${lv + 1}`;
    } else if (cashNow < cost) {
      hint.textContent = `资产达标 · 但要付 ${money0(cost)} 现金，你只有 ${money0(cashNow)}（卖掉部分持仓换现金）`;
    } else {
      hint.textContent = `达成条件 · 升级后变成 Lv.${lv + 1}，扣掉 ${money0(cost)} 现金`;
    }
  }
  const btn = $('#levelUpBtn');
  if (btn) {
    const cash = Number(me.cash) || 0;
    const assetOk = equity >= need;
    const cashOk = cash >= cost;
    btn.disabled = !(assetOk && cashOk);
    if (!assetOk) {
      btn.textContent = `总资产还差 ${money0(need - equity)}`;
    } else if (!cashOk) {
      btn.textContent = `现金不足（差 ${money0(cost - cash)}）`;
    } else {
      btn.textContent = `升级到 Lv.${lv + 1}`;
    }
  }
}

async function levelUp() {
  try {
    const r = await api('/api/shop/level-up', { method: 'POST' });
    toast(`升级成功！现在是 Lv.${r.level}，${money0(r.cost)} 已存进银行`, 'ok');
    await refreshMarket();
    renderShopTiers();
    renderLevelCard();
    if ($('#view-bank')?.classList.contains('active')) renderBank();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/** 背景卡片 */
function renderBgCard() {
  const me = state.market?.me || {};
  const unlocked = !!me.bgUnlocked;
  $('#bgBuy')?.classList.toggle('hidden', unlocked);
  $('#bgUpload')?.classList.toggle('hidden', !unlocked);
  const hint = $('#bgHint');
  if (hint) {
    hint.textContent = unlocked
      ? (me.background ? '当前已使用自定义背景，可以随时换一张' : '已解锁，选一张图片上传吧')
      : '解锁后可以随时更换背景';
  }
  applyBackground(me.background);
}

function applyBackground(data) {
  const bg = document.body;
  if (data) {
    bg.style.backgroundImage = `url(${data})`;
    bg.style.backgroundSize = 'cover';
    bg.style.backgroundPosition = 'center';
    bg.style.backgroundAttachment = 'fixed';
  } else {
    bg.style.backgroundImage = '';
  }
}

async function buyBg() {
  try {
    await api('/api/shop/bg', { method: 'POST' });
    toast('自定义背景已解锁', 'ok');
    await refreshMarket();
    renderBgCard();
  } catch (e) { toast(e.message, 'err'); }
}

/** 图片压缩后上传（避免存档过大） */
function pickBgImage() {
  const inp = $('#bgFile');
  if (!inp) return;
  inp.value = '';
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const img = new Image();
    const url = URL.createObjectURL(f);
    img.onload = async () => {
      URL.revokeObjectURL(url);
      const maxW = 1600;
      const scale = Math.min(1, maxW / img.width);
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale);
      cv.height = Math.round(img.height * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      const data = cv.toDataURL('image/jpeg', 0.82);
      try {
        await api('/api/shop/bg/save', { method: 'POST', body: JSON.stringify({ data }) });
        if (state.market?.me) state.market.me.background = data;
        applyBackground(data);
        toast('背景已更新', 'ok');
        renderBgCard();
      } catch (e) { toast(e.message, 'err'); }
    };
    img.onerror = () => toast('图片读取失败', 'err');
    img.src = url;
  };
  inp.click();
}

/** 改名 */
async function buyRename() {
  const name = ($('#renameInput')?.value || '').trim();
  if (name.length < 2) { toast('名字至少 2 个字', 'err'); return; }
  try {
    const r = await api('/api/shop/rename', { method: 'POST', body: JSON.stringify({ nickname: name }) });
    toast(`改名成功：${r.nickname}`, 'ok');
    await refreshMarket();
    $('#renameInput').value = '';
    renderRenameHint();
  } catch (e) { toast(e.message, 'err'); }
}

function renderRenameHint() {
  const me = state.market?.me || {};
  const tick = state.market?.tick || 0;
  const left = Math.max(0, (Number(me.renameReadyAt) || 0) - tick);
  const hint = $('#renameHint');
  if (hint) hint.textContent = left > 0 ? `冷却中，还要等 ${left} 轮` : '现在可以改名';
  const btn = $('#renameBuy');
  if (btn) btn.disabled = left > 0;
}

/** 自动定投卡片（Lv.2 道具） */
function renderAutoDcaCard() {
  const me = state.market?.me || {};
  const cfg = state.market?.config || {};
  const price = Number(cfg.shopAutoDcaPrice ?? 5000000);
  const premium = Math.max(0, Number(cfg.shopAutoDcaPremium ?? 0.03));
  const owned = !!me.autoDca;
  const on = me.autoDcaOn !== false;
  const cash = Number(me.cash) || 0;
  const lv = Math.max(1, Math.floor(Number(me.level) || 1));
  const st = state.market?.stocks?.DENG;
  const bankCap = Math.max(0, Number(cfg.workRatePerTick ?? 50))
    * Math.max(1, Number(cfg.workBankTicks ?? 1440));
  const limit = st ? Math.round(Number(st.price) * (1 + premium) * 100) / 100 : 0;
  const qty = limit > 0 ? Math.floor(bankCap / limit) : 0;
  const pct = Math.round(premium * 100);

  const priceEl = $('#autoDcaPrice');
  if (priceEl) priceEl.textContent = money0(price);
  $('#autoDcaOwned')?.classList.toggle('hidden', !owned);

  const hint = $('#autoDcaHint');
  if (hint) {
    if (owned) {
      hint.textContent = on
        ? `运行中：钱袋攒满 ${money0(bankCap)} 就自动挂单 ${qty} 股 @ ${limit.toFixed(2)}（现价 +${pct}%）`
        : '已暂停：钱袋攒满也不会自动下单';
    } else if (st) {
      hint.textContent = `每次大约买入 ${qty} 股（钱袋上限 ${money0(bankCap)} ÷ 挂单价 ${limit.toFixed(2)}）`;
    } else {
      hint.textContent = '等待行情数据…';
    }
  }

  const buy = $('#autoDcaBuy');
  if (buy) {
    if (owned) {
      buy.classList.add('hidden');
    } else {
      buy.classList.remove('hidden');
      if (lv < 2) {
        buy.disabled = true;
        buy.textContent = `需要 Lv.2（你现在 Lv.${lv}）`;
      } else if (cash < price) {
        buy.disabled = true;
        buy.textContent = `现金不足（差 ${money0(price - cash)}）`;
      } else {
        buy.disabled = false;
        buy.textContent = `购买 · ${money0(price)}`;
      }
    }
  }
  const tg = $('#autoDcaToggle');
  if (tg) {
    tg.classList.toggle('hidden', !owned);
    tg.textContent = on ? '暂停定投' : '继续定投';
  }
}

async function buyAutoDca() {
  const btn = $('#autoDcaBuy');
  if (btn && btn.disabled) return;
  try {
    const r = await api('/api/shop/auto-dca', { method: 'POST' });
    if (state.market?.me) {
      state.market.me.autoDca = true;
      state.market.me.autoDcaOn = r.autoDcaOn !== false;
      if (Number.isFinite(r.cash)) state.market.me.cash = r.cash;
    }
    toast('自动定投已开启：钱袋一满就自动买 DENG', 'ok');
    refreshMarket();
    renderShop();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function toggleAutoDca() {
  const on = !(state.market?.me?.autoDcaOn !== false);
  try {
    const r = await api('/api/shop/auto-dca/toggle', { method: 'POST', body: JSON.stringify({ on }) });
    if (state.market?.me) state.market.me.autoDcaOn = r.autoDcaOn !== false;
    toast(r.autoDcaOn ? '已继续定投' : '已暂停定投', 'ok');
    renderShop();
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ---------------- 商城 ----------------
// ---------------- 主题配色 ----------------
const THEME_CHART = {
  default: {
    text: '#5b7671', grid: 'rgba(230,240,237,.7)', border: 'rgba(230,240,237,.9)',
    cross: 'rgba(20,184,166,.4)', crossLabel: '#14b8a6'
  },
  red: {
    text: '#8d4f4a', grid: 'rgba(247,221,216,.8)', border: 'rgba(247,221,216,.95)',
    cross: 'rgba(220,38,38,.35)', crossLabel: '#dc2626'
  },
  dark: {
    text: '#9aa6b9', grid: 'rgba(38,45,58,.9)', border: 'rgba(45,54,70,.95)',
    cross: 'rgba(240,192,74,.35)', crossLabel: '#d9a52f'
  },
  tycoon: {
    text: '#55682f', grid: 'rgba(223,234,196,.8)', border: 'rgba(223,234,196,.95)',
    cross: 'rgba(101,163,13,.45)', crossLabel: '#65a30d'
  },
  bear: {
    text: '#3f6b4e', grid: 'rgba(213,233,219,.8)', border: 'rgba(213,233,219,.95)',
    cross: 'rgba(21,128,61,.4)', crossLabel: '#15803d'
  },
  hermit: {
    text: '#5f5582', grid: 'rgba(227,221,244,.8)', border: 'rgba(227,221,244,.95)',
    cross: 'rgba(124,107,176,.45)', crossLabel: '#7c6bb0'
  },
  probe: {
    text: '#6b5644', grid: 'rgba(232,220,206,.8)', border: 'rgba(232,220,206,.95)',
    cross: 'rgba(139,94,60,.42)', crossLabel: '#8b5e3c'
  },
};

/** 把主题套到 body 上，并同步图表配色 */
function applyTheme(theme) {
  const t = THEME_CHART[theme] ? theme : 'default';
  state.theme = t;
  document.body.dataset.theme = t === 'default' ? '' : t;
  if (t === 'default') delete document.body.dataset.theme;
  try { localStorage.setItem('xd_theme', t); } catch { /* ignore */ }

  const c = THEME_CHART[t];
  if (state.chart) {
    state.chart.applyOptions({
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: c.text },
      grid: {
        vertLines: { color: c.grid },
        horzLines: { color: c.grid }
      },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border },
      crosshair: {
        vertLine: { color: c.cross, labelBackgroundColor: c.crossLabel },
        horzLine: { color: c.cross, labelBackgroundColor: c.crossLabel }
      }
    });
  }
  renderShop();
}

/** 让页面一打开就是上次用的主题，避免闪一下 */
function applyCachedTheme() {
  let t = 'default';
  try { t = localStorage.getItem('xd_theme') || 'default'; } catch { /* ignore */ }
  applyTheme(t);
}

/** 服务端记录的主题优先（换设备也跟着走） */
function syncThemeFromServer() {
  const t = state.market?.me?.theme;
  if (!t) return;
  if (t !== state.theme) applyTheme(t);
}

async function chooseTheme(code) {
  if (code === 'default') {
    try {
      await api('/api/shop/theme/select', { method: 'POST', body: JSON.stringify({ theme: 'default' }) });
      applyTheme('default');
      toast('已切回经典配色', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    return;
  }

  const owned = (state.market?.me?.themes || []).includes(code);
  const btn = document.querySelector(`.theme-btn[data-theme-code="${code}"]`);
  if (btn) btn.disabled = true;

  try {
    if (owned) {
      await api('/api/shop/theme/select', { method: 'POST', body: JSON.stringify({ theme: code }) });
      applyTheme(code);
      toast('主题已切换', 'ok');
    } else {
      const r = await api('/api/shop/theme', { method: 'POST', body: JSON.stringify({ theme: code }) });
      if (state.market?.me) {
        state.market.me.cash = r.cash;
        state.market.me.themes = r.themes;
      }
      applyTheme(code);
      toast(`主题已启用（花费 ${money0(r.price)}）`, 'ok');
      refreshMarket();
    }
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
    renderShop();
  }
}

function renderShop() {
  const cfg = state.market?.config || {};
  const price = Number(cfg.shopFakeNewsPrice ?? 500000);
  const chance = Number(cfg.shopFakeNewsChance ?? 0.2);
  const cash = state.market?.me?.cash || 0;

  const pEl = $('#fakeNewsPrice');
  if (pEl) pEl.textContent = money0(price);

  const cEl = $('#fakeNewsChance');
  if (cEl) cEl.textContent = Math.round(chance * 100) + '%';

  // 影响标的 chips（股票列表变了就重建，用事件委托避免重复绑定）
  const chipBox = $('#fakeNewsTargets');
  const chipList = Object.values(state.market?.stocks || {}).filter((s) => !s.isIndex);
  const chipSig = chipList.map((s) => s.code).join(',');
  if (chipBox && chipList.length && chipBox.dataset.sig !== chipSig) {
    chipBox.innerHTML = chipList.map((s) => (
      `<button class="chip-toggle" type="button" data-fn-code="${s.code}">${s.name}</button>`
    )).join('');
    chipBox.dataset.sig = chipSig;
  }
  if (chipBox && !chipBox.dataset.bound) {
    chipBox.dataset.bound = '1';
    chipBox.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fn-code]');
      if (!b) return;
      const code = b.dataset.fnCode;
      const idx = state.fakeNewsTargets.indexOf(code);
      if (idx >= 0) state.fakeNewsTargets.splice(idx, 1);
      else state.fakeNewsTargets.push(code);
      renderShop();
    });
  }
  if (chipBox) {
    chipBox.querySelectorAll('[data-fn-code]').forEach((b) => {
      b.classList.toggle('active', state.fakeNewsTargets.includes(b.dataset.fnCode));
    });
  }

  // 冷却
  const cdTicks = Number(cfg.shopFakeNewsCooldown ?? 120);
  const cdEl = $('#fakeNewsCd');
  if (cdEl) cdEl.textContent = String(cdTicks);
  const tickNow2 = state.market?.tick || 0;
  const readyAt = Number(state.market?.me?.fakeNewsReadyAt || 0);
  const cdLeft = Math.max(0, readyAt - tickNow2);

  const btn = $('#fakeNewsBuy');
  if (btn) {
    if (cdLeft > 0) {
      const sec = Math.ceil(cdLeft * ((state.market?.config?.tickMs || 5000) / 1000));
      btn.disabled = true;
      btn.textContent = `冷却中 · 还有 ${cdLeft} 轮（约 ${Math.ceil(sec / 60)} 分钟）`;
    } else {
      const poor = cash < price;
      btn.disabled = poor;
      btn.textContent = poor ? `现金不足（差 ${money0(price - cash)}）` : '购买并发布';
    }
  }

  // ---- 保镖 ----
  const bgPrice = Number(cfg.shopBodyguardPrice ?? 50000);
  const bgTicks = Number(cfg.shopBodyguardTicks ?? 720);
  const bgPriceEl = $('#bodyguardPrice');
  if (bgPriceEl) bgPriceEl.textContent = money0(bgPrice);
  const bgTicksEl = $('#guardTicks');
  if (bgTicksEl) bgTicksEl.textContent = String(bgTicks);

  const tickNow = state.market?.tick || 0;
  const guardLeft = Math.max(0, Number(state.market?.me?.guardUntil || 0) - tickNow);
  const gs = $('#guardStatus');
  if (gs) {
    if (guardLeft > 0) {
      const mins = Math.ceil((guardLeft * (state.market?.config?.tickMs || 5000)) / 60000);
      gs.textContent = `🛡️ 保护中 · 还剩 ${guardLeft} 轮（约 ${mins} 分钟）`;
      gs.classList.add('on');
    } else {
      gs.textContent = '当前没有保护';
      gs.classList.remove('on');
    }
  }

  const bgBtn = $('#bodyguardBuy');
  if (bgBtn) {
    const poor = cash < bgPrice;
    bgBtn.disabled = poor;
    bgBtn.textContent = poor
      ? `现金不足（差 ${money0(bgPrice - cash)}）`
      : (guardLeft > 0 ? '再续一小时' : '购买保镖');
  }

  // ---- 交易专属通道 ----
  const chBase = Number(cfg.shopChannelBasePrice ?? 300000);
  const chRatio = Number(cfg.shopChannelRatio ?? 1.5);
  const chStep = Number(cfg.shopChannelStep ?? 100000);
  const baseCap = Number(cfg.maxFillNotionalPerTick ?? 300000);
  const chLevel = Math.max(0, Number(state.market?.me?.channelLevel || 0));
  const chPrice = Math.round(chBase * Math.pow(chRatio, chLevel));
  // 当前上限已经包含「基础 + 等级加成 + 已买通道」，以服务端下发为准
  const capNow = Number(state.market?.me?.fillCap ?? (baseCap + chStep * chLevel));
  const capNext = capNow + chStep;

  const chPriceEl = $('#channelPrice');
  if (chPriceEl) chPriceEl.textContent = money0(chPrice);
  const chCapNow = $('#channelCapNow');
  if (chCapNow) chCapNow.textContent = money0(capNow);
  const chLv = $('#channelLevel');
  if (chLv) chLv.textContent = `${chLevel} 级`;
  const chCapNext = $('#channelCapNext');
  if (chCapNext) chCapNext.textContent = money0(capNext);

  const chBtn = $('#channelBuy');
  if (chBtn) {
    const poor = cash < chPrice;
    chBtn.disabled = poor;
    chBtn.textContent = poor ? `现金不足（差 ${money0(chPrice - cash)}）` : `购买 · ${money0(chPrice)}`;
  }

  // ---- 红牛的累计返现 ----
  const redEarned = Number(state.market?.me?.redBonusEarned || 0);
  const redEarnedEl = $('#redEarned');
  if (redEarnedEl) {
    redEarnedEl.textContent = money(redEarned);
    redEarnedEl.className = redEarned > 0 ? 'up' : '';
  }

  // ---- 绿熊的累计返现 ----
  const bearEarned = Number(state.market?.me?.bearBonusEarned || 0);
  const bearEarnedEl = $('#bearEarned');
  if (bearEarnedEl) {
    bearEarnedEl.textContent = money(bearEarned);
    bearEarnedEl.className = bearEarned > 0 ? 'down' : '';
  }

  // ---- 主题 ----
  // 账号等级 / 分级商店
  renderShopTiers();
  renderLevelCard();
  renderBgCard();
  renderRenameHint();
  renderAutoDcaCard();

  const ownedThemes = state.market?.me?.themes || [];
  const curTheme = state.theme || state.market?.me?.theme || 'default';
  const themePrice = Number(cfg.shopThemePrice ?? 2000000);
  // 主题卡片的价格跟着配置走，统一不带小数
  document.querySelectorAll('.theme-card .shop-price').forEach((el) => {
    el.textContent = money0(themePrice);
  });
  // 主题切换冷却
  const themeCd = Number(cfg.shopThemeCooldown ?? 100);
  const themeLast = Number(state.market?.me?.themeChangedTick || 0);
  const themeTick = state.market?.tick || 0;
  const themeLeft = (themeCd > 0 && themeLast > 0)
    ? Math.max(0, themeCd - (themeTick - themeLast)) : 0;

  document.querySelectorAll('[data-cd-for]').forEach((el) => {
    if (themeLeft > 0) {
      el.classList.remove('hidden');
      const sec = Math.ceil(themeLeft * ((state.market?.config?.tickMs || 5000) / 1000));
      el.innerHTML = `换主题冷却中 <b>${themeLeft} 轮</b>（约 ${Math.ceil(sec / 60)} 分钟）`;
    } else {
      el.classList.add('hidden');
    }
  });

  document.querySelectorAll('.theme-btn').forEach((b) => {
    const code = b.dataset.themeCode;
    const has = ownedThemes.includes(code);
    const isCur = curTheme === code || (code === 'default' && curTheme === 'default');
    if (code === 'default') {
      b.textContent = isCur ? '正在使用' : '使用经典配色';
      b.disabled = isCur;
      return;
    }
    if (isCur) { b.textContent = '正在使用'; b.disabled = true; return; }
    if (has) {
      b.textContent = themeLeft > 0 ? `冷却 ${themeLeft} 轮` : '切换到这套';
      b.disabled = themeLeft > 0;
      return;
    }
    const poor = cash < themePrice;
    b.textContent = poor ? `现金不足（差 ${money0(themePrice - cash)}）` : '购买';
    b.disabled = poor;
  });
  document.querySelectorAll('.theme-owned').forEach((el) => {
    el.classList.toggle('hidden', !ownedThemes.includes(el.dataset.owned));
  });

  $$('.dir-btn').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.dir) === state.shopDir);
  });
}

async function buyBodyguard() {
  const btn = $('#bodyguardBuy');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '雇佣中…';
  try {
    const r = await api('/api/shop/bodyguard', { method: 'POST' });
    if (state.market?.me) {
      state.market.me.guardUntil = r.guardUntil;
      state.market.me.cash = r.cash;
    }
    toast(`🛡️ 保镖已就位，保护 ${r.leftTicks} 轮`, 'ok');
    refreshMarket();
  } catch (e) {
    toast(e.message, 'err');
    btn.textContent = old;
  } finally {
    renderShop();
  }
}

async function loadAdminPlayers() {
  const banBox = $('#banList');
  if (!banBox) return;
  try {
    const d = await adminApi('/api/admin/players');
    state.adminPlayers = d.players || [];
    renderBanList();
  } catch (e) {
    banBox.innerHTML = `<div class="field-hint">${e.message}</div>`;
  }
}

function renderBanList() {
  const box = $('#banList');
  if (!box) return;
  const kw = ($('#banSearch')?.value || '').trim().toLowerCase();
  const all = state.adminPlayers || [];
  const list = kw ? all.filter((p) => p.nickname.toLowerCase().includes(kw)) : all;
  const bannedCount = all.filter((p) => p.banned).length;
  const cnt = $('#banCount');
  if (cnt) cnt.textContent = `共 ${all.length} 人 · 已封禁 ${bannedCount} 人`;

  if (!list.length) {
    box.innerHTML = '<div class="field-hint">没有匹配的玩家</div>';
    return;
  }
  box.innerHTML = list.map((p) => `
    <div class="ban-row${p.banned ? ' banned' : ''}">
      <div class="ban-main">
        ${rankAvatar(p)}
        <b>${escapeHtml(p.nickname)}</b>
        ${p.banned ? '<span class="ban-tag">已封禁</span>' : ''}
        ${p.banReason ? `<span class="ban-reason">${escapeHtml(p.banReason)}</span>` : ''}
        <span class="ban-money">${money0(p.equity)}</span>
      </div>
      <div class="ban-actions">
        <button class="ban-btn ${p.banned ? 'unban' : ''}" data-ban-id="${p.id}" data-ban-action="${p.banned ? 'unban' : 'ban'}">
          ${p.banned ? '解封' : '封禁'}
        </button>
        <button class="ban-btn logout" data-logout-id="${p.id}" data-logout-name="${escapeHtml(p.nickname)}">登出</button>
        ${p.banned ? `<button class="ban-btn del" data-del-id="${p.id}" data-del-name="${escapeHtml(p.nickname)}">删号</button>` : ''}
      </div>
    </div>`).join('');

  box.querySelectorAll('[data-ban-id]').forEach((b) => {
    b.addEventListener('click', () => banPlayer(b.dataset.banId, b.dataset.banAction));
  });
  box.querySelectorAll('[data-logout-id]').forEach((b) => {
    b.addEventListener('click', () => logoutPlayer(b.dataset.logoutId, b.dataset.logoutName));
  });
  box.querySelectorAll('[data-del-id]').forEach((b) => {
    b.addEventListener('click', () => deletePlayer(b.dataset.delId, b.dataset.delName));
  });
}

async function logoutPlayer(id, name) {
  if (!confirm(`让「${name}」强制下线？\n\n账号不会被封，重新登录就能继续玩。`)) return;
  try {
    const r = await adminApi('/api/admin/player', { id, action: 'logout' });
    toast(r.kicked > 0 ? `已让「${name}」下线（${r.kicked} 个会话）` : `「${name}」当前不在线`, 'ok');
    loadAdminPlayers();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function banPlayer(id, action) {
  let reason = '';
  if (action === 'ban') {
    reason = prompt('封禁理由（可留空，会显示在登录提示里）：') || '';
  }
  try {
    const r = await adminApi('/api/admin/player', { id, action, reason });
    toast(action === 'ban'
      ? `已封禁${r.kicked ? `，踢下线 ${r.kicked} 个会话` : ''}`
      : '已解封', 'ok');
    loadAdminPlayers();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function deletePlayer(id, name) {
  const ok1 = confirm(`确定要删除「${name}」的账号吗？\n\n现金、持仓、订单、交易记录会全部消失，无法恢复。`);
  if (!ok1) return;
  const ok2 = confirm(`再确认一次：真的要永久删除「${name}」？`);
  if (!ok2) return;
  try {
    await adminApi('/api/admin/player', { id, action: 'delete' });
    toast(`已删除账号「${name}」`, 'ok');
    loadAdminPlayers();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function buyChannel() {
  const btn = $('#channelBuy');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = '购买中…';
  try {
    const r = await api('/api/shop/channel', { method: 'POST' });
    if (state.market?.me) {
      state.market.me.cash = r.cash;
      state.market.me.channelLevel = r.level;
    }
    toast(`⚡ 通道升到 ${r.level} 级，单笔上限 ${money0(r.cap)}`, 'ok');
    refreshMarket();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    renderShop();
  }
}

async function buyFakeNews() {
  const text = $('#fakeNewsText').value.trim();
  if (text.length < 4) { toast('内容至少 4 个字', 'err'); return; }

  const btn = $('#fakeNewsBuy');
  btn.disabled = true;
  btn.textContent = '发布中…';
  try {
    const r = await api('/api/shop/fake-news', {
      method: 'POST',
      body: JSON.stringify({ text, dir: state.shopDir, companies: state.fakeNewsTargets })
    });
    $('#fakeNewsText').value = '';
    state.fakeNewsTargets = [];
    if (state.market?.me) state.market.me.fakeNewsReadyAt = r.readyAt;
    const where = (r.companies && r.companies.length) ? `（影响 ${r.companies.join('/')}）` : '（全市场）';
    toast(`📰 假新闻已发布${where}，花费 ${money0(r.price)}`, 'ok');
    if (state.market?.me) state.market.me.cash = r.cash;
    refreshMarket();
    loadNewsSoon();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    renderShop();
  }
}

/** 新闻是 SSE 推的，买完立刻刷一下快照更跟手 */
function loadNewsSoon() {
  setTimeout(() => refreshMarket(), 800);
}

// ---------------- 挂单价参考线 + K线划线 ----------------
/** 把挂单价画成一根横线 */
function updateLimitLine(price) {
  const series = state.candleSeries;
  if (!series) return;
  const p = Number(price);
  const valid = Number.isFinite(p) && p > 0;

  if (state.limitLine) {
    try { series.removePriceLine(state.limitLine); } catch { /* ignore */ }
    state.limitLine = null;
  }
  if (!valid) return;

  const buy = isBuySide();
  state.limitLine = series.createPriceLine({
    price: p,
    color: buy ? '#f97316' : '#0ea5e9',
    lineWidth: 2,
    lineStyle: 2,          // 虚线
    axisLabelVisible: true,
    title: buy ? '挂买' : '挂卖'
  });
}

/** 当前持仓 */
function currentPosition() {
  return state.market?.me?.positions?.[state.code] || null;
}


/** 手动输入止盈止损 + 触发时平仓数量 */

/** 把持仓上已有的止盈止损回填到输入框 */
function fillTpSlInputs() {
  // 改成多条条件单后，输入框只用于新增，不再回填
}

/** 止盈止损页：列表 + 每行可删除 */
function renderTpSlStatus() {
  const box = $('#tpslStatus');
  if (!box) return;
  const pos = state.market?.me?.positions?.[state.code];
  const st = state.market?.stocks?.[state.code];
  if (!pos) {
    box.innerHTML = '<span class="ts-empty">这只票没有持仓，止盈止损无处可设</span>';
    return;
  }
  const list = Array.isArray(pos.tpsl) ? pos.tpsl : [];
  const head = `<div class="ts-title">当前持仓 ${pos.qty} 股 · ${pos.side === 'long' ? '做多' : '做空'}`
    + ` · 现价 ${(st?.price || 0).toFixed(2)}</div>`;

  if (!list.length) {
    box.innerHTML = head + '<span class="ts-empty">还没有条件单，填好价格点上面的按钮添加</span>';
    return;
  }

  box.innerHTML = head + list.map((x) => {
    const isTp = x.kind === 'tp';
    return `<div class="ts-row">
      <span class="ts-kind ${isTp ? 'tp' : 'sl'}">${isTp ? '止盈' : '止损'}</span>
      <b class="${isTp ? 'up' : 'down'}">${Number(x.price).toFixed(2)}</b>
      <i>${x.qty ? `平 ${x.qty} 股` : '全平'}</i>
      <button class="ts-del" data-tpsl-del="${x.id}" type="button" title="删除这条">✕</button>
    </div>`;
  }).join('');

  box.querySelectorAll('[data-tpsl-del]').forEach((b) => {
    b.addEventListener('click', () => removeTpSl(b.dataset.tpslDel));
  });
}

/** 删掉一条止盈止损 */
async function removeTpSl(id) {
  try {
    const r = await api('/api/tpsl/remove', {
      method: 'POST', body: JSON.stringify({ code: state.code, id })
    });
    if (r?.position && state.market?.me?.positions?.[state.code]) {
      const local = state.market.me.positions[state.code];
      local.tpsl = r.position.tpsl || [];
      local.tp = r.position.tp ?? null;
      local.sl = r.position.sl ?? null;
    }
    renderTpSlStatus();
    updatePriceLines();
    toast('已删除这条条件单', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function applyTpSl() {
  const pos = state.market?.me?.positions?.[state.code];
  if (!pos) { toast('没有持仓', 'err'); return; }
  const tpV = Number($('#tpPrice')?.value);
  const slV = Number($('#slPrice')?.value);
  const qtyV = Math.floor(Number($('#tpslQty')?.value) || 0);
  if (!(tpV > 0) && !(slV > 0)) { toast('止盈和止损至少要填一个', 'err'); return; }

  // 方向校验：做多时止盈必须高于现价、止损低于现价
  const px = Number(state.market?.stocks?.[state.code]?.price) || 0;
  const long = pos.side === 'long';
  if (tpV > 0 && ((long && tpV <= px) || (!long && tpV >= px))) {
    toast(long ? '做多的止盈价要高于现价' : '做空的止盈价要低于现价', 'err');
    return;
  }
  if (slV > 0 && ((long && slV >= px) || (!long && slV <= px))) {
    toast(long ? '做多的止损价要低于现价' : '做空的止损价要高于现价', 'err');
    return;
  }
  if (qtyV > 0 && qtyV > pos.qty) { toast(`最多 ${pos.qty} 股`, 'err'); return; }

  const body = { code: state.code, qty: qtyV || null };
  if (tpV > 0) body.tp = tpV;
  if (slV > 0) body.sl = slV;
  try {
    const r = await api('/api/tpsl', { method: 'POST', body: JSON.stringify(body) });
    if (r?.position && state.market?.me?.positions?.[state.code]) {
      const local = state.market.me.positions[state.code];
      local.tp = r.position.tp ?? null;
      local.sl = r.position.sl ?? null;
      if (Array.isArray(r.position.tpsl)) local.tpsl = r.position.tpsl;
    }
    state.tpslEdited = false;
    // 加完清空，方便接着加下一条
    if ($('#tpPrice')) $('#tpPrice').value = '';
    if ($('#slPrice')) $('#slPrice').value = '';
    if ($('#tpslQty')) $('#tpslQty').value = '';
    updatePriceLines();
    renderTpSlStatus();
    toast('止盈止损已更新' + (qtyV > 0 ? `（触发平 ${qtyV} 股）` : '（触发全平）'), 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

/** 屏幕 y 坐标 → 价格 */
/** 鼠标指到某根 K 线时，显示它的开高低收和涨跌幅 */
function bindHoverInfo() {
  if (!state.chart || state.hoverBound) return;
  state.hoverBound = true;

  state.chart.subscribeCrosshairMove((param) => {
    const box = $('#hoverInfo');
    if (!box) return;

    if (!param || !param.time || !param.point) {
      box.innerHTML = '';
      return;
    }
    const bar = param.seriesData && param.seriesData.get(state.candleSeries);
    if (!bar) { box.innerHTML = ''; return; }

    const list = state.candles || [];
    let idx = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].time === param.time) { idx = i; break; }
    }
    const prevClose = idx > 0 ? list[idx - 1].close : bar.open;
    const chg = prevClose ? ((bar.close - prevClose) / prevClose) * 100 : 0;
    const amp = prevClose ? ((bar.high - bar.low) / prevClose) * 100 : 0;
    const clsName = chg > 0 ? 'up' : chg < 0 ? 'down' : 'flat';

    const d = new Date(param.time * 1000);
    const sameDay = new Date().toDateString() === d.toDateString();
    const when = sameDay
      ? `${p2(d.getHours())}:${p2(d.getMinutes())}`
      : `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;

    box.innerHTML = `
      <span class="hi-time">${when}</span>
      <span>开 <b>${bar.open.toFixed(2)}</b></span>
      <span>高 <b class="up">${bar.high.toFixed(2)}</b></span>
      <span>低 <b class="down">${bar.low.toFixed(2)}</b></span>
      <span>收 <b>${bar.close.toFixed(2)}</b></span>
      <span class="hi-chg ${clsName}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>
      <span class="hi-amp">振幅 ${amp.toFixed(2)}%</span>`;
  });
}

function priceAtY(clientY) {
  const el = $('#chart');
  const series = state.candleSeries;
  if (!el || !series) return 0;
  const rect = el.getBoundingClientRect();
  const y = clientY - rect.top;
  const p = series.coordinateToPrice(y);
  if (!Number.isFinite(p) || p <= 0) return 0;
  return Math.round(p * 100) / 100;
}

/** 把价格写进输入框（并标记为手动） */
function setLimitPrice(price, { manual = true } = {}) {
  const inp = $('#orderLimit');
  if (!inp || !(price > 0)) return;
  inp.value = Number(price).toFixed(2);
  if (manual) state.limitAuto = false;
  updateLimitLine(price);
  updateOrderBtnLabel();
}

// ---------------- 限价挂单 ----------------
// 自动定价：在这个方向稍微让一点价，保证下一轮能成交
//   买入/平空 → 限价挂在现价上方（愿意多付一点）
//   卖出/平多 → 限价挂在现价下方（愿意少收一点）
// 让利比例必须每次现读，不能做成模块级常量——否则玩家改了要刷新才生效

/** 当前真正要下的方向：开仓看 state.side，平仓看持仓方向 */
function effectiveSide() {
  if ((state.orderMode || 'open') === 'close') {
    const pos = state.market?.me?.positions?.[state.code];
    return pos ? pos.side : 'long';
  }
  return state.side;
}

/** 这一单是不是「买入」（决定挂单价的让利方向） */
function isBuySide() {
  const side = effectiveSide();
  if ((state.orderMode || 'open') === 'close') return side === 'short'; // 平空 = 买回
  return side === 'long';
}

/** 挂单让利百分比（0~3），默认 0.5%，存在本地长期有效 */
function getSlipPct() {
  const v = Number(localStorage.getItem('xd_slip'));
  if (Number.isFinite(v) && v >= 0 && v <= 3) return v;
  return 0.5;
}

/** 保存让利比例（0~3%），立刻重算挂单价
 *  normalize=false 时不回写输入框，避免打字过程中被改写 */
function setSlipPct(v, normalize = true) {
  const raw = Number(v);
  const n = Number.isFinite(raw) ? Math.max(0, Math.min(3, raw)) : getSlipPct();
  localStorage.setItem('xd_slip', String(n));
  const inp = $('#slipInput');
  if (normalize && inp && Number(inp.value) !== n) inp.value = String(n);
  syncLimitPrice(true);
  return n;
}

function initSlipInput() {
  const el = $('#slipInput');
  if (!el) return;
  el.value = String(getSlipPct());
  // 以前这里没有任何监听：输入框是死的，改了既不保存也不重算挂单价
  el.addEventListener('input', () => {
    if (el.value === '') return;
    const n = Number(el.value);
    if (!Number.isFinite(n)) return;
    setSlipPct(n, false);
  });
  el.addEventListener('change', () => {
    setSlipPct(el.value === '' ? getSlipPct() : el.value);
  });
}

function autoLimitPrice() {
  const st = state.market?.stocks?.[state.code];
  if (!st || !(st.price > 0)) return 0;
  const price = Number(st.price);
  const slip = getSlipPct() / 100;
  const buy = isBuySide();
  let p = Math.round((buy ? price * (1 + slip) : price * (1 - slip)) * 100) / 100;
  // 低价股 0.01 就占 1%：四舍五入可能把让利抹平，这时至少让一跳
  if (buy && p <= price) p = Math.round((price + 0.01) * 100) / 100;
  if (!buy && p >= price) p = Math.max(0.01, Math.round((price - 0.01) * 100) / 100);
  return p;
}

// 挂单价默认跟随现价（让利后），玩家手动改过就不再覆盖
function syncLimitPrice(force = false) {
  const inp = $('#orderLimit');
  if (!inp) return;
  if (force || state.limitAuto) {
    const p = autoLimitPrice();
    if (p > 0) {
      inp.value = p.toFixed(2);
      state.limitAuto = true;
      updateLimitLine(p);
    }
  }
}

async function placeLimit() {
  const st = state.market?.stocks?.[state.code];
  if (!st) return;
  // 价格保留两位小数，避免出现 194.02499999999998 这种值
  const limit = Math.round(Number($('#orderLimit').value) * 100) / 100;
  if (!(limit > 0)) { toast('先填挂单价', 'err'); return; }

  const mode = state.orderMode || 'open';
  const pos = state.market?.me?.positions?.[state.code];

  let payload;
  if (mode === 'close') {
    if (!pos) { toast('这只票没有持仓可平', 'err'); return; }
    const closeQty = Math.floor(Number($('#orderQty').value) || 0);
    if (closeQty > 0 && closeQty > pos.qty) {
      toast(`最多平 ${pos.qty} 股`, 'err');
      return;
    }
    payload = { code: st.code, action: 'close', side: pos.side, limit, qty: closeQty > 0 ? closeQty : undefined };
  } else {
    payload = {
      code: st.code,
      action: 'open',
      side: state.side,
      qty: Number($('#orderQty').value),
      leverage: Number($('#orderLev').value) || 1,
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
  // 平仓方向由持仓决定，做多/做空切换没意义
  $('#sideSwitch')?.classList.toggle('hidden', isClose);

  // 平仓也要填数量（可以只平一部分），只有杠杆没意义
  const levEl = $('#orderLev');
  const levField = levEl?.closest('.field');
  if (levField) levField.classList.toggle('hidden', isClose);

  // 快捷分仓在两种模式下都在，只是档位含义不同
  $('.quick-qty')?.classList.remove('hidden');
  const quickLabels = isClose
    ? ['1/4 平', '1/3 平', '半平', '全平']
    : ['1/4 仓', '1/3 仓', '半仓', '全仓'];
  $$('.quick-qty button').forEach((b, i) => {
    if (quickLabels[i]) b.textContent = quickLabels[i];
  });

  // 切到平仓时，数量默认填满持仓
  if (isClose) {
    const p = state.market?.me?.positions?.[state.code];
    const q = $('#orderQty');
    if (q && p) q.value = String(p.qty);
  }

  // 成本预估框在平仓模式下没意义，一起藏起来
  $('.cost-box')?.classList.toggle('hidden', isClose);

  const hint = $('#closeHint');
  const pos = state.market?.me?.positions?.[state.code];
  if (hint) {
    hint.classList.toggle('hidden', !isClose);
    if (isClose) {
      const perTick = Number(state.market?.me?.fillCap ?? state.market?.config?.maxFillNotionalPerTick ?? 150000);
      const estQty = pos ? Math.max(1, Math.floor(perTick / Math.max(pos.price || pos.entry, 0.01))) : 0;
      hint.textContent = pos
        ? `当前持仓：${pos.side === 'long' ? '多' : '空'} ${pos.qty} 股 · ${(pos.leverage || 1).toFixed(0)}x · 成本 ${pos.entry.toFixed(2)}；每轮最多成交约 ${estQty} 股（${money(perTick)}）`
        : '这只票没有持仓';
    }
  }
  if (state.limitAuto) syncLimitPrice(true);
  updateOrderBtnLabel();
}

function updateOrderBtnLabel() {
  const btn = $('#orderBtn');
  if (!btn) return;

  // 休市优先
  if (state.market?.marketOpen === false) {
    btn.textContent = '休市中，暂停交易';
    btn.disabled = true;
    return;
  }

  const mode = state.orderMode || 'open';
  const me = state.market?.me || {};
  const pos = me.positions?.[state.code];

  if (mode === 'close') {
    if (!pos) {
      btn.textContent = '没有持仓可平';
      btn.disabled = true;
      return;
    }
    const pending = (me.orders || []).some(
      (o) => o.code === state.code && o.action === 'close'
    );
    if (pending) {
      btn.textContent = '这只票已有平仓单';
      btn.disabled = true;
      return;
    }
    btn.textContent = pos.side === 'long' ? '挂单平多' : '挂单平空';
    btn.disabled = false;
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
      const autoTag = o.auto
        ? `<span class="mo-auto">${o.auto === 'tp' ? '止盈单' : '止损单'}</span>`
        : (o.autoDca ? '<span class="mo-auto">定投</span>' : '');
      return `<div class="mo-row">
        <span class="mo-side ${buy ? 'buy' : 'sell'}">${label}${buy ? '买' : '卖'}</span>
        <span class="mo-name">${o.name}${autoTag}</span>
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

function selectStock(code) {
  const changed = state.code !== code;
  state.code = code;
  // 换股票了：输入框内容重新按新持仓回填
  if (changed) {
    state.tpslEdited = false;
    fillTpSlInputs(true);
    // 换股票了，止盈止损列表必须换成这只票的，否则会显示上一只的记录
    renderTpSlStatus();
  }
  // 手机上点列表进入个股详情页
  if (isMobile()) {
    document.body.classList.add('m-detail');
    resizeChartNow();
  }
  $$('.stock-item').forEach((el) => el.classList.toggle('active', el.dataset.code === code));
  const st = state.market.stocks[code];
  if (!st) return;
  const chg0 = stockChange(st);
  const stBadge = st.st && st.status !== 'delisted'
    ? '<span class="st-badge big">ST</span>'
    : '';
  $('#chartName').innerHTML = stBadge + escapeHtml(st.name);
  renderStBanner(st);
  renderChartSub(st);
  renderReport();
  $('#chartCode').textContent = st.code;
  $('#chartIcon').src = st.icon || '';
  $('#chartPrice').textContent = st.price.toFixed(2);
  $('#chartPrice').className = 'big-price ' + cls(chg0);
  const ce = $('#chartChange');
  ce.textContent = pct(chg0);
  ce.className = 'big-change ' + cls(chg0);
  updateCostPreview();
  state.limitAuto = true;
  syncLimitPrice(true);
  switchOrderMode(state.orderMode || 'open');
  updateLimitLine(Number($('#orderLimit')?.value));
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
  const ageTip = (n) => (n === null || n === undefined)
    ? '' : `<span class="news-age">已过去 ${n} 轮</span>`;
  // 有 tick 期限的公告显示「还剩 N 轮」，老公告还是显示已过去多少轮
  const noticeTip = (n) => {
    const left = Number(n.leftTicks);
    if (n.leftTicks === null || n.leftTicks === undefined || !Number.isFinite(left)) {
      return ageTip(n.ageTicks);
    }
    return `<span class="news-age">还剩 ${left} 轮</span>`;
  };

  const noticeHtml = notices.slice(0, 3).map((n) => `
    <div class="news-item news-notice">
      <span class="news-badge badge-notice">公告</span>
      <span class="news-text">${escapeHtml(n.text)}</span>
      ${noticeTip(n)}
    </div>`).join('');

  const newsHtml = list.slice(0, Math.max(1, 4 - Math.min(3, notices.length))).map((ev) => `
    <div class="news-item">
      ${newsBadge(ev)}
      <span class="news-text">${ev.text}</span>
      ${ageTip(ev.ageTicks)}
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
    localization: {
      timeFormatter: (t) => fmtLocalTime(t, true)
    },
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
    timeScale: {
      borderColor: 'rgba(230,240,237,.9)',
      timeVisible: true,
      secondsVisible: false,
      tickMarkFormatter: (t) => fmtLocalTime(t, false)
    },
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
  bindHoverInfo();
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

  // 手机上初次创建时图表容器可能是隐藏的（宽高为 0），
  // 给个兜底尺寸，等真正显示出来再由 ResizeObserver 校正
  const safeW = el.clientWidth || 320;
  const safeH = el.clientHeight || 300;
  const ro = new ResizeObserver(() => {
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w > 0 && h > 0) chart.applyOptions({ width: w, height: h });
  });
  ro.observe(el);
  chart.applyOptions({ width: safeW, height: safeH });
}

/** 切换列表/详情后，手动触发一次图表尺寸校正 */
function resizeChartNow() {
  const el = $('#chart');
  const chart = state.chart;
  if (!el || !chart) return;
  requestAnimationFrame(() => {
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w > 0 && h > 0) chart.applyOptions({ width: w, height: h });
  });
}

// ---------------- 下单卡片：下单 / 成交记录 切换 ----------------
function switchTradeTab(name) {
  state.tradeTab = name;
  document.querySelectorAll('.trade-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.ttab === name);
  });
  $('#orderPane')?.classList.toggle('hidden', name !== 'order');
  $('#logPane')?.classList.toggle('hidden', name !== 'log');
  $('#tpslPane')?.classList.toggle('hidden', name !== 'tpsl');
  if (name === 'log') loadStockTrades();
  if (name === 'tpsl') {
    fillTpSlInputs(true);
    renderTpSlStatus();
  }
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
        ${r.emoji
          ? `<span class="st-emoji">${r.emoji}</span>`
          : rankAvatar(r)}
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
    // 防竞态：切股票/切周期时前一个请求可能后到，直接把新数据覆盖成旧股票
    if (code !== state.code || tf !== state.tf) return;

    // 清洗：时间必须递增且唯一，否则图表库内部按时间查不到数据会抛
    // 「Value is null」，整块 K 线画不出来
    const seen = new Set();
    const clean = [];
    for (const c of (d.candles || [])) {
      if (!c || !Number.isFinite(c.time) || c.time <= 0) continue;
      if (!Number.isFinite(c.open) || !Number.isFinite(c.high)
        || !Number.isFinite(c.low) || !Number.isFinite(c.close)) continue;
      const t = Math.floor(c.time);
      if (seen.has(t)) continue;
      seen.add(t);
      clean.push({
        time: t,
        open: c.open,
        high: Math.max(c.high, c.open, c.close, c.low),
        low: Math.min(c.low, c.open, c.close, c.high),
        close: c.close
      });
    }
    clean.sort((a, b) => a.time - b.time);

    state.candles = clean;
    state.candleSeries.setData(state.candles);

    // 记下当前桶号：下一次 tick 落在同一根 K 线里就只更新它
    state.tickKey = code + '|' + tf;
    state.tickBucket = Math.floor((state.market?.tick || 0) / (TF_SECONDS[tf] || 12));
    renderMAs();
    state.plSig = null;
    updatePriceLines();
    updateMarkers();
    updateLimitLine(Number($('#orderLimit')?.value));
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
  if (!Number.isFinite(price) || price <= 0) return;

  const group = TF_SECONDS[state.tf] || 12;
  const tickMs = state.market?.tickMs || 5000;
  const tick = Number(state.market?.tick);
  if (!Number.isFinite(tick) || tick < 0) return;

  // 用「第几个 K 线桶」判断是不是新的一根：
  // 不要自己用 startedAt 推算时间戳，客户端算出来的时间和服务器
  // 真正记录的 tick 时间对不上，会导致最后一根永远更新不了
  const bucket = Math.floor(tick / group);
  const bucketSec = (group * tickMs) / 1000;
  const key = state.code + '|' + state.tf;
  if (state.tickKey !== key) {
    state.tickKey = key;
    state.tickBucket = bucket;
  }

  const last = state.candles[state.candles.length - 1];
  const sameBucket = state.tickBucket === null
    || state.tickBucket === undefined
    || bucket <= state.tickBucket;

  if (last && sameBucket) {
    // 同一根 K 线里：更新收盘价和上下影线
    last.close = price;
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    state.candleSeries.update(last);
    for (const period of [5, 10, 30]) {
      if (!state.maVisible[period]) continue;
      const n = state.candles.length;
      if (n < period) continue;
      let sum = 0;
      for (let i = n - period; i < n; i++) sum += state.candles[i].close;
      state.maSeries[period].update({ time: last.time, value: Number((sum / period).toFixed(4)) });
    }
    state.tickBucket = bucket;
    return;
  }

  // 开始新的一根：时间必须严格大于上一根
  const nowSec = Math.floor(Date.now() / 1000);
  const time = last ? Math.max(last.time + bucketSec, nowSec) : nowSec;
  const c = { time, open: price, high: price, low: price, close: price };
  state.candles.push(c);
  if (state.candles.length > 1200) state.candles.shift();
  state.candleSeries.update(c);
  renderMAs();
  state.tickBucket = bucket;
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
  fillTpSlInputs();
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
  if (d.banned) {
    localStorage.removeItem('xd_token');
    document.body.innerHTML = '<div style="padding:40px;text-align:center;font-size:15px">'
      + '你的账号已被封禁' + (d.reason ? '：' + d.reason : '') + '</div>';
    return;
  }
  const m = state.market;
  if (!m) return;
  m.tick = d.tick;
  m.index.value = d.index;
  // 指数的各周期涨跌幅也要跟着更新，否则顶部读数会一直停在进页面时那一刻
  if (d.indexChanges) m.index.changes = d.indexChanges;
  if (Array.isArray(d.indexWeights)) m.index.weights = d.indexWeights;
  if (d.smallIndex) {
    m.smallIndex = m.smallIndex || {};
    m.smallIndex.value = d.smallIndex.value;
    if (Array.isArray(d.smallIndex.weights)) m.smallIndex.weights = d.smallIndex.weights;
    if (d.smallIndex.nextRebalanceTick !== undefined) {
      m.smallIndex.nextRebalanceTick = d.smallIndex.nextRebalanceTick;
    }
  }
  if (d.fx) m.fx = d.fx;
  m.index.series.push(d.index);
  if (m.index.series.length > 600) m.index.series.shift();
  m.events = d.events || [];
  // 公告也要跟着每轮更新，否则管理员发的公告只有刷新页面才看得到
  if (Array.isArray(d.notices)) m.notices = d.notices;

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
    // 各周期的涨跌幅也要跟着刷新，否则界面上一直显示进游戏那一刻的值
    if (s.changes) m.stocks[code].changes = s.changes;
    if (s.st !== undefined) m.stocks[code].st = s.st;
    if (s.stTicks !== undefined) m.stocks[code].stTicks = s.stTicks;
    if (s.fxTarget !== undefined) m.stocks[code].fxTarget = s.fxTarget;
    // 金融大鳄的预览状态每轮同步
    if (s.preview !== undefined) m.stocks[code].preview = s.preview;
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
  // ST 进度每轮都在变，刷一下标题区和列表徽章
  const curSt = state.market?.stocks?.[state.code];
  if (curSt && curSt.st !== undefined) renderStBanner(curSt);
  if (curSt) renderChartSub(curSt);
  renderReport();

  if ($('#view-work').classList.contains('active')) renderWork();
  if ($('#view-shop').classList.contains('active')) renderShop();
  if ($('#view-bank').classList.contains('active')) renderBank();
  if (state.tradeTab === 'log' && $('#logPane') && !$('#logPane').classList.contains('hidden')) {
    loadStockTrades();
  }
  if (state.tradeTab === 'tpsl' && $('#tpslPane') && !$('#tpslPane').classList.contains('hidden')) {
    renderTpSlStatus();
  }
  // 有成交（挂单被撮合 / 强平）就重拉一次自己的成交，B/S 标记才不会漏
  if ((d.orderEvents && d.orderEvents.length) || (d.closes && d.closes.length)) {
    loadMyTrades();
  } else {
    updateMarkers();
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
    const chg = listChange(s);
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
      if (a.guarded) toast(`🛡️ ${a.target} 身边有保镖，小偷被赶走了`, 'err');
      else toast(`小偷空手而归：${a.target} 身上没现金`, 'err');
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
    if (c && c.bonus > 0) {
      const isBear = state.market?.me?.theme === 'bear';
      toast(`${isBear ? '🐻 熊市加成' : '🐂 牛市加成'} +${money(c.bonus)}`, 'ok');
    }
    if (c && c.autoOrder && !c.qty) {
      toast(
        `${c.code} ${c.autoOrder === 'tp' ? '止盈' : '止损'}触发，已自动挂出平仓单`,
        'ok'
      );
    }
  }
  for (const c of list) {
    // qty 为 0 的是「止盈止损触发生成挂单」事件，不是真的平仓，不要报盈亏
    if (!c || !c.qty) continue;
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

/** 服务端冲击成本费率（口径必须和 src/trading.js#impactCostRate 一致） */
function impactRate(notional) {
  const cfg = state.market?.config || {};
  const coef = Math.max(0, Number(cfg.impactCostCoef ?? 6));
  if (coef <= 0) return 0;
  const ref = Math.max(1, Number(cfg.playerImpactRef ?? 300000));
  const strength = Math.max(0, Number(cfg.playerImpactStrength ?? 0.0009));
  const maxRate = Math.max(0, Number(cfg.impactCostMax ?? 0.06));
  return Math.min(maxRate, (Math.abs(notional) / ref) * strength * coef);
}

/** 冲击成本：指数按权重拆腿后各腿单独算，个股直接算 */
function impactCost(notional) {
  const st = state.market?.stocks?.[state.code] || {};
  if (!st.isIndex) return notional * impactRate(notional);
  const weights = state.market?.index?.weights || [];
  let sum = 0;
  for (const w of weights) {
    const leg = notional * Number(w.weight || 0);
    sum += leg * impactRate(leg);
  }
  return sum;
}

/** 下单成本拆解，口径与服务端冻结一致（含冲击成本） */
function orderCostParts(qty, price) {
  const cfg = state.market?.config || {};
  const lev = Math.max(1, Number($('#orderLev')?.value) || 1);
  const notional = Math.max(0, qty) * price;
  const margin = notional / lev;
  const fee = notional * (cfg.feeRate || 0);
  const stamp = state.side === 'short' ? notional * (cfg.stampDuty || 0) : 0;
  const impact = notional > 0 ? impactCost(notional) : 0;
  return { notional, margin, fee, stamp, impact, total: margin + fee + stamp + impact };
}

/** 参考价：买单按限价（成交价最高就是限价），卖单取限价与现价里更高的那个 */
function orderRefPrice() {
  const st = state.market?.stocks?.[state.code];
  const limitPx = Math.round(Number($('#orderLimit')?.value) * 100) / 100;
  const rawPrice = limitPx > 0 ? limitPx : Number(st?.price) || 0;
  return isBuySide() ? rawPrice : Math.max(rawPrice, Number(st?.price) || 0);
}

/** 当前现金 + 当前杠杆下能买的最大股数（含手续费、印花税、冲击成本） */
function maxAffordableQty() {
  const st = state.market?.stocks?.[state.code];
  if (!st) return 0;
  const cash = Number(state.market?.me?.cash) || 0;
  if (!(cash > 0)) return 0;
  const refPrice = orderRefPrice();
  if (!(refPrice > 0)) return 0;
  const budget = cash * 0.998;          // 留 0.2% 余量，防浮点误差
  const fits = (q) => orderCostParts(q, refPrice).total <= budget;
  if (!fits(1)) return 0;
  // 冲击成本随成交额非线性增长，用二分找真正买得起的股数
  let hi = 1;
  while (fits(hi) && hi < 1e9) hi *= 2;
  if (hi === 1) return 1;
  let lo = Math.floor(hi / 2);
  hi = Math.floor(hi);
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (fits(mid)) lo = mid; else hi = mid - 1;
  }
  return Math.max(0, lo);
}

function updateCostPreview() {
  const st = state.market?.stocks?.[state.code];
  if (!st) return;
  const qty = Number($('#orderQty').value) || 0;
  const lev = Math.max(1, Number($('#orderLev').value) || 1);
  const cfg = state.market.config || {};
  const refPrice = orderRefPrice();
  const parts = orderCostParts(qty, refPrice);
  $('#costNotional').textContent = money(parts.notional);
  $('#costMargin').textContent = money(parts.total);
  $('#costFee').textContent = money(parts.fee + parts.stamp);
  const ci = $('#costImpact');
  if (ci) ci.textContent = money(parts.impact);
  const levMin = Number(cfg.minLeverage ?? 1);
  const levMax = Number(cfg.maxLeverage ?? 20);
  $('#levLabel').textContent = `${lev}x（${levMin}~${levMax} 倍）`;
  // 爆仓价按「实际开仓价」算：挂了限价就按限价，而不是现价
  const basePx = refPrice > 0 ? refPrice : st.price;
  const liqPx = state.side === 'long' ? basePx * (1 - 1 / lev) : basePx * (1 + 1 / lev);
  if (liqPx <= 0.01) {
    $('#costLiq').textContent = '不会爆仓';
    $('#costLiq').className = 'flat';
  } else {
    $('#costLiq').textContent = liqPx.toFixed(2) + `（跌/涨 ${(100 / lev).toFixed(1)}% 就爆）`;
    $('#costLiq').className = 'down';
  }
  const closed = state.market?.marketOpen === false;
  $('.trade-panel')?.classList.toggle('is-closed', closed);
  // 按钮文案统一由 updateOrderBtnLabel 决定（要看开仓/平仓模式）
  updateOrderBtnLabel();
}



function positionSignature(pos) {
  return pos
    .map((p) => `${p.code}:${p.qty}:${p.side}:${(p.leverage || 1).toFixed(1)}:${p.closing || ''}`)
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
        <th>现价</th><th>浮动盈亏</th><th>保证金</th><th>爆仓价</th><th>操作</th>
      </tr></thead>
      <tbody>
        ${pos.map((p) => {
          const name = state.market.stocks[p.code]?.name || p.code;
          const lev = p.leverage || 1;
          const liq = p.side === 'long' ? p.entry * (1 - 1 / lev) : p.entry * (1 + 1 / lev);
          const icon = state.market.stocks[p.code]?.icon || '';
          return `<tr data-pos="${p.code}">
            <td><img class="stock-icon-sm" src="${icon}" alt="" />${escapeHtml(name)} <span class="stock-code">${p.code}</span></td>
            <td>
              <span class="pill ${p.side}">${p.side === 'long' ? '多' : '空'}</span>
              ${p.closing ? `<span class="pill warn">${p.closing === 'tp' ? '止盈中' : '止损中'}</span>` : ''}
            </td>
            <td data-cell="qty">${p.qty}</td>
            <td>${lev.toFixed(1)}x</td>
            <td>${p.entry.toFixed(2)}</td>
            <td data-cell="price">${p.price.toFixed(2)}</td>
            <td data-cell="pnl"><span class="${cls(p.pnl)}">${money(p.pnl)} <small>(${pct(p.margin > 0 ? (p.pnl / p.margin) * 100 : 0)})</small></span></td>
            <td data-cell="margin">${money(p.margin)}</td>
            <td class="down">${liq > 0 ? liq.toFixed(2) : '—'}</td>
            <td class="op-hint">用右上「平仓」挂单</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;

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
            const impactFee = Number(t.impact) || 0;
            const bonusFee = Number(t.bonus) || 0;
            const feeTitle = `手续费 ${money(t.fee)} + 印花税 ${money(t.stamp)}`
              + (impactFee > 0 ? ` + 冲击成本 ${money(impactFee)}` : '');
            const feeCell = (feeTotal > 0 || impactFee > 0)
              ? `<span class="fee-cell" title="${feeTitle}">${money(feeTotal + impactFee)}`
                + (impactFee > 0 ? `<i class="fee-impact">冲击 ${money(impactFee)}</i>` : '')
                + `</span>`
              : '<span class="stock-code">—</span>';
            const amountCell = t.action === 'close'
              ? money(t.returned ?? 0)
              : money(t.margin ?? 0);
            return `<tr>
              <td class="stock-code">${fmtTime(t.at)}</td>
              <td>${escapeHtml(t.name || t.code)}${t.code ? ` <span class="stock-code">${t.code}</span>` : ''}</td>
              <td>${isSteal ? (t.action === 'steal' ? '偷钱' : '被偷') : isOpen ? '开仓' : '平仓'}</td>
              <td>${isSteal ? '<span class="stock-code">—</span>' : `<span class="pill ${t.side}">${t.side === 'long' ? '多' : '空'}</span>`}</td>
              <td>${isSteal ? '—' : t.qty}</td>
              <td>${isSteal ? '—' : Number(t.price).toFixed(2)}</td>
              <td>${isSteal ? '—' : (t.leverage || 1).toFixed(1) + 'x'}</td>
              <td>${isSteal ? money(t.amount || 0) : amountCell}${bonusFee > 0 ? `<i class="fee-bonus">🐂 +${money(bonusFee)}</i>` : ''}</td>
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
    localization: {
      timeFormatter: (t) => fmtLocalTime(t, true)
    },
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
    timeScale: {
      borderVisible: false,
      timeVisible: true,
      secondsVisible: false,
      // 不要因为来了新数据就自动平移视图，否则用户缩放后每个 tick 都会被拽走
      shiftVisibleRangeOnNewBar: false,
      tickMarkFormatter: (t) => fmtLocalTime(t, false)
    },
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
    const ts = chart.timeScale();

    // 数据没变化就不重画，避免每轮都闪一下
    const lastPoint = totalData[totalData.length - 1];
    const sameAsBefore = state.eqLastCount === totalData.length
      && state.eqLastTime === lastPoint.time
      && state.eqLastValue === lastPoint.value;

    if (!sameAsBefore) {
      // 记录更新前的视野，以及用户是不是贴着最右边看最新数据
      const before = ts.getVisibleLogicalRange();
      const atRight = !before || !state.eqLastCount
        || before.to >= state.eqLastCount - 1.5;

      state.eqTotal.setData(totalData);
      state.eqTrading.setData(tradingData);
      state.eqLastCount = totalData.length;
      state.eqLastTime = lastPoint.time;
      state.eqLastValue = lastPoint.value;

      if (!state.eqFitted) {
        ts.fitContent();
        state.eqFitted = true;
      } else if (atRight) {
        // 用户在看最新数据 → 跟着走
        ts.scrollToRealTime();
      } else if (before) {
        // 用户缩放到别处在看历史 → 原样保持，不要动
        ts.setVisibleLogicalRange(before);
      }
    } else if (!state.eqFitted) {
      ts.fitContent();
      state.eqFitted = true;
    }

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
// ---------------- 丰川银行 ----------------
function renderBank() {
  const me = state.market?.me || {};
  const cfg = state.market?.config || {};
  const bank = Math.max(0, Number(me.bank) || 0);
  const deposited = Math.max(0, Number(me.bankDeposited) || 0);
  const equity = Math.max(0, Number(me.equity) || 0);
  const threshold = Math.max(0, Number(cfg.bankPoorThreshold ?? 100000));
  const perWithdraw = Math.max(1, Number(cfg.bankWithdrawAmount ?? 100000));
  const poor = equity < threshold;
  const canWithdraw = poor && bank > 0;
  const amount = Math.min(perWithdraw, bank);

  const amtEl = $('#bankAmount');
  if (amtEl) amtEl.textContent = money(bank);
  const depEl = $('#bankDepositLine');
  if (depEl) depEl.textContent = `累计存入 ${money(deposited)}`;
  const eqEl = $('#bankEquity');
  if (eqEl) eqEl.textContent = money(equity);
  const ruleEl = $('#bankRuleText');
  if (ruleEl) ruleEl.textContent = money0(threshold);
  const waEl = $('#bankWithdrawAmount');
  if (waEl) waEl.textContent = money0(perWithdraw);

  const st = $('#bankState');
  if (st) {
    if (canWithdraw) {
      st.textContent = '可以取钱';
      st.className = 'up';
    } else if (poor) {
      st.textContent = '银行没钱';
      st.className = '';
    } else {
      st.textContent = '未到门槛';
      st.className = '';
    }
  }

  const btn = $('#bankWithdrawBtn');
  if (btn) {
    btn.disabled = !canWithdraw;
    btn.classList.toggle('is-off', !canWithdraw);
  }

  const hint = $('#bankHint');
  if (hint) {
    if (!poor) {
      const gap = equity - threshold;
      hint.textContent = `总资产要低于 ${money0(threshold)} 才能取钱（现在还高出 ${money0(gap)}）`;
    } else if (bank <= 0) {
      hint.textContent = '银行里还没有存款：升级账号时交的钱会自动存进来';
    } else {
      hint.textContent = `这次可以取 ${money(amount)}，取完银行还剩 ${money(bank - amount)}`;
    }
  }
}

async function withdrawBank() {
  const btn = $('#bankWithdrawBtn');
  if (btn && btn.disabled) return;
  try {
    const r = await api('/api/bank/withdraw', { method: 'POST' });
    if (state.market?.me) {
      state.market.me.cash = r.cash;
      state.market.me.bank = r.bank;
      if (r.status) {
        state.market.me.equity = r.status.equity;
        state.market.me.bankDeposited = r.status.deposited;
      }
    }
    toast(`从银行取出 ${money(r.amount)}`, 'ok');
    renderBank();
    refreshMarket();
  } catch (e) {
    toast(e.message, 'err');
  }
}

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
    const meNow = state.market?.me || {};
    const tickNow = state.market?.tick || 0;
    const stealLeftNow = Math.max(0, (Number(meNow.stealReadyAt) || 0) - tickNow);
    const spyLeftNow = Math.max(0, (Number(meNow.investigateReadyAt) || 0) - tickNow);
    // 冷却秒数也算进签名，不然按钮上的倒计时不会刷新
    const sig = d.rows
      .map((r) => `${r.id}:${Math.round(r.equity)}:${r.cash.toFixed(0)}:${r.level || 1}:${r.nickname}`)
      .join('|') + `|${meNow.theme || 'default'}|${stealLeftNow}|${spyLeftNow}|${meNow.stealQueued ? 1 : 0}`;
    if (!force && sig === state.rankSig && wrap.querySelector('table')) {
      const t = $('#rankTime');
      if (t) t.textContent = '刚刚同步';
      return;
    }
    state.rankSig = sig;
    wrap.innerHTML = `
      <table>
        <thead><tr><th>#</th><th>玩家</th><th>等级</th><th>总资产</th><th>现金</th><th>操作</th></tr></thead>
        <tbody>
          ${d.rows.map((r, i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '';
            const mine = r.id === meNow.id ? 'rank-row-me' : '';
            const lvCell = lvBadgeHtml(r.level || 1);
            const cfg = state.market?.config || {};
            const queued = !!meNow.stealQueued;
            const isMe = r.id === meNow.id;
            const cdLeft = stealLeftNow;
            const spyLeft = spyLeftNow;
            const probeActive = meNow.theme === 'probe';
            let actionCell = '<span class="stock-code">—</span>';
            if (!isMe) {
              const parts = [];
              if (cdLeft > 0) {
                parts.push(`<span class="steal-cd" title="冷却结束后可以再偷">冷却 ${cdLeft}</span>`);
              } else if (queued) {
                parts.push('<span class="steal-done">已派出</span>');
              } else if (r.cash <= 0) {
                parts.push('<span class="stock-code">没现金</span>');
              } else {
                const capByEquity = Math.floor(r.equity * Number(cfg.stealCapRatio ?? 0.001));
                const maxTake = Math.max(0, Math.min(capByEquity, r.cash));
                parts.push(`<button class="steal-btn" data-steal="${r.id}" data-name="${escapeHtml(r.nickname)}" title="总资产 0.1% = ${money(capByEquity)}，实际最多能拿走 ${money(maxTake)}">偷钱</button>`);
              }
              // 暗中调查：装备了这个主题才会出现，就在「偷钱」旁边
              if (probeActive) {
                parts.push(spyLeft > 0
                  ? `<span class="spy-cd" title="调查冷却中">调查 ${spyLeft}</span>`
                  : `<button class="spy-btn" data-spy="${r.id}" data-name="${escapeHtml(r.nickname)}" title="随机查看他的一个持仓">调查</button>`);
              }
              actionCell = `<span class="rank-actions">${parts.join('')}</span>`;
            }
            return `<tr class="${mine}">
              <td><span class="rank-medal">${medal || i + 1}</span></td>
              <td><span class="rank-user">${rankAvatar(r)}<span class="rank-name">${escapeHtml(r.nickname)}</span></span></td>
              <td>${lvCell}</td>
              <td class="${cls(r.equity - 100000)}">${money(r.equity)}</td>
              <td>${money(r.cash)}</td>
              <td>${actionCell}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
    wrap.querySelectorAll('[data-steal]').forEach((b) => {
      b.addEventListener('click', () => stealFrom(b.dataset.steal, b.dataset.name));
    });
    wrap.querySelectorAll('[data-spy]').forEach((b) => {
      b.addEventListener('click', () => investigatePlayer(b.dataset.spy, b.dataset.name));
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
  const ch = escapeHtml((r.nickname || '?').trim().charAt(0) || '?');
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

// ---------------- 暗中调查（Lv.2 主题技能） ----------------
async function investigatePlayer(targetId, name) {
  try {
    const r = await api('/api/investigate', { method: 'POST', body: JSON.stringify({ targetId }) });
    if (state.market?.me) state.market.me.investigateReadyAt = r.readyAt;
    showSpyResult(r);
    loadRank(true);
  } catch (e) {
    toast(e.message, 'err');
  }
}

function showSpyResult(r) {
  const p = r.position;
  const box = $('#spyBody');
  if (!box) return;
  box.innerHTML = `
    <p class="spy-line">对象：<b>${escapeHtml(r.target.nickname)}</b></p>
    <div class="spy-pos">
      <div class="spy-code">${escapeHtml(p.name)} <span class="stock-code">${p.code}</span></div>
      <div class="spy-row"><span>方向</span><b class="${p.side === 'long' ? 'up' : 'down'}">${p.side === 'long' ? '做多' : '做空'}</b></div>
      <div class="spy-row"><span>数量</span><b>${p.qty} 股</b></div>
      <div class="spy-row"><span>杠杆</span><b>${(p.leverage || 1).toFixed(0)}x</b></div>
      <div class="spy-row"><span>成本价</span><b>${p.entry.toFixed(2)}</b></div>
      <div class="spy-row"><span>现价</span><b>${p.price.toFixed(2)}</b></div>
      <div class="spy-row"><span>浮动盈亏</span><b class="${cls(p.pnl)}">${money(p.pnl)}（${pct(p.pnlPct)}）</b></div>
      <div class="spy-row"><span>已持有</span><b>${p.heldTicks} 轮</b></div>
    </div>
    <p class="spy-hint">冷却 ${r.cooldownTicks} 轮 · 第 ${r.readyAt} 轮后可以再查</p>`;
  const m = $('#spyModal');
  if (m) {
    m.classList.remove('hidden');
    m.style.display = 'flex';
  }
}

function closeSpy() {
  const m = $('#spyModal');
  if (!m) return;
  m.style.display = 'none';
  m.classList.add('hidden');
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
  const tickNow = Number(d.tick) || 0;
  const notices = (d.notices || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  const nl = $('#noticeList');
  if (nl) {
    nl.innerHTML = notices.length
      ? notices.map((n) => {
        const expire = Number(n.expireTick) || 0;
        const leftText = expire > 0 ? `剩 ${Math.max(0, expire - tickNow)} 轮` : '永久';
        return `<div class="notice-row">
          <span class="notice-text">${escapeHtml(n.text)}</span>
          <span class="notice-left">${leftText}</span>
          <button class="mini-btn danger" data-del-notice="${n.id}">删除</button>
        </div>`;
      }).join('')
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
        ['maxFillNotionalPerTick', '每轮最多成交(金额)']
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
        ['playerImpactTail', '后续影响倍率(1=不变)'],
        ['playerImpactMax', '单轮最大影响'],
        ['playerImpactFlowMax', '压力上限'],
        ['impactCostCoef', '冲击成本系数(0=不收)'],
        ['impactCostMax', '冲击成本封顶(0.06=6%)']
      ]
    },
    {
      title: '新闻事件',
      desc: '消息怎么影响价格',
      fields: [
        ['eventChance', '新闻概率/tick'],
        ['eventImpactScale', '影响倍率(1=标准)'],
        ['eventDurationMin', '最短持续(轮)'],
        ['eventDurationMax', '最长持续(轮)'],
        ['globalEventScale', '全市场新闻折扣(0.2=20%)'],
        ['marketTradesEnabled', '随机成交开关(1=开)'],
        ['marketTradesRate', '随机成交倍率(3=三倍)']
      ]
    },
    {
      title: '账号等级 / 商店',
      desc: '升级门槛与花费',
      fields: [
        ['levelBaseAsset', '升级门槛基数(1000万)'],
        ['levelGrowth', '每级门槛倍数(2=翻倍)'],
        ['levelUpRatio', '升级花费比例(0.6=60%)'],
        ['levelFillBonus', '每级成交上限加成'],
        ['shopBgPrice', '自定义背景价格'],
        ['shopRenamePrice', '改名卡价格'],
        ['shopRenameCooldown', '改名冷却(轮)']
      ]
    },
    {
      title: '散户情绪',
      desc: '每只票独立，个股面板可单独调',
      fields: [
        ['sentimentEnabled', '开关(1=开 0=关)'],
        ['sentimentStrength', '基准偏移(0.004=0.4%)'],
        ['sentimentTicks', '每多少轮施加一次'],
        ['sentimentRollMin', '重掷周期下限(轮)'],
        ['sentimentRollMax', '重掷周期上限(轮)']
      ]
    },
    {
      title: '哈基蜂业抽奖',
      desc: '低概率瞬间暴涨暴跌',
      fields: [
        ['weatherLotteryChance', '触发概率/轮(0.0006≈每28分钟)'],
        ['weatherLotteryLo', '最小涨跌幅(0.12=12%)'],
        ['weatherLotteryHi', '最大涨跌幅(0.40=40%)']
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
      title: '商城',
      desc: '道具价格与效果',
      fields: [
        ['shopFakeNewsPrice', '假新闻售价'],
        ['shopFakeNewsChance', '生效概率(0.2=20%)'],
        ['shopFakeNewsCooldown', '假新闻冷却(轮)'],
        ['shopBodyguardPrice', '保镖售价'],
        ['shopBodyguardTicks', '保镖时长(轮)'],
        ['shopThemePrice', '主题售价'],
        ['shopChannelBasePrice', '通道首价'],
        ['shopChannelRatio', '通道涨价倍率'],
        ['shopChannelStep', '通道每级加成'],
        ['shopAutoDcaPrice', '自动定投售价'],
        ['shopAutoDcaPremium', '定投挂单溢价(0.03=+3%)']
      ]
    },
    {
      title: '现时活动',
      desc: '打倒量化资本',
      fields: [
        ['activityEnabled', '活动开关(1=开)'],
        ['activityThreshold', '触发阈值(资产)'],
        ['activityReward', '平分总金额'],
        ['activityCooldownMinutes', '同一目标冷却(分钟)']
      ]
    },
    {
      title: '暗中调查',
      desc: 'Lv.2 主题技能：查别人的持仓',
      fields: [
        ['investigateCooldownTicks', '调查冷却(轮)']
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
  floorBoost: ['护盘加成', '每轮往上托多少'],
  // 实时汇率（只有留美外汇有）
  fxEnabled: ['汇率驱动(1=开)', '1 由 AUD/JPY 驱动，0 纯随机'],
  coef: ['汇率系数', '汇率涨跌放大倍数'],
  lev: ['汇率杠杆', '和系数相乘，越大越猛'],
  refreshMs: ['抓取间隔(毫秒)', '多久拉一次汇率，最快 15000'],
  track: ['靠拢比例', '每轮向目标价靠 多少，0.06=6%'],
  // 散户情绪（每只票独立）
  sentStrength: ['散户情绪强度', '情绪 1.0 时的基准偏移，0.004=0.4%'],
  sentTicks: ['情绪作用间隔(轮)', '每多少轮施加一次偏移，12=1分钟'],
  sentRollMin: ['情绪重掷周期下限(轮)', '每次重掷从「下限~上限」里随机抽一个周期，480=40分钟'],
  sentRollMax: ['情绪重掷周期上限(轮)', '和下限一起决定随机区间，960=80分钟']
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
      <div class="stock-admin-row">
        <span class="sa-label">标的管理</span>
        <input class="as-price" type="number" step="0.01" min="0.01"
          data-price-for="${st.code}" value="${Number(st.price).toFixed(2)}" title="直接改这只票的价格" />
        <button class="mini-btn" data-act="set" data-code="${st.code}">设置价</button>
        <button class="mini-btn" data-act="suspend" data-code="${st.code}">停牌</button>
        <button class="mini-btn" data-act="resume" data-code="${st.code}">复牌</button>
        <button class="mini-btn danger" data-act="delist" data-code="${st.code}">退市</button>
        <span class="pill ${st.status === 'normal' ? 'gray' : 'short'}">${st.status === 'normal' ? '正常' : st.status === 'suspended' ? '停牌中' : '已退市'}</span>
      </div>
      <div class="trait-head">
        <img class="stock-icon-sm" src="${st.icon
          || state.market?.stocks?.[st.code]?.icon
          || '/assets/stocks/' + st.code + '.png'}" alt="" onerror="this.style.visibility='hidden'" />
        <b>${st.name}</b>
        <span class="stock-code">${st.code}</span>
        <span class="trait-tag">${st.traitName || '—'}</span>
      </div>
      ${fields ? `<div class="cfg-grid">${fields}</div>` : '<div class="trait-empty">这只票没有可调参数</div>'}
    </section>`;
  }).join('');

  // 个股卡片里的「设置价 / 停牌 / 复牌 / 退市」
  $$('#traitForm [data-act]').forEach((b) => {
    b.addEventListener('click', async () => {
      const payload = { action: b.dataset.act, code: b.dataset.code, hours: 1 };
      if (b.dataset.act === 'set') {
        const inp = document.querySelector(`.as-price[data-price-for="${b.dataset.code}"]`);
        const v = Number(inp && inp.value);
        if (!(v > 0)) { toast('先填一个大于 0 的价格', 'err'); return; }
        payload.price = v;
      }
      try {
        await adminApi('/api/admin/stock', payload);
        toast(payload.price ? `价格已设为 $${payload.price}` : '操作成功', 'ok');
        loadAdmin();
        refreshMarket();
      } catch (e) { toast(e.message, 'err'); }
    });
  });
  $$('#traitForm .as-price').forEach((inp) => {
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const btn = document.querySelector(
        `#traitForm [data-act="set"][data-code="${inp.dataset.priceFor}"]`);
      if (btn) btn.click();
    });
  });
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
  // 显示时长（轮）：0 = 永久
  const rawTicks = Number($('#noticeTicks')?.value);
  const ticks = Number.isFinite(rawTicks) && rawTicks > 0 ? Math.round(rawTicks) : 0;
  try {
    await adminApi('/api/admin/announce', { text, ticks });
    toast(ticks > 0 ? `公告已发布，${ticks} 轮后自动消失` : '公告已发布（永久）', 'ok');
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
  if (name === 'shop') renderShop();
  if (name === 'bank') renderBank();
  // 切换标签时退回列表态（手机上从个股详情回到列表）
  document.body.classList.remove('m-detail');
  if (name === 'admin') {
    if (typeof loadAdminPlayers === 'function') loadAdminPlayers();
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
      if (state.orderMode === 'close') return;   // 平仓模式不切方向
      state.side = b.dataset.side;
      $$('#sideSwitch .side-btn').forEach((x) => x.classList.toggle('active', x === b));
      // 方向变了，自动价的让利方向也要跟着变
      if (state.limitAuto) syncLimitPrice(true);
      updateOrderBtnLabel();
      updateCostPreview();
    });
  });

  // 快捷分仓：开仓按「能买多少」，平仓按「持仓多少」
  $$('.quick-qty button').forEach((b) => {
    b.addEventListener('click', () => {
      const frac = Number(b.dataset.frac) || 1;
      const isClose = (state.orderMode || 'open') === 'close';
      const pos = state.market?.me?.positions?.[state.code];
      const base = isClose ? Math.floor(pos?.qty || 0) : maxAffordableQty();
      if (!(base > 0)) {
        if (isClose) toast('这只票没有持仓', 'err');
        return;
      }
      $('#orderQty').value = Math.max(1, Math.floor(base * frac));
      updateCostPreview();
    });
  });

  ['#orderQty', '#orderLev'].forEach((sel) => {
    $(sel).addEventListener('input', updateCostPreview);
  });
  $('#orderLimit')?.addEventListener('input', () => {
    state.limitAuto = false;
    updateLimitLine(Number($('#orderLimit').value));
  });
  // 手动输入止盈止损
  $('#tpslApply')?.addEventListener('click', applyTpSl);
  ['#tpPrice', '#slPrice', '#tpslQty'].forEach((sel) => {
    $(sel)?.addEventListener('input', () => { state.tpslEdited = true; });
  });
  $('#reportBtn')?.addEventListener('click', toggleReportPanel);
  document.querySelectorAll('[data-tier-tab]').forEach((b) => {
    b.addEventListener('click', () => switchShopTier(b.dataset.tierTab));
  });
  $('#levelUpBtn')?.addEventListener('click', levelUp);
  $('#bgBuy')?.addEventListener('click', buyBg);
  $('#bgUpload')?.addEventListener('click', pickBgImage);
  $('#renameBuy')?.addEventListener('click', buyRename);
  $('#autoDcaBuy')?.addEventListener('click', buyAutoDca);
  $('#autoDcaToggle')?.addEventListener('click', toggleAutoDca);
  $('#orderBtn').addEventListener('click', placeLimit);

  // 暗中调查弹窗
  $('#spyClose')?.addEventListener('click', closeSpy);
  $('#spyOk')?.addEventListener('click', closeSpy);
  $('#spyModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'spyModal') closeSpy();
  });

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
  $('#bankWithdrawBtn')?.addEventListener('click', withdrawBank);
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
  document.querySelectorAll('.dir-btn').forEach((b) => {
    b.addEventListener('click', () => {
      state.shopDir = Number(b.dataset.dir) || 1;
      renderShop();
    });
  });
  $('#fakeNewsBuy')?.addEventListener('click', buyFakeNews);
  $('#bodyguardBuy')?.addEventListener('click', buyBodyguard);
  $('#banSearch')?.addEventListener('input', renderBanList);
  $('#channelBuy')?.addEventListener('click', buyChannel);
  $('#mBackBtn')?.addEventListener('click', () => {
    document.body.classList.remove('m-detail');
    resizeChartNow();
  });
  document.querySelectorAll('.theme-btn').forEach((b) => {
    b.addEventListener('click', () => chooseTheme(b.dataset.themeCode));
  });
  $('#traitSaveBtn')?.addEventListener('click', saveTraits);

  // 定时刷新「我的」与「排行」，保证不靠 SSE 也准确
  setInterval(() => {
    if ($('#view-work').classList.contains('active')) renderWork();
  }, 1000);
}

// 调试用：把 state 挂到 window，方便排查问题（不含任何服务端秘密）
try { window.__xd = { state, priceAtY, updateLimitLine, autoLimitPrice, setLimitPrice }; window.__xdState = state; } catch { /* ignore */ }

// ---------------- 启动 ----------------
async function boot() {
  applyCachedTheme();
  initSlipInput();
  bind();
  if (state.token) {
    try {
      const d = await api('/api/market');
      if (!d.me) throw new Error('未登录');
      state.market = d;
      state.me = d.me;
      if (d.build) state.build = d.build;
      await enterGame();
      syncThemeFromServer();
      return;
    } catch (e) {
      console.error('[boot] 恢复登录失败:', e && (e.message || e));
      localStorage.removeItem('xd_token');
      state.token = '';
    }
  }
  showLogin();
}

// PWA：只在安全上下文（https/localhost）注册 Service Worker，
// 用 http://IP 直接访问时浏览器会拒绝，这里静默跳过
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

boot();
