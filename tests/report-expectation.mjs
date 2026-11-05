// 市场预期要吃「天花板剩余空间」：贴着天花板的票不能每期都白挨一刀
//   node tests/report-expectation.mjs

import { genNextReport, INDUSTRY } from '../src/fundamentals.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

function fixRandom(v) { Math.random = () => v; }
const origRandom = Math.random;

/** 科技行业增速中枢：(−6% + 42%) / 2 = 18% */
const MIDG_TECH = (INDUSTRY.科技.growth[0] + INDUSTRY.科技.growth[1]) / 2;
/** 和 src/fundamentals.js 的 TRAIT_BIAS 保持一致 */
const TRAIT_BIAS = {
  old_money: -0.035, casino: 0.06, hype: 0.025, reversal: 0, meme: -0.05,
  backstop: -0.025, fx: 0, broker: 0
};
const BIAS_REVERT = 0.15;

/** 复刻代码里的 bias：每期向「行业性格」回归 15% */
function biasOf(trait, stored = 0) {
  const base = TRAIT_BIAS[trait] ?? 0;
  return base + (stored - base) * (1 - BIAS_REVERT);
}

/** 手算「预期」：基础增速(+bias) → 规模衰减 → 天花板剩余空间 */
function expectByHand(multiple, growth, { trait = 'hype', ceilMult = 8 } = {}) {
  const base = 0.5 * growth + 0.5 * MIDG_TECH + biasOf(trait);
  const decay = 1 / (1 + Math.max(0, multiple - 1) * 1.5);
  const g = base * decay;
  const room = Math.max(0, 1 - multiple / ceilMult);
  return { base, g, room, expected: g > 0 ? g * room : g };
}

function mkStock({ multiple = 1, growth = 0.05, trait = 'hype', extra = {} } = {}) {
  const baseRev = 1e9;
  return {
    code: 'TST', name: '测试股', industry: '科技',
    shares: 1e9, freeFloat: 0.45,
    trait: { id: trait, name: trait, swing: 0.5, steadyGrowth: 0.035 },
    fundamentals: {
      period: 10,
      revenue: baseRev * multiple,
      baseRevenue: baseRev,
      netProfit: baseRev * multiple * 0.2,
      eps: 1, bps: 5, roe: 0.2, margin: 0.2,
      growth, debt: 0.4, dividendRate: 0.2,
      reportAt: Date.now(), bias: 0, expectedGrowth: 0.02
    },
    ...extra
  };
}

