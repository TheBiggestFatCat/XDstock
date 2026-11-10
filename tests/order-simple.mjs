// 简单模式（市价单）回归测试
//
//   node tests/order-simple.mjs
//
// 简单模式 = 不看挂单价、下一轮无条件按市价成交。
// 本套只验证「两种下单方式各自成立、互不影响」，传统模式的细节仍由 order-audit.mjs 管。
// 只在内存里造 db，不碰 data/db.json。

import { createDb } from '../src/store.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { placeLimitOrder, processOrders, cancelOrder } from '../src/orders.js';
import { playerEquity } from '../src/trading.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

function newDb(patch = {}) {
  const db = createDb();
  Object.assign(db.config, {
    marketCycleEnabled: 0,
    feeRate: 0.0005,
    stampDuty: 0.0005,
    playerImpactEnabled: 0,
    impactCostCoef: 0,
    maxFillNotionalPerTick: 1000000,
    orderTtlTicks: DEFAULT_CONFIG.orderTtlTicks,
    maxPendingOrders: 5,
    maxOrdersPerTick: 5,
    liquidationBuffer: 0,
    limitOrderEnabled: 1,
    levelFillBonus: 0,
    marketOpen: true
  }, patch);
  for (const st of Object.values(db.stocks)) { st.price = 100; st.fair = 100; }
  return db;
}
function mkPlayer(db, id, cash) {
  db.players[id] = {
    id, nickname: id, cash, positions: {}, orders: [],
    theme: 'default', level: 1, orderCount: 0, orderTick: -1
  };
  return db.players[id];
}
const nextTick = (db) => { db.tick += 1; return processOrders(db); };

// ---------------------------------------------------------------- 1
log('=== 1 简单模式买入：限价远低于现价，照样无条件成交 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'a', 100000);
  // 限价 50（现价 100）—— 传统模式下这个价永远等不到，简单模式下必须成交
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 100, leverage: 1, limit: 50, simple: true });
  check('简单模式下单被接受', r.ok === true, r.error || '');
  check('订单带 simple 标记', r.ok && r.order.simple === true);
  check('下单当轮不成交', !p.positions.TGW);
  const ev = nextTick(db);
  check('下一轮无条件成交', ev.some((e) => e.type === 'fill'));
  const pos = p.positions.TGW;
  check('成交价 = 市价 100（不是限价 50）', pos && pos.entry === 100, pos ? `entry=${pos.entry}` : '无持仓');
  check('挂单已出队', p.orders.length === 0);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 传统模式对照：同样的限价 50 不成交（两种模式互不影响）===');
{
  const db = newDb();
  const p = mkPlayer(db, 'a', 100000);
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 100, leverage: 1, limit: 50 });
  check('传统模式下单不带 simple 标记', r.ok && !r.order.simple);
  const ev = nextTick(db);
  check('没有成交事件', !ev.some((e) => e.type === 'fill'));
  check('没有持仓（限价没到）', !p.positions.TGW);
  check('挂单还在队列里', p.orders.length === 1);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 简单模式成交价跟下一轮市价走（下一轮涨到 120 → 按 120 成交）===');
{
  const db = newDb();
  const p = mkPlayer(db, 'a', 100000);
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 100, leverage: 1, limit: 100, simple: true });
  check('下单成功', r.ok, r.error || '');
  db.stocks.TGW.price = 120;                  // 下一轮跳空上涨
  nextTick(db);
  check('按跳空后的市价成交', p.positions.TGW && p.positions.TGW.entry === 120,
    p.positions.TGW ? `entry=${p.positions.TGW.entry}` : '无持仓');
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 简单模式押金含 3% 跳空缓冲 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'a', 100000);
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 100, leverage: 1, simple: true });
  check('不填 limit 也能下单', r.ok === true, r.error || '');
  const want = 100 * 100 * 1.03 * (1 + 0.0005);
  check('押金 = 现价 ×1.03 ×(1+手续费率)', r.ok && near(r.reserved, want, 1e-4),
    `reserved=${r.ok ? r.reserved.toFixed(4) : '-'} 期望≈${want.toFixed(4)}`);
  check('冻结后现金减少', near(p.cash, 100000 - r.reserved));
  // 成交后多余押金退回：只花掉实际成交价 + 手续费
  nextTick(db);
  const fee = 100 * 100 * 0.0005;
  check('差额已退回（只花掉成交额 + 手续费）', near(playerEquity(db, p), 100000 - fee),
    `equity=${playerEquity(db, p).toFixed(4)}`);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 简单模式卖空：价格上冲也不会因为限价被挡住 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'a', 100000);
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'short', qty: 100, leverage: 1, limit: 100, simple: true });
  check('卖空下单成功', r.ok, r.error || '');
  db.stocks.TGW.price = 96;                   // 跌到限价下方：传统「涨到 100 才卖」不会成交
  const ev = nextTick(db);
  check('简单模式照样成交', ev.some((e) => e.type === 'fill'));
  check('成交价 = 96', p.positions.TGW && p.positions.TGW.entry === 96,
    p.positions.TGW ? `entry=${p.positions.TGW.entry}` : '无持仓');
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 简单模式平仓：满仓单按市价无条件成交，流水标记 market ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'a', 100000);
  placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 100, leverage: 1, simple: true });
  nextTick(db);
  db.stocks.TGW.price = 110;
  // 平多需要 px >= limit 才成交；限价 999 永远等不到
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'close', side: 'long', limit: 999, simple: true });
  check('平仓单被接受', r.ok === true, r.error || '');
  check('平仓单也是 simple', r.ok && r.order.simple === true);
  const ev = nextTick(db);
  check('平仓无条件成交', ev.some((e) => e.type === 'fill' && e.side === 'long'));
  check('持仓已清', !p.positions.TGW);
  const last = db.trades[db.trades.length - 1];
  check('流水 reason = market', last && last.action === 'close' && last.reason === 'market',
    last ? `${last.action}/${last.reason}` : '无流水');
  check('平仓价 = 市价 110', last && last.price === 110, last ? `price=${last.price}` : '-');
}

