// 锦标赛：独立赛区，唯一标的 LMFX（留美外汇）
//
// 设计约束（和主市场的关系）：
//   · 完全独立的一套账：自己的现金（日元）、自己的持仓、自己的价格序列，
//     不碰 db.players / db.stocks，主市场一行都不受影响。
//   · 只挂在主循环的末尾跑一步（server.js#tourTick），赢了就 frozen，价格与成交一起冻结。
//   · 标的机制沿用 LMFX 退市前的口径：股价 = 初始价 × (1 + 汇率涨跌 × 系数 × 杠杆)，
//     只是汇率改成引擎内模拟（不依赖外部 Swissquote 接口，本地/离线都能跑）。
//   · 这里不 import 任何模块，避免 store.js → tour.js → engine.js → store.js 的循环引用。

/** 起手资金：30 万日元 */
export const TOUR_START_CASH = 300000;
/** 夺冠线：2000 万日元（剧情里妈妈亏掉的数） */
export const TOUR_TARGET = 20000000;
/** 手续费（开平仓都收，按成交额） */
export const TOUR_FEE_RATE = 0.0002;
export const TOUR_MAX_LEVERAGE = 20;
/** 玩家成交对价格的冲击：500 万日元算 1 单位压力 */
const TOUR_FLOW_REF = 5000000;
/** 汇率每轮波动（LMFX 再乘 8 倍杠杆） */
const FX_VOL = 0.0009;
/** 汇率偶发跳空：概率 × 幅度 —— 一把翻身的来源，也是爆仓的来源 */
const FX_JUMP_P = 0.004;
const FX_JUMP_MIN = 0.012;
const FX_JUMP_MAX = 0.03;
/** 玩家冲击形成的溢价，每轮按这个比例衰减 */
const PREMIUM_DECAY = 0.9;
/** 1 单位资金压力（500 万日元）换来多少持久溢价 */
const PREMIUM_PER_FLOW = 0.0015;
const FX_COEF = 1;
const FX_LEV = 8;
const SERIES_MAX = 900;
const TRADE_LOG_MAX = 120;
const PLAYER_LOG_MAX = 24;

function gauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function num(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function r2(v) {
  return Math.round(v * 100) / 100;
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
    fx: { rate: 100, base: 100 },
    stock: {
      code: 'LMFX',
      name: '留美外汇',
      icon: '/assets/stocks/LMFX.jpeg',
      industry: '金融',
      desc: '外汇自营、套息交易、高杠杆',
      initialPrice: 100,
      price: 100,
      prev: 100,
      flow: 0,
      premium: 0,
      series: [100]
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
  if (!Array.isArray(t.stock.series) || !t.stock.series.length) t.stock.series = [t.stock.price];
  if (!t.fx || typeof t.fx !== 'object') t.fx = base.fx;
  if (!(num(t.fx.base) > 0)) t.fx.base = num(t.fx.rate, 100) || 100;
  if (!(num(t.fx.rate) > 0)) t.fx.rate = t.fx.base;
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

/** 守卫：没开赛 / 已结束都拒绝下单 */
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

/** 价格走一步：汇率随机游走 → 隐含价（与退市前的 LMFX 同一公式）→ 叠加玩家溢价 */
function stepPrice(t) {
  const fx = t.fx;
  let ret = gauss() * FX_VOL;
  if (Math.random() < FX_JUMP_P) {
    const mag = FX_JUMP_MIN + Math.random() * (FX_JUMP_MAX - FX_JUMP_MIN);
    ret += (Math.random() < 0.5 ? -1 : 1) * mag;
  }
  fx.rate *= Math.exp(ret);
  if (fx.base > 0 && fx.rate > 0) {
    // 慢慢往基准拉回来，别跑成单边行情
    fx.rate *= Math.exp(0.0006 * Math.log(fx.base / fx.rate));
    fx.rate = clamp(fx.rate, fx.base * 0.3, fx.base * 3);
  }

  // 原来的口径：股价 = 初始价 × (1 + 汇率涨跌 × 系数 × 杠杆)
  // 这里用等价的对数形式，避免大幅跳空时线性近似失真
  const ratio = fx.rate / Math.max(1e-9, fx.base);
  const fxPrice = num(t.stock.initialPrice, 100) * Math.pow(ratio, FX_COEF * FX_LEV);

  // 玩家自己的成交会留下一点持久溢价（买单推高、卖单压低），逐轮衰减
  const flow = num(t.stock.flow);
  t.stock.premium = clamp(
    num(t.stock.premium) * PREMIUM_DECAY + flow * PREMIUM_PER_FLOW,
    -0.5,
    0.5
  );
  if (Math.abs(t.stock.premium) < 1e-5) t.stock.premium = 0;
  t.stock.flow = flow * 0.85;
  if (Math.abs(t.stock.flow) < 1e-4) t.stock.flow = 0;

  const p = fxPrice * Math.exp(num(t.stock.premium));
  t.stock.prev = num(t.stock.price, p);
  t.stock.price = Math.max(0.01, r2(p));
  t.stock.series.push(t.stock.price);
  if (t.stock.series.length > SERIES_MAX) {
    t.stock.series.splice(0, t.stock.series.length - SERIES_MAX);
  }
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
  if (!t.startedAt) return;
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

  t.stock.flow = clamp(
    num(t.stock.flow) + ((side === 'long' ? 1 : -1) * notional) / TOUR_FLOW_REF,
    -6,
    6
  );

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

  t.stock.flow = clamp(
    num(t.stock.flow) - ((pos.side === 'long' ? 1 : -1) * qty * price) / TOUR_FLOW_REF,
    -6,
    6
  );

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
  const series = t.stock.series.slice(-240);
  const first = series.length ? series[0] : t.stock.price;

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
      price: r2(t.stock.price),
      prev: r2(t.stock.prev),
      changePct: first > 0 ? Math.round(((t.stock.price / first) - 1) * 10000) / 100 : 0,
      fxRate: Math.round(num(t.fx.rate) * 100) / 100,
      series
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
            entry: r2(me.positions.LMFX.entry),
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
