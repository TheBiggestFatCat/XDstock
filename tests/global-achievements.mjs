// 全局成就（价值投资 / 短线擒龙）回归测试
//
//   node tests/global-achievements.mjs
//
// 造内存 db 直接调 trading.js，覆盖 4 个小任务 + 完成判定 + 排行榜图标。

import { createDb } from '../src/store.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { openPosition, closePosition } from '../src/trading.js';
import {
  GLOBAL_ACHIEVEMENTS, globalAchvProgress, refreshGlobals, bumpGlobal,
  achvPayload, achvEmojiList, themeEmojiList, ensureAchvState, grantAchv
} from '../src/achievements.js';
import { leaderboardRows } from '../src/api.js';

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
    limitOrderEnabled: 1, marketOpen: true, levelFillBonus: 0,
    ...Object.fromEntries(Object.entries(DEFAULT_CONFIG).filter(([k]) => k.startsWith('achv')))
  }, patch);
  db.tick = 1000;
  for (const st of Object.values(db.stocks)) {
    st.price = 100;
    st.fair = 100;
    st.series = new Array(40).fill(100);
  }
  return db;
}
function mkPlayer(db, id, cash = 1e10, skill = 'default') {
  db.players[id] = {
    id, nickname: id, cash, positions: {}, orders: [],
    theme: skill, skill, level: 1, themes: [], shards: {}, themeTier: {},
    achv: {}, achvCounters: {}
  };
  ensureAchvState(db.players[id]);
  return db.players[id];
}
/** 直接按「目标收益率」把价格挪过去（杠杆放大收益，方便造用例） */
function setPriceForRoi(st, pos, roiPct) {
  const dir = pos.side === 'long' ? 1 : -1;
  const need = (Number(pos.margin) * roiPct) / 100;          // 需要的 pnl
  const dp = need / (pos.qty * dir);
  st.price = pos.entry + dp;
}
const done = (p, id) => !!p.achv[id];
const taskOf = (db, p, id) => globalAchvProgress(db, p).find((g) => g.id === id);

