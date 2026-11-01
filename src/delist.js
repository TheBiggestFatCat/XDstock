// 退市处理：把一只票从市场里摘掉
//
//   1. 状态标记为 delisted（停牌、不可交易）
//   2. 所有持仓按最后价格强制平掉（爆仓价外的情况也要出清）
//   3. 相关挂单下一轮由 processOrders 自动撤销并退款
//   4. 发一条公告

import { closePosition } from './trading.js';
import { now } from './store.js';

export function delistStock(db, st, reason = '股价长期低于面值') {
  if (!st || st.status === 'delisted') return null;

  st.status = 'delisted';
  st.st = false;
  st.stTicks = 0;
  st.delistedAt = now();
  st.delistReason = reason;

  const results = [];
  for (const player of Object.values(db.players || {})) {
    const pos = player.positions?.[st.code];
    if (!pos) continue;
    const r = closePosition(db, player, st.code, 'delisted');
    results.push({ playerId: player.id, ...r });
  }

  if (!Array.isArray(db.notices)) db.notices = [];
  db.notices.push({
    id: 'n_' + Math.random().toString(36).slice(2, 10),
    text: `【退市】${st.name}（${st.code}）${reason}，已停止交易，所有持仓按最后价 ${st.price.toFixed(2)} 强制平仓。`,
    at: now(),
    kind: 'delist'
  });
  if (db.notices.length > 20) db.notices.splice(0, db.notices.length - 20);

  if (!Array.isArray(db.events)) db.events = [];
  db.events.push({
    id: 'ev_' + Math.random().toString(36).slice(2, 10),
    kind: 'leak',
    text: `${st.name}（${st.code}）正式退市，股民在交易所门口合影留念`,
    companies: [],
    dir: 0,
    trend: 0,
    leakTicks: 0,
    leakLeft: 0,
    duration: 1,
    remaining: 1,
    createdAt: now(),
    announced: true,
    delist: true
  });

  return { code: st.code, name: st.name, closed: results.length };
}

/** 每轮检查有没有触发退市的股票 */
export function checkDelist(db) {
  const cfg = db.config || {};
  const limit = Math.max(1, Math.round(Number(cfg.stDelistTicks ?? 100)));
  const stPrice = Math.max(0.01, Number(cfg.stPrice ?? 3));
  const out = [];
  for (const st of Object.values(db.stocks || {})) {
    if (st.isIndex || st.status === 'delisted') continue;
    if (st.price >= stPrice) continue;
    if ((st.stTicks || 0) < limit) continue;
    const r = delistStock(db, st, `连续 ${limit} 轮低于 ${stPrice.toFixed(2)} 元`);
    if (r) out.push(r);
  }
  return out;
}
