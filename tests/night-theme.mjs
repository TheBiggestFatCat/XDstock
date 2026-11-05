// 「夜行者」主题：时间窗 + 偷钱 CD
//   node tests/night-theme.mjs

import { nightWindow, isNightWindow, stealCooldownFor, nightInfoFor, nextNightBoundaryMs } from '../src/theme.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

/** 造一个某天某点的本地时间戳（跟着服务器时区走） */
const at = (h, m = 0) => new Date(2026, 10, 4, h, m, 0, 0).getTime();
const db = () => ({ config: {} });

// ---------------------------------------------------------------- 1
log('=== 1 时间窗：18:00 ~ 次日 04:00 ===');
{
  const cases = [
    [17, 59, false], [18, 0, true], [18, 1, true],
    [21, 30, true], [23, 59, true],
    [0, 0, true], [3, 59, true], [4, 0, false],
    [12, 0, false], [6, 30, false]
  ];
  for (const [h, m, want] of cases) {
    const got = isNightWindow(db(), at(h, m));
    check(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${want ? '算夜里' : '不算夜里'}`,
      got === want);
  }
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 时间窗可以配，且 start === end 视为不生效 ===');
{
  const early = { config: { nightStartHour: 22, nightEndHour: 6 } };
  check('22~6：23 点算夜里', isNightWindow(early, at(23)) === true);
  check('22~6：5 点算夜里', isNightWindow(early, at(5)) === true);
  check('22~6：6 点不算', isNightWindow(early, at(6)) === false);
  check('22~6：21 点不算', isNightWindow(early, at(21)) === false);

  const same = { config: { nightStartHour: 9, nightEndHour: 9 } };
  check('start === end → 永远不生效', isNightWindow(same, at(9)) === false);

  const day = { config: { nightStartHour: 0, nightEndHour: 24 } };
  check('0~24（end 归一到 0）→ 也不生效', isNightWindow(day, at(12)) === false);

  const wrap = { config: { nightStartHour: 30, nightEndHour: 4 } };
  check('越界小时会被归一（30 → 6）', nightWindow(wrap, at(7)).start === 6);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 偷钱 CD：夜行者夜里 5 轮，其余 60 轮 ===');
{
  const night = { theme: 'night', skill: 'night' };
  check('夜行者 · 夜里 → 5 轮', stealCooldownFor(db(), night, at(21)) === 5);
  check('夜行者 · 白天 → 60 轮', stealCooldownFor(db(), night, at(12)) === 60);
  check('别的主题 · 夜里 → 60 轮', stealCooldownFor(db(), { theme: 'dark', skill: 'dark' }, at(21)) === 60);
  check('没主题（新号）· 夜里 → 60 轮', stealCooldownFor(db(), {}, at(21)) === 60);
  check('玩家对象缺省也不炸', stealCooldownFor(db(), null, at(21)) === 60);

  const custom = { config: { nightStealCooldown: 3, stealCooldownTicks: 30 } };
  check('后台能改成 3 轮', stealCooldownFor(custom, night, at(21)) === 3);
  check('白天跟着全局改成 30 轮', stealCooldownFor(custom, night, at(12)) === 30);
  const zero = { config: { nightStealCooldown: 0 } };
  check('夜里 CD 设 0 = 不冷却', stealCooldownFor(zero, night, at(21)) === 0);
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 给前端的 nightInfo ===');
{
  const info = nightInfoFor(db(), { theme: 'night', skill: 'night' }, at(21));
  check('夜里 active = true', info.active === true);
  check('夜行者夜里 bonus = true', info.bonus === true);
  check('stealCd = 5', info.stealCd === 5);
  check('距离天亮是正数且小于 24 小时', info.msLeft > 0 && info.msLeft <= 86400000,
    Math.round(info.msLeft / 3600000) + ' 小时');

  const dayInfo = nightInfoFor(db(), { theme: 'night', skill: 'night' }, at(12));
  check('白天 active = false', dayInfo.active === false);
  check('白天 bonus = false', dayInfo.bonus === false);
  check('白天 stealCd = 60', dayInfo.stealCd === 60);

  const other = nightInfoFor(db(), { theme: 'red', skill: 'red' }, at(21));
  check('别的主题夜里也没有 bonus', other.bonus === false && other.stealCd === 60);

  // 边界：正好 4:00 应该算白天，倒计时要指向今晚 18:00
  const at4 = nightInfoFor(db(), { theme: 'night', skill: 'night' }, at(4, 0));
  check('4:00 已经不算夜里', at4.active === false);
  check('4:00 的倒计时指向 18:00（14 小时）',
    Math.abs(at4.msLeft - 14 * 3600000) < 60000, Math.round(at4.msLeft / 3600000) + ' 小时');
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 结算时用 cd 推 stealReadyAt（模拟 server.js 那两行）===');
{
  const stealTick = 1000;
  const p = { theme: 'night', skill: 'night', stealReadyAt: 0 };
  const cd = stealCooldownFor(db(), p, at(21));
  p.stealReadyAt = stealTick + cd;
  check('夜行者夜里偷完只要等 5 轮', p.stealReadyAt === 1005);

  const q = { theme: 'night', skill: 'night', stealReadyAt: 0 };
  q.stealReadyAt = stealTick + stealCooldownFor(db(), q, at(12));
  check('同样的人白天偷完要等 60 轮', q.stealReadyAt === 1060);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 跨零点窗口的倒计时不会算反 ===');
{
  const win = nightWindow(db(), at(2));
  const left = nextNightBoundaryMs(db(), win, at(2));
  check('凌晨 2 点的倒计时指向 4:00（2 小时）',
    Math.abs(left - 2 * 3600000) < 60000, Math.round(left / 3600000) + ' 小时');
  const win2 = nightWindow(db(), at(19));
  const left2 = nextNightBoundaryMs(db(), win2, at(19));
  check('晚上 19 点的倒计时指向次日 4:00（9 小时）',
    Math.abs(left2 - 9 * 3600000) < 60000, Math.round(left2 / 3600000) + ' 小时');
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