// ---------------------------------------------------------------- 7
log('');
log('=== 7 简单模式大单按每轮额度分批（不会一口气顶穿成交上限）===');
{
  const db = newDb({ maxFillNotionalPerTick: 5000 });
  const p = mkPlayer(db, 'a', 100000);
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 100, leverage: 1, simple: true });
  check('下单成功', r.ok, r.error || '');
  nextTick(db);
  check('第一轮只成交 50 股（5000 / 100）', p.positions.TGW && p.positions.TGW.qty === 50,
    p.positions.TGW ? `qty=${p.positions.TGW.qty}` : '无持仓');
  check('剩余 50 股还在队列', p.orders.length === 1 && p.orders[0].qty === 50);
  nextTick(db);
  check('第二轮吃完', p.positions.TGW && p.positions.TGW.qty === 100,
    p.positions.TGW ? `qty=${p.positions.TGW.qty}` : '无持仓');
  check('队列已空', p.orders.length === 0);
}

// ---------------------------------------------------------------- 8
log('');
log('=== 8 简单模式照样受「同票开平冲突」「同时挂单上限」约束 ===');
{
  const db = newDb({ maxPendingOrders: 2 });
  const p = mkPlayer(db, 'a', 100000);
  placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 100, leverage: 1, simple: true });
  nextTick(db);
  // 有持仓后：先挂一张手动平仓单，再想简单模式开仓 → 应该被挡
  const close = placeLimitOrder(db, p, { code: 'TGW', action: 'close', side: 'long', limit: 200, simple: true });
  check('平仓单挂出', close.ok === true, close.error || '');
  const reopen = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 10, leverage: 1, simple: true });
  check('有未成交平仓单时禁止开仓', reopen.ok === false, reopen.error || '');
}

// ---------------------------------------------------------------- 9
log('');
log('=== 9 撤单全额退押金（简单模式同样适用）===');
{
  const db = newDb();
  const p = mkPlayer(db, 'a', 100000);
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 100, leverage: 1, simple: true });
  const afterOrder = p.cash;
  check('押金已冻结', afterOrder < 100000);
  const c = cancelOrder(db, p, r.order.id);
  check('撤单成功', c.ok === true);
  check('现金全额退回', near(p.cash, 100000), `cash=${p.cash}`);
  check('队列已空', p.orders.length === 0);
}

// ---------------------------------------------------------------- 10
log('');
log('=== 10 停牌不撮合：简单模式也一样等复牌 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'a', 100000);
  db.stocks.TGW.status = 'suspended';
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 100, leverage: 1, simple: true });
  check('停牌时不接受下单', r.ok === false, r.error || '');
}

