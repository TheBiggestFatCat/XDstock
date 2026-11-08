// 散户情绪的方向分量（情绪读心主题的前置）
//
//   node tests/sentiment-drift.mjs
//
// swing = v × strength × (drift + (1-drift)×U(-1,1))
//   drift = 0 → 纯随机（旧行为，v 只决定抖多大，E[swing]=0）
//   drift = 1 → 纯方向（swing 恒等于 v×strength）

import { createDb } from '../src/store.js';
import { stepMarket, sentimentView, rollSentimentV } from '../src/engine.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

/** 跑 n 轮情绪，返回累计对数偏移 */
function runSentiment({ drift, v, n = 300, strength = 0.004, every = 1 }) {
  const db = createDb();
  Object.assign(db.config, {
    baseVolatility: 0, meanReversion: 0, eventChance: 0, localEventChance: 0,
    marketTradesRate: 0, hotMoneyEnabled: 0, playerImpactEnabled: 0,
    sentimentEnabled: 1, sentimentStrength: strength, sentimentTicks: every, sentimentDrift: drift,
    // 这段只测情绪本身，把「估值上限」关掉，否则涨到 2.5 倍 fair 就被压住了
    maxPremium: 1e9
  });
  const st = db.stocks.TGW;
  st.price = 100;
  st.fair = 100;
  st.nextReportTick = 1e12;
  st.sentiment = { v, nextRoll: 1e12, nextApply: 0 };
  let logSum = 0;
  const realLog = console.log;
  console.log = () => {};
  try {
    for (let i = 0; i < n; i++) {
      st.sentiment.nextRoll = 1e12;
      const before = st.price;
      stepMarket(db);
      logSum += Math.log(st.price / before);
    }
  } finally {
    console.log = realLog;
  }
  return { sum: logSum, price: st.price, st };
}

