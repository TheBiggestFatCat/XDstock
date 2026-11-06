import { INDEX_BASE, SMALL_INDEX_STOCK } from './stocks.js';
import { pushBar15, BAR15_TICKS } from './bars15.js';
import { TYCOON_LEAD_TICKS, isTycoonSector, genNextReport, fairFromReport, impactFactor, industryMidGrowth, rollWeather, dividendPerShare } from './fundamentals.js';
export { TYCOON_LEAD_TICKS };
import { genMarketTrades } from './marketTrades.js';
import { logTrade } from './trading.js';
import { maskSentiment } from './mind.js';
import { now } from './store.js';

/** 公告最多留几条（超出就丢最老的） */
const NOTICE_MAX = 20;
/** 抽奖型个股（原哈基蜂业那种）盘面异动公告的固定显示时长（轮）：30 轮 = 2.5 分钟 */
export const LOTTERY_NOTICE_TICKS = 30;

/**
 * 公告是否还该显示。
 * 设了 expireTick 就按 tick 判（到期自动消失）；
 * 老公告没有这个字段，退回原来的「24 小时内可见」时间口径。
 */
export function noticeAlive(db, n) {
  if (!n) return false;
  const expire = Number(n.expireTick) || 0;
  if (expire > 0) return Number(db.tick) < expire;
  return now() - (Number(n.at) || 0) < 24 * 3600 * 1000;
}

/**
 * 发一条公告。
 * @param {number} ticks 显示时长（轮）；0 = 永久，不会自动消失
 * @param {object} extra 额外字段（比如 kind: 'up' | 'down'）
 */
export function pushNotice(db, text, ticks = 0, extra = {}) {
  if (!Array.isArray(db.notices)) db.notices = [];
  const tick = Number(db.tick) || 0;
  const dur = Math.max(0, Math.floor(Number(ticks) || 0));
  const notice = {
    id: 'n_' + Math.random().toString(36).slice(2, 10),
    text: String(text || '').slice(0, 300),
    at: now(),
    tick,
    expireTick: dur > 0 ? tick + dur : 0,
    ...extra
  };
  db.notices.push(notice);
  // 顺手清掉已经过期的，列表不会越堆越多
  db.notices = db.notices.filter((n) => noticeAlive(db, n));
  if (db.notices.length > NOTICE_MAX) {
    db.notices.splice(0, db.notices.length - NOTICE_MAX);
  }
  return notice;
}

let gaussSpare = null;
export function gauss() {
  if (gaussSpare !== null) {
    const v = gaussSpare;
    gaussSpare = null;
    return v;
  }
  let u = 0, v = 0, s = 0;
  do {
    u = Math.random() * 2 - 1;
    v = Math.random() * 2 - 1;
    s = u * u + v * v;
  } while (s === 0 || s >= 1);
  const mul = Math.sqrt((-2 * Math.log(s)) / s);
  gaussSpare = v * mul;
  return u * mul;
}

function uniform(lo, hi) {
  return lo + Math.random() * (hi - lo);
}

/**
 * 散户情绪的重掷周期（轮）：每次重掷都从 [min, max] 里重新抽一个间隔，
 * 免得所有票像上了发条一样同节奏换情绪。
 *
 * 优先级：
 *   1. 个股 trait.sentRollMin / sentRollMax（面板里能改）
 *   2. 个股老字段 trait.sentRollTicks：按 ±1/3 现推一个区间（和 migrate 口径一致）
 *   3. 全局 config.sentimentRollMin / sentimentRollMax
 *   4. 全局老字段 sentimentRollTicks（固定周期兜底）
 */
