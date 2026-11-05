// 同一只票的挂单冲突：不能一边开仓一边平仓
//   node tests/order-conflict.mjs

import { createDb } from '../src/store.js';
import { placeLimitOrder, pendingConflict } from '../src/orders.js';

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
    id: 'p', nickname: 'p', cash: 1000000, positions: {}, orders: [],
    theme: 'default', level: 1, orderCount: 0, orderTick: -1
  };
  return db;
}

const mkPos = (p, qty = 100) => {
  p.positions.TGW = {
    code: 'TGW', side: 'long', qty, entry: 100, margin: 10000, leverage: 1, openedTick: 0
  };
};

// ---------------------------------------------------------------- 1
log('=== 1 纯函数 pendingConflict ===');
{
  const p = { orders: [] };
  check('没挂单 → 不冲突', pendingConflict(p, 'TGW', 'open') === null && pendingConflict(p, 'TGW', 'close') === null);

  p.orders = [{ code: 'TGW', action: 'close' }];
  check('有平仓单时不能再开仓', !!pendingConflict(p, 'TGW', 'open'));
  check('有平仓单时不能再平仓', !!pendingConflict(p, 'TGW', 'close'));

  p.orders = [{ code: 'TGW', action: 'open' }];
  check('有开仓单时能开仓（同向可叠加）', pendingConflict(p, 'TGW', 'open') === null);
  check('有开仓单时不能平仓', !!pendingConflict(p, 'TGW', 'close'));

  p.orders = [{ code: 'MCD', action: 'close' }];
  check('别的票不影响', pendingConflict(p, 'TGW', 'open') === null);

  p.orders = [{ code: 'TGW', action: 'close', auto: 'tp' }];
  check('止盈止损单不挡开仓（加仓不该被自己的风控单拦住）', pendingConflict(p, 'TGW', 'open') === null);
  check('但止盈止损单算出「已有平仓单」，手动不能重复平', !!pendingConflict(p, 'TGW', 'close'));

  p.orders = [{ code: 'TGW', action: 'close', autoDca: true }];
  check('自动定投的平仓单不算数', pendingConflict(p, 'TGW', 'close') === null);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 真下单：持多 → 挂平仓 → 再挂开仓被拦 ===');
{
  const db = newDb();
  const p = db.players.p;
  mkPos(p);

  const close = placeLimitOrder(db, p, { code: 'TGW', action: 'close', side: 'long', qty: 100, limit: 101 });
  check('平仓单挂上了', close.ok, close.error || '');

  const open = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 50, limit: 99 });
  check('再挂开仓被拦住', !open.ok, open.error || '竟然挂上了');
  check('提示写清楚原因', /平仓单/.test(open.error || ''), open.error || '');

  const second = placeLimitOrder(db, p, { code: 'TGW', action: 'close', side: 'long', qty: 50, limit: 101 });
  check('重复挂平仓也被拦住', !second.ok, second.error || '');
  check('只有一笔单在挂', p.orders.length === 1, String(p.orders.length));
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 先挂开仓 → 再挂平仓被拦 ===');
{
  const db = newDb();
  const p = db.players.p;
  mkPos(p, 100);

  const open = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 50, limit: 99 });
  check('开仓单挂上了', open.ok, open.error || '');

  const close = placeLimitOrder(db, p, { code: 'TGW', action: 'close', side: 'long', qty: 100, limit: 101 });
  check('再挂平仓被拦住', !close.ok, close.error || '竟然挂上了');
  check('提示写清楚原因', /开仓单/.test(close.error || ''), close.error || '');
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 系统单不受限（定投 / 止盈止损）===');
{
  const db = newDb();
  const p = db.players.p;
  mkPos(p, 100);

  const sys = placeLimitOrder(db, p, {
    code: 'TGW', action: 'close', side: 'long', qty: 100, limit: 101, system: true
  });
  check('system 单可以绕过冲突检查', sys.ok, sys.error || '');

  const openWhenSysClose = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 10, limit: 99 });
  check('玩家自己再开仓仍被拦', !openWhenSysClose.ok, openWhenSysClose.error || '');
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 同向开仓可以叠加（不误伤）===');
{
  const db = newDb();
  const p = db.players.p;
  const a = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 10, limit: 99 });
  const b = placeLimitOrder(db, p, { code: 'TGW', action: 'open', side: 'long', qty: 20, limit: 98 });
  check('两笔开仓都挂上了', a.ok && b.ok, (a.error || '') + (b.error || ''));
  check('共两笔挂单', p.orders.length === 2, String(p.orders.length));
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
