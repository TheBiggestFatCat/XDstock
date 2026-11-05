// 「蜜蜂彩票」零漂移回归
//
//   node tests/lottery.mjs
//
// 历史 bug：涨 ×(1+p) / 跌 ×(1−p) 是百分比对称，对数收益期望恒为负
// （½ln(1−p²)），于是 HJF 不管财报多好都会长期阴跌。
// 现在下跌改成 ×1/(1+p)，一次涨一次跌正好回到原点。

import { lotteryFactor } from '../src/engine.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---------------------------------------------------------------- 1
log('=== 1 涨跌互为倒数 ===');
{
  for (const p of [0.12, 0.2, 0.26, 0.3, 0.4]) {
    const up = lotteryFactor(true, p);
    const down = lotteryFactor(false, p);
    check(`p=${p}：涨 ${up.toFixed(4)} × 跌 ${down.toFixed(4)} = 1`,
      near(up * down, 1, 1e-12), (up * down).toFixed(12));
  }
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 对数收益期望正好为 0（旧版是负数）===');
{
  const rows = [];
  for (const p of [0.12, 0.2, 0.26, 0.3, 0.4]) {
    const e = 0.5 * Math.log(lotteryFactor(true, p)) + 0.5 * Math.log(lotteryFactor(false, p));
    rows.push(`p=${p}: ${e.toFixed(12)}`);
    check(`p=${p} 期望对数收益 = 0`, near(e, 0, 1e-12), e.toExponential(2));
  }
  // 对照：旧公式的期望（用来说明 bug 有多大）
  const oldE = (p) => 0.5 * Math.log(1 + p) + 0.5 * Math.log(1 - p);
  const oldAvg = [0.12, 0.2, 0.26, 0.3, 0.4].map(oldE);
  check('旧公式确实有负漂移（作为对照）', oldAvg.every((v) => v < 0),
    oldAvg.map((v) => v.toFixed(4)).join(' / '));
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 边界：p=0 / 超范围 / 非数字 ===');
{
  check('p=0 时涨跌都是 1', lotteryFactor(true, 0) === 1 && lotteryFactor(false, 0) === 1);
  check('p>1 被夹到 1', lotteryFactor(true, 5) === 2 && lotteryFactor(false, 5) === 0.5);
  check('非数字当作 0', lotteryFactor(true, 'abc') === 1 && lotteryFactor(false, undefined) === 1);
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 「抽奖异动」这条分支已经下线（没有股票用 trait.lottery）===');
{
  // 2026-11 起：所有票都没有 trait.lottery，engine 里的抽奖分支删了，
  // 只保留 lotteryFactor 这个「涨 ×(1+p) / 跌 ×1/(1+p)」的零漂移公式（测试段 2、3 覆盖）。
  // 这里只是防止有人又把 cfg.weatherLottery* 加回来。
  const { DEFAULT_CONFIG } = await import('../src/config.js');
  check('config 里没有 weatherLottery*', !('weatherLotteryChance' in DEFAULT_CONFIG));
  check('config 里没有 activity*', !('activityEnabled' in DEFAULT_CONFIG));
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
