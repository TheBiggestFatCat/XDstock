// 下单 / 撮合 / 结算 回归测试
//
//   node tests/order-audit.mjs
//
// 只在内存里造 db，直接调 src/* 的函数，不碰 data/db.json，也不起 HTTP 服务。
// 每个场景对应过去踩过的一个坑，改了下单逻辑后跑一遍，全绿再发版。

import { createDb } from '../src/store.js';
import {
  placeLimitOrder, processOrders, cancelOrder, estimateReserve,
  orderLimitBlocked, consumeOrderSlot, fillCapFor
} from '../src/orders.js';
import { openPosition, closePosition, checkPositions, playerEquity } from '../src/trading.js';

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
    feeRate: 0.0005,
    stampDuty: 0.0005,
    playerImpactEnabled: 0,
    impactCostCoef: 0,
    maxFillNotionalPerTick: 1000000,
    orderTtlTicks: 720,
    maxPendingOrders: 5,
    maxOrdersPerTick: 5,
    liquidationBuffer: 0,
    limitOrderEnabled: 1,
    // 默认关掉等级加成，免得把「小额限额」的用例顶穿；需要时用例自己开
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
const nextTickOrders = (db) => { db.tick += 1; return processOrders(db); };
const nextTickFull = (db) => { db.tick += 1; const ev = processOrders(db); const cl = checkPositions(db); return { ev, cl }; };

// ---------------------------------------------------------------- 1
log('=== 1 基础成交：买 100 股 @限价 101（现价 100，1x）===');
{
  const db = newDb();
  const p = mkPlayer(db, 'a', 100000);
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 100, leverage: 1, limit: 101 });
  check('挂单被接受', r.ok, r.error || '');
  check('押金 = 限价名义 + 手续费', near(r.reserved, 10100 + 10100 * 0.0005), `reserved=${r.reserved.toFixed(4)}`);
  check('挂单后现金 = 初始 - 押金', near(p.cash, 100000 - r.reserved), `cash=${p.cash.toFixed(4)}`);
  const ev = nextTickOrders(db);
  check('下一轮成交', ev.some((e) => e.type === 'fill'));
  const pos = p.positions.TGW;
  check('成交价 = 市场价 100（不是限价 101）', pos && pos.entry === 100, pos ? `entry=${pos.entry}` : 'no position');
  check('挂单已出队', p.orders.length === 0);
  check('总资产守恒（只少一次手续费 $5）', near(playerEquity(db, p), 99995), `equity=${playerEquity(db, p).toFixed(4)}`);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 部分成交：每轮上限 500 美元，10 股分两轮 ===');
{
  const db = newDb({ maxFillNotionalPerTick: 500 });
  const p = mkPlayer(db, 'a', 100000);
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 10, leverage: 1, limit: 101 });
  const reserve0 = r.reserved;
  let ev = nextTickOrders(db);
  const f1 = ev.find((e) => e.type === 'fill');
  check('第一轮只成交 5 股', f1 && f1.qty === 5, f1 ? `qty=${f1.qty} rest=${f1.rest}` : '无成交');
  check('剩余单还在队里', p.orders.length === 1 && p.orders[0].qty === 5);
  check('押金按成交比例退', near(p.orders[0].reserve, reserve0 / 2), `reserve=${p.orders[0].reserve.toFixed(4)}`);
  ev = nextTickOrders(db);
  check('第二轮成交剩余 5 股', ev.some((e) => e.type === 'fill'));
  check('总资产守恒（手续费 0.5）', near(playerEquity(db, p), 99999.5), `equity=${playerEquity(db, p).toFixed(4)}`);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 押金必须包含冲击成本（否则成交时被自己卡死）===');
{
  const patch = {
    playerImpactEnabled: 1, impactCostCoef: 6, playerImpactRef: 1000000,
    playerImpactStrength: 0.0009, maxFillNotionalPerTick: 300000
  };
  const db = newDb(patch);
  const notional = 1000 * 100;
  const rate = (notional / 1000000) * 0.0009 * 6;
  const need = estimateReserve(db, db.stocks.TGW, 100, 1000, 1, 'long');
  log(`  1000 股×100：冲击费率 ${(rate * 100).toFixed(4)}% → 冲击成本 $${(notional * rate).toFixed(2)}`);
  check('押金已含冲击成本', near(need, 100000 + 50 + 54), `reserve=${need.toFixed(2)}`);
  const p = mkPlayer(db, 'a', need);              // 全仓，一分不剩
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 1000, leverage: 1, limit: 100 });
  check('全仓挂单被接受', r.ok, r.error || '');
  const ev = nextTickOrders(db);
  check('全仓也能成交（不再报现金不足）', ev.some((e) => e.type === 'fill'), JSON.stringify(ev.map((e) => e.type)));
  check('持仓 1000 股', p.positions.TGW && p.positions.TGW.qty === 1000);
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 止损跳空：止损必须真的平掉 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'a', 200000);
  openPosition(db, p, { code: 'TGW', side: 'long', qty: 100, leverage: 1 });
  p.positions.TGW.tpsl = [{ id: 'ts_1', kind: 'sl', price: 96, qty: null, fired: false }];
  db.stocks.TGW.price = 95;
  db.tick += 1;
  const cl = checkPositions(db);
  const order = p.orders[0];
  check('触发止损 → 生成自动平仓单', cl.some((x) => x.autoOrder === 'sl') && !!order, order ? `limit=${order.limit}` : '没生成');
  check('自动单 TTL 是双倍且 expireTick 一致', order && order.expireTick === db.tick + db.config.orderTtlTicks * 2, order ? `expireTick=${order.expireTick}` : '');
  check('自动单不占「手动挂单」名额', true);
  // 跳空到 90：旧实现会挂在上方等反弹，新实现必须当轮平掉
  db.stocks.TGW.price = 90;
  db.tick += 1;
  const ev = processOrders(db);
  const f = ev.find((e) => e.type === 'fill');
  check('跳空到 90 时止损单成交（修复 B1）', !!f, f ? `price=${f.price} qty=${f.qty}` : JSON.stringify(ev.map((e) => e.type)));
  check('成交价 = 跳空后的市价 90', f && f.price === 90, f ? `price=${f.price}` : '');
  check('持仓已清空', !p.positions.TGW);
  check('止损单已出队', p.orders.length === 0);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 每人每轮操作次数 ===');
{
  const db = newDb({ maxOrdersPerTick: 1 });
  const p = mkPlayer(db, 'a', 1000000);
  check('第一次下单前没被拦', orderLimitBlocked(db, p) === null);
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 1, leverage: 1, limit: 101 });
  check('第一单成功', r.ok, r.error || '');
  consumeOrderSlot(db, p);
  const blocked = orderLimitBlocked(db, p);
  check('同一轮第二单被拦（修复 B2/B15）', typeof blocked === 'string' && /每轮只能操作 1 次/.test(blocked), blocked || '未拦住');
  db.tick += 1;
  check('下一轮恢复', orderLimitBlocked(db, p) === null);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 两个玩家同一只票同一轮都能成交（不再互相占位）===');
{
  const db = newDb();
  const a = mkPlayer(db, 'a', 1000000);
  const b = mkPlayer(db, 'b', 1000000);
  placeLimitOrder(db, a, { code: 'TGW', action: 'open', side: 'long', qty: 10, leverage: 1, limit: 100.5 });
  placeLimitOrder(db, b, { code: 'TGW', action: 'open', side: 'long', qty: 10, leverage: 1, limit: 105 });
  const ev = nextTickOrders(db);
  const filled = new Set(ev.filter((e) => e.type === 'fill').map((e) => e.playerId));
  check('a 和 b 都成交（修复 B2）', filled.has('a') && filled.has('b'), JSON.stringify([...filled]));
  check('a 成交 10 股、b 成交 10 股', a.positions.TGW?.qty === 10 && b.positions.TGW?.qty === 10);
}