// ---------------------------------------------------------------- 1
log('=== 1 定义：2 条全局成就，各 2 个小任务 ===');
{
  check('2 条全局成就', GLOBAL_ACHIEVEMENTS.length === 2, String(GLOBAL_ACHIEVEMENTS.length));
  check('名字是 价值投资 / 短线擒龙',
    GLOBAL_ACHIEVEMENTS.map((g) => g.name).join(',') === '价值投资,短线擒龙');
  check('每条 2 个小任务', GLOBAL_ACHIEVEMENTS.every((g) => g.tasks.length === 2));
  check('都有 emoji', GLOBAL_ACHIEVEMENTS.every((g) => !!g.emoji),
    GLOBAL_ACHIEVEMENTS.map((g) => g.emoji).join(''));
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 🏛️ 价值回归：偏离 30% 建仓 ≥500 万 → 穿到价值线另一头平仓 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'v1');
  const st = db.stocks.TGW;
  st.fair = 100;
  st.price = 130;                                 // 高估 30%
  openPosition(db, p, { code: 'TGW', side: 'short', qty: 50000, leverage: 1 });  // 500 万
  check('建仓时武装了 valueArm', !!p.positions.TGW?.valueArm, JSON.stringify(p.positions.TGW?.valueArm));
  st.price = 110;                                 // 还在价值线上方
  db.tick += 10;
  closePosition(db, p, 'TGW');
  check('还在同侧平仓 → 不算', !done(p, 'value_invest'), JSON.stringify(p.achvCounters));

  const db2 = newDb();
  const p2 = mkPlayer(db2, 'v2');
  const st2 = db2.stocks.TGW;
  st2.fair = 100; st2.price = 130;
  openPosition(db2, p2, { code: 'TGW', side: 'short', qty: 50000, leverage: 1 });
  st2.price = 95;                                  // 穿到价值线下方（另一头）
  db2.tick += 10;
  const r = closePosition(db2, p2, 'TGW');
  check('穿到另一头平仓 → 达成「价值回归」', done(p2, 'value_invest'), `pnl=${r.pnl.toFixed(0)}`);
  check('只完成 1/2 小任务', taskOf(db2, p2, 'value_invest').tasks.filter((t) => t.done).length === 1);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 🏛️ 建仓额不够 / 偏离不够 都不算 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'v3');
  const st = db.stocks.TGW;
  st.fair = 100; st.price = 130;
  openPosition(db, p, { code: 'TGW', side: 'short', qty: 20000, leverage: 1 });   // 只有 200 万
  check('200 万建仓不够门槛 → 不武装', !p.positions.TGW?.valueArm);
  st.price = 95; db.tick += 5;
  closePosition(db, p, 'TGW');
  check('不武装 → 不解锁', !done(p, 'value_invest'));

  const db2 = newDb();
  const p2 = mkPlayer(db2, 'v4');
  const st2 = db2.stocks.TGW;
  st2.fair = 100; st2.price = 110;                 // 只偏离 10%
  openPosition(db2, p2, { code: 'TGW', side: 'short', qty: 60000, leverage: 1 });
  check('偏离只有 10% → 不武装', !p2.positions.TGW?.valueArm);
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 🏛️ 长线价值：>500 万 + 持有 >24h + 收益率 ≥100% ===');
{
  const mk = (ticks, roi) => {
    const db = newDb();
    const p = mkPlayer(db, 'vh');
    const st = db.stocks.TGW;
    st.fair = 100; st.price = 100;
    openPosition(db, p, { code: 'TGW', side: 'long', qty: 60000, leverage: 10 });  // 600 万，margin 60 万
    const pos = p.positions.TGW;
    db.tick += ticks;
    setPriceForRoi(st, pos, roi);
    closePosition(db, p, 'TGW');
    return { p, db };
  };
  const need = Number(DEFAULT_CONFIG.achvValueHoldTicks);
  const a = mk(need - 1, 120);
  check('持有差 1 轮 → 不算', !done(a.p, 'value_invest'), `ticks=${need - 1}`);
  const b = mk(need + 1, 120);
  check('持有够了 + 收益 120% → 达成', done(b.p, 'value_invest'));
  const c = mk(need + 1, 60);
  check('收益只有 60% → 不算', !done(c.p, 'value_invest'));
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 🐉 一击即走：≥100 万 + 下一轮平仓 + 收益 ≥20% ===');
{
  const mk = (ticks, roi) => {
    const db = newDb();
    const p = mkPlayer(db, 'd1');
    const st = db.stocks.TGW;
    st.fair = 100; st.price = 100;
    openPosition(db, p, { code: 'TGW', side: 'long', qty: 20000, leverage: 20 });  // 200 万
    const pos = p.positions.TGW;
    db.tick += ticks;
    setPriceForRoi(st, pos, roi);
    closePosition(db, p, 'TGW');
    return p;
  };
  check('下一轮平仓 + 收益 25% → 达成「一击即走」', done(mk(1, 25), 'dragon_rush'));
  check('隔了 2 轮才平 → 不算', !done(mk(2, 25), 'dragon_rush'));
  check('收益只有 10% → 不算', !done(mk(1, 10), 'dragon_rush'));
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 🐉 十分钟翻倍：≥100 万 + 120 轮内 + 收益 ≥100% ===');
{
  const mk = (ticks, roi, qty = 20000) => {
    const db = newDb();
    const p = mkPlayer(db, 'd2');
    const st = db.stocks.TGW;
    st.fair = 100; st.price = 100;
    openPosition(db, p, { code: 'TGW', side: 'long', qty, leverage: 20 });
    const pos = p.positions.TGW;
    db.tick += ticks;
    setPriceForRoi(st, pos, roi);
    closePosition(db, p, 'TGW');
    return p;
  };
  check('120 轮内 + 收益 120% → 达成', done(mk(120, 120), 'dragon_rush'));
  check('121 轮 → 超窗，不算', !done(mk(121, 120), 'dragon_rush'));
  check('收益率不够（80%）→ 不算', !done(mk(60, 80), 'dragon_rush'));
  check('仓位只有 50 万 → 不算', !done(mk(10, 200, 5000), 'dragon_rush'));
}

// ---------------------------------------------------------------- 7
log('');
log('=== 7 「任一完成」vs「全部完成」 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'any');
  // 只手动把一个小任务记满
  bumpGlobal(db, p, 'dragonNextTick', 1);
  check('默认（requireAll=0）只完成一个小任务就达成',
    done(p, 'dragon_rush'), JSON.stringify(p.achvCounters));

  const db2 = newDb({ achvGlobalRequireAll: 1 });
  const p2 = mkPlayer(db2, 'all');
  bumpGlobal(db2, p2, 'dragonNextTick', 1);
  check('requireAll=1 时只完成一个 → 不达成', !done(p2, 'dragon_rush'));
  bumpGlobal(db2, p2, 'dragonFast100', 1);
  check('两个都完成 → 达成', done(p2, 'dragon_rush'));
}

// ---------------------------------------------------------------- 8
log('');
log('=== 8 排行榜图标 + payload ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'lb');
  check('没完成 → 排行榜没图标', achvEmojiList(p).length === 0, JSON.stringify(achvEmojiList(p)));
  bumpGlobal(db, p, 'valueCrossClose', 1);
  check('完成价值投资 → 🏛️ 上排行榜', achvEmojiList(p).includes('🏛️'), JSON.stringify(achvEmojiList(p)));
  bumpGlobal(db, p, 'dragonNextTick', 1);
  check('再完成短线擒龙 → 🏛️🐉', achvEmojiList(p).join('') === '🏛️🐉', JSON.stringify(achvEmojiList(p)));
  check('主题成就的函数不受影响（没主题成就时为空）', themeEmojiList(p).join('') === '🏛️🐉');

  const payload = achvPayload(db, p);
  check('payload 带 global 列表', Array.isArray(payload.global) && payload.global.length === 2);
  const vi = payload.global.find((g) => g.id === 'value_invest');
  check('global 里带小任务进度', vi.tasks.length === 2 && vi.tasks.some((t) => t.done));
  check('emojis 含 🏛️🐉', payload.emojis.join('') === '🏛️🐉', payload.emojis.join(''));

  // 排行榜行
  db.players.lb = p;
  const rows = leaderboardRows(db);
  const row = rows.find((r) => r.id === 'lb');
  check('排行榜行 achvEmojis = 🏛️🐉', (row.achvEmojis || []).join('') === '🏛️🐉',
    JSON.stringify(row.achvEmojis));
  check('全局成就不发结晶', Object.values(p.shards || {}).every((v) => !v));

  // ---- 弹窗用的 unlocked 清单 ----
  const u = payload.unlocked;
  check('unlocked 是数组', Array.isArray(u) && u.length === 2, String(u && u.length));
  const gDragon = u.find((x) => x.id === 'dragon_rush');
  check('unlocked 带 tone=dragon（短线擒龙用橙红）', gDragon?.tone === 'dragon', JSON.stringify(gDragon));
  check('unlocked 带 kind=global', gDragon?.kind === 'global');
  check('unlocked 带 emoji', gDragon?.emoji === '🐉', gDragon?.emoji);
  check('unlocked 带 at（去重用）', typeof gDragon?.at === 'number', String(gDragon?.at));
  check('成就点 +40/条', p.achvPoints === 80, String(p.achvPoints));
}

// ---------------------------------------------------------------- 8.5
log('');
log('=== 8.5 弹窗清单：主题成就也带 tone，未解锁的不出现 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'win');
  grantAchv(db, p, 'hermit_lone');          // 只解一条主题成就
  bumpGlobal(db, p, 'dragonNextTick', 1);   // 只解短线擒龙
  const u = achvPayload(db, p).unlocked;
  const themeOne = u.find((x) => x.id === 'hermit_lone');
  check('主题成就在 unlocked 里', !!themeOne, JSON.stringify(u.map((x) => x.id)));
  check('主题成就 tone=theme', themeOne?.tone === 'theme', themeOne?.tone);
  check('主题成就 kind=theme', themeOne?.kind === 'theme');
  check('每条都有 at', u.every((x) => typeof x.at === 'number'));
  check('未解锁的不出现（价值投资）', !u.some((x) => x.id === 'value_invest'));
}

// ---------------------------------------------------------------- 9
log('');
log('=== 9 幂等：重复结算不会重复加成就点 ===');

{
  const db = newDb();
  const p = mkPlayer(db, 'idem');
  bumpGlobal(db, p, 'valueCrossClose', 1);
  const pts = p.achvPoints;
  refreshGlobals(db, p);
  refreshGlobals(db, p);
  check('重复 refresh 不再加分', p.achvPoints === pts, `${pts} → ${p.achvPoints}`);
  check('计数不会被清零', p.achvCounters.valueCrossClose === 1);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
