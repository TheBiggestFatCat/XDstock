// 成长天花板 + 估值上限（给每家公司一条「无限接近但不超过」的线）
//
//   node tests/growth-ceiling.mjs

import { createDb, migrate } from '../src/store.js';
import { genNextReport, fairFromReport } from '../src/fundamentals.js';
import { stepMarket, liveIndexWeights, rebalanceIndex } from '../src/engine.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

function seeded(code, { revenue = 100e8, baseRevenue = 100e8, eps = 20, margin = 0.2, growth = 0.3, bias = 0.16 } = {}) {
  const db = createDb();
  const st = db.stocks[code];
  const shares = Number(st.shares) || 1;
  st.price = 100;
  st.fair = fairFromReport(st);
  st.fundamentals = {
    period: 1, revenue, baseRevenue, netProfit: eps * shares, tradePnl: 0,
    eps, bps: 400, roe: 0.05, margin, growth,
    debt: 0.4, dividendRate: 0.35, reportAt: Date.now(), bias, expectedGrowth: growth
  };
  st.fair = fairFromReport(st);
  return { db, st, shares };
}

// ---------------------------------------------------------------- 1
log('=== 1 营收天花板：最高只能长到 base × growthCeiling，永远不超过 ===');
{
  const { st } = seeded('MAMA', { revenue: 100e8, baseRevenue: 100e8, growth: 0.3, bias: 0.16 });
  const ceil = 100e8 * 8;
  let maxRev = 0;
  const realLog = console.log;
  console.log = () => {};
  try {
    for (let i = 0; i < 800; i++) {
      st.fundamentals = genNextReport(st, { growthCeiling: 8 });
      if (st.fundamentals.revenue > maxRev) maxRev = st.fundamentals.revenue;
    }
  } finally {
    console.log = realLog;
  }
  check('800 期内营收从未超过 8 倍基准', maxRev <= ceil + 1, `最高 ${(maxRev / 1e8).toFixed(1)} 亿（上限 ${(ceil / 1e8).toFixed(0)} 亿）`);
  check('营收确实长到了天花板附近', maxRev > ceil * 0.8, `最高 ${(maxRev / 1e8).toFixed(1)} 亿`);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 越接近天花板，正向增速被压得越低 ===');
{
  const near = seeded('MAMA', { revenue: 780e8, baseRevenue: 100e8 });   // 7.8× / 8×，只剩 2.5% 空间
  const far = seeded('MAMA', { revenue: 200e8, baseRevenue: 100e8 });    // 2× / 8×，还有 75% 空间
  const realLog = console.log;
  console.log = () => {};
  let nearG;
  let farG;
  try {
    const a = seeded('MAMA', { revenue: 780e8, baseRevenue: 100e8, growth: 0.2, bias: 0.16 });
    a.st.fundamentals = genNextReport(a.st, { growthCeiling: 8 });
    nearG = a.st.fundamentals.growth;
    const b = seeded('MAMA', { revenue: 200e8, baseRevenue: 100e8, growth: 0.2, bias: 0.16 });
    b.st.fundamentals = genNextReport(b.st, { growthCeiling: 8 });
    farG = b.st.fundamentals.growth;
  } finally {
    console.log = realLog;
  }
  check('贴近天花板的公司增速明显更低', nearG < farG * 0.2,
    `7.8× 增速 ${(nearG * 100).toFixed(2)}% vs 2× 增速 ${(farG * 100).toFixed(2)}%`);
  void near;
  void far;
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 负增长不受天花板影响（该萎缩照样萎缩）===');
{
  // 贴着天花板（8×），连跑多次取平均，把噪声平均掉看确定性部分
  const runs = [];
  for (let i = 0; i < 60; i++) {
    const s = seeded('MAMA', { revenue: 800e8, baseRevenue: 100e8, growth: -0.3, bias: -0.16 });
    runs.push(genNextReport(s.st, { growthCeiling: 8 }));
  }
  const avgG = runs.reduce((a, r) => a + r.growth, 0) / runs.length;
  const avgRev = runs.reduce((a, r) => a + r.revenue, 0) / runs.length;
  check('贴顶的公司负增长仍然成立', avgG < -0.005, `60 期平均增速 ${(avgG * 100).toFixed(2)}%`);
  check('营收整体在往下走（平均低于天花板）', avgRev < 800e8 - 1e8,
    `平均营收 ${(avgRev / 1e8).toFixed(1)} 亿（上限 800）`);
  check('单期可能正好顶在天花板上，但不会超', runs.every((r) => r.revenue <= 800e8 + 1));
  check('也没被地板（0.25×）误伤', runs.every((r) => r.revenue >= 100e8 * 0.25 - 1));
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 估值上限：股价不会超过 fair × maxPremium ===');
{
  const db = createDb();
  Object.assign(db.config, {
    baseVolatility: 0.02, meanReversion: 0, eventChance: 0, localEventChance: 0,
    marketTradesRate: 0, playerImpactEnabled: 0, sentimentEnabled: 0, maxPremium: 2.5
  });
  const st = db.stocks.MAMA;
  st.fair = 500;
  st.price = 1400;           // 2.8× fair，已经越线
  st.nextReportTick = 1e12;
  const realLog = console.log;
  console.log = () => {};
  let worst = 0;
  try {
    for (let i = 0; i < 200; i++) {
      stepMarket(db);
      const prem = st.price / st.fair;
      if (prem > worst) worst = prem;
    }
  } finally {
    console.log = realLog;
  }
  check('200 轮里最高溢价不超过 2.5 倍', worst <= 2.5 + 1e-6, `最高 ${worst.toFixed(4)}×`);
  check('价格被压回线内', st.price <= st.fair * 2.5 + 1e-6,
    `现价 ${st.price.toFixed(1)} vs 上限 ${(st.fair * 2.5).toFixed(1)}`);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 线内的股票完全不受影响 ===');
{
  const db = createDb();
  Object.assign(db.config, {
    baseVolatility: 0.01, meanReversion: 0.0004, eventChance: 0, localEventChance: 0,
    marketTradesRate: 0, playerImpactEnabled: 0, sentimentEnabled: 0, maxPremium: 2.5
  });
  const st = db.stocks.TGW;
  st.fair = 500;
  st.price = 400;             // 0.8×，远在线内
  st.nextReportTick = 1e12;
  const realLog = console.log;
  console.log = () => {};
  let maxPrem = 0;
  try {
    for (let i = 0; i < 300; i++) {
      stepMarket(db);
      const prem = st.price / st.fair;
      if (prem > maxPrem) maxPrem = prem;
    }
  } finally {
    console.log = realLog;
  }
  check('线内股票自由波动（没被压平）', maxPrem > 0.81 && st.price !== 400,
    `跑了 300 轮，最高溢价 ${maxPrem.toFixed(3)}×`);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 指数实时权重：跟总市值成比例，加起来是 1 ===');
{
  const db = migrate({});
  const liveStocks = Object.values(db.stocks).filter((s) => !s.isIndex);
  rebalanceIndex(db, liveStocks, 2160);          // 先造一次权重
  const live = liveIndexWeights(db, 'index');
  const codes = Object.keys(db.index.weights || {});
  const sum = Object.values(live).reduce((a, b) => a + b, 0);
  check('权重合计为 1', Math.abs(sum - 1) < 1e-9, sum.toFixed(9));
  check('和成分数量一致', Object.keys(live).length === codes.length,
    `${Object.keys(live).length} / ${codes.length}`);
  // 手工核对一只票
  const code = codes[0];
  const st = db.stocks[code];
  const cap = st.price * st.shares * (st.freeFloat || 0.45);
  let total = 0;
  for (const c of codes) {
    const s2 = db.stocks[c];
    total += s2.price * s2.shares * (s2.freeFloat || 0.45);
  }
  check('单只票权重 = 流通市值 / 总流通市值', Math.abs(live[code] - cap / total) < 1e-12,
    `${code} ${(live[code] * 100).toFixed(2)}%`);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
