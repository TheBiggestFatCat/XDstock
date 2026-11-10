// 锦标赛：独立赛区，唯一标的 LMFX（留美外汇）
//
// 设计约束（和主市场的关系）：
//   · 完全独立的一套账：自己的现金（日元）、自己的持仓、自己的价格序列，
//     不碰 db.players / db.stocks，主市场一行都不受影响。
//   · 只挂在主循环的末尾跑一步（server.js#tourTick），赢了就 frozen，价格与成交一起冻结。
//   · 标的机制：股价就是实时汇率 —— 每轮直接取抓到的 AUD/JPY 原值，
//     不归一化、不放大、不叠加溢价、不记成交冲击，报价和任何行情软件上的 AUD/JPY 完全一致。
//     汇率由 server.js#tourFxLoop 定时抓取（src/fx.js），本模块只负责读最新值。
//   · 这里不 import 任何模块，避免 store.js → tour.js → engine.js → store.js 的循环引用。

/** 起手资金：30 万日元 */
export const TOUR_START_CASH = 300000;
/** 夺冠线：2000 万日元（剧情里妈妈亏掉的数） */
export const TOUR_TARGET = 20000000;
/** 手续费：0 —— 零摩擦，进出只按价格差结算（1000 倍杠杆下任何费率都会吃掉大块保证金） */
export const TOUR_FEE_RATE = 0;
export const TOUR_MAX_LEVERAGE = 1000;
/**
 * 报价序列上限（每个 tick 一个点）——和主站 config.historyTicks 同一口径：
 * 5 秒 × 3600 = 5 小时，正好铺满 1 分钟图的 300 根。
 */
const SERIES_MAX = 3600;
/**
 * 三个周期各自保留多少根，根数照抄主站：
 * 1m 300 根 = 5 小时、5m 300 根 = 25 小时、15m 192 根 = 48 小时。
 * 单靠 5 秒的 series 攒不出 25/48 小时，所以历史部分由 setTourHist 从真实行情补进来。
 */
export const TOUR_TFS = {
  '1m': { sec: 60, max: 300 },
  '5m': { sec: 300, max: 300 },
  '15m': { sec: 900, max: 192 }
};
const TRADE_LOG_MAX = 120;
const PLAYER_LOG_MAX = 24;

