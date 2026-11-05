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
export function seedBars15(list, price, tickNow, vol = 0.02) {
  const out = [];
  const sigma = Math.max(0.002, Math.min(0.15, Number(vol) || 0.02));
  const bucketNow = Math.floor((Number(tickNow) || 0) / BAR15_TICKS);
  let cur = Number(price) > 0 ? Number(price) : 1;

  for (let i = 0; i < BAR15_MAX; i++) {
    const bucket = bucketNow - i;
    const r = (Math.random() - 0.5) * 2 * sigma;
    const open = Math.max(0.01, cur / (1 + r));
    const hi = Math.max(open, cur) * (1 + Math.random() * sigma * 0.6);
    const lo = Math.min(open, cur) * (1 - Math.random() * sigma * 0.6);
    out.push([
      bucket,
      Number(open.toFixed(4)),
      Number(hi.toFixed(4)),
      Number(lo.toFixed(4)),
      Number(cur.toFixed(4))
    ]);
    cur = open;
  }
  out.reverse();                      // 变成时间正序
  if (Array.isArray(list)) list.length = 0;
  return out;
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