// ---------------------------------------------------------------- 7
log('');
log('=== 7 价格优先：同一玩家同票多单按限价攻击性排序 ===');
{
  const db = newDb({ maxFillNotionalPerTick: 500 });
  const p = mkPlayer(db, 'a', 1000000);
  // 先挂低价的，再挂高价的；预算只够 5 股，应该由高价单先成交
  placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 20, leverage: 1, limit: 100.2 });
  placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 20, leverage: 1, limit: 104 });
  const ev = nextTickOrders(db);
  const f = ev.filter((e) => e.type === 'fill');
  check('本轮只成交一张、5 股', f.length === 1 && f[0].qty === 5, JSON.stringify(f.map((e) => [e.qty, e.limit])));
  check('成交的是限价更高那张（104）', f[0] && Number(f[0].limit) === 104, f[0] ? `limit=${f[0].limit}` : '');
  const rest = p.orders.map((o) => [Number(o.limit), o.qty]);
  check('另一张原样排队', rest.some(([l]) => l === 100.2));
}

// ---------------------------------------------------------------- 8
log('');
log('=== 8 残留平仓单不会平掉反向新仓 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'a', 200000);
  openPosition(db, p, { code: 'TGW', side: 'long', qty: 100, leverage: 1 });
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'close', side: 'long', limit: 90 });
  check('挂了一张 90 的平多单', r.ok, r.error || '');
  closePosition(db, p, 'TGW', 'manual');
  openPosition(db, p, { code: 'TGW', side: 'short', qty: 100, leverage: 1 });
  const ev = nextTickOrders(db);
  check('方向不一致的旧平仓单被撤销（修复 B8）', ev.some((e) => e.type === 'cancel'), JSON.stringify(ev.map((e) => e.type)));
  check('新开的空单完好无损', p.positions.TGW && p.positions.TGW.side === 'short' && p.positions.TGW.qty === 100);
}