function num(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function r2(v) {
  return Math.round(v * 100) / 100;
}

/** 报价保留 3 位小数：AUD/JPY 的零售报价就是 109.018 这个精度 */
function r3(v) {
  return Math.round(v * 1000) / 1000;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function yen(v) {
  return '¥' + Math.round(num(v)).toLocaleString('en-US');
}

/** 下一个 21:00（服务器本地时间）。已经过了今晚 9 点就排到明晚 */
export function nextStartAt(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 21, 0, 0, 0);
  if (t.getTime() <= nowMs) t.setDate(t.getDate() + 1);
  return t.getTime();
}

export function createTour(nowMs = Date.now()) {
  return {
    createdAt: nowMs,
    startAt: nextStartAt(nowMs),
    startedAt: 0,
    endedAt: 0,
    frozen: false,
    tick: 0,
    winner: null,
    fx: { rate: 0, at: 0, source: '', stale: true },
    stock: {
      code: 'LMFX',
      name: '留美外汇',
      icon: '/assets/stocks/LMFX.jpeg',
      industry: '金融',
      desc: '外汇自营、套息交易、高杠杆',
      price: 0,
      prev: 0,
      series: [],
      seriesAt: [],
      // 历史 K 线包（1m / 5m / 15m），每个是一串标准 OHLC，按时间升序
      hist: { '1m': [], '5m': [], '15m': [] },
      histAt: 0
    },
    players: {},
    trades: [],
    jobs: 0
  };
}

/** 老存档没有 tour 字段时补一份；字段缺了也顺手补齐 */
export function ensureTour(db) {
  if (!db.tour || typeof db.tour !== 'object') {
    db.tour = createTour();
    return db.tour;
  }
  const t = db.tour;
  const base = createTour();
  for (const [k, v] of Object.entries(base)) {
    if (t[k] === undefined || t[k] === null) t[k] = v;
  }
  if (!t.stock || typeof t.stock !== 'object') t.stock = base.stock;
  for (const [k, v] of Object.entries(base.stock)) {
    if (t.stock[k] === undefined || t.stock[k] === null) t.stock[k] = v;
  }
  delete t.stock.initialPrice;   // 不再用初始价，股价就是汇率原值
  if (!Array.isArray(t.stock.series)) t.stock.series = [];
  // 每个点配一个时间戳（K 线的 x 轴用），老存档缺这半边就按 tickMs 反推补上
  if (!Array.isArray(t.stock.seriesAt)) t.stock.seriesAt = [];
  if (t.stock.seriesAt.length !== t.stock.series.length) {
    const step = Math.max(1000, num(db.config?.tickMs, 5000));
    const n = t.stock.series.length;
    const tail = num(t.fx?.at, Date.now());
    t.stock.seriesAt = t.stock.series.map((_, i) => tail - (n - 1 - i) * step);
  }
  if (!t.fx || typeof t.fx !== 'object') t.fx = {};
  for (const [k, v] of Object.entries(base.fx)) {
    if (t.fx[k] === undefined || t.fx[k] === null) t.fx[k] = v;
  }
  delete t.fx.base;              // 老存档的归一化基准，一并清掉
  if (!(num(t.fx.rate) > 0)) t.fx.rate = 0;
  // 历史包：老存档没有就补空包
  if (!t.stock.hist || typeof t.stock.hist !== 'object') t.stock.hist = { '1m': [], '5m': [], '15m': [] };
  for (const tf of Object.keys(TOUR_TFS)) {
    if (!Array.isArray(t.stock.hist[tf])) t.stock.hist[tf] = [];
  }
  if (!(num(t.stock.histAt) > 0)) t.stock.histAt = 0;
  if (!t.players || typeof t.players !== 'object') t.players = {};
  if (!Array.isArray(t.trades)) t.trades = [];
  return t;
}

export function tourStatus(t) {
  if (!t) return 'pending';
  if (t.frozen) return 'ended';
  return t.startedAt ? 'running' : 'pending';
}

/**
 * 到点自动开赛。
 * 本地调试时不想到点等 21:00，可以 `XD_TOUR_OPEN=1 node server.js` 强行开赛
 * （只读环境变量，线上不设就完全没影响）。
 */
function maybeStart(t) {
  if (!t || t.frozen || t.startedAt) return;
  const nowMs = Date.now();
  if (nowMs >= num(t.startAt) || process.env.XD_TOUR_OPEN === '1') {
    t.startedAt = nowMs;
    t.tick = num(t.tick);
  }
}

/** 守卫：没开赛 / 已结束 / 汇率还没接上都拒绝下单 */
function guard(t) {
  if (!t) return { ok: false, error: '锦标赛还没初始化' };
  if (t.frozen) return { ok: false, error: '锦标赛已结束，行情已冻结' };
  if (!t.startedAt) {
    const left = Math.max(0, num(t.startAt) - Date.now());
    const min = Math.ceil(left / 60000);
    // 别写死时间：赛程随时可能改，统一从 startAt 算
    const at = new Date(num(t.startAt));
    const pad = (x) => String(x).padStart(2, '0');
    const when = `${at.getMonth() + 1}/${at.getDate()} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
    return {
      ok: false,
      error: left > 0 ? `锦标赛 ${when} 开赛，还有约 ${min} 分钟` : '锦标赛即将开始，稍等一轮'
    };
  }
  if (!(num(t.fx.rate) > 0)) return { ok: false, error: '汇率还没接上，稍后再试' };
  return null;
}

/** 参赛账号：第一次进来就开户，之后复用 */
export function joinTour(t, player) {
  if (!player) return null;
  let g = t.players[player.id];
  if (!g) {
    g = {
      id: player.id,
      nickname: player.nickname || '匿名',
      cash: TOUR_START_CASH,
      startCash: TOUR_START_CASH,
      positions: {},
      jobs: 0,
      opens: 0,
      closes: 0,
      liquidations: 0,
      joinedAt: Date.now(),
      log: []
    };
    t.players[player.id] = g;
  } else if (player.nickname && g.nickname !== player.nickname) {
    g.nickname = player.nickname;   // 改名跟着走
  }
  return g;
}

export function tourEquity(t, g) {
  let e = num(g.cash);
  const pos = g.positions && g.positions.LMFX;
  if (pos) {
    const dir = pos.side === 'long' ? 1 : -1;
    e += num(pos.margin) + (num(t.stock.price) - num(pos.entry)) * num(pos.qty) * dir;
  }
  return e;
}

function logTourTrade(t, g, row) {
  const rec = { at: Date.now(), tick: t.tick, ...row };
  g.log.push(rec);
  if (g.log.length > PLAYER_LOG_MAX) g.log.splice(0, g.log.length - PLAYER_LOG_MAX);
  t.trades.push(rec);
  if (t.trades.length > TRADE_LOG_MAX) t.trades.splice(0, t.trades.length - TRADE_LOG_MAX);
}

/**
 * 价格走一步：股价 = 抓到的 AUD/JPY 原值。
 * 不归一化、不放大、不吃成交冲击 —— 抓不到新汇率就原地不动，绝不自己编一个数出来。
 */
function stepPrice(t) {
  const rate = num(t.fx.rate, 0);
  if (!(rate > 0)) return;
  // 每轮都落一个点：汇率 10 秒才更新一次，价格没变时画平线，时间轴才和真实分时图一致
  const px = r3(rate);
  t.stock.prev = num(t.stock.price, px);
  t.stock.price = px;
  t.stock.series.push(px);
  if (!Array.isArray(t.stock.seriesAt)) t.stock.seriesAt = [];
  t.stock.seriesAt.push(Date.now());
  if (t.stock.series.length > SERIES_MAX) {
    const cut = t.stock.series.length - SERIES_MAX;
    t.stock.series.splice(0, cut);
    t.stock.seriesAt.splice(0, cut);
  }
}

/**
 * 写入一次抓取结果（server.js#tourFxLoop 调用）。
 * 抓失败传 rate <= 0：只标 stale，价格保持上一次的值。
 * 还没开赛时把第一个报价对齐，免得开赛第一轮从 0 跳一大截；
 * 之后的走势由 tourTick 里的 stepPrice 逐轮追加，这里不再重置序列。
 */
export function setTourRate(db, rate, at = Date.now(), source = '') {
  const t = ensureTour(db);
  const v = num(rate, 0);
  if (!(v > 0)) {
    t.fx.stale = true;
    return false;
  }
  t.fx.rate = v;
  t.fx.at = num(at, Date.now());
  t.fx.source = String(source || '');
  t.fx.stale = false;
  if (!t.startedAt && !t.frozen && !t.stock.series.length) {
    t.stock.prev = r3(v);
    t.stock.price = r3(v);
    t.stock.series = [t.stock.price];
    t.stock.seriesAt = [num(at, Date.now())];
  }
  return true;
}

/**
 * 写入一段历史 K 线（server.js#refreshTourHist 调用）。
 * 只收最后 TOUR_TFS[tf].max 根，按时间升序、同一时间覆盖旧的。
 */
export function setTourHist(db, tf, bars, at = Date.now()) {
  const t = ensureTour(db);
  const cfg = TOUR_TFS[tf];
  if (!cfg || !Array.isArray(bars) || !bars.length) return false;
  const byTime = new Map();
  for (const b of bars) {
    const time = num(b.time, 0);
    const close = num(b.close, 0);
    const open = num(b.open, close);
    if (!(time > 0) || !(close > 0) || !(open > 0)) continue;
    byTime.set(time, {
      time,
      open,
      high: Math.max(num(b.high, close), open, close),
      low: Math.min(num(b.low, close) || open, open, close),
      close
    });
  }
  if (!byTime.size) return false;
  t.stock.hist[tf] = [...byTime.values()].sort((a, b) => a.time - b.time).slice(-cfg.max);
  t.stock.histAt = num(at, Date.now());
  return true;
}

/** 5 秒报价点 → 指定周期的 OHLC（和主站 candlesFromSeries 一个口径） */
function barsFromSeries(t, sec) {
  const out = [];
  const series = Array.isArray(t.stock.series) ? t.stock.series : [];
  const at = Array.isArray(t.stock.seriesAt) ? t.stock.seriesAt : [];
  for (let i = 0; i < series.length; i++) {
    const px = num(series[i], 0);
    const ts = num(at[i], 0);
    if (!(px > 0) || !(ts > 0)) continue;
    const time = Math.floor(ts / 1000 / sec) * sec;
    const last = out[out.length - 1];
    if (!last || last.time !== time) {
      out.push({ time, open: px, high: px, low: px, close: px });
    } else {
      if (px > last.high) last.high = px;
      if (px < last.low) last.low = px;
      last.close = px;
    }
  }
  return out;
}

/**
 * 某周期的完整 K 线：历史包打底 + 实时聚合接在后面，条数和主站一致（300/300/192）。
 * 接缝按时间裁：历史里和实时重叠的那几根（含正在走的那根）一律让给实时数据，
 * 否则会出现两根时间戳相同、OHLC 却不一致的柱子。
 */
export function tourCandles(db, tf = '1m') {
  const t = ensureTour(db);
  const cfg = TOUR_TFS[tf] || TOUR_TFS['1m'];
  const live = barsFromSeries(t, cfg.sec);
  const firstLive = live.length ? live[0].time : Infinity;
  const hist = (t.stock.hist[tf] || []).filter((b) => num(b.time, 0) < firstLive);
  return {
    tf,
    tickMs: num(db.config?.tickMs, 5000),
    histAt: num(t.stock.histAt),
    candles: hist.concat(live).slice(-cfg.max)
  };
}

/** 爆仓线：保证金只剩 5% 时强平 */
function settleOne(t, g) {
  const pos = g.positions && g.positions.LMFX;
  if (!pos) return;
  const dir = pos.side === 'long' ? 1 : -1;
  const pnl = (num(t.stock.price) - num(pos.entry)) * num(pos.qty) * dir;
  if (num(pos.margin) + pnl > num(pos.margin) * 0.05) return;
  const back = Math.max(0, num(pos.margin) + pnl);
  g.cash += back;
  g.liquidations = (g.liquidations || 0) + 1;
  logTourTrade(t, g, {
    action: 'liquidate',
    code: pos.code,
    side: pos.side,
    qty: pos.qty,
    price: num(t.stock.price),
    pnl: r2(pnl),
    cash: r2(g.cash)
  });
  delete g.positions.LMFX;
}

/** 第一个权益摸到 2000 万的人夺冠，随后整个赛区冻结 */
function checkWinner(t) {
  if (t.frozen) return;
  let best = null;
  for (const g of Object.values(t.players)) {
    const eq = tourEquity(t, g);
    if (eq >= TOUR_TARGET && (!best || eq > best.eq)) best = { g, eq };
  }
  if (!best) return;
  t.frozen = true;
  t.endedAt = Date.now();
  t.winner = {
    id: best.g.id,
    nickname: best.g.nickname,
    equity: r2(best.eq),
    tick: t.tick,
    at: t.endedAt
  };
}

/** 主循环每轮调一次 */
export function tourTick(db) {
  const t = ensureTour(db);
  if (t.frozen) return;
  maybeStart(t);
  // 还没开赛：走势图照样跟着实时汇率走，玩家一进页面就能看到真实行情在动；
  // 但不加 tick、不结算、不判胜，交易仍被 guard() 锁着（要等 startAt 到点）
  if (!t.startedAt) {
    stepPrice(t);
    return;
  }
  t.tick += 1;
  stepPrice(t);
  for (const g of Object.values(t.players)) settleOne(t, g);
  checkWinner(t);
}

/** 开仓（市价，立刻按现价成交） */
export function tourOpen(db, player, body = {}) {
  maybeStart(db.tour);
  const t = ensureTour(db);
  const blocked = guard(t);
  if (blocked) return blocked;
  const g = joinTour(t, player);
  if (!g) return { ok: false, error: '先登录再参赛' };

  const side = body.side === 'short' ? 'short' : 'long';
  const leverage = clamp(Math.round(num(body.leverage, 1)), 1, TOUR_MAX_LEVERAGE);
  const qty = Math.floor(num(body.qty));
  if (!(qty > 0)) return { ok: false, error: '数量必须是正整数' };

  const price = num(t.stock.price);
  if (!(price > 0)) return { ok: false, error: '行情异常，稍后再试' };

  const exist = g.positions.LMFX;
  if (exist && exist.side !== side) {
    return { ok: false, error: '已经有反向持仓，先平掉再开' };
  }

  const notional = qty * price;
  const margin = notional / leverage;
  const fee = notional * TOUR_FEE_RATE;
  const need = margin + fee;
  if (g.cash < need) {
    return {
      ok: false,
      error: `现金不足，需要 ${yen(need)}，你只有 ${yen(g.cash)}`
    };
  }

  g.cash -= need;
  if (!exist) {
    g.positions.LMFX = {
      code: 'LMFX',
      side,
      qty,
      entry: price,
      margin,
      leverage,
      openedTick: t.tick
    };
  } else {
    const total = exist.qty + qty;
    exist.entry = (num(exist.entry) * num(exist.qty) + price * qty) / total;
    exist.qty = total;
    exist.margin = num(exist.margin) + margin;
    exist.leverage = (exist.qty * exist.entry) / exist.margin;
  }

  g.opens = (g.opens || 0) + 1;
  logTourTrade(t, g, {
    action: 'open',
    code: 'LMFX',
    side,
    qty,
    price,
    leverage,
    fee: r2(fee),
    cash: r2(g.cash)
  });
  checkWinner(t);
  return {
    ok: true,
    price,
    qty,
    side,
    leverage,
    cash: r2(g.cash),
    equity: r2(tourEquity(t, g))
  };
}

/** 平仓（不传 qty = 全平） */
export function tourClose(db, player, body = {}) {
  maybeStart(db.tour);
  const t = ensureTour(db);
  const blocked = guard(t);
  if (blocked) return blocked;
  const g = joinTour(t, player);
  if (!g) return { ok: false, error: '先登录再参赛' };

  const pos = g.positions.LMFX;
  if (!pos) return { ok: false, error: '没有持仓可平' };

  let qty = Math.floor(num(body.qty, 0));
  if (!(qty > 0) || qty > pos.qty) qty = pos.qty;

  const price = num(t.stock.price);
  const dir = pos.side === 'long' ? 1 : -1;
  const pnl = (price - num(pos.entry)) * qty * dir;
  const marginPart = (num(pos.margin) * qty) / Math.max(1, num(pos.qty));
  const fee = qty * price * TOUR_FEE_RATE;

  g.cash += marginPart + pnl - fee;
  pos.qty -= qty;
  pos.margin = Math.max(0, num(pos.margin) - marginPart);
  if (pos.qty <= 0) delete g.positions.LMFX;

  g.closes = (g.closes || 0) + 1;
  logTourTrade(t, g, {
    action: 'close',
    code: 'LMFX',
    side: pos.side,
    qty,
    price,
    pnl: r2(pnl),
    fee: r2(fee),
    cash: r2(g.cash)
  });
  checkWinner(t);
  return {
    ok: true,
    price,
    qty,
    pnl: r2(pnl),
    cash: r2(g.cash),
    equity: r2(tourEquity(t, g))
  };
}

/** 打工：现金不足 30 万时一次性补齐，无次数限制 */
export function tourJob(db, player) {
  maybeStart(db.tour);
  const t = ensureTour(db);
  const blocked = guard(t);
  if (blocked) return blocked;
  const g = joinTour(t, player);
  if (!g) return { ok: false, error: '先登录再参赛' };

  if (g.cash >= TOUR_START_CASH) {
    return { ok: false, error: `手里还有 ${yen(g.cash)}，不用打工` };
  }
  const before = g.cash;
  g.cash = TOUR_START_CASH;
  g.jobs = (g.jobs || 0) + 1;
  t.jobs = (t.jobs || 0) + 1;
  return { ok: true, gained: r2(TOUR_START_CASH - before), cash: g.cash, jobs: g.jobs };
}

function rankRows(db, t) {
  // 只算还在的账号：管理员删号后赛区里会留一条孤儿记录，别让它挂在榜上
  const rows = Object.values(t.players).filter((g) => db.players && db.players[g.id]).map((g) => {
    const eq = tourEquity(t, g);
    return {
      id: g.id,
      nickname: g.nickname,
      equity: r2(eq),
      cash: r2(g.cash),
      retPct: Math.round(((eq / Math.max(1, num(g.startCash, TOUR_START_CASH))) - 1) * 1000) / 10,
      jobs: g.jobs || 0,
      inPosition: !!g.positions.LMFX
    };
  });
  rows.sort((a, b) => b.equity - a.equity || a.nickname.localeCompare(b.nickname));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

/** 给前端的快照（只读，不含任何内部压力/概率） */
export function tourState(db, player) {
  const t = ensureTour(db);
  maybeStart(t);
  const status = tourStatus(t);
  const me = player ? joinTour(t, player) : null;
  const rows = rankRows(db, t);
  // 涨跌幅基准：1 分钟历史包最老一根的开盘价（5 小时前，和图上第一根柱子对齐）。
  // 拿不到历史包时退回实时序列的第一个点，再不行就用现价（显示 0.00%）
  const h1 = t.stock.hist['1m'];
  const first = h1 && h1.length
    ? num(h1[0].open, t.stock.price)
    : (t.stock.series.length ? num(t.stock.series[0]) : t.stock.price);

  let myRank = null;
  if (me) {
    const hit = rows.find((r) => r.id === me.id);
    if (hit) myRank = hit.rank;
  }

  return {
    ok: true,
    status,
    startAt: num(t.startAt),
    startedAt: num(t.startedAt),
    endedAt: num(t.endedAt),
    tick: num(t.tick),
    tickMs: num(db.config?.tickMs, 5000),
    target: TOUR_TARGET,
    startCash: TOUR_START_CASH,
    feeRate: TOUR_FEE_RATE,
    maxLeverage: TOUR_MAX_LEVERAGE,
    winner: t.winner || null,
    jobs: num(t.jobs),
    players: rows.length,
    stock: {
      code: t.stock.code,
      name: t.stock.name,
      icon: t.stock.icon,
      industry: t.stock.industry,
      desc: t.stock.desc,
      price: r3(t.stock.price),
      prev: r3(t.stock.prev),
      changePct: first > 0 ? Math.round(((t.stock.price / first) - 1) * 10000) / 100 : 0,
      fxRate: r3(t.fx.rate),
      fxAt: num(t.fx.at),
      fxSource: t.fx.source || '',
      fxStale: t.fx.stale !== false,
      // K 线不在这里发：三个周期各自走 /api/tour/candles?tf=
      histAt: num(t.stock.histAt)
    },
    me: me
      ? {
        id: me.id,
        nickname: me.nickname,
        cash: r2(me.cash),
        equity: r2(tourEquity(t, me)),
        retPct: Math.round(((tourEquity(t, me) / Math.max(1, num(me.startCash, TOUR_START_CASH))) - 1) * 1000) / 10,
        rank: myRank,
        jobs: me.jobs || 0,
        opens: me.opens || 0,
        closes: me.closes || 0,
        liquidations: me.liquidations || 0,
        position: me.positions.LMFX
          ? {
            code: 'LMFX',
            side: me.positions.LMFX.side,
            qty: me.positions.LMFX.qty,
            entry: r3(me.positions.LMFX.entry),
            margin: r2(me.positions.LMFX.margin),
            leverage: Math.round(num(me.positions.LMFX.leverage, 1) * 10) / 10,
            pnl: r2(
              (num(t.stock.price) - num(me.positions.LMFX.entry))
              * num(me.positions.LMFX.qty)
              * (me.positions.LMFX.side === 'long' ? 1 : -1)
            )
          }
          : null,
        log: (me.log || []).slice(-12).reverse()
      }
      : null,
    ranks: rows.slice(0, 50)
  };
}
