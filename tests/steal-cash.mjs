// 偷钱金额：百分比按「对方现金」算（不是总资产）
//   node tests/steal-cash.mjs

import { stealAmount } from '../src/steal.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

const CFG = { capRatio: 0.001, stealMin: 100, stealMax: 10000 };
const fixed = (v) => () => v;      // 固定随机数

// ---------------------------------------------------------------- 1
log('=== 1 上限挂在「现金」上 ===');
{
  // 现金 1,000,000 → 上限 1,000（0.1%）
  const a = stealAmount({ victimCash: 1000000, ...CFG, roll: fixed(1) });
  check('现金 100 万最多偷 1000', a === 1000, String(a));
  // 现金 10,000 → 上限 10
  const b = stealAmount({ victimCash: 10000, ...CFG, roll: fixed(1) });
  check('现金 1 万最多偷 10', b === 10, String(b));
  // 现金 100 → 上限 0.1 → 取整 0
  const c = stealAmount({ victimCash: 100, ...CFG, roll: fixed(1) });
  check('现金 100 偷不到（<1 块）', c === 0, String(c));
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 只看现金，跟持仓无关 ===');
{
  // 同样是「现金 10 万」，一个有 100 万持仓、一个没有，结果必须一样
  const withPos = stealAmount({ victimCash: 100000, equity: 1100000, ...CFG, roll: fixed(0.5) });
  const cashOnly = stealAmount({ victimCash: 100000, equity: 100000, ...CFG, roll: fixed(0.5) });
  check('持仓多少不影响结果', withPos === cashOnly, `${withPos} vs ${cashOnly}`);
  check('现金 10 万最多 100', withPos <= 100, String(withPos));
  // 旧算法（按总资产 110 万）会算出 1100，现在不会超过 100
  check('不会按总资产算成 1100', withPos !== 1100, String(withPos));
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 随机区间与最小/最大 ===');
{
  const tiny = stealAmount({ victimCash: 100000000, ...CFG, roll: fixed(0) });
  check('roll=0 取最小（但受上限夹）', tiny === Math.min(100, Math.floor(100000000 * 0.001)), String(tiny));
  const big = stealAmount({ victimCash: 100000000, ...CFG, roll: fixed(1) });
  check('roll=1 取最大 stealMax=10000', big === 10000, String(big));
  const mid = stealAmount({ victimCash: 100000000, ...CFG, roll: fixed(0.5) });
  check('roll=0.5 落在区间中', mid > 0 && mid <= 10000, String(mid));
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 永远偷不出超过对方现金的钱 ===');
{
  for (const cash of [1, 2, 50, 150, 1500, 9999]) {
    const a = stealAmount({ victimCash: cash, ...CFG, roll: fixed(0.99) });
    check(`现金 ${cash} → 不多偷`, a <= cash, String(a));
  }
  const zero = stealAmount({ victimCash: 0, ...CFG, roll: fixed(1) });
  check('现金 0 → 空手', zero === 0);
  const neg = stealAmount({ victimCash: -500, ...CFG, roll: fixed(1) });
  check('负现金 → 空手', neg === 0);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 参数脏了也不会算出负数 / 离谱值 ===');
{
  const noRatio = stealAmount({ victimCash: 1000000, capRatio: 0, stealMin: 100, stealMax: 10000, roll: fixed(1) });
  check('capRatio=0 → 空手', noRatio === 0);
  const swap = stealAmount({ victimCash: 100000000, capRatio: 1, stealMin: 10000, stealMax: 100, roll: fixed(0.5) });
  check('min/max 写反也能兜住', swap >= 100 && swap <= 10000, String(swap));
  const nan = stealAmount({ victimCash: NaN, ...CFG, roll: fixed(0.5) });
  check('NaN 现金 → 空手', nan === 0);
  const noArgs = stealAmount();
  check('不传参 → 空手不炸', noArgs === 0);
  const badRatio = stealAmount({ victimCash: 1000000, capRatio: -1, stealMin: 0, stealMax: 0, roll: fixed(0.5) });
  check('负比例 → 空手', badRatio === 0);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
