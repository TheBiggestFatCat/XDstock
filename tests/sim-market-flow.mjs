// 虚假成交 + 游资 对价格的影响模拟器
//   node tests/sim-market-flow.mjs
//
// 量四件事（全部用线上实际参数，见 LIVE）：
//   A. 单笔/单次资金进场，最终把价格推多少（解析值）
//   B. 放回线上噪声里：市场资金占总波动的比例、价格偏离分布、会不会顶到天花板
//   C. 游资的轮动节奏（间隔、金额、板块）是否符合 20~300 轮 / 1000 万~3000 万
//   D. 敏感性：marketImpactStrength 从 0.0005 到 0.004，影响怎么变

import { createDb, migrate } from '../src/store.js';
import { stepMarket } from '../src/engine.js';
import { impactFactor } from '../src/fundamentals.js';

// ---- 线上实际生效的参数（从 data/db.json 读出来的，不是 DEFAULT_CONFIG）----
const LIVE = {
  baseVolatility: 0.01, meanReversion: 0.002, eventImpactScale: 1.5, globalEventScale: 0.2,
  eventChance: 0.04, reportIntervalTicks: 720, indexRebalanceTicks: 2160,
  playerImpactEnabled: 1, playerImpactRef: 100000, playerImpactStrength: 0.0003,
  playerImpactTail: 0.6, playerImpactDecay: 0.88, playerImpactMax: 0.008, playerImpactFlowMax: 12,
  impactRefFreeCap: 1e10,
  sentimentEnabled: 1, sentimentStrength: 0.004, sentimentTicks: 12, sentimentDrift: 0.6, sentimentEdge: 3,
  // 本次新增的默认值
  marketTradesEnabled: 1, marketTradesRate: 3,
  marketTradesSmallP: 70, marketTradesMidP: 24, marketTradesBigP: 6, marketTradesChase: 25,
  hotMoneyEnabled: 1, hotMoneySwitchMin: 20, hotMoneySwitchMax: 300,
  hotMoneyMin: 10000000, hotMoneyMax: 30000000,
  marketImpactEnabled: 1, marketImpactRef: 10000000, marketImpactStrength: 0.002,
  marketImpactMax: 0.008, marketImpactDecay: 0.85, marketImpactFlowMax: 8
};
const TICK_MS = 5000;

