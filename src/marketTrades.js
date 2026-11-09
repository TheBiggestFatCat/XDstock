/**
 * 市场噪声成交（成交记录里那些带小动物头像的「虚假成交」）
 *
 * 2026-11 改版：**不再只是装饰，会真的推动股价**。
 *
 *   - 金额分三档，越低档出现频率越高（频率是管理面板里的三个权重，自动归一化）
 *       一档  1 万 ~   10 万
 *       二档 10 万 ~  100 万
 *       三档 100 万 ~ 1000 万
 *   - 方向跟着本轮涨跌走：涨了偏买（marketTradesChase 追涨系数）、
 *     跌了偏卖（marketTradesPanic 杀跌系数），两个系数分开调可以做非对称手感
 *   - 成交额通过 trading.js#addMarketFlow 记进 st.mflow（市场资金通道），
 *     由 engine.js#stepStock 逐轮释放到价格上；指数标的按权重拆给成分股
 *
 * 昵称和头像池跟「游资」（src/hotmoney.js）共用 marketIdentity()，
 * 两种资金来源在成交记录里长得完全一样，玩家分不出来。
 */

import { addMarketFlow, addVolume, indexWeights } from './trading.js';
import { freeCap } from './fundamentals.js';

/** 散户昵称池（虚假成交 / 游资共用） */
export const MARKET_NAMES = [
  '散户老王', '追涨杀跌', '北向资金', '游资小李', '量化打板', '值班交易员',
  '长线阿姨', '梭哈哥', '割肉侠', '抄底王', '打新中签', '融资客',
  '隔壁老张', '机构通道', '小仓位试水', '尾盘偷袭', '日内高手', '躺平持仓',
  '私募三号', '网格交易', '追梦少年', '老韭菜', '技术流', '躺赢选手'
];

/** 小动物头像池（虚假成交 / 游资共用） */
export const MARKET_EMOJIS = [
  '🦊', '🐯', '🐼', '🐸', '🐵', '🦁', '🐺', '🐷', '🐨', '🦉',
  '🐙', '🦈', '🐲', '🦄', '🐢', '🦅', '🐳', '🦖', '🐝', '🦔'
];

/** 三档金额（元）：越低档越常见 */
export const MARKET_TIERS = [
  { key: 'small', lo: 10000, hi: 100000 },
  { key: 'mid', lo: 100000, hi: 1000000 },
  { key: 'big', lo: 1000000, hi: 10000000 }
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (a, b) => a + Math.random() * (b - a);
const rand01 = (f) => {
  const v = Number(typeof f === 'function' ? f() : f);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(0.999999999, v));
};

/** 三档的权重（读 config，自动归一化；三个都填 0 时退化成等概率） */
export function marketTierWeights(cfg = {}) {
  const raw = [
    Number(cfg.marketTradesSmallP ?? 70),
    Number(cfg.marketTradesMidP ?? 24),
    Number(cfg.marketTradesBigP ?? 6)
  ].map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const sum = raw.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return [1 / 3, 1 / 3, 1 / 3];
  return raw.map((v) => v / sum);
}

/**
 * 按权重抽一档，再在档内均匀抽一个金额。
 * @returns {{tier:string, lo:number, hi:number, notional:number}}
 */
export function pickMarketNotional(cfg = {}, rnd = Math.random) {
  const w = marketTierWeights(cfg);
  const r = rand01(rnd);
  let acc = 0;
  let idx = w.length - 1;
  for (let i = 0; i < w.length; i++) {
    acc += w[i];
    if (r < acc) { idx = i; break; }
  }
  const t = MARKET_TIERS[idx];
  const notional = t.lo + rand01(rnd) * (t.hi - t.lo);
  return { tier: t.key, lo: t.lo, hi: t.hi, notional };
}

const coefOf = (v, fb) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fb;
};