// ---------------------------------------------------------------- 1
log('=== 1 drift=0（旧行为）：v 的正负不影响结果，累积偏移期望为 0 ===');
{
  const up = runSentiment({ drift: 0, v: 1, n: 4000 });
  const down = runSentiment({ drift: 0, v: -1, n: 4000 });
  check('v=+1 的累积偏移基本为 0', Math.abs(up.sum) < 0.6, up.sum.toFixed(3));
  check('v=-1 的累积偏移基本为 0', Math.abs(down.sum) < 0.6, down.sum.toFixed(3));
  check('两者方向无明显差异（旧行为没有方向）',
    Math.abs(up.sum - down.sum) < 0.6, `差 ${(up.sum - down.sum).toFixed(3)}`);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 drift=1（纯方向）：swing 恒等于 v × strength ===');
{
  const up = runSentiment({ drift: 1, v: 1, n: 200, strength: 0.004, every: 1 });
  const down = runSentiment({ drift: 1, v: -1, n: 200, strength: 0.004, every: 1 });
  check('v=+1 200 轮 ≈ +0.8（0.004×200）', Math.abs(up.sum - 0.8) < 1e-6, up.sum.toFixed(6));
  check('v=-1 200 轮 ≈ -0.8', Math.abs(down.sum + 0.8) < 1e-6, down.sum.toFixed(6));
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 drift=0.6：方向分量占总量的 60% ===');
{
  const up = runSentiment({ drift: 0.6, v: 1, n: 3000, strength: 0.004, every: 1 });
  // 期望 = 0.6 × 0.004 × 3000 = 7.2，噪声 σ = 0.4×0.004/√3×√3000 ≈ 0.16
  check('v=+1 累积偏移 ≈ +7.2', Math.abs(up.sum - 7.2) < 0.6, up.sum.toFixed(3));
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 个股 trait.sentDrift 覆盖全局 ===');
{
  const db = createDb();
  Object.assign(db.config, {
    baseVolatility: 0, meanReversion: 0, eventChance: 0, localEventChance: 0,
    marketTradesRate: 0, hotMoneyEnabled: 0, playerImpactEnabled: 0,
    sentimentEnabled: 1, sentimentStrength: 0.004, sentimentTicks: 1, sentimentDrift: 0
  });
  const st = db.stocks.TGW;
  st.price = 100;
  st.fair = 100;
  st.nextReportTick = 1e12;
  st.trait.sentDrift = 1;                 // 个股强制纯方向
  st.sentiment = { v: 1, nextRoll: 1e12, nextApply: 0 };
  let sum = 0;
  const realLog = console.log;
  console.log = () => {};
  try {
    for (let i = 0; i < 100; i++) {
      st.sentiment.nextRoll = 1e12;
      const before = st.price;
      stepMarket(db);
      sum += Math.log(st.price / before);
    }
  } finally {
    console.log = realLog;
  }
  check('全局 drift=0 但个股 drift=1 时仍有方向', Math.abs(sum - 0.4) < 1e-6, sum.toFixed(4));
  check('情绪状态里记下了生效的 drift', Math.abs(Number(st.sentiment.drift) - 1) < 1e-9,
    String(st.sentiment.drift));
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 sentimentView：给「情绪读心」主题的字段 ===');
{
  const st = { sentiment: { v: 0.42, nextRoll: 1100, nextApply: 1050, drift: 0.6, lastSwing: 0.002 } };
  const view = sentimentView(st, { tick: 1000, config: { sentimentTicks: 12 } });
  check('v 透传', Math.abs(view.v - 0.42) < 1e-9);
  check('rollIn = nextRoll - tick', view.rollIn === 100, String(view.rollIn));
  check('applyIn = nextApply - tick', view.applyIn === 50, String(view.applyIn));
  check('every 从全局取', view.every === 12, String(view.every));
  check('drift 透传', Math.abs(view.drift - 0.6) < 1e-9);
  check('swing 透传', Math.abs(view.swing - 0.002) < 1e-12);
  const withTrait = sentimentView(
    { trait: { sentTicks: 30 }, sentiment: { v: 0, nextRoll: 1, nextApply: 1 } },
    { tick: 0, config: { sentimentTicks: 12 } }
  );
  check('个股 sentTicks 优先', withTrait.every === 30, String(withTrait.every));
  const empty = sentimentView({}, { tick: 5 });
  check('没有情绪状态时返回全 0', empty.v === 0 && empty.rollIn === 0 && empty.applyIn === 0);
  const future = sentimentView({ sentiment: { v: 1, nextRoll: 10, nextApply: 10 } }, { tick: 100 });
  check('过期的 nextRoll 不会返回负数', future.rollIn === 0 && future.applyIn === 0);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 情绪值分布：套了对数后越靠两端越难抽（rollSentimentV）===');
{
  const sample = (hard, n = 60000) => {
    const vs = [];
    for (let i = 0; i < n; i++) vs.push(rollSentimentV(hard));
    const abs = vs.map(Math.abs);
    const mean = abs.reduce((a, b) => a + b, 0) / abs.length;
    const over8 = abs.filter((v) => v > 0.8).length / abs.length;
    return { mean, over8, min: Math.min(...vs), max: Math.max(...vs) };
  };
  const uniform = sample(0);
  const normal = sample(3);
  const hard = sample(9);
  check('k=0 是均匀分布（均值 |v| ≈ 0.5）', Math.abs(uniform.mean - 0.5) < 0.01,
    uniform.mean.toFixed(4));
  check('k=0 时 20% 落在 |v|>0.8', Math.abs(uniform.over8 - 0.2) < 0.01,
    (uniform.over8 * 100).toFixed(1) + '%');
  check('k=3 均值降到 ≈0.39', Math.abs(normal.mean - 0.389) < 0.01, normal.mean.toFixed(4));
  check('k=3 时极端值少了一半', normal.over8 < 0.13,
    (normal.over8 * 100).toFixed(1) + '%');
  check('k=9 更难到顶端', hard.mean < normal.mean - 0.03 && hard.over8 < normal.over8,
    `均值 ${hard.mean.toFixed(3)}，>0.8 占 ${(hard.over8 * 100).toFixed(1)}%`);
  check('所有取值都在 [-1, 1]', uniform.min >= -1 && uniform.max <= 1 &&
    normal.min >= -1 && normal.max <= 1 && hard.min >= -1 && hard.max <= 1);
  check('符号不丢（不会把负数变成正数）', (() => {
    for (let i = 0; i < 2000; i++) {
      const v = rollSentimentV(3);
      if (Number.isNaN(v) || !Number.isFinite(v)) return false;
    }
    return true;
  })());
}

// ---------------------------------------------------------------- 7
log('');
log('=== 7 引擎确实按 config.sentimentEdge 抽（集成）===');
{
  const avgAbsV = (edge) => {
    const db = createDb();
    Object.assign(db.config, {
      baseVolatility: 0, meanReversion: 0, eventChance: 0, localEventChance: 0,
      marketTradesRate: 0, hotMoneyEnabled: 0, playerImpactEnabled: 0,
      sentimentEnabled: 1, sentimentStrength: 0.001, sentimentTicks: 1, sentimentEdge: edge
    });
    const st = db.stocks.TGW;
    st.price = 100;
    st.fair = 100;
    st.nextReportTick = 1e12;
    st.sentiment = { v: 0, nextRoll: 0, nextApply: 0 };
    const realLog = console.log;
    console.log = () => {};
    const vals = [];
    try {
      // 1600 次：|U(-1,1)| 均值的标准差 ≈ 0.0144，卡 0.05 就是 ±3.5σ（400 次时只有 ±1.7σ，会抖）
      for (let i = 0; i < 1600; i++) {
        st.sentiment.nextRoll = 0;      // 每轮强制重掷
        stepMarket(db);
        vals.push(Math.abs(Number(st.sentiment.v) || 0));
      }
    } finally {
      console.log = realLog;
    }
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  const flat = avgAbsV(0);
  const steep = avgAbsV(20);
  check('edge=0 时均值接近 0.5', Math.abs(flat - 0.5) < 0.05, flat.toFixed(3));
  check('edge=20 时明显更小', steep < flat - 0.1, `0.5 → ${steep.toFixed(3)}`);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
