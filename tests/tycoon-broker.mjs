// 金融大鳄 × 券商财报：营收不再被地板夹死，预览才有信息
//   node tests/tycoon-broker.mjs
//
// 线上症状：券商（XD）的营收一路跌到 baseRevenue 的 25%（地板），
// 于是每期财报都是「同比 0.00%」，金融大鳄看到的永远是「符合预期 +0.00pp」。
// 根因：成交活跃度用的是**绝对口径**（成交笔数 ÷ 2），玩家一少就永远偏冷；
//      营收公式 0.7×上期 + 0.3×基准×活跃度 就会一直低于地板。
// 修法：活跃度改成**相对口径**（volumeAvg / volumeRef 慢速基准），
//      并让 migrate 把贴地板的券商基准营收拉回现值。

import { createDb, migrate } from '../src/store.js';
import { stepMarket, volumeFactorOf } from '../src/engine.js';
import { genNextReport, fairFromReport } from '../src/fundamentals.js';
import { marketPayload } from '../src/api.js';
import { ensureAchvState } from '../src/achievements.js';

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

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const withRandom = (seed, fn) => {
  const orig = Math.random;
  Math.random = mulberry32(seed);
  try { return fn(); } finally { Math.random = orig; }
};

function mkPlayer(db, id, skill = 'tycoon') {
  const p = {
    id, nickname: id, cash: 1e6, positions: {}, orders: [],
    theme: skill, skill, level: 3, themes: [], shards: {}, themeTier: {},
    achv: {}, achvCounters: {}
  };
  ensureAchvState(p);
  db.players[id] = p;
  return p;
}

// ================================================================ 1
log('=== 1 成交活跃度改成相对口径（1 = 和平常一样活跃）===');
{
  check('avg == ref → 1', Math.abs(volumeFactorOf({ volumeAvg: 0.4, volumeRef: 0.4 }) - 1) < 1e-9);
  check('比平常热闹 3 倍 → 3',
    Math.abs(volumeFactorOf({ volumeAvg: 1.2, volumeRef: 0.4 }) - 3) < 1e-9,
    String(volumeFactorOf({ volumeAvg: 1.2, volumeRef: 0.4 })));
  check('冷清到 1/10 → 被夹在 0.15 下限',
    volumeFactorOf({ volumeAvg: 0.02, volumeRef: 0.4 }) === 0.15);
  check('极热也被夹在 5 上限',
    volumeFactorOf({ volumeAvg: 100, volumeRef: 0.4 }) === 5);
  check('没有 volumeRef 时退化成 1（不炸）',
    Math.abs(volumeFactorOf({ volumeAvg: 0.26 }) - 1) < 1e-9);
  check('一笔成交都没有 → 当作「和平常一样」（不能把券商按到地板）',
    volumeFactorOf({ volumeAvg: 0, volumeRef: 0 }) === 1,
    String(volumeFactorOf({ volumeAvg: 0, volumeRef: 0 })));
  check('不传 db 也不炸', volumeFactorOf(null) === 1);
  check('和玩家总数无关：0.26 笔/轮配 0.26 的基准 → 1',
    Math.abs(volumeFactorOf({ volumeAvg: 0.26, volumeRef: 0.26 }) - 1) < 1e-9);
}

