// 天气 / 农业股财报回归
//
//   node tests/weather.mjs
//
// 覆盖曾经的 bug：db.weather 只掷一次就永久冻住，
// 导致 PVZ/HJF 的「市场预期」永远是一个常数、同比永远为负。

import { createDb } from '../src/store.js';
import { rollWeather, genNextReport } from '../src/fundamentals.js';
import { runReports } from '../src/engine.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---------------------------------------------------------------- 1
log('=== 1 rollWeather 本身 ===');
{
  let min = 9, max = -9, sum = 0;
  let pos = 0, neg = 0;
  let labelOk = true;
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const w = rollWeather(0);
    min = Math.min(min, w.score);
    max = Math.max(max, w.score);
    sum += w.score;
    if (w.score > 0) pos++; else neg++;
    const s = w.score;
    const want = s > 0.45 ? '大丰收' : s > 0.12 ? '风调雨顺'
      : s > -0.12 ? '平平无奇' : s > -0.45 ? '略有减产' : '灾害歉收';
    if (w.label !== want) labelOk = false;
  }
  const mean = sum / N;
  check('分数落在 [-1, 1]', min >= -1 && max <= 1, `min=${min.toFixed(3)} max=${max.toFixed(3)}`);
  check('标签与分数档位一致', labelOk);
  check('均值接近 0（好天气坏天气都有）', Math.abs(mean) < 0.06, `mean=${mean.toFixed(3)}`);
  check('正负两种天气都能抽到', pos > N * 0.3 && neg > N * 0.3, `pos=${pos} neg=${neg}`);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 均值回归：好天气不会一直好 ===');
{
  let s1 = 0, s2 = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    s1 += rollWeather(1).score;
    s2 += rollWeather(-1).score;
  }
  const m1 = s1 / N;
  const m2 = s2 / N;
  // 分数被截断在 [-1,1]，所以从 ±1 出发的均值会略微向中间收（≈±0.45）
  check('上期 +1 → 本期均值明显偏正', m1 > 0.35 && m1 < 0.55, `mean=${m1.toFixed(3)}`);
  check('上期 -1 → 本期均值明显偏负', m2 < -0.35 && m2 > -0.55, `mean=${m2.toFixed(3)}`);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 天气股的增速吃规模衰减 ===');
{
  const st = {
    code: 'PVZ', shares: 1e8, industry: '农业种业', price: 20,
    trait: { id: 'weather', swing: 0.5 },
    fundamentals: { revenue: 4e9, baseRevenue: 1e9, eps: 0.2, bps: 5, growth: 0.01, margin: 0.1 }
  };
  const decay = 1 / (1 + (4 - 1) * 1.5);
  const r = genNextReport(st, { weather: -0.5 });
  check('expectedGrowth = 天气 × 摆幅 × 衰减', near(r.expectedGrowth, -0.5 * 0.5 * decay, 1e-6),
    `got=${r.expectedGrowth.toFixed(6)} want=${(-0.5 * 0.5 * decay).toFixed(6)}`);
  check('实际增速 = 预期 ± 8% 噪声', Math.abs(r.growth - r.expectedGrowth) <= 0.0800001,
    `growth=${r.growth.toFixed(4)} expected=${r.expectedGrowth.toFixed(4)}`);

  const st2 = { ...st, fundamentals: { ...st.fundamentals, revenue: 1e9 } };
  const r2 = genNextReport(st2, { weather: -0.5 });
  check('营收回到基准时衰减=1', near(r2.expectedGrowth, -0.25, 1e-6), `got=${r2.expectedGrowth.toFixed(6)}`);
}

// ---------------------------------------------------------------- 4
function makeDb() {
  const db = createDb();
  db.tick = 1000;
  db.config.reportIntervalTicks = 720;
  db.events = [];
  db.notices = [];
  db.volumeAvg = 0;
  db.fx = { rate: 0, prevRate: 0, base: 0, at: 0 };
  for (const c of ['PVZ', 'HJF']) {
    const st = db.stocks[c];
    st.price = 20;
    st.fair = 20;
    st.shares = c === 'PVZ' ? 4e8 : 2.6e8;
    st.freeFloat = 0.5;
    st.fundamentals = {
      period: 5, revenue: 1e9, baseRevenue: 1e9, netProfit: 1e8,
      eps: 0.25, bps: 10, growth: 0.02, margin: 0.1, debt: 0.4, dividendRate: 0.2
    };
    st.reportHistory = [];
    st.nextReportTick = db.tick;
    st.weather = undefined;
    st.weatherTarget = 0;
  }
  db.weather = undefined;
  return db;
}

