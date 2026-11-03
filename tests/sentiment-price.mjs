// 散户情绪「是否真的作用到价格上」回归
//
//   node tests/sentiment-price.mjs
//
// 历史 bug：swing 加在 logRet 上，而 logRet 早就用来算出 p 了，
// 所以情绪参数怎么调都没反应。这里用「波动=0、其它影响全关」的环境，
// 价格只要动了就一定是情绪干的（不用改 Math.random——gauss 是拒绝采样，
// 固定随机数会死循环）。

import { createDb } from '../src/store.js';
import { stepMarket } from '../src/engine.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

/**
 * 只留散户情绪能影响价格：波动 0、无新闻、无玩家冲击、无均值回归、
 * 汇率关掉、不出版报、不重掷情绪（nextRoll 推到很远）
 */
function setup(overrides = {}) {
  const db = createDb();
  Object.assign(db.config, {
    baseVolatility: 0,
    meanReversion: 0,
    eventChance: 0,
    marketTradesRate: 0,
    playerImpactEnabled: 0,
    fxEnabled: 0,
    sentimentEnabled: 1,
    sentimentStrength: 0.01,
    sentimentTicks: 1,
    ...overrides
  });
  for (const st of Object.values(db.stocks)) {
    st.nextReportTick = 1e12;
    st.sentiment = { v: 1, nextRoll: 1e12, nextApply: 0 };
    if (st.trait) {
      st.trait.sentStrength = 0.01;
      st.trait.sentTicks = 1;
      st.trait.sentRollMin = 1e9;
      st.trait.sentRollMax = 1e9;
    }
  }
  return db;
}

/** 跑 n 轮，返回每轮结束后的价格（顺便屏蔽引擎的日志噪音） */
function runTicks(db, st, n) {
  const realLog = console.log;
  console.log = () => {};
  const prices = [st.price];
  try {
    for (let i = 0; i < n; i++) {
      stepMarket(db);
      prices.push(st.price);
    }
  } finally {
    console.log = realLog;
  }
  return prices;
}

const changedCount = (prices) => prices.slice(1).filter((p, i) => p !== prices[i]).length;

// ---------------------------------------------------------------- 1
log('=== 1 情绪必须真的推动价格（历史 bug 的核心）===');
{
  const db = setup();
  const st = db.stocks.TGW;
  const before = st.price;
  const prices = runTicks(db, st, 1);
  const move = Math.abs(prices[1] / before - 1);
  check('正情绪开关下价格真的变了', prices[1] !== before, `${before.toFixed(4)} -> ${prices[1].toFixed(4)}`);
  check('单次幅度不超过设定强度 1%', move > 0 && move < 0.0101, `实际 ${(move * 100).toFixed(3)}%`);
  check('lastSwing 有记录', Number.isFinite(st.sentiment.lastSwing) && st.sentiment.lastSwing !== 0,
    `lastSwing=${st.sentiment.lastSwing}`);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 关掉情绪后价格必须纹丝不动（证明测试环境是干净的）===');
{
  const db = setup({ sentimentEnabled: 0 });
  const st = db.stocks.TGW;
  const before = st.price;
  const prices = runTicks(db, st, 60);
  check('60 轮下来一次都没动', changedCount(prices) === 0, `变动 ${changedCount(prices)} 次`);
  check('价格保持原值', st.price === before, `${before} -> ${st.price}`);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 v = 0 时 swing 正好是 0 ===');
{
  const db = setup();
  const st = db.stocks.TGW;
  st.sentiment = { v: 0, nextRoll: 1e12, nextApply: 0 };
  const before = st.price;
  const prices = runTicks(db, st, 20);
  check('情绪值 0 → 价格不动', changedCount(prices) === 0, `变动 ${changedCount(prices)} 次`);
  check('lastSwing = 0', st.sentiment.lastSwing === 0, `${st.sentiment.lastSwing}`);
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 强度 0 时不生效 ===');
{
  const db = setup();
  const st = db.stocks.TGW;
  st.trait.sentStrength = 0;
  db.config.sentimentStrength = 0;
  const prices = runTicks(db, st, 20);
  check('强度 0 → 价格不动', changedCount(prices) === 0, `变动 ${changedCount(prices)} 次`);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 作用间隔 sentimentTicks 生效 ===');
{
  const db = setup();
  const st = db.stocks.TGW;
  st.trait.sentTicks = 3;               // 每 3 轮施加一次
  st.sentiment = { v: 1, nextRoll: 1e12, nextApply: 0 };
  const prices = runTicks(db, st, 9);   // 期望：第 1、4、7 轮各施加一次
  const n = changedCount(prices);
  check('9 轮里只动了 3 次', n === 3, `实际 ${n} 次`);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 情绪会累积成趋势，不是一次性 ===');
{
  const db = setup({ sentimentStrength: 0.02 });
  const st = db.stocks.TGW;
  st.trait.sentStrength = 0.02;
  st.sentiment = { v: 1, nextRoll: 1e12, nextApply: 0 };
  const before = st.price;
  const prices = runTicks(db, st, 120);
  // 每次施加 ±2% 以内的对称噪声，120 次的累计 σ ≈ 1.15% × √120 ≈ 12.6%
  const drift = Math.abs(st.price / before - 1);
  check('120 轮后有明显位移', drift > 0.005, `位移 ${(drift * 100).toFixed(2)}%`);
  check('位移在合理量级内（< 60%）', drift < 0.6, `${(drift * 100).toFixed(2)}%`);
  check('过程中价格确实在变', changedCount(prices) > 100, `变动 ${changedCount(prices)} 次`);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
