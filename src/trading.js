import { now } from './store.js';
import {
  bumpAchv, grantAchv, bumpGlobal, isEvolved, skillMult, achvTarget, ensureAchvState,
  themeTier, refreshGlobals, ownsTheme
} from './achievements.js';
import { isTycoonSector } from './fundamentals.js';
import { maskSentiment } from './mind.js';
import { SMALL_INDEX_STOCK } from './stocks.js';
import { freeFeeActive, stampRateFor } from './perks.js';

const TRADE_LOG_MAX = 4000;

/** 记一条交易流水（超出上限就丢最老的） */
export function logTrade(db, entry) {
  if (!Array.isArray(db.trades)) db.trades = [];
  db.trades.push({
    id: 't_' + Math.random().toString(36).slice(2, 10),
    at: now(),
    ...entry
  });
  if (db.trades.length > TRADE_LOG_MAX) {
    db.trades.splice(0, db.trades.length - TRADE_LOG_MAX);
  }
}

function num(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

export function positionPnl(pos, price) {
  const dir = pos.side === 'long' ? 1 : -1;
  return (price - pos.entry) * pos.qty * dir;
}

export function positionEquity(pos, price) {
  return pos.margin + positionPnl(pos, price);
}

/** 玩家总权益 = 现金 + 所有仓位的保证金与浮盈亏 */
export function playerEquity(db, player) {
  let equity = num(player.cash);

  // 挂单冻结的押金还是你的钱，不能从总资产里抹掉
  for (const o of player.orders || []) {
    equity += Math.max(0, num(o.reserve));
  }

  for (const [code, pos] of Object.entries(player.positions || {})) {
    const st = db.stocks[code];
    if (!st) continue;
    equity += positionEquity(pos, st.price);
  }
  return equity;
}

/** 当前挂单冻结了多少押金 */
export function frozenCash(player) {
  let sum = 0;
  for (const o of player.orders || []) sum += Math.max(0, Number(o.reserve) || 0);
  return sum;
}

/**
 * 玩家成交对股价的冲击：买入推高，卖出压低
 * 用「成交额 / 参考成交额」累积成压力，由引擎逐轮释放
 */
function addFlow(st, cfg, signedNotional) {
  if (Number(cfg.playerImpactEnabled ?? 1) === 0) return;
  if (st.isIndex) return;   // 指数价格是算出来的，记了也没用
  const ref = Math.max(1, Number(cfg.playerImpactRef ?? 30000));
  const maxFlow = Math.max(1, Number(cfg.playerImpactFlowMax ?? 40));
  const before = Number(st.flow) || 0;
  st.flow = Math.max(-maxFlow, Math.min(maxFlow, before + signedNotional / ref));
  // 标记「本轮刚有成交」，下一轮走首轮全额冲击，之后按后续倍率衰减
  st.flowFresh = true;
}

/**
 * 市场资金（虚假成交 / 游资）对股价的压力。
 *
 * 和玩家的 addFlow 是**两套独立通道**（玩家走 st.flow，市场走 st.mflow）：
 *   - 单位和上限各自一套参数，游资砸 3000 万不会把玩家那 12 单位的上限占满
 *   - 释放也在引擎里分开写（engine.js#stepStock），玩家冲击的手感一点没动
 *
 * 单位：一笔 marketImpactRef（默认 1000 万）算 1 单位压力，封顶 marketImpactFlowMax。
 */
function addMarketFlowTo(st, cfg, signedNotional) {
  if (!st || st.isIndex) return;
  const n = Number(signedNotional);
  if (!Number.isFinite(n) || n === 0) return;
  if (Number(cfg.marketImpactEnabled ?? 1) === 0) return;
  const ref = Math.max(1, Number(cfg.marketImpactRef ?? 10000000));
  const maxFlow = Math.max(1, Number(cfg.marketImpactFlowMax ?? 8));
  const before = Number(st.mflow) || 0;
  st.mflow = Math.max(-maxFlow, Math.min(maxFlow, before + n / ref));
}

/**
 * 市场资金的统一入口（虚假成交 / 游资都调它）。
 * 指数标的按权重拆给成分股 —— 买指数 = 买一篮子，和玩家那边口径一致。
 */
export function addMarketFlow(db, st, signedNotional) {
  if (!db || !st) return;
  const cfg = db.config || {};
  if (Number(cfg.marketImpactEnabled ?? 1) === 0) return;
  if (st.isIndex) {
    distributeIndexFlow(db, signedNotional, 'market', indexKeyFor(st));
    return;
  }
  addMarketFlowTo(st, cfg, signedNotional);
}

/**
 * 冲击成本费率：单子越大，吃掉的市场深度越多，付的钱越多
 * 和 playerImpact 用同一套参考额，避免两套口径
 */
export function impactCostRate(db, notional) {
  const cfg = db.config || {};
  const coef = Math.max(0, Number(cfg.impactCostCoef ?? 6));
  if (coef <= 0) return 0;
  const ref = Math.max(1, Number(cfg.playerImpactRef ?? 30000));
  const strength = Math.max(0, Number(cfg.playerImpactStrength ?? 0.0009));
  const maxRate = Math.max(0, Number(cfg.impactCostMax ?? 0.06));
  const rate = (Math.abs(notional) / ref) * strength * coef;
  return Math.min(maxRate, rate);
}

/** 指数成分：当前权重（没有权重时按等权）。DENGS 读小灯指数自己的权重表 */
function indexWeights(db, indexKey = 'index') {
  const idx = (indexKey === 'smallIndex' ? db.smallIndex : db.index) || {};
  const w = idx.weights || {};
  const live = Object.values(db.stocks).filter((s) => !s.isIndex && s.status === 'normal');
  let sumW = 0;
  for (const s of live) sumW += Math.max(0, Number(w[s.code]) || 0);
  return live.map((s) => ({
    st: s,
    weight: sumW > 0
      ? Math.max(0, Number(w[s.code]) || 0) / sumW
      : 1 / Math.max(1, live.length)
  }));
}

/** 这个指数标的该用哪张权重表（DENG → index，DENGS → smallIndex） */
function indexKeyFor(st) {
  return st && st.code === SMALL_INDEX_STOCK.code ? 'smallIndex' : 'index';
}

/**
 * 买卖指数 = 按权重买一篮子成分股。
 * 把成交额按权重拆开，分别记到每只成分股的资金流上，
 * 这样买指数会真的把整个市场推上去。
 *
 * channel：'player' 走玩家的 st.flow，'market' 走虚假成交/游资的 st.mflow
 */
function distributeIndexFlow(db, signedNotional, channel = 'player', indexKey = 'index') {
  for (const { st, weight } of indexWeights(db, indexKey)) {
    if (weight <= 0) continue;
    const leg = signedNotional * weight;
    if (channel === 'market') addMarketFlowTo(st, db.config || {}, leg);
    else addFlow(st, db.config, leg);
  }
}

/** 指数的冲击成本 = 各成分腿冲击成本之和（拆单后更便宜，符合直觉） */
export function indexImpactCost(db, notional, indexKey = 'index') {
  let total = 0;
  for (const { st, weight } of indexWeights(db, indexKey)) {
    if (weight <= 0) continue;
    const leg = notional * weight;
    total += leg * impactCostRate(db, leg);
  }
  return total;
}


/** 指数是否处于上升趋势：现价 > MA5 > MA10 > MA30 */
export function indexDowntrend(db) {
  const series = db.index?.series || [];
  if (series.length < 31) return false;
  const tail = series.slice(-31);
  const last = tail[tail.length - 1];
  const ma = (n) => {
    const part = tail.slice(-n);
    return part.reduce((a, b) => a + b, 0) / part.length;
  };
  const ma5 = ma(5);
  const ma10 = ma(10);
  const ma30 = ma(30);
  return last < ma5 && ma5 < ma10 && ma10 < ma30;
}

export function indexUptrend(db) {
  const series = db.index?.series || [];
  if (series.length < 31) return false;
  const tail = series.slice(-31);
  const last = tail[tail.length - 1];
  const ma = (n) => {
    const part = tail.slice(-n);
    return part.reduce((a, b) => a + b, 0) / part.length;
  };
  const ma5 = ma(5);
  const ma10 = ma(10);
  const ma30 = ma(30);
  return last > ma5 && ma5 > ma10 && ma10 > ma30;
}

/**
 * 手续费率。
 *
 * 2026-11 按 docs/主题技能.md 重平衡：🐂 红牛进化的效果改成「返现 1.5%」，
 * 不再有多头排列免手续费这条（所以这里只剩「咸鱼代下单」一种免手续费来源）。
 */
export function feeRateFor(db, player) {
  const cfg = db.config || {};
  const base = Number(cfg.feeRate ?? 0);
  // 🐟 咸鱼代下单：生效期间手续费全免（印花税在 stampRateFor 里一起免）
  if (freeFeeActive(db, player)) return 0;
  return base;
}

/** 暗黑大手的冲击倍率：未进化用 config.darkImpactBase（默认 1.05），进化后用 themeEvolveImpact（默认 1.08） */
export function darkImpactMult(db, player) {
  if (!player || player.skill !== 'dark') return 1;
  const cfg = db.config || {};
  if (!isEvolved(player, 'dark')) {
    const b = Number(cfg.darkImpactBase);
    return Number.isFinite(b) && b > 0 ? b : 1.05;
  }
  const v = Number(cfg.themeEvolveImpact);
  return Number.isFinite(v) && v > 0 ? v : 1.08;
}

/** 最近 windowTicks 轮内、别人在这只票上的成交（不含自己） */
function recentOtherTrades(db, code, selfId, windowTicks, action) {
  const tickMs = Math.max(1000, Number((db.config || {}).tickMs) || 5000);
  const since = Date.now() - Math.max(1, Number(windowTicks) || 100) * tickMs;
  const list = Array.isArray(db.trades) ? db.trades : [];
  const out = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i];
    if (!t || Number(t.at) < since) break;
    if (t.code !== code) continue;
    if (t.playerId === selfId) continue;
    if (action && t.action !== action) continue;
    out.push(t);
  }
  return out;
}

