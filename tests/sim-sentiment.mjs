// 散户情绪强度模拟器（重做版）
//   node tests/_sim_sentiment.mjs
//
// 量三件事：
//   1. 方向推力：v 固定时每小时把价格推多少
//   2. 随机波动：drift=0 时情绪自己贡献多少 σ
//   3. 净效果：跟均值回归拔河，最后价格能偏离 fair 多远

import { createDb } from '../src/store.js';
import { stepMarket } from '../src/engine.js';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 跑 n 轮，返回对数收益序列 */
function run({ strength, ticks = 12, drift = 0.6, v = 1, baseVol = 0, n = 720, seed = 1,
  reversion = 0, rolling = false } = {}) {
  const db = createDb();
  Object.assign(db.config, {
    baseVolatility: baseVol, meanReversion: reversion, eventChance: 0, localEventChance: 0,
    marketTradesRate: 0, hotMoneyEnabled: 0, playerImpactEnabled: 0,
    sentimentEnabled: 1, sentimentStrength: strength, sentimentTicks: ticks, sentimentDrift: drift,
    sentimentRollMin: 480, sentimentRollMax: 960
  });
  const st = db.stocks.TGW;
  st.price = 100;
  st.fair = 100;
  st.nextReportTick = 1e12;
  st.sentiment = { v, nextRoll: 1e12, nextApply: 0 };

  const orig = Math.random;
  Math.random = mulberry32(seed);
  const logs = [];
  const realLog = console.log;
  console.log = () => {};
  try {
    let prev = st.price;
    for (let i = 0; i < n; i++) {
      if (!rolling) st.sentiment.nextRoll = 1e12;
      stepMarket(db);
      logs.push(Math.log(st.price / prev));
      prev = st.price;
    }
  } finally {
    console.log = realLog;
    Math.random = orig;
  }
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  const sd = Math.sqrt(logs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, logs.length - 1));
  return { mean, sd, end: st.price, logs };
}

/** 多个种子取平均，得到每小时平均推力 / σ */
function hourly({ strength, drift, v, baseVol = 0, n = 720, seeds = 20, reversion = 0 }) {
  const means = [];
  const sds = [];
  for (let s = 1; s <= seeds; s++) {
    const r = run({ strength, drift, v, baseVol, n, seed: s * 97, reversion });
    means.push(r.mean * 720);
    sds.push(r.sd * Math.sqrt(720));
  }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return { mean: avg(means), sd: avg(sds) };
}

const pct = (v, d = 2) => (v * 100).toFixed(d) + '%';
const pad = (s, n) => String(s).padStart(n);

console.log('========== A. 情绪单独作用：方向推力 vs 随机波动 ==========');
console.log('  参数：每 12 轮推一次（每小时 60 次），v 固定，关掉其它所有力');
console.log('strength  drift   v=+1 每小时    v=-1 每小时    drift=0 时每小时σ');
console.log('-------------------------------------------------------------------------');
for (const strength of [0.002, 0.004, 0.006, 0.01, 0.015, 0.02]) {
  const up = hourly({ strength, drift: 0.6, v: 1 });
  const down = hourly({ strength, drift: 0.6, v: -1 });
  const noiseOnly = hourly({ strength, drift: 0, v: 1 });
  const analyticPush = 60 * strength * 0.6;
  console.log(
    pad(pct(strength, 1), 8) + pad('0.6', 6) + pad(pct(up.mean), 14) + pad(pct(down.mean), 14) + pad(pct(noiseOnly.sd), 16) +
    '   (理论推力 ' + pct(analyticPush) + ')'
  );
}

console.log('');
console.log('========== B. 放回线上噪声里，情绪占总波动的比例 ==========');
console.log('  线上 baseVolatility = 1%/轮 → 每小时噪声 σ = 26.83%');
const NOISE_H = 0.01 * Math.sqrt(720);
console.log('strength  drift |  情绪σ/小时   噪声σ/小时   占比');
console.log('-------------------------------------------------');
for (const strength of [0.004, 0.01, 0.015, 0.02, 0.03, 0.05]) {
  const r = hourly({ strength, drift: 0.6, v: 1, n: 1440, seeds: 8 });
  const sentH = r.sd;
  console.log(
    pad(pct(strength, 1), 8) + pad('0.6', 6) + ' |' + pad(pct(sentH), 12) + pad(pct(NOISE_H), 13) +
    pad((sentH / NOISE_H * 100).toFixed(1) + '%', 8)
  );
}

console.log('');
console.log('========== C. 跟均值回归拔河：价格能偏离 fair 多远 ==========');
console.log('  均值回归 k=0.0004/轮 → 每小时把 log 缺口拉回 25%（半衰期约 2.4 小时）');
console.log('strength  drift | 1 小时(中位)  6 小时(中位)  24 小时(中位)  24小时(90分位)');
console.log('-----------------------------------------------------------------------------');
function excursion(strength, drift, hours, seeds = 10) {
  const out = [];
  for (let s = 1; s <= seeds; s++) {
    const r = run({ strength, drift, v: 1, rolling: true, n: 720 * hours, seed: s * 13, reversion: 0.0004 });
    // 跟「没有情绪」时的 fair 比（fair 固定 100）
    out.push(Math.abs(Math.log(r.end / 100)));
  }
  out.sort((a, b) => a - b);
  return [out[Math.floor(out.length / 2)], out[Math.floor(out.length * 0.9)]];
}
for (const strength of [0.002, 0.004, 0.006, 0.01, 0.015]) {
  for (const drift of [0.3, 0.6, 1]) {
    const [m1] = excursion(strength, drift, 1);
    const [m6] = excursion(strength, drift, 6);
    const [m24, p24] = excursion(strength, drift, 24);
    console.log(
      pad(pct(strength, 1), 8) + pad(String(drift), 6) + ' |' +
      pad(pct(m1), 13) + pad(pct(m6), 14) + pad(pct(m24), 14) + pad(pct(p24), 15)
    );
  }
}
