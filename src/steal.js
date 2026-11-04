// 偷钱金额：百分比按「对方的现金」算，不按总资产
//   - 持仓里的钱偷不到（跟现实一样，你没法从别人的股票账户里拎走股票）
//   - 所以在场上的钱越多，被偷的上限才越高
//   - 上下限：stealCapRatio（默认 0.1%）、stealMin / stealMax

/**
 * 算这一把能偷多少（0 = 空手）。
 * @param {object} o
 * @param {number} o.victimCash  对方现价现金
 * @param {number} o.capRatio    百分比（0.001 = 现金的 0.1%）
 * @param {number} o.stealMin    单次最少想偷多少
 * @param {number} o.stealMax    单次最多想偷多少
 * @param {function} [o.roll]    随机源（测试用），返回 [0,1)
 */
export function stealAmount({ victimCash, capRatio, stealMin, stealMax, roll = Math.random } = {}) {
  const cash = Math.max(0, Number(victimCash) || 0);
  if (cash < 1) return 0;

  const ratio = Math.max(0, Number(capRatio) || 0);
  // 百分比挂在现金上：对方穷得只剩 100 块，最多也就偷走 100 × 0.1% = 0 块
  const cap = cash * ratio;

  const lo0 = Math.max(0, Number(stealMin) || 0);
  const hi0 = Math.max(0, Number(stealMax) || 0);
  const lo = Math.min(lo0, hi0);
  const hi = Math.max(lo0, hi0);

  const r = typeof roll === 'function' ? roll() : Math.random();
  const want = lo + Math.max(0, Math.min(1, Number(r) || 0)) * (hi - lo);

  let amount = Math.floor(Math.min(want, cap, cash));
  if (!Number.isFinite(amount) || amount < 0) amount = 0;
  if (amount < 1) return 0;
  return Math.min(amount, cash);
}