/** 🕶️ 黑手：暗黑大手同股同方向累计开仓额，达标后「换技能平仓」才解锁 */
function trackDarkAccum(db, player, code, side, notional) {
  // 成就只看「拥有」：用着别的技能也照样累计（技能效果本身还是看 skill）
  if (!ownsTheme(player, 'dark')) return;
  if (!player.darkAccum || typeof player.darkAccum !== 'object') player.darkAccum = {};
  if (!player.darkArmed || typeof player.darkArmed !== 'object') player.darkArmed = {};
  const cur = player.darkAccum[code];
  const same = cur && cur.side === side ? Number(cur.notional) || 0 : 0;
  const total = same + (Number(notional) || 0);
  player.darkAccum[code] = { side, notional: total, at: Number(db.tick) || 0 };
  const need = achvTarget(db.config, 'achvDarkHandTarget');
  if (total + 1e-9 >= need) {
    player.darkArmed[code] = { side, at: Number(db.tick) || 0, notional: total };
  }
}

/** 🕶️ 推土机：别人刚开仓，我反方向进场 → 武装；等他平完我再平 → 解锁 */
function armDarkPush(db, player, code, side) {
  if (!ownsTheme(player, 'dark')) return;
  const win = achvTarget(db.config, 'achvDarkPushWindowTicks');
  const others = recentOtherTrades(db, code, player.id, win, 'open')
    .filter((t) => (t.side === 'short' ? 'short' : 'long') !== side);
  if (!others.length) return;
  const other = others[0];
  player.pushArm = { code, otherId: other.playerId, side, at: Number(db.tick) || 0 };
}

