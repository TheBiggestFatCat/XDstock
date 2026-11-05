/**
 * 主题相关的规则（目前只有「夜行者」用到）。
 *
 * 时间一律按**服务器本地时间**算（线上是 Asia/Shanghai），
 * 玩家端只负责展示，判断永远在服务端做。
 */

const HOUR_MS = 3600 * 1000;

/** 把一个可能越界的「小时」夹回 0~23 */
function normHour(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return ((Math.round(n) % 24) + 24) % 24;
}

/**
 * 夜行者的时间窗：默认现实时间 18:00 ~ 次日 04:00。
 * 支持跨零点（start > end）；start === end 视为「不生效」。
 *
 * @returns {{active:boolean, hour:number, start:number, end:number}}
 */
export function nightWindow(db, nowMs = Date.now()) {
  const cfg = (db && db.config) || {};
  const start = normHour(cfg.nightStartHour, 18);
  const end = normHour(cfg.nightEndHour, 4);
  const hour = new Date(Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()).getHours();
  let active;
  if (start === end) active = false;
  else if (start < end) active = hour >= start && hour < end;
  else active = hour >= start || hour < end;     // 跨零点：18~24 和 0~4
  return { active, hour, start, end };
}

/** 现在是不是夜里 */
export function isNightWindow(db, nowMs = Date.now()) {
  return nightWindow(db, nowMs).active;
}

/**
 * 该玩家**此刻**的偷钱冷却（轮）。
 *
 * - 夜行者主题 + 夜里 → `nightStealCooldown`（默认 5 轮）
 * - 其他情况 → `stealCooldownTicks`（默认 60 轮）
 */
export function stealCooldownFor(db, player, nowMs = Date.now()) {
  const cfg = (db && db.config) || {};
  const base = Math.max(0, Number(cfg.stealCooldownTicks ?? 60));
  if (!player || player.skill !== 'night') return base;
  if (!isNightWindow(db, nowMs)) return base;
  const night = Number(cfg.nightStealCooldown);
  return Math.max(0, Number.isFinite(night) ? night : 5);
}

/** 给前端展示用：这个玩家当前的偷钱 CD 和夜里状态 */
export function nightInfoFor(db, player, nowMs = Date.now()) {
  const win = nightWindow(db, nowMs);
  const isNight = player && player.skill === 'night';
  return {
    active: win.active,
    hour: win.hour,
    start: win.start,
    end: win.end,
    bonus: !!(isNight && win.active),
    stealCd: stealCooldownFor(db, player, nowMs),
    msLeft: nextNightBoundaryMs(db, win, nowMs)
  };
}

/** 距离下一次「进入/离开夜里」还有多少毫秒（前端可以显示倒计时） */
export function nextNightBoundaryMs(db, win, nowMs = Date.now()) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const target = win.active ? win.end : win.start;
  const d = new Date(now);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), target, 0, 0, 0);
  let diff = next.getTime() - now;
  if (diff <= 0) diff += 24 * HOUR_MS;
  return diff;
}
