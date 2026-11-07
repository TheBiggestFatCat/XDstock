// 「情绪读心」读数规则
//   node tests/mind-view.mjs
//
// 规则（2026-11 改版）：
//   - 读心看到的情绪值可能是假的：每次重掷都会另抽一个同分布的「假读数」
//   - 谁看到假读数**按玩家判定**：
//       未进化   → 准确率 = 1 − mindFakeChance（默认 0.5 → 50%）
//       Ⅱ 阶     → 准确率 = mindAccurateChanceEvolved（默认 0.7 → 70%），没有别的额外效果
//   - 判定用「玩家 + 股票 + 这次重掷周期」的稳定哈希：一次重掷内不跳，不同玩家互相独立
//   - **价格推力永远用真值**，假读数只影响读心面板

import { createDb } from '../src/store.js';
import { stepMarket, rollSentimentV, sentimentView } from '../src/engine.js';
import { maskSentiment, mindAccurateChance, hash01 } from '../src/mind.js';
import { ensureAchvState, grantAchv, evolveTheme } from '../src/achievements.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

function mkPlayer(db, id, { evolved = false, skill = 'mind' } = {}) {
  const p = {
    id, nickname: id, cash: 1e9, positions: {}, orders: [],
    theme: skill, skill, level: 1, themes: ['mind'], shards: {}, themeTier: {},
    achv: {}, achvCounters: {}
  };
  ensureAchvState(p);
  db.players[id] = p;
  if (evolved) {
    grantAchv(db, p, 'mind_read');
    grantAchv(db, p, 'mind_profit');
    evolveTheme(db, p, 'mind');
  }
  return p;
}
const mkSt = (st, real, fake, nextRoll = 500) => {
  st.sentiment = { v: real, viewV: fake, nextRoll, nextApply: 0, drift: 0.6 };
};

