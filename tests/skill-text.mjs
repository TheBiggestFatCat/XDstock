// 主题技能文案：必须跟后台配置自动一致（2026-11 改）
//   node tests/skill-text.mjs
//
// 规则：
//   - 商城卡片上的技能描述由 src/skillText.js 用 db.config 生成，前端不写死任何数字
//   - 每个主题给两段：t1 = 一级技能，t2 = 二级技能（进化后解锁）
//   - 后台把参数改了，文案里的数字必须跟着变（改 20 → 12，文案就得是 12）

import { buildSkillText, skillTextPayload, SKILL_TEXT_THEMES } from '../src/skillText.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { darkImpactMult } from '../src/trading.js';
import { ensureAchvState } from '../src/achievements.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

const base = () => ({ ...DEFAULT_CONFIG });
const has = (s, ...needles) => needles.every((n) => String(s).includes(n));

// ================================================================ 1
log('=== 1 八个主题都有一级 + 二级文案 ===');
{
  const t = buildSkillText(base());
  check('主题数量 = 8', Object.keys(t).length === 8, Object.keys(t).join(','));
  for (const code of SKILL_TEXT_THEMES) {
    const x = t[code];
    check(`${code} 有 t1 / t2`, !!x && !!x.t1 && !!x.t2, x ? `${x.t1.length}/${x.t2.length} 字` : '缺');
  }
  check('文案里没有 undefined / NaN',
    Object.values(t).every((x) => !/undefined|NaN|null/.test(x.t1 + x.t2)));
  check('每个主题的 t1 和 t2 不能一样',
    Object.values(t).every((x) => x.t1 !== x.t2));
}

// ================================================================ 2
log('');
log('=== 2 数字全部来自配置：改了参数文案立刻变 ===');
{
  const cfg = base();
  cfg.tycoonLeadTicks = 12;
  cfg.tycoonLeadTicksEvolved = 45;
  const t = buildSkillText(cfg);
  check('大鳄一级文案用 tycoonLeadTicks', has(t.tycoon.t1, '12 轮'), t.tycoon.t1);
  check('大鳄二级文案用 tycoonLeadTicksEvolved', has(t.tycoon.t2, '45 轮'), t.tycoon.t2);

  cfg.hermitHideChance = 0.35;
  cfg.hermitHideChanceEvolved = 0.9;
  const t2 = buildSkillText(cfg);
  check('隐世一级用 hermitHideChance', has(t2.hermit.t1, '35%'), t2.hermit.t1);
  check('隐世二级用 hermitHideChanceEvolved', has(t2.hermit.t2, '90%'), t2.hermit.t2);

  cfg.redBonusRate = 0.025;
  cfg.bearBonusRate = 0.03;
  cfg.redBonusMinTicks = 30;
  cfg.bearBonusMinTicks = 45;
  const t3 = buildSkillText(cfg);
  check('红牛返现率', has(t3.red.t1, '2.5%', '30 轮'), t3.red.t1);
  check('绿熊返现率', has(t3.bear.t1, '3%', '45 轮'), t3.bear.t1);

  cfg.darkImpactBase = 1.2;
  cfg.themeEvolveImpact = 1.5;
  cfg.themeEvolveImpactRefund = 0.35;
  const t4 = buildSkillText(cfg);
  check('暗黑一级用 darkImpactBase', has(t4.dark.t1, '×1.20', '20%'), t4.dark.t1);
  check('暗黑二级用 themeEvolveImpact + refund', has(t4.dark.t2, '×1.50', '35%'), t4.dark.t2);

  cfg.investigateCooldownTicks = 60;
  cfg.investigateCooldownEvolved = 5;
  const t5 = buildSkillText(cfg);
  check('调查冷却（一级/二级）', has(t5.probe.t1, '60 轮') && has(t5.probe.t2, '5 轮'),
    `${t5.probe.t1} ‖ ${t5.probe.t2}`);

  cfg.mindFakeChance = 0.8;
  cfg.mindAccurateChanceEvolved = 0.95;
  const t6 = buildSkillText(cfg);
  check('读心一级用 mindFakeChance', has(t6.mind.t1, '80%'), t6.mind.t1);
  check('读心二级用准确率 + 反推假读数', has(t6.mind.t2, '95%', '5%'), t6.mind.t2);

  cfg.nightStartHour = 20;
  cfg.nightEndHour = 6;
  cfg.stealCooldownTicks = 90;
  cfg.nightStealCooldown = 4;
  cfg.nightStealCooldownEvolved = 2;
  const t7 = buildSkillText(cfg);
  check('夜行时间窗按配置补零', has(t7.night.t1, '20:00 ~ 06:00'), t7.night.t1);
  check('夜行冷却（白天/夜里/进化）', has(t7.night.t1, '90 轮', '4 轮') && has(t7.night.t2, '2 轮'),
    `${t7.night.t1} ‖ ${t7.night.t2}`);
}

