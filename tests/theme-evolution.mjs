// 主题成就 + 主题进化（Lv1 → Lv2）回归测试
//
//   node tests/theme-evolution.mjs
//
// 只在内存里造 db，直接调 src/* 的函数，不碰 data/db.json、不起 HTTP 服务。

import { createDb } from '../src/store.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { openPosition, closePosition } from '../src/trading.js';
import {
  THEME_ACHIEVEMENTS, THEMES, THEME_EMOJI, achvTarget, ensureAchvState,
  bumpAchv, grantAchv, canEvolve, evolveTheme, themeTier, isEvolved,
  themeAchvProgress, themeEmojiList, achvPayload, tycoonLeadTicks
} from '../src/achievements.js';
import { investigatePlayer } from '../src/api.js';
import { stealCooldownFor } from '../src/theme.js';

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
    feeRate: 0.0005,
    stampDuty: 0.0005,
    playerImpactEnabled: 0,
    impactCostCoef: 0,
    impactCostMax: 0.06,
    levelFillBonus: 0,
    marketOpen: true,
    // 成就阈值按代码默认值，别被线上 config 影响
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
  // 默认把指数做成「多头排列」，需要空头的用例自己改
  db.index.series = [
    ...new Array(10).fill(90),
    ...new Array(10).fill(95),
    ...new Array(10).fill(99),
    100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110
  ];
  return db;
}
function mkPlayer(db, id, cash = 1e9, skill = 'default') {
  db.players[id] = {
    id, nickname: id, cash, positions: {}, orders: [],
    theme: skill, skill, level: 1, orderCount: 0, orderTick: -1,
    themes: [...THEMES], shards: {}, themeTier: {}, achv: {}, achvCounters: {}
  };
  ensureAchvState(db.players[id]);
  return db.players[id];
}
const downIndex = (db) => {
  db.index.series = [
    ...new Array(10).fill(120),
    ...new Array(10).fill(115),
    ...new Array(10).fill(110),
    108, 107, 106, 105, 104, 103, 102, 101, 100, 99, 98
  ];
};