// ---------------------------------------------------------------- 1
log('=== 1 高倍数票（6.3×）：预期要乘剩余空间 ===');
{
  fixRandom(0.5);   // 噪声 = 0
  const rep = genNextReport(mkStock({ multiple: 6.3 }), { growthCeiling: 8 });
  const hand = expectByHand(6.3, 0.05);

  check('剩余空间算对（1 − 6.3/8 = 21.25%）', Math.abs(hand.room - 0.2125) < 1e-6, hand.room.toFixed(4));
  check('预期 = 基础增速 × 剩余空间', Math.abs(rep.expectedGrowth - hand.expected) < 1e-6,
    `${rep.expectedGrowth.toFixed(5)} vs ${hand.expected.toFixed(5)}`);
  check('预期比「不吃空间」的旧值小一半以上', rep.expectedGrowth < hand.g * 0.5,
    `${(rep.expectedGrowth * 100).toFixed(2)}% vs 旧 ${(hand.g * 100).toFixed(2)}%`);
  check('无噪声时实际 ≈ 预期（不再必挨刀）',
    Math.abs(rep.growth - rep.expectedGrowth) < 1e-9,
    `${(rep.growth * 100).toFixed(3)}% / ${(rep.expectedGrowth * 100).toFixed(3)}%`);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 低倍数票（0.7×）：几乎不受影响 ===');
{
  fixRandom(0.5);
  const rep = genNextReport(mkStock({ multiple: 0.7 }), { growthCeiling: 8 });
  const hand = expectByHand(0.7, 0.05);
  check('剩余空间 ≈ 91%', Math.abs(hand.room - 0.9125) < 1e-6, hand.room.toFixed(4));
  check('预期仍按公式来', Math.abs(rep.expectedGrowth - hand.expected) < 1e-6);
  check('预期只被削掉约 1pp', Math.abs(hand.g - hand.expected) < 0.012,
    `${((hand.g - hand.expected) * 100).toFixed(2)}pp`);
  check('实际 ≈ 预期', Math.abs(rep.growth - rep.expectedGrowth) < 1e-9);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 正好贴在天花板上：预期 0、实际 0 ===');
{
  fixRandom(0.5);
  const rep = genNextReport(mkStock({ multiple: 8 }), { growthCeiling: 8 });
  check('预期剩 0', Math.abs(rep.expectedGrowth) < 1e-9, rep.expectedGrowth.toExponential(2));
  check('实际增速也被压到 0', Math.abs(rep.growth) < 1e-9, rep.growth.toExponential(2));
  check('营收不再增长', Math.abs(rep.revenue - 8e9) < 1, (rep.revenue / 1e9).toFixed(4));
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 负增长的票：预期不吃剩余空间（该跌还是跌）===');
{
  fixRandom(0.5);
  const rep = genNextReport(mkStock({ multiple: 1.2, growth: -0.3, trait: 'meme' }), { growthCeiling: 8 });
  const hand = expectByHand(1.2, -0.3, { trait: 'meme' });
  check('手算确实是负的', hand.g < 0, (hand.g * 100).toFixed(2) + '%');
  check('预期是负数', rep.expectedGrowth < 0, (rep.expectedGrowth * 100).toFixed(2) + '%');
  check('负增速不乘剩余空间', Math.abs(rep.expectedGrowth - Math.max(-0.35, hand.g)) < 1e-6,
    `${(rep.expectedGrowth * 100).toFixed(2)}% vs ${(hand.g * 100).toFixed(2)}%`);
  check('实际 ≈ 预期', Math.abs(rep.growth - rep.expectedGrowth) < 1e-9);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 噪声仍然能造出超预期 / 不及预期 ===');
{
  fixRandom(0.99);   // rand(-0.08,0.08) ≈ +0.078
  const up = genNextReport(mkStock({ multiple: 1.5 }), { growthCeiling: 8 });
  check('随机高开 → 实际高于预期 5pp 以上', up.growth - up.expectedGrowth > 0.05,
    ((up.growth - up.expectedGrowth) * 100).toFixed(1) + 'pp');

  fixRandom(0.01);   // ≈ −0.078
  const down = genNextReport(mkStock({ multiple: 1.5 }), { growthCeiling: 8 });
  check('随机低开 → 实际低于预期 5pp 以上', down.growth - down.expectedGrowth < -0.05,
    ((down.growth - down.expectedGrowth) * 100).toFixed(1) + 'pp');
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 steady（麦当劳）预期 ≈ 实际 ===');
{
  fixRandom(0.5);
  const st = mkStock({ multiple: 2.25, growth: 0.03, trait: 'steady' });
  st.capCeiling = 1e12;
  st.fair = 500;
  const rep = genNextReport(st, { growthCeiling: 8 });
  check('steady 票预期 ≈ 实际（噪声被压到 ±0.25%）',
    Math.abs(rep.growth - rep.expectedGrowth) < 0.003,
    `${(rep.growth * 100).toFixed(3)}%`);
}

// ---------------------------------------------------------------- 7
log('');
log('=== 7 有市值目标的票（弦卷财团）预期 = 实际 ===');
{
  fixRandom(0.5);
  const st = mkStock({ multiple: 1, growth: 0.02, trait: 'backstop' });
  st.capTarget = 5e11;
  st.capTargetRate = 0.06;
  const rep = genNextReport(st, { growthCeiling: 8 });
  check('capTarget 票预期 = 实际', Math.abs(rep.growth - rep.expectedGrowth) < 1e-9,
    `${(rep.growth * 100).toFixed(3)}% vs ${(rep.expectedGrowth * 100).toFixed(3)}%`);
}

Math.random = origRandom;
console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
