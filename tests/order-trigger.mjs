// 挂单触发方式：远价买单不能立刻成交
//   node tests/order-trigger.mjs

import { createDb } from '../src/store.js';
import { placeLimitOrder, processOrders } from '../src/orders.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

function newDb(patch = {}) {
  const db = createDb();
  Object.assign(db.config, {
    feeRate: 0, stampDuty: 0, playerImpactEnabled: 0, impactCostCoef: 0,
    maxFillNotionalPerTick: 1e9, orderTtlTicks: 2000, maxPendingOrders: 5,
    maxOrdersPerTick: 9, liquidationBuffer: 0, limitOrderEnabled: 1,
    levelFillBonus: 0, marketOpen: true, minLeverage: 1, maxLeverage: 10,
    orderMarketableBand: 0.1
  }, patch);
  for (const st of Object.values(db.stocks)) { st.price = 100; st.fair = 100; }
  db.players.p = {
    id: 'p', nickname: 'p', cash: 10000000, positions: {}, orders: [],
    theme: 'default', level: 1, orderCount: 0, orderTick: -1
  };
  return db;
}
const nextTick = (db) => { db.tick += 1; return processOrders(db); };

// ---------------------------------------------------------------- 1
log('=== 1 现价 100 挂 300 买入：不能立刻成交 ===');
{
  const db = newDb();
  const p = db.players.p;
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 100, limit: 300 });
  check('挂单被接受', r.ok, r.error || '');
  check('标记成到价单', r.order.trigger === 'stop', r.order.trigger);

  const ev1 = nextTick(db);
  check('下一轮不成交（价格 100 还没到 300）', !ev1.some((e) => e.type === 'fill'),
    JSON.stringify(ev1.map((e) => e.type)));
  check('单子还挂着', p.orders.length === 1 && p.orders[0].qty === 100, String(p.orders.length));

  // 价格慢慢涨到 299 还是不成交
  db.stocks.TGW.price = 299;
  const ev2 = nextTick(db);
  check('涨到 299 仍不成交', !ev2.some((e) => e.type === 'fill'));

  // 到 300 才成交，而且成交价是市价
  db.stocks.TGW.price = 300;
  const ev3 = nextTick(db);
  const fill = ev3.find((e) => e.type === 'fill');
  check('涨到 300 成交', !!fill, JSON.stringify(ev3.map((e) => e.type)));
  check('成交价 = 市价 300', fill && Math.abs(fill.price - 300) < 1e-6, fill ? String(fill.price) : '');
  check('持仓建立', !!p.positions.TGW, JSON.stringify(Object.keys(p.positions)));
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 让利那套（挂价略高于市价）还是要立刻成交 ===');
{
  const db = newDb();
  const p = db.players.p;
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 100, limit: 100.5 });
  check('100.5 算普通限价单', r.ok && r.order.trigger === 'limit', r.order.trigger);
  const ev = nextTick(db);
  check('下一轮就成交', ev.some((e) => e.type === 'fill'), JSON.stringify(ev.map((e) => e.type)));

  const db2 = newDb();
  const p2 = db2.players.p;
  const r2 = placeLimitOrder(db2, p2, { code: 'TGW', action: 'open', side: 'long', qty: 100, limit: 109 });
  check('+9% 仍在带宽内（算市价单）', r2.order.trigger === 'limit', r2.order.trigger);
  const r3 = placeLimitOrder(db2, p2, { code: 'MCD', action: 'open', side: 'long', qty: 10, limit: 111.5 });
  check('+11.5% 超出带宽（算到价单）', r3.order.trigger === 'stop', r3.order.trigger);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 低挂买单（等回调）还是等到价才成交 ===');
{
  const db = newDb();
  const p = db.players.p;
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 100, limit: 90 });
  check('挂 90 是普通限价单', r.ok && r.order.trigger === 'limit', r.order.trigger);
  check('价格 100 时不成交', !nextTick(db).some((e) => e.type === 'fill'));
  db.stocks.TGW.price = 89;
  check('跌到 89 才成交', nextTick(db).some((e) => e.type === 'fill'));
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 卖单行为不变 ===');
{
  const db = newDb();
  const p = db.players.p;
  p.positions.TGW = { code: 'TGW', side: 'long', qty: 100, entry: 100, margin: 10000, leverage: 1, openedTick: 0 };

  const high = placeLimitOrder(db, p, { code: 'TGW', action: 'close', side: 'long', qty: 100, limit: 300 });
  check('高挂卖单是 limit', high.ok && high.order.trigger === 'limit', high.order.trigger);
  check('价格 100 不成交', !nextTick(db).some((e) => e.type === 'fill'));
  db.stocks.TGW.price = 300;
  check('涨到 300 才成交', nextTick(db).some((e) => e.type === 'fill'));
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 平空（买回）同样受带宽保护 ===');
{
  const db = newDb();
  const p = db.players.p;
  p.positions.TGW = { code: 'TGW', side: 'short', qty: 100, entry: 100, margin: 10000, leverage: 1, openedTick: 0 };
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'close', side: 'short', qty: 100, limit: 300 });
  check('平空挂 300 也是到价单', r.ok && r.order.trigger === 'stop', r.order.trigger || r.error);
  check('价格 100 不成交', !nextTick(db).some((e) => e.type === 'fill'));
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 到价单也有超时撤单 ===');
{
  const db = newDb({ orderTtlTicks: 3 });
  const p = db.players.p;
  placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 100, limit: 300 });
  for (let i = 0; i < 5; i++) nextTick(db);
  check('到价单超时被撤', p.orders.length === 0, String(p.orders.length));
  check('押金退了', p.cash > 9900000, p.cash.toFixed(0));
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
