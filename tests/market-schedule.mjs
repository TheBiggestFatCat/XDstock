// 定时休市 / 开市：一次性 + 计划性 + 循环作息（2026-11）
//   node tests/market-schedule.mjs
//
// 线上要求：管理界面能指定「现实时间」自动休市开市，一次性和计划性（每天）都要支持；
// 再基于它把游戏节奏改成「开 5 分钟 / 休 2 分钟」（白天 / 夜里）。

import {
  normalizeSchedule, ensureSchedules, scheduleWindow, nextScheduleStart,
  cyclePhase, marketPhase, phaseText, fmtMinute, parseMinute, MINUTE_MS, DAY_MIN
} from '../src/schedule.js';

let fails = 0;
let passes = 0;
const out = [];
const realLog = console.log;
console.log = () => {};
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
const near = (a, b, eps = 1) => Math.abs(a - b) <= eps;

/** 造一个本地时间的毫秒时间戳 */
const at = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const base = at(2026, 11, 9, 12, 0, 0);

const mkDb = (cfg = {}, schedules = []) => ({
  config: { marketOpen: 1, marketCycleEnabled: 0, ...cfg },
  marketSchedules: schedules
});

// ================================================================ 1
log('=== 1 HH:MM 解析 / 格式化 ===');
{
  check('fmtMinute(0) = 00:00', fmtMinute(0) === '00:00');
  check('fmtMinute(570) = 09:30', fmtMinute(570) === '09:30');
  check('fmtMinute 跨天取模', fmtMinute(1440) === '00:00' && fmtMinute(-60) === '23:00');
  check('parseMinute 09:30 = 570', parseMinute('09:30') === 570);
  check('parseMinute 9:05 = 545', parseMinute('9:05') === 545);
  check('parseMinute 非法返回 null', parseMinute('24:00') === null && parseMinute('9') === null && parseMinute('') === null);
  check('往返一致', parseMinute(fmtMinute(1234)) === 1234);
}

// ================================================================ 2
log('');
log('=== 2 清洗：脏数据丢掉、过期一次性自动停用 ===');
{
  const db = { marketSchedules: [
    null, {}, { kind: 'once', startAt: 0 }, { kind: 'daily', startMinute: '99:99' },
    { kind: 'once', startAt: base - 60 * MINUTE_MS, durationMin: 30 },   // 早就结束
    { kind: 'once', startAt: base + 10 * MINUTE_MS, durationMin: 5 },
    { kind: 'daily', startMinute: '09:30', durationMin: 15, note: '早盘' }
  ] };
  const changed = ensureSchedules(db, base);
  check('脏数据被清掉', db.marketSchedules.length === 3, JSON.stringify(db.marketSchedules.map((s) => s.kind)));
  check('确实有改动', changed === true);
  const done = db.marketSchedules.find((s) => s.kind === 'once' && s.startAt < base);
  check('过期的一次性被标成 done + 停用', done && done.done === true && done.enabled === false);
  const future = db.marketSchedules.find((s) => s.kind === 'once' && s.startAt > base);
  check('未来的仍然有效', future && future.enabled === true && future.durationMin === 5);
  const daily = db.marketSchedules.find((s) => s.kind === 'daily');
  check('每天的计划保留 startMinute', daily.startMinute === 570 && daily.note === '早盘');
  check('重复调用不再改动', ensureSchedules(db, base) === false);
}

// ================================================================ 3
log('');
log('=== 3 一次性休市：到点关、到点开 ===');
{
  const s = normalizeSchedule({ kind: 'once', startAt: base + 10 * MINUTE_MS, durationMin: 30 }, base);
  check('窗口开始前不算', scheduleWindow(s, base + 9 * MINUTE_MS) === null);
  const w = scheduleWindow(s, base + 10 * MINUTE_MS);
  check('窗口内命中，结束时间 = 开始 + 时长', w && near(w.end, base + 40 * MINUTE_MS));
  check('窗口结束后不算', scheduleWindow(s, base + 40 * MINUTE_MS) === null);

  const db = mkDb({}, [s]);
  const p1 = marketPhase(db, base);
  check('休市前：开市', p1.open === true, p1.label);
  const p2 = marketPhase(db, base + 20 * MINUTE_MS);
  check('休市窗口内：关市', p2.open === false && p2.reason === 'schedule', p2.label);
  check('给出开市时间', near(p2.nextOpenAt, base + 40 * MINUTE_MS));
  check('文案带倒计时', /后开市/.test(phaseText(p2, base + 20 * MINUTE_MS)), phaseText(p2, base + 20 * MINUTE_MS));
  const p3 = marketPhase(db, base + 41 * MINUTE_MS);
  check('窗口过后自动开市', p3.open === true);
}

