// 指数成交量口径（2026-11）
//   node tests/index-volume.mjs
//
// 要求：
//   1. 指数（DENG / DENGS）上的成交，按成分股权重把**成交量**拆给个股
//      —— 不然指数自己攒了一堆量，玩家点进个股 K 线发现一根柱子都没有
//   2. 个股自己的成交也要反映到指数上：指数成交量 = 成分股本轮成交量之和
//   3. 两边不能重复计算（指数的单已经拆进成分股了，指数只做求和）

import { createDb, migrate } from '../src/store.js';
import { stepMarket, rebalanceIndex } from '../src/engine.js';
import { addVolume, indexTickVolume } from '../src/trading.js';
import { logTrade } from '../src/trading.js';

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
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

function calmDb() {
  const db = migrate(createDb());
  Object.assign(db.config, {
    baseVolatility: 0, meanReversion: 0, eventChance: 0, localEventChance: 0,
    marketTradesEnabled: 0, hotMoneyEnabled: 0, playerImpactEnabled: 0,
    marketImpactEnabled: 0, sentimentEnabled: 0, goldVol: 0, goldRev: 0,
    reportIntervalTicks: 1e9, dividendRate: 0, maxPremium: 1e9,
    morningRallyEnabled: 0, marketCycleEnabled: 0, marketOpen: 1
  });
  db.tick = 1000;
  db.players = {};
  for (const st of Object.values(db.stocks)) {
    st.nextReportTick = 1e12;
    st.status = 'normal';
    st.st = false;
    st.stTicks = 0;
    st.volTick = 0;
    st.volSeries = [];
  }
  return db;
}

const members = (db) => Object.values(db.stocks).filter((s) => !s.isIndex && s.status === 'normal');

// ================================================================ 1
log('=== 1 指数单按权重拆给成分股 ===');
{
  const db = calmDb();
  // 先算出成分权重（真实环境每 3 小时重算一次；DENG 用全部个股）
  rebalanceIndex(db, Object.values(db.stocks).filter((s) => !s.isIndex), 1000);
  for (const s of Object.values(db.stocks)) { s.volTick = 0; s.volSeries = []; }
  const idx = db.stocks.DENG;
  const before = members(db).map((s) => Number(s.volTick) || 0);
  const given = addVolume(db, 'DENG', 10000);
  const after = members(db).map((s) => Number(s.volTick) || 0);
  const total = after.reduce((a, b) => a + b, 0) - before.reduce((a, b) => a + b, 0);
  check('拆出去的成交量之和 = 原成交量', near(total, 10000, 0.01), total.toFixed(2));
  check('返回值 = 实际拆出去的量', near(given, total, 0.01), given.toFixed(2));
  check('指数自己不攒量', !(Number(idx.volTick) > 0), String(idx.volTick || 0));

  // 权重大的分到的多
  const w = db.index.weights || {};
  const sorted = members(db).filter((s) => (w[s.code] || 0) > 0)
    .sort((a, b) => (w[b.code] || 0) - (w[a.code] || 0));
  const big = sorted[0];
  const small = sorted[sorted.length - 1];
  check('权重大的票分到更多', (big.volTick || 0) > (small.volTick || 0),
    `${big.code} ${(big.volTick || 0).toFixed(1)} vs ${small.code} ${(small.volTick || 0).toFixed(1)}`);
  check('比例 ≈ 权重比', (() => {
    const ratio = (big.volTick || 0) / (small.volTick || 1);
    const expect = (w[big.code] || 0) / (w[small.code] || 1);
    return Math.abs(ratio - expect) / Math.max(1e-9, expect) < 0.02;
  })(), `${((big.volTick || 0) / (small.volTick || 1)).toFixed(2)} vs ${((w[big.code] || 0) / (w[small.code] || 1)).toFixed(2)}`);

  // DENGS 用另一张权重表
  const db2 = calmDb();
  rebalanceIndex(db2, Object.values(db2.stocks).filter((s) => !s.isIndex), 1000);
  for (const s of Object.values(db2.stocks)) { s.volTick = 0; s.volSeries = []; }
  addVolume(db2, 'DENGS', 1000);
  const sum2 = members(db2).reduce((a, s) => a + (Number(s.volTick) || 0), 0);
  check('DENGS 也按权重拆（小盘指数）', near(sum2, 1000, 0.01), sum2.toFixed(2));
}

// ================================================================ 2
log('');
log('=== 2 个股成交：记在自己头上，也进指数 ===');
{
  const db = calmDb();
  addVolume(db, 'TGW', 5000);
  check('个股 volTick = 5000', near(db.stocks.TGW.volTick, 5000), String(db.stocks.TGW.volTick));
  check('别的票不受影响', members(db).filter((s) => s.code !== 'TGW').every((s) => !(Number(s.volTick) > 0)));
  const idxVol = indexTickVolume(db, 'index');
  check('指数成交量已包含这 5000 股', near(idxVol, 5000), idxVol.toFixed(2));

  // 停牌的票不算进指数（和指数价格口径一致）
  db.stocks.TGW.status = 'suspended';
  check('停牌票的成交量不进指数', near(indexTickVolume(db, 'index'), 0), indexTickVolume(db, 'index').toFixed(2));
  db.stocks.TGW.status = 'normal';

  // 脏数据
  check('未知代码不炸', addVolume(db, 'NOPE', 100) === 0);
  check('数量 0 / 负数 / 非数字都不记', addVolume(db, 'TGW', 0) === 0 && addVolume(db, 'TGW', -5) === 0 && addVolume(db, 'TGW', 'x') === 0);
  check('null db 不炸', addVolume(null, 'TGW', 10) === 0);
}

