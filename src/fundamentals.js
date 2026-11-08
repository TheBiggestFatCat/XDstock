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

/** 行业：合理市盈率 + 净利率区间 + 营收增速区间 + 派息率（参考现实：成长股少分、金融多分） */
export const INDUSTRY = {
  消费: { pe: 18, margin: [0.06, 0.16], growth: [-0.08, 0.16], payout: 0.45 },
  科技: { pe: 25, margin: [0.10, 0.28], growth: [-0.06, 0.42], payout: 0.12 },
  金融: { pe: 10, margin: [0.18, 0.35], growth: [-0.06, 0.12], payout: 0.40 },
  传媒: { pe: 15, margin: [0.08, 0.22], growth: [-0.10, 0.22], payout: 0.30 },
  外汇: { pe: 12, margin: [0.12, 0.25], growth: [-0.05, 0.10], payout: 0.35 }
};

/** 每家公司的天生体质：有的能长大，有的注定萎缩 */
const TRAIT_BIAS = {
  old_money: -0.035,   // 老钱：守成，慢慢缩
  casino: 0.06,        // 赌场：高增长高波动
  hype: 0.025,         // 话题驱动：靠新闻
  reversal: 0.0,       // 反转王：随波逐流
  meme: -0.05,         // 梗股：热度过了就凉
  backstop: -0.025,    // 护盘：稳，但增长很慢
  fx: 0.0,
  broker: 0.0,
  gold: 0.0,           // 矿工银行：没有长期体质，全看金价
};

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 标准正态（Box-Muller） */
function gauss() {
  const u = Math.max(1e-9, Math.random());
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 财报的随机偏移量（标准差）。
 *
 * 规则：**体量越大，偏移越小**，按市值的平方根缩放 ——
 * 体量翻 4 倍，偏移量减半。再夹在 [volMin, volMax] 之间。
 *
 * @param {number} sizeCap 当前市值
 * @param {object} cfg     取 reportVol / reportRefCap / reportVolMin / reportVolMax
 */
export function reportVolFor(sizeCap, cfg = {}) {
  const refCap = Math.max(1e9, Number(cfg.reportRefCap) || 1e11);      // 基准体量 1000 亿
  const volBase = clamp(Number(cfg.reportVol) || 0.05, 0.001, 0.5);
  const volMin = clamp(Number(cfg.reportVolMin) || 0.01, 0.001, 0.5);
  const volMax = clamp(Number(cfg.reportVolMax) || 0.1, volMin, 1);
  const size = Math.max(1e8, Number(sizeCap) || refCap);
  return clamp(volBase * Math.sqrt(refCap / size), volMin, volMax);
}

/** 每期把多少比例的利润并进净资产（剩下的视作分红/回购，发给场外股东） */
const BPS_RETAIN = [0.15, 0.3];
/** 账面价值过高时，每期向「盈利估值×2」收敛的比例（半衰期约 230 期） */
const BOOK_SHRINK = 0.003;
/** 营收天花板：最多长到基准营收的多少倍（会无限接近但不超过） */
const DEFAULT_GROWTH_CEILING = 8;

/** 「金融大鳄」能提前多少轮看到下一期财报（引擎生成 pendingReport 时也用这个） */
export const TYCOON_LEAD_TICKS = 20;

/** 市场预期看最近几期财报（拟合走势用） */
export const EXPECT_LOOKBACK = 5;

/**
 * 市场预期：拿最近 `lookback`（默认 5）期财报的**营收走势**做最小二乘拟合，外推下一期。
 *
 * 2026-11 改：以前「市场预期」是按模型内部参数算的理论值（纯随机票直接给 0），
 * 玩家看到的「预期」和实际盘面没多大关系。现在改成「市场看走势」：
 * 最近 5 期一路涨，市场就预期它接着涨；一路跌就预期它接着跌。
 * 这样「超预期 / 不及预期」才是相对**市场共识**说的。
 *
 * 做法：把 5 期营收取对数做一元线性回归，拟合线的斜率就是「每期对数增速」，
 * 换算成百分比即预期同比。对数空间做是为了让「+10% 再 +10%」这种等比走势是直线。
 *
 * 返回 `{ growth, slope, samples }`；有效样本 < 3 期时返回 `null`
 * （新上市 / 老存档还没攒够历史，调用方回退到模型口径）。
 */
export function expectedGrowthFromHistory(history, lookback = EXPECT_LOOKBACK) {
  const rows = Array.isArray(history) ? history.slice(-Math.max(2, Math.floor(lookback) || EXPECT_LOOKBACK)) : [];
  const pts = [];
  for (let i = 0; i < rows.length; i++) {
    const rev = Number(rows[i] && rows[i].revenue);
    if (Number.isFinite(rev) && rev > 0) pts.push({ x: pts.length, y: Math.log(rev) });
  }
  if (pts.length < 3) return null;
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const my = pts.reduce((a, p) => a + p.y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of pts) {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) * (p.x - mx);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  // 预期增速 = 拟合线往下一格涨多少（对数空间的差 → 百分比）
  const nextY = my + slope * (n - mx);
  const lastY = my + slope * (n - 1 - mx);
  const growth = Number.isFinite(nextY) && Number.isFinite(lastY)
    ? Math.exp(nextY - lastY) - 1
    : 0;
  return { growth: clamp(growth, -0.35, 0.9), slope, samples: n };
}

/**
 * 价值线（fair）：用最近 N 期财报的**每股收益趋势**拟合出来，而不是只认最后一期。
 *
 * 为什么改（2026-11）：`fairFromReport` 只看最后一期 EPS，一期财报抽到 ±6% 的噪声，
 * 整条价值线就被拽走 6%，再靠均值回归慢慢把价格拖过去 —— 玩家看到的是
 * 「价值线跟着单期财报乱跳」。现在改成和「市场预期」同一套思路：
 * 把最近 N 期 EPS 取对数做一元线性回归，取**拟合线在最后一期的值**当"当前盈利水平"，
 * 再乘行业 PE 和成长溢价。
 *
 * 窗口默认 8 期（`FAIR_LOOKBACK`，可被 `cfg.fairLookback` 覆盖）：
 * 端点杠杆 = 1/n + (x−x̄)²/Sxx，n=5 时最后一期占 60%（单期 ±5% 传 4.48%，几乎没降噪），
 * n=8 降到 42%（传 2.1~2.7%），而且不像几何平均那样滞后趋势。选型数据见开发者文档 §6.2.0。
 *
 * - 成长溢价用**拟合出来的斜率**（每期对数增速），不是最后一期的 `growth`
 * - 净资产底线仍然用当前 `bps × 0.8`（历史里没存 bps）
 * - 有效样本 < 3 期 → 返回 `null`，调用方回退到 `fairFromReport`（只看最后一期）
 *
 * @returns {number|null} 估值价（元），历史不够返回 null
 */
export const FAIR_LOOKBACK = 8;

export function fairFromHistory(st, lookback = FAIR_LOOKBACK) {
  const rows = Array.isArray(st?.reportHistory) ? st.reportHistory.slice(-Math.max(2, Math.floor(lookback) || FAIR_LOOKBACK)) : [];
  const pts = [];
  for (let i = 0; i < rows.length; i++) {
    const eps = Number(rows[i] && rows[i].eps);
    if (Number.isFinite(eps) && eps > 0) pts.push({ x: pts.length, y: Math.log(eps) });
  }
  if (pts.length < 3) return null;
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const my = pts.reduce((a, p) => a + p.y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of pts) {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) * (p.x - mx);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  // 拟合线在**最后一期**（x = n - 1）的取值 = "按最近这 5 期看，现在大概赚多少"
  const fittedY = my + slope * (n - 1 - mx);
  if (!Number.isFinite(fittedY)) return null;
  const epsFit = Math.exp(fittedY);
  if (!(epsFit > 0) || !Number.isFinite(epsFit)) return null;

  const ind = industryOf(st);
  const f = st.fundamentals || {};
  const bps = Number(f.bps) || 0;
  // 成长溢价用拟合斜率（折成百分比），和 fairFromReport 的口径一致：max(0, g) × 1.5，上限 +50%
  const growthFit = Math.exp(slope) - 1;
  const premium = 1 + clamp(Math.max(0, growthFit) * 1.5, 0, 0.5);
  const byEps = epsFit * ind.pe * premium;
  const byBook = bps * 0.8;     // 净资产底线（和 fairFromReport 一致）
  const out = Math.max(byEps, byBook, 0.01);
  return Number.isFinite(out) ? out : null;
}

/**
 * 「金融大鳄」能看到哪些票：**只有金融板块**（券商 / 外汇）。
 * 引擎用它决定给谁生成 pendingReport，api/server 用它决定要不要下发 previewIn，
 * 三处必须用同一个判断，否则会出现「有倒计时但永远没有预览」。
 */
export function isTycoonSector(st) {
  const id = st?.trait?.id;
  if (id === 'broker' || id === 'fx') return true;
  return String(st?.industry || '').includes('金融');
}

/**
 * 距离「可以预览下一期财报」还有多少轮：
 *   > 0  还要等这么多轮
 *   <= 0 已经在窗口内（有技能的话下一轮就能看到）
 * 没有排期（指数 / 已退市）返回 null。
 */
export function previewInTicks(st, tick, lead = TYCOON_LEAD_TICKS) {
  const next = Number(st?.nextReportTick) || 0;
  if (!(next > 0)) return null;
  return next - Number(tick || 0) - Math.max(0, Number(lead) || 0);
}

/**
 * 「金融大鳄」的预览数据。**api.js 和 server.js 共用这一份**，
 * 免得两处算出不一样的数字（历史上就是这样飘的）。
 * 没有任何 pendingReport 就返回 null。
 */
export function tycoonPreviewPayload(st, tick, lead = TYCOON_LEAD_TICKS) {
  const pr = st?.pendingReport;
  if (!pr) return null;
  const f = st.fundamentals || {};
  const growth = Number(pr.growth) || 0;
  const expected = Number(pr.expectedGrowth) || 0;
  // 和 runReports 发报当轮的口径完全一致
  const surprise = Math.max(-0.3, Math.min(0.3, growth - expected));
  const verdict = surprise > 0.02 ? 'beat' : surprise < -0.02 ? 'miss' : 'inline';
  const oldEps = Number(f.eps) || 0;
  const newEps = Number(pr.eps) || 0;
  return {
    eps: Number(pr.eps) || 0,
    revenue: Number(pr.revenue) || 0,
    netProfit: Number(pr.netProfit) || 0,
    growth,
    expected,
    surprise,
    verdict,
    // 发报那一刻的价格冲击（%）
    shockPct: Math.max(-0.06, Math.min(0.06, surprise * 0.8)) * 100,
    tickLeft: Math.max(0, (Number(st.nextReportTick) || 0) - Number(tick || 0)),
    previewIn: previewInTicks(st, tick, lead),
    expectPct: oldEps > 0 ? (newEps / oldEps - 1) * 100 : 0
  };
}
/**
 * 体质向「行业性格」回归的速度：每期把偏离收掉 15%。
 * 0.15 → 半衰期约 4.3 期，一次衰退大概 15 期就散尽，
 * 不会让公司一路缩到营收地板后还年复一年报「同比 -35%」（营收其实没动）。
 */
const BIAS_REVERT = 0.15;

/**
 * 掷一次天气（-1 ~ 1），农业股共用。
 *
 * 传上期分数会做均值回归：好天气不会一直好，坏天气也不会一直坏，
 * 否则一次掷骰就能决定这两只票这辈子的走向（历史 bug）。
 * 传 0 就是全新的随机天气（老存档迁移用）。
 */
export function rollWeather(prevScore = 0) {
  const u = Math.random() || 1e-9;
  const v = Math.random();
  const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  const base = Number(prevScore) || 0;
  const score = clamp(base * 0.5 + g * 0.55, -1, 1);
  const label = score > 0.45 ? '大丰收' : score > 0.12 ? '风调雨顺'
    : score > -0.12 ? '平平无奇' : score > -0.45 ? '略有减产' : '灾害歉收';
  return { score, label };
}

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

/** 行业中枢增速：作为「市场预期」的基准 */
export function industryMidGrowth(st) {
  const ind = industryOf(st);
  return (ind.growth[0] + ind.growth[1]) / 2;
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
    baseRevenue: revenue,   // 基准营收：用来压制无限复利
    netProfit: eps * shares,
    eps,
    bps,
    roe,
    margin,
    growth,
    // 刚上市这一期「按预期」：不然大鳄预览会算成「超预期 +6pp」
    expectedGrowth: growth,
    debt: rand(0.25, 0.6),
    dividendRate: rand(0.1, 0.4),
    reportAt: Date.now(),
    bias: (TRAIT_BIAS[st.trait?.id] ?? 0) + (Math.random() - 0.5) * 0.04
  };
}