// ================================================================ 2
log('');
log('=== 2 migrate 自愈：贴地板的券商基准营收拉回现值 ===');
{
  // 造一个「贴地板」的券商
  const db = migrate(createDb());
  db.stocks.XD.fundamentals = {
    ...db.stocks.XD.fundamentals,
    revenue: 5.95e9,
    baseRevenue: 23.8e9,          // 25.0% → 正好贴地板
    growth: 0,
    expectedGrowth: 0
  };
  const healed = migrate(db);
  const xd = healed.stocks.XD;
  check('券商基准营收被拉回现值',
    Math.abs(xd.fundamentals.baseRevenue - xd.fundamentals.revenue) < 1e-6,
    `${(xd.fundamentals.baseRevenue / 1e8).toFixed(1)} 亿 vs ${(xd.fundamentals.revenue / 1e8).toFixed(1)} 亿`);
  check('自愈后不再贴地板（比值 100%）',
    Math.abs(xd.fundamentals.revenue / xd.fundamentals.baseRevenue - 1) < 1e-6);

  // 正常的票不许乱改
  const db2 = migrate(createDb());
  const beforeTgw = Number(db2.stocks.TGW.fundamentals.baseRevenue);
  const m2 = migrate(db2);
  check('非券商票的基准营收不动',
    Math.abs(Number(m2.stocks.TGW.fundamentals.baseRevenue) - beforeTgw) < 1e-6,
    String(m2.stocks.TGW.fundamentals.baseRevenue));

  // 只贴一半的券商也不动（不是病态状态）
  const db3 = migrate(createDb());
  db3.stocks.XD.fundamentals = {
    ...db3.stocks.XD.fundamentals, revenue: 1.2e10, baseRevenue: 2.0e10
  };
  const m3 = migrate(db3);
  check('营收 60% 的券商不触发自愈',
    Math.abs(m3.stocks.XD.fundamentals.baseRevenue - 2.0e10) < 1e-6,
    (m3.stocks.XD.fundamentals.baseRevenue / 1e8).toFixed(1) + ' 亿');
}

// ================================================================ 3
log('');
log('=== 3 券商财报重新有波动（以前每期都是 0%）===');
{
  const db = migrate(createDb());
  const xd = db.stocks.XD;
  Object.assign(db.config, {
    baseVolatility: 0, meanReversion: 0, eventChance: 0, marketTradesEnabled: 0,
    hotMoneyEnabled: 0, sentimentEnabled: 0, playerImpactEnabled: 0, dividendRate: 0
  });
  db.tick = 5000;
  db.volumeAvg = 0.4;
  db.volumeRef = 0.4;

  const growths = [];
  const revs = [];
  withRandom(2026, () => {
    for (let i = 0; i < 20; i++) {
      db.tick += 720;
      for (const s of Object.values(db.stocks)) s.nextReportTick = s.code === 'XD' ? db.tick : 1e12;
      // 模拟真实活跃度的小幅波动（在基准附近，不会 10 倍暴动）
      db.volumeAvg = 0.4 * (0.6 + Math.random() * 0.9);
      stepMarket(db);
      growths.push(Number(xd.fundamentals.growth) || 0);
      revs.push(Number(xd.fundamentals.revenue) || 0);
    }
  });
  const nonZero = growths.filter((g) => Math.abs(g) > 0.001).length;
  const distinctRevs = new Set(revs.map((r) => Math.round(r / 1e6))).size;
  check('20 期里绝大多数不是 0%', nonZero >= 18, `${nonZero}/20`);
  check('营收数字每期都在变（不是冻在地板）', distinctRevs >= 15, `${distinctRevs}/20 种`);
  const mean = growths.reduce((a, b) => a + b, 0) / growths.length;
  const sd = Math.sqrt(growths.reduce((a, b) => a + (b - mean) ** 2, 0) / growths.length);
  check('增速波动是「正常财报」量级（1%~15%）', sd > 0.01 && sd < 0.15, (sd * 100).toFixed(2) + '%');
  check('营收再也没贴回地板', revs.every((r) => r > Number(xd.fundamentals.baseRevenue) * 0.3),
    `${(Math.min(...revs) / Number(xd.fundamentals.baseRevenue) * 100).toFixed(1)}% ~ ${(Math.max(...revs) / Number(xd.fundamentals.baseRevenue) * 100).toFixed(1)}%`);
}

