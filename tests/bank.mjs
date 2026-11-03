// 丰川银行回归：升级费用存进银行 + 贫困时取钱救急（取款 = 存款的 1%~20%，下限 10 万）
//
//   node tests/bank.mjs
//
// 只 import src/*，不读写 data/db.json。

import { createDb } from '../src/store.js';
import { bankRules, bankStatus, levelUpPlayer, withdrawFromBank, withdrawRange } from '../src/bank.js';
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
    bankWithdrawRateMin: 0.01,
    bankWithdrawRateMax: 0.20,
    bankWithdrawFloor: 100000
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
  const poor = mkPlayer(db, 'poor', { cash: 5000000 });
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
log('=== 3 取款区间 = 存款的 1%~20%，下限 10 万 ===');
{
  const db = newDb();
  const rules = bankRules(db);
  check('默认比例 1%~20%', rules.rateMin === 0.01 && rules.rateMax === 0.2);
  check('默认下限 10 万', rules.floor === 100000);

  const big = withdrawRange(db, 22500000);
  check('2250 万 → 22.5 万 ~ 450 万',
    big.low === 225000 && big.high === 4500000, `${big.low} ~ ${big.high}`);

  const mid = withdrawRange(db, 1000000);
  check('100 万 → 10% 下限作用后 10 万 ~ 20 万',
    mid.low === 100000 && mid.high === 200000, `${mid.low} ~ ${mid.high}`);

  const small = withdrawRange(db, 30000);
  check('存款 3 万 < 下限 → 只能取 3 万', small.low === 30000 && small.high === 30000, `${small.low} ~ ${small.high}`);
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 实际取款金额确实在区间内且随机 ===');
{
  const db = newDb();
  const amounts = [];
  for (let i = 0; i < 300; i++) {
    const p = mkPlayer(db, 'r' + i, { cash: 1000, bank: 22500000 });
    const r = withdrawFromBank(db, p);
    amounts.push(r.amount);
  }
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  check('全部落在 22.5 万 ~ 450 万', min >= 225000 && max <= 4500000, `min=${min} max=${max}`);
  check('确实是随机（取值够分散）', new Set(amounts).size > 50, `distinct=${new Set(amounts).size}`);
  check('取款额不超过存款', amounts.every((a) => a <= 22500000));

  // 下限生效：存款 100 万，1% 只有 1 万
  const low = [];
  for (let i = 0; i < 100; i++) {
    const p = mkPlayer(db, 'l' + i, { cash: 1000, bank: 1000000 });
    low.push(withdrawFromBank(db, p).amount);
  }
  check('存款 100 万时每次都 ≥ 10 万（下限生效）', Math.min(...low) >= 100000, `min=${Math.min(...low)}`);
  check('... 且不超过 20%', Math.max(...low) <= 200000, `max=${Math.max(...low)}`);

  // 存款不足下限 → 取全部
  const tiny = mkPlayer(db, 'tiny', { cash: 1000, bank: 30000 });
  const r = withdrawFromBank(db, tiny);
  check('存款不足下限 → 取全部 3 万', r.ok && r.amount === 30000, `amount=${r.amount}`);
  check('取完银行清零', tiny.bank === 0);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 贫困条件 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'b', { cash: 50000, bank: 300000 });
  const st = bankStatus(db, p);
  check('总资产低于门槛 → 可取', st.poor && st.canWithdraw, `equity=${st.equity}`);
  check('状态里的可取区间 = 10 万 ~ 10 万',
    st.withdrawMin === 100000 && st.withdrawMax === 100000, `${st.withdrawMin} ~ ${st.withdrawMax}`);

  const r = withdrawFromBank(db, p);
  check('取款成功', r.ok, r.error || '');
  check('取出区间内的金额', r.amount === 100000, `amount=${r.amount}`);
  check('现金增加', near(p.cash, 150000), `cash=${p.cash}`);
  check('银行余额减少', near(p.bank, 200000), `bank=${p.bank}`);

  const r2 = withdrawFromBank(db, p);
  check('总资产超过门槛后不能再取', !r2.ok && /总资产要低于/.test(r2.error), r2.error || '');

  const rich = mkPlayer(db, 'rich', { cash: 200000, bank: 500000 });
  check('总资产 ≥ 门槛 → 不可取', !bankStatus(db, rich).canWithdraw);

  const empty = mkPlayer(db, 'empty', { cash: 1000, bank: 0 });
  const r3 = withdrawFromBank(db, empty);
  check('银行没钱 → 提示没存款', !r3.ok && /没有存款/.test(r3.error), r3.error || '');

  const exact = mkPlayer(db, 'exact', { cash: 99999, bank: 100000 });
  check('总资产 99,999 也算贫困', bankStatus(db, exact).canWithdraw);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 银行不计入总资产 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'c', { cash: 5000, bank: 999999 });
  check('总资产不含银行存款', playerEquity(db, p) === 5000, `equity=${playerEquity(db, p)}`);
}

// ---------------------------------------------------------------- 7
log('');
log('=== 7 参数可配 ===');
{
  const db = newDb();
  db.config.bankPoorThreshold = 500000;
  db.config.bankWithdrawRateMin = 0.1;
  db.config.bankWithdrawRateMax = 0.1;
  db.config.bankWithdrawFloor = 50000;
  const rules = bankRules(db);
  check('读配置', rules.poorThreshold === 500000 && rules.floor === 50000);

  const p = mkPlayer(db, 'd', { cash: 400000, bank: 1000000 });
  check('新门槛下 40 万也算贫困', bankStatus(db, p).canWithdraw);
  const r = withdrawFromBank(db, p);
  check('固定 10% → 正好取 10 万', r.ok && r.amount === 100000, `amount=${r.amount}`);

  // 比例写反自动对调
  db.config.bankWithdrawRateMin = 0.2;
  db.config.bankWithdrawRateMax = 0.05;
  const sw = bankRules(db);
  check('比例写反 → 自动对调', sw.rateMin === 0.05 && sw.rateMax === 0.2, `${sw.rateMin}~${sw.rateMax}`);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
