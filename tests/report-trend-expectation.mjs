// 市场预期 = 最近 5 期财报的走势拟合（2026-11 改）
//   node tests/report-trend-expectation.mjs
//
// 规则：拿 `st.reportHistory` 最后 5 期的**营收**（对数空间）做一元线性回归，
// 拟合线往下一格涨多少，就是「市场预期」。有效样本 < 3 期才回退到模型口径。

import { expectedGrowthFromHistory, genNextReport, EXPECT_LOOKBACK } from '../src/fundamentals.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
const pct = (x) => (x * 100).toFixed(3) + '%';
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const mkHist = (revs) => revs.map((r, i) => ({ period: i + 1, revenue: r }));
const geo = (start, g, n) => Array.from({ length: n }, (_, i) => start * (1 + g) ** i);

function mkStock(history = []) {
  return {
    code: 'TST', name: '测试股', industry: '科技', shares: 1e9, freeFloat: 0.45,
    trait: { id: 'reversal', name: '反转' },
    reportHistory: history,
    fundamentals: {
      period: history.length + 1,
      revenue: history.length ? history[history.length - 1].revenue : 100,
      baseRevenue: 100, netProfit: 20, eps: 1, bps: 5, roe: 0.2, margin: 0.2,
      growth: 0.03, debt: 0.4, dividendRate: 0.2, reportAt: Date.now(), expectedGrowth: 0
    },
    price: 100, fair: 100
  };
}
function fixRandom(v) {
  const orig = Math.random;
  Math.random = () => v;
  return () => { Math.random = orig; };
}

// ================================================================ 1
log('=== 1 拟合函数：走势是什么样，预期就是什么样 ===');
{
  check('看最近 5 期', EXPECT_LOOKBACK === 5, String(EXPECT_LOOKBACK));
  check('等比 +2%/期 → 预期 +2%',
    near(expectedGrowthFromHistory(mkHist(geo(100, 0.02, 5))).growth, 0.02, 1e-9),
    pct(expectedGrowthFromHistory(mkHist(geo(100, 0.02, 5))).growth));
  check('等比 −2%/期 → 预期 −2%',
    near(expectedGrowthFromHistory(mkHist([100, 98, 96.04, 94.1192, 92.236816])).growth, -0.02, 1e-9),
    pct(expectedGrowthFromHistory(mkHist([100, 98, 96.04, 94.1192, 92.236816])).growth));
  check('持平 → 预期 0',
    near(expectedGrowthFromHistory(mkHist([100, 100, 100, 100, 100])).growth, 0, 1e-12));
  check('+10%/期的稳步增长 → 预期 10%',
    near(expectedGrowthFromHistory(mkHist(geo(100, 0.1, 5))).growth, 0.1, 1e-9),
    pct(expectedGrowthFromHistory(mkHist(geo(100, 0.1, 5))).growth));
  check('只有 3 期也能拟合（新票刚够）',
    near(expectedGrowthFromHistory(mkHist(geo(100, 0.05, 3))).growth, 0.05, 1e-9));
  check('只有 2 期 → null（交给模型口径）',
    expectedGrowthFromHistory(mkHist([100, 105])) === null);
  check('空历史 → null', expectedGrowthFromHistory([]) === null);
  check('不传也不炸', expectedGrowthFromHistory(undefined) === null);
}

// ================================================================ 2
log('');
log('=== 2 只看最近 5 期：更早的数据一律不影响 ===');
{
  const clean = mkHist(geo(100, 0.02, 5));
  const dirty = mkHist([1, 5, 900, ...geo(100, 0.02, 5)]);
  check('前面插 3 条离谱旧数据，结果不变',
    near(expectedGrowthFromHistory(clean).growth, expectedGrowthFromHistory(dirty).growth, 1e-9));
  check('样本数记的是 5', expectedGrowthFromHistory(dirty).samples === 5,
    String(expectedGrowthFromHistory(dirty).samples));

  // 只保留能被消化的脏数据：非正营收/缺字段跳过
  const messy = mkHist([100, 102, 104.04]).concat([{ period: 9, revenue: 0 }, { period: 10 }]);
  check('非正营收被跳过，仍然按前 3 期拟合',
    near(expectedGrowthFromHistory(messy).growth, 0.02, 1e-9),
    pct(expectedGrowthFromHistory(messy).growth));
}

// ================================================================ 3
log('');
log('=== 3 极端走势被夹住（不许把预期吹到天上）===');
{
  check('疯涨（每期 ×2）→ 上限 90%',
    near(expectedGrowthFromHistory(mkHist([1, 2, 4, 8, 16])).growth, 0.9, 1e-9),
    pct(expectedGrowthFromHistory(mkHist([1, 2, 4, 8, 16])).growth));
  check('崩塌（每期 ÷3）→ 下限 −35%',
    near(expectedGrowthFromHistory(mkHist([81, 27, 9, 3, 1])).growth, -0.35, 1e-9),
    pct(expectedGrowthFromHistory(mkHist([81, 27, 9, 3, 1])).growth));
}