/** 🧙 来去无踪：别人刚成交，我用隐世仙人跟着成交 */
function trackHermitFollow(db, player, code) {
  if (!ownsTheme(player, 'hermit')) return;
  const win = achvTarget(db.config, 'achvHermitFollowWindowTicks');
  if (!recentOtherTrades(db, code, player.id, win).length) return;
  bumpAchv(db, player, 'hermitFollow', 1);
}

/** 🕵️ 软柿子：别人刚建仓，我在同一只票反方向开仓 */
function trackProbeWeak(db, player, code, side) {
  if (!ownsTheme(player, 'probe')) return;
  const win = achvTarget(db.config, 'achvProbeWindowTicks');
  const others = recentOtherTrades(db, code, player.id, win, 'open')
    .filter((t) => (t.side === 'short' ? 'short' : 'long') !== side);
  if (!others.length) return;
  bumpAchv(db, player, 'probeWeak', 1);
}

export function openPosition(db, player, { code, side, qty, leverage, tp, sl }) {
  const cfg = db.config;
  const st = db.stocks[code];
  if (!st) return { ok: false, error: '标的不存在' };
  if (st.status !== 'normal') return { ok: false, error: '该标的当前不可交易' };

  qty = Math.floor(num(qty));
  if (!(qty > 0)) return { ok: false, error: '数量必须是正整数' };


  leverage = num(leverage, 1);
  if (leverage < (cfg.minLeverage ?? 1) || leverage > (cfg.maxLeverage ?? 20)) {
    return { ok: false, error: `杠杆需在 ${cfg.minLeverage} ~ ${cfg.maxLeverage} 倍之间` };
  }

  side = side === 'short' ? 'short' : 'long';
  const price = st.price;
  const notional = qty * price;
  const margin = notional / leverage;
  const fee = notional * feeRateFor(db, player);
  const stamp = side === 'short' ? notional * stampRateFor(db, player) : 0;

  // 冲击成本：这笔单自己会推动价格，成本由下单人承担
  // 指数是由成分股算出来的，买卖它不会推动它自己，所以不收冲击成本
  const impactCost = st.isIndex
    ? indexImpactCost(db, notional, indexKeyFor(st))
    : notional * impactCostRate(db, notional);
  const cost = margin + fee + stamp + impactCost;
  if (player.cash < cost) {
    return { ok: false, error: `现金不足，需要 $${cost.toFixed(2)}，你只有 $${player.cash.toFixed(2)}` };
  }

  const exist = player.positions[code];
  if (exist && exist.side !== side) {
    return { ok: false, error: '这只票你还有反向持仓，先平掉再开' };
  }

  player.cash -= cost;
  // 🕶️ 暗黑大手进化：自己吃掉的冲击成本返还 20%
  if (player.skill === 'dark' && isEvolved(player, 'dark')) {
    const refundRate = Number(cfg.themeEvolveImpactRefund ?? 0.2);
    if (refundRate > 0) player.cash += impactCost * refundRate;
  }
  // 开多 = 买入推高；开空 = 卖出压低
  // 暗黑大手：自己的成交对市场冲击额外多 5%（进化后 8%）
  const impactMult = darkImpactMult(db, player);
  if (st.isIndex) {
    // 指数：按权重把冲击分摊给成分股
    distributeIndexFlow(db, (side === 'long' ? notional : -notional) * impactMult, 'player', indexKeyFor(st));
  } else {
    addFlow(st, cfg, (side === 'long' ? notional : -notional) * impactMult);
  }
  db.tradesThisTick = (db.tradesThisTick || 0) + 1;
  logTrade(db, {
    playerId: player.id,
    nickname: player.nickname,
    code,
    name: st.name,
    action: 'open',
    side,
    qty,
    price,
    leverage,
    fee,
    stamp,
    margin,
    impact: impactCost,
    reason: 'manual'
  });

  if (!exist) {
    player.positions[code] = {
      code,
      side,
      qty,
      entry: price,
      margin,
      leverage,
      tp: tp ? num(tp) : null,
      sl: sl ? num(sl) : null,
      openedAt: now(),
      openedTick: db.tick
    };
  } else {
    const totalQty = exist.qty + qty;
    exist.entry = (exist.entry * exist.qty + price * qty) / totalQty;
    exist.qty = totalQty;
    exist.margin += margin;
    exist.leverage = (exist.qty * exist.entry) / exist.margin;
    if (tp) exist.tp = num(tp);
    if (sl) exist.sl = num(sl);
  }

  // ---- 全局成就：记录建仓时的「偏离价值线」与仓位规模 ----
  ensureAchvState(player);
  {
    const posG = player.positions[code];
    if (posG) {
      const fairNow = Number(st.fair) || 0;
      // 正 = 价格高于价值线（高估），负 = 低于（低估）
      const dev = fairNow > 0 ? price / fairNow - 1 : 0;
      posG.openNotional = (Number(posG.openNotional) || 0) + notional;
      posG.lastOpenNotional = notional;
      const openMin = achvTarget(cfg, 'achvValueOpenMin');
      const devMin = achvTarget(cfg, 'achvValueDeviation');
      // 价值回归：单笔够大 + 偏离够远 → 记下方向，等回到价值线另一头
      if (notional + 1e-9 >= openMin && Math.abs(dev) + 1e-9 >= devMin) {
        posG.valueArm = { devSign: dev > 0 ? 1 : -1, at: db.tick, notional };
      }
      // 长线价值：单笔够大就记一笔，24 小时后看收益
      if (notional + 1e-9 >= openMin) {
        posG.valueHoldArm = { at: db.tick, notional };
      }
    }
  }

  // ---- 主题成就判定（开仓侧）----
  trackDarkAccum(db, player, code, side, notional);
  armDarkPush(db, player, code, side);
  trackHermitFollow(db, player, code);
  trackProbeWeak(db, player, code, side);
  // 🧙 孤狼：单票持仓市值
  const posNow = player.positions[code];
  if (posNow && ownsTheme(player, 'hermit')) {
    bumpAchv(db, player, 'hermitMaxPos', num(posNow.qty) * price, 'max');
  }

  return { ok: true, position: player.positions[code] };
}

