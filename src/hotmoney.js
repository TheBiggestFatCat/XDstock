/**
 * 游资资金（2026-11 新增）
 *
 * 一群「游资」在板块之间轮动：在一只票上买入 → 待 20~300 轮 → 换到别的板块，
 * 先把旧的卖掉、再在新板块里买一只。每一笔 1000 万 ~ 3000 万的资金，
 * 通过 trading.js#addMarketFlow 记进 st.mflow，由引擎逐轮释放在价格上。
 *
 * 设计要点：
 *   - **前端不需要任何新展示**：游资的成交记录混在「虚假成交」里，
 *     昵称 / 小动物头像共用 marketIdentity()，玩家看不出区别
 *     （内部用 row.hot = true 标记，这个字段不下发前端）
 *   - **板块** = 股票的 industry 字段（消费娱乐 / 科技AI / 金融 …），
 *     换板块时优先挑一个和当前不同的板块，只有一个板块时就在原地换票
 *   - 状态存在 db.hotMoney（code / industry / nextSwitchTick / switches），
 *     老存档由 store.js#migrate 补上，引擎每轮调 stepHotMoney()
 */

import { addMarketFlow, logTrade } from './trading.js';
import { marketIdentity } from './marketTrades.js';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand01 = (f) => clamp(Number(typeof f === 'function' ? f() : f) || 0, 0, 0.999999999);

/** 按 industry 分组：{ 板块名: [可交易的个股...] }（指数不算） */
export function hotMoneySectors(db) {
  const out = new Map();
  for (const st of Object.values(db?.stocks || {})) {
    if (!st || st.isIndex) continue;
    if (st.status !== 'normal') continue;
    const key = String(st.industry || '其他');
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(st);
  }
  return out;
}

/** 补齐游资状态（老存档 / 新存档都走这里）。原地补字段，保持对象引用不变 */
export function ensureHotMoney(db) {
  if (!db || typeof db !== 'object') return null;
  if (!db.hotMoney || typeof db.hotMoney !== 'object') db.hotMoney = {};
  const hm = db.hotMoney;
  hm.code = typeof hm.code === 'string' ? hm.code : '';
  hm.industry = typeof hm.industry === 'string' ? hm.industry : '';
  hm.nextSwitchTick = Math.max(0, Math.floor(num(hm.nextSwitchTick, 0)));
  hm.switches = Math.max(0, Math.floor(num(hm.switches, 0)));
  hm.startedTick = Math.max(0, Math.floor(num(hm.startedTick, 0)));
  return hm;
}

/** 换板块的间隔（轮）：[hotMoneySwitchMin, hotMoneySwitchMax] 闭区间随机 */
export function hotMoneySwitchInterval(cfg = {}, rnd = Math.random) {
  const lo = Math.max(1, Math.round(num(cfg.hotMoneySwitchMin, 20)));
  const hi = Math.max(lo, Math.round(num(cfg.hotMoneySwitchMax, 300)));
  return lo + Math.floor(rand01(rnd) * (hi - lo + 1));
}

/** 每一笔的金额（元）：[hotMoneyMin, hotMoneyMax] 随机 */
export function hotMoneyAmount(cfg = {}, rnd = Math.random) {
  const lo = Math.max(1, num(cfg.hotMoneyMin, 10000000));
  const hi = Math.max(lo, num(cfg.hotMoneyMax, 30000000));
  return lo + rand01(rnd) * (hi - lo);
}

/**
 * 写一条游资成交（和虚假成交同款字段，只有内部标记 hot 不同）
 * @returns {object} 写进去的那一行
 */
