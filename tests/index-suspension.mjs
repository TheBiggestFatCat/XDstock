// 指数 × 成分股停牌：停牌不该让指数少一项（2026-11 修）
//   node tests/index-suspension.mjs
//
// 线上事故：麦当劳停牌那一个 tick，DENG 从 2728 直接掉到 1869（−32%），
// 原因是求和只遍历 status==='normal' 的票，MCD 那 22.9% 的权重直接消失。
// 现在的规则：**停牌仍然是成分股，按最后成交价计**；只有退市才剔除（剔除时强制调仓）。

import { createDb, migrate } from '../src/store.js';
import { stepMarket, rebalanceIndex } from '../src/engine.js';

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
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

/** 一个价格不会自己动的市场：想改价就手动改 */
function calmDb() {
  const db = migrate(createDb());
  Object.assign(db.config, {
    baseVolatility: 0, meanReversion: 0, eventChance: 0, localEventChance: 0,
    marketTradesEnabled: 0, hotMoneyEnabled: 0, playerImpactEnabled: 0,
    sentimentEnabled: 0, goldVol: 0, goldRev: 0, reportIntervalTicks: 1e9,
    dividendRate: 0,
    // 早市冲量是「按服务器本地时间 6~10 点」生效的，跑测试时正好在窗口内
    // LU 会一路顶着涨，把指数带偏 → 和停牌无关，必须关掉
    morningRallyEnabled: 0
  });
  db.tick = 1000;
  db.players = {};
  for (const st of Object.values(db.stocks)) {
    st.nextReportTick = 1e12;
    st.status = 'normal';
    st.st = false;
    st.stTicks = 0;
  }
  return db;
}

const tick = (db) => { stepMarket(db); return db.index.value; };
const mcdWeight = (db) => Number((db.index.weights || {}).MCD) || 0;

// ================================================================ 1
log('=== 1 停牌不会让指数闪崩（复现线上事故）===');
{
  const db = calmDb();
  tick(db);                       // 第一次 tick 建仓权重
  const v0 = db.index.value;
  check('期初权重里有全部 10 只票', Object.keys(db.index.weights).length === 10,
    Object.keys(db.index.weights).join(','));
  const w = mcdWeight(db);
  check('麦当劳权重是个正经数字（10%~30%）', w > 0.1 && w < 0.3, (w * 100).toFixed(1) + '%');

  // 麦当劳先拉 50%，指数按权重涨（这是正常的）
  db.stocks.MCD.price *= 1.5;
  const v1 = tick(db);
  check('麦当劳涨 50% → 指数按权重跟涨', v1 > v0, `${v0.toFixed(1)} → ${v1.toFixed(1)}`);
  const upRatio = v1 / v0 - 1;
  check('跟涨幅度 ≈ 权重 × 50%', near(upRatio, w * 0.5, 0.02),
    `实际 ${(upRatio * 100).toFixed(2)}%，理论 ${(w * 0.5 * 100).toFixed(2)}%`);

  // 停牌！指数必须原地不动
  db.stocks.MCD.status = 'suspended';
  const v2 = tick(db);
  check('停牌后一个 tick 指数不动（不再闪崩）', near(v2, v1, 0.01),
    `${v1.toFixed(2)} → ${v2.toFixed(2)}`);
  check('停牌期间权重表里仍然有麦当劳', mcdWeight(db) > 0, (mcdWeight(db) * 100).toFixed(1) + '%');
  check('DENG 标的价 = 指数点位', near(db.stocks.DENG.price, v2, 0.01),
    `${db.stocks.DENG.price} vs ${v2.toFixed(2)}`);

  // 停牌期间别的票照常影响指数（不是把指数冻住，只是不再少一项）
  db.stocks.TGW.price *= 1.1;
  const v3 = tick(db);
  check('停牌期间其它成分股照常影响指数', v3 > v2 + 0.01, `${v2.toFixed(2)} → ${v3.toFixed(2)}`);

  // 复牌：价格变化当轮就进指数
  db.stocks.MCD.status = 'normal';
  db.stocks.MCD.price *= 1.2;
  const v4 = tick(db);
  check('复牌当轮马上恢复进指数（涨幅立刻体现）', v4 > v3, `${v3.toFixed(2)} → ${v4.toFixed(2)}`);
  // 麦当劳之前涨过 50%（p/base = 1.5），所以这一波 20% 对指数的贡献比纯 w×20% 更大
  check('复牌涨幅与权重同量级', (v4 / v3 - 1) > w * 0.2 * 0.8 && (v4 / v3 - 1) < w * 0.2 * 3,
    `实际 ${((v4 / v3 - 1) * 100).toFixed(2)}%，权重 ${(w * 100).toFixed(1)}%`);
}

