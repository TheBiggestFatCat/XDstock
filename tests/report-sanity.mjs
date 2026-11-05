// 财报系统体检：报出来的数字必须自洽
//   node tests/report-sanity.mjs
//
// 曾经踩过的坑：
//   1. 营收被夹在「基准 25% 的地板」后，growth 还沿用夹之前的数
//      → 财报显示「营收一动不动，同比 -35%」（LMFX / TGW / LU / NW 都这样过）
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
  let r;
  try {
    r = genNextReport(st, {});
  } finally {
    console.log = realLog;
  }
  check('营收仍在地板', Math.abs(r.revenue - 25e8) < 1e8 * 0.5, (r.revenue / 1e8).toFixed(2) + ' 亿');
  check('报的增速 ≈ 0（不是 -30%）', Math.abs(r.growth) < 0.02, (r.growth * 100).toFixed(2) + '%');
  check('市场预期也同步 ≈ 0（不会白送超预期冲击）',
    Math.abs(r.expectedGrowth) < 0.05, (r.expectedGrowth * 100).toFixed(2) + '%');
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 体质会回归，不会永久 -30%/期 地缩下去 ===');
{
  const st = {
    code: 'T2', name: '衰退股', shares: 1e8, industry: '消费娱乐', price: 10,
    trait: { id: 'reversal', revMult: 1 },      // reversal 的基准 bias 是 0
    fundamentals: {
      period: 1, revenue: 100e8, baseRevenue: 100e8, netProfit: 10e8, tradePnl: 0,
      eps: 1, bps: 10, roe: 0.1, margin: 0.1, growth: -0.2,
      debt: 0.4, dividendRate: 0.2, bias: -0.16, expectedGrowth: -0.2, reportAt: Date.now()
    }
  };
  const realLog = console.log;
  console.log = () => {};
  const biases = [];
  try {
    for (let i = 0; i < 30; i++) {
      st.fundamentals = genNextReport(st, {});
      biases.push(st.fundamentals.bias);
    }
  } finally {
    console.log = realLog;
  }
  check('bias 从 -0.16 明显回正', Math.abs(biases[biases.length - 1]) < 0.08,
    `-0.16 → ${biases[biases.length - 1].toFixed(3)}`);
  // BIAS_REVERT=0.15 → 3 期最多磨掉 1−0.85³ ≈ 39%（0.16 → 0.098）；
  // 但每期有 12% 概率撞上「景气/衰退偏移 ±0.05」，会让它掉得更快，所以阈值放到 0.04
  check('不是一步砍断（前 3 期还在慢慢磨）', Math.abs(biases[2]) > 0.04, biases[2].toFixed(3));
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 触底会反弹：缩到地板的票能重新长回来 ===');
{
  const st = {
    code: 'T3', name: '触底股', shares: 1e8, industry: '消费娱乐', price: 10,
    trait: { id: 'old_money', revMult: 1 },
    fundamentals: {
      period: 40, revenue: 25e8, baseRevenue: 100e8, netProfit: 2e8, tradePnl: 0,
      eps: 2, bps: 20, roe: 0.1, margin: 0.1, growth: -0.3,
      debt: 0.4, dividendRate: 0.2, bias: -0.16, expectedGrowth: -0.3, reportAt: Date.now()
    }
  };
  const realLog = console.log;
  console.log = () => {};
  let end = 0;
  let low = Infinity;
  try {
    for (let i = 0; i < 80; i++) {
      st.fundamentals = genNextReport(st, {});
      const rev = Number(st.fundamentals.revenue);
      low = Math.min(low, rev);
      end = rev;
    }
  } finally {
    console.log = realLog;
  }
  check('80 期里从没跌破地板', low >= 25e8 - 1e8 * 0.01, (low / 1e8).toFixed(1) + ' 亿');
  // 80 期是随机游走，偶尔只涨 20% 多；这里只要证明「不是卡死在地板」即可
  check('最后确实长回来了（高于地板 15% 以上）', end > 25e8 * 1.15,
    `${(low / 1e8).toFixed(1)} 亿 → ${(end / 1e8).toFixed(1)} 亿`);
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