export function closePosition(db, player, code, reason = 'manual', qty = null) {
  const cfg = db.config;
  const pos = player.positions[code];
  if (!pos) return { ok: false, error: '没有这只票的持仓' };
  const st = db.stocks[code];
  if (!st) return { ok: false, error: '标的不存在' };

  // 不传 qty 就是全平（止盈止损/手动平仓），传了就是部分平
  const closeQty = qty ? Math.min(pos.qty, Math.max(1, Math.floor(qty))) : pos.qty;
  const ratio = closeQty / pos.qty;

  const price = st.price;
  const notional = closeQty * price;
  const pnl = (pos.side === 'long' ? price - pos.entry : pos.entry - price) * closeQty;
  const fee = notional * feeRateFor(db, player);
  // 平多 = 卖出，收印花税；平空 = 买入，不收
  const stamp = pos.side === 'long' ? notional * stampRateFor(db, player) : 0;

  const sideNow = pos.side;
  const entry = pos.entry;
  const marginPart = pos.margin * ratio;
  let equity = marginPart + pnl;
  if (equity < 0) equity = 0; // 亏损不会超过这部分保证金
  // 冲击成本：平仓同样要为自己造成的冲击付钱（强平/退市除外）
  const impactCost = reason === 'liquidated' || reason === 'delisted'
    ? 0
    : (st.isIndex ? indexImpactCost(db, notional) : notional * impactCostRate(db, notional));
  let back = Math.max(0, equity - fee - stamp - impactCost);

  // 「红红的牛」技能：牛市里平仓，额外返 1% 成交额（每个持仓只算一次）
  let bonus = 0;
  const noBonus = reason === 'liquidated' || reason === 'delisted';

  // 注意：每笔平仓单都独立判定一次，不做「每个持仓只算一次」的限制
  // （分批止盈/止损时，每一笔平仓都有机会吃到返现）
  const redRate = Number(cfg.redBonusRate ?? 0.01);
  const uptrendNow = indexUptrend(db);
  // 🐂 顺势收割：**拥有**红牛主题就计数（不用正在装备技能）
  if (ownsTheme(player, 'red') && !noBonus && uptrendNow) {
    bumpAchv(db, player, 'redTrendClose', 1);
  }
  if (ownsTheme(player, 'red') && redRate > 0 && !noBonus) {
    const minTicks = Math.max(0, Number(cfg.redBonusMinTicks ?? 12));
    const held = db.tick - Number(pos.openedTick ?? db.tick);
    if (held >= minTicks && uptrendNow) {
      // 成就按「基础返现率」累计；真金白银只有装备了红牛技能才发
      bumpAchv(db, player, 'redBonusEarned', notional * redRate);
      if (player.skill === 'red') {
        // 进化后倍率 1.5（上限仍由 redBonusRate 控制，不在这里写死金额）
        bonus = notional * redRate * skillMult(db, player, 'red');
        back += bonus;
        // 累计统计，主题卡片上要显示
        player.redBonusEarned = num(player.redBonusEarned) + bonus;
      }
    }
  }

  // 「绿绿的熊」技能：熊市里平仓，同样返 1% 成交额（和红牛正好反过来）
  const bearRate = Number(cfg.bearBonusRate ?? 0.01);
  const downtrendNow = indexDowntrend(db);
  // 🐻 熊市舞者：**拥有**绿熊主题就计数（不用正在装备技能）
  if (ownsTheme(player, 'bear') && !noBonus && downtrendNow) {
    bumpAchv(db, player, 'bearTrendClose', 1);
  }
  if (ownsTheme(player, 'bear') && bearRate > 0 && !noBonus) {
    const minTicks = Math.max(0, Number(cfg.bearBonusMinTicks ?? 12));
    const held = db.tick - Number(pos.openedTick ?? db.tick);
    if (held >= minTicks && downtrendNow) {
      // 成就按基础返现率累计；真金白银只有装备了绿熊技能才发
      bumpAchv(db, player, 'bearBonusEarned', notional * bearRate);
      if (player.skill === 'bear') {
        const add = notional * bearRate * skillMult(db, player, 'bear');
        bonus += add;
        back += add;
        player.bearBonusEarned = num(player.bearBonusEarned) + add;
      }
    }
  }

  player.cash += back;

  // ================= 全局成就判定（平仓侧）=================
  ensureAchvState(player);
  {
    const cfgG = db.config || {};
    const pnlPct = Number(pos.margin) > 0 ? (pnl / Number(pos.margin)) * 100 : 0;
    const heldTicks = Math.max(0, Number(db.tick) - Number(pos.openedTick ?? db.tick));
    const fairNow = Number(st.fair) || 0;
    const devNow = fairNow > 0 ? price / fairNow - 1 : 0;

    // 🏛️ 价值回归：建仓时偏离 ≥30%，现在价格已经穿到价值线的另一头
    if (pos.valueArm) {
      const crossed = pos.valueArm.devSign > 0 ? devNow < 0 : devNow > 0;
      if (crossed) bumpGlobal(db, player, 'valueCrossClose', 1);
    }
    // 🏛️ 长线价值：单笔 >500 万、持有 >24 小时、这笔收益率 ≥100%
    if (pos.valueHoldArm) {
      const needTicks = achvTarget(cfgG, 'achvValueHoldTicks');
      const needPct = achvTarget(cfgG, 'achvValueProfitPct');
      if (heldTicks + 1e-9 >= needTicks && pnlPct + 1e-9 >= needPct) {
        bumpGlobal(db, player, 'valueHoldProfit', 1);
      }
    }
    // 🐉 短线擒龙：两档都看「建仓规模 + 持有轮数 + 这笔收益率」
    const shortMin = achvTarget(cfgG, 'achvShortOpenMin');
    const openNotional = Number(pos.openNotional) || 0;
    if (openNotional + 1e-9 >= shortMin) {
      if (heldTicks <= 1 && pnlPct + 1e-9 >= achvTarget(cfgG, 'achvShortNextPnlPct')) {
        bumpGlobal(db, player, 'dragonNextTick', 1);
      }
      // 注意别写成 `heldTicks + 1e-9 <= win`：刚好等于窗口时会因为加了 eps 反而判为超窗
      if (heldTicks <= achvTarget(cfgG, 'achvShortWindowTicks') + 1e-9
        && pnlPct + 1e-9 >= achvTarget(cfgG, 'achvShortPnlPct')) {
        bumpGlobal(db, player, 'dragonFast100', 1);
      }
    }
    // 兜底：每次平仓都结算一次（管理员改阈值后也能补上）
    refreshGlobals(db, player);
  }

  // ================= 主题成就判定（平仓侧）=================
  const cfgA = db.config || {};

  // 🕶️ 黑手：暗黑大手累计够了 → 换别的技能在这只票平仓
  if (player.darkArmed && player.darkArmed[code] && player.skill !== 'dark') {
    delete player.darkArmed[code];
    if (player.darkAccum) delete player.darkAccum[code];
    bumpAchv(db, player, 'darkHand', 1);
  }

  // 🕶️ 推土机：我推过价，且对方已经平掉 → 解锁
  if (ownsTheme(player, 'dark') && player.pushArm && player.pushArm.code === code) {
    const other = db.players?.[player.pushArm.otherId];
    const otherStillIn = other && other.positions && other.positions[code];
    if (!otherStillIn) {
      delete player.pushArm;
      bumpAchv(db, player, 'darkPush', 1);
    }
  }

  // 🐊 先知：金融板块「超预期」财报公布前后的一进一出
  if (ownsTheme(player, 'tycoon') && st && isTycoonSector(st)) {
    const surprise = Number(st.lastSurprise) || 0;
    const reportAt = Number(st.lastReportTick) || 0;
    const needLev = achvTarget(cfgA, 'achvTycoonProphetLeverage');
    const openedBefore = reportAt > 0 && Number(pos.openedTick) <= reportAt;
    if (surprise > 0.02 && openedBefore && num(pos.leverage) >= needLev) {
      bumpAchv(db, player, 'tycoonProphet', 1);
    }
  }

  // 🐊 信息差：金融板块累计实现盈利
  if (st && isTycoonSector(st)) {
    const net = pnl - fee - stamp;
    if (net > 0) bumpAchv(db, player, 'tycoonFinancePnl', net);
  }

  // 🧠 读心 / 情绪交易员（只看拥有；没装备的人读到的是引擎那份真值，不影响判定）
  if (ownsTheme(player, 'mind')) {
    // 用「这个玩家自己看到的读数」判定，而不是全局那份
    const v = Number(maskSentiment(st, db, player).v) || 0;
    const extreme = Math.max(0.1, Math.min(1, Number(cfgA.achvMindExtreme ?? 0.8)));
    const rightWay = sideNow === 'long' ? v >= extreme : v <= -extreme;
    if (pnl > 0 && rightWay) bumpAchv(db, player, 'mindRead', 1);
    const netMind = pnl - fee - stamp;
    if (netMind > 0) bumpAchv(db, player, 'mindPnl', netMind);
  }

  // 🧙 孤狼：平仓前再量一次持仓市值（涨上去也算；拥有隐世主题才算）
  if (ownsTheme(player, 'hermit') && pos && pos.qty > 0) {
    bumpAchv(db, player, 'hermitMaxPos', num(pos.qty) * price, 'max');
  }

  // 平多 = 卖出压低；平空 = 买回推高
  const impactMult2 = darkImpactMult(db, player);
  if (st.isIndex) {
    distributeIndexFlow(db, (pos.side === 'long' ? -notional : notional) * impactMult2, 'player', indexKeyFor(st));
  } else {
    addFlow(st, cfg, (pos.side === 'long' ? -notional : notional) * impactMult2);
  }

  if (closeQty >= pos.qty) {
    delete player.positions[code];
  } else {
    pos.qty -= closeQty;
    pos.margin -= marginPart;
    if (pos.qty < 1) delete player.positions[code];
  }
  db.tradesThisTick = (db.tradesThisTick || 0) + 1;
  logTrade(db, {
    playerId: player.id,
    nickname: player.nickname,
    code,
    name: st.name,
    action: 'close',
    side: pos.side,
    qty: closeQty,
    price,
    leverage: pos.leverage,
    entry: pos.entry,
    pnl,
    fee,
    stamp,
    impact: impactCost,
    bonus,
    returned: back,
    reason
  });

  return {
    ok: true,
    code,
    side: sideNow,
    qty: closeQty,
    entry,
    price,
    pnl,
    fee,
    stamp,
    impact: impactCost,
    bonus,
    returned: back,
    reason
  };
}