// ================================================================ 2
log('');
log('=== 2 停牌很久也不会「自己恢复不了」 ===');
{
  const db = calmDb();
  tick(db);
  const v0 = db.index.value;
  db.stocks.MCD.status = 'suspended';       // 只停牌，价格一动不动
  for (let i = 0; i < 50; i++) tick(db);
  check('停 50 轮指数一点没掉', near(db.index.value, v0, 0.01), `${v0.toFixed(2)} → ${db.index.value.toFixed(2)}`);
  check('50 轮里没被强制调仓（权重还是 10 个）', Object.keys(db.index.weights).length === 10,
    String(Object.keys(db.index.weights).length));
  db.stocks.MCD.status = 'normal';
  const v1 = tick(db);
  check('复牌后仍然接着算（不再掉）', near(v1, v0, 0.01), `${v0.toFixed(2)} → ${v1.toFixed(2)}`);
}

// ================================================================ 3
log('');
log('=== 3 退市才剔除，而且剔除不跳空 ===');
{
  const db = calmDb();
  tick(db);
  const v0 = tick(db);
  db.stocks.MCD.status = 'delisted';
  const v1 = tick(db);
  check('退市后指数不闪崩（靠调仓把权重归一）', near(v1, v0, v0 * 0.02),
    `${v0.toFixed(2)} → ${v1.toFixed(2)}`);
  check('退市后权重表里没有麦当劳了', !('MCD' in db.index.weights), Object.keys(db.index.weights).join(','));
  check('退市后权重合计 = 1', near(
    Object.values(db.index.weights).reduce((a, b) => a + b, 0), 1, 1e-9));
}

// ================================================================ 4
log('');
log('=== 4 小灯指数（DENGS）同样规则 ===');
{
  const db = calmDb();
  tick(db);
  const before = Object.keys(db.smallIndex.weights).sort().join(',');
  const v0 = db.smallIndex.value;
  // 把 DENGS 的成分里挑一只停牌
  const first = Object.keys(db.smallIndex.weights)[0];
  db.stocks[first].status = 'suspended';
  const v1 = tick(db);
  check('DENGS 停牌不闪崩', near(v1, v0, 0.01), `${v0.toFixed(2)} → ${v1.toFixed(2)}`);
  check('DENGS 成分没被换掉', Object.keys(db.smallIndex.weights).sort().join(',') === before,
    Object.keys(db.smallIndex.weights).join(','));
  // 复牌
  db.stocks[first].status = 'normal';
  const v2 = tick(db);
  check('DENGS 复牌后正常参与', Number.isFinite(v2) && v2 > 0, v2.toFixed(2));
}

// ================================================================ 5
log('');
log('=== 5 调仓仍然正常（新票纳入 / 周期到点）===');
{
  const db = calmDb();
  tick(db);
  const period = Number(db.config.indexRebalanceTicks);
  db.tick += period;            // 假装一个季度过去了
  const v0 = db.index.value;
  const v1 = tick(db);
  check('到点会调仓（rebalanceTick 更新）', db.index.rebalanceTick >= db.tick - 1,
    `${db.index.rebalanceTick} vs ${db.tick}`);
  check('调仓当轮指数不跳空', near(v1, v0, v0 * 0.01), `${v0.toFixed(2)} → ${v1.toFixed(2)}`);
  check('调仓后权重仍然合计 1', near(
    Object.values(db.index.weights).reduce((a, b) => a + b, 0), 1, 1e-9));

  // 手动调仓函数仍然可用（tests/growth-ceiling 也在用）
  const live = Object.values(db.stocks).filter((s) => !s.isIndex && s.status !== 'delisted');
  rebalanceIndex(db, live, period);
  check('rebalanceIndex 可手动调用', Object.keys(db.index.weights).length === live.length,
    `${Object.keys(db.index.weights).length} / ${live.length}`);
}

console.log = realLog;
console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
