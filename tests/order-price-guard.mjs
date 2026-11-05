// 挂价上限：离谱的买单挂价直接拒绝（不影响正常让利开仓）
//   node tests/order-price-guard.mjs

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

function newDb() {
  const db = createDb();
  Object.assign(db.config, {
    feeRate: 0, stampDuty: 0, playerImpactEnabled: 0, impactCostCoef: 0,
    maxFillNotionalPerTick: 1e9, orderTtlTicks: 2000, maxPendingOrders: 5,
    maxOrdersPerTick: 9, liquidationBuffer: 0, limitOrderEnabled: 1,
    levelFillBonus: 0, marketOpen: true, minLeverage: 1, maxLeverage: 10
  });
  for (const st of Object.values(db.stocks)) { st.price = 100; st.fair = 100; }
  db.players.p = {
    id: 'p', nickname: 'p', cash: 100000000, positions: {}, orders: [],
    theme: 'default', level: 1, orderCount: 0, orderTick: -1
  };
  return db;
}
const tick = (db) => { db.tick += 1; return processOrders(db); };

/** 挂一笔单，跑一轮，返回 { placed, filled } */
function tryOrder(opts) {
  const db = newDb();
  const p = db.players.p;
  if (opts.pos) {
    p.positions.TGW = {
      code: 'TGW', side: opts.pos.side, qty: opts.pos.qty, entry: 100,
      margin: opts.pos.qty * 100, leverage: 1, openedTick: 0
    };
  }
  const r = placeLimitOrder(db, p, opts.body);
  const ev = r.ok ? tick(db) : [];
  const fill = ev.find((e) => e.type === 'fill');
  return { placed: r.ok, error: r.error || '', filled: !!fill, fillPrice: fill ? fill.price : null, qty: fill ? fill.qty : 0 };
}

// ---------------------------------------------------------------- 1
log('=== 1 现价 100 挂 300 买入：拒绝，不再「秒成交」===');
{
  const r = tryOrder({ body: { code: 'TGW', action: 'open', side: 'long', qty: 100, limit: 300 } });
  check('挂单被拒绝', !r.placed, '竟然挂上了');
  check('没有成交', !r.filled);
  check('提示写明上限', /最高 200\.00/.test(r.error), r.error);
  check('提示写明现价', /现价 100\.00/.test(r.error), r.error);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 边界：最高 2 倍价，正好 200 可以 ===');
{
  const over = tryOrder({ body: { code: 'TGW', action: 'open', side: 'long', qty: 10, limit: 201 } });
  check('201 被拒', !over.placed, over.error);
  const edge = tryOrder({ body: { code: 'TGW', action: 'open', side: 'long', qty: 10, limit: 200 } });
  check('200 允许', edge.placed, edge.error);
  check('200 按市价 100 成交（不是按 200）', edge.filled && Math.abs(edge.fillPrice - 100) < 1e-6,
    String(edge.fillPrice));
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 回归：各种让利都还能正常开仓成交 ===');
{
  for (const pct of [0.5, 1, 5, 10, 20, 50, 99]) {
    const limit = Math.round(100 * (1 + pct / 100) * 100) / 100;
    const r = tryOrder({ body: { code: 'TGW', action: 'open', side: 'long', qty: 10, limit } });
    check(`让利 ${pct}% → 挂上并下一轮成交`, r.placed && r.filled,
      r.placed ? (r.filled ? '' : '没成交') : r.error);
  }
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 低价股 0.01 一跳也不能误伤 ===');
{
  const db = newDb();
  for (const st of Object.values(db.stocks)) st.price = 0.85;
  const p = db.players.p;
  const r = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 100, limit: 0.86 });
  check('0.85 现价挂 0.86 允许', r.ok, r.error || '');
  const ev = tick(db);
  check('下一轮成交', ev.some((e) => e.type === 'fill'));
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 卖单 / 平仓一律不拦 ===');
{
  const sellHigh = tryOrder({
    pos: { side: 'long', qty: 100 },
    body: { code: 'TGW', action: 'close', side: 'long', qty: 100, limit: 300 }
  });
  check('平多挂 300 允许（等到价）', sellHigh.placed, sellHigh.error);
  check('现价 100 不成交', !sellHigh.filled);

  const sellLow = tryOrder({
    pos: { side: 'long', qty: 100 },
    body: { code: 'TGW', action: 'close', side: 'long', qty: 100, limit: 10 }
  });
  check('平多挂 10 允许（按市价成交）', sellLow.placed, sellLow.error);
  check('下一轮成交', sellLow.filled);

  const openShortHigh = tryOrder({ body: { code: 'TGW', action: 'open', side: 'short', qty: 10, limit: 300 } });
  check('开空挂 300 允许（卖单不拦）', openShortHigh.placed, openShortHigh.error);

  const closeShortHigh = tryOrder({
    pos: { side: 'short', qty: 100 },
    body: { code: 'TGW', action: 'close', side: 'short', qty: 100, limit: 300 }
  });
  check('平空挂 300 允许（不做上限检查）', closeShortHigh.placed, closeShortHigh.error);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 低挂买单（等回调）行为不变 ===');
{
  const r = tryOrder({ body: { code: 'TGW', action: 'open', side: 'long', qty: 10, limit: 90 } });
  check('挂 90 允许', r.placed, r.error);
  check('现价 100 不成交', !r.filled);

  const db = newDb();
  const p = db.players.p;
  placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 10, limit: 90 });
  db.stocks.TGW.price = 89;
  tick(db);
  check('跌到 89 才成交', !!p.positions.TGW);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
