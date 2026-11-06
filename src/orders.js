// 限价挂单：真实股市的挂单机制
//
//   开多 = 买入：价格跌到限价（或更低）才成交
//   开空 = 卖出：价格涨到限价（或更高）才成交
//   平多 = 卖出：价格涨到限价（或更高）才成交
//   平空 = 买入：价格跌到限价（或更低）才成交
//
// 开仓单会把「保证金 + 手续费 + 印花税 + 冲击成本」先扣下来押在订单里，
// 撤单或到期全额退回，成交时按实际价格结算（不会比限价更贵）。
//
// 撮合规则（每个 tick 一次）：
//   · 风控单（止盈止损转来的 auto 单）必须当轮成交，不受限价约束。
//     否则价格跳空时卖单会挂在上方等反弹，止损形同虚设。
//   · 其余按「价格优先 → 时间优先」排队。
//   · 成交金额上限按【玩家 × 标的 × 方向】算，大单自动拆成多轮。
//     不再有「全服每只票每轮只成交一张」——那会被 1 股小单占位卡死全服。
//   · 价格跳空导致钱不够时，按买得起的数量成交，而不是整单撤销。

import { openPosition, closePosition, impactCostRate, indexImpactCost } from './trading.js';

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const r2 = (v) => Math.round(Number(v) * 100) / 100;

/** 风控单的穿价幅度：挂单价在现价基础上让 0.4%，保证方向正确 */
const AUTO_SLIP = 0.004;
/** 同一张单连续失败几次就撤掉（避免每轮刷失败提示） */
const MAX_ORDER_FAILS = 3;

function uid() {
  return 'o_' + Math.random().toString(36).slice(2, 10);
}

/** 这笔单子是买入方向吗 */
export function isBuyOrder(order) {
  if (order.action === 'open') return order.side === 'long';
  return order.side === 'short'; // 平空 = 买回
}

/**
 * 按「最坏情况成交价」估开仓要押多少钱：
 *   保证金 + 手续费 + 印花税（做空）+ 冲击成本
 *
 * 冲击成本必须算进来，否则成交那一刻 openPosition 会因为「现金不足」
 * 把整张单卡死（押金刚好用满的玩家 100% 命中）。
 */
export function estimateReserve(db, st, price, qty, leverage, side) {
  const cfg = (db && db.config) || {};
  const notional = qty * price;
  const margin = notional / Math.max(1, num(leverage, 1));
  const fee = notional * num(cfg.feeRate, 0);
  const stamp = side === 'short' ? notional * num(cfg.stampDuty, 0) : 0;
  const impact = st && st.isIndex
    ? indexImpactCost(db, notional)
    : notional * impactCostRate(db, notional);
  return margin + fee + stamp + impact;
}

/**
 * 每人每轮操作次数限制（防刷成交额把小灯证券抬上去）
 * 返回 null = 还能下单；否则是给玩家看的提示
 */
export function orderLimitBlocked(db, player) {
  const max = num((db.config || {}).maxOrdersPerTick, 1);
  if (!(max > 0)) return null;
  const sameTick = player.orderTick === db.tick;
  const used = sameTick ? num(player.orderCount, 0) : 0;
  if (used < max) return null;
  const secs = Math.max(1, Math.round(num((db.config || {}).tickMs, 5000) / 1000));
  return `每轮只能操作 ${max} 次，等下一轮（约 ${secs} 秒）`;
}

/** 成功挂出一张单后，记一次操作机会 */
export function consumeOrderSlot(db, player) {
  const same = player.orderTick === db.tick;
  const prev = same ? num(player.orderCount, 0) : 0;
  player.orderTick = db.tick;
  player.orderCount = Math.min(prev + 1, 1e6);
}