// ---------------------------------------------------------------- 11
log('');
log('=== 11 「允许限价挂单」关闭时：限价单被拒，简单模式仍可用（市价单不是挂单）===');
{
  const db = newDb({ limitOrderEnabled: 0 });
  const p = mkPlayer(db, 'a', 100000);
  const lim = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 100, leverage: 1, limit: 101 });
  check('传统挂单被拒', lim.ok === false && /挂单功能已关闭/.test(lim.error || ''), lim.error || '');
  const smp = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 100, leverage: 1, simple: true });
  check('简单模式仍可下单', smp.ok === true, smp.error || '');
  const ev = nextTick(db);
  check('并且真的成交了', ev.some((e) => e.type === 'fill'));
}

// ---------------------------------------------------------------- 12
log('');
log('=== 12 两个玩家各用一种模式，互不干扰 ===');
{
  const db = newDb();
  const a = mkPlayer(db, 'a', 100000);   // 简单模式
  const b = mkPlayer(db, 'b', 100000);   // 传统模式，限价 50 永远不成交
  placeLimitOrder(db, a, { code: 'TGW', action: 'open', side: 'long', qty: 100, leverage: 1, simple: true });
  placeLimitOrder(db, b, { code: 'TGW', action: 'open', side: 'long', qty: 100, leverage: 1, limit: 50 });
  const ev = nextTick(db);
  const fillA = ev.find((e) => e.type === 'fill' && e.playerId === 'a');
  const fillB = ev.find((e) => e.type === 'fill' && e.playerId === 'b');
  check('A（简单）成交', !!fillA);
  check('B（传统）没成交', !fillB);
  check('B 的挂单还在', b.orders.length === 1);
  check('B 没有持仓', !b.positions.TGW);
}

// ---------------------------------------------------------------- 13
log('');
log('=== 13 简单模式押金只看现价，不看（可能填得很远的）挂单价 ===');
{
  const dbA = newDb();
  const a = mkPlayer(dbA, 'a', 100000);
  const ra = placeLimitOrder(dbA, a, { code: 'TGW', action: 'open', side: 'long', qty: 10, leverage: 1, limit: 50, simple: true });
  const dbB = newDb();
  const b = mkPlayer(dbB, 'b', 100000);
  const rb = placeLimitOrder(dbB, b, { code: 'TGW', action: 'open', side: 'long', qty: 10, leverage: 1, limit: 900, simple: true });
  check('limit 填 50 和填 900，押金完全一样', ra.ok && rb.ok && near(ra.reserved, rb.reserved),
    `${ra.ok ? ra.reserved.toFixed(4) : '-'} vs ${rb.ok ? rb.reserved.toFixed(4) : '-'}`);
  check('押金 = 现价 × 1.03 × (1 + 手续费率)',
    ra.ok && near(ra.reserved, 100 * 10 * 1.03 * 1.0005, 1e-4),
    ra.ok ? `reserved=${ra.reserved.toFixed(4)}` : '-');
}

// ---------------------------------------------------------------- 14
log('');
log('=== 14 全仓买入：按前端口径算出的股数必须被服务端接受（旧 bug：差 3% 报资金不足）===');
{
  const db = newDb();
  const p = mkPlayer(db, 'a', 100000);
  const px = 100;
  // 复刻 public/app.js#maxAffordableQty 的简单模式口径：
  //   预算 = 现金 × 0.99，每股成本按「现价 × 1.03」算（= 服务端 SIMPLE_RESERVE_SLIP 缓冲）
  const perShare = px * 1.03 * (1 + db.config.feeRate);
  const qty = Math.floor((100000 * 0.99) / perShare);
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty, leverage: 1, simple: true });
  check('全仓股数（' + qty + '）被接受', r.ok === true, r.error || '');
  check('冻结押金不超过现金', r.ok && r.reserved <= 100000, r.ok ? `reserved=${r.reserved.toFixed(2)}` : '-');
  check('冻结后现金非负', p.cash >= -1e-9, `cash=${p.cash.toFixed(4)}`);

  // 下一轮成交：按现价（不打 3% 折）成交，多冻的押金退回，现金不能为负
  const ev = nextTick(db);
  const fill = ev.find((e) => e.type === 'fill' && e.playerId === 'a');
  check('全仓单成交', !!fill);
  check('成交后现金非负', p.cash >= -1e-6, `cash=${p.cash.toFixed(4)}`);
  check('按全仓股数全部成交', p.positions.TGW?.qty === qty, `qty=${p.positions.TGW?.qty ?? 0} 期望=${qty}`);
  check('剩余冻结押金已退回（没有挂单残留押金）', p.orders.every((o) => !o.reserve),
    `reserve=${p.orders.reduce((s, o) => s + (o.reserve || 0), 0).toFixed(4)}`);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
