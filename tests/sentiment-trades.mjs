// 散户情绪 → 虚假成交（2026-11）
//   node tests/sentiment-trades.mjs
//
// 要做的事：把「散户情绪」从只影响价格的一条暗线，变成**看得见的成交**——
//   1. 成交笔数按流通市值分配（大票笔数多），否则 9 笔均匀抽，小票被推飞、大票纹丝不动
//   2. 情绪定方向：看多偏买、看空偏卖
//   3. 情绪放量：越兴奋成交越多
// 原来的虚假成交机制（三档金额 / 昵称池 / 走 st.mflow 推价）一点没动。

import { createDb, migrate } from '../src/store.js';
import { marketTradeWeight, marketSentimentBias, genMarketTrades } from '../src/marketTrades.js';
import { freeCap } from '../src/fundamentals.js';

let fails = 0;
let passes = 0;
const out = [];
const realLog = console.log;
console.log = () => {};
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

function calmDb(over = {}) {
  const db = migrate(createDb());
  Object.assign(db.config, {
    baseVolatility: 0, meanReversion: 0, eventChance: 0, localEventChance: 0,
    hotMoneyEnabled: 0, playerImpactEnabled: 0, marketImpactEnabled: 1,
    sentimentEnabled: 0, goldVol: 0, goldRev: 0, reportIntervalTicks: 1e9,
    dividendRate: 0, morningRallyEnabled: 0,
    marketTradesEnabled: 1, marketTradesRate: 40,
    ...over
  });
  db.tick = 1000;
  db.players = {};
  for (const st of Object.values(db.stocks)) {
    st.nextReportTick = 1e12;
    st.status = 'normal';
    st.st = false;
    st.stTicks = 0;
    st.sentiment = { v: 0 };
    st.trait = {};
  }
  return db;
}

const byCode = (rows) => {
  const m = new Map();
  for (const r of rows) m.set(r.code, (m.get(r.code) || 0) + 1);
  return m;
};

// ================================================================ 1
log('=== 1 成交权重：按流通市值分配 ===');
{
  const db = calmDb();
  const stocks = Object.values(db.stocks).filter((s) => !s.isIndex);
  const big = stocks.reduce((a, b) => (freeCap(a) >= freeCap(b) ? a : b));
  const small = stocks.reduce((a, b) => (freeCap(a) <= freeCap(b) ? a : b));

  const wBig = marketTradeWeight(big, db.config);
  const wSmall = marketTradeWeight(small, db.config);
  check('大票权重 > 小票权重', wBig > wSmall * 5,
    `${big.code} ${wBig.toFixed(2)} vs ${small.code} ${wSmall.toFixed(2)}`);
  check('权重比 ≈ 流通市值比（指数 1）',
    near(wBig / wSmall, freeCap(big) / freeCap(small), (freeCap(big) / freeCap(small)) * 1e-6),
    `${(wBig / wSmall).toFixed(2)} vs ${(freeCap(big) / freeCap(small)).toFixed(2)}`);

  // 指数 0 = 各票一样重（老行为）
  const flat = { ...db.config, marketTradesSizeExp: 0 };
  check('指数 0 → 每只票权重一样', near(marketTradeWeight(big, flat), marketTradeWeight(small, flat)),
    `${marketTradeWeight(big, flat)} vs ${marketTradeWeight(small, flat)}`);

  // 个股覆盖
  const scaled = { ...big, trait: { ...big.trait, mktSizeScale: 3 } };
  check('个股 mktSizeScale=3 → 权重 ×3', near(marketTradeWeight(scaled, db.config), wBig * 3),
    `${marketTradeWeight(scaled, db.config).toFixed(2)} vs ${(wBig * 3).toFixed(2)}`);
  const exp0 = { ...big, trait: { mktSizeExp: 0 } };
  check('个股 mktSizeExp=0 → 退化成 1 份', near(marketTradeWeight(exp0, db.config), 1),
    String(marketTradeWeight(exp0, db.config)));
}

// ================================================================ 2
log('');
log('=== 2 情绪放量：|v| 越大笔数越多 ===');
{
  const db = calmDb();
  const st = db.stocks.TGW;
  st.sentiment = { v: 0 };
  const base = marketTradeWeight(st, db.config);
  st.sentiment = { v: 1 };
  const hot = marketTradeWeight(st, db.config);
  st.sentiment = { v: -1 };
  const cold = marketTradeWeight(st, db.config);
  check('正常情绪 v=1 → 权重 ×1.6（全局 60%）', near(hot / base, 1.6, 1e-6), (hot / base).toFixed(3));
  check('负情绪也一样放量（只和绝对值有关）', near(cold, hot), `${cold.toFixed(2)} vs ${hot.toFixed(2)}`);
  check('个股 mktSentVol=0 → 不放量',
    near(marketTradeWeight({ ...st, trait: { mktSentVol: 0 } }, db.config), base),
    String(marketTradeWeight({ ...st, trait: { mktSentVol: 0 } }, db.config).toFixed(2)));
  check('个股 mktSentVol=200 → ×3',
    near(marketTradeWeight({ ...st, trait: { mktSentVol: 200 } }, db.config) / base, 3, 1e-6));
}