// ================================================================ 4
log('');
log('=== 4 金融大鳄的预览对券商也有信息了 ===');
{
  const db = migrate(createDb());
  const me = mkPlayer(db, 'tycoon1');
  Object.assign(db.config, {
    baseVolatility: 0, meanReversion: 0, eventChance: 0, marketTradesEnabled: 0,
    hotMoneyEnabled: 0, sentimentEnabled: 0, playerImpactEnabled: 0, dividendRate: 0
  });
  db.tick = 6000;
  db.volumeAvg = 0.4;
  db.volumeRef = 0.4;
  const xd = db.stocks.XD;
  xd.nextReportTick = db.tick + 5;
  xd.pendingReport = null;

  const previews = [];
  withRandom(777, () => {
    for (let i = 0; i < 6; i++) {
      db.tick += 720;
      xd.nextReportTick = db.tick + 5;
      xd.pendingReport = null;
      db.volumeAvg = 0.4 * (0.6 + Math.random() * 0.9);
      stepMarket(db);
      const pay = marketPayload(db, me);
      const st = pay.stocks.XD;
      if (st.preview) previews.push(st.preview);
    }
  });
  check('每一轮都能拿到券商预览', previews.length === 6, String(previews.length));
  const surprises = previews.map((p) => Math.abs(Number(p.surprise) || 0));
  check('预览里有非 0 的「超预期/不及预期」',
    surprises.filter((s) => s > 0.001).length >= 5,
    surprises.map((s) => (s * 100).toFixed(2) + 'pp').join(' '));
  check('判定不再永远是「符合预期」',
    previews.some((p) => p.verdict !== 'inline'),
    previews.map((p) => p.verdict).join(','));
  check('预览里的增速不是 0', previews.some((p) => Math.abs(Number(p.growth) || 0) > 0.001),
    previews.map((p) => (Number(p.growth || 0) * 100).toFixed(2) + '%').join(' '));
  check('发报冲击也不再恒为 0',
    previews.some((p) => Math.abs(Number(p.shockPct) || 0) > 0.01),
    previews.map((p) => Number(p.shockPct || 0).toFixed(2)).join(' '));
}

// ================================================================ 5
log('');
log('=== 5 券商估值跟着动（不再是死票）===');
{
  const db = migrate(createDb());
  const xd = db.stocks.XD;
  Object.assign(db.config, {
    baseVolatility: 0, meanReversion: 0, eventChance: 0, marketTradesEnabled: 0,
    hotMoneyEnabled: 0, sentimentEnabled: 0, playerImpactEnabled: 0, dividendRate: 0
  });
  db.tick = 7000;
  db.volumeAvg = 0.4;
  db.volumeRef = 0.4;
  const fairs = [];
  withRandom(99, () => {
    for (let i = 0; i < 10; i++) {
      db.tick += 720;
      for (const s of Object.values(db.stocks)) s.nextReportTick = s.code === 'XD' ? db.tick : 1e12;
      db.volumeAvg = 0.4 * (0.6 + Math.random() * 0.9);
      stepMarket(db);
      fairs.push(Number(xd.fair) || 0);
    }
  });
  const distinct = new Set(fairs.map((f) => Math.round(f))).size;
  check('fair 每期都在变（不是一条直线）', distinct >= 7, `${distinct}/10 种`);
  check('盈亏/价格能跟着动', xd.price > 0 && fairs.every((f) => f > 0));
  check('fair 和财报自洽（fair ≈ fairFromReport）',
    Math.abs(fairFromReport(xd) - xd.fair) / xd.fair < 0.35,
    `${fairFromReport(xd).toFixed(2)} vs ${xd.fair.toFixed(2)}`);
}

// ================================================================ 6
log('');
log('=== 6 基准营收自愈不会反复触发 ===');
{
  const db = createDb();
  db.stocks.XD.fundamentals = {
    ...db.stocks.XD.fundamentals, revenue: 5.95e9, baseRevenue: 23.8e9
  };
  const m1 = migrate(db);
  const base1 = m1.stocks.XD.fundamentals.baseRevenue;
  const m2 = migrate(m1);
  check('第二次 migrate 不会再改一遍',
    Math.abs(m2.stocks.XD.fundamentals.baseRevenue - base1) < 1e-6,
    `${(base1 / 1e8).toFixed(1)} 亿`);
  check('genNextReport 能正常出数', (() => {
    const g = genNextReport(m2.stocks.XD, { volumeFactor: 1 });
    return Number.isFinite(Number(g.growth)) && Number(g.revenue) > 0;
  })());
}

console.log = realLog;
console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