/** 挂一笔限价单 */
/**
 * 同一只票的挂单冲突检查。
 *
 * 老版本只看「有没有反向持仓」，于是玩家可以在同一只票上
 * 一边挂开仓单、一边挂平仓单 —— 两笔一起排队，谁先成交就把另一笔的前提打乱：
 *   - 开仓先成交 → 持仓变多，后面那笔「平 100 股」只平掉一半，玩家以为自己已经清仓
 *   - 平仓先成交 → 持仓没了，开仓单成交后变成满仓，和玩家预期相反
 *   - 两笔平仓单还可能按「挂单时的数量」重复卖，触发一次注定失败的撮合
 *
 * 所以规则收紧成：
 *   1. 要开仓：这只票不许有**未成交的手动平仓单**
 *   2. 要平仓：这只票不许有**未成交的开仓单**，也不许已经有平仓单在排队
 *   3. 止盈止损（auto）单是系统风控单，**不挡开仓**（否则玩家加仓前得先撤掉止损）；
 *      但它算「已有平仓单」，避免手动再挂一笔重复卖
 *
 * @returns {null|string} 冲突时返回给玩家看的话
 */
export function pendingConflict(player, code, action) {
  const list = Array.isArray(player?.orders) ? player.orders : [];
  const same = list.filter((o) => o && String(o.code || '').toUpperCase() === code);
  if (!same.length) return null;

  const opens = same.filter((o) => o.action === 'open');
  const closes = allCloseOrders(same);

  if (action === 'open') {
    // 自动定投是系统单，不挡开仓；手动平仓单挡
    const manualClose = closes.find((o) => !o.auto);
    if (manualClose) return '这只票还有未成交的平仓单，等它成交或先撤掉';
    return null;
  }

  if (opens.length) return '这只票还有未成交的开仓单，等它成交或先撤掉';
  if (closes.length) return '这只票已经有一笔平仓单在排队了';
  return null;
}

/** 所有「平仓性质」的在挂单（hand: 手动 / auto: 止盈止损 / autoDca: 定投不算） */
function allCloseOrders(list) {
  return list.filter((o) => o && o.action === 'close' && !o.autoDca);
}

export function placeLimitOrder(db, player, body) {
  const cfg = db.config;
  if (num(cfg.limitOrderEnabled, 1) === 0) {
    return { ok: false, error: '挂单功能已关闭' };
  }
  // 休市：前端会把按钮置灰，但接口必须自己拦（否则能绕过页面挂单占押金）
  if (cfg.marketOpen === false) {
    return { ok: false, status: 423, error: '休市中，暂停交易' };
  }

  const code = String(body.code || '').toUpperCase();
  const st = db.stocks[code];
  if (!st) return { ok: false, error: '标的不存在' };
  if (st.status !== 'normal') return { ok: false, error: '该标的当前不可交易' };

  const action = body.action === 'close' ? 'close' : 'open';
  const side = body.side === 'short' ? 'short' : 'long';
  const limit = num(body.limit, 0);
  if (!(limit > 0)) return { ok: false, error: '限价必须大于 0' };

  if (!Array.isArray(player.orders)) player.orders = [];
  const maxPending = Math.max(1, num(cfg.maxPendingOrders, 5));
  // 止盈止损单和自动定投单不占名额（它们是系统单，不是玩家手动挂的）
  const manualCount = player.orders.filter((o) => !o.auto && !o.autoDca).length;
  // 系统单（自动定投）不受「同时挂几笔」的限制，否则玩家挂满手动单后定投就哑了
  if (!body.system && manualCount >= maxPending) {
    return { ok: false, error: `最多同时挂 ${maxPending} 笔单，先撤掉一些` };
  }

  // 同一只票不允许同时挂着冲突的单（开仓 ↔ 平仓、重复平仓）
  const conflict = body.system ? null : pendingConflict(player, code, action);
  if (conflict) return { ok: false, error: conflict };

  const ttl = Math.max(1, num(cfg.orderTtlTicks, 2000));
  const expireTick = db.tick + ttl;

  if (action === 'close') {
    const pos = player.positions[code];
    if (!pos) return { ok: false, error: '你没有这只票的持仓' };
    if (pos.side !== side) return { ok: false, error: '方向和持仓不一致' };

    // 允许只平一部分：body.qty 有值就按它来，否则全平
    const wantQty = Math.floor(num(body.qty, 0));
    const closeQty = wantQty > 0 ? Math.min(pos.qty, wantQty) : pos.qty;

    const order = {
      id: uid(),
      code,
      name: st.name,
      action,
      side,
      qty: closeQty,
      limit,
      leverage: pos.leverage || 1,
      reserve: 0,
      createdAt: Date.now(),
      createdTick: db.tick,
      expireTick
    };
    player.orders.push(order);
    return { ok: true, order };
  }

  // 开仓
  let qty = Math.floor(num(body.qty, 0));
  if (!(qty > 0)) return { ok: false, error: '数量必须是正整数' };

  const leverage = num(body.leverage, 1);
  if (leverage < num(cfg.minLeverage, 1) || leverage > num(cfg.maxLeverage, 20)) {
    return { ok: false, error: `杠杆需在 ${cfg.minLeverage} ~ ${cfg.maxLeverage} 倍之间` };
  }

  const exist = player.positions[code];
  if (exist && exist.side !== side) {
    return { ok: false, error: '这只票你还有反向持仓，先平掉再挂' };
  }

  // 押金按「最坏情况成交价」冻结：
  //   买单 → 直接按【限价】冻结（成交价最高就是限价）
  //   卖单 → 取限价和现价里更高的那个（成交价没有上限，成交时再按买得起的量缩小）
  const buySide = side === 'long';
  const refPrice = buySide ? limit : Math.max(limit, st.price);
  const reserve = estimateReserve(db, st, refPrice, qty, leverage, side);
  if (player.cash < reserve) {
    return { ok: false, error: `押金不足，需要 $${reserve.toFixed(2)}，你只有 $${player.cash.toFixed(2)}` };
  }

  player.cash -= reserve;

  const order = {
    id: uid(),
    code,
    name: st.name,
    action,
    side,
    qty,
    limit,
    leverage,
    reserve,
    createdAt: Date.now(),
    createdTick: db.tick,
    expireTick
  };
  player.orders.push(order);
  return { ok: true, order, reserved: reserve };
}

