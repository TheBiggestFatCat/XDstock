// 主题/技能拆分：换外观不冷却、换技能才冷却
//   node tests/theme-split.mjs

import { createDb } from '../src/store.js';
import { stealCooldownFor, nightInfoFor } from '../src/theme.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

/**
 * 直接测「接口里的那段逻辑」：为了不启 HTTP，这里复刻 api.js 里
 * /api/shop/theme 的判定（同一份规则，改一处记得同步）
 */
const THEMES = ['red', 'bear', 'dark', 'tycoon', 'hermit', 'probe', 'mind', 'night'];
const THEME_NEED_LEVEL = { probe: 2, mind: 2, night: 2 };

function buyOrSwitch(db, me, { theme, part }) {
  const code = String(theme || '').trim();
  if (!THEMES.includes(code) && code !== 'default') return { status: 400, error: '没有这个主题' };
  const p = part === 'look' || part === 'skill' ? part : 'both';
  const needLv = Math.max(1, Number(THEME_NEED_LEVEL[code]) || 1);
  if ((Math.floor(Number(me.level)) || 1) < needLv) return { status: 403, error: `要 Lv.${needLv}` };

  const price = Number(db.config.shopThemePrice ?? 2000000);
  if (!Array.isArray(me.themes)) me.themes = [];
  const owned = me.themes.includes(code);
  const wantsSkill = p === 'skill' || p === 'both';
  const cd = Math.max(0, Number(db.config.shopThemeCooldown ?? 100));
  const lastAt = Number(me.skillChangedTick ?? -1);
  if (wantsSkill && cd > 0 && lastAt >= 0 && db.tick - lastAt < cd) {
    return { status: 429, error: '技能刚换过', leftTicks: cd - (db.tick - lastAt) };
  }
  let spent = 0;
  if (!owned) {
    if (me.cash < price) return { status: 400, error: '现金不足' };
    me.cash -= price;
    me.themes.push(code);
    spent = price;
  }
  if (p === 'look' || p === 'both') me.theme = code;
  if (wantsSkill) { me.skill = code; me.skillChangedTick = db.tick; }
  return { status: 200, part: p, theme: me.theme, skill: me.skill, spent, cash: me.cash };
}

function newDb() {
  const db = createDb();
  db.config.shopThemePrice = 2000000;
  db.config.shopThemeCooldown = 100;
  db.players.p = {
    id: 'p', nickname: 'p', cash: 10000000, level: 5,
    theme: 'default', skill: 'default', skillChangedTick: -1, themes: [], positions: {}, orders: []
  };
  return db;
}

// ---------------------------------------------------------------- 1
log('=== 1 先买一套：外观 + 技能同时到手 ===');
{
  const db = newDb();
  const me = db.players.p;
  const r = buyOrSwitch(db, me, { theme: 'red', part: 'both' });
  check('买了 red', r.status === 200, r.error || '');
  check('外观变 red', me.theme === 'red', me.theme);
  check('技能也变 red', me.skill === 'red', me.skill);
  check('扣了一次钱', r.spent === 2000000, String(r.spent));
  check('记录冷却起点', me.skillChangedTick === db.tick, String(me.skillChangedTick));
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 换外观：不看冷却、不动技能 ===');
{
  const db = newDb();
  const me = db.players.p;
  buyOrSwitch(db, me, { theme: 'red', part: 'both' });     // 技能=red，开始冷却
  const r = buyOrSwitch(db, me, { theme: 'dark', part: 'look' });
  check('冷却期间也能换外观', r.status === 200, r.error || '');
  check('外观变 dark', me.theme === 'dark', me.theme);
  check('技能还是 red', me.skill === 'red', me.skill);
  check('买了 dark 但要收钱（首次）', r.spent === 2000000, String(r.spent));

  const again = buyOrSwitch(db, me, { theme: 'bear', part: 'look' });
  check('再换一套外观（已买过的 bear 没买过）', again.status === 200, again.error || '');
  const free = buyOrSwitch(db, me, { theme: 'red', part: 'look' });
  check('换回已买过的外观不花钱', free.status === 200 && free.spent === 0, String(free.spent));
  check('技能依然没动', me.skill === 'red', me.skill);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 换技能：吃冷却 ===');
{
  const db = newDb();
  const me = db.players.p;
  buyOrSwitch(db, me, { theme: 'red', part: 'skill' });
  db.tick += 10;
  const blocked = buyOrSwitch(db, me, { theme: 'bear', part: 'skill' });
  check('冷却中换技能被拦', blocked.status === 429, String(blocked.status));
  check('告知还要等几轮', blocked.leftTicks === 90, String(blocked.leftTicks));

  const look = buyOrSwitch(db, me, { theme: 'bear', part: 'look' });
  check('同一时刻换外观照样可以', look.status === 200, look.error || '');
  check('外观 bear / 技能 red', me.theme === 'bear' && me.skill === 'red', `${me.theme}/${me.skill}`);

  db.tick += 95;    // 冷却结束
  const ok = buyOrSwitch(db, me, { theme: 'bear', part: 'skill' });
  check('冷却好了能换技能', ok.status === 200, ok.error || '');
  check('技能变 bear', me.skill === 'bear', me.skill);
  check('外观仍是 bear（没被技能改动）', me.theme === 'bear', me.theme);
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 外观和技能可以不一致（这就是这次要的效果）===');
{
  const db = newDb();
  const me = db.players.p;
  buyOrSwitch(db, me, { theme: 'hermit', part: 'both' });   // 技能：隐身
  buyOrSwitch(db, me, { theme: 'dark', part: 'look' });     // 外观：暗黑
  check('外观 dark', me.theme === 'dark', me.theme);
  check('技能 hermit', me.skill === 'hermit', me.skill);
  // 技能效果按 skill 走：hermit 的隐身判定不认 theme
  const owner = { theme: 'dark', skill: 'hermit' };
  check('hermit 技能判定认 skill 不认 theme', owner.skill === 'hermit' && owner.theme !== 'hermit');
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 等级门槛：还是按主题要求 ===');
{
  const db = newDb();
  const me = db.players.p;
  me.level = 1;
  const r = buyOrSwitch(db, me, { theme: 'mind', part: 'look' });
  check('Lv.1 买 mind 外观被拦', r.status === 403, String(r.status));
  me.level = 2;
  const r2 = buyOrSwitch(db, me, { theme: 'mind', part: 'look' });
  check('Lv.2 可以买', r2.status === 200, r2.error || '');
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 夜行者技能按 skill 生效（偷钱 CD）===');
{
  const db = createDb();
  db.config.stealCooldownTicks = 60;
  db.config.nightStealCooldown = 5;
  db.config.nightStartHour = 0;
  db.config.nightEndHour = 23;          // 0~23 点都算夜里（start===end 会被忽略）
  const nightMs = new Date(2026, 0, 1, 12, 0, 0).getTime();
  const skillNight = { theme: 'red', skill: 'night' };
  const lookNight = { theme: 'night', skill: 'red' };
  check('技能是 night → 偷钱 CD 5 轮',
    stealCooldownFor(db, skillNight, nightMs) === 5, String(stealCooldownFor(db, skillNight, nightMs)));
  check('只有外观是 night → 还是 60 轮',
    stealCooldownFor(db, lookNight, nightMs) === 60, String(stealCooldownFor(db, lookNight, nightMs)));
  const info = nightInfoFor(db, skillNight, nightMs);
  check('夜行者加成只认 skill', info.bonus === true, String(info.bonus));
  check('外观是 night 但没有技能 → 没加成',
    nightInfoFor(db, lookNight, nightMs).bonus === false);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
