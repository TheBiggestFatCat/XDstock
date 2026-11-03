// 丰川银行回归：升级费用存进银行 + 贫困时取钱救急
//
//   node tests/bank.mjs
//
// 只 import src/*，不读写 data/db.json。

import { createDb } from '../src/store.js';
import { bankRules, bankStatus, levelUpPlayer, withdrawFromBank } from '../src/bank.js';
import { playerEquity } from '../src/trading.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

function newDb() {
  const db = createDb();
  db.tick = 100;
  Object.assign(db.config, {
    levelBaseAsset: 10000000,
    levelGrowth: 2,
    levelUpRatio: 0.6,
    bankPoorThreshold: 100000,
    bankWithdrawAmount: 100000
  });
  return db;
}
function mkPlayer(db, id, extra = {}) {
  db.players[id] = { id, nickname: id, level: 1, cash: 0, bank: 0, positions: {}, orders: [], ...extra };
  return db.players[id];
}

// ---------------------------------------------------------------- 1
log('=== 1 升级费用存进银行 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'a', { cash: 20000001, level: 1 });
  const equityBefore = playerEquity(db, p);
  const r = levelUpPlayer(db, p);
  check('升级成功', r.ok, r.error || '');
  check('Lv.1 → Lv.2', p.level === 2 && r.level === 2);
  check('费用 = 总资产 × 60%', r.cost === Math.floor(equityBefore * 0.6), `cost=${r.cost}`);
  check('现金被扣', near(p.cash, 20000001 - r.cost), `cash=${p.cash}`);
  check('钱进了银行（不是凭空消失）', p.bank === r.cost, `bank=${p.bank}`);
  check('累计存入同步', p.bankDeposited === r.cost);
  check('总资产只减了费用（银行不算资产）', near(playerEquity(db, p), equityBefore - r.cost),
    `equity=${playerEquity(db, p).toFixed(2)}`);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 升级前置条件不变 ===');
{
  const db = newDb();
  const poor = mkPlayer(db, 'poor', { cash: 5000000 });   // 总资产 500 万 < 1000 万门槛
  const r1 = levelUpPlayer(db, poor);
  check('总资产不够不能升', !r1.ok && /升级需要总资产/.test(r1.error), r1.error || '');
  check('失败时不改动银行', !poor.bank && poor.level === 1);

  const noCash = mkPlayer(db, 'nocash', { cash: 1000 });
  noCash.positions = { TGW: { code: 'TGW', side: 'long', qty: 100000, entry: 100, margin: 1e7, leverage: 1, openedTick: 1 } };
  const equity2 = playerEquity(db, noCash);
  check('（构造）总资产够但现金不够', equity2 >= 10000000 && noCash.cash < equity2 * 0.6);
  const r2 = levelUpPlayer(db, noCash);
  check('现金不足不能升', !r2.ok && /升级要付/.test(r2.error), r2.error || '');
  check('失败时银行仍为 0', !noCash.bank);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 贫困时取钱救急 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'b', { cash: 50000, bank: 300000 });
  const st = bankStatus(db, p);
  check('总资产低于门槛 → 可取', st.poor && st.canWithdraw, `equity=${st.equity}`);
  check('可取金额 = 配置的 10 万', st.withdrawable === 100000, `withdrawable=${st.withdrawable}`);

  const r = withdrawFromBank(db, p);
  check('取款成功', r.ok, r.error || '');
  check('取出 100,000', r.amount === 100000, `amount=${r.amount}`);
  check('现金 +10 万', near(p.cash, 150000), `cash=${p.cash}`);
  check('银行余额 -10 万', near(p.bank, 200000), `bank=${p.bank}`);

  // 取完总资产 = 15 万 > 门槛 → 不能再取
  const r2 = withdrawFromBank(db, p);
  check('总资产超过门槛后不能再取', !r2.ok && /总资产要低于/.test(r2.error), r2.error || '');
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 取款边界 ===');
{
  const db = newDb();
  const rich = mkPlayer(db, 'rich', { cash: 200000, bank: 500000 });
  check('总资产 ≥ 门槛 → 不可取', !bankStatus(db, rich).canWithdraw);
  const r = withdrawFromBank(db, rich);
  check('富的时候取不了', !r.ok, r.error || '');

  const empty = mkPlayer(db, 'empty', { cash: 1000, bank: 0 });
  check('银行没钱 → 不可取', !bankStatus(db, empty).canWithdraw);
  const r2 = withdrawFromBank(db, empty);
  check('取不了并提示没存款', !r2.ok && /没有存款/.test(r2.error), r2.error || '');

  const small = mkPlayer(db, 'small', { cash: 1000, bank: 30000 });
  const r3 = withdrawFromBank(db, small);
  check('余额不足 10 万 → 取全部 3 万', r3.ok && r3.amount === 30000, `amount=${r3.amount}`);
  check('取完银行清零', small.bank === 0);

  const exact = mkPlayer(db, 'exact', { cash: 99999, bank: 100000 });
  check('总资产 99,999 = 差 1 块也算贫困', bankStatus(db, exact).canWithdraw);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 银行不计入总资产，不影响排行榜口径 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'c', { cash: 5000, bank: 999999 });
  check('总资产不含银行存款', playerEquity(db, p) === 5000, `equity=${playerEquity(db, p)}`);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 参数可配 ===');
{
  const db = newDb();
  db.config.bankPoorThreshold = 500000;
  db.config.bankWithdrawAmount = 200000;
  const rules = bankRules(db);
  check('读配置', rules.poorThreshold === 500000 && rules.withdrawAmount === 200000);

  const p = mkPlayer(db, 'd', { cash: 400000, bank: 1000000 });
  check('新门槛下 40 万也算贫困', bankStatus(db, p).canWithdraw);
  const r = withdrawFromBank(db, p);
  check('按新金额取 20 万', r.ok && r.amount === 200000, `amount=${r.amount}`);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