log('');
log('=== 4 发报时重掷天气，兄弟股共用同一份 ===');
{
  const db = makeDb();
  runReports(db);
  const w1 = db.weather;
  check('首期掷出天气', !!w1 && Number.isFinite(w1.score));
  check('rollTick = 当前 tick', w1.rollTick === 1000, `rollTick=${w1.rollTick}`);
  check('PVZ/HJF 共用同一个天气对象', db.stocks.PVZ.weather === w1 && db.stocks.HJF.weather === w1);
  check('两只票都发了一期财报', db.stocks.PVZ.reportHistory.length === 1 && db.stocks.HJF.reportHistory.length === 1);
  check('天气目标价 = fair ×(1+天气×摆幅)',
    near(db.stocks.PVZ.weatherTarget, db.stocks.PVZ.fair * (1 + w1.score * 0.5), 1e-6),
    `target=${db.stocks.PVZ.weatherTarget.toFixed(3)} fair=${db.stocks.PVZ.fair.toFixed(3)}`);

  // 下一期：必须重掷
  db.tick = 1720;
  db.stocks.PVZ.nextReportTick = 1720;
  db.stocks.HJF.nextReportTick = 1720;
  runReports(db);
  check('下一期换了天气（rollTick 前进）', db.weather.rollTick === 1720, `rollTick=${db.weather.rollTick}`);
  check('两期是两次独立抽样', db.weather !== w1);
  check('兄弟股仍然共用', db.stocks.PVZ.weather === db.weather && db.stocks.HJF.weather === db.weather);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 老存档（没有 rollTick）解冻时归零，不重新赌一把 ===');
{
  const db = makeDb();
  db.weather = { score: -1, label: '灾害歉收' };   // 冻死在 -1 的老存档
  runReports(db);
  check('解冻后天气归零（平平无奇）', db.weather.score === 0 && db.weather.label === '平平无奇',
    JSON.stringify(db.weather));
  check('打上 rollTick（之后才会正常重掷）', db.weather.rollTick === 1000, `rollTick=${db.weather.rollTick}`);
  check('这一期增速只剩噪声', Math.abs(db.stocks.PVZ.fundamentals.expectedGrowth) < 1e-9,
    `expected=${db.stocks.PVZ.fundamentals.expectedGrowth}`);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 回归：连续多期不会再"永远为负" ===');
{
  const db = makeDb();
  const growths = [];
  // 40 期足够把「恰好全负」的概率压到可以忽略（天气是均值回归的随机游走）
  for (let i = 0; i < 40; i++) {
    db.tick += 720;
    db.stocks.PVZ.nextReportTick = db.tick;
    db.stocks.HJF.nextReportTick = db.tick;
    runReports(db);
    growths.push(db.stocks.PVZ.fundamentals.expectedGrowth);
  }
  const pos = growths.filter((g) => g > 0).length;
  check('40 期里出现过正增长（修复前是 0 期）', pos > 0, `正增长 ${pos}/40 期`);
  check('预期不是固定值（每期都在变）', new Set(growths.map((g) => g.toFixed(6))).size > 5,
    `不同取值 ${new Set(growths.map((g) => g.toFixed(6))).size} 个`);
  check('两只票预期同量级（同一天气）',
    Math.abs(db.stocks.PVZ.fundamentals.expectedGrowth - db.stocks.HJF.fundamentals.expectedGrowth) < 0.2,
    `PVZ=${(db.stocks.PVZ.fundamentals.expectedGrowth * 100).toFixed(1)}% HJF=${(db.stocks.HJF.fundamentals.expectedGrowth * 100).toFixed(1)}%`);
  check('财报历史都记下来了', db.stocks.PVZ.reportHistory.length >= 10 && db.stocks.HJF.reportHistory.length >= 10,
    `PVZ=${db.stocks.PVZ.reportHistory.length} HJF=${db.stocks.HJF.reportHistory.length}`);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
