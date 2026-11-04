// 保镖「一次买十份」：总价 / 总时长 / 份数夹取的纯函数
//   node tests/bodyguard-bulk.mjs

import { bodyguardOrder } from '../src/api.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

const CFG = { shopBodyguardPrice: 50000, shopBodyguardTicks: 720 };

// ---------------------------------------------------------------- 1
log('=== 1 一份 ===');
{
  const o = bodyguardOrder(CFG, 1);
  check('qty = 1', o.qty === 1);
  check('总价 = 单价', o.total === 50000, String(o.total));
  check('时长 = 基础时长', o.addTicks === 720, String(o.addTicks));
  check('单价单独带回来', o.unitPrice === 50000);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 十份 ===');
{
  const o = bodyguardOrder(CFG, 10);
  check('qty = 10', o.qty === 10);
  check('总价 = 单价 × 10', o.total === 500000, String(o.total));
  check('时长 = 基础 × 10（10 小时）', o.addTicks === 7200, String(o.addTicks));
  check('没有打折', o.total === o.unitPrice * 10);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 份数夹取（前端乱传也不会出事）===');
{
  check('0 份当 1 份', bodyguardOrder(CFG, 0).qty === 1);
  check('负数当 1 份', bodyguardOrder(CFG, -7).qty === 1);
  check('缺省当 1 份', bodyguardOrder(CFG, undefined).qty === 1);
  check('null 当 1 份', bodyguardOrder(CFG, null).qty === 1);
  check('字符串数字能用', bodyguardOrder(CFG, '10').qty === 10);
  check('11 份被夹到 10', bodyguardOrder(CFG, 11).qty === 10);
  check('999 份被夹到 10', bodyguardOrder(CFG, 999).qty === 10);
  check('小数四舍五入（2.6 → 3）', bodyguardOrder(CFG, 2.6).qty === 3);
  check('NaN 当 1 份', bodyguardOrder(CFG, NaN).qty === 1);
  check('"abc" 当 1 份', bodyguardOrder(CFG, 'abc').qty === 1);
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 配置改了要跟着变（价格/时长都不是写死的）===');
{
  const o = bodyguardOrder({ shopBodyguardPrice: 80000, shopBodyguardTicks: 360 }, 10);
  check('总价跟配置走', o.total === 800000, String(o.total));
  check('时长跟配置走', o.addTicks === 3600, String(o.addTicks));
  const bad = bodyguardOrder({ shopBodyguardPrice: -5, shopBodyguardTicks: 0 }, 1);
  check('价格兜底 1', bad.unitPrice === 1, String(bad.unitPrice));
  check('时长兜底 1', bad.addTicks === 1, String(bad.addTicks));
  const empty = bodyguardOrder({}, 1);
  check('配置为空用默认 50000 / 720', empty.total === 50000 && empty.addTicks === 720);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