// ---------------------------------------------------------------- 9
log('');
log('=== 9 撤单 / 超时撤单都全额退款 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'a', 100000);
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 10, leverage: 1, limit: 101 });
  const c = cancelOrder(db, p, r.order.id);
  check('撤单成功', c.ok);
  check('押金全额退回', near(p.cash, 100000), `cash=${p.cash.toFixed(4)}`);
  const r2 = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 10, leverage: 1, limit: 90 });
  db.tick = r2.order.expireTick + 1;
  const ev = processOrders(db);
  check('超时自动撤单', ev.some((e) => e.type === 'cancel'));
  check('超时撤单也退款', near(p.cash, 100000), `cash=${p.cash.toFixed(4)}`);
}

// ---------------------------------------------------------------- 10
log('');
log('=== 10 休市期间禁止下单 ===');
{
  const db = newDb({ marketOpen: false });
  const p = mkPlayer(db, 'a', 100000);
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 1, leverage: 1, limit: 101 });
  check('休市挂单被拒（修复 B9）', !r.ok && r.status === 423, r.error || '竟然成功了');
  check('押金没被动', near(p.cash, 100000));
}

// ---------------------------------------------------------------- 11
log('');
log('=== 11 手动远价平仓单不再屏蔽止盈止损 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'a', 200000);
  openPosition(db, p, { code: 'TGW', side: 'long', qty: 100, leverage: 1 });
  p.positions.TGW.tpsl = [{ id: 'ts_1', kind: 'sl', price: 96, qty: null, fired: false }];
  placeLimitOrder(db, p, { code: 'TGW', action: 'close', side: 'long', limit: 200 });
  db.stocks.TGW.price = 90;
  db.tick += 1;
  const cl = checkPositions(db);
  check('止损照常触发（修复 B7）', cl.some((x) => x.autoOrder === 'sl'), `closes=${cl.length}`);
  check('生成了止损自动单', p.orders.some((o) => o.auto === 'sl'));
}

// ---------------------------------------------------------------- 12
log('');
log('=== 12 1 股小单不再卡死别人的大单 ===');
{
  const db = newDb();
  const a = mkPlayer(db, 'a_占位', 1000000);
  const b = mkPlayer(db, 'b_大单', 1000000);
  placeLimitOrder(db, b, { code: 'TGW', action: 'open', side: 'long', qty: 1000, leverage: 1, limit: 105 });
  placeLimitOrder(db, a, { code: 'TGW', action: 'open', side: 'long', qty: 1, leverage: 1, limit: 100.5 });
  const ev = nextTickOrders(db);
  const filled = new Set(ev.filter((e) => e.type === 'fill').map((e) => e.playerId));
  check('同一轮里 1 股小单和大单都成交（修复 B2）', filled.has('a_占位') && filled.has('b_大单'), JSON.stringify([...filled]));
  check('大单一次吃满 1000 股', b.positions.TGW && b.positions.TGW.qty === 1000, `qty=${b.positions.TGW?.qty}`);
  // 后面 4 轮继续用小单去挤，大单已经成交完毕，不再被卡
  let aFills = 0;
  for (let i = 0; i < 4; i++) {
    placeLimitOrder(db, a, { code: 'TGW', action: 'open', side: 'long', qty: 1, leverage: 1, limit: 100.5 });
    const e2 = nextTickOrders(db);
    if (e2.some((e) => e.type === 'fill' && e.playerId === 'a_占位')) aFills += 1;
  }
  check('小单自己也能正常成交', aFills === 4, `a 成交 ${aFills}/4 轮`);
}

