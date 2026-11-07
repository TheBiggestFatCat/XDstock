// 新财报模型：零期望随机偏移 + 体量越大偏移越小
//   node tests/report-expectation.mjs
//
// 规则：
//   - 每期财报 = 上一期营收 × (1 + 偏移)，偏移在**对数空间取零均值**
//     （中位数原地踏步，不会整体慢慢缩水）
//   - 偏移的标准差由体量决定：σ = reportVol × √(基准体量 / 当前市值)，
//     夹在 [reportVolMin, reportVolMax] 之间 → 体量越大越稳
//   - 纯随机路径的「市场预期」= 0，所以意外 = 实际偏移
//   - 特质驱动的票（稳步增长 / 市值目标 / 金价 / 天气）仍然走各自的确定性路径

import { genNextReport, reportVolFor, INDUSTRY } from '../src/fundamentals.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

const realRandom = Math.random;
function fixRandom(v) { Math.random = () => v; }

function mkStock({ multiple = 1, growth = 0.05, trait = 'reversal', shares = 1e9, price = 100, extra = {} } = {}) {
  const baseRev = 1e9;
  return {
    code: 'TST', name: '测试股', industry: '科技',
    shares, freeFloat: 0.45,
    trait: { id: trait, name: trait, swing: 0.5, steadyGrowth: 0.035 },
    fundamentals: {
      period: 10,
      revenue: baseRev * multiple,
      baseRevenue: baseRev,
      netProfit: baseRev * multiple * 0.2,
      eps: 1, bps: 5, roe: 0.2, margin: 0.2,
      growth, debt: 0.4, dividendRate: 0.2,
      reportAt: Date.now(), expectedGrowth: 0.02
    },
    price,
    fair: price,
    ...extra
  };
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};
/** 用固定的随机数把高斯值钉死：0.25 → z=0；0.5 → z<0；1e-4/0.999 交替 → z 很大且为正 */
function withFixedRandom(fn, mode) {
  const orig = Math.random;
  try {
    if (mode === 'zero') { Math.random = () => 0.25; }        // cos(π/2)=0
    else if (mode === 'neg') { Math.random = () => 0.5; }     // cos(π)=−1
    else if (mode === 'pos') {
      let k = 0;
      Math.random = () => (k++ % 2 === 0 ? 1e-4 : 0.999);
    } else if (typeof mode === 'function') { Math.random = mode; }
    return fn();
  } finally {
    Math.random = orig;
  }
}

