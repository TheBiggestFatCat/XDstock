// 自动定投（Lv.2 商城道具）
//
//   打工钱袋每次攒满 → 自动收进现金 → 自动挂一张 DENG 买单
//   挂单价 = DENG 现价 ×(1 + shopAutoDcaPremium)，默认 +3%，保证下一轮能成交
//   股数 = 钱袋 ÷ 挂单价（押金按挂单价冻结，剩下的钱成交后退回现金）
//
// 整个 tick 循环对「所有玩家」生效，不看在线状态，所以离线也会定投。

import { placeLimitOrder, estimateReserve } from './orders.js';

export const AUTO_DCA_CODE = 'DENG';

/** 算出这一次定投要挂的单（不产生副作用） */
export function autoDcaPlan(db, bank) {
  const cfg = (db && db.config) || {};
  const st = db.stocks?.[AUTO_DCA_CODE];
  const price = Number(st && st.price) || 0;
  const premium = Math.max(0, Math.min(0.5, Number(cfg.shopAutoDcaPremium ?? 0.03)));
  const limit = Math.round(price * (1 + premium) * 100) / 100;
  const money = Math.max(0, Number(bank) || 0);
  let qty = limit > 0 ? Math.floor(money / limit) : 0;
  // 押金不只是「股数×挂单价」：还有手续费和冲击成本。
  // 按真实押金往下缩，保证钱袋一定付得起（否则会每轮重试、永远挂不上）。
  let guard = 0;
  while (qty > 0 && guard < 10) {
    const need = estimateReserve(db, st, limit, qty, 1, 'long');
    if (need <= money) break;
    const scaled = Math.floor(qty * (money / need));
    qty = scaled < qty ? scaled : qty - 1;
    guard += 1;
  }
  return { code: AUTO_DCA_CODE, price, limit, qty, premium, bank: money };
}

/**
 * 每轮检查一次。
 * @param {number} bankCap 打工钱袋上限；<=0 表示打工没开，定投不触发
 * @returns 本轮的处理结果（给日志/调试用）
 */
export function autoDcaTick(db, bankCap) {
  const out = [];
  const cap = Number(bankCap) || 0;
  if (!(cap > 0)) return out;
  const st = db.stocks?.[AUTO_DCA_CODE];
  if (!st || st.status !== 'normal') return out;

  for (const p of Object.values(db.players || {})) {
    if (!p.autoDca || p.autoDcaOn === false) continue;
    const bank = Math.max(0, Number(p.workBank) || 0);
    if (bank < cap) continue;
    // 上一张定投单还没成交（或没被撤），这轮先不挂第二张
    if (Array.isArray(p.orders) && p.orders.some((o) => o.autoDca)) continue;

    const plan = autoDcaPlan(db, bank);
    if (plan.qty < 1) continue;

    // 先把钱袋收进现金（等价于点了一次「收钱」），再挂单
    p.cash = (Number(p.cash) || 0) + bank;
    p.workEarned = (Number(p.workEarned) || 0) + bank;
    p.workBank = 0;

    const r = placeLimitOrder(db, p, {
      code: plan.code,
      action: 'open',
      side: 'long',
      qty: plan.qty,
      leverage: 1,
      limit: plan.limit,
      system: true   // 系统单：不占「同时挂单」名额
    });

    if (!r.ok) {
      // 挂不上就原样还回去，别把玩家的打工钱吞了
      p.workBank = bank;
      p.cash = (Number(p.cash) || 0) - bank;
      p.workEarned = Math.max(0, (Number(p.workEarned) || 0) - bank);
      out.push({ playerId: p.id, ok: false, reason: r.error || '下单失败', bank });
      continue;
    }

    r.order.autoDca = true;
    out.push({
      playerId: p.id,
      ok: true,
      code: plan.code,
      qty: plan.qty,
      limit: plan.limit,
      bank
    });
  }
  return out;
}
