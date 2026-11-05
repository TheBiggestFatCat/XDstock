// 早市冲量（LU 瑞幸咖啡）：每天 6~10 点把价格沿斜坡往上托
//   node tests/morning-rally.mjs

import { morningRallyWindow, applyMorningRally } from '../src/engine.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { STOCK_SEED } from '../src/stocks.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

const cfg = () => ({
  ...DEFAULT_CONFIG,
  morningRallyEnabled: 1,
  morningRallyStartHour: 6,
  morningRallyEndHour: 10,
  morningRallyTotal: 0.25,
  morningRallyPull: 0.02,
  tickMs: 5000
});
/** 造一个「本地时间」时间戳 */
const at = (h, m = 0, s = 0) => new Date(2026, 0, 15, h, m, s, 0).getTime();

// ---------------------------------------------------------------- 1
log('=== 1 LU 的 trait 换成了 morning ===');
{
  const t = STOCK_SEED.LU.trait;
  check('id = morning', t.id === 'morning', t.id);
  check('名字是「早市冲量」', t.name === '早市冲量', t.name);
  check('不再带 streak/bounceLo（旧反转王字段）', t.streak === undefined && t.bounceLo === undefined);
  check('没有别的票用 morning',
    Object.entries(STOCK_SEED).filter(([, s]) => s.trait?.id === 'morning').length === 1);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 窗口边界：6:00 ~ 10:00 ===');
{
  const c = cfg();
  check('5:59 不在窗口', morningRallyWindow(c, at(5, 59)).active === false);
  check('6:00 在窗口', morningRallyWindow(c, at(6, 0)).active === true);
  check('7:00 在窗口，进度 0.25', Math.abs(morningRallyWindow(c, at(7, 0)).progress - 0.25) < 1e-6,
    morningRallyWindow(c, at(7, 0)).progress.toFixed(3));
  check('9:59 还在窗口', morningRallyWindow(c, at(9, 59)).active === true);
  check('10:00 出窗口', morningRallyWindow(c, at(10, 0)).active === false);
  check('12:00 不在窗口', morningRallyWindow(c, at(12, 0)).active === false);
  check('同一天同一个 slot', morningRallyWindow(c, at(6, 5)).slot === morningRallyWindow(c, at(9, 55)).slot);
  check('换一天 slot 会变', morningRallyWindow(c, at(6, 5)).slot !==
    morningRallyWindow({ ...c }, new Date(2026, 0, 16, 6, 5).getTime()).slot);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 开关 / 空窗口 / 跨零点 ===');
{
  check('关掉就整段失效', morningRallyWindow({ ...cfg(), morningRallyEnabled: 0 }, at(7)).active === false);
  check('start===end 视为不生效',
    morningRallyWindow({ ...cfg(), morningRallyStartHour: 8, morningRallyEndHour: 8 }, at(8, 30)).active === false);
  const night = { ...cfg(), morningRallyStartHour: 22, morningRallyEndHour: 2 };
  check('跨零点：23:00 在窗口', morningRallyWindow(night, at(23)).active === true);
  check('跨零点：1:00 在窗口', morningRallyWindow(night, at(1)).active === true);
  check('跨零点：12:00 不在', morningRallyWindow(night, at(12)).active === false);
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 价格被托着走：窗口内爬坡，窗口外不动 ===');
{
  const c = cfg();
  const st = { price: 100 };
  let p = 100;

  // 窗口外：价格一分不动
  const before = applyMorningRally(c, st, 100, at(5, 0));
  check('5:00 不动', Math.abs(before - 100) < 1e-9, before.toFixed(4));

  // 6:00 进窗口记基准
  p = applyMorningRally(c, st, 100, at(6, 0));
  check('进窗口记下基准价', Math.abs(st.morningBase - 100) < 1e-6, String(st.morningBase));
  check('刚进窗口目标=基准，不动', Math.abs(p - 100) < 1e-6, p.toFixed(4));

  // 模拟整段：每 5 秒走一轮
  p = 100;
  let ticks = 0;
  for (let t = at(6, 0); t < at(10, 0); t += 5000) {
    p = applyMorningRally(c, st, p, t);
    ticks++;
  }
  check('窗口内跑了 2880 轮（4 小时 / 5 秒）', ticks === 2880, String(ticks));
  check('窗口末累计涨幅 ≈ +25%', Math.abs(p / 100 - 1 - 0.25) < 0.01, ((p / 100 - 1) * 100).toFixed(2) + '%');

  // 窗口结束后不再托
  const after = applyMorningRally(c, st, p, at(10, 30));
  check('10:30 不再托', Math.abs(after - p) < 1e-9);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 只托不压：已经高于目标价就不管 ===');
{
  const c = cfg();
  const st = { price: 100 };
  applyMorningRally(c, st, 100, at(6, 0));           // 基准 100
  const pumped = 200;                                 // 玩家把价格拉到 2 倍
  const r = applyMorningRally(c, st, pumped, at(8));  // 目标才 ~125
  check('高于目标价时不动', Math.abs(r - pumped) < 1e-9, r.toFixed(2));
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 力度可调：total 变了终点就跟着变 ===');
{
  for (const total of [0.05, 0.25, 0.6]) {
    const c = { ...cfg(), morningRallyTotal: total };
    const st = { price: 50 };
    let p = 50;
    for (let t = at(6, 0); t < at(10, 0); t += 5000) p = applyMorningRally(c, st, p, t);
    check(`total=${total} → 实际 ${((p / 50 - 1) * 100).toFixed(1)}%`,
      Math.abs(p / 50 - 1 - total) < total * 0.05);
  }
  // pull 很小 → 追不上斜坡，终点低于 total
  const slow = { ...cfg(), morningRallyPull: 0.0005 };
  const st2 = { price: 50 };
  let p2 = 50;
  for (let t = at(6, 0); t < at(10, 0); t += 5000) p2 = applyMorningRally(slow, st2, p2, t);
  check('pull 太小时追不满，涨幅小于目标', p2 / 50 - 1 < 0.25, ((p2 / 50 - 1) * 100).toFixed(1) + '%');
}

// ---------------------------------------------------------------- 7
log('');
log('=== 7 脏数据 ===');
{
  const c = cfg();
  check('价格 <= 0 时原样返回', applyMorningRally(c, {}, 0, at(7)) === 0);
  check('没有 st 时原样返回', applyMorningRally(c, null, 100, at(7)) === 100);
  check('空配置不炸', typeof morningRallyWindow({}, at(7)) === 'object');
  const st = {};
  const r = applyMorningRally({ ...c, morningRallyTotal: 0 }, st, 100, at(7));
  check('total=0 等于关闭', Math.abs(r - 100) < 1e-9);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