// ================================================================ 3
log('');
log('=== 3 红牛/绿熊的二级技能 = 返现倍率（按 docs/主题技能.md）===');
{
  const t = buildSkillText({ ...base(), redBonusRate: 0.01, bearBonusRate: 0.01, themeEvolveSkillMult: 1.5 });
  check('红牛二级写 1.5%', has(t.red.t2, '1.5%'), t.red.t2);
  check('绿熊二级写 1.5%', has(t.bear.t2, '1.5%'), t.bear.t2);
  check('二级文案里不再提「免手续费」', !has(t.red.t2, '手续费'), t.red.t2);
  check('二级文案里不再提「保证金」', !has(t.bear.t2, '保证金'), t.bear.t2);

  const t2 = buildSkillText({ ...base(), redBonusRate: 0.02, themeEvolveSkillMult: 2 });
  check('倍率跟着配置走（2% × 2 = 4%）', has(t2.red.t2, '4%'), t2.red.t2);
}

// ================================================================ 4
log('');
log('=== 4 配置缺字段 / 脏值不炸（回落到默认）===');
{
  const t = buildSkillText({});
  check('空配置也能出八条文案', Object.keys(t).length === 8);
  check('空配置没有 undefined/NaN', Object.values(t).every((x) => !/undefined|NaN|null/.test(x.t1 + x.t2)));
  check('空配置用默认提前量 20/40', has(t.tycoon.t1, '20 轮') && has(t.tycoon.t2, '40 轮'));

  const dirty = buildSkillText({
    tycoonLeadTicks: 'abc', hermitHideChance: null, redBonusRate: undefined,
    nightStartHour: 'x', darkImpactBase: NaN, mindFakeChance: -1
  });
  check('脏值不产生 NaN/undefined',
    Object.values(dirty).every((x) => !/undefined|NaN|null/.test(x.t1 + x.t2)));
  check('脏值回落到默认（大鳄 20 轮）', has(dirty.tycoon.t1, '20 轮'), dirty.tycoon.t1);
}

// ================================================================ 5
log('');
log('=== 5 和引擎真正用的值一致（不能文案写 1.05、实际跑 1.08）===');
{
  const db = { config: { ...base(), darkImpactBase: 1.17, themeEvolveImpact: 1.44 } };
  const plain = { id: 'p1', skill: 'dark', themeTier: { dark: 1 }, achv: {}, achvCounters: {} };
  const evo = { id: 'p2', skill: 'dark', themeTier: { dark: 2 }, achv: {}, achvCounters: {} };
  ensureAchvState(plain);
  ensureAchvState(evo);
  check('一级：引擎倍率 = 文案数字', Math.abs(darkImpactMult(db, plain) - 1.17) < 1e-9,
    String(darkImpactMult(db, plain)));
  check('二级：引擎倍率 = 文案数字', Math.abs(darkImpactMult(db, evo) - 1.44) < 1e-9,
    String(darkImpactMult(db, evo)));
  const t = buildSkillText(db.config);
  check('文案里写的就是 1.17 / 1.44', has(t.dark.t1, '1.17') && has(t.dark.t2, '1.44'),
    `${t.dark.t1} ‖ ${t.dark.t2}`);
  check('非暗黑号倍率 = 1', darkImpactMult(db, { id: 'x', skill: 'red', themeTier: {} }) === 1);
}

// ================================================================ 6
log('');
log('=== 6 接口 payload 形状 ===');
{
  const p = skillTextPayload({ config: base() });
  check('有 texts 和时间戳', !!p.texts && typeof p.at === 'number');
  check('texts 覆盖 8 个主题', Object.keys(p.texts).length === 8);
  check('可以 JSON 序列化（不会有函数/undefined）',
    typeof JSON.stringify(p) === 'string' && !JSON.stringify(p).includes('undefined'));
}

// ================================================================ 7
log('');
log('=== 7 配置被改反了也不会说反话（进化反而更弱时用「降到/升到」）===');
{
  const rev = buildSkillText({
    ...base(),
    tycoonLeadTicks: 30, tycoonLeadTicksEvolved: 12,
    hermitHideChance: 0.9, hermitHideChanceEvolved: 0.4,
    darkImpactBase: 1.3, themeEvolveImpact: 1.1,
    investigateCooldownTicks: 5, investigateCooldownEvolved: 40,
    stealCooldownTicks: 1, nightStealCooldown: 5, nightStealCooldownEvolved: 9
  });
  check('大鳄：提前量变少 → 说「降到」', has(rev.tycoon.t2, '降到', '12 轮'), rev.tycoon.t2);
  check('隐世：隐身概率变少 → 说「降到」', has(rev.hermit.t2, '降到', '40%'), rev.hermit.t2);
  check('暗黑：冲击倍率变低 → 说「降到」', has(rev.dark.t2, '降到', '1.10'), rev.dark.t2);
  check('调查：冷却变长 → 说「提高到」', has(rev.probe.t2, '提高', '40 轮'), rev.probe.t2);
  check('夜行：夜里比白天还长 → 说「升到」（不能写成「降到」）',
    has(rev.night.t1, '1 轮', '升到', '5 轮') && !has(rev.night.t1, '降到'), rev.night.t1);
  check('夜行二级同理', has(rev.night.t2, '升到', '9 轮'), rev.night.t2);

  // 正着配的时候仍然是「降到 / 提高到」
  const ok = buildSkillText({ ...base(), stealCooldownTicks: 60, nightStealCooldown: 5, nightStealCooldownEvolved: 3 });
  check('正常配置：60 → 5 说「降到」', has(ok.night.t1, '60 轮', '降到', '5 轮'), ok.night.t1);
  check('正常配置：5 → 3 也是「降到」', has(ok.night.t2, '降到', '3 轮'), ok.night.t2);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