// ---------------------------------------------------------------- 13
log('');
log('=== 13 开空遇到价格上冲：按买得起的量部分成交，不整单撤销 ===');
{
  const db = newDb();
  const reserve = estimateReserve(db, db.stocks.TGW, 100, 100, 1, 'short');
  const p = mkPlayer(db, 'a', reserve);          // 全仓
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'short', qty: 100, leverage: 1, limit: 99 });
  check('空单挂单被接受', r.ok, r.error || '');
  db.stocks.TGW.price = 130;                     // 上冲 30%
  // 押金本来按 100 冻结，130 只够买 76 股
  const db2tick = nextTickOrders(db);
  const f = db2tick.find((e) => e.type === 'fill');
  check('按能承受的数量部分成交（修复 B4）', !!f && f.qty === 76, f ? `qty=${f.qty}` : JSON.stringify(db2tick.map((e) => e.type)));
  check('剩余 24 股继续排队', p.orders.length === 1 && p.orders[0].qty === 24, `rest=${p.orders[0]?.qty}`);
  // 资产守恒：只剩手续费 + 印花税
  const feePaid = 76 * 130 * 0.0005 * 2;         // 手续费 + 印花税（开空双向各一次）
  check('总资产 = 初始 - 税费', near(playerEquity(db, p), reserve - feePaid, 1e-4),
    `equity=${playerEquity(db, p).toFixed(4)} 期望 ${(reserve - feePaid).toFixed(4)}`);
}

// ---------------------------------------------------------------- 14
log('');
log('=== 14 同一玩家同一票同一方向的每轮成交额预算 ===');
{
  const db = newDb({ maxFillNotionalPerTick: 500 });
  const p = mkPlayer(db, 'a', 1000000);
  const placed = [];
  for (let i = 0; i < 5; i++) {
    placed.push(placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 10, leverage: 1, limit: 100.4 + i * 0.1 }));
  }
  check('5 张单都挂上了', placed.every((r) => r.ok), placed.filter((r) => !r.ok).map((r) => r.error).join(','));
  const ev = nextTickOrders(db);
  const total = ev.filter((e) => e.type === 'fill').reduce((s, e) => s + e.qty * e.price, 0);
  check('本轮成交额不超过上限 500', total <= 500.001, `total=${total.toFixed(2)}`);
  check('多张单可以共享预算，而不是只成交第一张', ev.filter((e) => e.type === 'fill').length <= 5, `fills=${ev.filter((e) => e.type === 'fill').length}`);
}

// ---------------------------------------------------------------- 15
log('');
log('=== 15 成交失败不会整单撤销（重试计数）===');
{
  const db = newDb();
  const p = mkPlayer(db, 'a', 100000);
  // 人为制造一个失败：挂单后把持仓方向改成反的（平仓单会撞上「方向不一致」→ 直接撤，这是预期的）
  openPosition(db, p, { code: 'TGW', side: 'long', qty: 10, leverage: 1 });
  placeLimitOrder(db, p, { code: 'TGW', action: 'close', side: 'long', limit: 90 });
  p.positions.TGW.side = 'short';            // 模拟持仓被反向
  const ev = nextTickOrders(db);
  check('方向不一致 → 撤单而不是每轮刷失败', ev.some((e) => e.type === 'cancel'), JSON.stringify(ev.map((e) => e.type)));
  check('挂单已清除', p.orders.length === 0);
}

// ---------------------------------------------------------------- 16
log('');
log('=== 16 账号等级提供额外的单笔成交上限 ===');
{
  const db = newDb({ levelFillBonus: 1000000 });
  const base = Number(db.config.maxFillNotionalPerTick);
  const bonus = Number(db.config.levelFillBonus);
  const step = Number(db.config.shopChannelStep);
  check('配置里有每级加成', bonus === 1000000, `bonus=${bonus}`);

  const a = mkPlayer(db, 'lv1', 1e7);
  a.level = 1;
  const b = mkPlayer(db, 'lv3', 1e7);
  b.level = 3;
  check('Lv.1 = 基础 + 1×100万', fillCapFor(db, a) === base + bonus, `${fillCapFor(db, a)}`);
  check('Lv.3 = 基础 + 3×100万', fillCapFor(db, b) === base + 3 * bonus, `${fillCapFor(db, b)}`);
  b.channelLevel = 2;
  check('商城通道与等级加成叠加', fillCapFor(db, b) === base + 3 * bonus + 2 * step, `${fillCapFor(db, b)}`);

  // 实际撮合：同一张 30000 股的单，等级越高一轮吃得越多
  const mk = (name, level, patch) => {
    const d = newDb(patch);
    const p = mkPlayer(d, name, 1e8);
    p.level = level;
    placeLimitOrder(d, p, { code: 'TGW', action: 'open', side: 'long', qty: 30000, leverage: 1, limit: 100 });
    nextTickOrders(d);
    return p.positions.TGW?.qty || 0;
  };
  check('关掉加成：一轮只吃 1,000,000（10000 股）', mk('no-bonus', 1, { levelFillBonus: 0 }) === 10000);
  check('Lv.1：一轮吃 2,000,000（20000 股）', mk('lv1', 1, { levelFillBonus: 1000000 }) === 20000);
  check('Lv.3：一轮吃满 4,000,000（30000 股）', mk('lv3', 3, { levelFillBonus: 1000000 }) === 30000);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