/**
 * 这一笔「偏向买入」的概率（0.1~0.9，0.5 = 买卖各半）。
 *
 * 2026-11 改版：信号从「本轮 vs 上一轮」换成**最近 `marketTradesWindow` 轮的涨跌幅**
 * （默认 12 轮 = 1 分钟）。单轮噪声有 0.5%~1%，按单轮判定基本帧帧打满；
 * 1 分钟动量把噪声摊平，触发一次能维持约一分钟，也不会被自己的单轮冲击带跑。
 *
 * 三段式响应，专门防「追涨杀跌刹不住车」：
 *   1. **死区**：`|chg| < 1 档` → 不偏（0.5），小抖动不触发
 *   2. **线性**：1 档 → 0 偏移，2 档 → 满幅（追涨/杀跌系数）
 *   3. **过热回落**：> 3 档开始减弱、≥ 5 档归零 —— 短时间涨太多反而没人敢追
 *
 * 另外按 `pressure`（该票当前市场资金压力 |st.mflow|）自限幅：已经被市场资金推得很狠的票，
 * 偏向再乘 `1 - 0.6×busy`，避免「自己推自己」越推越猛。
 *
 * @param {number} chg 窗口内涨跌幅（小数，0.03 = 3%）
 * @param {object} cfg db.config
 * @param {number} pressure 该票当前的市场资金压力（st.mflow，单位）
 * @returns {number} 买入概率
 */
export function marketBuyProb(chg, cfg = {}, pressure = 0) {
  const c = Number.isFinite(Number(chg)) ? Number(chg) : 0;
  const chase = coefOf(cfg.marketTradesChase, 25);
  const panic = coefOf(cfg.marketTradesPanic, chase);
  const trigRaw = Number(cfg.marketTradesTrigger);
  const trig = Number.isFinite(trigRaw) && trigRaw > 0 ? trigRaw : 0.03;
  const coef = (c >= 0 ? chase : panic) / 100;

  const steps = Math.abs(c) / trig;            // 涨跌了「几档」
  if (steps < 1) return 0.5;                   // 死区

  let amp;
  if (steps <= 2) amp = steps - 1;             // 1~2 档：线性到满幅
  else if (steps <= 3) amp = 1;                // 2~3 档：满幅
  else amp = Math.max(0, 1 - (steps - 3) / 2); // 3~5 档：过热回落

  // 已经推得很狠的票不再追（|压力| ≥ 2 单位时只剩 40%）
  const busy = Math.min(1, Math.abs(Number(pressure) || 0) / 2);
  amp *= 1 - 0.6 * busy;

  const bias = amp * coef;
  const p = c >= 0 ? 0.5 + bias : 0.5 - bias;
  return Math.max(0.1, Math.min(0.9, p));
}

/**
 * 判定用的涨跌幅：最近 `windowTicks` 轮的涨跌幅。
 * 历史不够就用最早能给的那一格（比如刚上市的票）；不足两格返回 0。
 */
export function marketWindowChange(series, windowTicks) {
  const ser = Array.isArray(series) ? series : [];
  const w = Math.max(1, Math.floor(Number(windowTicks) || 12));
  if (ser.length < 2) return 0;
  const now = Number(ser[ser.length - 1]);
  const back = Number(ser[Math.max(0, ser.length - 1 - w)]);
  if (!(back > 0) || !Number.isFinite(now)) return 0;
  return now / back - 1;
}

/**
 * 统一的「散户身份」：虚假成交和游资共用，成交记录里看起来没有区别。
 * rnd 可注入，方便测试拿到确定性结果。
 */
export function marketIdentity(rnd = Math.random) {
  const pickWith = (arr) => arr[Math.floor(rand01(rnd) * arr.length) % arr.length];
  return { nickname: pickWith(MARKET_NAMES), emoji: pickWith(MARKET_EMOJIS) };
}

const num = (v, fb) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
};

/**
 * 一只票本轮「该分到多少虚假成交」的权重（2026-11 新增：散户情绪落地）
 *
 * 原来 9 笔成交在 12 只票里**均匀**抽 → 大票小票各 ~0.75 笔，
 * 但同样金额对大票（流通 2594 亿）几乎推不动、对小票（126 亿）能推 5 倍。
 * 现在按**流通市值**分配笔数：市值大的票成交笔数多，单笔金额不变，
 * 于是各票「总成交额 / 流通市值」接近 → 推动力接近，手感一致。
 *
 * 情绪再加两层：
 *   1. 方向：st.sentiment.v ∈ [-1,1]，正=散户看多 → 买盘概率 +
 *   2. 放量：|v| 越大这笔票的成交笔数越多（散户越兴奋越爱交易）
 *
 * 个股可以在「个股 → 每只票」里覆盖：mktSizeScale / mktSentBias / mktSentVol，
 * 留空就跟随全局 marketTradesSizeExp / marketTradesSentBias / marketTradesSentVol。
 */
