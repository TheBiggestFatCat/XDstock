/**
 * 定时休市 / 开市（2026-11）
 *
 * 三种「休市」来源，优先级从高到低：
 *   1. 总开关 config.marketOpen === 0 —— 管理员手动一刀切，谁都别想开（老行为）
 *   2. 定时休市 marketSchedules —— 一次性（指定日期时间）或计划性（每天几点，可天天重复）
 *   3. 循环作息 marketCycle —— 开市 N 分钟 / 休市 M 分钟，按现实时间无限循环
 *      （游戏现在的节奏：开 5 分钟 = 白天，休 2 分钟 = 夜里）
 *
 * 全部按**服务器本地现实时间**算，和 tick 无关：重启、卡顿都不会把节奏带偏。
 * 本模块只做纯计算，不碰 db 以外的东西，方便测试。
 */

export const MINUTE_MS = 60000;
export const DAY_MIN = 24 * 60;

const num = (v, fb) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
};

/** 把 0~1439 的分钟数格式化成 HH:MM */
export function fmtMinute(min) {
  const m = ((Math.round(num(min, 0)) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 'HH:MM' → 0~1439；非法返回 null */
export function parseMinute(str) {
  const m = String(str || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (!(h >= 0 && h <= 23 && mm >= 0 && mm <= 59)) return null;
  return h * 60 + mm;
}

/** 当前本地时间在当天的第几分钟 */
function localMinuteOfDay(nowMs) {
  const d = new Date(nowMs);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

/** 今天 00:00 的时间戳（本地时区） */
function startOfDayMs(nowMs) {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 规整一条定时计划；不合法返回 null */
export function normalizeSchedule(raw, nowMs = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind === 'daily' ? 'daily' : 'once';
  const durationMin = Math.max(1, Math.min(DAY_MIN, Math.round(num(raw.durationMin, 30))));
  const note = String(raw.note || '').slice(0, 40);
  const enabled = raw.enabled === false ? false : true;
  const id = String(raw.id || `sch_${Math.random().toString(36).slice(2, 10)}`);

  if (kind === 'daily') {
    // startMinute 既接受 '09:30'，也接受已经规整过的 570（二次清洗时就是数字）
    const rawStart = raw.startMinute;
    let startMinute = null;
    if (typeof rawStart === 'number' && Number.isFinite(rawStart)) {
      startMinute = ((Math.round(rawStart) % DAY_MIN) + DAY_MIN) % DAY_MIN;
    } else {
      startMinute = parseMinute(rawStart);
      if (startMinute === null && Number.isFinite(Number(raw.startMinuteNum))) {
        startMinute = ((Math.round(Number(raw.startMinuteNum)) % DAY_MIN) + DAY_MIN) % DAY_MIN;
      }
    }
    if (startMinute === null) return null;
    return { id, kind, enabled, startMinute, durationMin, note, createdAt: num(raw.createdAt, nowMs) };
  }

  const startAt = Math.round(num(raw.startAt, 0));
  if (!(startAt > 0)) return null;
  return { id, kind, enabled, startAt, durationMin, note, createdAt: num(raw.createdAt, nowMs) };
}

/**
 * 清洗 db.marketSchedules：
 *   - 丢掉脏数据
 *   - 一次性计划过期就标 done（保留记录，面板上标记「已结束」）
 * 返回是否有改动
 */
export function ensureSchedules(db, nowMs = Date.now()) {
  if (!db || typeof db !== 'object') return false;
  let changed = false;
  if (!Array.isArray(db.marketSchedules)) {
    db.marketSchedules = [];
    changed = true;
  }
  const out = [];
  for (const raw of db.marketSchedules) {
    const s = normalizeSchedule(raw, nowMs);
    if (!s) { changed = true; continue; }
    if (s.kind === 'once' && s.startAt + s.durationMin * MINUTE_MS <= nowMs && s.enabled) {
      // 过期的一次性计划：自动停用（不然会一直占着列表）
      out.push({ ...s, enabled: false, done: true });
      changed = true;
      continue;
    }
    out.push(s);
  }
  if (changed) db.marketSchedules = out;
  return changed;
}

/**
 * 一次性 / 计划性计划在 nowMs 这一瞬间是否处于「休市窗口」。
 * 窗口：startAt ~ startAt + durationMin（daily 用当天/昨天的同一时刻，跨零点也算）
 */
export function scheduleWindow(s, nowMs) {
  if (!s || s.enabled === false) return null;
  const dur = s.durationMin * MINUTE_MS;
  if (s.kind === 'once') {
    if (nowMs >= s.startAt && nowMs < s.startAt + dur) {
      return { start: s.startAt, end: s.startAt + dur };
    }
    return null;
  }
  // daily：今天这个点、以及昨天这个点（跨零点的窗口会用到）
  const today = startOfDayMs(nowMs);
  for (const offset of [0, -1]) {
    const start = today + offset * 24 * 60 * MINUTE_MS + s.startMinute * MINUTE_MS;
    if (nowMs >= start && nowMs < start + dur) {
      return { start, end: start + dur };
    }
  }
  return null;
}

/** 计划下一次开始的时间（用于「距下次休市」提示）；没有则 0 */
export function nextScheduleStart(s, nowMs) {
  if (!s || s.enabled === false) return 0;
  const dur = s.durationMin * MINUTE_MS;
  if (s.kind === 'once') {
    return s.startAt + dur > nowMs ? Math.max(s.startAt, nowMs) : 0;
  }
  const today = startOfDayMs(nowMs);
  for (const offset of [0, 1, 2]) {
    const start = today + offset * 24 * 60 * MINUTE_MS + s.startMinute * MINUTE_MS;
    if (start + dur > nowMs) return Math.max(start, nowMs);
  }
  return 0;
}

/** 循环作息：返回当前相位 */
export function cyclePhase(cfg = {}, nowMs = Date.now()) {
  const enabled = Number(cfg.marketCycleEnabled ?? 0) !== 0;
  const openMin = Math.max(1, Math.min(DAY_MIN, Math.round(num(cfg.marketCycleOpenMin, 5))));
  const closeMin = Math.max(0, Math.min(DAY_MIN, Math.round(num(cfg.marketCycleCloseMin, 2))));
  if (!enabled || closeMin <= 0) {
    return { enabled: false, open: true, openMin, closeMin, phaseSec: 0, cycleSec: 0, nextChangeAt: 0 };
  }
  const openSec = openMin * 60;
  const cycleSec = (openMin + closeMin) * 60;
  const phaseSec = Math.floor((nowMs / 1000) % cycleSec);
  const closing = phaseSec >= openSec;
  const nextChangeAt = closing
    ? nowMs + (cycleSec - phaseSec) * 1000
    : nowMs + (openSec - phaseSec) * 1000;
  return { enabled: true, open: !closing, openMin, closeMin, phaseSec, cycleSec, nextChangeAt };
}

/**
 * 当前到底开没开市（唯一入口）
 * @returns {{open:boolean, reason:string, label:string, nextOpenAt:number, nextChangeAt:number,
 *            scheduleId:string, scheduleNote:string, cycle:object}}
 */
export function marketPhase(db, nowMs = Date.now()) {
  const cfg = (db && db.config) || {};
  const cycle = cyclePhase(cfg, nowMs);

  // 1. 总开关
  if (Number(cfg.marketOpen ?? 1) === 0) {
    return {
      open: false, reason: 'manual', label: '管理员休市',
      nextOpenAt: 0, nextChangeAt: 0, scheduleId: '', scheduleNote: '', cycle
    };
  }

  // 2. 定时休市（一次性 / 每天）
  const list = Array.isArray(db.marketSchedules) ? db.marketSchedules : [];
  for (const s of list) {
    const win = scheduleWindow(s, nowMs);
    if (!win) continue;
    return {
      open: false,
      reason: 'schedule',
      label: s.kind === 'once' ? '定时休市（一次性）' : `定时休市（每天 ${fmtMinute(s.startMinute)}）`,
      nextOpenAt: win.end,
      nextChangeAt: win.end,
      scheduleId: s.id,
      scheduleNote: s.note || '',
      cycle
    };
  }

  // 3. 循环作息
  if (cycle.enabled && !cycle.open) {
    return {
      open: false, reason: 'cycle',
      label: `夜间休市（每 ${cycle.openMin} 分开市 / ${cycle.closeMin} 分休市）`,
      nextOpenAt: cycle.nextChangeAt, nextChangeAt: cycle.nextChangeAt,
      scheduleId: '', scheduleNote: '', cycle
    };
  }

  // 开着市：算下一次会关的时间（给前端提示）
  let nextCloseAt = cycle.enabled ? cycle.nextChangeAt : 0;
  for (const s of list) {
    const t = nextScheduleStart(s, nowMs);
    if (t > 0 && (nextCloseAt === 0 || t < nextCloseAt)) nextCloseAt = t;
  }
  return {
    open: true, reason: 'open', label: '开市中',
    nextOpenAt: 0, nextChangeAt: nextCloseAt, scheduleId: '', scheduleNote: '', cycle
  };
}

/** 给人看的一句话状态（管理面板 / 前端横幅都用它） */
export function phaseText(phase, nowMs = Date.now()) {
  if (!phase) return '';
  if (phase.open) return '开市中';
  const left = phase.nextOpenAt > 0 ? Math.max(0, phase.nextOpenAt - nowMs) : 0;
  if (left <= 0) return phase.label;
  const mm = Math.floor(left / 60000);
  const ss = Math.floor((left % 60000) / 1000);
  return `${phase.label} · ${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')} 后开市`;
}
