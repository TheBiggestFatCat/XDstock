/**
 * 单独打包的中长周期 K 线（2026-11：5 分钟也单独存了）
 *
 * 为什么不直接用 `series`：
 *   主 `series` 只留 `historyTicks`(3600) 个 tick = 5 小时，
 *   5 分钟一根要 60 个 tick，从 series 里最多凑出 60 根；
 *   而 1 分钟图有 300 根 —— 切到 5 分钟就只剩一条小尾巴，看不出一整天。
 *
 * 现在两档都单独存：
 *   - 5 分钟：`bars5`，60 tick / 根，300 根 = 25 小时（和 1 分钟图的 300 根对齐）
 *   - 15 分钟：`bars15`，180 tick / 根，192 根 = 48 小时
 *
 * 数组项：`[bucket, open, high, low, close, volume]`，bucket = floor(absTick / 每根 tick 数)。
 * 这个模块只做纯计算，不依赖 engine / store，避免循环引用。
 */

export const BAR5_TICKS = 60;       // 5 分钟 = 60 tick
export const BAR5_MAX = 300;        // 300 根 = 25 小时（和 1 分钟图的 300 根一样多）
export const BAR5_SEED_VER = 1;

export const BAR15_TICKS = 180;     // 15 分钟 = 180 tick
export const BAR15_MAX = 192;       // 192 根 = 48 小时
/** 冷启动数据的版本：算法改了就让老存档重铺一遍 */
export const BAR15_SEED_VER = 2;

/**
 * 往一份 K 线里塞一个价格（通用实现）。
 * 同一根就更新 high / low / close，跨桶就新开一根，超过 max 丢最老的。
 */
export function pushBar(list, bucket, price, volume = 0, max = BAR15_MAX) {
  const p = Number(price);
  if (!Array.isArray(list) || !Number.isFinite(p) || p <= 0) return list;
  if (!Number.isFinite(bucket)) return list;
  const vol = Number(volume) > 0 ? Number(volume) : 0;

  const last = list[list.length - 1];
  if (last && last[0] === bucket) {
    if (p > last[2]) last[2] = p;
    if (p < last[3]) last[3] = p;
    last[4] = p;
    last[5] = (Number(last[5]) || 0) + vol;   // 成交量累加（老存档没有第 6 位 → 从 0 起）
    return list;
  }
  // 只往未来开新的一根；乱序（理论上不该有）直接忽略
  if (!last || bucket > last[0]) {
    list.push([bucket, p, p, p, p, vol]);
    if (list.length > max) list.splice(0, list.length - max);
  }
  return list;
}

/**
 * 冷启动 / 老存档升级时把一份 K 线铺满（从当前价往回随机走）。
 * 尾部必须接上当前价，否则图上最后一根会离现价很远。
 */
export function seedBars(list, price, tickNow, vol = 0.08, max = BAR15_MAX, ticks = BAR15_TICKS) {
  const out = [];
  const sigma = Math.max(0.002, Math.min(0.25, Number(vol) || 0.08));
  const bucketNow = Math.floor((Number(tickNow) || 0) / ticks);
  const anchor = Number(price) > 0 ? Number(price) : 1;
  // 每根往回走完再往现价拉一点点：单根波动够大（跟真实盘面一个量级），
  // 但整段不至于跑飞成 10 倍
  const kappa = 0.12;
  let cur = anchor;

  for (let i = 0; i < max; i++) {
    const bucket = bucketNow - i;
    // 两段均匀分布相加 ≈ 正态，比纯 uniform 更像真行情
    const g = (Math.random() + Math.random() - 1) * sigma * 1.4;
    let next = Math.max(0.01, cur / (1 + g));
    next = next * (1 - kappa) + anchor * kappa;
    const open = next;
    const body = Math.max(open, cur);
    const bodyLow = Math.min(open, cur);
    const hi = body * (1 + Math.random() * sigma * 0.8);
    const lo = bodyLow * (1 - Math.random() * sigma * 0.8);
    out.push([
      bucket,
      Number(open.toFixed(4)),
      Number(hi.toFixed(4)),
      Number(lo.toFixed(4)),
      Number(cur.toFixed(4))
    ]);
    cur = next;
  }
  out.reverse();                      // 变成时间正序
  if (Array.isArray(list)) list.length = 0;
  return out;
}

/** 冷启动该用多大的单根波动：由 baseVolatility 推（每 tick σ × √根数） */
export function seedVolFromConfig(cfg, ticks = BAR15_TICKS) {
  const tickVol = Math.max(0.0005, Number(cfg?.baseVolatility ?? 0.01));
  return Math.max(0.01, Math.min(0.2, tickVol * Math.sqrt(ticks) * 0.75));
}

/**
 * 把 `[bucket,o,h,l,c,vol]` 转成 K 线对象。
 * @param {function} timeOf  (absTick) => 毫秒时间戳（由调用方用真实时间轴算）
 */
export function barsToCandles(list, timeOf, ticks = BAR15_TICKS) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const b of list) {
    if (!Array.isArray(b) || b.length < 5) continue;
    const bucket = Number(b[0]);
    const o = Number(b[1]);
    const h = Number(b[2]);
    const l = Number(b[3]);
    const c = Number(b[4]);
    if (![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) continue;
    if (!Number.isFinite(bucket)) continue;
    const ms = typeof timeOf === 'function' ? timeOf(bucket * ticks) : 0;
    out.push({
      time: Math.floor(Number(ms) / 1000),
      open: Number(o.toFixed(4)),
      high: Number(Math.max(h, o, c, l).toFixed(4)),
      low: Number(Math.min(l, o, c, h).toFixed(4)),
      close: Number(c.toFixed(4)),
      volume: Math.max(0, Number(b[5]) || 0)
    });
  }
  return out;
}

/* ---------- 15 分钟（老名字保留，老代码/测试还在用） ---------- */
export function pushBar15(list, bucket, price, volume = 0) {
  return pushBar(list, bucket, price, volume, BAR15_MAX);
}
export function seedBars15(list, price, tickNow, vol = 0.08) {
  return seedBars(list, price, tickNow, vol, BAR15_MAX, BAR15_TICKS);
}
export function bars15Candles(list, timeOf) {
  return barsToCandles(list, timeOf, BAR15_TICKS);
}

/* ---------- 5 分钟（2026-11 新增，根数和 1 分钟对齐） ---------- */
export function pushBar5(list, bucket, price, volume = 0) {
  return pushBar(list, bucket, price, volume, BAR5_MAX);
}
export function seedBars5(list, price, tickNow, vol = 0.03) {
  return seedBars(list, price, tickNow, vol, BAR5_MAX, BAR5_TICKS);
}
export function bars5Candles(list, timeOf) {
  return barsToCandles(list, timeOf, BAR5_TICKS);
}