/** 情绪放量系数：|v|=1 时这只票的成交笔数 ×(1 + sentVol/100) */
export function marketSentimentVolume(st, cfg = {}) {
  const t = st.trait || {};
  const sentVol = Math.max(0, num(t.mktSentVol ?? cfg.marketTradesSentVol, 60)) / 100;
  const v = Math.min(1, Math.abs(num(st.sentiment?.v, 0)));
  return 1 + sentVol * v;
}

export function marketTradeWeight(st, cfg = {}) {
  const t = st.trait || {};
  const exp = Math.max(0, Math.min(2, num(t.mktSizeExp ?? cfg.marketTradesSizeExp, 1)));
  const sizeScale = Math.max(0, num(t.mktSizeScale, 1));
  // 流通市值（元）→ 相对权重；exp=0 时退化成「所有票一样重」（老行为）
  const cap = Math.max(1, freeCap(st));
  const capW = exp === 0 ? 1 : Math.pow(cap / 1e8, exp);   // 以「亿」为单位，数字不会太夸张
  // 情绪放量：除了让这只票占更大份额，还会把总笔数一起抬高（见下面的 avgSent）
  return capW * sizeScale * marketSentimentVolume(st, cfg);
}

/**
 * 指数当虚假成交标的时的权重。
 *
 * 指数本身没有 shares（freeCap ≈ 0），老逻辑里权重恒为 0 → 指数永远抽不到，
 * 于是「指数的虚假成交」整段没了。这里用**成分股流通市值之和**当它的体量，
 * 再乘 `indexTradeScale`（默认 0.15）控制占比。
 */
export function indexTradeWeight(db, st, cfg = {}) {
  const scale = Number(cfg.indexTradeScale ?? 0.15);
  if (!(scale > 0)) return 0;
  const key = st.code === 'DENGS' ? 'smallIndex' : 'index';
  let cap = 0;
  let sentSum = 0;
  let n = 0;
  for (const { st: member, weight } of indexWeights(db, key)) {
    if (!(weight > 0)) continue;
    cap += freeCap(member);
    sentSum += marketSentimentVolume(member, cfg);
    n += 1;
  }
  if (!n) return 0;
  const exp = Math.max(0, Math.min(2, num(cfg.marketTradesSizeExp, 1)));
  const capW = exp === 0 ? 1 : Math.pow(cap / 1e8, exp);
  const avgSent = sentSum / n;
  return capW * scale * avgSent;
}

/** 情绪对方向的影响（百分点）：正=偏买，负=偏卖 */
export function marketSentimentBias(st, cfg = {}) {
  const t = st.trait || {};
  const bias = num(t.mktSentBias ?? cfg.marketTradesSentBias, 25);
  const v = Math.max(-1, Math.min(1, num(st.sentiment?.v, 0)));
  return (bias / 100) * v;
}

/** 按权重抽一只票（权重全 0 时退回均匀） */
function pickWeighted(list, weights, rnd = Math.random) {
  let sum = 0;
  for (const w of weights) sum += w;
  if (!(sum > 0)) return list[Math.floor(rand01(rnd) * list.length) % list.length];
  let r = rand01(rnd) * sum;
  for (let i = 0; i < list.length; i++) {
    r -= weights[i];
    if (r <= 0) return list[i];
  }
  return list[list.length - 1];
}

/**
 * 生成 1~2 笔（× 倍率）虚假成交并写进流水，同时给对应股票加市场资金压力。
 * @param {object} db
 * @param {number} maxTrades 本轮最多几笔（不含倍率）
 */
