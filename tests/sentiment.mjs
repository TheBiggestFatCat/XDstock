// 散户情绪「重掷周期」改成随机范围 —— 回归测试
//
//   node tests/sentiment.mjs
//
// 只 import src/*，不读写 data/db.json。

import { createDb } from '../src/store.js';
import { sentimentRollInterval } from '../src/engine.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

const db = createDb();
const draw = (st, n = 3000) => Array.from({ length: n }, () => sentimentRollInterval(db, st));
const stat = (arr) => {
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return { min, max, mean, distinct: new Set(arr).size };
};

// ---------------------------------------------------------------- 1
log('=== 1 默认配置：480~960 的随机区间 ===');
{
  const st = { trait: {} };
  const s = stat(draw(st));
  check('全部落在 [480, 960]', s.min >= 480 && s.max <= 960, `min=${s.min} max=${s.max}`);
  check('确实是随机（不同值足够多）', s.distinct > 50, `distinct=${s.distinct}`);
  check('均值仍在 720 附近（和旧的固定 1 小时一致）', Math.abs(s.mean - 720) < 25, `mean=${s.mean.toFixed(1)}`);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 个股面板参数优先于全局 ===');
{
  const st = { trait: { sentRollMin: 10, sentRollMax: 20 } };
  const s = stat(draw(st));
  check('个股区间 10~20 生效', s.min >= 10 && s.max <= 20 && s.distinct > 3, `min=${s.min} max=${s.max}`);
  check('不被全局 480/960 盖掉', s.max <= 20);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 个股只配了一头也能用 ===');
{
  const st = { trait: { sentRollMin: 50 } };
  const s = stat(draw(st, 500));
  check('只配下限 → 上下限都按 50', s.min === 50 && s.max === 50, `min=${s.min} max=${s.max}`);
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 老字段 sentRollTicks 按 ±1/3 现推区间 ===');
{
  const st = { trait: { sentRollTicks: 300 } };
  const s = stat(draw(st));
  check('300 → 200~400', s.min >= 200 && s.max <= 400, `min=${s.min} max=${s.max}`);
  check('不再是固定值', s.distinct > 20, `distinct=${s.distinct}`);
  check('均值约等于原来的 300', Math.abs(s.mean - 300) < 12, `mean=${s.mean.toFixed(1)}`);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 全局配置改范围，个股没配时生效 ===');
{
  const d2 = createDb();
  d2.config.sentimentRollMin = 100;
  d2.config.sentimentRollMax = 120;
  const arr = Array.from({ length: 500 }, () => sentimentRollInterval(d2, { trait: {} }));
  const s = stat(arr);
  check('跟着全局配置走（100~120）', s.min >= 100 && s.max <= 120, `min=${s.min} max=${s.max}`);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 参数写反 / 相等时的兜底 ===');
{
  const s1 = stat(draw({ trait: { sentRollMin: 200, sentRollMax: 100 } }, 500));
  check('下限 > 上限 → 自动对调', s1.min >= 100 && s1.max <= 200, `min=${s1.min} max=${s1.max}`);

  const s2 = stat(draw({ trait: { sentRollMin: 77, sentRollMax: 77 } }, 200));
  check('上下限相等 → 固定 77', s2.min === 77 && s2.max === 77, `min=${s2.min} max=${s2.max}`);

  const d3 = createDb();
  delete d3.config.sentimentRollMin;
  delete d3.config.sentimentRollMax;
  d3.config.sentimentRollTicks = 600;
  const arr = Array.from({ length: 200 }, () => sentimentRollInterval(d3, { trait: {} }));
  const s3 = stat(arr);
  check('只有老的固定字段 → 退化成固定 600', s3.min === 600 && s3.max === 600, `min=${s3.min} max=${s3.max}`);
}

// ---------------------------------------------------------------- 7
log('');
log('=== 7 每只票各自独立：不会全场同一轮换情绪 ===');
{
  // 用同一个 db 模拟 12 只票各抽一次，间隔应当分散
  const arr = [];
  for (let i = 0; i < 12; i++) arr.push(sentimentRollInterval(db, { trait: {} }));
  const spread = Math.max(...arr) - Math.min(...arr);
  check('同一次重掷里 12 只票的间隔不完全相同', new Set(arr).size > 3, `distinct=${new Set(arr).size}`);
  check('最大最小差 > 60 轮', spread > 60, `spread=${spread}`);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
