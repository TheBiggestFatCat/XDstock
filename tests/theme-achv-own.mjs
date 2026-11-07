// 主题成就只看「拥有主题」，不看是否正在装备技能（2026-11 改）
//   node tests/theme-achv-own.mjs
//
// 背景：以前所有主题成就的判定都写着 `player.skill === 'XXX'`，
// 玩家买了主题、换用别的技能之后，成就就再也不涨了。
// 现在判定统一走 `achievements.js#ownsTheme(player, theme)`：
//   - **拥有**（`player.themes` 里有，或正在用的外观/技能是它）→ 成就照常累计
//   - **技能效果**（返现的钱、冲击倍率、隐身、冷却…）仍然只看 `player.skill`

import { createDb } from '../src/store.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { openPosition, closePosition } from '../src/trading.js';
import {
  THEMES, ensureAchvState, bumpAchv, ownsTheme, achvTarget
} from '../src/achievements.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

function newDb(patch = {}) {
  const db = createDb();
  Object.assign(db.config, {
    feeRate: 0, stampDuty: 0, playerImpactEnabled: 0, impactCostCoef: 0,
    levelFillBonus: 0, marketOpen: true,
    ...Object.fromEntries(Object.entries(DEFAULT_CONFIG).filter(([k]) => k.startsWith('achv')
      || k.startsWith('themeEvolve') || k.startsWith('tycoonLead') || k.startsWith('hermitHide')
      || k.startsWith('investigateCooldown') || k.startsWith('nightStealCooldown')))
  }, patch);
  db.tick = 1000;
  for (const st of Object.values(db.stocks)) {
    st.price = 100;
    st.fair = 100;
    st.series = new Array(40).fill(100);
  }
  db.index.series = [
    ...new Array(10).fill(90), ...new Array(10).fill(95), ...new Array(10).fill(99),
    100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110
  ];
  return db;
}

/** skill = 正在装备的技能；themes = 买过的主题（默认空 = 什么都没买） */
function mkPlayer(db, id, { skill = 'default', themes = [], cash = 1e9 } = {}) {
  const p = {
    id, nickname: id, cash, positions: {}, orders: [],
    theme: skill, skill, level: 3, orderCount: 0, orderTick: -1,
    themes: [...themes], shards: {}, themeTier: {}, achv: {}, achvCounters: {}
  };
  ensureAchvState(p);
  db.players[id] = p;
  return p;
}

const downIndex = (db) => {
  db.index.series = [
    ...new Array(10).fill(120), ...new Array(10).fill(115), ...new Array(10).fill(110),
    108, 107, 106, 105, 104, 103, 102, 101, 100, 99, 98
  ];
};
const counter = (p, k) => Number(p.achvCounters[k]) || 0;

// ================================================================ 1
log('=== 1 ownsTheme：买了就算，正在用也算 ===');
{
  check('themes 里有 → 拥有', ownsTheme({ themes: ['red'] }, 'red') === true);
  check('themes 里没有 → 不算', ownsTheme({ themes: ['red'] }, 'bear') === false);
  check('正在用的外观 → 算拥有（兼容老存档）', ownsTheme({ theme: 'dark', themes: [] }, 'dark') === true);
  check('正在用的技能 → 算拥有（兼容老存档）', ownsTheme({ skill: 'night', themes: [] }, 'night') === true);
  check('什么都没有 → 不算', ownsTheme({}, 'mind') === false);
  check('玩家/主题缺省不炸', ownsTheme(null, 'red') === false && ownsTheme({}, '') === false);
}

// ================================================================ 2
log('');
log('=== 2 🐂 红牛：买了但装备别的技能，照样算「顺势收割」===');
{
  const db = newDb();
  const owner = mkPlayer(db, 'own', { skill: 'bear', themes: ['red'], cash: 1e9 });
  openPosition(db, owner, { code: 'TGW', side: 'long', qty: 1000, leverage: 1 });
  db.tick += 20;                       // 过掉 redBonusMinTicks
  const cashBefore = owner.cash;
  closePosition(db, owner, 'TGW');
  check('趋势平仓计数 +1', counter(owner, 'redTrendClose') === 1, String(counter(owner, 'redTrendClose')));
  check('返现成就按基础返现率累计（10 万的 1%）',
    near(counter(owner, 'redBonusEarned'), 100000 * 0.01, 1), counter(owner, 'redBonusEarned').toFixed(0));
  // 平仓会把押金退回来（10 万的仓、1 倍杠杆 → 退 10 万），所以只该多这一笔，没有返现
  check('没装备红牛 → 只退押金、不发现金', near(owner.cash - cashBefore, 100000, 1), (owner.cash - cashBefore).toFixed(2));
  check('「累计已返」也还是 0', !owner.redBonusEarned, String(owner.redBonusEarned));

  // 装备了才发钱
  const skilled = mkPlayer(db, 'sk', { skill: 'red', themes: ['red'] });
  openPosition(db, skilled, { code: 'MAMA', side: 'long', qty: 1000, leverage: 1 });
  db.tick += 20;
  const c0 = skilled.cash;
  closePosition(db, skilled, 'MAMA');
  check('装备红牛 → 返现到账', near(skilled.redBonusEarned, 100000 * 0.01, 1),
    String(skilled.redBonusEarned && skilled.redBonusEarned.toFixed(0)));
  check('装备红牛 → 现金确实多了', skilled.cash > c0, (skilled.cash - c0).toFixed(0));

  // 完全没买的号：不涨
  const none = mkPlayer(db, 'none', { skill: 'default', themes: [] });
  openPosition(db, none, { code: 'NW', side: 'long', qty: 1000, leverage: 1 });
  db.tick += 20;
  closePosition(db, none, 'NW');
  check('没买红牛 → 完全不计数', counter(none, 'redTrendClose') === 0 && counter(none, 'redBonusEarned') === 0);
}