/** 每 tick 检查止盈止损与强平 */
export function checkPositions(db) {
  const results = [];
  for (const player of Object.values(db.players)) {
    if (!player.positions) continue;
    for (const code of Object.keys(player.positions)) {
      const pos = player.positions[code];
      const st = db.stocks[code];
      if (!st) continue;

      // 退市：直接按最后价格平掉
      if (st.status === 'delisted') {
        results.push({ playerId: player.id, ...closePosition(db, player, code, 'delisted') });
        continue;
      }

      const price = st.price;
      const equity = positionEquity(pos, price);

      // 强平：保证金已经亏光，必须一次平掉，不走挂单
      if (equity <= (db.config.liquidationBuffer ?? 0)) {
        const r = closePosition(db, player, code, 'liquidated');
        results.push({ playerId: player.id, ...r });
        continue;
      }

      // 止盈止损：到线不直接成交，而是自动挂一张平仓单，
      // 交给撮合流程按「每轮成交量上限」慢慢平
      const dir = pos.side === 'long' ? 1 : -1;

      // 多条止盈止损：先补一条老数据到列表里
      if (!Array.isArray(pos.tpsl)) {
        pos.tpsl = [];
        if (pos.tp) pos.tpsl.push({ id: 'ts_legacy_tp', kind: 'tp', price: Number(pos.tp), qty: pos.tpQty || null, fired: false });
        if (pos.sl) pos.tpsl.push({ id: 'ts_legacy_sl', kind: 'sl', price: Number(pos.sl), qty: pos.slQty || null, fired: false });
      }

      // 找出所有触发但还没处理的条件
      const hits = pos.tpsl.filter((x) => {
        if (x.fired) return false;
        return x.kind === 'tp'
          ? (price - x.price) * dir >= 0
          : (price - x.price) * dir <= 0;
      });
      if (!hits.length) continue;

      const hit = hits[0].kind;

      // 只有「已经挂出去的止盈止损单」才算处理过。
      // 玩家手动挂的平仓单不算——否则一张永远不成交的远价单会把止损整个屏蔽掉。
      const already = (player.orders || []).some(
        (o) => o.code === code && o.action === 'close' && o.auto
      );
      if (already) continue;

      // 止盈/止损可以只平一部分：用玩家预先设好的数量
      const presetQty = Number(hits[0].qty);
      const orderQty = Math.max(1, Math.min(
        pos.qty,
        Number.isFinite(presetQty) && presetQty > 0 ? Math.floor(presetQty) : pos.qty
      ));

      if (!Array.isArray(player.orders)) player.orders = [];
      const ttl = Math.max(1, Number(db.config.orderTtlTicks ?? 2000));
      const slip = 0.004;
      const buy = pos.side === 'short';           // 平空 = 买回
      const limit = Math.round((buy ? price * (1 + slip) : price * (1 - slip)) * 100) / 100;

      player.orders.push({
        id: 'o_' + Math.random().toString(36).slice(2, 10),
        code,
        name: st.name,
        action: 'close',
        side: pos.side,
        qty: orderQty,
        limit,
        reserve: 0,
        createdAt: Date.now(),
        createdTick: db.tick,
        // 风控单给双倍时长，而且 expireTick 必须和撮合里的实际口径一致
        expireTick: db.tick + ttl * 2,
        auto: hit,           // tp / sl，撮合时按「必须成交」处理
        // 记住「这张单是谁触发的」：万一它被撤掉（超时 / 手动撤 / 成交失败），
        // cancelOrder 要把这些条件重新武装，否则止盈止损会被永久吃掉
        tpslIds: hits.map((h) => h.id),
        tpslOrigQty: orderQty
      });

      // 风控单一旦触发，这只票**还没成交完的开仓单必须撤掉**：
      // 否则它会继续把仓位加上去，而止盈止损只按触发那一刻的数量平，
      // 结果是「止损成交了、仓位反而更大、而且再也没有止损保护」。
      {
        const opens = (player.orders || []).filter(
          (o) => o && o.code === code && o.action === 'open'
        );
        for (const o of opens) {
          const i = player.orders.indexOf(o);
          if (i >= 0) player.orders.splice(i, 1);
          if (Number(o.reserve) > 0) player.cash += Number(o.reserve);
          results.push({
            playerId: player.id, ok: true, code, side: o.side, qty: 0,
            canceledOpen: true, reason: '止盈止损触发，撤销未成交的开仓单'
          });
        }
      }

      // 止盈止损已转化成挂单，持仓上的条件清掉，避免重复触发
      for (const h of hits) h.fired = true;
      const restTp = pos.tpsl.find((x) => x.kind === 'tp' && !x.fired);
      const restSl = pos.tpsl.find((x) => x.kind === 'sl' && !x.fired);
      pos.tp = restTp ? restTp.price : null;
      pos.sl = restSl ? restSl.price : null;
      pos.closing = hit;
      results.push({
        playerId: player.id,
        ok: true,
        code,
        side: pos.side,
        qty: 0,
        autoOrder: hit,
        price
      });
    }
  }
  return results;
}
