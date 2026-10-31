import { now } from './store.js';

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
  for (const [code, pos] of Object.entries(player.positions || {})) {
    const st = db.stocks[code];
    if (!st) continue;
    equity += positionEquity(pos, st.price);
  }
  return equity;
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
  const fee = notional * (cfg.feeRate ?? 0);
  const stamp = side === 'short' ? notional * (cfg.stampDuty ?? 0) : 0;

  const cost = margin + fee + stamp;
  if (player.cash < cost) {
    return { ok: false, error: `现金不足，需要 $${cost.toFixed(2)}，你只有 $${player.cash.toFixed(2)}` };
  }

  const exist = player.positions[code];
  if (exist && exist.side !== side) {
    return { ok: false, error: '这只票你还有反向持仓，先平掉再开' };
  }

  player.cash -= cost;
  db.tradesThisTick = (db.tradesThisTick || 0) + 1;

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
      openedAt: now()
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

  return { ok: true, position: player.positions[code] };
}

export function closePosition(db, player, code, reason = 'manual') {
  const cfg = db.config;
  const pos = player.positions[code];
  if (!pos) return { ok: false, error: '没有这只票的持仓' };
  const st = db.stocks[code];
  if (!st) return { ok: false, error: '标的不存在' };

  const price = st.price;
  const notional = pos.qty * price;
  const pnl = positionPnl(pos, price);
  const fee = notional * (cfg.feeRate ?? 0);
  // 平多 = 卖出，收印花税；平空 = 买入，不收
  const stamp = pos.side === 'long' ? notional * (cfg.stampDuty ?? 0) : 0;

  let equity = pos.margin + pnl;
  if (equity < 0) equity = 0; // 亏损不会超过保证金
  const back = Math.max(0, equity - fee - stamp);

  player.cash += back;
  delete player.positions[code];
  db.tradesThisTick = (db.tradesThisTick || 0) + 1;

  return {
    ok: true,
    code,
    side: pos.side,
    qty: pos.qty,
    entry: pos.entry,
    price,
    pnl,
    fee,
    stamp,
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

      // 强平
      if (equity <= (db.config.liquidationBuffer ?? 0)) {
        const r = closePosition(db, player, code, 'liquidated');
        results.push({ playerId: player.id, ...r });
        continue;
      }

      // 止盈止损
      const dir = pos.side === 'long' ? 1 : -1;
      let hit = null;
      if (pos.tp && (price - pos.tp) * dir >= 0) hit = 'tp';
      if (pos.sl && (price - pos.sl) * dir <= 0) hit = 'sl';
      if (hit) {
        const r = closePosition(db, player, code, hit);
        results.push({ playerId: player.id, ...r });
      }
    }
  }
  return results;
}
