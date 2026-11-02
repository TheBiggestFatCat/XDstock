// 限价挂单：真实股市的挂单机制
//
//   开多 = 买入：价格跌到限价（或更低）才成交
//   开空 = 卖出：价格涨到限价（或更高）才成交
//   平多 = 卖出：价格涨到限价（或更高）才成交
//   平空 = 买入：价格跌到限价（或更低）才成交
//
// 开仓单会把「保证金 + 手续费 + 印花税」先扣下来押在订单里，
// 撤单或到期全额退回，成交时按实际价格结算（不会比限价更贵）。

import { openPosition, closePosition } from './trading.js';

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

function uid() {
  return 'o_' + Math.random().toString(36).slice(2, 10);
}

/** 这笔单子是买入方向吗 */
export function isBuyOrder(order) {
  if (order.action === 'open') return order.side === 'long';
  return order.side === 'short'; // 平空 = 买回
}

/** 按当前价估算开仓需要押多少钱 */
export function estimateReserve(cfg, price, qty, leverage, side) {
  const notional = qty * price;
  const margin = notional / Math.max(1, leverage);
  const fee = notional * num(cfg.feeRate, 0);
  const stamp = side === 'short' ? notional * num(cfg.stampDuty, 0) : 0;
  return margin + fee + stamp;
}

