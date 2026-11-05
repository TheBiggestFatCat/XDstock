/**
 * 15 分钟 K 线（单独存一份，保留 48 小时）
 *
 * 为什么要单独存：主 `series` 只留 `historyTicks`(3600) 个 tick = 5 小时，
 * 15 分钟一根要 180 个 tick，从 series 里最多凑出 20 根。
 * 而 48 小时的 15m 只有 192 根 —— 存这 192 根比把 series 拉到 48 小时省 20 多倍。
 *
 * 这个模块只做纯计算，不依赖 engine / store，避免循环引用。
 */

export const BAR15_TICKS = 180;     // 15 分钟 = 180 tick
export const BAR15_MAX = 192;       // 192 根 = 48 小时
/** 冷启动数据的版本：算法改了就让老存档重铺一遍 */
export const BAR15_SEED_VER = 2;

/**
 * 往 15 分钟 K 线里塞一个价格。
 * 同一根就更新 high / low / close，跨桶就新开一根，超过 BAR15_MAX 丢最老的。
 * 数组项：`[bucket, open, high, low, close]`，bucket = floor(absTick / 180)。
 */
export function pushBar15(list, bucket, price) {
  const p = Number(price);
  if (!Array.isArray(list) || !Number.isFinite(p) || p <= 0) return list;
  if (!Number.isFinite(bucket)) return list;

  const last = list[list.length - 1];
  if (last && last[0] === bucket) {
    if (p > last[2]) last[2] = p;
    if (p < last[3]) last[3] = p;
    last[4] = p;
    return list;
  }
  // 只往未来开新的一根；乱序（理论上不该有）直接忽略
  if (!last || bucket > last[0]) {
    list.push([bucket, p, p, p, p]);
    if (list.length > BAR15_MAX) list.splice(0, list.length - BAR15_MAX);
  }
  return list;
}

/**
 * 冷启动 / 老存档升级时把 15 分钟 K 线铺满 192 根（从当前价往回随机走）。
 * 尾部必须接上当前价，否则图上最后一根会离现价很远。
 */
export function seedBars15(list, price, tickNow, vol = 0.08) {
  const out = [];
  const sigma = Math.max(0.002, Math.min(0.25, Number(vol) || 0.08));
  const bucketNow = Math.floor((Number(tickNow) || 0) / BAR15_TICKS);
  const anchor = Number(price) > 0 ? Number(price) : 1;
  // 每根往回走完再往现价拉一点点：单根波动够大（跟真实盘面一个量级），
  // 但 48 小时不至于跑飞成 10 倍
  const kappa = 0.12;
  let cur = anchor;

  for (let i = 0; i < BAR15_MAX; i++) {
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

/** 冷启动该用多大的单根波动：直接由 baseVolatility 推（每 tick σ × √180） */
export function seedVolFromConfig(cfg) {
  const tickVol = Math.max(0.0005, Number(cfg?.baseVolatility ?? 0.01));
  // 理论上 √180 × 1% ≈ 13%，均值回归会削掉一部分，取 0.6 的系数
  return Math.max(0.01, Math.min(0.2, tickVol * Math.sqrt(BAR15_TICKS) * 0.75));
}

/**
 * 把 `[bucket,o,h,l,c]` 转成 K 线对象。
 * @param {function} timeOf  (absTick) => 毫秒时间戳（由调用方用真实时间轴算）
 */
export function bars15Candles(list, timeOf) {
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
    const ms = typeof timeOf === 'function' ? timeOf(bucket * BAR15_TICKS) : 0;
    out.push({
      time: Math.floor(Number(ms) / 1000),
      open: Number(o.toFixed(4)),
      high: Number(Math.max(h, o, c, l).toFixed(4)),
      low: Number(Math.min(l, o, c, h).toFixed(4)),
      close: Number(c.toFixed(4))
    });
  }
  return out;
}