/**
 * 生成下一期财报。
 * 营收按增速滚动，净利率小幅漂移，EPS 由净利润 / 股本算出。
 */
export function genNextReport(st, ctx = {}) {
  const ind = industryOf(st);
  const f = st.fundamentals || {};
  const shares = Number(st.shares) || 1;
  const midG = (ind.growth[0] + ind.growth[1]) / 2;
  const trait = st.trait?.id;

  // ===== 新的财报基线：**零期望的随机偏移** =====
  // 不再向行业中枢回归、也没有「天生体质」：每期就在上一期的基础上随机抖一下，
  // 期望正好是「原地踏步」（正态分布对称）。体量越大抖得越小（见 reportVolFor）。
  const baseRev = Number(f.baseRevenue) || Number(f.revenue) || 1;
  const multiple = Math.max(0.2, (Number(f.revenue) || baseRev) / baseRev);
  // 规模衰减只留给「特质驱动」的那几条线用（金价、券商），基线不用它
  const decay = 1 / (1 + Math.max(0, multiple - 1) * 1.5);

  const cfgVol = {
    reportRefCap: Number(st.reportRefCap ?? ctx.reportRefCap ?? 1e11),
    reportVol: Number(st.reportVol ?? ctx.reportVol ?? 0.05),
    reportVolMin: Number(st.reportVolMin ?? ctx.reportVolMin ?? 0.01),
    reportVolMax: Number(st.reportVolMax ?? ctx.reportVolMax ?? 0.1)
  };
  const sizeCap = Math.max(1e8, (Number(st.fair) || Number(st.price) || 1) * shares);
  const vol = reportVolFor(sizeCap, cfgVol);
  // 在对数空间里取零均值（中位数原地踏步）：直接用乘法随机游走会让
  // 大多数路径慢慢缩水（Itô 漂移），玩家看到的就成了「所有公司都在缩」
  const logShift = clamp(gauss() * vol, -0.35, 0.35);
  let growth = clamp(Math.exp(logShift) - 1, -0.3, 0.3);
  // 没被特质覆盖时，市场预期就是「不变」——随机偏移本身就是意外
  let plainRandom = true;
  let bias = 0;

  // 「稳步增长」型（麦当劳）：有市值天花板时增速只由「离天花板还有多远」决定，
  // 越接近天花板长得越慢 —— 无限接近但永远到不了。
  // 2026-11 起 MCD 不再设 capCeiling（天花板会把它硬夹在 10000 亿、看起来像卡死），
  // 没有天花板时 room 固定取 0.5（≈ 每期 2%），剩下的刹车交给营收天花板（growthCeiling）。
  if (trait === 'steady') {
    const capTarget = Math.max(0, Number(st.capCeiling) || Number(ctx.capCeiling) || 0);
    const capNow = Math.max(1, (Number(st.fair) || Number(st.price) || 1) * shares);
    const room = capTarget > 0 ? clamp(1 - capNow / capTarget, 0, 1) : 0.5;
    const g0 = Math.max(0, Number(st.trait?.steadyGrowth ?? 0.035));
    // 离得远 ≈ g0，贴到天花板 → 0
    growth = g0 * Math.sqrt(room);
    bias = 0;
    plainRandom = false;
  }

  // 业务联动也属于「可预期」的一部分
  if (trait === 'broker') {
    const vf = clamp(Number(ctx.volumeFactor) || 1, 0.2, 4);
    // 已经在上面加过，这里不再重复
  }

  /**
   * 市值目标（弦卷财团：逐步萎缩到 5000 亿）。
   *
   * 由目标市值反推「配得上这个市值的营收」，再让营收朝它收敛 ——
   * 这样 EPS / 合理价 / 净资产会一起往下走，PE 也不会失真，
   * 而不是硬把 fair 按住（那样 PE 会看着像 7 倍，自相矛盾）。
   */
  const capTargetNow = Math.max(0, Number(st.capTarget) || Number(ctx.capTarget) || 0);
  let tgtMarginRef = 0;
  // 目标市值带来的「基础增速」：矿工银行要把它和金价波动叠在一起
  let capTargetGrowth = null;
  if (capTargetNow > 0) {
    const tgtPrice = capTargetNow / shares;
    const tgtEps = tgtPrice / Math.max(1, ind.pe);
    // 用「行业中枢净利率」反推营收，而不是上期净利率 —— 否则净利率漂一点，
    // EPS 目标就跟着漂，终点会落在 5000 亿上下好几个百分点
    tgtMarginRef = (ind.margin[0] + ind.margin[1]) / 2;
    const tgtRev = Math.max(1, (tgtEps * shares) / Math.max(0.02, tgtMarginRef));
    const rate = clamp(Number(st.capTargetRate ?? ctx.capTargetRate ?? 0.06), 0.005, 0.5);
    // 每期只走「差距的 rate」，所以越接近目标越慢
    capTargetGrowth = clamp((tgtRev / Math.max(1, Number(f.revenue) || baseRev) - 1) * rate, -0.5, 0.5);
    growth = capTargetGrowth;
    bias = 0;
    plainRandom = false;
  }

  // 种业：营收完全由天气决定（天气全程公开，大家都知道）
  if (trait === 'weather') {
    const w = clamp(Number(ctx.weather) || 0, -1, 1);
    const swing = Math.max(0.1, Number(st.trait?.swing) || 0.5);
    // 天气决定增速，但仍然要吃规模衰减：大公司涨不快，也跌不快
    growth = w * swing * decay;
    plainRandom = false;
  }

  // 金价驱动（矿工银行）：增速 = 金价涨跌 × 系数（可预期）+ 随机浮动（不可预期）
  let goldExpected = null;
  let goldJitterAmp = 0;
  if (trait === 'gold') {
    const gr = clamp(Number(ctx.goldReturn) || 0, -0.3, 0.3);
    // 顺序：ctx（引擎下发的全局配置）→ 个股 trait（手工覆盖）→ 出厂值
    const coef = Math.max(0, Number(ctx.goldCoef ?? st.trait?.goldCoef ?? 2.2));
    const jitter = Number(ctx.goldJitter ?? st.trait?.goldJitter ?? 0.03);
    goldJitterAmp = clamp(Number.isFinite(jitter) ? jitter : 0.03, 0, 0.2);
    goldExpected = gr * coef * decay;      // 也吃规模衰减：越大越涨不动
    // 有市值目标（矿工银行 1000 亿 → 3000 亿）：目标增速是主干，金价是叠加的波动
    growth = (capTargetGrowth ?? 0) + goldExpected + rand(-goldJitterAmp, goldJitterAmp);
    bias = 0;
    plainRandom = false;
  }

  // 规模天花板：营收只能「无限接近」baseRev × growthCeiling，永远不超过。
  // 个股自己的天花板优先（麦当劳 4.5 倍），其次全局配置。
  // 剩余空间在这里就算好，预期和实际用的是同一个值。
  const ceilMult = Math.max(1.2,
    Number(st.growthCeiling) || Number(ctx.growthCeiling) || DEFAULT_GROWTH_CEILING);
  const revCeil = baseRev * ceilMult;
  const ceilRoom = Math.max(0, 1 - (Number(f.revenue) || baseRev) / revCeil);

  // 市场预期 = 这家公司按当前规模本该有的增速（不含随机噪声）。
  // ⚠️ 必须也吃掉天花板剩余空间：否则营收已经 6 倍多的票，
  // 预期 2% 而实际被压到 0.4%，每期都白挨一次「不及预期」的价格下杀。
  // 负增长不吃 room（该萎缩就萎缩，天花板只管往上）。
  const goldTotal = goldExpected !== null ? (capTargetGrowth ?? 0) + goldExpected : null;
  // 纯随机路径：市场预期 = 0（没人能猜到这个偏移），所以「意外」= 实际偏移
  let expectedGrowth = plainRandom
    ? 0
    : (goldTotal !== null
      ? clamp(goldTotal > 0 ? goldTotal * ceilRoom : goldTotal, -0.35, 0.9)
      : clamp(growth > 0 ? growth * ceilRoom : growth, -0.35, 0.9));

  // 2026-11：市场预期改成「看最近 5 期财报的走势」（拟合外推），
  // 攒够 3 期就按走势来；不够（新上市 / 老存档）才回退到上面那套模型口径。
  const trendFit = expectedGrowthFromHistory(st.reportHistory, EXPECT_LOOKBACK);
  if (trendFit) expectedGrowth = trendFit.growth;

  // 稳步增长 / 有市值目标的票：财报不抖（它们的走势是「慢慢走」，不该被随机噪声带跑）
  const smoothReport = trait === 'steady' || capTargetNow > 0;
  // 纯随机路径：偏移本身已经是随机的，不再叠加噪声（否则体量缩放会被冲掉）
  if (plainRandom) {
    // 什么都不加
  } else if (trait === 'gold') {
    // 金价股：随机浮动已经按 goldJitter 加过了，这里只补一点点
    growth += rand(-0.002, 0.002);
  } else {
    growth += smoothReport ? rand(-0.0025, 0.0025) : rand(-0.08, 0.08);
  }

  // ----- 业务联动 -----
  // 券商：全市场成交越活跃，佣金收入越高，增速越快
  if (trait === 'broker') {
    const vf = clamp(Number(ctx.volumeFactor) || 1, 0.2, 4);
    growth += clamp(vf - 1, -1, 1) * 0.10 * decay;
  }
  // 外汇：汇率波动越大，点差收入越高
  if (trait === 'fx') {
    const ff = clamp(Number(ctx.fxFactor) || 1, 0.2, 4);
    growth += clamp(ff - 1, -1, 1) * 0.08 * decay;
  }

  growth = clamp(growth, -0.35, 0.9);

  // 实际增速同样吃天花板剩余空间（负增长不受影响，该萎缩还是会萎缩）。
  // 但**纯随机路径不吃**：否则正偏移永远被削一刀，期望就变成「慢慢缩水」了；
  // 随机路径的失控由下面的 revCeil 硬夹负责。
  if (!plainRandom && growth > 0) growth *= ceilRoom;

  let margin = (Number(f.margin) || (ind.margin[0] + ind.margin[1]) / 2) + rand(-0.02, 0.02);
  // 稳步增长 / 有市值目标的公司净利率也稳（不然 ±2pp 的抖动会让 EPS 上下乱跳，PE 看着像过山车）
  if (smoothReport) {
    const midMargin = (ind.margin[0] + ind.margin[1]) / 2;
    margin = (Number(f.margin) || midMargin) * 0.88 + midMargin * 0.12 + rand(-0.001, 0.001);
  }
  // 金价高 → 矿业融资和贵金属交易的利差都更肥
  if (trait === 'gold') {
    const gr = clamp(Number(ctx.goldReturn) || 0, -0.3, 0.3);
    margin += clamp(gr * 0.1, -0.03, 0.03);
  }
  // 券商成交火爆时净利率也会抬一点
  if (trait === 'broker') {
    const vf = clamp(Number(ctx.volumeFactor) || 1, 0.2, 4);
    margin += clamp(vf - 1, -1, 1) * 0.02;
  }
  margin = clamp(margin, ind.margin[0] * 0.7, ind.margin[1] * 1.2);

  // 营收 = 存量业务（70%）+ 与业务量挂钩的部分（30%）
  // 券商看全市场成交量，外汇看汇率波动幅度：
  // 这样数字本身就体现"最近行情怎么样"，而不只是影响增速
  const prevRev = Math.max(1, Number(f.revenue) || baseRev);
  const hasVolumeLink = trait === 'broker' || trait === 'fx';
  const volumeFactor = trait === 'broker'
    ? clamp(Number(ctx.volumeFactor) || 1, 0.15, 5)
    : trait === 'fx'
      ? clamp(Number(ctx.fxFactor) || 1, 0.15, 5)
      : 1;
  // 业务量按中性 1 算时该有多少营收 → 用来定义「市场预期」
  const revenueAt = (g, volume) => (hasVolumeLink
    ? prevRev * (1 + g) * 0.7 + baseRev * 0.3 * volume
    : prevRev * (1 + g));

  let revenue = revenueAt(growth, volumeFactor);

  // 跌到基准的 25% 就不再往下掉，避免公司直接归零；涨到天花板也上不去
  const revFloor = baseRev * 0.25;
  const clampedRev = Math.min(Math.max(revenue, revFloor), revCeil);
  const bounded = Math.abs(clampedRev - revenue) > 1e-9;
  revenue = clampedRev;

  // 财报上那个「同比增速」必须是营收真实变化：
  // 以前被地板/天花板夹住时还沿用夹之前的数，于是出现「营收一动不动、同比 -35%」的假财报
  const realizedGrowth = revenue / prevRev - 1;
  growth = clamp(realizedGrowth, -0.99, 2);
  // 被夹住的时候不制造「假超预期」，否则每期都会白送一次财报冲击
  const finalExpected = bounded
    ? clamp(realizedGrowth, -0.35, 0.9)
    : expectedGrowth;

  let netProfit = revenue * margin;
  let tradePnl = 0;

  // 外汇：净利里加一块「自营盘盈亏」
  // 本金 × 杠杆 × 本期汇率涨跌，方向正确就赚，方向错了就亏
  if (trait === 'fx') {
    const lev = Math.max(0, Number(st.trait?.lev) || 8);
    const fxRet = clamp(Number(ctx.fxReturn) || 0, -0.12, 0.12);
    tradePnl = baseRev * 0.5 * fxRet * lev;
    netProfit += tradePnl;
  }

  // 允许亏损，但别亏到把公司做没了
  netProfit = Math.max(netProfit, -baseRev * 0.6);

  const eps = netProfit / shares;
  // 净资产：只留存一部分利润（其余视作分红/回购），账面虚高时缓慢回落
  let bps = nextBps(f.bps, eps, {
    pe: ind.pe,
    growth,
    // 稳定增长型：快到市值天花板时几乎不留存，否则 BPS 会一路把 fair 顶穿天花板；
    // 有市值目标的票同理（在缩表，不该再攒净资产）
    retain: ((trait === 'steady' && Number(st.capCeiling) > 0
      && (Number(st.fair) || 0) * shares >= Number(st.capCeiling) * 0.9) || capTargetNow > 0)
      ? 0.02
      : rand(BPS_RETAIN[0], BPS_RETAIN[1])
  });
  // 有市值目标的票（弦卷财团）：净资产也会一路减值到「配得上目标市值」的水平，
  // 否则 BPS×0.8 那条地板会把 fair 拖住，市值永远掉不到 5000 亿
  if (capTargetNow > 0) {
    const tgtPrice = capTargetNow / shares;
    const tgtBps = Math.max(1, (tgtPrice / 0.8) * 0.95);
    const rate = clamp(Number(st.capTargetRate ?? ctx.capTargetRate ?? 0.06), 0.005, 0.5);
    bps = bps + (tgtBps - bps) * rate;
  }
  const roe = bps > 0 ? eps / bps : 0;

  return {
    period: (Number(f.period) || 0) + 1,
    revenue,
    baseRevenue: baseRev,
    netProfit,
    tradePnl,
    eps,
    bps,
    roe,
    margin,
    growth,
    debt: clamp((Number(f.debt) || 0.4) + rand(-0.05, 0.05), 0.05, 0.9),
    dividendRate: clamp((Number(f.dividendRate) || 0.25) + rand(-0.05, 0.05), 0, 0.6),
    reportAt: Date.now(),
    bias,
    expectedGrowth: finalExpected
  };
}