export function sentimentRollInterval(db, st) {
  const cfg = (db && db.config) || {};
  const t = (st && st.trait) || {};

  const gLegacy = Math.max(1, Math.floor(Number(cfg.sentimentRollTicks ?? 720)));
  const tLegacy = Number(t.sentRollTicks);
  const hasTLegacy = Number.isFinite(tLegacy) && tLegacy > 0;
  const derivedMin = hasTLegacy ? Math.max(1, Math.round(tLegacy * 2 / 3)) : null;
  const derivedMax = derivedMin != null ? Math.max(derivedMin, Math.round(tLegacy * 4 / 3)) : null;

  const tMin = Number(t.sentRollMin);
  const tMax = Number(t.sentRollMax);
  let min;
  let max;
  if (Number.isFinite(tMin) || Number.isFinite(tMax)) {
    // 个股显式配了区间（哪怕只配了一头）
    min = Math.max(1, Math.floor(Number.isFinite(tMin) ? tMin : tMax));
    max = Math.max(1, Math.floor(Number.isFinite(tMax) ? tMax : tMin));
  } else if (derivedMin != null) {
    min = derivedMin;
    max = derivedMax;
  } else {
    min = Math.max(1, Math.floor(Number(cfg.sentimentRollMin ?? gLegacy)));
    max = Math.max(1, Math.floor(Number(cfg.sentimentRollMax ?? gLegacy)));
  }

  if (max < min) {
    const tmp = min;
    min = max;
    max = tmp;
  }
  if (max === min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * 「情绪读心」主题用的情绪视图：当前情绪、还有多久换方向、多久推一次、方向分量。
 * 注意：情绪是引擎内部状态，只有在 me.theme === 'mind' 时才下发。
 */
export function sentimentView(st, db, player) {
  const s = (st && st.sentiment) || {};
  const tick = Number(db && db.tick) || 0;
  const cfg = (db && db.config) || {};
  const t = (st && st.trait) || {};
  // 看到的可能是假值：按这个玩家自己的准确率决定（见 src/mind.js）
  const masked = maskSentiment(st, db, player);
  return {
    v: Number(masked.v) || 0,
    fake: !!masked.fake,
    rollIn: Math.max(0, (Number(s.nextRoll) || 0) - tick),
    applyIn: Math.max(0, (Number(s.nextApply) || 0) - tick),
    every: Math.max(1, Math.floor(Number(t.sentTicks ?? cfg.sentimentTicks ?? 12))),
    drift: Number(s.drift) || 0,
    swing: Number(s.lastSwing) || 0
  };
}

/**
 * 指数成分的「实时权重」（按当前流通市值算）。
 *
 * 指数本身用的是**调仓时冻结**的权重（`db.index.weights`），这里只给前端做参考，
 * 让玩家能看出「谁被调仓冻结卡住了、谁已经涨上来了」。
 */
export function liveIndexWeights(db, indexKey = 'index') {
  const idx = indexKey === 'smallIndex' ? db.smallIndex : db.index;
  const codes = Object.keys(idx?.weights || {});
  const caps = {};
  let total = 0;
  for (const code of codes) {
    const st = db.stocks[code] || {};
    const cap = (Number(st.price) || 0) * (Number(st.shares) || 0) * (Number(st.freeFloat) || 0.45);
    if (cap > 0) {
      caps[code] = cap;
      total += cap;
    }
  }
  const out = {};
  if (total > 0) for (const [code, cap] of Object.entries(caps)) out[code] = cap / total;
  return out;
}

/** 情绪值「顶端难度」的默认值（0 = 均匀分布） */
const DEFAULT_SENT_EDGE = 3;
/** 「情绪读心」看到假值的概率（默认 50%） */
const DEFAULT_MIND_FAKE = 0.5;

/**
 * 掷一个情绪值 v ∈ [-1, 1]。
 * 原来直接 `Math.random()*2-1`（均匀），极端值 ±1 和中间值一样容易抽到；
 * 这里套一层对数把值往 0 压 —— 越接近两端越难抽，中间更容易：
 *
 *   取 r ~ 均匀(-1,1)，t = 1-|r|（0 最极端、1 最中间），
 *   |v| = 1 - ln(1 + k·t) / ln(1 + k)
 *
 * `hard`（k）= 0 退化成原来的均匀分布；k=3 时 |v| 均值 0.50 → 0.39，
 * k=9 时 → 0.32，抽到 |v| > 0.8 的概率从 20% 降到 6% / 2%。
 */
export function rollSentimentV(hard = DEFAULT_SENT_EDGE) {
  const r = Math.random() * 2 - 1;
  const k = Math.max(0, Number(hard) || 0);
  if (!(k > 0)) return r;
  const t = 1 - Math.abs(r);
  const mapped = 1 - Math.log(1 + k * t) / Math.log(1 + k);
  return (r < 0 ? -1 : 1) * Math.max(0, Math.min(1, mapped));
}

/** 整点拉升的触发窗口（分钟）：只在整点后这么多分钟内触发，错过就跳过 */
const RALLY_WINDOW_MIN = 10;
/** 有市值天花板的票，合理价最多顶到天花板的多少（剩下留给整点拉升） */
const FAIR_CAP_RATIO = 0.95;

export function rallySlotFor(st, nowMs = Date.now()) {
  const hours = Array.isArray(st?.rallyHours) ? st.rallyHours : [];
  if (!hours.length) return null;
  const d = new Date(Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now());
  const h = d.getHours();
  if (!hours.includes(h)) return null;
  if (d.getMinutes() >= RALLY_WINDOW_MIN) return null;
  const p2 = (n) => String(n).padStart(2, '0');
  const slot = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(h)}`;
  if (st.lastRallySlot === slot) return null;
  return slot;
}

/** 把一个可能越界的「小时」夹回 0~23 */
function normHour(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return ((Math.round(n) % 24) + 24) % 24;
}

/**
 * 「早市冲量」的窗口状态（个股特性 `trait.id === 'morning'`，目前是 LU 瑞幸咖啡）。
 *
 * 每天 `morningRallyStartHour` ~ `morningRallyEndHour`（服务器本地时间）之间生效：
 * 进窗口那一轮记住基准价，之后目标价按**线性斜坡**从基准涨到 基准×(1+total)，
 * 价格被「托着」往目标走 —— 不是瞬移，所以分时图上是持续的爬坡。
 *
 * @returns {{active:boolean, slot:string, progress:number}}
 *   progress：0 = 刚进窗口，1 = 窗口结束（用来算目标价）
 */
export function morningRallyWindow(cfg = {}, nowMs = Date.now()) {
  const win = (cfg && typeof cfg.morningRallyWindow === 'object' && cfg.morningRallyWindow) || cfg || {};
  if (Number(win.morningRallyEnabled ?? 1) === 0) return { active: false, slot: '', progress: 0 };
  const start = normHour(win.morningRallyStartHour, 6);
  const end = normHour(win.morningRallyEndHour, 10);
  if (start === end) return { active: false, slot: '', progress: 0 };

  const DAY = 24 * 3600 * 1000;
  const d = new Date(Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now());
  const now = d.getTime();
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();

  // 先按「今天开始的这一班」算，不中就试「昨天开始的那一班」（跨零点时凌晨属于前一班）
  let startMs = midnight + start * 3600 * 1000;
  let endMs = midnight + end * 3600 * 1000;
  if (endMs <= startMs) endMs += DAY;                       // start > end：结束在次日
  if (!(now >= startMs && now < endMs)) {
    startMs -= DAY;
    endMs -= DAY;
    if (!(now >= startMs && now < endMs)) return { active: false, slot: '', progress: 0 };
  }

  const span = Math.max(60000, endMs - startMs);
  const progress = Math.max(0, Math.min(1, (now - startMs) / span));
  const sd = new Date(startMs);
  const p2 = (n) => String(n).padStart(2, '0');
  const slot = `${sd.getFullYear()}-${p2(sd.getMonth() + 1)}-${p2(sd.getDate())}-${p2(sd.getHours())}`;
  return { active: true, slot, progress };
}

/**
 * 把「早市冲量」作用到价格上。
 *
 * 目标价 = 进窗口时的价格 × (1 + total × progress)，价格只被**往上托**：
 * 已经高于目标（比如玩家刚砸过盘又买回来）就不动，绝不主动往下压。
 * 每轮最多贴近 `pull`（对数），所以不会瞬移。
 *
 * @returns {number} 处理后的价格
 */
export function applyMorningRally(cfg, st, price, nowMs = Date.now()) {
  if (!(price > 0) || !st) return price;
  const win = morningRallyWindow(cfg, nowMs);
  if (!win.active) return price;

  const total = Number((cfg && cfg.morningRallyTotal) ?? 0.25);
  const pull = Math.max(0, Number((cfg && cfg.morningRallyPull) ?? 0.02));
  if (!(total > 0) || !(pull > 0)) return price;

  // 进窗口（或进入新的一天）→ 记这一轮的基准价
  if (st.morningSlot !== win.slot || !(Number(st.morningBase) > 0)) {
    st.morningSlot = win.slot;
    st.morningBase = price;
  }
  const base = Number(st.morningBase) || price;
  const target = base * (1 + total * win.progress);
  if (price >= target) return price;              // 只在目标价下方才托

  const step = Math.min(pull, Math.log(target / price));
  return price * Math.exp(step);
}

/** 单只股票走一步 */
function stepStock(st, cfg, events, brokerDrift, fxData, db) {
  const t = st.trait || {};
  const sigma = cfg.baseVolatility * (t.volMult ?? 1);
  let logRet = gauss() * sigma;

  if (t.drift) logRet += t.drift;

  // 新闻冲击
  let evImpact = 0;
  const globalScale = Math.max(0, Number(cfg.globalEventScale ?? 0.2));
  for (const ev of events) {
    // 不指定标的 = 全市场新闻
    const isGlobal = !(ev.companies && ev.companies.length);
    if (!isGlobal && !ev.companies.includes(st.code)) continue;
    // 全市场新闻对每只票的冲击打 2 折，否则一条顶几十条个股新闻
    evImpact += (ev.trend || 0) * (isGlobal ? globalScale : 1);
  }
  if (evImpact !== 0) {
    logRet += evImpact * (cfg.eventImpactScale ?? 1) * (t.eventMult ?? 1);
  }

  // 券商：全市场成交活跃度
  if (t.id === 'broker' && brokerDrift) logRet += brokerDrift;

  // 梗股彩票
  if (t.id === 'meme' && Math.random() < (t.lotteryChance ?? 0)) {
    logRet += Math.log(1 + uniform(t.lotteryLo ?? 0.25, t.lotteryHi ?? 0.6));
  }

  let p = st.price * Math.exp(logRet);

  // 反转王：连击
  if (t.id === 'reversal') {
    const n = t.streak ?? 3;
    if (st.streak >= n) {
      p *= 1 + uniform(t.bounceLo ?? 0.04, t.bounceHi ?? 0.08);
      st.streak = 0;
    } else if (st.streak <= -n) {
      p *= 1 - uniform(t.bounceLo ?? 0.04, t.bounceHi ?? 0.08);
      st.streak = 0;
    }
  }

  // 早市冲量（LU）：窗口内把价格往「线性斜坡目标价」上托
  if (t.id === 'morning') {
    p = applyMorningRally(cfg, st, p, Date.now());
  }

  // 护盘：跌破合理估值的比例就有买盘
  if (t.id === 'backstop' && t.floorRatio) {
    if (p < st.fair * t.floorRatio) p *= 1 + (t.floorBoost ?? 0.025);
  }

  // 汇率杠杆：股价被 AUD/JPY 牵着走
  let fxTarget = 0;
  if (t.id === 'fx') {
    const fx = fxData || {};
    const rate = Number(fx.rate) || 0;
    const base = Number(fx.base) || rate || 0;
    const coef = Number(t.coef ?? cfg.fxCoef ?? 1);
    const lev = Number(t.lev ?? cfg.fxLeverage ?? 8);
    const fxOn = Number(t.fxEnabled ?? cfg.fxEnabled ?? 1) !== 0;
    if (rate > 0 && base > 0 && fxOn) {
      // 汇率涨跌 × 系数 × 杠杆 = 股价应有的涨跌
      const implied = 1 + (rate / base - 1) * coef * lev;
      fxTarget = st.initialPrice * Math.max(0.1, implied);
      st.fxTarget = fxTarget;
      // 每轮朝目标靠一点，汇率更新时不会一根直线跳完
      const track = Math.max(0, Math.min(1, Number(t.track ?? cfg.fxTrack ?? 0.06)));
      if (track > 0 && fxTarget > 0) {
        p *= Math.exp(track * Math.log(fxTarget / p));
      }
    }
  }

  // 均值回归（对数空间）
  const k = (cfg.meanReversion ?? 0) * (t.revMult ?? 1);
  if (k > 0 && st.fair > 0 && p > 0) {
    p *= Math.exp(k * Math.log(st.fair / p));
  }

  // 散户情绪：每隔一段随机周期重掷方向，按固定间隔施加随机偏移（每只票独立）
  if (db && Number(cfg.sentimentEnabled ?? 1) !== 0) {
    const t2 = st.trait || {};
    const strength = Math.max(0, Number(t2.sentStrength ?? cfg.sentimentStrength ?? 0.004));
    const every = Math.max(1, Math.floor(Number(t2.sentTicks ?? cfg.sentimentTicks ?? 12)));
    // 方向分量：0 = 纯随机（v 只决定抖多大），1 = 纯方向（v 决定涨还是跌）
    // 个股 trait.sentDrift 可以单独覆盖全局 config.sentimentDrift
    const drift = Math.max(0, Math.min(1, Number(t2.sentDrift ?? cfg.sentimentDrift ?? 0.6)));
    // 顶端难度：越靠两端越难抽到（0 = 原来的均匀分布）
    const edge = Math.max(0, Number(t2.sentEdge ?? cfg.sentimentEdge ?? DEFAULT_SENT_EDGE));
    if (!st.sentiment || typeof st.sentiment !== 'object') {
      st.sentiment = { v: 0, nextRoll: 0, nextApply: 0 };
    }
    st.sentiment.drift = drift;
    if (!(Number(st.sentiment.nextRoll) > 0) || db.tick >= Number(st.sentiment.nextRoll)) {
      // 每次重掷都重新抽一个周期，不再固定
      const rollEvery = sentimentRollInterval(db, st);
      const realV = rollSentimentV(edge);
      // 「情绪读心」看到的假读数：每次重掷都抽一个同分布的备用值，
      // 至于谁看到它，由每个玩家自己的准确率决定（src/mind.js）
      const fakeV = rollSentimentV(edge);
      st.sentiment = {
        v: realV,
        viewV: fakeV,
        viewFake: false,
        nextRoll: db.tick + rollEvery,
        nextApply: db.tick,
        rollEvery,
        drift
      };
    }
    if (db.tick >= Number(st.sentiment.nextApply || 0)) {
      const swing = st.sentiment.v * strength * (drift + (1 - drift) * (Math.random() * 2 - 1));
      // 注意：p 在上面的 `st.price * Math.exp(logRet)` 就算好了，
      // 这里改 logRet 没用（历史 bug），必须直接作用在 p 上
      p *= Math.exp(swing);
      st.sentiment.nextApply = db.tick + every;
      st.sentiment.lastSwing = swing;
    }
  }

  // 玩家资金冲击：短时间内的大额净买入/净卖出会推着价格走
  // 流通盘越小，同样一笔钱推动得越猛
  const flow = Number(st.flow) || 0;
  if (flow !== 0 && Number(cfg.playerImpactEnabled ?? 1) !== 0) {
    const refCap = Number(cfg.impactRefFreeCap) || 0;
    const factor = refCap > 0 ? impactFactor(st, refCap) : 1;
    const strength = Number(cfg.playerImpactStrength ?? 0.0009) * factor;
    const capPerTick = Number(cfg.playerImpactMax ?? 0.008);
    // 首轮全额，后续按「后续影响倍率」打折
    const tail = st.flowFresh ? 1 : Number(cfg.playerImpactTail ?? 1);
    let impact = flow * strength * tail;
    impact = Math.max(-capPerTick, Math.min(capPerTick, impact));
    p *= 1 + impact;
    // 压力逐轮衰减，冲击是「消化掉」而不是永久抬价
    st.flow = flow * Number(cfg.playerImpactDecay ?? 0.88);
    if (Math.abs(st.flow) < 0.02) st.flow = 0;
    st.flowFresh = false;
  }

  if (!Number.isFinite(p) || p <= 0) p = st.price;
  p = Math.max(0.01, p);

  // 估值上限：价格可以炒，但永远不超过 fair × maxPremium（无限接近这条线）
  // 只压上限、不管下限——跌深了交给均值回归和护盘
  const fairNow = Number(st.fair) || 0;
  const maxPrem = Math.max(1.05, Number(cfg.maxPremium ?? 2.5));
  if (fairNow > 0) {
    const ceilP = fairNow * maxPrem;
    if (p > ceilP) p = ceilP;
  }

  // 整点拉升（麦当劳专属）：每天 12:00 / 18:00 各来一次，一次 +5%~+20%
  // 只推价格，不发公告（2026-11 按需求去掉公告，玩家从盘面自己看）
  const rallySlot = rallySlotFor(st, Date.now());
  if (rallySlot) {
    st.lastRallySlot = rallySlot;
    const lo = Math.max(0, Number(cfg.rallyMin ?? 0.05));
    const hi = Math.max(lo, Number(cfg.rallyMax ?? 0.2));
    const boost = lo + Math.random() * (hi - lo);
    p *= 1 + boost;
  }

  // 市值天花板：price × 总股本 不允许超过 capCeiling（如麦当劳 10000 亿）
  const capCeiling = Number(st.capCeiling) || 0;
  const sharesForCap = Number(st.shares) || 0;
  if (capCeiling > 0 && sharesForCap > 0) {
    const capPrice = capCeiling / sharesForCap;
    if (p > capPrice) p = capPrice;
  }

  // 连击计数
  const prev = st.price;
  if (t.id === 'reversal') {
    const move = p / prev - 1;
    if (move > 0.002) st.streak = st.streak > 0 ? st.streak + 1 : 1;
    else if (move < -0.002) st.streak = st.streak < 0 ? st.streak - 1 : -1;
    else st.streak = 0;
  }

  st.price = p;

  // ST 判定：连续低于阈值就戴帽，回到阈值上方自动摘帽
  const stPrice = Math.max(0.01, Number(cfg.stPrice ?? 3));
  if (!st.isIndex && st.status !== 'delisted') {
    if (st.price < stPrice) {
      st.stTicks = (st.stTicks || 0) + 1;
      st.st = true;
    } else {
      st.stTicks = 0;
      st.st = false;
    }
  }
}

/**
 * 新闻系统：两阶段
 *
 *   阶段一「偷跑」：5~10 轮大幅变动，此时不公布（市场莫名其妙就动了）
 *   阶段二「公布」：新闻放出后继续走完 80~200 轮
 *        · 50% 继续小幅同向
 *        · 50% 直接反转（利好发出来反而跌）
 */
export function spawnNews(db) {
  const cfg = db.config;
  const pool = db.newsPool || [];
  if (!pool.length) return null;
  if (Math.random() > (cfg.eventChance ?? 0.015)) return null;

  const tpl = pool[Math.floor(Math.random() * pool.length)];
  const dir = tpl.dir >= 0 ? 1 : -1;

  const leakTicks = Math.round(uniform(5, 10));
  const total = Math.round(uniform(80, 200));

  const ev = {
    id: 'ev_' + Math.random().toString(36).slice(2, 10),
    kind: 'leak',
    text: tpl.text,
    companies: tpl.companies || [],
    dir,
    trend: dir * uniform(0.005, 0.009),
    leakTicks,
    leakLeft: leakTicks,
    duration: total,
    remaining: total,
    createdAt: now(),
    announced: false
  };

  if (typeof ev.createdTick !== 'number') ev.createdTick = db.tick;
  db.events.push(ev);
  return ev;
}

/** 偷跑结束 → 公布新闻，掷骰子决定「继续」还是「打脸」 */
function publishEvent(e) {
  e.announced = true;
  e.kind = 'after';
  e.publishedAt = now();
  // 继续 / 反转 的概率和幅度要配平，否则每轮都有一点点净下行，
  // 积少成多会让所有股票长期阴跌（之前是 50/50，但反转幅度是继续的 2 倍）
  //   继续：60% × 平均 +0.0004 = +0.00024
  //   反转：40% × 平均 -0.0006 = -0.00024   ← 期望值正好抵消
  const keep = Math.random() < 0.6;
  if (keep) {
    e.after = 'continue';
    e.trend = e.dir * uniform(0.0003, 0.0005);
  } else {
    e.after = 'reverse';
    e.trend = -e.dir * uniform(0.0005, 0.0007);
  }
  return e;
}

/** 推进一轮 */
/**
 * 彩票倍数：涨则 ×(1+p)，跌则 ×1/(1+p) —— 两者互为倒数。
 *
 * 以前是「涨 ×(1+p) / 跌 ×(1-p)」，看着 50/50，但百分比对称会让对数收益期望
 * 恒为负（½ln(1-p²)），于是这只票不管财报多好都会长期阴跌（-1.5%/小时）。
 * 改成互为倒数后，一次涨 +p 再跌 -p 正好回到原点，期望零漂移。
 */
export function lotteryFactor(up, pct) {
  const p = Math.max(0, Math.min(1, Number(pct) || 0));
  return up ? 1 + p : 1 / (1 + p);
}

export function stepMarket(db) {
  const cfg = db.config;

  // 1. 新闻：推进阶段 + 到期清理
  const survivors = [];
  for (const e of db.events) {
    e.remaining -= 1;

    if (!e.announced) {
      e.leakLeft -= 1;
      if (e.leakLeft <= 0) publishEvent(e);
    }

    if (e.remaining > 0) survivors.push(e);
  }
  db.events = survivors;

  // 2. 券商活跃度中枢
  const trades = db.tradesThisTick || 0;
  db.tradesThisTick = 0;
  // 成交活跃度 EMA（给券商的财报用）
  const alphaV = 0.02;
  db.volumeAvg = (db.volumeAvg || trades) * (1 - alphaV) + trades * alphaV;
  // 汇率波动 EMA（给外汇的财报用）
  {
    const fx = db.fx || {};
    const r = Number(fx.rate) || 0;
    const prev = Number(fx.prevRate) || r;
    const vol = (r > 0 && prev > 0) ? Math.abs(r / prev - 1) : 0;
    db.fxVolAvg = (db.fxVolAvg || vol) * (1 - 0.1) + vol * 0.1;
  }
  const stocks = Object.values(db.stocks);
  const xd = stocks.find((s) => s.trait?.id === 'broker');
  let brokerDrift = 0;
  if (xd) {
    const alpha = cfg.brokerAlpha ?? 0.02;
    const floor = Number(cfg.brokerMidFloor ?? 0.05);
    const mid = Math.max(floor, (xd.brokerMid ?? 0.1) * (1 - alpha) + alpha * trades);
    xd.brokerMid = mid;
    const ratio = (trades + 0.1) / (mid + 0.1);
    brokerDrift = Math.max(
      -(cfg.brokerCap ?? 0.01),
      Math.min(cfg.brokerCap ?? 0.01, (cfg.brokerSensitivity ?? 0.02) * Math.log(ratio))
    );
  }

  // 3. 每只票走一步
  for (const st of stocks) {
    if (st.status !== 'normal') continue;
    if (st.isIndex) continue;   // 指数不自己走，等下面按成分算
    stepStock(st, cfg, db.events, st.trait?.id === 'broker' ? brokerDrift : 0, db.fx, db);

    st.series.push(Number(st.price.toFixed(4)));
    const cap = cfg.historyTicks ?? 3600;
    if (st.series.length > cap) st.series.splice(0, st.series.length - cap);
    // 15 分钟 K 线单独攒一份（48 小时）
    pushBar15(st.bars15, Math.floor(db.tick / BAR15_TICKS), st.price);
  }

  // 3.5 生成市场噪声成交（反映本轮的随机波动）
  genMarketTrades(db);

  // 3.58 天气股对齐（共用天气、同时发报）
  {
    let first = null;
    for (const st of stocks) {
      if (st.isIndex || st.trait?.id !== 'weather') continue;
      if (!first) {
        first = st;
      } else {
        // 天气共用
        if (db.weather) st.weather = db.weather;
        else if (first.weather) st.weather = first.weather;
        // 发报轮次对齐（取更早的那个，保证同时公布）
        const a = Number(first.nextReportTick) || 0;
        const b = Number(st.nextReportTick) || 0;
        const same = Math.min(a || b, b || a);
        if (same > 0) {
          first.nextReportTick = same;
          st.nextReportTick = same;
        }
      }
      // 目标价每只天气股都要算（第一只以前被 continue 跳过，迁移清空后就一直没目标价）
      if (!st.weather && db.weather) st.weather = db.weather;
      if (st.weather && !(Number(st.weatherTarget) > 0)) {
        const swing = Math.max(0.1, Number(st.trait?.swing) || 0.5);
        st.weatherTarget = Math.max(0.5, Number(st.fair) * (1 + st.weather.score * swing));
      }
    }
    if (!db.weather && first?.weather) db.weather = first.weather;
  }

  // 3.6 种业：市场提前向天气预期靠拢
  for (const s2 of stocks) {
    if (s2.isIndex || s2.trait?.id !== 'weather') continue;
    if (!(Number(s2.weatherTarget) > 0)) continue;
    const rate = Math.max(0, Math.min(0.05, Number(s2.trait?.anticipate) || 0.004));
    s2.fair = Number((s2.fair + (s2.weatherTarget - s2.fair) * rate).toFixed(4));
  }

  // 4. 生成新新闻
  spawnNews(db);

  // 5. 指数：权重按季度调仓，期内权重冻结
  const live = stocks.filter((s) => s.status === 'normal' && !s.isIndex);
  if (live.length) {
    const idx = db.index;
    const period = Math.max(60, Number(cfg.indexRebalanceTicks ?? 2160));
    // 有新股上市（权重表里没有它）就立刻调仓，不用等到季度末
    const missing = live.some((x) => !(Number(idx.weights?.[x.code]) > 0));
    if (!idx.weights || !idx.basePrices || !(idx.nextRebalanceTick > 0)
      || missing || db.tick >= idx.nextRebalanceTick) {
      rebalanceIndex(db, live, period);
      if (missing) console.log('[指数] 发现新成分股，已调仓纳入');
    }
    let sum = 0;
    for (const s of live) {
      const w = Number(idx.weights?.[s.code]) || 0;
      const b = Number(idx.basePrices?.[s.code]) || 0;
      if (w > 0 && b > 0) sum += w * (s.price / b);
    }
    if (sum > 0) {
      db.index.value = Number(((Number(idx.scale) || INDEX_BASE) * sum).toFixed(2));
      const idxStock = db.stocks.DENG;
      if (idxStock) {
        idxStock.price = db.index.value;
        if (!Array.isArray(idxStock.series)) idxStock.series = [];
        idxStock.series.push(db.index.value);
        if (idxStock.series.length > 3600) {
          idxStock.series.splice(0, idxStock.series.length - 3600);
        }
        pushBar15(idxStock.bars15, Math.floor(db.tick / BAR15_TICKS), db.index.value);
        idxStock.changePct = 0;
      }
    }

    // ---- 小灯指数：只编市值最小的 7 家，节奏和灯证指数一致 ----
    if (!db.smallIndex || typeof db.smallIndex !== 'object') {
      db.smallIndex = { value: INDEX_BASE, series: [INDEX_BASE] };
    }
    const sidx = db.smallIndex;
    const byCap = live
      .map((x) => ({ x, cap: x.price * (Number(x.shares) || 0) * (Number(x.freeFloat) || 0.45) }))
      .filter((o) => o.cap > 0)
      .sort((a, b) => a.cap - b.cap)
      .slice(0, 7)
      .map((o) => o.x);

    const sMissing = byCap.some((x) => !(Number(sidx.weights?.[x.code]) > 0));
    // 调仓时机完全跟着灯证指数走
    if (sMissing || db.tick === (Number(idx.rebalanceTick) || -1)
      || !sidx.weights || !(Number(sidx.nextRebalanceTick) > 0)) {
      const total = byCap.reduce(
        (a, x) => a + x.price * (Number(x.shares) || 0) * (Number(x.freeFloat) || 0.45), 0);
      if (total > 0) {
        sidx.weights = {};
        sidx.basePrices = {};
        for (const x of byCap) {
          const cap = x.price * (Number(x.shares) || 0) * (Number(x.freeFloat) || 0.45);
          sidx.weights[x.code] = cap / total;
          sidx.basePrices[x.code] = Math.max(0.01, Number(x.price) || 0.01);
        }
        sidx.scale = Number(sidx.value) > 0 ? Number(sidx.value) : INDEX_BASE;
        sidx.rebalanceTick = db.tick;
        sidx.nextRebalanceTick = Number(idx.nextRebalanceTick) || (db.tick + period);
      }
    }

    let sSum = 0;
    for (const x of byCap) {
      const w = Number(sidx.weights?.[x.code]) || 0;
      const b = Number(sidx.basePrices?.[x.code]) || 0;
      if (w > 0 && b > 0) sSum += w * (x.price / b);
    }
    if (sSum > 0) {
      sidx.value = Number(((Number(sidx.scale) || INDEX_BASE) * sSum).toFixed(2));
    }
    const sidxStock = db.stocks[SMALL_INDEX_STOCK.code];
    if (sidxStock) {
      sidxStock.price = sidx.value;
      if (!Array.isArray(sidxStock.series)) sidxStock.series = [];
      sidxStock.series.push(sidx.value);
      if (sidxStock.series.length > 3600) {
        sidxStock.series.splice(0, sidxStock.series.length - 3600);
      }
      pushBar15(sidxStock.bars15, Math.floor(db.tick / BAR15_TICKS), sidx.value);
    }
    sidx.series.push(sidx.value);
    if (sidx.series.length > 3600) sidx.series.splice(0, sidx.series.length - 3600);

  }
  db.index.series.push(db.index.value);
  const cap = cfg.historyTicks ?? 3600;
  if (db.index.series.length > cap) {
    db.index.series.splice(0, db.index.series.length - cap);
  }

  // 指数标的的价格 = 指数点位
  const idxStock = db.stocks.DENG;
  if (idxStock) {
    idxStock.price = db.index.value;
    idxStock.series.push(Number(db.index.value.toFixed(4)));
    if (idxStock.series.length > cap) {
      idxStock.series.splice(0, idxStock.series.length - cap);
    }
  }

  // 6. 财报：到点就发一期
  runReports(db);

  db.tick += 1;

  // 记下这一轮的真实时间（休市不算），K 线坐标就用它，不再靠 tick 推算
  if (!Array.isArray(db.tickTimes)) {
    db.tickTimes = [];
    db.tickTimesStart = db.tick;
  }
  db.tickTimes.push(db._simNow ?? Date.now());
  const timeCap = Math.max(600, Number(cfg.historyTicks ?? 3600) + 600);
  if (db.tickTimes.length > timeCap) {
    const drop = db.tickTimes.length - timeCap;
    db.tickTimes.splice(0, drop);
    db.tickTimesStart = (db.tickTimesStart || 0) + drop;
  }
  return brokerDrift;
}

/** 从 tick 序列聚合出 K 线（按绝对 tick 编号分桶，保证前后端一致） */
/**
 * 某个绝对 tick 对应的真实毫秒。
 * 有记录就用记录，老存档没记录时退回「起始时间 + tick × 间隔」。
 */
export function timeOfTick(db, absTick) {
  const times = db.tickTimes;
  const start = db.tickTimesStart || 0;
  if (Array.isArray(times) && times.length) {
    const idx = absTick - start;
    if (idx >= 0 && idx < times.length) return times[idx];
  }
  return (db.startedAt || 0) + absTick * (db.config.tickMs || 5000);
}

/**
 * 服务端记的真实时间轴，但把「停机造成的空洞」压掉。
 *
 * db.tickTimes 存的是每轮的真实时间戳，服务器重启/停机期间没有 tick，
 * 于是相邻两个 tick 的时间差可能是几小时。直接拿它当 K 线横轴，
 * 图上就会出现「一大段空白 + 线跳过去」的假缺口。
 *
 * 这里从最新一轮往回走，把每个间隔夹在 [0.25×tickMs, 3×tickMs] 之间：
 * 最新一根仍然是真实时间，历史空洞被压缩成正常的几格。
 *
 * @returns {{start:number, times:number[]}} times[i] 对应绝对 tick = start + i
 */
export function tickTimeAxis(db) {
  const times = Array.isArray(db.tickTimes) ? db.tickTimes : [];
  const start = Number(db.tickTimesStart) || 0;
  const step = Math.max(1000, Number(db.config?.tickMs) || 5000);
  const maxGap = step * 3;
  const minGap = Math.max(1, Math.floor(step * 0.25));
  const out = new Array(times.length);
  if (!times.length) return { start, times: out };

  let t = Number(times[times.length - 1]) || Date.now();
  out[times.length - 1] = t;
  for (let i = times.length - 2; i >= 0; i--) {
    const real = (Number(times[i + 1]) || t) - (Number(times[i]) || t);
    const gap = Math.min(Math.max(real, minGap), maxGap);
    t -= gap;
    out[i] = t;
  }
  return { start, times: out };
}

/** 时间轴查表：超出记录范围就用最后一轮 + 步长外推 */
export function timeFromAxis(axis, absTick, db) {
  const times = axis.times || [];
  const idx = Number(absTick) - Number(axis.start || 0);
  if (idx >= 0 && idx < times.length) return times[idx];
  const step = Math.max(1000, Number(db?.config?.tickMs) || 5000);
  const lastIdx = times.length - 1;
  if (lastIdx < 0) return (Number(db?.startedAt) || 0) + absTick * step;
  const lastAbs = Number(axis.start || 0) + lastIdx;
  return times[lastIdx] + (absTick - lastAbs) * step;
}

export function candlesFromSeries(series, group, tickMs, tickStart, maxCandles = 1200, baseMs = 0, timeOf = null) {
  const out = [];
  if (!series || !series.length) return out;

  let curBucket = null;
  let cur = null;
  for (let i = 0; i < series.length; i++) {
    const absTick = tickStart + i;
    const bucket = Math.floor(absTick / group);
    const v = series[i];
    if (bucket !== curBucket) {
      if (cur) out.push(cur);
      curBucket = bucket;
      const ms = timeOf ? timeOf(absTick) : (baseMs + bucket * group * tickMs);
      cur = {
        time: Math.floor(ms / 1000),
        open: v,
        high: v,
        low: v,
        close: v
      };
    } else {
      if (v > cur.high) cur.high = v;
      if (v < cur.low) cur.low = v;
      cur.close = v;
    }
  }
  if (cur) out.push(cur);

  return out.slice(-maxCandles).map((c) => ({
    time: c.time,
    open: Number(c.open.toFixed(4)),
    high: Number(c.high.toFixed(4)),
    low: Number(c.low.toFixed(4)),
    close: Number(c.close.toFixed(4))
  }));
}


/**
 * 冷启动时先空跑若干 tick，把 K 线铺满。
 * 否则刚开局图表上一根 K 线都没有，观感很差。
 */
export function seedHistory(db, ticks = 2400) {
  const realChance = db.config.eventChance;
  const stepMs = db.config.tickMs || 5000;
  const baseMs = Date.now() - ticks * stepMs;
  db.config.eventChance = 0;          // 历史里不生成新闻
  for (let i = 0; i < ticks; i++) {
    db._simNow = baseMs + i * stepMs;  // 铺历史用合成时间，保证坐标均匀
    stepMarket(db);
    db.events = [];
  }
  delete db._simNow;
  db.config.eventChance = realChance;
  db.tradesThisTick = 0;
  db.startedAt = Date.now() - db.tick * (db.config.tickMs || 5000);
}


/**
 * 按 K 线跨度算涨跌幅：取「当前 tick 往前推 N 个 tick」的价格作为基准。
 * N 就是各周期的 tick 数（1m=12, 5m=60, 15m=180, 1h=720, 4h=2880）。
 */
export function changesFor(series, tfTicks) {
  const out = {};
  if (!series || series.length < 2) {
    for (const k of Object.keys(tfTicks)) out[k] = 0;
    return out;
  }
  const last = series[series.length - 1];
  for (const [key, ticks] of Object.entries(tfTicks)) {
    const idx = Math.max(0, series.length - 1 - ticks);
    const base = series[idx];
    out[key] = base ? ((last - base) / base) * 100 : 0;
  }
  return out;
}

/** 每家公司错开发财报：间隔 reportIntervalTicks 轮 */
export function runReports(db) {
  const cfg = db.config;
  const interval = Math.max(60, Number(cfg.reportIntervalTicks ?? 720));
  const list = Object.values(db.stocks).filter((s) => !s.isIndex);
  // 本轮的派息事件（前端按人下发，不落盘）
  db.dividendEvents = [];
  if (!list.length) return;

  const gap = Math.max(1, Math.floor(interval / list.length));
  for (let i = 0; i < list.length; i++) {
    const st = list[i];
    if (st.status === 'delisted') continue;
    if (!st.nextReportTick) {
      // 错开：第 i 家在 i*gap 轮后先发
      st.nextReportTick = db.tick + gap * (i + 1);
      continue;
    }
    // 「金融大鳄」技能：**只有金融板块**（券商/外汇）提前算好下一期，
    // 有技能的玩家能在 payload 里看到 preview；没技能的看不到（服务端按 skill 过滤）。
    // 提前量取「未进化 20 / 已进化 30」里的大值，具体每个玩家能看到多少由
    // achievements.js#tycoonLeadTicks 决定（进化后多 10 轮准备时间）。
    // 发布时直接用这份 pendingReport，所以「看到什么就发什么」。
    const lead = Math.max(
      Math.max(1, Number(cfg.tycoonLeadTicks) || TYCOON_LEAD_TICKS),
      Math.max(0, Number(cfg.tycoonLeadTicksEvolved) || 0)
    );
    if (isTycoonSector(st) && !st.pendingReport && db.tick >= st.nextReportTick - lead) {
      const fxNowP = Number(db.fx?.rate) || 0;
      const fxBaseP = Number(db.fx?.reportBase) || fxNowP;
      const ctxP = {
        volumeFactor: (Number(db.volumeAvg) || 0) / 2,
        fxFactor: (Number(db.fxVolAvg) || 0) / 0.004,
        fxReturn: fxBaseP > 0 ? fxNowP / fxBaseP - 1 : 0,
        // ⚠️ 天气也要带进来：现在所有票都提前算 pendingReport，
        // 少了这一项天气股的增速会恒为 0（发报时直接用 pendingReport，不会再重算）
        weather: Number(st.weather?.score) || 0,
        growthCeiling: cfg.growthCeiling
      };
      st.pendingReport = genNextReport(st, ctxP);
    }

    if (db.tick < st.nextReportTick) continue;

    const before = Number(st.fair) || 0;
    const volumeFactor = (Number(db.volumeAvg) || 0) / 2;          // 2 笔/轮算正常
    const fxFactor = (Number(db.fxVolAvg) || 0) / 0.004;           // 0.4% 波动算正常
    // 本期汇率涨跌：以上一期财报时的汇率为基准
    const fxNow = Number(db.fx?.rate) || 0;
    const fxBase = Number(db.fx?.reportBase) || fxNow;
    const fxReturn = fxBase > 0 ? fxNow / fxBase - 1 : 0;
    st.fundamentals = st.pendingReport || genNextReport(st, {
      volumeFactor, fxFactor, fxReturn, weather: st.weather?.score || 0,
      growthCeiling: cfg.growthCeiling
    });
    // 这一期结束后，汇率基准往前推
    if (db.fx) db.fx.reportBase = fxNow;
    st.pendingReport = null;

    // 合理价：新财报算出来的值 70% + 上期 30%，避免一次财报把线拉到天上
    const computed = fairFromReport(st);
    const smoothed = before > 0 ? computed * 0.7 + before * 0.3 : computed;
    st.fair = Number(smoothed.toFixed(4));

    // 市值天花板（麦当劳 10000 亿）：合理价也只允许无限靠近，不许越过。
    // 留 5% 头给整点拉升，价格天花板在 stepStock 里另有一道硬夹
    const capCeilFair = Number(st.capCeiling) || 0;
    const sharesFair = Number(st.shares) || 0;
    if (capCeilFair > 0 && sharesFair > 0) {
      const maxFair = (capCeilFair / sharesFair) * FAIR_CAP_RATIO;
      if (st.fair > maxFair) st.fair = Number(maxFair.toFixed(4));
    }

    // 市值目标（弦卷财团：逐步萎缩到 5000 亿）：合理价也按同一节奏往目标靠，
    // 营收/净资产在 fundamentals 里已经朝目标收敛，这里再兜一道，保证终点不跑偏
    const capTgtFair = Number(st.capTarget) || 0;
    if (capTgtFair > 0 && sharesFair > 0) {
      const tgtPrice = capTgtFair / sharesFair;
      const rate = Math.max(0.005, Math.min(0.5, Number(st.capTargetRate) || 0.06));
      // 直接朝目标价收；基本面残差（EPS/净资产的取整误差）会把终点顶在目标上下一点点
      st.fair = Number((st.fair + (tgtPrice - st.fair) * rate).toFixed(4));
      // 还在目标上方时只许跌不许涨 —— 才不会出现「萎了一半又弹回去」
      if (st.fair > tgtPrice && st.fair > before) st.fair = before;
    }

    // 超预期 = 实际增速 − 市场预期（这家公司按规模应有的增速）
    const expectRaw = Number(st.fundamentals.expectedGrowth);
    const expected = Number.isFinite(expectRaw) ? expectRaw : industryMidGrowth(st);
    const diff = Number(st.fundamentals.growth) - expected;
    st.lastSurprise = Math.max(-0.3, Math.min(0.3, diff));
    st.expectedGrowth = expected;
    // 「先知」成就要判断「建仓是否早于这期发报」，所以记下发布轮次
    st.lastReportTick = db.tick;

    // 财报历史（给前端的折线图用）
    // 同一片天下的农业股，财报同时发布
    // 注意：必须用「发报后的下一期」，不能拿 st.nextReportTick（此刻还是旧的到期值），
    // 否则兄弟股会一直到期，两只票轮流每 tick 发一次财报
    if (st.trait?.id === 'weather') {
      for (const sib of Object.values(db.stocks)) {
        if (sib === st || sib.isIndex || sib.trait?.id !== 'weather') continue;
        // 还没轮到的兄弟股：直接把到期时间拉到现在，本轮跟着一起发报
        // （已经发过的不能碰，否则会被重置成「立刻到期」，下一轮又发一次）
        if (list.indexOf(sib) > list.indexOf(st)) sib.nextReportTick = db.tick;
      }
    }

    if (!Array.isArray(st.reportHistory)) st.reportHistory = [];
    // 种业：天气是全局的，所有农业股共用同一片天
    if (st.trait?.id === 'weather') {
      // 每期财报重新观测一次天气（同一轮只掷一次，兄弟股共用）。
      // 老存档的 db.weather 没有 rollTick，说明它被「一次定终身」冻住过：
      // 解冻时先归零，别用一次随机结果决定这两只票的命运。
      const w0 = db.weather;
      const legacy = !w0 || !Number.isFinite(Number(w0.rollTick));
      if (legacy) {
        db.weather = { score: 0, label: '平平无奇', rollTick: db.tick };
      } else if (Number(w0.rollTick) !== db.tick || !Number.isFinite(Number(w0.score))) {
        db.weather = { ...rollWeather(Number(w0.score)), rollTick: db.tick };
      }
      st.weather = db.weather;
      const swing = Math.max(0.1, Number(st.trait?.swing) || 0.5);
      st.weatherTarget = Math.max(0.5, Number(st.fair) * (1 + db.weather.score * swing));
    }

    st.reportHistory.push({
      period: Number(st.fundamentals.period) || 0,
      revenue: Number(st.fundamentals.revenue) || 0,
      netProfit: Number(st.fundamentals.netProfit) || 0,
      eps: Number(st.fundamentals.eps) || 0,
      growth: Number(st.fundamentals.growth) || 0,
      margin: Number(st.fundamentals.margin) || 0
    });
    if (st.reportHistory.length > 24) {
      st.reportHistory.splice(0, st.reportHistory.length - 24);
    }
    st.nextReportTick = db.tick + interval;

    // 派息：本期 EPS × 行业派息率（× 后台倍率），再按现价封顶。
    // 只发给「持满一期」的仓位（本期才开的仓不参与），免得财报前买入、发完就卖白拿；
    // 空头补息（现实规则），现金不够就扣到 0，不追缴。
    // 派完立刻除权：股价下调相同的每股金额，多头拿现金、持仓市值同额下跌，总资产不变。
    const dps = dividendPerShare(st, { rate: cfg.dividendRate, cap: cfg.dividendCap });
    if (dps > 0) {
      const since = db.tick - interval;
      let paidTotal = 0;
      for (const p of Object.values(db.players || {})) {
        const pos = p.positions ? p.positions[st.code] : null;
        if (!pos || !(Number(pos.qty) > 0)) continue;
        if (Number(pos.openedTick) > since) continue;
        const amt = Number(pos.qty) * dps;
        if (!(amt > 0)) continue;
        if (pos.side === 'long') {
          p.cash = (Number(p.cash) || 0) + amt;
          p.dividendEarned = (Number(p.dividendEarned) || 0) + amt;
          paidTotal += amt;
          db.dividendEvents.push({
            playerId: p.id, code: st.code, name: st.name, dps, side: 'long', amount: amt, tick: db.tick
          });
          // 同时写进交易记录（不然玩家只能看到一条一闪而过的提示）
          logTrade(db, {
            playerId: p.id, nickname: p.nickname, action: 'dividend',
            code: st.code, name: st.name, side: 'long',
            qty: Number(pos.qty), price: dps, leverage: 1,
            amount: amt, fee: 0, stamp: 0, impact: 0, margin: 0,
            pnl: amt, reason: 'dividend'
          });
        } else {
          const pay = Math.min(amt, Math.max(0, Number(p.cash) || 0));
          if (pay > 0) {
            p.cash = Number(p.cash) - pay;
            p.dividendEarned = (Number(p.dividendEarned) || 0) - pay;
            db.dividendEvents.push({
              playerId: p.id, code: st.code, name: st.name, dps, side: 'short', amount: -pay, tick: db.tick
            });
            logTrade(db, {
              playerId: p.id, nickname: p.nickname, action: 'dividend',
              code: st.code, name: st.name, side: 'short',
              qty: Number(pos.qty), price: dps, leverage: 1,
              amount: -pay, fee: 0, stamp: 0, impact: 0, margin: 0,
              pnl: -pay, reason: 'dividend'
            });
          }
        }
      }
      // 除权（除息）：所有股份一起下调，不管有没有人持有
      const exPrice = Math.max(0.01, Number((Number(st.price) - dps).toFixed(4)));
      st.price = exPrice;
      if (paidTotal > 0) {
        const shown = paidTotal >= 1e8 ? (paidTotal / 1e8).toFixed(2) + ' 亿'
          : paidTotal >= 1e4 ? (paidTotal / 1e4).toFixed(1) + ' 万'
            : Math.round(paidTotal) + ' 元';
        pushNotice(
          db,
          `${st.name}派息 ${dps.toFixed(2)} 元/股，合计派发 ${shown}（除权价 ${exPrice.toFixed(2)}）`,
          30,
          { kind: 'up' }
        );
      }
    }

    // 财报当期的价格冲击：超预期就上冲/下杀
    const surprise = st.lastSurprise;
    const shock = Math.max(-0.06, Math.min(0.06, surprise * 0.8));
    if (Number.isFinite(shock) && Math.abs(shock) > 0.0005) {
      st.price = Number((st.price * (1 + shock)).toFixed(4));
    }

    // 挂一条新闻，让所有人知道
    const f = st.fundamentals;
    const verdict = surprise > 0.02 ? '超预期' : surprise < -0.02 ? '不及预期' : '符合预期';
    const good = surprise > 0.02;
    db.events.push({
      id: 'ev_' + Math.random().toString(36).slice(2, 10),
      kind: 'after',
      text: `${st.name}发${f.period}季报：营收${fmtYi(f.revenue)}，净利${fmtYi(f.netProfit)}，`
        + `同比${(f.growth * 100).toFixed(1)}%，市场预期${(expected * 100).toFixed(1)}%，${verdict}`,
      companies: [st.code],
      dir: good ? 1 : -1,
      trend: 0,
      duration: 40,
      remaining: 40,
      createdAt: Date.now(),
      createdTick: db.tick,
      announced: true,
      isReport: true
    });
    if (db.events.length > 40) db.events.shift();
  }
}

function fmtYi(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(2) + '万';
  return n.toFixed(0);
}


/**
 * 指数季度调仓：按流通市值定权重，记下期初价和期初点位，期内权重冻结。
 */
export function rebalanceIndex(db, live, period) {
  const idx = db.index;
  const caps = {};
  let total = 0;
  for (const s of live) {
    const sh = Number(s.shares) || 0;
    const ff = Number(s.freeFloat) || 0.45;
    const cap = s.price * sh * ff;
    if (cap > 0) { caps[s.code] = cap; total += cap; }
  }
  if (!(total > 0)) return;
  const weights = {};
  for (const code of Object.keys(caps)) weights[code] = caps[code] / total;
  const basePrices = {};
  for (const s of live) basePrices[s.code] = Math.max(0.01, Number(s.price) || 0.01);
  idx.weights = weights;
  idx.basePrices = basePrices;
  idx.scale = Number(idx.value) > 0 ? Number(idx.value) : 1000;
  idx.rebalanceTick = db.tick;
  idx.nextRebalanceTick = db.tick + period;
}
