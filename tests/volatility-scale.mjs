// 全市场波动总开关 volatilityScale：一个倍率同时缩放所有「随机波动」来源
//   node tests/volatility-scale.mjs
//
// 口径（src/engine.js#stepStock）：
//   total = 基础噪声 σ + 新闻冲击 + 散户情绪 + 玩家资金冲击 + 市场资金冲击
//   volatilityScale=0.5 → 这些全部减半；财报当日冲击（runReports）也乘它
// 不动：基本面（财报/fair）、均值回归、固定事件（整点拉升/疯狂星期四/早市冲量/汇率跟随）
import { DEFAULT_CONFIG, volatilityScaleOf } from '../src/config.js';
import { createDb, migrate } from '../src/store.js';
import { stepMarket, runReports } from '../src/engine.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
const near = (a, b, eps = 1e-9) => Math.abs(Number(a) - Number(b)) < eps;
const quiet = (fn) => {
  const real = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = real; }
};
const std = (arr) => {
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
};

/** 造一个接近「纯随机游走」的市场：关掉所有无关噪声源，只留下被测通道 */
function mkDb(extra = {}) {
  const db = quiet(() => migrate(createDb()));
  Object.assign(db.config, {
    baseVolatility: 0,
    meanReversion: 0,
    eventChance: 0,
    sentimentEnabled: 0,
    marketTradesEnabled: 0,
    hotMoneyEnabled: 0,
    playerImpactEnabled: 0,
    marketImpactEnabled: 0,
    majorNewsEnabled: 0,
    morningRallyEnabled: 0,
    marketCycleEnabled: 0,
    volatilityScale: 1
  }, extra);
  db.events = [];
  for (const s of Object.values(db.stocks)) {
    s.nextReportTick = 1e12;
    s.rallyHours = [];
  }
  return db;
}

/** 跑 n 轮，返回 TGW 每轮的对数收益 */
function runTicks(db, n) {
  const st = db.stocks.TGW;
  const rets = [];
  let prev = st.price;
  quiet(() => {
    for (let i = 0; i < n; i++) {
      stepMarket(db);
      rets.push(Math.log(st.price / prev));
      prev = st.price;
    }
  });
  return rets;
}

