/**
 * 「一次性道具」的规则（2026-11 新增的两个商城道具）
 *
 *   1. 咸鱼代下单（Lv.1，50 万）：freeFeeTicks 轮内**所有交易手续费全免**
 *      —— 手续费（feeRate）+ 印花税（stampDuty）都算，冲击成本不免（那是市场深度成本）
 *      状态：player.freeFeeUntilTick（生效到哪一轮）/ player.freeFeeReadyAt（冷却到哪一轮）
 *   2. 游资情报（Lv.3，200 万）：告诉你游资**下一次进场**的板块
 *      —— 板块在游资上一次换仓时就已经抽好（db.hotMoney.nextIndustry），
 *         所以情报永远是真的，不是瞎猜（见 src/hotmoney.js）
 *      状态：player.hotTipReadyAt（冷却到哪一轮）
 *
 * 这里只放纯函数，路由和界面各自去读，方便单测（tests/shop-perks.mjs）。
 */

/** 咸鱼代下单：5 分钟 = 60 轮（1 轮 5 秒） */
export const FREE_FEE_TICKS = 60;
/** 游资情报的默认冷却（轮） */
export const HOT_TIP_COOLDOWN = 500;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** 免手续费是否正在生效（按 tick 判：休市期间 tick 不动，期效也不会流逝） */
export function freeFeeActive(db, player) {
  if (!player) return false;
  return num(player.freeFeeUntilTick) > num(db && db.tick);
}

/** 免手续费还剩多少轮（0 = 没生效） */
export function freeFeeLeft(db, player) {
  if (!player) return 0;
  return Math.max(0, num(player.freeFeeUntilTick) - num(db && db.tick));
}

/** 这一次要免掉多少轮（读 config，兜底 60） */
export function freeFeeDuration(db) {
  const cfg = (db && db.config) || {};
  return Math.max(1, Math.round(num(cfg.shopFreeFeeTicks, FREE_FEE_TICKS)));
}

/** 印花税率：免手续费期间为 0，其余照 config */
export function stampRateFor(db, player) {
  if (freeFeeActive(db, player)) return 0;
  const cfg = (db && db.config) || {};
  return Math.max(0, num(cfg.stampDuty));
}

/** 手续费率：免手续费期间为 0（红牛进化那套在 trading.js#feeRateFor 里另算） */
export function feeRateForFree(db, player) {
  if (freeFeeActive(db, player)) return 0;
  const cfg = (db && db.config) || {};
  return Math.max(0, num(cfg.feeRate));
}

/** 冷却还剩多少轮（通用：readyAt 字段名） */
export function cooldownLeft(db, player, field) {
  if (!player) return 0;
  return Math.max(0, num(player[field]) - num(db && db.tick));
}

/**
 * 游资下一次进场的板块情报。
 * 返回 null = 现在没有情报（游资被关掉 / 还没抽好）。
 * @returns {{industry:string, leftTicks:number, amount:number}|null}
 */
export function hotTipTarget(db) {
  const hm = (db && db.hotMoney) || {};
  const cfg = (db && db.config) || {};
  if (Number(cfg.hotMoneyEnabled ?? 1) === 0) return null;
  const industry = typeof hm.nextIndustry === 'string' ? hm.nextIndustry : '';
  if (!industry) return null;
  return {
    industry,
    leftTicks: Math.max(0, num(hm.nextSwitchTick) - num(db && db.tick)),
    // 下一次进场的金额量级（给情报文案用；游资每笔 1000 万~3000 万）
    amount: Math.round(num(hm.nextAmount))
  };
}
