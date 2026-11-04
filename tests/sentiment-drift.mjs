// 散户情绪的方向分量（情绪读心主题的前置）
//
//   node tests/sentiment-drift.mjs
//
// swing = v × strength × (drift + (1-drift)×U(-1,1))
//   drift = 0 → 纯随机（旧行为，v 只决定抖多大，E[swing]=0）
//   drift = 1 → 纯方向（swing 恒等于 v×strength）

import { createDb } from '../src/store.js';
import { stepMarket } from '../src/engine.js';
import { sentimentView } from '../src/engine.js';

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
    marketTradesRate: 0, playerImpactEnabled: 0,
    sentimentEnabled: 1, sentimentStrength: strength, sentimentTicks: every, sentimentDrift: drift
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
    marketTradesRate: 0, playerImpactEnabled: 0,
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

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