const realLog = console.log;
const quiet = (fn) => {
  console.log = () => {};
  try { return fn(); } finally { console.log = realLog; }
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pct = (v, d = 2) => (v >= 0 ? '+' : '') + (v * 100).toFixed(d) + '%';
const pad = (s, n) => String(s).padStart(n);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = (a) => {
  if (a.length < 2) return 0;
  const m = avg(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
};
const quantile = (arr, q) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
};

/** 单轮的市场资金冲击（和 engine.js#stepStock 里那段公式逐字一致） */
function impactPerTick(st, cfg) {
  const mflow = Number(st.mflow) || 0;
  if (mflow === 0 || Number(cfg.marketImpactEnabled ?? 1) === 0) return 0;
  const factor = impactFactor(st, Number(cfg.impactRefFreeCap) || 0);
  const strength = Number(cfg.marketImpactStrength ?? 0.002) * factor;
  const cap = Math.max(0, Number(cfg.marketImpactMax ?? 0.008));
  return Math.max(-cap, Math.min(cap, mflow * strength));
}

/** 一笔 notional 的压力，逐轮释放完的累计涨幅（解析值） */
function cumulativeImpact(st, cfg, notional) {
  const ref = Math.max(1, Number(cfg.marketImpactRef) || 1);
  const capFlow = Math.max(1, Number(cfg.marketImpactFlowMax) || 8);
  let flow = Math.max(-capFlow, Math.min(capFlow, notional / ref));
  const decay = Number(cfg.marketImpactDecay ?? 0.85);
  const factor = impactFactor(st, Number(cfg.impactRefFreeCap) || 0);
  const strength = Number(cfg.marketImpactStrength ?? 0.002) * factor;
  const cap = Math.max(0, Number(cfg.marketImpactMax ?? 0.008));
  let sum = 0;
  for (let i = 0; i < 500 && Math.abs(flow) >= 0.02; i++) {
    sum += Math.log(1 + Math.max(-cap, Math.min(cap, flow * strength)));
    flow *= decay;
  }
  return Math.exp(sum) - 1;
}

function mkDb(patch = {}) {
  return quiet(() => {
    const db = migrate(createDb());
    Object.assign(db.config, LIVE, patch);
    return db;
  });
}

/** 跑一段，返回每只票的逐轮序列 */
function run({ ticks, seed, patch = {}, from = 0 }) {
  const orig = Math.random;
  Math.random = mulberry32(seed);
  const db = mkDb(patch);
  const codes = Object.values(db.stocks).filter((s) => !s.isIndex).map((s) => s.code);
  const series = {};
  for (const c of codes) series[c] = { imp: [], ret: [], dev: [] };
  // 统计游资（用计数器，别依赖被截断的 db.trades）
  const hot = { switches: 0, intervals: [], amounts: [], industries: [], jumps: [], buys: 0, sells: 0 };
  let lastSwitch = from;
  let seq = 0;
  try {
    quiet(() => {
      for (let i = 0; i < ticks; i++) {
        for (const c of codes) series[c].imp.push(impactPerTick(db.stocks[c], db.config));
        const before = db.hotMoney ? db.hotMoney.switches : 0;
        stepMarket(db);
        for (const c of codes) {
          const st = db.stocks[c];
          series[c].ret.push(Number(st.lastRet) || 0);
          series[c].dev.push(Math.abs(Math.log(st.price / st.fair)));
        }
        if (db.hotMoney && db.hotMoney.switches > before) {
          hot.switches++;
          hot.intervals.push(db.tick - lastSwitch);
          lastSwitch = db.tick;
          hot.industries.push(db.hotMoney.industry);
          const code = db.hotMoney.code;
          hot.jumps.push(Number(db.stocks[code]?.lastRet) || 0);
          seq++;
        }
      }
    });
  } finally {
    Math.random = orig;
  }
  // 游资买卖笔数：看 db.hotMoney.switches 即可（每次 1 买 1 卖，首次只有买）
  hot.sells = Math.max(0, hot.switches - 1);
  hot.buys = hot.switches;
  return { db, series, hot, codes };
}

/** 汇总多颗种子 */
function summarize({ ticks, seeds = 3, patch = {} }) {
  const acc = { retSd: [], impSd: [], varShare: [], dev50: [], dev90: [], devMax: [], top: 0, n: 0 };
  for (const seed of seeds) {
    const { series } = run({ ticks, seed, patch });
    for (const s of Object.values(series)) {
      const rSd = sd(s.ret);
      const iSd = sd(s.imp);
      acc.retSd.push(rSd);
      acc.impSd.push(iSd);
      acc.varShare.push(rSd > 0 ? (iSd * iSd) / (rSd * rSd) : 0);
      acc.dev50.push(quantile(s.dev, 0.5));
      acc.dev90.push(quantile(s.dev, 0.9));
      acc.devMax.push(quantile(s.dev, 1));
      acc.top += s.dev.filter((d) => Math.exp(d) > 2.4).length;
      acc.n += s.dev.length;
    }
  }
  return {
    retSd: avg(acc.retSd),
    impSd: avg(acc.impSd),
    varShare: avg(acc.varShare),
    dev50: quantile(acc.dev50, 0.5),
    dev90: quantile(acc.dev90, 0.5),
    devMax: Math.max(...acc.devMax),
    topRate: acc.top / Math.max(1, acc.n)
  };
}

// ================================================================ A
console.log('========== A. 一次资金进场，最终把价格推多少 ==========');
console.log('  解析值：压力逐轮释放、按 0.85 衰减、单轮封顶 0.8%，累计到消化干净');
{
  const db = mkDb();
  const rows = [
    { label: '虚假成交 一档 5 万', notional: 50000 },
    { label: '虚假成交 二档 50 万', notional: 500000 },
    { label: '虚假成交 三档 1000 万', notional: 10000000 },
    { label: '游资 一笔 2000 万', notional: 20000000 },
    { label: '游资 一笔 3000 万', notional: 30000000 }
  ];
  const codes = ['NW', 'XD', 'KFC', 'MB', 'MCD'];
  console.log(pad('资金', 22) + codes.map((c) => pad(c, 9)).join('') + pad('impactFactor', 14));
  console.log('-'.repeat(36 + 9 * codes.length));
  for (const r of rows) {
    const cells = codes.map((c) => pad(pct(cumulativeImpact(db.stocks[c], db.config, r.notional), 2), 9));
    console.log(pad(r.label, 22) + cells.join(''));
  }
  console.log(pad('impactFactor', 22) + codes.map((c) => pad(impactFactor(db.stocks[c], db.config.impactRefFreeCap).toFixed(3), 9)).join(''));
  console.log('  （同一笔钱砸在小盘股上更明显：factor = (100亿 / 流通市值)^0.6）');
}

// ================================================================ B
console.log('');
console.log('========== B. 放回线上噪声里：占多大比例、会不会顶到天花板 ==========');
console.log('  1500 轮 × 3 颗种子，线上参数（1%/轮 噪声 + 0.002 回归 + 新闻 + 情绪）');
{
  const variants = [
    { key: '基线（全关）', patch: { marketTradesEnabled: 0, hotMoneyEnabled: 0, marketImpactEnabled: 0 } },
    { key: '只有虚假成交', patch: { hotMoneyEnabled: 0 } },
    { key: '虚假成交 + 游资', patch: {} }
  ];
  console.log(pad('变体', 20) + pad('每轮σ', 10) + pad('资金σ', 10) + pad('方差占比', 10)
    + pad('偏离中位', 10) + pad('90分位', 10) + pad('最大', 10) + pad('贴顶率', 9));
  console.log('-'.repeat(89));
  for (const v of variants) {
    const s = summarize({ ticks: 1500, seeds: [11, 22, 33], patch: v.patch });
    console.log(
      pad(v.key, 20) + pad(pct(s.retSd, 2), 10) + pad(pct(s.impSd, 3), 10)
      + pad((s.varShare * 100).toFixed(2) + '%', 10)
      + pad(pct(s.dev50, 1), 10) + pad(pct(s.dev90, 1), 10) + pad(pct(s.devMax, 1), 10)
      + pad((s.topRate * 100).toFixed(2) + '%', 9)
    );
  }
  console.log('  「资金σ」= 虚假成交/游资每轮推到价格上的那一部分（对数）；方差占比 = σ²比');
  console.log('  「贴顶率」= 价格进入 fair×2.4 以上（快撞 2.5 上限）的股票-轮次占比');
}

// ================================================================ C
console.log('');
console.log('========== C. 游资轮动实测（3000 轮 ≈ 4.2 小时） ==========');
{
  const { hot } = run({ ticks: 3000, seed: 2026 });
  const hours = 3000 * TICK_MS / 3600000;
  const intervals = hot.intervals.slice(1);     // 第一段是从 0 起算的，不算
  console.log(`换板块 ${hot.switches} 次 / ${hours.toFixed(1)} 小时 → 平均 ${(3000 / Math.max(1, hot.switches)).toFixed(0)} 轮一次（${(3000 / Math.max(1, hot.switches) * TICK_MS / 60000).toFixed(1)} 分钟）`);
  console.log(`实测间隔：最短 ${Math.min(...intervals)} / 中位 ${quantile(intervals, 0.5)} / 最长 ${Math.max(...intervals)} 轮（要求 20~300）`);
  console.log(`买入 ${hot.buys} 笔、卖出 ${hot.sells} 笔`);
  console.log(`覆盖板块 ${[...new Set(hot.industries)].length} 个：${[...new Set(hot.industries)].join(' / ')}`);
  console.log(`买入那一轮该票涨幅：中位 ${pct(quantile(hot.jumps, 0.5), 2)} / 90 分位 ${pct(quantile(hot.jumps, 0.9), 2)}`);
  console.log(`连续两次买同一板块：${hot.industries.filter((x, i) => i > 0 && x === hot.industries[i - 1]).length} 次（应为 0）`);
}

// ================================================================ D
console.log('');
console.log('========== D. 敏感性：marketImpactStrength（同一颗种子、同一串随机数） ==========');
console.log('  1000 轮 × 3 颗种子；strength 不消耗随机数，所以各行的噪声完全相同，差别只来自市场资金');
{
  console.log(pad('strength', 10) + pad('单轮资金σ', 12) + pad('方差占比', 10) + pad('偏离中位', 10)
    + pad('90分位', 10) + pad('最大', 10) + pad('贴顶率', 9));
  console.log('-'.repeat(71));
  for (const strength of [0.0005, 0.001, 0.002, 0.003, 0.004, 0.008]) {
    const s = summarize({ ticks: 1000, seeds: [7, 17, 27], patch: { marketImpactStrength: strength } });
    console.log(
      pad(strength, 10) + pad(pct(s.impSd, 3), 12) + pad((s.varShare * 100).toFixed(2) + '%', 10)
      + pad(pct(s.dev50, 1), 10) + pad(pct(s.dev90, 1), 10) + pad(pct(s.devMax, 1), 10)
      + pad((s.topRate * 100).toFixed(2) + '%', 9)
    );
  }
  console.log('  线上噪声 σ=1%/轮、回归 0.002（半衰期 29 分钟）；「最大」列是 9 只票里最夸张的那只');
}

// ================================================================ E
console.log('');
console.log('========== E. 单看「一笔游资」的路径（NW，小盘股） ==========');
{
  const db = mkDb({ baseVolatility: 0, meanReversion: 0, eventChance: 0, sentimentEnabled: 0,
    marketTradesEnabled: 0, hotMoneyEnabled: 0 });
  const st = db.stocks.NW;
  st.price = 100;
  st.fair = 100;
  st.mflow = 30000000 / db.config.marketImpactRef;    // 一笔 3000 万
  const line = [];
  for (let i = 0; i < 12; i++) {
    const imp = impactPerTick(st, db.config);
    line.push(`${i + 1}轮 ${pct(imp, 2)}`);
    quiet(() => stepMarket(db));
  }
  console.log('  每轮冲击：' + line.join(' → '));
  console.log(`  12 轮后价格 ${st.price.toFixed(2)}（${pct(st.price / 100 - 1, 2)}），压力剩 ${(Number(st.mflow) || 0).toFixed(3)} 单位`);
  console.log(`  「一笔 3000 万」全部消化完的累计涨幅：${pct(cumulativeImpact(mkDb().stocks.NW, mkDb().config, 30000000), 2)}（NW ≈ 2.0~2.5%）`);
}