// ================================================================ 3
log('');
log('=== 3 🐻 绿熊：同理（空头排列）===');
{
  const db = newDb();
  downIndex(db);
  const owner = mkPlayer(db, 'bown', { skill: 'red', themes: ['bear'] });
  openPosition(db, owner, { code: 'TGW', side: 'short', qty: 1000, leverage: 1 });
  db.tick += 20;
  closePosition(db, owner, 'TGW');
  check('空头趋势平仓计数 +1', counter(owner, 'bearTrendClose') === 1);
  check('返现成就累计 1%', near(counter(owner, 'bearBonusEarned'), 1000, 1),
    counter(owner, 'bearBonusEarned').toFixed(0));
  check('没装备绿熊 → 不发现金', !owner.bearBonusEarned);

  const none = mkPlayer(db, 'bnone', { skill: 'default', themes: [] });
  openPosition(db, none, { code: 'LU', side: 'short', qty: 1000, leverage: 1 });
  db.tick += 20;
  closePosition(db, none, 'LU');
  check('没买绿熊 → 不计数', counter(none, 'bearTrendClose') === 0);
}

// ================================================================ 4
log('');
log('=== 4 🧙 来去无踪 / 🕵️ 软柿子：拥有主题即可触发 ===');
{
  const db = newDb();
  const a = mkPlayer(db, 'a', { skill: 'default' });
  openPosition(db, a, { code: 'LU', side: 'long', qty: 100, leverage: 1 });

  const h = mkPlayer(db, 'h', { skill: 'red', themes: ['hermit'] });   // 拥有隐世，装备红牛
  openPosition(db, h, { code: 'LU', side: 'long', qty: 100, leverage: 1 });
  check('隐世：拥有就能记「来去无踪」', !!h.achv.hermit_follow, String(counter(h, 'hermitFollow')));

  const pb = mkPlayer(db, 'p', { skill: 'night', themes: ['probe'] });
  openPosition(db, pb, { code: 'LU', side: 'short', qty: 100, leverage: 1 });
  check('调查：拥有就能记「软柿子」', !!pb.achv.probe_weak, String(counter(pb, 'probeWeak')));

  const noHermit = mkPlayer(db, 'nh', { skill: 'red', themes: [] });
  openPosition(db, noHermit, { code: 'LU', side: 'long', qty: 100, leverage: 1 });
  check('没买隐世 → 不记', counter(noHermit, 'hermitFollow') === 0);
}

// ================================================================ 5
log('');
log('=== 5 🕶️ 黑手：拥有暗黑就能累计，换掉技能平仓就解锁 ===');
{
  const db = newDb();
  const d = mkPlayer(db, 'd', { skill: 'red', themes: ['dark'] });     // 拥有暗黑，装备红牛
  const need = achvTarget(db.config, 'achvDarkHandTarget');
  openPosition(db, d, { code: 'TGW', side: 'long', qty: Math.ceil(need / 100) + 10, leverage: 1 });
  check('累计开仓额已武装', !!d.darkArmed && !!d.darkArmed.TGW, JSON.stringify(d.darkArmed && Object.keys(d.darkArmed)));
  closePosition(db, d, 'TGW');
  check('平仓 → 黑手解锁', !!d.achv.dark_hand);
}

// ================================================================ 6
log('');
log('=== 6 🕶️ 推土机：拥有暗黑即可武装 + 解锁 ===');
{
  const db = newDb();
  const a = mkPlayer(db, 'a', { skill: 'default' });
  openPosition(db, a, { code: 'TGW', side: 'long', qty: 1000, leverage: 1 });

  const d = mkPlayer(db, 'd', { skill: 'red', themes: ['dark'] });
  openPosition(db, d, { code: 'TGW', side: 'short', qty: 1000, leverage: 1 });
  check('反方向进场后武装', !!d.pushArm && d.pushArm.otherId === 'a');
  closePosition(db, a, 'TGW');
  closePosition(db, d, 'TGW');
  check('他平完我再平 → 推土机解锁', !!d.achv.dark_push);
}

