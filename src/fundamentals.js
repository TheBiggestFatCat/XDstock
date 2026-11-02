/**
 * 财报系统
 *
 * 每家公司有总股本、流通比例、行业，以及一套财务数据。
 * 价值回归线（fair）由财报算出来：
 *     fair = EPS × 行业合理PE × (1 + 成长溢价)   ，且不低于 每股净资产 × 0.8
 *
 * 资金影响能力由流通市值算出来：
 *     每 10 万元净买入带来的单轮涨幅 ∝ (参考流通市值 / 本公司流通市值)^0.6
 */

/** 行业：合理市盈率 + 净利率区间 + 营收增速区间 */
export const INDUSTRY = {
  消费: { pe: 18, margin: [0.06, 0.16], growth: [0.02, 0.18] },
  科技: { pe: 25, margin: [0.10, 0.28], growth: [0.10, 0.45] },
  金融: { pe: 10, margin: [0.18, 0.35], growth: [0.00, 0.12] },
  传媒: { pe: 15, margin: [0.08, 0.22], growth: [0.03, 0.25] },
  外汇: { pe: 12, margin: [0.12, 0.25], growth: [0.01, 0.10] }
};

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 行业名归一化：种子里的名字更花哨，这里映射到 5 个大类 */
const ALIAS = [
  ['消费', '消费'],
  ['科技', '科技'],
  ['金融', '金融'],
  ['传媒', '传媒'],
  ['外汇', '外汇']
];

export function industryOf(st) {
  const raw = String(st.industry || '');
  for (const [kw, key] of ALIAS) {
    if (raw.includes(kw)) return INDUSTRY[key];
  }
  // 留美外汇走外汇口径
  if (st.trait?.id === 'fx') return INDUSTRY.外汇;
  return INDUSTRY.科技;
}

/** 市值（元）：现价 × 总股本 */
export function marketCap(st) {
  const shares = Number(st.shares) || 0;
  return (Number(st.price) || 0) * shares;
}

/** 流通市值 */
export function freeCap(st) {
  const ff = Number(st.freeFloat) || 0.45;
  return marketCap(st) * ff;
}

/** 由财报推出合理价 */
export function fairFromReport(st) {
  const ind = industryOf(st);
  const f = st.fundamentals || {};
  const eps = Number(f.eps) || 0;
  const bps = Number(f.bps) || 0;
  const growth = Number(f.growth) || 0;
  // 成长溢价：增速越高给得越多，上限 +50%
  const premium = 1 + clamp(Math.max(0, growth) * 1.5, 0, 0.5);
  const pe = ind.pe * premium;
  const byEps = eps * pe;
  const byBook = bps * 0.8;   // 净资产底线
  return Math.max(byEps, byBook, 0.01);
}

/** 按目标合理价倒推一套财务数据（老存档迁移用） */
export function backDerive(st, targetFair) {
  const ind = industryOf(st);
  const growth = rand(ind.growth[0], ind.growth[1]);
  const premium = 1 + clamp(Math.max(0, growth) * 1.5, 0, 0.5);
  const eps = targetFair / (ind.pe * premium);
  const roe = rand(0.07, 0.18);
  const bps = eps / roe;
  const margin = rand(ind.margin[0], ind.margin[1]);
  const shares = Number(st.shares) || 1;
  const revenue = eps * shares / margin;
  return {
    period: 0,
    revenue,
    netProfit: eps * shares,
    eps,
    bps,
    roe,
    margin,
    growth,
    debt: rand(0.25, 0.6),
    dividendRate: rand(0.1, 0.4),
    reportAt: Date.now(),
    reportTick: 0
  };
}

/**
 * 生成下一期财报。
 * 营收按增速滚动，净利率小幅漂移，EPS 由净利润 / 股本算出。
 */
export function genNextReport(st) {
  const ind = industryOf(st);
  const f = st.fundamentals || {};
  const shares = Number(st.shares) || 1;

  // 增速均值回归 + 噪声
  let growth = (Number(f.growth) || 0.1) * 0.75 + rand(ind.growth[0], ind.growth[1]) * 0.25;
  growth += rand(-0.08, 0.08);
  growth = clamp(growth, -0.35, 0.9);

  const margin = clamp(
    (Number(f.margin) || (ind.margin[0] + ind.margin[1]) / 2) + rand(-0.02, 0.02),
    ind.margin[0] * 0.7,
    ind.margin[1] * 1.2
  );

  const revenue = (Number(f.revenue) || 1) * (1 + growth);
  const netProfit = revenue * margin;
  const eps = netProfit / shares;
  const bps = (Number(f.bps) || 1) + eps * rand(0.4, 0.9);
  const roe = bps > 0 ? eps / bps : 0;

  return {
    period: (Number(f.period) || 0) + 1,
    revenue,
    netProfit,
    eps,
    bps,
    roe,
    margin,
    growth,
    debt: clamp((Number(f.debt) || 0.4) + rand(-0.05, 0.05), 0.05, 0.9),
    dividendRate: clamp((Number(f.dividendRate) || 0.25) + rand(-0.05, 0.05), 0, 0.6),
    reportAt: Date.now(),
    reportTick: 0
  };
}

/** 资金影响能力：流通盘越小越容易被推动 */
export function impactFactor(st, refFreeCap) {
  const cap = Math.max(1, freeCap(st));
  const rel = Math.max(0.05, refFreeCap / cap);
  return Math.pow(rel, 0.6);
}

/** 给前端看的财报摘要 */
export function reportPayload(st) {
  const f = st.fundamentals || {};
  const cap = marketCap(st);
  const free = freeCap(st);
  const fair = fairFromReport(st);
  const price = Number(st.price) || 0;
  return {
    industry: st.industry || '',
    shares: Number(st.shares) || 0,
    freeFloat: Number(st.freeFloat) || 0.45,
    marketCap: cap,
    freeCap: free,
    fair,
    premium: fair > 0 ? (price / fair - 1) * 100 : 0,
    pe: (Number(f.eps) || 0) > 0 ? price / f.eps : 0,
    pb: (Number(f.bps) || 0) > 0 ? price / f.bps : 0,
    revenue: Number(f.revenue) || 0,
    netProfit: Number(f.netProfit) || 0,
    eps: Number(f.eps) || 0,
    bps: Number(f.bps) || 0,
    roe: Number(f.roe) || 0,
    growth: Number(f.growth) || 0,
    debt: Number(f.debt) || 0,
    dividendRate: Number(f.dividendRate) || 0,
    period: Number(f.period) || 0,
    reportAt: Number(f.reportAt) || 0,
    lastSurprise: Number(st.lastSurprise) || 0
  };
}