// ---------------------------------------------------------------- 1
log('=== 1 偏移量随体量缩小（平方根缩放）===');
{
  const cfg = { reportVol: 0.05, reportRefCap: 1e11, reportVolMin: 0.01, reportVolMax: 0.1 };
  const at = (cap) => reportVolFor(cap, cfg);
  check('基准体量 1000 亿 → 5%', Math.abs(at(1e11) - 0.05) < 1e-9, (at(1e11) * 100).toFixed(2) + '%');
  check('体量 4 倍 → 偏移减半', Math.abs(at(4e11) - 0.025) < 1e-9, (at(4e11) * 100).toFixed(2) + '%');
  check('体量 1/4 → 偏移翻倍', Math.abs(at(2.5e10) - 0.1) < 1e-9, (at(2.5e10) * 100).toFixed(2) + '%');
  check('巨无霸到下限', Math.abs(at(1e14) - 0.01) < 1e-9, (at(1e14) * 100).toFixed(2) + '%');
  check('小公司到上限', Math.abs(at(1e8) - 0.1) < 1e-9, (at(1e8) * 100).toFixed(2) + '%');
  check('单调不增', [1e9, 1e10, 5e10, 1e11, 1e12, 1e13].every((c, i, arr) => i === 0 || at(c) <= at(arr[i - 1]) + 1e-12));
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 期望原地踏步（不涨不跌）===');
{
  const st = mkStock({ multiple: 3, trait: 'reversal' });
  const growths = [];
  const ratios = [];
  for (let i = 0; i < 3000; i++) {
    const r = genNextReport(st, { growthCeiling: 8 });
    growths.push(Number(r.growth));
    ratios.push(Number(r.revenue) / (1e9 * 3));
  }
  // ⚠️ 对数空间零均值 ≠ 算术均值零：E[e^X − 1] = e^(σ²/2) − 1 ≈ +0.13%（σ=5% 的凸性项），
  // 再叠加 3000 次采样的标准误（≈0.07%），所以上限放到 0.6% —— 以前卡 0.4% 会偶发失败
  check('3000 期平均增速 ≈ 0（含对数正态的 +0.13% 凸性项）', Math.abs(mean(growths)) < 0.006,
    (mean(growths) * 100).toFixed(3) + '%');
  check('中位数营收倍数 ≈ 1（不整体缩水）', Math.abs(ratios.sort((a, b) => a - b)[1500] - 1) < 0.03);
  check('正负各一半', Math.abs(growths.filter((g) => g > 0).length / growths.length - 0.5) < 0.03,
    `${((growths.filter((g) => g > 0).length / growths.length) * 100).toFixed(1)}%`);
  check('偏移是零均值 -> 预期也是 0',
    growths.every((g, i) => Number(genNextReport(st, {}).expectedGrowth) === 0));
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 实际波动幅度和 reportVolFor 对得上 ===');
{
  const big = mkStock({ trait: 'reversal', shares: 4e10, price: 100 });   // 4 万亿？
  const small = mkStock({ trait: 'reversal', shares: 2e8, price: 100 });
  const cfg = { growthCeiling: 8, reportVol: 0.05, reportRefCap: 1e11, reportVolMin: 0.01, reportVolMax: 0.1 };
  const sample = (st) => Array.from({ length: 2000 }, () => Number(genNextReport(st, cfg).growth));
  const sBig = sd(sample(big));
  const sSmall = sd(sample(small));
  const vBig = reportVolFor(big.fair * big.shares, { reportVol: 0.05, reportRefCap: 1e11, reportVolMin: 0.01, reportVolMax: 0.1 });
  const vSmall = reportVolFor(small.fair * small.shares, { reportVol: 0.05, reportRefCap: 1e11, reportVolMin: 0.01, reportVolMax: 0.1 });
  check('大公司的偏移接近理论值', Math.abs(sBig - vBig) < 0.01, `${(sBig * 100).toFixed(2)}% vs ${(vBig * 100).toFixed(2)}%`);
  check('小公司的偏移接近上限', Math.abs(sSmall - 0.1) < 0.02, (sSmall * 100).toFixed(2) + '%');
  check('小公司抖动明显更大', sSmall > sBig * 2, `${(sBig * 100).toFixed(2)}% vs ${(sSmall * 100).toFixed(2)}%`);
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 纯随机路径：预期 0，意外 = 实际偏移 ===');
{
  const st = mkStock({ trait: 'reversal' });
  const rep = withFixedRandom(() => genNextReport(st, {}), 'pos');
  check('预期为 0', rep.expectedGrowth === 0, String(rep.expectedGrowth));
  check('正向偏移 → 意外为正', rep.growth > 0.2, (rep.growth * 100).toFixed(1) + '%');
  const rep2 = withFixedRandom(() => genNextReport(st, {}), 'neg');
  check('负向偏移 → 意外为负', rep2.growth < -0.03, (rep2.growth * 100).toFixed(2) + '%');
  check('零偏移 → 增长 0', Math.abs(withFixedRandom(() => genNextReport(st, {}), 'zero').growth) < 1e-9);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 特质驱动的票仍然走自己的路径（不被随机偏移打乱）===');
{
  // 稳步增长（麦当劳）：永远是正的小幅增长
  const steady = mkStock({ trait: 'steady', extra: { capCeiling: 1e12 } });
  const steadyG = Array.from({ length: 200 }, () => Number(genNextReport(steady, { growthCeiling: 8 }).growth));
  check('稳步增长型平均明显为正', mean(steadyG) > 0.005, (mean(steadyG) * 100).toFixed(2) + '%');
  check('稳步增长型几乎不抖', sd(steadyG) < 0.01, (sd(steadyG) * 100).toFixed(3) + '%');

  // 市值目标（弦卷）：往目标收
  const tgt = mkStock({ trait: 'backstop', extra: { capTarget: 5e11, capTargetRate: 0.06 } });
  const tgtG = Array.from({ length: 100 }, () => Number(genNextReport(tgt, { growthCeiling: 8 }).growth));
  check('有市值目标的票增长是「朝目标收」', tgtG.every((g) => g > 0.05 || g < -0.5), String(tgtG.length));
  check('市值目标的预期不是 0（可预期）', Number(genNextReport(tgt, {}).expectedGrowth) !== 0);

  // 天气：由天气决定
  const weather = mkStock({ trait: 'weather' });
  const wSun = Number(withFixedRandom(() => genNextReport(weather, { weather: 1, growthCeiling: 8 }), 'zero').growth);
  const wRain = Number(withFixedRandom(() => genNextReport(weather, { weather: -1, growthCeiling: 8 }), 'zero').growth);
  check('天气好 → 正增长', wSun > 0.1, (wSun * 100).toFixed(1) + '%');
  check('天气差 → 负增长', wRain < -0.1, (wRain * 100).toFixed(1) + '%');
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 安全网：地板与天花板还在 ===');
{
  const low = mkStock({ multiple: 0.3, trait: 'reversal' });
  const high = mkStock({ multiple: 7.9, trait: 'reversal' });
  const lowRep = withFixedRandom(() => genNextReport(low, { growthCeiling: 8 }), 'neg');
  const highRep = withFixedRandom(() => genNextReport(high, { growthCeiling: 8 }), 'pos');
  check('跌破基准 25% 就被托住', lowRep.revenue >= 1e9 * 0.25 - 1,
    (lowRep.revenue / 1e8).toFixed(1) + ' 亿（地板 2.5 亿）');
  check('顶到天花板就不许再上', highRep.revenue <= 1e9 * 8 + 1,
    (highRep.revenue / 1e8).toFixed(1) + ' 亿（上限 80 亿）');
  check('被夹住时不制造假超预期', Math.abs(highRep.growth - (highRep.revenue / (1e9 * 7.9) - 1)) < 1e-9);
}

// ---------------------------------------------------------------- 7
log('');
log('=== 7 财报其余字段仍然自洽 ===');
{
  const st = mkStock({ multiple: 2, trait: 'reversal' });
  const rep = genNextReport(st, { growthCeiling: 8 });
  check('营收 = 上期 × (1+偏移)', Math.abs(rep.revenue - 1e9 * 2 * (1 + rep.growth)) < 1e6,
    `${(rep.revenue / 1e8).toFixed(2)} 亿`);
  check('EPS = 净利 / 股本', Math.abs(rep.eps - rep.netProfit / st.shares) < 1e-9);
  check('净利 = 营收 × 净利率', Math.abs(rep.netProfit - rep.revenue * rep.margin) < 1e3);
  check('净资产是正的', rep.bps > 0);
  check('财报期号 +1', rep.period === 11, String(rep.period));
  check('行业成长中枢仍然可查', Number.isFinite((INDUSTRY.科技.growth[0] + INDUSTRY.科技.growth[1]) / 2));
}

Math.random = realRandom;
console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