// ================================================================ 4
log('');
log('=== 4 计划性（每天）：天天生效、跨零点也认 ===');
{
  const every = normalizeSchedule({ kind: 'daily', startMinute: '09:30', durationMin: 60 }, base);
  const today = at(2026, 11, 9, 0, 0, 0);
  check('今天 09:30 命中', !!scheduleWindow(every, today + 570 * MINUTE_MS));
  check('今天 10:29 还在窗口内', !!scheduleWindow(every, today + 629 * MINUTE_MS));
  check('今天 10:30 出窗口', scheduleWindow(every, today + 630 * MINUTE_MS) === null);
  check('明天同一时间也命中', !!scheduleWindow(every, today + 24 * 60 * MINUTE_MS + 570 * MINUTE_MS));

  // 跨零点：23:30 开始，休 90 分钟 → 次日 01:00 结束
  const night = normalizeSchedule({ kind: 'daily', startMinute: '23:30', durationMin: 90 }, base);
  const lateNight = at(2026, 11, 10, 0, 30, 0);   // 次日 00:30
  const w = scheduleWindow(night, lateNight);
  check('跨零点的窗口：次日 00:30 仍在休市', !!w, w ? `${new Date(w.start).toLocaleTimeString()} ~ ${new Date(w.end).toLocaleTimeString()}` : '');
  check('跨零点的窗口：次日 01:01 已开市', scheduleWindow(night, at(2026, 11, 10, 1, 1, 0)) === null);

  // 下次开始时间：窗口内返回「现在」（已经在休），窗口过了返回明天 09:30
  const inWin = nextScheduleStart(every, today + 580 * MINUTE_MS);   // 09:40，还在 09:30~10:30 里
  check('窗口内：下次开始就是现在', near(inWin, today + 580 * MINUTE_MS),
    new Date(inWin).toLocaleString('zh-CN'));
  const next = nextScheduleStart(every, today + 660 * MINUTE_MS);    // 11:00，窗口已过
  check('窗口过了：下一次开始 = 明天 09:30', near(next, today + 24 * 60 * MINUTE_MS + 570 * MINUTE_MS),
    new Date(next).toLocaleString('zh-CN'));

  // 停用的计划不生效
  const off = { ...every, enabled: false };
  check('停用后不命中', scheduleWindow(off, today + 570 * MINUTE_MS) === null);
}

