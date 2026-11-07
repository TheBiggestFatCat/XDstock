// 商店等级门槛：前端展示 + 后端拦截的同一套规则
//   node tests/shop-gate.mjs

import { shopNeedLevel, shopGate } from '../src/api.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

// ---------------------------------------------------------------- 1
log('=== 1 每个商品都有等级要求，默认 1 级 ===');
{
  const keys = ['fakeNews', 'bodyguard', 'channel', 'freeFee', 'bg', 'rename', 'autoDca', 'hotTip', 'levelUp', 'comingSoon'];
  for (const k of keys) {
    const n = shopNeedLevel(k);
    check(`${k} 有等级要求`, Number.isFinite(n) && n >= 1, 'Lv.' + n);
  }
  check('咸鱼代下单是 Lv.1 商品', shopNeedLevel('freeFee') === 1, 'Lv.' + shopNeedLevel('freeFee'));
  check('游资情报是 Lv.3 商品', shopNeedLevel('hotTip') === 3, 'Lv.' + shopNeedLevel('hotTip'));
  check('未知 key 兜底 Lv.1', shopNeedLevel('某个不存在的商品') === 1);
  check('null / undefined 也不炸', shopNeedLevel(null) === 1 && shopNeedLevel(undefined) === 1);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 等级够就放行，不够就拦 ===');
{
  // 道具：Lv.1 的商品 Lv.1 就能买，Lv.2 的要 Lv.2
  check('Lv.1 买假新闻 → 放行', shopGate({ level: 1 }, 'fakeNews') === null);
  check('Lv.1 买保镖 → 放行', shopGate({ level: 1 }, 'bodyguard') === null);
  check('Lv.1 买通道 → 放行', shopGate({ level: 1 }, 'channel') === null);
  check('Lv.1 买咸鱼代下单 → 放行', shopGate({ level: 1 }, 'freeFee') === null);
  check('Lv.2 买游资情报 → 拦下（Lv.3）', shopGate({ level: 2 }, 'hotTip')?.needLevel === 3);
  check('Lv.3 买游资情报 → 放行', shopGate({ level: 3 }, 'hotTip') === null);
  check('Lv.1 买改名卡 → 拦下', shopGate({ level: 1 }, 'rename')?.needLevel === 2);
  check('Lv.1 买自定义背景 → 拦下', shopGate({ level: 1 }, 'bg')?.needLevel === 2);
  check('Lv.1 买自动定投 → 拦下', shopGate({ level: 1 }, 'autoDca')?.needLevel === 2);
  check('Lv.2 买改名卡 → 放行', shopGate({ level: 2 }, 'rename') === null);
  check('Lv.2 买自动定投 → 放行', shopGate({ level: 2 }, 'autoDca') === null);
  check('Lv.2 买 Lv.3 商品 → 拦下', shopGate({ level: 2 }, 'comingSoon')?.needLevel === 3);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 拦截时带的是能直接给前端显示的信息 ===');
{
  const r = shopGate({ level: 1 }, 'rename');
  check('有 error 文案', typeof r.error === 'string' && r.error.length > 0, r.error);
  check('文案里写了需要几级', r.error.includes('Lv.2'), r.error);
  check('文案里写了当前几级', r.error.includes('Lv.1'), r.error);
  check('带 needLevel 字段', r.needLevel === 2);
  check('带 level 字段', r.level === 1);
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 脏数据不会把门槛弄失效 ===');
{
  check('level 是字符串也能判断', shopGate({ level: '2' }, 'rename') === null);
  check('level 缺省按 1 级算', shopGate({}, 'rename')?.needLevel === 2);
  check('level 是 NaN 按 1 级算', shopGate({ level: NaN }, 'rename')?.needLevel === 2);
  check('level 是负数按 1 级算', shopGate({ level: -5 }, 'rename')?.needLevel === 2);
  check('me 是 null 也不炸', shopGate(null, 'rename')?.needLevel === 2);
  check('level 是小数向下取整（1.9 算 1 级）', shopGate({ level: 1.9 }, 'rename')?.needLevel === 2);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
