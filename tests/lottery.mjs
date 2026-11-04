// 「蜜蜂彩票」零漂移回归
//
//   node tests/lottery.mjs
//
// 历史 bug：涨 ×(1+p) / 跌 ×(1−p) 是百分比对称，对数收益期望恒为负
// （½ln(1−p²)），于是 HJF 不管财报多好都会长期阴跌。
// 现在下跌改成 ×1/(1+p)，一次涨一次跌正好回到原点。

import { createDb } from '../src/store.js';
import { lotteryFactor, stepMarket } from '../src/engine.js';

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
log('=== 4 实跑引擎：两轮彩票只可能是 15.625 / 10 / 6.4（旧版是 14.06 / 9.375 / 5.625）===');
{
  const db = createDb();
  Object.assign(db.config, {
    baseVolatility: 0,
    meanReversion: 0,
    eventChance: 0,
    localEventChance: 0,
    marketTradesRate: 0,
    playerImpactEnabled: 0,
    sentimentEnabled: 0,
    weatherLotteryChance: 1,      // 每轮必触发
    weatherLotteryLo: 0.25,       // 固定幅度：涨 ×1.25、跌 ×0.8
    weatherLotteryHi: 0.25
  });
  for (const st of Object.values(db.stocks)) {
    st.nextReportTick = 1e12;
    st.sentiment = { v: 0, nextRoll: 1e12, nextApply: 1e12 };
    st.flow = 0;
    if (st.trait?.id === 'weather') {
      st.price = 10;
      st.fair = 10;
      st.weatherTarget = 10;
      st.trait.anticipate = 0;
      st.trait.swing = 0.0001;
    }
  }
  db.events = [];
  db.events = [];
  // 抽奖型个股（原哈基蜂业 HJF 已经下市，这里自己造一只同样体质的票）
  const hjf = {
    code: 'LOT', name: '测试抽奖股', industry: '农业种业',
    shares: 260000000, freeFloat: 0.5, price: 10, fair: 10, initialPrice: 10,
    status: 'normal', series: [10], streak: 0, flow: 0, nextReportTick: 1e12,
    brokerMid: 100000,
    sentiment: { v: 0, nextRoll: 1e12, nextApply: 1e12 },
    trait: {
      id: 'weather', name: '靠天吃饭', desc: '测试用', volMult: 1, revMult: 1,
      swing: 0.0001, anticipate: 0,
      lottery: 1, lotteryChance: 0.0006, lotteryLo: 0.12, lotteryHi: 0.40
    }
  };
  db.stocks.LOT = hjf;
  hjf.price = 10;

  const realLog = console.log;
  console.log = () => {};
  try {
    for (let i = 0; i < 2; i++) stepMarket(db);   // 两轮 = 两次彩票
  } finally {
    console.log = realLog;
  }

  const v = Number(hjf.price.toFixed(4));
  const okNew = [15.625, 10, 6.4].some((x) => Math.abs(x - v) < 1e-6);
  const oldVals = [14.0625, 9.375, 5.625];
  check('结果落在「涨×1.25 / 跌×0.8」的三种组合里', okNew, `${v}`);
  check('不落在旧公式的三种组合里', !oldVals.some((x) => Math.abs(x - v) < 1e-6),
    `旧值 ${oldVals.join(' / ')}`);
  check('公告幅度是真实涨跌幅（涨 25% 或跌 20%）',
    [0.25, 0.2].some((x) => Math.abs(hjf.lastLottery.pct - x) < 1e-6),
    `${(hjf.lastLottery.pct * 100).toFixed(2)}%`);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