// ---------------------------------------------------------------- 1
log('=== 1 准确率：未进化 50%，Ⅱ 阶 70% ===');
{
  const db = createDb();
  const p0 = mkPlayer(db, 'plain');
  const p2 = mkPlayer(db, 'evo', { evolved: true });
  check('未进化准确率 = 1 − mindFakeChance',
    Math.abs(mindAccurateChance(db, p0) - (1 - Number(db.config.mindFakeChance))) < 1e-9,
    String(mindAccurateChance(db, p0)));
  check('Ⅱ 阶准确率 = mindAccurateChanceEvolved（0.7）',
    Math.abs(mindAccurateChance(db, p2) - 0.7) < 1e-9, String(mindAccurateChance(db, p2)));
  check('不是读心技能 → 永远看真值', mindAccurateChance(db, { id: 'x', skill: 'red' }) === 1);
  const db2 = createDb();
  Object.assign(db2.config, { mindAccurateChanceEvolved: 1 });
  check('把 Ⅱ 阶准确率调成 1 → 永远真', mindAccurateChance(db2, mkPlayer(db2, 'evo2', { evolved: true })) === 1);
  Object.assign(db2.config, { mindAccurateChanceEvolved: 0 });
  check('调成 0 → 永远假', mindAccurateChance(db2, db2.players.evo2) === 0);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 实际命中率：未进化 ≈50%，Ⅱ 阶 ≈70% ===');
{
  const db = createDb();
  const st = db.stocks.TGW;
  const p0 = mkPlayer(db, 'p0');
  const p2 = mkPlayer(db, 'p2', { evolved: true });
  const N = 20000;
  let real0 = 0;
  let real2 = 0;
  for (let i = 0; i < N; i++) {
    mkSt(st, 0.8, -0.9, 1000 + i);
    if (!maskSentiment(st, db, p0).fake) real0++;
    if (!maskSentiment(st, db, p2).fake) real2++;
  }
  const r0 = real0 / N;
  const r2 = real2 / N;
  check('未进化命中真值 ≈ 50%', Math.abs(r0 - 0.5) < 0.03, (r0 * 100).toFixed(1) + '%');
  check('Ⅱ 阶命中真值 ≈ 70%', Math.abs(r2 - 0.7) < 0.03, (r2 * 100).toFixed(1) + '%');
  check('Ⅱ 阶明显更准', r2 > r0 + 0.1, `${(r0 * 100).toFixed(1)}% → ${(r2 * 100).toFixed(1)}%`);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 稳定性：同一次重掷内不跳，不同玩家互相独立 ===');
{
  const db = createDb();
  const st = db.stocks.TGW;
  const p0 = mkPlayer(db, 's1');
  const p2 = mkPlayer(db, 's2', { evolved: true });
  mkSt(st, 0.42, -0.77, 777);
  const a = maskSentiment(st, db, p0);
  const b = maskSentiment(st, db, p0);
  check('同一个玩家连续两次结果一致', a.v === b.v && a.fake === b.fake);
  // 换重掷周期才可能变
  let changed = 0;
  for (let i = 0; i < 200; i++) {
    mkSt(st, 0.42, -0.77, 900 + i);
    const cur = maskSentiment(st, db, p0);
    if (cur.v !== a.v) changed++;
  }
  check('换周期后读数会变（不是写死）', changed > 20, `变了 ${changed}/200`);
  // 同一周期下不同玩家结果不完全一样
  let diff = 0;
  mkSt(st, 0.42, -0.77, 555);
  for (let i = 0; i < 50; i++) {
    const q = mkPlayer(db, 'many' + i);
    if (maskSentiment(st, db, q).fake !== maskSentiment(st, db, p2).fake) diff++;
  }
  check('同周期不同玩家判定互相独立', diff > 5, `不同 ${diff}/50`);
  check('看到的只可能是真值或假读数之一', [0.42, -0.77].includes(Number(maskSentiment(st, db, p0).v.toFixed(2))));
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 sentimentView：按玩家返回，且带 fake 标记 ===');
{
  const db = createDb();
  db.tick = 100;
  const st = db.stocks.TGW;
  const p0 = mkPlayer(db, 'v1');
  mkSt(st, 0.42, -0.77, 500);
  const view = sentimentView(st, db, p0);
  check('只可能是真值或假读数', [0.42, -0.77].includes(Number(view.v.toFixed(2))), String(view.v));
  check('带 fake 标记', typeof view.fake === 'boolean');
  check('still 返回 rollIn / every 等面板字段',
    'rollIn' in view && 'applyIn' in view && 'every' in view);

  delete st.sentiment.viewV;
  check('老存档（没有 viewV）退回真值', Math.abs(sentimentView(st, db, p0).v - 0.42) < 1e-9);
  const red = { id: 'r', skill: 'red' };
  check('非读心玩家永远看真值', Math.abs(sentimentView(st, db, red).v - 0.42) < 1e-9);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 引擎集成：价格推力用真值，面板才用假读数 ===');
{
  const runOnce = (accurateEvolved) => {
    const db = createDb();
    Object.assign(db.config, {
      baseVolatility: 0, meanReversion: 0, eventChance: 0, localEventChance: 0,
      marketTradesRate: 0, hotMoneyEnabled: 0, playerImpactEnabled: 0,
      sentimentEnabled: 1, sentimentStrength: 0.01, sentimentTicks: 1, sentimentDrift: 1,
      sentimentEdge: 3, mindAccurateChanceEvolved: accurateEvolved, maxPremium: 1e9
    });
    const st = db.stocks.TGW;
    st.price = 100;
    st.fair = 100;
    st.nextReportTick = 1e12;
    st.sentiment = { v: 0, nextRoll: 0, nextApply: 0 };
    const p = mkPlayer(db, 'evo', { evolved: true });
    const realLog = console.log;
    console.log = () => {};
    try {
      stepMarket(db);
    } finally {
      console.log = realLog;
    }
    return { st, db, p };
  };

  const allFake = runOnce(0);          // Ⅱ 阶准确率 0 → 永远看假读数
  const real = Number(allFake.st.sentiment.v) || 0;
  const shown = sentimentView(allFake.st, allFake.db, allFake.p).v;
  check('准确率 0 时面板值和真值不同', Math.abs(shown - real) > 1e-9,
    `真 ${real.toFixed(3)} vs 显示 ${shown.toFixed(3)}`);
  const usedV = Number(allFake.st.sentiment.lastSwing) / 0.01;
  check('价格推力用的是真值', Math.abs(usedV - real) < 1e-9, `实际用力 ${usedV.toFixed(3)}`);
  check('价格方向跟真值一致',
    real === 0 ? Math.abs(allFake.st.price - 100) < 1e-9
      : Math.sign(allFake.st.price - 100) === Math.sign(real));

  const alwaysReal = runOnce(1);
  check('准确率 1 时面板值 = 真值',
    Math.abs(sentimentView(alwaysReal.st, alwaysReal.db, alwaysReal.p).v
      - (Number(alwaysReal.st.sentiment.v) || 0)) < 1e-12);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 重掷周期：假读数一次重掷内保持不变 ===');
{
  const db = createDb();
  Object.assign(db.config, {
    baseVolatility: 0, meanReversion: 0, eventChance: 0, localEventChance: 0,
    marketTradesRate: 0, hotMoneyEnabled: 0, playerImpactEnabled: 0,
    sentimentEnabled: 1, sentimentStrength: 0.001, sentimentTicks: 12, sentimentDrift: 0.6,
    sentimentRollMin: 200, sentimentRollMax: 200, mindAccurateChanceEvolved: 0, maxPremium: 1e9
  });
  const st = db.stocks.TGW;
  st.price = 100;
  st.fair = 100;
  st.nextReportTick = 1e12;
  st.sentiment = { v: 0, nextRoll: 0, nextApply: 0 };
  const p = mkPlayer(db, 'steady', { evolved: true });
  const realLog = console.log;
  console.log = () => {};
  const shown = [];
  try {
    for (let i = 0; i < 120; i++) {
      stepMarket(db);
      shown.push(sentimentView(st, db, p).v);
    }
  } finally {
    console.log = realLog;
  }
  const first = shown[0];
  const changed = shown.filter((v) => Math.abs(v - first) > 1e-12).length;
  check('200 轮周期内（跑了 120 轮）显示值不跳', changed === 0, `变了 ${changed} 次`);
  check('并且确实是假读数（和真值不同）',
    Math.abs(shown[0] - (Number(st.sentiment.v) || 0)) > 1e-9,
    `显示 ${shown[0].toFixed(3)} / 真 ${(Number(st.sentiment.v) || 0).toFixed(3)}`);
}

// ---------------------------------------------------------------- 7
log('');
log('=== 7 假读数分布：同分布、有正有负、都在 [-1,1] ===');
{
  const vs = [];
  for (let i = 0; i < 20000; i++) vs.push(rollSentimentV(3));
  check('都在 [-1, 1]', vs.every((v) => v >= -1 && v <= 1));
  check('有正有负', vs.some((v) => v > 0.3) && vs.some((v) => v < -0.3));
  const over8 = vs.filter((v) => Math.abs(v) > 0.8).length / vs.length;
  check('有顶端难度（>0.8 约 10%）', over8 > 0.07 && over8 < 0.15, (over8 * 100).toFixed(1) + '%');
  check('hash01 稳定且落在 [0,1)', (() => {
    const a = hash01('x|y|1');
    const b = hash01('x|y|1');
    return a === b && a >= 0 && a < 1 && hash01('x|y|2') !== a;
  })());
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