// ================================================================ 3
log('');
log('=== 3 一轮跑完：指数成交量 = 成分股之和，不重复 ===');
{
  const db = calmDb();
  addVolume(db, 'TGW', 3000);
  addVolume(db, 'MCD', 2000);
  addVolume(db, 'DENG', 7000);          // 指数单 → 拆给成分股
  stepMarket(db);
  const idxVol = db.stocks.DENG.volSeries.slice(-1)[0];
  const sumMembers = members(db).reduce((a, s) => a + (s.volSeries.slice(-1)[0] || 0), 0);
  check('指数这一轮的成交量 = 成分股之和', near(idxVol, sumMembers, 0.01),
    `${idxVol.toFixed(1)} vs ${sumMembers.toFixed(1)}`);
  check('指数量里包含指数单拆出来的量', idxVol >= 9900 - 0.5, idxVol.toFixed(1));
  check('指数自己没有「额外的」量（不重复）', near(idxVol, 3000 + 2000 + 7000, 0.01), idxVol.toFixed(1));

  // 15 分钟那根也带上了
  const lastBar = db.stocks.DENG.bars15.slice(-1)[0];
  check('指数 15m K 线也有成交量', Array.isArray(lastBar) && Number(lastBar[5]) >= 0, JSON.stringify(lastBar?.slice?.(-1)));
}

// ================================================================ 4
log('');
log('=== 4 玩家/游资流水（logTrade）路径也走拆权重 ===');
{
  const db = calmDb();
  logTrade(db, { code: 'DENG', name: '灯证指数', action: 'open', side: 'long', qty: 4000, price: 2000 });
  const sum = members(db).reduce((a, s) => a + (Number(s.volTick) || 0), 0);
  check('logTrade 打在指数上 → 拆给成分股', near(sum, 4000, 0.01), sum.toFixed(2));
  check('指数自己 volTick 仍是 0', !(Number(db.stocks.DENG.volTick) > 0));

  // XJ 也被上一条指数单分到了一点量，所以这里看「增量」
  const xjBefore = Number(db.stocks.XJ.volTick) || 0;
  logTrade(db, { code: 'XJ', name: '弦卷财团', action: 'open', side: 'long', qty: 888, price: 400 });
  check('普通票的增量就是自己的成交量', near(db.stocks.XJ.volTick - xjBefore, 888), String(db.stocks.XJ.volTick - xjBefore));
  check('总成交量 = 4000 + 888', near(indexTickVolume(db, 'index'), 4888, 0.01), indexTickVolume(db, 'index').toFixed(2));
}

// ================================================================ 5
log('');
log('=== 5 两个指数各自独立 ===');
{
  const db = calmDb();
  // 大指数 = 全部 10 只；小指数 = 流通市值最小的 3 只（线上 DENGS 是 7 只，逻辑一样）
  const all = Object.values(db.stocks).filter((s) => !s.isIndex);
  rebalanceIndex(db, all, 1000);
  const cap = (s) => s.price * s.shares * (s.freeFloat || 0.45);
  const smallest = all.slice().sort((a, b) => cap(a) - cap(b)).slice(0, 3);
  db.smallIndex = db.smallIndex || {};
  db.smallIndex.weights = Object.fromEntries(smallest.map((s) => [s.code, 1 / smallest.length]));
  for (const s of Object.values(db.stocks)) { s.volTick = 0; s.volSeries = []; }

  addVolume(db, 'TGW', 1000);
  const big = indexTickVolume(db, 'index');
  const small = indexTickVolume(db, 'smallIndex');
  check('大指数包含全部正常成分的量', near(big, 1000), big.toFixed(1));
  check('小指数只算自己的成分（不含非成分股）', small < big + 1e-9,
    `小指数 ${small.toFixed(1)} <= 大指数 ${big.toFixed(1)}`);

  // 小指数成分股的成交要计入小指数
  const member = smallest[0];
  const v0 = indexTickVolume(db, 'smallIndex');
  addVolume(db, member.code, 500);
  const d = indexTickVolume(db, 'smallIndex') - v0;
  check('小指数成分股的成交会计入小指数', d >= 500 - 1e-9, `+${d.toFixed(1)}`);
}

console.log = realLog;
console.log(out.join('\n'));
console.log('');
console.log(fails ? `---- ${passes} 通过 / ${fails} 失败 ----` : `---- ${passes} 通过 / 0 失败 ----`);
process.exit(fails ? 1 : 0);
