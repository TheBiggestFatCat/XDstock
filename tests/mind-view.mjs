// 「情绪读心」假值限制
//   node tests/mind-view.mjs
//
// 规则：
//   - 每次重掷情绪时，按 mindFakeChance（默认 0.5）决定「读心」看到的是不是假值
//   - 假值用同一套公式 rollSentimentV(edge) 重抽，看起来跟真的一样
//   - 假值一旦定了就撑到下一次重掷（不会每轮跳）
//   - **价格推力永远用真值**，假值只影响读心面板

import { createDb } from '../src/store.js';
import {
  stepMarket, rollSentimentV, rollMindView, sentimentView
} from '../src/engine.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

// ---------------------------------------------------------------- 1
log('=== 1 概率开关：0 = 永远真，1 = 永远假 ===');
{
  let fake = 0;
  for (let i = 0; i < 2000; i++) if (rollMindView(0.5, 3, 0).fake) fake++;
  check('chance=0 从不撒谎', fake === 0);
  check('chance=0 原样返回真值', rollMindView(0.5, 3, 0).viewV === 0.5);

  let allFake = true;
  for (let i = 0; i < 2000; i++) if (!rollMindView(0.5, 3, 1).fake) allFake = false;
  check('chance=1 永远撒谎', allFake);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 假值按同一套公式抽（分布一致、范围一致）===');
{
  const vs = [];
  for (let i = 0; i < 40000; i++) {
    const r = rollMindView(0, 3, 1);
    vs.push(r.viewV);
  }
  const abs = vs.map(Math.abs);
  const mean = abs.reduce((a, b) => a + b, 0) / abs.length;
  const over8 = abs.filter((v) => v > 0.8).length / abs.length;
  check('假值均值 ≈ 真值分布（0.389）', Math.abs(mean - 0.389) < 0.01, mean.toFixed(4));
  check('假值也有顶端难度（>0.8 约 10.7%）', over8 > 0.08 && over8 < 0.14,
    (over8 * 100).toFixed(1) + '%');
  check('假值都在 [-1, 1]', vs.every((v) => v >= -1 && v <= 1));
  check('假值有正有负', vs.some((v) => v > 0.3) && vs.some((v) => v < -0.3));
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 概率 0.5：大约一半是假的 ===');
{
  const N = 40000;
  let fake = 0;
  for (let i = 0; i < N; i++) if (rollMindView(0, 3, 0.5).fake) fake++;
  const rate = fake / N;
  check('假值比例 ≈ 50%', Math.abs(rate - 0.5) < 0.02, (rate * 100).toFixed(2) + '%');
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 sentimentView：有假值就用假值，没有就退回真值 ===');
{
  const db = createDb();
  db.tick = 100;
  const st = db.stocks.TGW;
  st.sentiment = { v: 0.42, viewV: -0.77, viewFake: true, nextRoll: 500, nextApply: 160, drift: 0.6, lastSwing: 0.001 };
  const view = sentimentView(st, db);
  check('读心看到的是假值', Math.abs(view.v - (-0.77)) < 1e-9, String(view.v));

  st.sentiment = { v: 0.42, nextRoll: 500, nextApply: 160, drift: 0.6 };
  check('老存档（没有 viewV）退回真值', Math.abs(sentimentView(st, db).v - 0.42) < 1e-9);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 引擎集成：假值只影响面板，价格照样按真值推 ===');
{
  const runOnce = (chance) => {
    const db = createDb();
    Object.assign(db.config, {
      baseVolatility: 0, meanReversion: 0, eventChance: 0, localEventChance: 0,
      marketTradesRate: 0, playerImpactEnabled: 0,
      sentimentEnabled: 1, sentimentStrength: 0.01, sentimentTicks: 1, sentimentDrift: 1,
      sentimentEdge: 3, mindFakeChance: chance, maxPremium: 1e9
    });
    const st = db.stocks.TGW;
    st.price = 100;
    st.fair = 100;
    st.nextReportTick = 1e12;
    st.sentiment = { v: 0, nextRoll: 0, nextApply: 0 };
    const realLog = console.log;
    console.log = () => {};
    try {
      stepMarket(db);
    } finally {
      console.log = realLog;
    }
    return { st, db };
  };

  const { st, db } = runOnce(1);          // 100% 假
  const real = Number(st.sentiment.v) || 0;
  const shown = sentimentView(st, db).v;
  check('100% 假时，面板值和真值不一样', Math.abs(shown - real) > 1e-9,
    `真 ${real.toFixed(3)} vs 显示 ${shown.toFixed(3)}`);
  check('假值标记为 true', st.sentiment.viewFake === true);
  // drift=1 时 swing = v × strength，正好能反推引擎用的是哪个值
  const usedV = Number(st.sentiment.lastSwing) / 0.01;
  check('价格推力用的是真值', Math.abs(usedV - real) < 1e-9,
    `实际用力 ${usedV.toFixed(3)}`);
  check('价格涨跌方向跟真值一致（真值为正则涨）',
    real === 0 ? Math.abs(st.price - 100) < 1e-9 : Math.sign(st.price - 100) === Math.sign(real));

  const honest = runOnce(0);
  check('chance=0 时面板值 = 真值', Math.abs(sentimentView(honest.st, honest.db).v -
    (Number(honest.st.sentiment.v) || 0)) < 1e-12);
  check('chance=0 时 viewFake = false', honest.st.sentiment.viewFake === false);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 假值在一次重掷周期内保持不变（不会每轮跳）===');
{
  const db = createDb();
  Object.assign(db.config, {
    baseVolatility: 0, meanReversion: 0, eventChance: 0, localEventChance: 0,
    marketTradesRate: 0, playerImpactEnabled: 0,
    sentimentEnabled: 1, sentimentStrength: 0.001, sentimentTicks: 12, sentimentDrift: 0.6,
    sentimentRollMin: 200, sentimentRollMax: 200, mindFakeChance: 1, maxPremium: 1e9
  });
  const st = db.stocks.TGW;
  st.price = 100;
  st.fair = 100;
  st.nextReportTick = 1e12;
  st.sentiment = { v: 0, nextRoll: 0, nextApply: 0 };
  const realLog = console.log;
  console.log = () => {};
  const shown = [];
  try {
    for (let i = 0; i < 120; i++) {
      stepMarket(db);
      shown.push(sentimentView(st, db).v);
    }
  } finally {
    console.log = realLog;
  }
  const first = shown[0];
  const changed = shown.filter((v) => Math.abs(v - first) > 1e-12).length;
  check('200 轮周期内（跑了 120 轮）显示值不跳', changed === 0, `变了 ${changed} 次`);
  check('并且确实是假值（和真值不同）',
    Math.abs(shown[0] - (Number(st.sentiment.v) || 0)) > 1e-9,
    `显示 ${shown[0].toFixed(3)} / 真 ${(Number(st.sentiment.v) || 0).toFixed(3)}`);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
