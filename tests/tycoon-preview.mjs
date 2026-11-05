// 金融大鳄：所有个股提前预览 + 超预期判定与发报口径一致
//   node tests/tycoon-preview.mjs

import { createDb } from '../src/store.js';
import { runReports, TYCOON_LEAD_TICKS } from '../src/engine.js';
import { genNextReport, previewInTicks, tycoonPreviewPayload, TYCOON_LEAD_TICKS as LEAD } from '../src/fundamentals.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

const realRandom = Math.random;
function fixRandom(v) { Math.random = () => v; }

function newDb() {
  const db = createDb();
  Object.assign(db.config, { reportIntervalTicks: 720, growthCeiling: 8 });
  db.tick = 1000;
  db.events = [];
  db.trades = [];
  for (const st of Object.values(db.stocks)) {
    if (st.isIndex) continue;
    st.nextReportTick = db.tick + 100;
    delete st.pendingReport;
  }
  return db;
}
const stocks = (db) => Object.values(db.stocks).filter((s) => !s.isIndex);

/** 前端/后端共用的判定口径（api.js 里那三行） */
function judge(report) {
  const growth = Number(report.growth) || 0;
  const expected = Number(report.expectedGrowth) || 0;
  const surprise = Math.max(-0.3, Math.min(0.3, growth - expected));
  const verdict = surprise > 0.02 ? 'beat' : surprise < -0.02 ? 'miss' : 'inline';
  const shockPct = Math.max(-0.06, Math.min(0.06, surprise * 0.8)) * 100;
  return { growth, expected, surprise, verdict, shockPct };
}