/** 撤单：开仓单退回押金 */
export function cancelOrder(db, player, orderId, reason = '手动撤单') {
  if (!Array.isArray(player.orders)) player.orders = [];
  const i = player.orders.findIndex((o) => o.id === orderId);
  if (i < 0) return { ok: false, error: '没有这笔挂单' };
  const order = player.orders[i];
  player.orders.splice(i, 1);
  if (order.reserve > 0) {
    player.cash = num(player.cash, 0) + order.reserve;
  }
  // 自动止盈止损单被撤掉后，持仓不再是「平仓中」
  if (order.auto) {
    const pos = player.positions?.[order.code];
    if (pos) pos.closing = null;
  }
  return { ok: true, order, reason };
}

/** 从玩家的挂单数组里摘掉一张单（不谈钱，钱由调用方处理） */
function removeOrder(player, order) {
  const list = player.orders || [];
  const i = list.indexOf(order);
  if (i >= 0) list.splice(i, 1);
}

/**
 * 每个玩家的「每轮单笔成交上限」（金额）：
 *   基础 maxFillNotionalPerTick
 *   + 通道等级 × (shopChannelStep × 账号等级)   ← 通道每级加成按等级放大
 *   + 账号等级 × levelFillBonus（每个等级 +100 万，Lv.1 就有一份）
 *
 * 通道那条是 2026-11 改的：**每买 1 级通道的增量 = shopChannelStep × 玩家等级**。
 *   Lv.1 买 1 级 → +10 万（默认 shopChannelStep）
 *   Lv.3 买 1 级 → +30 万
 * 所以等级越高，通道越值钱；反过来买过通道的人升级时，通道那份也会同步变大。
 * 这里每次都按玩家当前 level / channelLevel 现算，老玩家升级后**下一轮直接生效**，
 * 不需要迁移或重置任何数据。
 */
export function fillCapFor(db, player) {
  const cfg = (db && db.config) || {};
  const base = Math.max(1, num(cfg.maxFillNotionalPerTick, 300000));
  const chLevel = Math.max(0, Math.floor(num(player && player.channelLevel, 0)));
  const chStep = Math.max(0, num(cfg.shopChannelStep, 100000));
  const lv = Math.max(1, Math.floor(num(player && player.level, 1)));
  const lvBonus = Math.max(0, num(cfg.levelFillBonus, 1000000));
  const channelPart = chLevel * chStep * lv;
  return base + channelPart + lv * lvBonus;
}

/** 通道每买 1 级能涨多少（按这个玩家的等级算），前端展示用 */
export function channelStepFor(db, player) {
  const cfg = (db && db.config) || {};
  const chStep = Math.max(0, num(cfg.shopChannelStep, 100000));
  const lv = Math.max(1, Math.floor(num(player && player.level, 1)));
  return chStep * lv;
}