export function genMarketTrades(db, maxTrades = 2) {
  if (!Array.isArray(db.trades)) db.trades = [];
  const cfg = db.config || {};
  if (Number(cfg.marketTradesEnabled ?? 1) === 0) return [];

  // 指数也算（DENG / DENGS 也要有散户在交易）
  const list = Object.values(db.stocks).filter((s) => s.status === 'normal');
  if (!list.length) return [];

  const rate = Math.max(0, Number(cfg.marketTradesRate ?? 3));
  // 倍率 0 = 彻底关掉这一项（以前还会硬编 1 笔，等于关不掉）
  if (!(rate > 0)) return [];

  // 情绪放量：全市场平均「兴奋度」会抬高总笔数（v 全 0 时 = 1，不动）
  const avgSent = list.reduce((a, s) => a + marketSentimentVolume(s, cfg), 0) / list.length;
  // 开盘巨量：休市结束后的第一轮按倍率放大（0/1 = 不放量），标记只消费一次
  const surgeRaw = db.reopenSurge ? Number(cfg.reopenSurgeMult ?? 3) : 1;
  const surge = Number.isFinite(surgeRaw) && surgeRaw > 1 ? Math.min(10, surgeRaw) : 1;
  if (db.reopenSurge) db.reopenSurge = false;
  const base = Math.max(1, Math.round(rand(1, maxTrades) * rate * avgSent * surge));

  // 每只票的成交权重（市值 × 个股倍率 × 情绪放量），每轮算一次
  // 指数单独算：用成分股流通市值之和 × indexTradeScale，否则它永远抽不到
  const weights = list.map((s) => (s.isIndex
    ? indexTradeWeight(db, s, cfg)
    : marketTradeWeight(s, cfg)));
  const weightedPicker = () => pickWeighted(list, weights);

  const out = [];
  for (let i = 0; i < base; i++) {
    const st = weightedPicker();
    // 判定参数：个股 trait 里有覆盖就用个股的（管理面板「个股 → 每只票」里填），否则跟随全局
    const eff = {
      marketTradesWindow: st.trait?.mktWindow ?? cfg.marketTradesWindow,
      marketTradesTrigger: st.trait?.mktTrigger ?? cfg.marketTradesTrigger,
      marketTradesChase: st.trait?.mktChase ?? cfg.marketTradesChase,
      marketTradesPanic: st.trait?.mktPanic ?? cfg.marketTradesPanic
    };
    const ser = st.series || [];
    const win = Number(eff.marketTradesWindow) || 12;
    const prev = ser.length > 1 ? ser[ser.length - 2] : st.price;
    const chg = marketWindowChange(ser, win) || (prev > 0 ? st.price / prev - 1 : 0);

    // 涨了偏买（追涨），跌了偏卖（杀跌）；pressure = 这只票当前的市场资金压力，越大越不追
    // 再叠加散户情绪：看多 → 买盘概率更高，看空 → 卖盘更高（个股可覆盖）
    const sentBias = marketSentimentBias(st, cfg);
    const buyProb = Math.max(0.1, Math.min(0.9, marketBuyProb(chg, eff, st.mflow) + sentBias));
    const isBuy = Math.random() < buyProb;

    // 三档金额：越低档越常见
    const { tier, notional } = pickMarketNotional(cfg);
    const price = Math.max(0.01, Number(st.price) || 0.01);
    const qty = Math.max(1, Math.floor(notional / price));
    const tradedNotional = qty * Number(price.toFixed(2));

    const { nickname, emoji } = marketIdentity();
    const row = {
      id: 'mk_' + Math.random().toString(36).slice(2, 10),
      at: Date.now(),
      code: st.code,
      name: st.name,
      action: 'open',
      side: isBuy ? 'long' : 'short',
      qty,
      price: Number(price.toFixed(2)),
      leverage: Math.round(rand(1, 10)),
      fee: 0,
      stampDuty: 0,
      margin: 0,
      impact: 0,
      reason: 'market',
      playerId: 'mkt_' + (i + 1),
      nickname,
      emoji,
      isMarket: true,
      tier
    };
    out.push(row);

    // 真的推动股价：买入推高、卖出压低
    addMarketFlow(db, st, isBuy ? tradedNotional : -tradedNotional);
  }

  db.trades.push(...out);
  // 成交量：指数上的单子按权重拆给成分股（addVolume 内部处理）
  for (const row of out) addVolume(db, row.code, row.qty);
  const cap = Number(cfg.tradeLogMax) || 3000;
  if (db.trades.length > cap) db.trades.splice(0, db.trades.length - cap);
  return out;
}