// ================================================================ 5
log('');
log('=== 5 循环作息：开 5 分 / 休 2 分 ===');
{
  const cfg = { marketCycleEnabled: 1, marketCycleOpenMin: 5, marketCycleCloseMin: 2 };
  const cycleSec = 7 * 60;
  // 找一个周期起点对齐的时间
  const anchor = Math.floor(base / 1000 / cycleSec) * cycleSec * 1000;
  const ph = [
    cyclePhase(cfg, anchor + 1000),
    cyclePhase(cfg, anchor + 4 * 60 * 1000),
    cyclePhase(cfg, anchor + 5 * 60 * 1000 + 1000),
    cyclePhase(cfg, anchor + 6 * 60 * 1000 + 59000)
  ];
  check('第 1 秒：开市', ph[0].open === true);
  check('第 4 分：还在开市', ph[1].open === true);
  check('第 5 分 1 秒：休市（夜间）', ph[2].open === false);
  check('第 6 分 59 秒：仍休市', ph[3].open === false);
  check('开市相位给出「下次关市」时间', near(ph[0].nextChangeAt, anchor + 5 * 60 * 1000, 1000));
  check('休市相位给出「下次开市」时间', near(ph[2].nextChangeAt, anchor + 7 * 60 * 1000, 1000));

  // 一天内的开市占比
  let openCount = 0;
  for (let s = 0; s < cycleSec; s += 5) {
    if (cyclePhase(cfg, anchor + s * 1000).open) openCount += 1;
  }
  const ratio = openCount / (cycleSec / 5);
  check('开市占比 ≈ 5/7 = 71%', near(ratio, 5 / 7, 0.02), (ratio * 100).toFixed(1) + '%');

  // 关掉 / 休市 0 分钟 → 不生效（永远开市）
  check('关掉循环 → 不生效', cyclePhase({ marketCycleEnabled: 0, marketCycleOpenMin: 5, marketCycleCloseMin: 2 }, base).enabled === false);
  check('休市 0 分钟 → 不生效', cyclePhase({ marketCycleEnabled: 1, marketCycleOpenMin: 5, marketCycleCloseMin: 0 }, base).enabled === false);

  // 参数兜底
  const weird = cyclePhase({ marketCycleEnabled: 1, marketCycleOpenMin: 'x', marketCycleCloseMin: -3 }, base);
  check('非法参数不炸且退化成 5 分开市', weird.openMin === 5 && weird.enabled === false);
}

// ================================================================ 6
log('');
log('=== 6 优先级：总开关 > 定时休市 > 循环作息 ===');
{
  const daily = normalizeSchedule({ kind: 'daily', startMinute: '12:00', durationMin: 30 }, base);
  const cfg = { marketCycleEnabled: 1, marketCycleOpenMin: 5, marketCycleCloseMin: 2 };
  const inCycleClose = marketPhase(mkDb(cfg, []), base);
  const db = mkDb(cfg, [daily]);

  // 12:10 同时踩中「定时休市」和循环；定时优先
  const p = marketPhase(db, at(2026, 11, 9, 12, 10, 0));
  check('定时休市优先于循环', p.reason === 'schedule', p.label);

  // 总开关关掉时，任何计划都拦不住
  const forced = mkDb({ marketOpen: 0 }, [daily]);
  const fp = marketPhase(forced, base);
  check('总开关=休市 → reason=manual', fp.reason === 'manual', fp.label);
  check('总开关时不报下次开市时间', fp.nextOpenAt === 0);

  // 没计划时按循环
  const onlyCycle = marketPhase(mkDb(cfg, []), base);
  check('只有循环 → 按相位走', ['open', 'cycle'].includes(onlyCycle.reason), onlyCycle.label);

  // 全关 → 一直开市
  const plain = marketPhase(mkDb({}, []), base);
  check('都不配 → 一直开市', plain.open === true && plain.reason === 'open');
  check('开市时给出「距下次关市」', plain.nextChangeAt === 0 || plain.nextChangeAt > base);
}

// ================================================================ 7
log('');
log('=== 7 开市时能算出「还有多久关市」（给前端提示）===');
{
  const cfg = { marketCycleEnabled: 1, marketCycleOpenMin: 5, marketCycleCloseMin: 2 };
  const cycleSec = 7 * 60;
  const anchor = Math.floor(base / 1000 / cycleSec) * cycleSec * 1000;
  const p = marketPhase(mkDb(cfg, []), anchor + 60 * 1000);
  check('开市相位 nextChangeAt 落在 5 分钟边界', near(p.nextChangeAt, anchor + 5 * 60 * 1000, 1000));

  const db = mkDb({}, [normalizeSchedule({ kind: 'daily', startMinute: '12:20', durationMin: 10 }, base)]);
  const p2 = marketPhase(db, at(2026, 11, 9, 12, 0, 0));
  check('有定时休市时取更早的那个边界', near(p2.nextChangeAt, at(2026, 11, 9, 12, 20, 0)), new Date(p2.nextChangeAt).toLocaleTimeString('zh-CN'));
}

console.log = realLog;
console.log(out.join('\n'));
console.log('');
console.log(fails ? `---- ${passes} 通过 / ${fails} 失败 ----` : `---- ${passes} 通过 / 0 失败 ----`);
process.exit(fails ? 1 : 0);