// ---------------------------------------------------------------- 1
log('=== 1 定义：8 个主题 × 2 条 = 16 条，阈值都走配置 ===');
{
  const db = newDb();
  check('16 条主题成就', THEME_ACHIEVEMENTS.length === 16, String(THEME_ACHIEVEMENTS.length));
  check('8 个主题', THEMES.length === 8, THEMES.join(','));
  const perTheme = {};
  for (const a of THEME_ACHIEVEMENTS) perTheme[a.theme] = (perTheme[a.theme] || 0) + 1;
  check('每个主题正好 2 条', Object.values(perTheme).every((n) => n === 2), JSON.stringify(perTheme));
  check('每条都有 emoji', THEME_ACHIEVEMENTS.every((a) => !!a.emoji));
  check('红牛趋势阈值从配置读', achvTarget(db.config, 'achvRedTrendTarget') === 20);
  check('暗黑累计阈值从配置读', achvTarget({ ...db.config, achvDarkHandTarget: 5000 }, 'achvDarkHandTarget') === 5000);
  check('未知键有兜底', achvTarget({}, 'achvShardPerEvolve') === 2);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 计数器 → 解锁 → 结晶 +1 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'a');
  check('初始 0 条', themeAchvProgress(p, 'red').every((x) => !x.got));
  const got1 = bumpAchv(db, p, 'redTrendClose', 19);
  check('19 次还差一次', got1.length === 0 && p.achvCounters.redTrendClose === 19);
  const got2 = bumpAchv(db, p, 'redTrendClose', 1);
  check('第 20 次解锁「顺势收割」', got2.length === 1 && got2[0].id === 'red_trend');
  check('结晶 +1', p.shards.red === 1, String(p.shards.red));
  check('成就点 +40', p.achvPoints === 40, String(p.achvPoints));
  check('重复触发不会再加结晶', bumpAchv(db, p, 'redTrendClose', 5).length === 0 && p.shards.red === 1);
  check('进度百分比给前端', themeAchvProgress(p, 'red')[0].progress >= 20);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 进化门槛：两条成就 + 2 结晶 + 已购买 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'a', 1e9, 'red');
  p.themes = ['red'];
  check('没成就不能进化', canEvolve(db, p, 'red') === false);
  const r0 = evolveTheme(db, p, 'red');
  check('进化被拒且给原因', r0.ok === false && /还差成就/.test(r0.error || ''), r0.error || '');

  grantAchv(db, p, 'red_trend');
  check('一条成就 + 1 结晶还是不够', canEvolve(db, p, 'red') === false);
  grantAchv(db, p, 'red_bonus');
  check('两条成就 + 2 结晶可以进化', canEvolve(db, p, 'red') === true, `shards=${p.shards.red}`);
  const r1 = evolveTheme(db, p, 'red');
  check('进化成功 → Ⅱ 阶', r1.ok === true && themeTier(p, 'red') === 2);
  check('结晶被扣掉 2 枚', p.shards.red === 0, String(p.shards.red));
  const r2 = evolveTheme(db, p, 'red');
  check('不能重复进化', r2.ok === false && /已经进化/.test(r2.error || ''), r2.error || '');

  const p2 = mkPlayer(db, 'b', 1e9, 'red');
  p2.themes = [];                      // 没买这个主题
  grantAchv(db, p2, 'red_trend');
  grantAchv(db, p2, 'red_bonus');
  const r3 = evolveTheme(db, p2, 'red');
  check('没买主题不能进化', r3.ok === false && /还没买/.test(r3.error || ''), r3.error || '');
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 🐂🐻 返现倍率 1.0 → 1.5（上限仍由 redBonusRate 控制）===');
{
  const mk = (evolved) => {
    const db = newDb({ redBonusRate: 0.01, redBonusMinTicks: 0, bearBonusRate: 0.01, bearBonusMinTicks: 0 });
    const p = mkPlayer(db, 'r', 1e9, 'red');
    if (evolved) { grantAchv(db, p, 'red_trend'); grantAchv(db, p, 'red_bonus'); evolveTheme(db, p, 'red'); }
    openPosition(db, p, { code: 'TGW', side: 'long', qty: 1000, leverage: 1 });
    db.tick += 5;
    const before = p.cash;
    closePosition(db, p, 'TGW');
    return { bonus: p.redBonusEarned, gained: p.cash - before };
  };
  const a = mk(false);
  const b = mk(true);
  check('进化前返现 ≈ 1% 成交额', near(a.bonus, 100000 * 0.01, 1), a.bonus.toFixed(0));
  check('进化后返现 ≈ 1.5% 成交额', near(b.bonus, 100000 * 0.015, 1), b.bonus.toFixed(0));
  check('倍率确实是 1.5×', near(b.bonus / a.bonus, 1.5, 0.01), (b.bonus / a.bonus).toFixed(3));
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 🐻 绿熊进化：返现 1% → 1.5%（不再有保证金减免）===');
{
  const mk = (evolved) => {
    const db = newDb({ bearBonusRate: 0.01, bearBonusMinTicks: 0 });
    downIndex(db);
    const p = mkPlayer(db, 'b', 1e9, 'bear');
    if (evolved) { grantAchv(db, p, 'bear_trend'); grantAchv(db, p, 'bear_bonus'); evolveTheme(db, p, 'bear'); }
    openPosition(db, p, { code: 'TGW', side: 'short', qty: 1000, leverage: 5 });
    db.tick += 5;
    closePosition(db, p, 'TGW');
    return { bonus: p.bearBonusEarned, cost: 1e9 - p.cash };
  };
  const a = mk(false);
  const b = mk(true);
  check('进化前返现 ≈ 1% 成交额', near(a.bonus, 100000 * 0.01, 1), a.bonus.toFixed(0));
  check('进化后返现 ≈ 1.5% 成交额', near(b.bonus, 100000 * 0.015, 1), b.bonus.toFixed(0));
  // 2026-11：保证金减免下线了，进化只影响返现，不影响开仓成本
  const openCost = (evolved) => {
    const db = newDb();
    downIndex(db);
    const p = mkPlayer(db, 'b2', 1e9, 'bear');
    if (evolved) { grantAchv(db, p, 'bear_trend'); grantAchv(db, p, 'bear_bonus'); evolveTheme(db, p, 'bear'); }
    const c0 = p.cash;
    openPosition(db, p, { code: 'TGW', side: 'short', qty: 1000, leverage: 5 });
    return c0 - p.cash;
  };
  check('开仓成本不受进化影响（保证金减免已下线）',
    near(openCost(false), openCost(true), 1e-6), `${openCost(false).toFixed(0)} vs ${openCost(true).toFixed(0)}`);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 🕶️ 暗黑大手：冲击 1.05 → 1.1，且返还 20% 冲击成本 ===');
{
  const mk = (evolved, patch = {}) => {
    const db = newDb({ impactCostCoef: 6, impactCostMax: 0.06, ...patch });
    const p = mkPlayer(db, 'd', 1e9, 'dark');
    if (evolved) { grantAchv(db, p, 'dark_hand'); grantAchv(db, p, 'dark_push'); evolveTheme(db, p, 'dark'); }
    const flow0 = Number(db.stocks.TGW.flow) || 0;
    const cash0 = p.cash;
    openPosition(db, p, { code: 'TGW', side: 'long', qty: 1000, leverage: 10 });
    const spent = cash0 - p.cash;
    return { spent, impact: Number(db.stocks.TGW.flow) || 0 };
  };
  const a = mk(false);
  const b = mk(true);
  check('进化后净支出更少（返还了冲击成本）', b.spent < a.spent, `${a.spent.toFixed(0)} → ${b.spent.toFixed(0)}`);
  // 冲击成本可以从成交流水里读出来（logTrade 记了 impact）
  const impact = (() => {
    const db2 = newDb({ impactCostCoef: 6, impactCostMax: 0.06 });
    const p2 = mkPlayer(db2, 'd9', 1e9, 'dark');
    openPosition(db2, p2, { code: 'TGW', side: 'long', qty: 1000, leverage: 10 });
    return Number(db2.trades[db2.trades.length - 1].impact) || 0;
  })();
  check('返还额 = 冲击成本 × 20%', near(a.spent - b.spent, impact * 0.2, 0.5),
    `${(a.spent - b.spent).toFixed(2)} vs ${(impact * 0.2).toFixed(2)}（冲击 ${impact.toFixed(2)}）`);
}

// ---------------------------------------------------------------- 7
log('');
log('=== 7 🐊 大鳄：提前量 20 → 40 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 't', 1e9, 'tycoon');
  check('未进化 20 轮', tycoonLeadTicks(db, p) === 20, String(tycoonLeadTicks(db, p)));
  grantAchv(db, p, 'tycoon_prophet');
  grantAchv(db, p, 'tycoon_info');
  evolveTheme(db, p, 'tycoon');
  check('进化后 40 轮', tycoonLeadTicks(db, p) === 40, String(tycoonLeadTicks(db, p)));
  const q = mkPlayer(db, 't2', 1e9, 'red');
  check('别的技能不受影响', tycoonLeadTicks(db, q) === 20);
}

// ---------------------------------------------------------------- 8
log('');
log('=== 8 🧙 隐世仙人：孤狼（单票持仓 > 1000 万）===');
{
  const db = newDb();
  const p = mkPlayer(db, 'h', 1e9, 'hermit');
  openPosition(db, p, { code: 'TGW', side: 'long', qty: 120000, leverage: 20 });
  check('持仓 1200 万 → 孤狼解锁', !!p.achv.hermit_lone, JSON.stringify(p.achvCounters.hermitMaxPos));
  const p2 = mkPlayer(db, 'h2', 1e9, 'hermit');
  openPosition(db, p2, { code: 'TGW', side: 'long', qty: 50000, leverage: 20 });
  check('持仓 500 万 → 还没解锁', !p2.achv.hermit_lone);
}

// ---------------------------------------------------------------- 9
log('');
log('=== 9 🧙 来去无踪 / 🕵️ 软柿子：跟随别人成交 ===');
{
  const db = newDb();
  const a = mkPlayer(db, 'a', 1e9, 'default');
  openPosition(db, a, { code: 'LU', side: 'long', qty: 100, leverage: 1 });
  const h = mkPlayer(db, 'h', 1e9, 'hermit');
  openPosition(db, h, { code: 'LU', side: 'long', qty: 100, leverage: 1 });
  check('隐世跟着别人成交 → 来去无踪', !!h.achv.hermit_follow);

  const pb = mkPlayer(db, 'p', 1e9, 'probe');
  openPosition(db, pb, { code: 'LU', side: 'short', qty: 100, leverage: 1 });
  check('调查在别人持仓上反向开仓 → 软柿子', !!pb.achv.probe_weak);

  const solo = mkPlayer(db, 's', 1e9, 'hermit');
  openPosition(db, solo, { code: 'MCD', side: 'long', qty: 100, leverage: 1 });
  check('没人交易过的票 → 不触发', !solo.achv.hermit_follow);
}

// ---------------------------------------------------------------- 10
log('');
log('=== 10 🕶️ 黑手：同股同方向累计 1000 万后换技能平仓 ===');
{
  const db = newDb({ impactCostCoef: 0 });
  const p = mkPlayer(db, 'd', 1e9, 'dark');
  openPosition(db, p, { code: 'TGW', side: 'long', qty: 60000, leverage: 10 });
  check('600 万还没武装', !(p.darkArmed && p.darkArmed.TGW));
  openPosition(db, p, { code: 'TGW', side: 'long', qty: 60000, leverage: 10 });
  check('累计 1200 万 → 武装', !!(p.darkArmed && p.darkArmed.TGW));
  p.skill = 'red';                       // 换别的技能
  closePosition(db, p, 'TGW');
  check('换技能平仓 → 黑手解锁', !!p.achv.dark_hand);

  const q = mkPlayer(db, 'd2', 1e9, 'dark');
  openPosition(db, q, { code: 'TGW', side: 'long', qty: 120000, leverage: 10 });
  closePosition(db, q, 'TGW');           // 没换技能就平
  check('没换技能直接平 → 不解锁', !q.achv.dark_hand);
}

// ---------------------------------------------------------------- 11
log('');
log('=== 11 🕶️ 推土机：别人开仓 → 我反方向推 → 他平完我再平 ===');
{
  const db = newDb({ impactCostCoef: 0 });
  const a = mkPlayer(db, 'a', 1e9, 'default');
  const d = mkPlayer(db, 'd', 1e9, 'dark');
  openPosition(db, a, { code: 'TGW', side: 'long', qty: 1000, leverage: 1 });
  openPosition(db, d, { code: 'TGW', side: 'short', qty: 1000, leverage: 1 });
  check('反方向进场后武装', !!d.pushArm && d.pushArm.otherId === 'a');
  closePosition(db, a, 'TGW');           // 他先平
  closePosition(db, d, 'TGW');           // 我再平
  check('他平完我再平 → 推土机解锁', !!d.achv.dark_push);
}

// ---------------------------------------------------------------- 12
log('');
log('=== 12 🐊 先知：金融板块「超预期」财报前后的一进一出 ===');
{
  const db = newDb({ impactCostCoef: 0 });
  db.config.achvTycoonProphetLeverage = 10;
  const p = mkPlayer(db, 't', 1e9, 'tycoon');
  openPosition(db, p, { code: 'XD', side: 'long', qty: 1000, leverage: 10 });
  db.stocks.XD.lastReportTick = db.tick + 3;    // 财报在他建仓之后发布
  db.stocks.XD.lastSurprise = 0.08;             // 而且「超预期」
  db.tick += 5;
  closePosition(db, p, 'XD');
  check('超预期前 10 倍建仓 → 先知解锁', !!p.achv.tycoon_prophet);

  const q = mkPlayer(db, 't2', 1e9, 'tycoon');
  openPosition(db, q, { code: 'XD', side: 'long', qty: 1000, leverage: 3 }); // 杠杆不够
  db.stocks.XD.lastReportTick = db.tick + 3;
  db.stocks.XD.lastSurprise = 0.08;
  db.tick += 5;
  closePosition(db, q, 'XD');
  check('杠杆不够 → 不解锁', !q.achv.tycoon_prophet);

  const r = mkPlayer(db, 't3', 1e9, 'tycoon');
  openPosition(db, r, { code: 'XD', side: 'long', qty: 1000, leverage: 10 });
  db.stocks.XD.lastReportTick = db.tick + 3;
  db.stocks.XD.lastSurprise = -0.08;          // 不及预期
  db.tick += 5;
  closePosition(db, r, 'XD');
  check('不及预期 → 不解锁', !r.achv.tycoon_prophet);
}

// ---------------------------------------------------------------- 13
log('');
log('=== 13 🧠 读心：情绪极强 + 顺势盈利 ===');
{
  const mk = (v, side) => {
    const db = newDb({ impactCostCoef: 0 });
    const p = mkPlayer(db, 'm', 1e9, 'mind');
    const st = db.stocks.TGW;
    st.sentiment = { v, viewV: v, nextRoll: 99999, nextApply: 99999 };
    st.price = 100;
    openPosition(db, p, { code: 'TGW', side, qty: 1000, leverage: 1 });
    st.price = side === 'long' ? 105 : 95;     // 顺方向盈利
    closePosition(db, p, 'TGW');
    return p;
  };
  check('情绪 +90% 做多盈利 → 读心', !!mk(0.9, 'long').achv.mind_read);
  check('情绪 +90% 做空 → 不算', !mk(0.9, 'short').achv.mind_read);
  check('情绪 −90% 做空盈利 → 读心', !!mk(-0.9, 'short').achv.mind_read);
  check('情绪只有 +30% → 不够极端', !mk(0.3, 'long').achv.mind_read);
}

// ---------------------------------------------------------------- 14
log('');
log('=== 14 🕵️ 情报网 + Ⅱ 阶看全部持仓 ===');
{
  const db = newDb({ impactCostCoef: 0 });
  const me = mkPlayer(db, 'spy', 1e9, 'probe');
  const target = mkPlayer(db, 'victim', 1e9, 'default');
  openPosition(db, target, { code: 'TGW', side: 'long', qty: 100, leverage: 1 });
  openPosition(db, target, { code: 'MCD', side: 'short', qty: 100, leverage: 1 });

  const r1 = investigatePlayer(db, me, target.id);
  check('未进化只返回单个 position（不下发列表）', r1.ok && !!r1.position && r1.positions === undefined,
    JSON.stringify(r1.position && r1.position.code));
  check('冷却 30 轮', r1.cooldownTicks === 30, String(r1.cooldownTicks));
  check('情报网计数 +1', me.achvCounters.probeCount === 1, String(me.achvCounters.probeCount));

  // 攒满 20 次 + 两条成就 → 进化
  for (let i = 0; i < 19; i++) { me.investigateReadyAt = 0; investigatePlayer(db, me, target.id); }
  check('调查 20 次 → 情报网解锁', !!me.achv.probe_net, String(me.achvCounters.probeCount));
  grantAchv(db, me, 'probe_weak');
  evolveTheme(db, me, 'probe');
  me.investigateReadyAt = 0;
  const r2 = investigatePlayer(db, me, target.id);
  check('Ⅱ 阶看全部持仓', r2.evolved === true && r2.positions.length === 2, String(r2.positions?.length));
  check('Ⅱ 阶冷却 20 轮', r2.cooldownTicks === 20, String(r2.cooldownTicks));
}

// ---------------------------------------------------------------- 15
log('');
log('=== 15 🌙 夜行者：20:00~04:00，夜里 CD 3 → 1 ===');
{
  const db = newDb();
  // 必须按**本地时间**造，不能用 UTC 毫秒（getHours 取的是本地小时）
  const night = new Date(2026, 0, 1, 22, 0, 0).getTime();   // 22:00 在夜里（20~04）
  const day = new Date(2026, 0, 1, 12, 0, 0).getTime();     // 12:00 不在夜里
  const p = mkPlayer(db, 'n', 1e9, 'night');
  check('未进化：夜里 CD 3', stealCooldownFor(db, p, night) === 3, String(stealCooldownFor(db, p, night)));
  check('未进化：白天还是 60', stealCooldownFor(db, p, day) === 60, String(stealCooldownFor(db, p, day)));
  grantAchv(db, p, 'night_big');
  grantAchv(db, p, 'night_200');
  evolveTheme(db, p, 'night');
  check('进化后：夜里 CD 1', stealCooldownFor(db, p, night) === 1, String(stealCooldownFor(db, p, night)));
  check('进化后：白天仍 60', stealCooldownFor(db, p, day) === 60);
}

// ---------------------------------------------------------------- 16
log('');
log('=== 16 排行榜徽章 + 隐世 Ⅱ 阶模糊 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'h', 1e9, 'hermit');
  grantAchv(db, p, 'hermit_lone');
  check('只解一条 → 排行榜不显示徽章', themeEmojiList(p).length === 0, JSON.stringify(themeEmojiList(p)));
  grantAchv(db, p, 'hermit_follow');
  check('两条都解 → 出现 🧙', themeEmojiList(p).includes('🧙'), JSON.stringify(themeEmojiList(p)));
  evolveTheme(db, p, 'hermit');
  check('进化后徽章还是 🧙（排行榜不带 ✦）',
    themeEmojiList(p).join(',') === '🧙', JSON.stringify(themeEmojiList(p)));

  const multi = mkPlayer(db, 'm', 1e9, 'red');
  grantAchv(db, multi, 'red_trend');
  grantAchv(db, multi, 'red_bonus');          // 红牛两条都达成
  grantAchv(db, multi, 'tycoon_info');        // 大鳄只解了一条
  check('只有整组达成才亮（大鳄只解一条不亮）',
    themeEmojiList(multi).join(',') === '🐂', JSON.stringify(themeEmojiList(multi)));
  grantAchv(db, multi, 'tycoon_prophet');
  check('补齐后两个主题都亮',
    themeEmojiList(multi).length === 2, JSON.stringify(themeEmojiList(multi)));
}

// ---------------------------------------------------------------- 17
log('');
log('=== 17 payload 结构（前端要用）===');
{
  const db = newDb();
  const p = mkPlayer(db, 'a', 1e9, 'red');
  grantAchv(db, p, 'red_trend');
  const payload = achvPayload(db, p);
  check('有 points', payload.points === 40, String(payload.points));
  check('8 个主题都在', Object.keys(payload.themes).length === 8);
  const red = payload.themes.red;
  check('red 有 tier/shards/got/total', red.tier === 1 && red.shards === 1 && red.got === 1 && red.total === 2,
    JSON.stringify({ tier: red.tier, shards: red.shards, got: red.got, total: red.total }));
  check('每条成就带进度和目标', red.list.every((x) => 'progress' in x && 'target' in x && 'got' in x));
  check('canEvolve 为 false（还差一条）', red.canEvolve === false);
  // 只解了一条：payload 的 emojis 里也不该出现
  check('只解一条 → payload.emojis 为空', payload.emojis.length === 0, JSON.stringify(payload.emojis));
  grantAchv(db, p, 'red_bonus');
  check('补齐两条后 payload.emojis 有 🐂', achvPayload(db, p).emojis.includes('🐂'));
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
