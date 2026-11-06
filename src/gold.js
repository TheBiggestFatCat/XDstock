// 金价：矿工银行（MB）的财报驱动源
//
// 设计取舍：
//   - 不接外部接口。游戏一轮 5 秒、财报 720 轮（1 小时），而真实金价一小时
//     基本不动，接真实数据会让 MB 的财报永远是一条直线，玩家也看不出因果。
//   - 所以金价是**游戏内模拟**的：每轮做一次对数随机游走 + 向基准缓慢回归，
//     波动幅度完全由后台参数控制（goldVol / goldRev），跟「市场情绪」独立。
//
// 状态放在 db.gold：
//   { price, base, reportBase, series[], lastTick }
//   - reportBase：上一期财报到期的金价，用来算「这期金价涨跌」
//   - series：最近 N 轮的金价，前端画小图 / 算涨跌用

export const GOLD_BASE = 2400;          // 默认 2400 美元/盎司
const SERIES_MAX = 3600;                // 最近 5 小时

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 补上金价状态（老存档 / 新存档都走这里） */
export function ensureGold(db) {
  if (!db || typeof db !== 'object') return null;
  const cfg = (db && db.config) || {};
  const base = Math.max(100, num(cfg.goldBase, GOLD_BASE));
  const g = db.gold && typeof db.gold === 'object' ? db.gold : {};
  const price = num(g.price, 0) > 0 ? num(g.price) : base;
  db.gold = {
    price,
    base,
    reportBase: num(g.reportBase, 0) > 0 ? num(g.reportBase) : price,
    series: Array.isArray(g.series) && g.series.length ? g.series.slice(-SERIES_MAX) : [price],
    lastTick: num(g.lastTick, 0)
  };
  return db.gold;
}

/**
 * 走一轮金价。
 * 对数随机游走 + 向基准回归：k 越大越贴基准，vol 越大越跳。
 * 同时维护 series（给前端看走势）。
 */
export function stepGold(db, rand = Math.random) {
  const cfg = (db && db.config) || {};
  const g = ensureGold(db);
  if (!g) return null;
  const base = Math.max(100, num(cfg.goldBase, GOLD_BASE));
  g.base = base;
  const vol = clamp(num(cfg.goldVol, 0.0012), 0, 0.05);      // 每轮波动（0.12%）
  const rev = clamp(num(cfg.goldRev, 0.002), 0, 0.2);        // 向基准回归速度
  const prev = Math.max(1, num(g.price, base));
  // Box-Muller 取标准正态（只取一个，够用）
  const u1 = Math.max(1e-9, rand());
  const u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const drift = rev * Math.log(base / prev);
  let next = prev * Math.exp(z * vol + drift);
  // 极端保险：不许跌破基准的 20%、也不许翻 5 倍
  next = clamp(next, base * 0.2, base * 5);
  g.price = Number(next.toFixed(4));
  g.series.push(g.price);
  if (g.series.length > SERIES_MAX) g.series.splice(0, g.series.length - SERIES_MAX);
  g.lastTick = num(db.tick, 0);
  return g;
}

/** 相对 n 轮之前涨了多少（没有足够历史时返回 0） */
export function goldChange(db, ticks = 1) {
  const g = db && db.gold;
  const s = Array.isArray(g?.series) ? g.series : [];
  if (s.length < 2) return 0;
  const n = Math.max(1, Math.min(s.length - 1, Math.round(ticks)));
  const prev = num(s[s.length - 1 - n], 0);
  const now = num(s[s.length - 1], 0);
  return prev > 0 ? now / prev - 1 : 0;
}

/** 财报用：从「上一期发报时」到现在的金价涨跌 */
export function goldReturnSinceReport(db) {
  const g = ensureGold(db);
  if (!g) return 0;
  const prev = num(g.reportBase, 0) > 0 ? num(g.reportBase) : num(g.price, 0);
  const now = num(g.price, 0);
  return prev > 0 ? now / prev - 1 : 0;
}

/** 下发到前端的快照 */
export function goldInfo(db) {
  const g = ensureGold(db);
  if (!g) return { price: 0, base: 0, chg1: 0, chg60: 0, series: [] };
  return {
    price: num(g.price, 0),
    base: num(g.base, 0),
    // 最近一轮 / 最近 12 轮（1 分钟）的涨跌
    chg1: goldChange(db, 1),
    chg12: goldChange(db, 12),
    chg60: goldChange(db, 60),
    // 只给最近 120 个点，够画一小条线了
    series: (g.series || []).slice(-120)
  };
}

export function goldSeriesMax() {
  return SERIES_MAX;
}
