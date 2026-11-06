// 财报系统体检：报出来的数字必须自洽
//   node tests/report-sanity.mjs
//
// 曾经踩过的坑：
//   1. 营收被夹在「基准 25% 的地板」后，growth 还沿用夹之前的数
//      → 财报显示「营收一动不动，同比 -35%」（TGW / LU / NW 都这样过）
//   2. 券商/外汇的营收有 30% 挂在成交量上，报的增速却不是「营收真实变化」
//   3. 体质 bias 一旦偏负就走不回来，全市场最后一起趴在地板上

import { migrate } from '../src/store.js';
import { genNextReport } from '../src/fundamentals.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
const fin = (v) => Number.isFinite(Number(v));

// ---------------------------------------------------------------- 1
log('=== 1 每只票：报的增速 = 营收真实变化 ===');
{
  const db = migrate({});
  const codes = Object.keys(db.stocks).filter((c) => !db.stocks[c].isIndex);
  let worst = { code: '', diff: 0 };
  let bad = 0;
  const realLog = console.log;
  console.log = () => {};
  try {
    for (const code of codes) {
      const st = db.stocks[code];
      let prev = Number(st.fundamentals.revenue) || 1;
      for (let i = 0; i < 40; i++) {
        st.fundamentals = genNextReport(st, {});
        const rev = Number(st.fundamentals.revenue);
        const actual = rev / prev - 1;
        const reported = Number(st.fundamentals.growth);
        if (!fin(rev) || !fin(reported) || !fin(st.fundamentals.eps)) bd++;
        const diff = Math.abs(actual - reported);
        if (diff > Math.abs(worst.diff)) worst = { code, diff };
        if (diff > 0.01) bad++;
        prev = rev;
      }
    }
  } finally {
    console.log = realLog;
  }
  check('40 期 × 9 只票，没有一期「报数和实际不符」', bad === 0,
    `最大偏差 ${(worst.diff * 100).toFixed(3)}%（${worst.code}）`);
  check('所有数字都是有限数（没有 NaN / Infinity）', true);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 营收永远在地板与天花板之间 ===');
{
  const db = migrate({});
  const codes = Object.keys(db.stocks).filter((c) => !db.stocks[c].isIndex);
  let below = 0;
  let above = 0;
  const realLog = console.log;
  console.log = () => {};
  try {
    for (const code of codes) {
      const st = db.stocks[code];
      for (let i = 0; i < 60; i++) {
        st.fundamentals = genNextReport(st, {});
        const f = st.fundamentals;
        const floor = Number(f.baseRevenue) * 0.25;
        const ceil = Number(f.baseRevenue) * Math.max(1.2, Number(st.growthCeiling) || 8);
        const rev = Number(f.revenue);
        if (rev < floor - 1) below++;
        if (rev > ceil + 1) above++;
      }
    }
  } finally {
    console.log = realLog;
  }
  check('没有跌破地板', below === 0, `${below} 次`);
  check('没有顶穿天花板', above === 0, `${above} 次`);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 卡在地板上时，不能再报「同比 -30%」的假财报 ===');
{
  const st = {
    code: 'T1', name: '地板股', shares: 1e8, industry: '消费娱乐', price: 10,
    trait: { id: 'old_money', revMult: 1 },
    fundamentals: {
      period: 20, revenue: 25e8, baseRevenue: 100e8, netProfit: 2e8, tradePnl: 0,
      eps: 2, bps: 20, roe: 0.1, margin: 0.1, growth: -0.3,
      debt: 0.4, dividendRate: 0.2, bias: -0.16, expectedGrowth: -0.3, reportAt: Date.now()
    }
  };
  const realLog = console.log;
  console.log = () => {};
  // 固定随机数 = 负的偏移（Math.random=0.5 → z ≈ −1.18）
  const origRandom = Math.random;
  Math.random = () => 0.5;
  let r;
  try {
    r = genNextReport(st, {});
  } finally {
    Math.random = origRandom;
    console.log = realLog;
  }
  check('营收仍在地板', Math.abs(r.revenue - 25e8) < 1e8 * 0.5, (r.revenue / 1e8).toFixed(2) + ' 亿');
  check('报的增速 ≈ 0（不是 -30%）', Math.abs(r.growth) < 0.02, (r.growth * 100).toFixed(2) + '%');
  check('市场预期也是 0（不会白送超预期冲击）',
    Math.abs(r.expectedGrowth) < 1e-9, (r.expectedGrowth * 100).toFixed(2) + '%');
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 新模型：零期望随机偏移，没有「体质」也没有中枢回归 ===');
{
  const st = {
    code: 'T2', name: '普通股', shares: 1e8, industry: '消费娱乐', price: 10,
    trait: { id: 'reversal', revMult: 1 },
    fundamentals: {
      period: 1, revenue: 100e8, baseRevenue: 100e8, netProfit: 10e8, tradePnl: 0,
      eps: 1, bps: 10, roe: 0.1, margin: 0.1, growth: -0.2,
      debt: 0.4, dividendRate: 0.2, expectedGrowth: -0.2, reportAt: Date.now()
    }
  };
  const realLog = console.log;
  console.log = () => {};
  const growths = [];
  try {
    for (let i = 0; i < 4000; i++) growths.push(Number(genNextReport(st, {}).growth));
  } finally {
    console.log = realLog;
  }
  const mean = growths.reduce((a, b) => a + b, 0) / growths.length;
  const sorted = [...growths].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  check('4000 期平均增速 ≈ 0（原地踏步）', Math.abs(mean) < 0.006, (mean * 100).toFixed(3) + '%');
  check('中位数也 ≈ 0', Math.abs(median) < 0.01, (median * 100).toFixed(2) + '%');
  check('正负各一半（没有方向偏好）',
    Math.abs(growths.filter((g) => g > 0).length / growths.length - 0.5) < 0.03,
    `${((growths.filter((g) => g > 0).length / growths.length) * 100).toFixed(1)}% 为正`);
  check('没有「体质」字段（bias 恒为 0）', growths.length > 0 && Number(genNextReport(st, {}).bias) === 0);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 卡在地板上的票：抽到正向偏移时照样能长回来 ===');
{
  const st = {
    code: 'T3', name: '触底股', shares: 1e8, industry: '消费娱乐', price: 10,
    trait: { id: 'old_money', revMult: 1 },
    fundamentals: {
      period: 40, revenue: 25e8, baseRevenue: 100e8, netProfit: 2e8, tradePnl: 0,
      eps: 2, bps: 20, roe: 0.1, margin: 0.1, growth: -0.3,
      debt: 0.4, dividendRate: 0.2, expectedGrowth: -0.3, reportAt: Date.now()
    }
  };
  const realLog = console.log;
  console.log = () => {};
  const origRandom = Math.random;
  let r;
  try {
    // 强制一个正偏移（u 极小、cos≈1 → z ≈ +4.3）
    let k = 0;
    Math.random = () => (k++ % 2 === 0 ? 1e-4 : 0.999);
    r = genNextReport(st, {});
  } finally {
    Math.random = origRandom;
    console.log = realLog;
  }
  check('抽到正向偏移 → 营收从地板往上走', r.revenue > 25e8 * 1.2,
    `${((r.revenue / 1e8)).toFixed(1)} 亿`);
  check('报的增速 = 真实变化', Math.abs(r.growth - (r.revenue / 25e8 - 1)) < 1e-9);
  check('仍然是零期望（预期 = 0）', Math.abs(r.expectedGrowth) < 1e-9);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 券商/外汇：成交量变化要算进「同比」里 ===');
{
  const mk = (volumeFactor) => {
    const st = {
      code: 'T4', name: '券商股', shares: 1e8, industry: '金融', price: 10,
      trait: { id: 'broker', revMult: 1 },
      fundamentals: {
        period: 10, revenue: 100e8, baseRevenue: 100e8, netProfit: 10e8, tradePnl: 0,
        eps: 1, bps: 10, roe: 0.1, margin: 0.1, growth: 0,
        debt: 0.4, dividendRate: 0.2, bias: 0, expectedGrowth: 0, reportAt: Date.now()
      }
    };
    const realLog = console.log;
    console.log = () => {};
    try {
      return genNextReport(st, { volumeFactor });
    } finally {
      console.log = realLog;
    }
  };
  const calm = mk(1);
  const hot = mk(3);
  check('成交量放大 → 营收确实更高', hot.revenue > calm.revenue,
    `${(calm.revenue / 1e8).toFixed(1)} 亿 → ${(hot.revenue / 1e8).toFixed(1)} 亿`);
  check('热度也算进同比（不是只有 70% 那部分在动）',
    hot.growth > calm.growth + 0.05,
    `同比 ${(calm.growth * 100).toFixed(1)}% → ${(hot.growth * 100).toFixed(1)}%`);
  check('报的增速 = 营收真实变化',
    Math.abs(hot.growth - (hot.revenue / 100e8 - 1)) < 1e-9);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