/**
 * 每个 tick 撮合一次（价格更新之后调用）
 * 返回成交/撤单事件列表，用于推送提示
 */
export function processOrders(db) {
  const events = [];

  // ---------- 1. 收集所有挂单，按「风控单 → 买/卖 → 价格 → 时间」排队 ----------
  const items = [];
  for (const player of Object.values(db.players)) {
    const orders = player.orders;
    if (!Array.isArray(orders) || !orders.length) continue;
    for (const order of orders) {
      items.push({ player, order, st: db.stocks[order.code] });
    }
  }
  if (!items.length) return events;

  items.sort((a, b) => {
    if (a.order.code !== b.order.code) return a.order.code < b.order.code ? -1 : 1;
    // 风控单优先（止损必须跑得掉）
    const aAuto = a.order.auto ? 0 : 1;
    const bAuto = b.order.auto ? 0 : 1;
    if (aAuto !== bAuto) return aAuto - bAuto;
    const aBuy = isBuyOrder(a.order) ? 0 : 1;
    const bBuy = isBuyOrder(b.order) ? 0 : 1;
    if (aBuy !== bBuy) return aBuy - bBuy;
    // 同方向：限价越有攻击性的先成交
    const d = aBuy === 0
      ? num(b.order.limit) - num(a.order.limit)
      : num(a.order.limit) - num(b.order.limit);
    if (d !== 0) return d;
    const t = num(a.order.createdAt) - num(b.order.createdAt);
    if (t !== 0) return t;
    return String(a.order.id).localeCompare(String(b.order.id));
  });

  // ---------- 2. 每个「玩家 + 标的 + 方向」每轮的成交金额预算 ----------
  const budget = new Map();
  const capOf = (player) => fillCapFor(db, player);

  for (const { player, order, st } of items) {
    const code = order.code;
    const name = order.name || code;
    const pushCancel = (reason) => {
      events.push({ playerId: player.id, type: 'cancel', code, name, reason });
    };

    // 标的没了 / 退市 → 撤单退款
    if (!st || st.status === 'delisted') {
      cancelOrder(db, player, order.id, '标的已退市，自动撤单');
      pushCancel('标的已退市');
      continue;
    }

    // 超时撤单
    const expire = num(order.expireTick, 0);
    if (expire > 0 && db.tick > expire) {
      cancelOrder(db, player, order.id, '挂单超时');
      pushCancel('超时自动撤单');
      continue;
    }

    // 停牌不撮合
    if (st.status !== 'normal') continue;

    // 下单当轮不成交，从下一轮开始排队
    if (db.tick <= num(order.createdTick, 0)) continue;

    const px = num(st.price, 0);
    if (!(px > 0)) continue;
    const buy = isBuyOrder(order);

    if (order.auto) {
      // 风控单：每轮重定一次穿价，并且无视限价直接成交。
      // 价格跳空时若还按原限价判断，卖单会永远等不到成交。
      order.limit = r2(buy ? px * (1 + AUTO_SLIP) : px * (1 - AUTO_SLIP));
    } else {
      const hit = buy ? px <= num(order.limit) : px >= num(order.limit);
      if (!hit) continue;
    }

    // 平仓单必须和当前持仓同向，否则会平掉后来开的反向仓位
    if (order.action === 'close') {
      const pos = player.positions?.[code];
      if (!pos) {
        cancelOrder(db, player, order.id, '持仓已不存在');
        pushCancel('持仓已不存在');
        continue;
      }
      if (pos.side !== order.side) {
        cancelOrder(db, player, order.id, '方向和持仓不一致');
        pushCancel('持仓方向已变，平仓单自动撤销');
        continue;
      }
    }

    const remainQty = Math.max(0, Math.floor(num(order.qty)));
    if (remainQty < 1) {
      removeOrder(player, order);
      continue;
    }

    // 本轮该方向还剩多少成交金额
    const key = `${player.id}|${code}|${buy ? 'b' : 's'}`;
    if (!budget.has(key)) budget.set(key, capOf(player));
    const left = budget.get(key);
    if (!(left > 0)) continue;

    let fillQty = Math.min(remainQty, Math.floor(left / px));
    if (fillQty < 1) continue;

    if (order.action === 'open') {
      // 价格跳空、押金不够时按买得起的数量成交，不整单撤销
      const perShare = estimateReserve(db, st, px, 1, order.leverage, order.side);
      const afford = Math.floor(
        (num(player.cash) + Math.max(0, num(order.reserve))) / Math.max(perShare, 1e-9)
      );
      if (afford < 1) {
        cancelOrder(db, player, order.id, '资金不足');
        events.push({
          playerId: player.id, type: 'fail', code, name,
          reason: '资金不足，连 1 股都买不起，该挂单已撤销'
        });
        continue;
      }
      fillQty = Math.min(fillQty, afford);

      // 按比例解冻这一轮要用的押金；价格往上跳就多解冻一点
      const reserve = Math.max(0, num(order.reserve));
      const perShareReserve = remainQty > 0 ? reserve / remainQty : 0;
      const needNow = estimateReserve(db, st, px, fillQty, order.leverage, order.side) * 1.01;
      const fromReserve = Math.min(reserve, Math.max(perShareReserve * fillQty, needNow));
      player.cash = num(player.cash) + fromReserve;
      order.reserve = reserve - fromReserve;

      const r = openPosition(db, player, {
        code,
        side: order.side,
        qty: fillQty,
        leverage: order.leverage
      });

      if (!r.ok) {
        // 钱按原样冻回去，单子留到下一轮；同一个错连犯几次才撤
        player.cash = num(player.cash) - fromReserve;
        order.reserve = reserve;
        order.fails = num(order.fails) + 1;
        if (order.fails >= MAX_ORDER_FAILS) {
          const why = r.error || '成交失败';
          cancelOrder(db, player, order.id, why);
          events.push({ playerId: player.id, type: 'fail', code, name, reason: why + '，该挂单已撤销' });
        } else if (order.fails === 1) {
          events.push({ playerId: player.id, type: 'fail', code, name, reason: (r.error || '成交失败') + '，下一轮重试' });
        }
        continue;
      }

      budget.set(key, left - fillQty * px);
      order.qty = remainQty - fillQty;
      if (order.qty < 1) {
        // 全部成交：剩余押金（价格更优时的差价）退回
        if (num(order.reserve) > 0) player.cash = num(player.cash) + num(order.reserve);
        order.reserve = 0;
        removeOrder(player, order);
      }

      events.push({
        playerId: player.id,
        type: 'fill',
        code,
        name,
        side: order.side,
        qty: fillQty,
        price: r.position?.entry ?? px,
        limit: order.limit,
        rest: order.qty
      });
      continue;
    }

    // ---------- 平仓 ----------
    const pos = player.positions[code];
    const closeQty = Math.min(fillQty, Math.max(0, Math.floor(num(pos.qty))));
    if (closeQty < 1) {
      cancelOrder(db, player, order.id, '持仓已不存在');
      pushCancel('持仓已不存在');
      continue;
    }

    // 自动单在流水里标成止盈/止损，方便回看
    const r = closePosition(db, player, code, order.auto || 'limit', closeQty);
    if (!r.ok) {
      order.fails = num(order.fails) + 1;
      if (order.fails >= MAX_ORDER_FAILS) {
        const why = r.error || '平仓失败';
        cancelOrder(db, player, order.id, why);
        events.push({ playerId: player.id, type: 'fail', code, name, reason: why + '，该挂单已撤销' });
      } else if (order.fails === 1) {
        events.push({ playerId: player.id, type: 'fail', code, name, reason: r.error || '平仓失败' });
      }
      continue;
    }

    const doneQty = Math.max(1, Math.floor(num(r.qty, closeQty)));
    budget.set(key, left - doneQty * px);
    order.qty = remainQty - doneQty;
    if (order.qty < 1 || !player.positions[code]) {
      if (order.auto && player.positions[code]) player.positions[code].closing = null;
      removeOrder(player, order);
    }

    events.push({
      playerId: player.id,
      type: 'fill',
      bonus: r.bonus || 0,
      code,
      name,
      side: order.side,
      qty: r.qty ?? closeQty,
      price: px,
      limit: order.limit,
      pnl: r.pnl,
      rest: order.qty,
      // tp / sl：这张是止盈止损自动挂出来的单，用于站内通知和流水标记
      auto: order.auto || null
    });
  }

  return events;
}