/**
 * 下一期的每股净资产（BPS）。
 *
 * 只把 retain 比例的利润并进账面（其余视作分红/回购，发给场外股东）。
 * 以前是 eps × rand(0.4, 0.9) 全额留存，账面只涨不跌，
 * 「净资产底线」越垫越高，业务萎缩的公司反而越来越值钱。
 *
 * 另外，当 0.8×BPS 超过「盈利估值 × 2」时，每期以 shrink 向目标收敛，
 * 让虚高的账面慢慢回落（半衰期约 230 期），而不是一刀砍断。
 */
export function nextBps(prevBps, eps, { pe = 18, growth = 0, retain = 0.225, shrink = BOOK_SHRINK } = {}) {
  const prev = Number(prevBps) || 1;
  const e = Number(eps) || 0;
  const rate = Math.max(0, Math.min(1, shrink));
  let bps = prev + e * retain;
  const byEps = e * Number(pe) * (1 + clamp(Math.max(0, Number(growth) || 0) * 1.5, 0, 0.5));
  if (byEps > 0) {
    const capBps = (byEps * 2) / 0.8;
    if (bps > capBps) {
      // 已经超过上限：这一期不再留存（视作全部分红），只做缓慢收敛；
      // 本来在上限以下的，就直接封顶，不允许一次冲上去
      bps = prev > capBps ? prev + (capBps - prev) * rate : capBps;
    }
  }
  return Math.max(1, bps);
}