// ================================================================ 3
log('');
log('=== 3 情绪定方向：看多偏买、看空偏卖 ===');
{
  const db = calmDb();
  const st = db.stocks.TGW;
  check('v=0 → 没有偏移', near(marketSentimentBias(st, db.config), 0));
  st.sentiment = { v: 1 };
  check('v=1、全局 25 → +0.25 买盘', near(marketSentimentBias(st, db.config), 0.25));
  st.sentiment = { v: -1 };
  check('v=-1 → -0.25（偏卖）', near(marketSentimentBias(st, db.config), -0.25));
  check('个股 mktSentBias=0 → 情绪不影响方向',
    near(marketSentimentBias({ ...st, trait: { mktSentBias: 0 } }, db.config), 0));
  check('个股 mktSentBias=60 且 v=-1 → -0.6（偏卖）',
    near(marketSentimentBias({ ...st, trait: { mktSentBias: 60 } }, db.config), -0.6));
  check('v 超出 [-1,1] 被夹住',
    near(marketSentimentBias({ ...st, sentiment: { v: 5 } }, db.config), 0.25));

  // 端到端：看多时买盘明显更多
  const bull = calmDb();
  for (const s of Object.values(bull.stocks)) s.sentiment = { v: 1 };
  // 让「追涨杀跌」不干扰：窗口判定关掉偏移
  bull.config.marketTradesChase = 0;
  bull.config.marketTradesPanic = 0;
  const bullRows = [];
  for (let i = 0; i < 30; i++) bullRows.push(...genMarketTrades(bull, 2));
  const bullBuy = bullRows.filter((r) => r.side === 'long').length / bullRows.length;
  check('全员看多 → 买盘约 75%', bullBuy > 0.65, (bullBuy * 100).toFixed(0) + '%');

  const bear = calmDb();
  for (const s of Object.values(bear.stocks)) s.sentiment = { v: -1 };
  bear.config.marketTradesChase = 0;
  bear.config.marketTradesPanic = 0;
  const bearRows = [];
  for (let i = 0; i < 30; i++) bearRows.push(...genMarketTrades(bear, 2));
  const bearSell = bearRows.filter((r) => r.side === 'short').length / bearRows.length;
  check('全员看空 → 卖盘约 75%', bearSell > 0.65, (bearSell * 100).toFixed(0) + '%');
}

// ================================================================ 4
log('');
log('=== 4 端到端：大票分到的笔数明显更多 ===');
{
  const db = calmDb();
  // 小票分到的笔数少，样本太小时比例波动很大 → 多跑几轮
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push(...genMarketTrades(db, 2));
  const counts = byCode(rows);
  const stocks = Object.values(db.stocks).filter((s) => !s.isIndex);
  const big = stocks.reduce((a, b) => (freeCap(a) >= freeCap(b) ? a : b));
  const small = stocks.reduce((a, b) => (freeCap(a) <= freeCap(b) ? a : b));
  const cBig = counts.get(big.code) || 0;
  const cSmall = counts.get(small.code) || 0;
  check('大票笔数 > 小票笔数', cBig > cSmall,
    `${big.code} ${cBig} 笔 vs ${small.code} ${cSmall} 笔（流通 ${(freeCap(big) / 1e8).toFixed(0)}亿 vs ${(freeCap(small) / 1e8).toFixed(0)}亿）`);
  check('总笔数还在正常范围', rows.length > 4000 && rows.length < 20000, String(rows.length));

  // 关键性质：**笔数 ∝ 流通市值**（同一档金额分布 → 成交额/流通市值 ≈ 常数 → 推动力接近）
  const densBig = cBig / freeCap(big);
  const densSmall = cSmall / freeCap(small);
  const densRatio = densBig / densSmall;
  check('大票小票「笔数/流通市值」接近（差 < 1.8 倍，纯理论比见第 1 节）',
    densRatio < 1.8 && densRatio > 1 / 1.8,
    `${densBig.toExponential(2)} vs ${densSmall.toExponential(2)}（${densRatio.toFixed(2)}×）`);

  // 单笔金额还是走同一套三档（小票笔数少，均值本身波动大，这里只查档位都没丢）
  const tiers = new Set(rows.map((r) => r.tier));
  check('三档金额都还在用', tiers.has('small') && tiers.has('mid'), [...tiers].join(','));

  // 老的机制一点没动
  check('还是 isMarket 标记 + 三档 tier',
    rows.every((r) => r.isMarket === true && ['small', 'mid', 'big'].includes(r.tier)));
  check('还是写了成交额到 st.mflow（能推动股价）',
    Object.values(db.stocks).some((s) => Math.abs(Number(s.mflow) || 0) > 0));

  // 关掉总开关就不生成
  const off = calmDb({ marketTradesEnabled: 0 });
  check('总开关关掉 → 不生成', genMarketTrades(off, 2).length === 0);
  const zero = calmDb({ marketTradesRate: 0 });
  check('倍率 0 → 不生成', genMarketTrades(zero, 2).length === 0);
}

// ================================================================ 5
log('');
log('=== 5 情绪极端时成交额真的变多（会推动价格）===');
{
  const measure = (v) => {
    const db = calmDb();
    db.config.marketTradesChase = 0;
    db.config.marketTradesPanic = 0;
    for (const s of Object.values(db.stocks)) s.sentiment = { v };
    const rows = [];
    for (let i = 0; i < 40; i++) rows.push(...genMarketTrades(db, 2));
    return rows.reduce((a, r) => a + r.qty * r.price, 0);
  };
  const flat = measure(0);
  const hot = measure(1);
  check('|情绪|=1 时总成交额更大（放量生效）', hot > flat * 1.2,
    `${(flat / 1e4).toFixed(0)}万 → ${(hot / 1e4).toFixed(0)}万`);
}

console.log = realLog;
console.log(out.join('\n'));
console.log('');
console.log(fails ? `---- ${passes} 通过 / ${fails} 失败 ----` : `---- ${passes} 通过 / 0 失败 ----`);
process.exit(fails ? 1 : 0);