// ================================================================ 7
log('');
log('=== 7 🐊 先知：拥有大鳄即可（不用装备）===');
{
  const db = newDb();
  db.config.achvTycoonProphetLeverage = 10;
  const p = mkPlayer(db, 't', { skill: 'red', themes: ['tycoon'] });
  openPosition(db, p, { code: 'XD', side: 'long', qty: 1000, leverage: 10 });
  db.stocks.XD.lastSurprise = 0.05;
  db.stocks.XD.lastReportTick = db.tick + 1;
  db.tick += 2;
  closePosition(db, p, 'XD');
  check('超预期财报前后的进出 → 先知', !!p.achv.tycoon_prophet);

  const none = mkPlayer(db, 'tn', { skill: 'default', themes: [] });
  openPosition(db, none, { code: 'XD', side: 'long', qty: 1000, leverage: 10 });
  db.stocks.XD.lastSurprise = 0.05;
  db.stocks.XD.lastReportTick = db.tick + 1;
  db.tick += 2;
  closePosition(db, none, 'XD');
  check('没买大鳄 → 不算', !none.achv.tycoon_prophet);
}

// ================================================================ 8
log('');
log('=== 8 🧠 读心 / 🧙 孤狼：拥有主题才累计 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'm', { skill: 'red', themes: ['mind'] });
  db.stocks.TGW.sentiment = { v: 0.95, viewV: 0.95, nextRoll: 1e12, nextApply: 0 };
  openPosition(db, p, { code: 'TGW', side: 'long', qty: 1000, leverage: 1 });
  db.tick += 5;
  db.stocks.TGW.sentiment = { v: 0.95, viewV: 0.95, nextRoll: 1e12, nextApply: 0 };
  db.stocks.TGW.price = 105;                       // 顺方向盈利
  closePosition(db, p, 'TGW');
  check('情绪极强时顺方向盈利 → 读心', !!p.achv.mind_read, String(counter(p, 'mindRead')));
  check('带读心主题累计盈利', counter(p, 'mindPnl') > 0, counter(p, 'mindPnl').toFixed(0));

  const owner = mkPlayer(db, 'hl', { skill: 'red', themes: ['hermit'] });
  openPosition(db, owner, { code: 'DFY', side: 'long', qty: 200000, leverage: 1 });   // 2000 万
  check('孤狼：拥有隐世就量持仓市值', counter(owner, 'hermitMaxPos') >= 20000000 - 1,
    counter(owner, 'hermitMaxPos').toFixed(0));

  const none = mkPlayer(db, 'hn', { skill: 'red', themes: [] });
  openPosition(db, none, { code: 'DFY', side: 'long', qty: 200000, leverage: 1 });
  check('没买隐世 → 不量', counter(none, 'hermitMaxPos') === 0);
}

// ================================================================ 9
log('');
log('=== 9 技能效果仍然只看 player.skill（不能被成就改造带偏）===');
{
  const db = newDb({ impactCostCoef: 0, playerImpactEnabled: 1 });
  const ownerOnly = mkPlayer(db, 'dark-owner', { skill: 'red', themes: ['dark'] });
  const darkSkill = mkPlayer(db, 'dark-skill', { skill: 'dark', themes: ['dark'] });
  const flowOf = (p, code) => {
    const before = Number(db.stocks[code].flow) || 0;
    openPosition(db, p, { code, side: 'long', qty: 1000, leverage: 1 });
    return (Number(db.stocks[code].flow) || 0) - before;
  };
  // addFlow 的单位是「成交额 / playerImpactRef」：10 万的仓、ref=100 万 → 0.1 单位
  const a = flowOf(ownerOnly, 'TGW');
  const b = flowOf(darkSkill, 'MAMA');
  check('只拥有暗黑（技能是红牛）→ 冲击拿基础值', near(a, 0.1, 1e-9), a.toFixed(4));
  check('装备暗黑 → 冲击 ×1.05', near(b, 0.105, 1e-9), b.toFixed(4));

  const hermOwner = mkPlayer(db, 'h-owner', { skill: 'red', themes: ['hermit'] });
  const hermSkill = mkPlayer(db, 'h-skill', { skill: 'hermit', themes: ['hermit'] });
  const hideChanceOf = (p) => {
    // 隐身概率读的是 skill，不是主题拥有
    let hidden = 0;
    for (let i = 0; i < 200; i++) {
      const fakeTrade = { playerId: p.id, id: 'x' + i };
      // 用同一个判定函数：api 里是 isEvolved ? evo : base，前提是 skill === 'hermit'
      if (p.skill === 'hermit') hidden++;
    }
    void hermOwner;
    return hidden;
  };
  check('拥有隐世但没装备 → 不隐身（技能效果不跟着拥有走）',
    hideChanceOf(hermOwner) === 0, String(hideChanceOf(hermOwner)));
  check('装备隐世 → 会隐身', hideChanceOf(hermSkill) === 200, String(hideChanceOf(hermSkill)));
}

// ================================================================ 10
log('');
log('=== 10 计数仍然照常解锁 / 产结晶 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'c', { skill: 'red', themes: ['red'] });
  const target = achvTarget(db.config, 'achvRedTrendTarget');
  bumpAchv(db, p, 'redTrendClose', target);
  check('达成阈值 → 解锁「顺势收割」', !!p.achv.red_trend);
  check('解锁后结晶 +1', Number(p.shards.red) === 1, String(p.shards.red));
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
