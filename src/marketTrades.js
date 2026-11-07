/**
 * 市场噪声成交（成交记录里那些带小动物头像的「虚假成交」）
 *
 * 2026-11 改版：**不再只是装饰，会真的推动股价**。
 *
 *   - 金额分三档，越低档出现频率越高（频率是管理面板里的三个权重，自动归一化）
 *       一档  1 万 ~   10 万
 *       二档 10 万 ~  100 万
 *       三档 100 万 ~ 1000 万
 *   - 方向跟着本轮涨跌走：涨了偏买、跌了偏卖（追涨系数 marketTradesChase 可调）
 *   - 成交额通过 trading.js#addMarketFlow 记进 st.mflow（市场资金通道），
 *     由 engine.js#stepStock 逐轮释放到价格上；指数标的按权重拆给成分股
 *
 * 昵称和头像池跟「游资」（src/hotmoney.js）共用 marketIdentity()，
 * 两种资金来源在成交记录里长得完全一样，玩家分不出来。
 */

import { addMarketFlow } from './trading.js';

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

/**
 * 统一的「散户身份」：虚假成交和游资共用，成交记录里看起来没有区别。
 * rnd 可注入，方便测试拿到确定性结果。
 */
export function marketIdentity(rnd = Math.random) {
  const pickWith = (arr) => arr[Math.floor(rand01(rnd) * arr.length) % arr.length];
  return { nickname: pickWith(MARKET_NAMES), emoji: pickWith(MARKET_EMOJIS) };
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

  const base = Math.max(1, Math.round(rand(1, maxTrades) * rate));
  // 追涨系数：越大越跟着本轮涨跌下单（0 = 买卖各半）
  const chaseRaw = Number(cfg.marketTradesChase);
  const chase = Number.isFinite(chaseRaw) && chaseRaw >= 0 ? chaseRaw : 25;

  const out = [];
  for (let i = 0; i < base; i++) {
    const st = pick(list);
    const ser = st.series || [];
    const prev = ser.length > 1 ? ser[ser.length - 2] : st.price;
    const chg = prev > 0 ? (st.price / prev - 1) : 0;

    // 涨了偏买，跌了偏卖
    const buyProb = Math.max(0.1, Math.min(0.9, 0.5 + chg * chase));
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
  const cap = Number(cfg.tradeLogMax) || 3000;
  if (db.trades.length > cap) db.trades.splice(0, db.trades.length - cap);
  return out;
}
