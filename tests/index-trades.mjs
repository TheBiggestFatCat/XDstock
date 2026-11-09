// 指数的虚假成交：抽得到、按权重拆给成分股、能间接推动成分股和指数
//   node tests/index-trades.mjs

import { createDb, migrate } from '../src/store.js';
import { genMarketTrades, indexTradeWeight, marketTradeWeight } from '../src/marketTrades.js';
import { indexWeights, addMarketFlow, addVolume } from '../src/trading.js';
import { stepMarket } from '../src/engine.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

const quiet = (fn) => {
  const real = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = real; }
};

function calmDb(patch = {}) {
  const db = quiet(() => migrate(createDb()));
  Object.assign(db.config, {
    baseVolatility: 0, meanReversion: 0, eventChance: 0, localEventChance: 0,
    hotMoneyEnabled: 0, sentimentEnabled: 0, playerImpactEnabled: 0,
    fxEnabled: 0, goldVol: 0, goldRev: 0,
    maxPremium: 1e9, reportIntervalTicks: 1e12,
    marketTradesEnabled: 1
  }, patch);
  db.tick = 10000;
  db.events = [];
  for (const st of Object.values(db.stocks)) {
    st.nextReportTick = 1e12;
    st.mflow = 0;
    st.volTick = 0;
    st.volSeries = [];
  }
  return db;
}

// ---------------------------------------------------------------- 1
log('=== 1 指数现在抽得到虚假成交 ===');
{
  const db = calmDb({ marketTradesRate: 8, marketTradesSizeExp: 1, indexTradeScale: 0.08 });
  for (let i = 0; i < 200; i += 1) quiet(() => genMarketTrades(db, 2));
  const idxRows = db.trades.filter((t) => t.code === 'DENG' || t.code === 'DENGS');
  const stockRows = db.trades.filter((t) => t.code !== 'DENG' && t.code !== 'DENGS');
  check('指数有了虚假成交', idxRows.length > 0, `共 ${idxRows.length} 笔`);
  check('个股也还在成交', stockRows.length > 0, `共 ${stockRows.length} 笔`);
  check('指数占比不超过一半', idxRows.length < (idxRows.length + stockRows.length) * 0.5,
    `指数 ${idxRows.length} / 全部 ${idxRows.length + stockRows.length}`);
  check('两个指数都抽到', idxRows.some((t) => t.code === 'DENG') && idxRows.some((t) => t.code === 'DENGS'));
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 权重口径：指数用成分股市值之和 × 系数 ===');
{
  const db = calmDb({ marketTradesSizeExp: 1, indexTradeScale: 0.08 });
  const deng = db.stocks.DENG;
  const w = indexTradeWeight(db, deng, db.config);
  check('指数权重 > 0（老逻辑是 0）', w > 0, String(w));
  // 老口径对指数算不出有效权重（指数没有 shares → freeCap 是 NaN），所以必须另开一条
  const legacy = marketTradeWeight(deng, db.config);
  // 老口径：指数没有 shares → freeCap 兜底成 1 → 权重 1e-8，等于永远抽不到
  check('老口径权重小到抽不到（<1e-6）', !(legacy > 1e-6), String(legacy));

  const zero = indexTradeWeight(db, deng, { ...db.config, indexTradeScale: 0 });
  check('系数 0 → 权重 0（可关掉）', zero === 0, String(zero));

  const half = indexTradeWeight(db, deng, { ...db.config, indexTradeScale: 0.04 });
  check('系数减半 → 权重减半', Math.abs(half - w / 2) < 1e-9, `${w} → ${half}`);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 指数单按权重拆到成分股（冲击 / 成交量） ===');
{
  const db = calmDb();
  const deng = db.stocks.DENG;
  const before = Object.fromEntries(Object.values(db.stocks).filter((s) => !s.isIndex)
    .map((s) => [s.code, Number(s.mflow) || 0]));
  const beforeVol = Object.fromEntries(Object.values(db.stocks).filter((s) => !s.isIndex)
    .map((s) => [s.code, Number(s.volTick) || 0]));

  const notional = 10_000_000;
  addMarketFlow(db, deng, notional);
  addVolume(db, 'DENG', 4000);

  const legs = {};
  for (const { st, weight } of indexWeights(db, 'index')) {
    if (!(weight > 0)) continue;
    legs[st.code] = weight;
    const dFlow = (Number(st.mflow) || 0) - before[st.code];
    check(`  ${st.code} 吃到冲击（权重 ${(weight * 100).toFixed(1)}%）`, dFlow > 0, String(dFlow.toFixed(4)));
  }
  const memberSum = Object.values(legs).reduce((a, b) => a + b, 0);
  check('权重合计 = 1', Math.abs(memberSum - 1) < 1e-9, String(memberSum));

  const volSum = Object.values(db.stocks).filter((s) => !s.isIndex)
    .reduce((a, s) => a + ((Number(s.volTick) || 0) - (beforeVol[s.code] || 0)), 0);
  check('成交量按权重拆完合计 = 4000', Math.abs(volSum - 4000) < 1e-6, String(volSum));
  const outsider = Object.values(db.stocks).find((s2) => !s2.isIndex && !(legs[s2.code] > 0));
  if (outsider) {
    const dv = (Number(outsider.volTick) || 0) - (beforeVol[outsider.code] || 0);
    check('非成分股没被塞成交量', dv === 0, `${outsider.code} +${dv}`);
  } else {
    check('非成分股没被塞成交量（都是成分股，跳过）', true);
  }
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 指数单能把成分股价格推动（间接影响） ===');
{
  // 只留指数单：个股 mktSizeScale = 0，抽签权重归零
  const db = calmDb({ marketTradesRate: 40, indexTradeScale: 1 });
  for (const s2 of Object.values(db.stocks)) {
    if (!s2.isIndex) s2.trait = { ...(s2.trait || {}), mktSizeScale: 0 };
  }
  const members = indexWeights(db, 'index').filter((x) => x.weight > 0).map((x) => x.st.code);
  const px0 = Object.fromEntries(members.map((c) => [c, db.stocks[c].price]));
  const idx0 = db.stocks.DENG.price;

  for (let i = 0; i < 12; i += 1) quiet(() => stepMarket(db));

  const moved = members.filter((c) => db.stocks[c].price !== px0[c]);
  check('成分股价格被动到了', moved.length > 0, `${moved.length} / ${members.length} 只`);
  check('指数点位也跟着动了', db.stocks.DENG.price !== idx0, `${idx0} → ${db.stocks.DENG.price}`);

  // 指数是按权重加权的，所以要跟「权重加权后的成分股涨跌」比，而不是数只数
  let weighted = 0;
  for (const { st, weight } of indexWeights(db, 'index')) {
    if (!(weight > 0)) continue;
    const p0 = px0[st.code];
    if (p0 > 0) weighted += weight * (st.price / p0 - 1);
  }
  const idxChg = idx0 > 0 ? db.stocks.DENG.price / idx0 - 1 : 0;
  check('指数方向 = 成分股加权方向', Math.sign(idxChg) === Math.sign(weighted),
    `指数 ${(idxChg * 100).toFixed(3)}% vs 加权 ${(weighted * 100).toFixed(3)}%`);
  check('指数确实动了（不是纹丝不动）', Math.abs(idxChg) > 1e-9, String(idxChg));
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