function pushHotTrade(db, st, { action, qty, rnd }) {
  const { nickname, emoji } = marketIdentity(rnd);
  const row = {
    id: 'hm_' + Math.random().toString(36).slice(2, 10),
    at: Date.now(),
    code: st.code,
    name: st.name,
    action,
    side: 'long',
    qty,
    price: Number((Number(st.price) || 0.01).toFixed(2)),
    // 杠杆随机 1~10，和虚假成交一样，看不出是同一路资金
    leverage: 1 + Math.floor(rand01(rnd) * 10),
    fee: 0,
    stampDuty: 0,
    margin: 0,
    impact: 0,
    reason: 'market',
    // playerId 也用 mkt_ 前缀：/api/stock-trades 会下发这个字段，别露馅
    playerId: 'mkt_' + (1 + Math.floor(rand01(rnd) * 3)),
    nickname,
    emoji,
    isMarket: true,
    hot: true   // 内部标记，不下发前端
  };
  logTrade(db, row);
  return row;
}

/**
 * 走到点就换板块：卖旧 → 挑新板块 → 买新。
 * 没到换的时候（或者被关掉）返回 null。
 *
 * @param {object} db
 * @param {{rand?: function}} [opts] 测试可以注入确定性随机数
 * @returns {{sold: object|null, bought: object|null, industry: string, code: string}|null}
 */
export function stepHotMoney(db, opts = {}) {
  const cfg = db?.config || {};
  if (Number(cfg.hotMoneyEnabled ?? 1) === 0) return null;
  const hm = ensureHotMoney(db);
  if (!hm) return null;

  // 手里有票、还没到换的时候 → 什么都不做
  const tick = num(db.tick, 0);
  if (hm.code && tick < hm.nextSwitchTick) return null;

  const sectors = hotMoneySectors(db);
  const keys = [...sectors.keys()];
  if (!keys.length) return null;

  const rnd = typeof opts.rand === 'function' ? opts.rand : Math.random;
  const out = { sold: null, bought: null, industry: '', code: '' };
  if (!hm.startedTick) hm.startedTick = tick;

  // 1) 换板块 = 先撤掉上一只票的仓位（卖出压低价格）
  if (hm.code) {
    const prev = db.stocks[hm.code];
    if (prev && prev.status === 'normal' && Number(prev.price) > 0) {
      const amount = hotMoneyAmount(cfg, rnd);
      const qty = Math.max(1, Math.floor(amount / Number(prev.price)));
      out.sold = pushHotTrade(db, prev, { action: 'close', qty, rnd });
      addMarketFlow(db, prev, -(qty * Number(prev.price)));
    }
  }

  // 2) 挑一个和当前不同的板块（只有一个板块时就在原地换）
  const others = keys.filter((k) => k !== hm.industry);
  const pool = others.length ? others : keys;
  const industry = pool[Math.floor(rand01(rnd) * pool.length) % pool.length];
  const list = sectors.get(industry) || [];
  if (!list.length) {
    // 极端情况：板块里的票全停牌了，下一轮再试
    hm.code = '';
    hm.industry = '';
    hm.nextSwitchTick = tick + 1;
    return out;
  }

  // 3) 在新板块里买一只（买入推高价格）
  const st = list[Math.floor(rand01(rnd) * list.length) % list.length];
  const amount = hotMoneyAmount(cfg, rnd);
  const qty = Math.max(1, Math.floor(amount / Math.max(0.01, Number(st.price) || 0.01)));
  out.bought = pushHotTrade(db, st, { action: 'open', qty, rnd });
  addMarketFlow(db, st, qty * Number(st.price));

  hm.code = st.code;
  hm.industry = industry;
  hm.switches += 1;
  hm.nextSwitchTick = tick + hotMoneySwitchInterval(cfg, rnd);
  out.industry = industry;
  out.code = st.code;
  return out;
}

/** 给管理面板 / 排查用的一行摘要 */
export function hotMoneyInfo(db) {
  const hm = ensureHotMoney(db);
  if (!hm) return null;
  const st = hm.code ? db.stocks[hm.code] : null;
  return {
    code: hm.code,
    name: st ? st.name : '',
    industry: hm.industry,
    switches: hm.switches,
    leftTicks: Math.max(0, hm.nextSwitchTick - num(db.tick, 0))
  };
}