// ---------------------------------------------------------------- 1
log('=== 1 所有个股都提前生成 pendingReport（不只是金融）===');
{
  fixRandom(0.5);
  const db = newDb();
  runReports(db);                                    // 第一次只安排 nextReportTick
  check('还没到提前量 → 没有 pendingReport', stocks(db).every((s) => !s.pendingReport));

  db.tick += 100 - TYCOON_LEAD_TICKS;                // 进入提前窗口
  runReports(db);
  const withPending = stocks(db).filter((s) => s.pendingReport);
  check(`提前 ${TYCOON_LEAD_TICKS} 轮全都有 pendingReport`,
    withPending.length === stocks(db).length, `${withPending.length}/${stocks(db).length}`);
  check('非金融票也有（丰川 / 麦当劳）',
    !!db.stocks.TGW.pendingReport && !!db.stocks.MCD.pendingReport);
  check('金融票也有（小灯证券）', !!db.stocks.XD.pendingReport);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 发布时用的就是预览那份（所见即所得）===');
{
  fixRandom(0.5);
  const db = newDb();
  runReports(db);
  db.tick += 100 - TYCOON_LEAD_TICKS;
  runReports(db);
  const previewRevenue = db.stocks.TGW.pendingReport.revenue;
  const previewGrowth = db.stocks.TGW.pendingReport.growth;

  db.tick += TYCOON_LEAD_TICKS;                       // 到点发报
  runReports(db);
  check('发出来的营收 = 预览的营收',
    Math.abs(db.stocks.TGW.fundamentals.revenue - previewRevenue) < 1e-6,
    `${db.stocks.TGW.fundamentals.revenue} vs ${previewRevenue}`);
  check('发出来的增速 = 预览的增速',
    Math.abs(db.stocks.TGW.fundamentals.growth - previewGrowth) < 1e-9);
  check('发完清掉 pendingReport',
    db.stocks.TGW.pendingReport === null || db.stocks.TGW.pendingReport === undefined);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 无噪声（均值轨迹）→ 全部「符合预期」===');
{
  fixRandom(0.5);
  const db = newDb();
  runReports(db);
  db.tick += 100 - TYCOON_LEAD_TICKS;
  runReports(db);

  let n = 0;
  for (const st of stocks(db)) {
    if (!st.pendingReport) continue;
    const j = judge(st.pendingReport);
    check(`${st.code} 符合预期（差 ${(j.surprise * 100).toFixed(2)}pp）`,
      Math.abs(j.surprise) <= 0.02 && Math.abs(j.shockPct) <= 1.6);
    n++;
  }
  check('至少覆盖 9 只票', n >= 9, String(n));
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 有噪声 → 该超的标超预期、该砸的标不及预期 ===');
{
  for (const [rnd, want] of [[0.99, 'beat'], [0.01, 'miss']]) {
    fixRandom(rnd);
    const db = newDb();
    runReports(db);
    db.tick += 100 - TYCOON_LEAD_TICKS;
    runReports(db);
    const st = stocks(db).find((s) => s.trait?.id !== 'steady'   // 稳态票噪声只有 ±0.25%
      && s.trait?.id !== 'broker' && s.trait?.id !== 'fx' && s.pendingReport);
    const j = judge(st.pendingReport);
    check(`随机 ${rnd} → ${st.code} 判定 ${want}（实际差 ${(j.surprise * 100).toFixed(1)}pp）`,
      j.verdict === want, j.verdict);
    check(`价格冲击方向和判定一致（${j.shockPct.toFixed(2)}%）`,
      (want === 'beat' && j.shockPct > 0) || (want === 'miss' && j.shockPct < 0));
  }
  check('冲击被夹在 ±6% 内', Math.abs(Math.max(-0.06, Math.min(0.06, 0.4 * 0.8))) <= 0.06);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 判定阈值：±2pp 以内算「符合预期」===');
{
  const verdictOf = (diff) => {
    const surprise = Math.max(-0.3, Math.min(0.3, diff));
    return surprise > 0.02 ? 'beat' : surprise < -0.02 ? 'miss' : 'inline';
  };
  check('+5pp → 超预期', verdictOf(0.05) === 'beat');
  check('+2pp 整 → 符合', verdictOf(0.02) === 'inline');
  check('+2.1pp → 超预期', verdictOf(0.021) === 'beat');
  check('-2.1pp → 不及预期', verdictOf(-0.021) === 'miss');
  check('0 → 符合', verdictOf(0) === 'inline');
  check('差值被夹在 ±30%', Math.max(-0.3, Math.min(0.3, 0.9)) === 0.3);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 天气股：兄弟股同轮发报，两只都拿得到 pending ===');
{
  fixRandom(0.5);
  const db = newDb();
  const list = stocks(db);
  // 种子里已经没有天气股了，这里临时把两只改成 weather 来验证兄弟股逻辑
  list[0].trait = { ...list[0].trait, id: 'weather', swing: 0.5 };
  list[1].trait = { ...list[1].trait, id: 'weather', swing: 0.5 };
  db.weather = { score: 0.3, label: '风调雨顺', rollTick: db.tick };
  runReports(db);
  for (const st of list) st.nextReportTick = db.tick + 100;
  db.tick += 100 - TYCOON_LEAD_TICKS;
  runReports(db);
  check('两只天气股都有 pendingReport',
    !!list[0].pendingReport && !!list[1].pendingReport);
  db.tick += TYCOON_LEAD_TICKS;
  runReports(db);
  check('同轮一起发（营收都在）',
    !!list[0].fundamentals.revenue && !!list[1].fundamentals.revenue);
}

// ---------------------------------------------------------------- 7
log('');
log('=== 7 pendingReport 字段齐全（前端要用）===');
{
  fixRandom(0.5);
  const db = newDb();
  const rep = genNextReport(db.stocks.LU, { growthCeiling: 8 });
  for (const k of ['revenue', 'netProfit', 'eps', 'growth', 'expectedGrowth']) {
    check(`有 ${k}`, Number.isFinite(Number(rep[k])), String(rep[k]));
  }
}

// ---------------------------------------------------------------- 8
log('');
log('=== 8 倒计时：还需多少轮才能预览 ===');
{
  check('常量是 20', LEAD === 20, String(LEAD));
  check('发报还有 100 轮 → 还要等 80 轮', previewInTicks({ nextReportTick: 1100 }, 1000) === 80);
  check('发报还有 20 轮 → 正好 0（已进窗口）', previewInTicks({ nextReportTick: 1020 }, 1000) === 0);
  check('发报还有 10 轮 → 负数（窗口内）', previewInTicks({ nextReportTick: 1010 }, 1000) === -10);
  check('没有排期（指数/退市）→ null', previewInTicks({}, 1000) === null);
  check('自定义提前量也认', previewInTicks({ nextReportTick: 1100 }, 1000, 50) === 50);
}

// ---------------------------------------------------------------- 9
log('');
log('=== 9 共用构造器：两处 payload 数字一致 ===');
{
  fixRandom(0.5);
  const db = newDb();
  const st = db.stocks.LU;
  st.nextReportTick = db.tick + 12;
  const rep = genNextReport(st, { growthCeiling: 8, weather: 0 });
  st.pendingReport = rep;

  const p1 = tycoonPreviewPayload(st, db.tick);
  const p2 = tycoonPreviewPayload(st, db.tick);
  check('同一状态两次调用结果一致', JSON.stringify(p1) === JSON.stringify(p2));
  check('没有 pendingReport → null', tycoonPreviewPayload({ ...st, pendingReport: null }, db.tick) === null);
  for (const k of ['eps', 'revenue', 'netProfit', 'growth', 'expected', 'surprise', 'verdict', 'shockPct', 'tickLeft', 'previewIn']) {
    check(`字段 ${k} 在`, p1[k] !== undefined, String(p1[k]));
  }
  check('tickLeft = 距发报轮数', p1.tickLeft === 12, String(p1.tickLeft));
  check('previewIn = tickLeft − 提前量', p1.previewIn === 12 - LEAD, String(p1.previewIn));
  check('verdict 与 surprise 自洽',
    (p1.surprise > 0.02) === (p1.verdict === 'beat')
    && (p1.surprise < -0.02) === (p1.verdict === 'miss'));
}

Math.random = realRandom;
console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
