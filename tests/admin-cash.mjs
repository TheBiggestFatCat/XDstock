// 管理端「打钱」回归：打到现金（不是银行）
//
//   node tests/admin-cash.mjs
//
// 2026-11 改：管理面板的「打钱」从改 `player.bank` 改成改 `player.cash`，
// 因为银行的钱要等「取钱救急」才拿得出来，发补偿/活动奖励不方便。

import { grantCash } from '../src/api.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const mk = (patch = {}) => ({ id: 'p1', nickname: '甲', cash: 1000, bank: 5000, bankDeposited: 4000, ...patch });

// ---------------------------------------------------------------- 1
log('=== 1 加现金：钱进 cash，不进 bank ===');
{
  const p = mk();
  const r = grantCash(p, 500);
  check('返回成功', r.ok === true, r.error || '');
  check('cash 1000 → 1500', near(p.cash, 1500), String(p.cash));
  check('实际变动额 = 500', near(r.amount, 500), String(r.amount));
  check('返回值带变动前余额', near(r.before, 1000), String(r.before));
  check('银行完全没动', near(p.bank, 5000), String(p.bank));
  check('累计存入没被污染', near(p.bankDeposited, 4000), String(p.bankDeposited));
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 扣现金：负数扣钱 ===');
{
  const p = mk();
  const r = grantCash(p, -200);
  check('cash 1000 扣 200 → 800', near(p.cash, 800), String(p.cash));
  check('实际变动额 = -200', near(r.amount, -200), String(r.amount));
  check('银行不受影响', near(p.bank, 5000), String(p.bank));
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 扣到 0 为止，不出现负现金 ===');
{
  const p = mk({ cash: 300 });
  const r = grantCash(p, -1000);
  check('cash 300 扣 1000 → 0', near(p.cash, 0), String(p.cash));
  check('实际变动额 = -300（不是 -1000）', near(r.amount, -300), String(r.amount));
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 现金已经是 0 还要扣：变动 0，前端据此提示「扣不动」 ===');
{
  const p = mk({ cash: 0 });
  const r = grantCash(p, -500);
  check('仍然返回成功', r.ok === true, r.error || '');
  check('cash 保持 0', near(p.cash, 0), String(p.cash));
  check('实际变动额 = 0', near(r.amount, 0), String(r.amount));
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 脏数据：现金为 undefined / 字符串 ===');
{
  const a = mk({ cash: undefined });
  grantCash(a, 100);
  check('undefined 当 0 处理', near(a.cash, 100), String(a.cash));
  const b = mk({ cash: '250.5' });
  grantCash(b, 100);
  check('字符串余额能加', near(b.cash, 350.5), String(b.cash));
  const c = mk({ cash: -50 });
  grantCash(c, 100);
  check('负余额先归零再加 → 100', near(c.cash, 100), String(c.cash));
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 金额校验 ===');
{
  const p = mk();
  check('0 被拒', grantCash(p, 0).ok === false);
  check('空串被拒', grantCash(p, '').ok === false);
  check('NaN 被拒', grantCash(p, NaN).ok === false);
  check('非数字被拒', grantCash(p, 'abc').ok === false);
  check('超过 1e12 被拒', grantCash(p, 2e12).ok === false);
  check('被拒时余额不动', near(p.cash, 1000), String(p.cash));
}

// ---------------------------------------------------------------- 7
log('');
log('=== 7 小数金额向下取整（不做四舍五入，避免多打钱） ===');
{
  const p = mk({ cash: 0 });
  grantCash(p, 99.9);
  check('99.9 → 99', near(p.cash, 99), String(p.cash));
  const q = mk({ cash: 0 });
  grantCash(q, -99.9);
  check('负数 99.9 → -99（余额 0 截断）', near(q.cash, 0), String(q.cash));
}

// ---------------------------------------------------------------- 8
log('');
log('=== 8 大额：1B 能正常加，且不超过精度 ===');
{
  const p = mk({ cash: 0 });
  const r = grantCash(p, 1e9);
  check('cash = 1e9', near(p.cash, 1e9, 1e-3), String(p.cash));
  check('变动额 1e9', near(r.amount, 1e9, 1e-3), String(r.amount));
  check('银行没动', near(p.bank, 5000), String(p.bank));
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