// ================================================================ 4
log('');
log('=== 4 接进 genNextReport：预期 = 走势，意外 = 实际 − 走势 ===');
{
  const hist = mkHist(geo(100, 0.04, 5));      // 前 5 期每期 +4%
  const st = mkStock(hist);
  const unfix = fixRandom(0.25);              // 高斯 = 0（没有随机偏移）
  let r;
  try {
    r = genNextReport(st, { growthCeiling: 8, reportVol: 0 });
  } finally { unfix(); }
  check('预期 = 4%（拟合出来的）', near(Number(r.expectedGrowth), 0.04, 0.005),
    pct(Number(r.expectedGrowth)));
  check('没随机到偏移时，实际 = 0，意外 = −4%', near(Number(r.growth), 0, 1e-9),
    pct(Number(r.growth)));

  // 同样的历史 + 不同的随机种子 → 预期完全一样（预期只由历史决定）
  const st2 = mkStock(mkHist(geo(100, 0.04, 5)));
  const unfix2 = fixRandom(0.9);
  let r2;
  try {
    r2 = genNextReport(st2, { growthCeiling: 8, reportVol: 0 });
  } finally { unfix2(); }
  check('预期只由历史决定（换随机数不变）',
    near(Number(r.expectedGrowth), Number(r2.expectedGrowth), 1e-12));
  check('但实际增速会变', Math.abs(Number(r.growth) - Number(r2.growth)) > 1e-6,
    `${pct(Number(r.growth))} vs ${pct(Number(r2.growth))}`);

  // 走势向下 → 预期为负
  const down = mkStock(mkHist([120, 114, 108.3, 102.885, 97.74]));
  const unfix3 = fixRandom(0.25);
  let r3;
  try {
    r3 = genNextReport(down, { growthCeiling: 8, reportVol: 0 });
  } finally { unfix3(); }
  check('下跌走势 → 预期为负', Number(r3.expectedGrowth) < -0.02, pct(Number(r3.expectedGrowth)));
}

// ================================================================ 5
log('');
log('=== 5 历史不够时回退（新上市 / 老存档）===');
{
  const st = mkStock([]);                    // 纯随机票，没有历史
  const unfix = fixRandom(0.25);
  let r;
  try {
    r = genNextReport(st, { growthCeiling: 8, reportVol: 0 });
  } finally { unfix(); }
  check('没有历史时按老口径：纯随机票预期 = 0', r.expectedGrowth === 0, String(r.expectedGrowth));

  // 只有 2 期也回退
  const st2 = mkStock(mkHist([100, 110]));
  const unfix2 = fixRandom(0.25);
  let r2;
  try {
    r2 = genNextReport(st2, { growthCeiling: 8, reportVol: 0 });
  } finally { unfix2(); }
  check('只有 2 期时也回退（预期 0）', r2.expectedGrowth === 0, String(r2.expectedGrowth));
}

// ================================================================ 6
log('');
log('=== 6 稳步增长型：预期能跟上走势，不再每期都「超预期」===');
{
  // 麦当劳式：每期 +0.86%
  const hist = mkHist(geo(2879.6e8, 0.0086, 6).slice(-5));
  const st = mkStock(hist);
  st.trait = { id: 'steady', name: '稳步增长', steadyGrowth: 0.028 };
  // 基准营收要和现价匹配，否则会先被营收天花板/地板夹住（那是另一套逻辑）
  st.fundamentals.baseRevenue = hist[0].revenue;
  st.fundamentals.revenue = hist[hist.length - 1].revenue;
  const expect = Number(expectedGrowthFromHistory(hist).growth);
  check('预期 ≈ 0.86%', Math.abs(expect - 0.0086) < 0.0005, pct(expect));

  const gaps = [];
  const orig = Math.random;
  try {
    for (let i = 0; i < 50; i++) {
      const rep = genNextReport(st, { growthCeiling: 4.5, reportVol: 0.02 });
      gaps.push(Number(rep.growth) - Number(rep.expectedGrowth));
    }
  } finally { Math.random = orig; }
  const big = gaps.filter((g) => Math.abs(g) > 0.02).length;
  check('50 期里只有极少数被判成大超预期/大不及预期', big <= 5, `${big}/50 期 > 2pp`);
}

// ================================================================ 7
log('');
log('=== 7 与「大鳄预览」一致：预览里的预期就是拟合值 ===');
{
  const hist = mkHist(geo(100, 0.03, 5));
  const st = mkStock(hist);
  const unfix = fixRandom(0.6);
  let r;
  try {
    r = genNextReport(st, { growthCeiling: 8, reportVol: 0 });
  } finally { unfix(); }
  check('财报对象里的 expectedGrowth = 拟合值',
    near(Number(r.expectedGrowth), Number(expectedGrowthFromHistory(hist).growth), 1e-12),
    pct(Number(r.expectedGrowth)));
  check('营收仍然 = 上期 × (1+实际)',
    Math.abs(Number(r.revenue) - hist[hist.length - 1].revenue * (1 + Number(r.growth))) < 1e-3);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