/**
 * 实际派息率（净利的多少比例分掉）。
 *
 * 按行业取现实里的水平：金融 40%、消费 45%、传媒 30%、外汇 35%、科技 12%。
 * `mult` 是后台的「派息倍率」（1 = 按行业标准，0 = 停发，2 = 全部翻倍）。
 * 于是 股息率 = 派息率 ÷ 市盈率 —— 跟现实一致：越便宜的票股息率越高。
 */
export function dividendPayout(st, mult = 1) {
  const ind = industryOf(st);
  const base = clamp(Number(ind.payout) || 0, 0, 1);
  const k = clamp(Number(mult) || 0, 0, 5);
  return clamp(base * k, 0, 1);
}

/**
 * 本期每股股息 = max(0, EPS) × 派息率，再按「现价 × 封顶比例」截断。
 * 因为封顶跟着现价走，所以这个数每轮都在变（前端显示的就是它）。
 * 亏损公司（EPS ≤ 0）不分红；派息倍率填 0 就停发。
 */
export function dividendPerShare(st, { rate = 1, cap = 0.015 } = {}) {
  const f = (st && st.fundamentals) || {};
  const eps = Math.max(0, Number(f.eps) || 0);
  const payout = dividendPayout(st, rate);
  const raw = eps * payout;
  if (!(raw > 0)) return 0;
  const price = Math.max(0, Number(st && st.price) || 0);
  const capRate = clamp(Number(cap) || 0, 0, 0.5);
  if (!(capRate > 0)) return raw;          // 封顶填 0 = 不封顶
  return Math.min(raw, price * capRate);
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
    lastSurprise: Number(st.lastSurprise) || 0,
    expectedGrowth: Number(f.expectedGrowth) || 0,
    history: (Array.isArray(st.reportHistory) ? st.reportHistory : []).map((h) => ({
      period: h.period,
      revenue: h.revenue,
      netProfit: h.netProfit,
      eps: h.eps,
      growth: h.growth,
      margin: h.margin
    }))
  };
}
