// 金融大鳄：所有个股提前预览 + 超预期判定与发报口径一致
//   node tests/tycoon-preview.mjs

import { createDb } from '../src/store.js';
import { runReports, TYCOON_LEAD_TICKS } from '../src/engine.js';
import { genNextReport, previewInTicks, tycoonPreviewPayload, isTycoonSector, TYCOON_LEAD_TICKS as LEAD } from '../src/fundamentals.js';

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
log('=== 1 只有金融板块（券商/外汇）提前生成 pendingReport ===');
{
  fixRandom(0.5);
  const db = newDb();
  runReports(db);                                    // 第一次只安排 nextReportTick
  check('还没到提前量 → 没有 pendingReport', stocks(db).every((s) => !s.pendingReport));

  db.tick += 100 - TYCOON_LEAD_TICKS;                // 进入提前窗口
  runReports(db);
  const withPending = stocks(db).filter((s) => s.pendingReport);
  const finance = stocks(db).filter(isTycoonSector);
  check('金融板块的票都有 pendingReport',
    finance.length >= 2 && finance.every((s) => !!s.pendingReport),
    `${withPending.length}/${finance.length}`);
  check('全部 pendingReport 都落在金融板块',
    withPending.every(isTycoonSector), withPending.map((s) => s.code).join(','));
  check('非金融票没有 pendingReport',
    stocks(db).filter((st) => !isTycoonSector(st)).every((st) => !st.pendingReport),
    stocks(db).filter((st) => !isTycoonSector(st)).map((st) => st.code).join(','));
  check('判定覆盖小灯证券（broker）与矿工银行（金融板块）',
    isTycoonSector(db.stocks.XD) && isTycoonSector(db.stocks.MB));
  check('判定排除消费/科技票',
    !isTycoonSector(db.stocks.TGW) && !isTycoonSector(db.stocks.MAMA));
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
  const previewRevenue = db.stocks.XD.pendingReport.revenue;
  const previewGrowth = db.stocks.XD.pendingReport.growth;

  db.tick += TYCOON_LEAD_TICKS;                       // 到点发报
  runReports(db);
  check('发出来的营收 = 预览的营收',
    Math.abs(db.stocks.XD.fundamentals.revenue - previewRevenue) < 1e-6,
    `${db.stocks.XD.fundamentals.revenue} vs ${previewRevenue}`);
  check('发出来的增速 = 预览的增速',
    Math.abs(db.stocks.XD.fundamentals.growth - previewGrowth) < 1e-9);
  check('发完清掉 pendingReport',
    db.stocks.XD.pendingReport === null || db.stocks.XD.pendingReport === undefined);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 无偏移（随机数刚好让 z=0）→ 全部「符合预期」===');
{
  // Math.random=0.25 → cos(2π×0.25)=0 → 高斯值为 0 → 偏移为 0
  fixRandom(0.25);
  const db = newDb();
  runReports(db);
  db.tick += 100 - TYCOON_LEAD_TICKS;
  runReports(db);

  let n = 0;
  for (const st of stocks(db).filter(isTycoonSector)) {
    if (!st.pendingReport) continue;
    const j = judge(st.pendingReport);
    check(`${st.code} 符合预期（差 ${(j.surprise * 100).toFixed(2)}pp）`,
      Math.abs(j.surprise) <= 0.02 && Math.abs(j.shockPct) <= 1.6);
    n++;
  }
  check('覆盖 2 只金融票', n >= 2, String(n));
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 有噪声 → 该超的标超预期、该砸的标不及预期 ===');
{
  // 0.0001 → z ≈ +4.3（大幅正偏移）；0.5 → cos(π) = −1 → z ≈ −1.18（负偏移）
  for (const [rnd, want] of [[0.0001, 'beat'], [0.5, 'miss']]) {
    fixRandom(rnd);
    const db = newDb();
    runReports(db);
    db.tick += 100 - TYCOON_LEAD_TICKS;
    runReports(db);
    // 只用「纯随机偏移」的金融票（MB 是金价驱动，不受这个随机数控制）
    const st = stocks(db).find((s) => isTycoonSector(s) && s.pendingReport && s.trait?.id === 'broker');
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
log('=== 6 非金融票即使兄弟股同轮发报，也不生成 pendingReport ===');
{
  fixRandom(0.5);
  const db = newDb();
  const list = stocks(db);
  // 种子里已经没有天气股了，这里临时把两只非金融票改成 weather 来验证
  const w1 = list.find((s) => !isTycoonSector(s));
  const w2 = list.filter((s) => !isTycoonSector(s) && s !== w1)[0];
  w1.trait = { ...w1.trait, id: 'weather', swing: 0.5 };
  w2.trait = { ...w2.trait, id: 'weather', swing: 0.5 };
  db.weather = { score: 0.3, label: '风调雨顺', rollTick: db.tick };
  runReports(db);
  for (const st of list) st.nextReportTick = db.tick + 100;
  db.tick += 100 - TYCOON_LEAD_TICKS;
  runReports(db);
  check('天气股（非金融）不生成 pendingReport',
    !w1.pendingReport && !w2.pendingReport, `${w1.code}/${w2.code}`);
  db.tick += TYCOON_LEAD_TICKS;
  runReports(db);
  check('照样正常发报（只是没有预览）',
    !!w1.fundamentals.revenue && !!w2.fundamentals.revenue);
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
  const st = db.stocks.XD;
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