/** 挂一笔限价单 */
export function placeLimitOrder(db, player, body) {
  const cfg = db.config;
  if (num(cfg.limitOrderEnabled, 1) === 0) {
    return { ok: false, error: '挂单功能已关闭' };
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
  if (player.orders.length >= maxPending) {
    return { ok: false, error: `最多同时挂 ${maxPending} 笔单，先撤掉一些` };
  }

  const ttl = Math.max(1, num(cfg.orderTtlTicks, 720));
  const expireTick = db.tick + ttl;

  if (action === 'close') {
    const pos = player.positions[code];
    if (!pos) return { ok: false, error: '你没有这只票的持仓' };
    if (pos.side !== side) return { ok: false, error: '方向和持仓不一致' };

    const order = {
      id: uid(),
      code,
      name: st.name,
      action,
      side,
      qty: pos.qty,
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
  //   买单 → 直接按【限价】冻结（成交价最高就是限价，按现价冻结价格一涨就不够）
  //   卖单 → 取限价和现价里更高的那个
  const buySide = side === 'long';
  const refPrice = buySide ? limit : Math.max(limit, st.price);
  const reserve = estimateReserve(cfg, refPrice, qty, leverage, side);
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

/**
 * 每个 tick 撮合一次（价格更新之后调用）
 * 返回成交/撤单事件列表，用于推送提示
 */
export function processOrders(db) {
  const events = [];

  for (const player of Object.values(db.players)) {
    const orders = player.orders;
    if (!Array.isArray(orders) || !orders.length) continue;

    for (const order of [...orders]) {
      const st = db.stocks[order.code];

      // 标的没了 / 退市 → 撤单退款
      if (!st || st.status === 'delisted') {
        cancelOrder(db, player, order.id, '标的已退市，自动撤单');
        events.push({ playerId: player.id, type: 'cancel', code: order.code, name: order.name, reason: '标的已退市' });
        continue;
      }

      // 超时撤单（自动单给两倍时间）
      const ttlCap = order.auto
        ? (order.createdTick || 0) + Math.max(1, num(db.config.orderTtlTicks, 720)) * 2
        : (order.expireTick || 0);
      if (db.tick > ttlCap) {
        cancelOrder(db, player, order.id, '挂单超时');
        events.push({ playerId: player.id, type: 'cancel', code: order.code, name: order.name, reason: '超时自动撤单' });
        continue;
      }

      // 停牌不撮合
      if (st.status !== 'normal') continue;

      // 下单当轮不成交，从下一轮开始排队
      if (db.tick <= (order.createdTick ?? 0)) continue;

      const px = st.price;
      const buy = isBuyOrder(order);
      // 买单：价格跌到限价以下才成交；卖单：涨到限价以上才成交
      const hit = buy ? px <= order.limit : px >= order.limit;
      if (!hit) continue;

      // 止盈止损自动单：每轮重新按现价定一次可成交价，保证追得上行情
      if (order.auto) {
        const buyNow = isBuyOrder(order);
        const slipN = 0.004;
        order.limit = Math.round(
          (buyNow ? px * (1 + slipN) : px * (1 - slipN)) * 100
        ) / 100;
      }

      // 每轮最多成交这么多「金额」，换算成股数（大单会被拆成多轮）
      // 与杠杆无关：杠杆只影响占用多少保证金，不影响这张单在市场里吃掉的筹码
      // 玩家买了「交易专属通道」的话，每级 +10 万
      const channelStep = num(db.config.shopChannelStep, 100000);
      const channelLevel = Math.max(0, Math.floor(num(player.channelLevel, 0)));
      const notionalCap = Math.max(1, num(db.config.maxFillNotionalPerTick, 300000))
        + channelLevel * channelStep;
      const fillCap = Math.max(1, Math.floor(notionalCap / Math.max(px, 0.01)));
      const remainQty = Math.max(0, Math.floor(order.qty));
      if (remainQty < 1) {
        const idx = orders.indexOf(order);
        if (idx >= 0) orders.splice(idx, 1);
        continue;
      }
      const fillQty = Math.min(fillCap, remainQty);

      if (order.action === 'open') {
        // 从押金里按比例解冻这一轮要用的部分
        const perShareReserve = (order.reserve || 0) / remainQty;
        let portion = perShareReserve * fillQty;

        // 价格如果往上跳了，按比例解冻的不一定够这一轮的成本，
        // 就从本单剩下的押金里再补一点，避免误报「现金不足」并撤单
        const needNow = estimateReserve(db.config, px, fillQty, order.leverage, order.side) * 1.01;
        if (needNow > portion) {
          const spare = Math.max(0, (order.reserve || 0) - portion);
          portion += Math.min(spare, needNow - portion);
        }
        player.cash = num(player.cash, 0) + portion;

        const r = openPosition(db, player, {
          code: order.code,
          side: order.side,
          qty: fillQty,
          leverage: order.leverage
        });

        if (!r.ok) {
          // 成交失败：押金退回去，单子留着下一轮再试
          player.cash = num(player.cash, 0) - portion;
          if (order.reserve > 0) {
            events.push({
              playerId: player.id,
              type: 'fail',
              code: order.code,
              name: order.name,
              reason: (r.error || '成交失败') + '，该挂单已自动撤销'
            });
            // 失败一次就撤掉，避免死循环
            const idx = orders.indexOf(order);
            if (idx >= 0) orders.splice(idx, 1);
            player.cash = num(player.cash, 0) + (order.reserve || 0);
            order.reserve = 0;
          }
          continue;
        }

        order.qty -= fillQty;
        order.reserve = Math.max(0, (order.reserve || 0) - portion);

        if (order.qty < 1) {
          // 全部成交：剩余押金（价格更优时的差价）退回
          if (order.reserve > 0) player.cash = num(player.cash, 0) + order.reserve;
          order.reserve = 0;
          const idx = orders.indexOf(order);
          if (idx >= 0) orders.splice(idx, 1);
        }

        events.push({
          playerId: player.id,
          type: 'fill',
          code: order.code,
          name: order.name,
          side: order.side,
          qty: fillQty,
          price: r.position?.entry ?? st.price,
          limit: order.limit,
          rest: order.qty
        });
      } else {
        const pos = player.positions[order.code];
        if (!pos) {
          const idx = orders.indexOf(order);
          if (idx >= 0) orders.splice(idx, 1);
          events.push({
            playerId: player.id,
            type: 'cancel',
            code: order.code,
            name: order.name,
            reason: '持仓已不存在'
          });
          continue;
        }

        const closeQtyNow = Math.min(fillQty, pos.qty);
        // 自动单在流水里标成止盈/止损，方便回看
        const r = closePosition(db, player, order.code, order.auto || 'limit', closeQtyNow);
        if (!r.ok) {
          events.push({ playerId: player.id, type: 'fail', code: order.code, name: order.name, reason: r.error });
          const idx = orders.indexOf(order);
          if (idx >= 0) orders.splice(idx, 1);
          continue;
        }

        order.qty -= closeQtyNow;
        if (order.qty < 1 || !player.positions[order.code]) {
          const idx = orders.indexOf(order);
          if (idx >= 0) orders.splice(idx, 1);
        }

        events.push({
          playerId: player.id,
          type: 'fill',
          bonus: r.bonus || 0,
          code: order.code,
          name: order.name,
          side: order.side,
          qty: r.qty ?? closeQtyNow,
          price: st.price,
          limit: order.limit,
          pnl: r.pnl,
          rest: order.qty
        });
      }
    }
  }

  return events;
}