// ---------------------------------------------------------------- 1
log('=== 1 配置与夹取口径 ===');
{
  check('DEFAULT_CONFIG 有 volatilityScale', 'volatilityScale' in DEFAULT_CONFIG,
    String(DEFAULT_CONFIG.volatilityScale));
  check('默认值 = 1（标准波动）', DEFAULT_CONFIG.volatilityScale === 1, String(DEFAULT_CONFIG.volatilityScale));
  check('缺省 → 1', volatilityScaleOf({}) === 1);
  check('脏值（NaN）→ 1', volatilityScaleOf({ volatilityScale: NaN }) === 1);
  check('0.5 原样保留', volatilityScaleOf({ volatilityScale: 0.5 }) === 0.5, String(volatilityScaleOf({ volatilityScale: 0.5 })));
  check('0 → 夹到 0.01（近似静音）', volatilityScaleOf({ volatilityScale: 0 }) === 0.01);
  check('负数 → 夹到 0.01', volatilityScaleOf({ volatilityScale: -3 }) === 0.01);
  check('99 → 夹到 3', volatilityScaleOf({ volatilityScale: 99 }) === 3);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 基础噪声：scale=0.5 时逐轮波动应约为一半 ===');
{
  const N = 9000;
  const db1 = mkDb({ baseVolatility: 0.005, volatilityScale: 1 });
  const db05 = mkDb({ baseVolatility: 0.005, volatilityScale: 0.5 });
  const s1 = std(runTicks(db1, N));
  const s05 = std(runTicks(db05, N));
  const ratio = s05 / s1;
  check('波动率减半', near(ratio, 0.5, 0.06), `std ${s1.toExponential(3)} → ${s05.toExponential(3)}，ratio=${ratio.toFixed(3)}`);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 新闻冲击：scale=0.5 时累计冲击应约减半 ===');
{
  const mkNews = (scale) => {
    const db = mkDb({ volatilityScale: scale });
    db.events = [{
      id: 'ev_test', kind: 'good', companies: ['TGW'], trend: 0.01,
      dir: 1, duration: 1e9, remaining: 1e9, leakTicks: 0, leakLeft: 0,
      announced: true, createdAt: Date.now(), createdTick: db.tick
    }];
    return db;
  };
  const a = mkNews(1);
  const b = mkNews(0.5);
  const pa = a.stocks.TGW.price;
  const pb = b.stocks.TGW.price;
  quiet(() => { for (let i = 0; i < 120; i++) { stepMarket(a); stepMarket(b); } });
  const ra = Math.log(a.stocks.TGW.price / pa);
  const rb = Math.log(b.stocks.TGW.price / pb);
  check('新闻推动累计收益比 ≈ 2:1', near(rb / ra, 0.5, 0.03),
    `+${(ra * 100).toFixed(2)}% vs +${(rb * 100).toFixed(2)}%`);
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 散户情绪：scale=0.5 时 swing 波动应约减半 ===');
{
  const N = 4800;
  const mkSent = (scale) => mkDb({
    sentimentEnabled: 1, sentimentStrength: 0.004, sentimentDrift: 0.6,
    sentimentTicks: 12, sentimentEdge: 0, volatilityScale: scale
  });
  const s1 = std(runTicks(mkSent(1), N));
  const s05 = std(runTicks(mkSent(0.5), N));
  const ratio = s05 / s1;
  check('情绪波动约减半', near(ratio, 0.5, 0.15), `std ${s1.toExponential(3)} → ${s05.toExponential(3)}，ratio=${ratio.toFixed(3)}`);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 玩家资金冲击 / 市场资金冲击：同样吃总开关 ===');
{
  const runFlow = (scale, field, extra) => {
    const db = mkDb({ volatilityScale: scale, ...extra });
    const st = db.stocks.TGW;
    const before = st.price;
    quiet(() => {
      for (let i = 0; i < 20; i++) {
        st[field] = 1;          // 每轮补满压力，保证对比的冲击一致
        if (field === 'flow') st.flowFresh = true;
        stepMarket(db);
      }
    });
    return Math.log(st.price / before);
  };
  const pa = runFlow(1, 'flow', { playerImpactEnabled: 1, playerImpactStrength: 0.0009 });
  const pb = runFlow(0.5, 'flow', { playerImpactEnabled: 1, playerImpactStrength: 0.0009 });
  check('玩家冲击累计 ≈ 减半', near(pb / pa, 0.5, 0.02), `+${(pa * 100).toFixed(3)}% vs +${(pb * 100).toFixed(3)}%`);
  const ma = runFlow(1, 'mflow', { marketImpactEnabled: 1, marketImpactStrength: 0.002 });
  const mb = runFlow(0.5, 'mflow', { marketImpactEnabled: 1, marketImpactStrength: 0.002 });
  check('市场资金冲击累计 ≈ 减半', near(mb / ma, 0.5, 0.02), `+${(ma * 100).toFixed(3)}% vs +${(mb * 100).toFixed(3)}%`);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 财报当日冲击：±6% 封顶也跟着缩 ===');
{
  const shockOf = (scale) => {
    const db = quiet(() => migrate(createDb()));
    Object.assign(db.config, { dividendRate: 0, volatilityScale: scale });
    db.tick = 1000;
    for (const s of Object.values(db.stocks)) s.nextReportTick = 1e12;
    const st = db.stocks.TGW;
    st.nextReportTick = 1000;
    st.pendingReport = {
      period: 2, revenue: 1e10, baseRevenue: 1e10, netProfit: 2e9, tradePnl: 0,
      eps: 2, bps: 20, roe: 0.1, margin: 0.2, growth: 0.2, debt: 0.3,
      dividendRate: 0, reportAt: Date.now(), bias: 0, expectedGrowth: 0
    };
    const before = st.price;
    quiet(() => runReports(db));
    return st.price / before - 1;
  };
  check('标准：超预期 +20% → 冲击 +6%（封顶）', near(shockOf(1), 0.06, 1e-6), (shockOf(1) * 100).toFixed(2) + '%');
  check('scale=0.5 → 冲击 3%', near(shockOf(0.5), 0.03, 1e-6), (shockOf(0.5) * 100).toFixed(2) + '%');
  check('scale=2 → 冲击 12%（封顶按基础 6% 再乘倍率）', near(shockOf(2), 0.12, 1e-6), (shockOf(2) * 100).toFixed(2) + '%');
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
