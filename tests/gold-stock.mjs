// 矿工银行（MB）：金价驱动的财报 + 退市标的清理
//   node tests/gold-stock.mjs
//
// 规则：
//   - 金价是游戏内模拟的：每轮随机游走 + 向基准回归，存在 db.gold
//   - MB 的财报增速 = 金价涨跌（自上一期发报）× goldCoef + 随机浮动 ±goldJitter
//   - 「可预期」的部分只有金价那一段 → 随机浮动就是超预期 / 不及预期的来源
//   - LMFX 已退市：代码里删掉，老存档里 migrate 时结算持仓、撤单、删行情

import { createDb, migrate } from '../src/store.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  ensureGold, stepGold, goldChange, goldReturnSinceReport, goldInfo, GOLD_BASE
} from '../src/gold.js';
import { genNextReport, fairFromReport, isTycoonSector } from '../src/fundamentals.js';
import { runReports } from '../src/engine.js';
import { STOCK_SEED, STOCK_CODES } from '../src/stocks.js';
import { marketPayload } from '../src/api.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

const mkDb = (patch = {}) => {
  // 和真实启动一致：createDb() 只给骨架，migrate() 才补股本 / 基本面
  const db = migrate(createDb());
  Object.assign(db.config, patch);
  db.tick = 1000;
  return db;
};
/** 造一只 MB（用真实种子 + 用现价倒推的基本面） */
const mbStock = (db) => {
  const st = db.stocks.MB;
  st.price = 100;
  st.fair = 100;
  return st;
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// ---------------------------------------------------------------- 1
log('=== 1 MB 定义：金融板块 + 金价特性 ===');
{
  const seed = STOCK_SEED.MB;
  check('MB 在 STOCK_CODES 里', STOCK_CODES.includes('MB'), STOCK_CODES.join(','));
  check('名字是矿工银行', seed.name === '矿工银行', seed.name);
  check('金融板块', seed.industry === '金融', seed.industry);
  check('图标指向 MB.png', seed.icon === '/assets/stocks/MB.png', seed.icon);
  check('trait.id = gold', seed.trait.id === 'gold', seed.trait.id);
  check('金价系数 / 随机浮动走全局配置（不再塞进 trait）',
    seed.trait.goldCoef === undefined && Number(DEFAULT_CONFIG.goldCoef) > 0
      && Number(DEFAULT_CONFIG.goldJitter) > 0,
    `${DEFAULT_CONFIG.goldCoef} / ${DEFAULT_CONFIG.goldJitter}`);
  const db = mkDb();
  check('金融大鳄能预览 MB（isTycoonSector）', isTycoonSector(db.stocks.MB) === true);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 金价：随机游走 + 向基准回归 ===');
{
  const db = mkDb();
  const g = ensureGold(db);
  check('初始等于基准', Math.abs(g.price - GOLD_BASE) < 1e-9, String(g.price));
  const prices = [g.price];
  for (let i = 0; i < 600; i++) prices.push(stepGold(db).price);
  check('每轮都在动', new Set(prices.map((p) => p.toFixed(4))).size > 500, String(new Set(prices).size));
  check('不会跳得太离谱（单轮 < 3%）',
    prices.every((p, i) => i === 0 || Math.abs(p / prices[i - 1] - 1) < 0.03));
  check('不会跌破基准的 20%', Math.min(...prices) > GOLD_BASE * 0.2);
  check('不会翻 5 倍', Math.max(...prices) < GOLD_BASE * 5);
  check('series 跟着长', db.gold.series.length >= 600);
  check('goldChange(1) = 最近一轮涨跌',
    Math.abs(goldChange(db, 1) - (prices[prices.length - 1] / prices[prices.length - 2] - 1)) < 1e-9);
  // 长期均值应该贴着基准（回归生效）
  const avg = mean(prices.slice(200));
  check('长期均值贴基准（回归生效）', Math.abs(avg / GOLD_BASE - 1) < 0.15, avg.toFixed(1));
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 金价可用参数调节（波动 / 回归）===');
{
  const calm = mkDb({ goldVol: 0 });
  ensureGold(calm);
  for (let i = 0; i < 50; i++) stepGold(calm);
  check('goldVol=0 时金价不动', Math.abs(calm.gold.price - GOLD_BASE) < 1e-6, String(calm.gold.price));

  const wild = mkDb({ goldVol: 0.02, goldRev: 0 });
  ensureGold(wild);
  const ps = [wild.gold.price];
  for (let i = 0; i < 200; i++) ps.push(stepGold(wild).price);
  const spread = (Math.max(...ps) - Math.min(...ps)) / GOLD_BASE;
  check('goldVol=0.02 时波动明显更大', spread > 0.05, (spread * 100).toFixed(1) + '%');
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 财报跟着金价走：金价涨 → 增速高 ===');
{
  const db = mkDb({ growthCeiling: 8 });
  const st = mbStock(db);
  const run = (goldRet, n = 400) => {
    const gs = [];
    for (let i = 0; i < n; i++) gs.push(Number(genNextReport(st, { goldReturn: goldRet }).growth));
    return mean(gs);
  };
  const up = run(0.05);      // 金价涨 5%
  const flat = run(0);
  const down = run(-0.05);   // 金价跌 5%
  check('金价涨 → 财报增速明显更高', up > flat + 0.05, `${(up * 100).toFixed(1)}% vs ${(flat * 100).toFixed(1)}%`);
  check('金价跌 → 财报增速明显更低', down < flat - 0.05, `${(down * 100).toFixed(1)}%`);
  const coef = Number(db.config.goldCoef);
  // MB 还有「1000 亿 → 3000 亿」的市值目标增速，所以金价看的是**增量**
  check('金价的增量 ≈ 涨跌 × 系数',
    Math.abs((up - flat) - 0.05 * coef) < 0.03, `${((up - flat) * 100).toFixed(1)}pp`);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 随机浮动：±goldJitter，且只影响「意外」不影响预期 ===');
{
  const db = mkDb();
  const st = mbStock(db);
  const jitter = Number(db.config.goldJitter);
  const diffs = [];
  const surprises = [];
  const expects = [];
  for (let i = 0; i < 600; i++) {
    const r = genNextReport(st, { goldReturn: 0.02 });
    diffs.push(Number(r.growth));
    surprises.push(Number(r.growth) - Number(r.expectedGrowth));
    expects.push(Number(r.expectedGrowth));
  }
  const spread = Math.max(...diffs) - Math.min(...diffs);
  check('实际增速的抖动 ≈ 2×goldJitter', Math.abs(spread - 2 * jitter) < jitter * 0.35,
    `${(spread * 100).toFixed(2)}% vs ${(2 * jitter * 100).toFixed(2)}%`);
  const expectSet = new Set(expects.map((v) => v.toFixed(9)));
  check('预期增速里不含随机浮动（600 次完全一样）', expectSet.size === 1,
    `${expectSet.size} 种取值`);
  const expect = Number(genNextReport(st, { goldReturn: 0.02 }).expectedGrowth);
  const goldPart = 0.02 * Number(db.config.goldCoef);
  // 预期 = 市值目标增速 + 金价那段（都不含随机浮动）
  check('预期 = 目标增速 + 金价那段（不含抖动）',
    expect - goldPart > 0.05 && expect - goldPart < 0.3,
    `目标段 ${((expect - goldPart) * 100).toFixed(1)}%`);
  check('「意外」正负都有（会出超预期也会不及预期）',
    surprises.some((s) => s > 0.005) && surprises.some((s) => s < -0.005));
  const big = surprises.filter((s) => Math.abs(s) > jitter * 1.6).length;
  check('意外不会超出随机浮动范围', big === 0, `${big} 次越界`);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 金价也影响净利率（小幅）===');
{
  const db = mkDb();
  const st = mbStock(db);
  const m = (gr) => mean(Array.from({ length: 300 }, () => Number(genNextReport(st, { goldReturn: gr }).margin)));
  const hi = m(0.2);
  const lo = m(-0.2);
  check('金价高时净利率更高', hi > lo + 0.01, `${(hi * 100).toFixed(2)}% vs ${(lo * 100).toFixed(2)}%`);
  // 净利率的夹子是金融区间 [0.18,0.35] × [0.7, 1.2] → [0.126, 0.42]；
  // 起点是随机种的，所以只断言「没超出夹子」，别断言具体值
  check('净利率没有被搞出行业区间', hi <= 0.42 + 1e-9 && lo >= 0.126 - 1e-9,
    `${hi.toFixed(3)} / ${lo.toFixed(3)}`);
}

// ---------------------------------------------------------------- 7
log('');
log('=== 7 金价基准：发报后往前推 ===');
{
  const db = mkDb();
  ensureGold(db);
  db.gold.price = 2600;
  const ret = goldReturnSinceReport(db);
  check('从基准价的涨跌 = 2600/2400 − 1', Math.abs(ret - (2600 / 2400 - 1)) < 1e-9, ret.toFixed(4));
  db.gold.reportBase = 2600;
  check('发报后基准推到现在 → 涨跌归零', Math.abs(goldReturnSinceReport(db)) < 1e-9);
}

// ---------------------------------------------------------------- 8
log('');
log('=== 8 金价快照 goldInfo ===');
{
  const db = mkDb();
  ensureGold(db);
  for (let i = 0; i < 200; i++) stepGold(db);
  const info = goldInfo(db);
  check('带价格 / 基准', info.price > 0 && info.base > 0, `${info.price} / ${info.base}`);
  check('带最近一轮与 60 轮涨跌',
    Number.isFinite(info.chg1) && Number.isFinite(info.chg60));
  check('series 不超过 120 个点', info.series.length <= 120, String(info.series.length));
  check('价格与序列尾巴一致', Math.abs(info.price - info.series[info.series.length - 1]) < 1e-9);
}

// ---------------------------------------------------------------- 9
log('');
log('=== 9 退市清理：LMFX 被删除，持仓结算、挂单撤销 ===');
{
  check('代码里已经没有 LMFX', !STOCK_CODES.includes('LMFX'), STOCK_CODES.join(','));
  check('种子里也没有', !STOCK_SEED.LMFX);

  // 造一份「老存档」：还有 LMFX 行情 + 一个玩家持有 LMFX 多单和一发挂单
  const db = createDb();
  db.stocks.LMFX = {
    code: 'LMFX', name: '留美外汇', industry: '金融', shares: 2e8, freeFloat: 0.45,
    price: 10, fair: 70, initialPrice: 100, status: 'delisted',
    series: [10], trait: { id: 'fx', name: '汇率杠杆' }, fundamentals: {}
  };
  const p = {
    id: 'p1', nickname: '测试', pin: 'x', cash: 1000, positions: {}, orders: [],
    level: 1, themes: [], themeTier: {}, shards: {}, achv: {}, achvCounters: {},
    equityHistory: [], notifications: []
  };
  p.positions.LMFX = { code: 'LMFX', side: 'long', qty: 100, entry: 8, margin: 800, leverage: 1, openedTick: 1 };
  p.orders.push({ id: 'o1', code: 'LMFX', side: 'long', action: 'open', qty: 10, limit: 9, reserve: 90 });
  p.orders.push({ id: 'o2', code: 'MB', side: 'long', action: 'open', qty: 10, limit: 100, reserve: 100 });
  db.players.p1 = p;

  const m = migrate(db);
  check('LMFX 行情被删掉', !m.stocks.LMFX);
  check('LMFX 持仓被平掉', !m.players.p1.positions.LMFX);
  // 100 股 × (10 − 8) = 200 盈亏，保证金 800 退回 → 1000 + 800 + 200 = 2000；挂单押金 90 也退
  check('现金回来了（保证金 + 盈亏 + 挂单押金）',
    Math.abs(m.players.p1.cash - (1000 + 800 + 200 + 90)) < 1e-6, String(m.players.p1.cash));
  check('LMFX 挂单被撤', !m.players.p1.orders.some((o) => o.code === 'LMFX'));
  check('其它票的挂单不受影响', m.players.p1.orders.some((o) => o.code === 'MB'));
  check('金价状态被补上', Number(m.gold?.price) > 0, JSON.stringify(m.gold && { price: m.gold.price, base: m.gold.base }));
}

// ---------------------------------------------------------------- 10
log('');
log('=== 10 新票会自己长出来（老存档里没有 MB）===');
{
  const db = createDb();
  delete db.stocks.MB;
  const m = migrate(db);
  check('migrate 补上 MB', !!m.stocks.MB && m.stocks.MB.code === 'MB');
  check('价格从初始价开始', Math.abs(m.stocks.MB.price - STOCK_SEED.MB.initialPrice) < 1e-6, String(m.stocks.MB.price));
  check('带图标与特性', m.stocks.MB.icon === '/assets/stocks/MB.png' && m.stocks.MB.trait.id === 'gold');
  check('有基本面（能出财报）', !!m.stocks.MB.fundamentals && Number(m.stocks.MB.fundamentals.period) >= 0);
  // migrate 里 fair 会 toFixed(4)，这里留 1e-3 的容差
  check('有价值线', Number(m.stocks.MB.fair) > 0
    && Math.abs(fairFromReport(m.stocks.MB) - m.stocks.MB.fair) < 1e-3,
    `${m.stocks.MB.fair} vs ${fairFromReport(m.stocks.MB).toFixed(4)}`);
}

// ---------------------------------------------------------------- 11
log('');
log('=== 11 金价默认参数与配置一致 ===');
{
  check('goldBase = 2400', Number(DEFAULT_CONFIG.goldBase) === 2400, String(DEFAULT_CONFIG.goldBase));
  check('goldVol = 0.0012', Math.abs(DEFAULT_CONFIG.goldVol - 0.0012) < 1e-12);
  check('goldRev = 0.002', Math.abs(DEFAULT_CONFIG.goldRev - 0.002) < 1e-12);
  check('goldCoef = 2.2', Math.abs(DEFAULT_CONFIG.goldCoef - 2.2) < 1e-12);
  check('goldJitter = 0.03', Math.abs(DEFAULT_CONFIG.goldJitter - 0.03) < 1e-12);
}

// ---------------------------------------------------------------- 12
log('');
log('=== 12 走真实 runReports：金价涨 → 这期财报是正增长 ===');
{
  const db = mkDb({ reportIntervalTicks: 720 });
  ensureGold(db);
  const st = db.stocks.MB;
  st.nextReportTick = db.tick;                 // 立刻发报
  db.gold.price = 2640;                        // 金价从 2400 涨到 2640（+10%）
  db.gold.reportBase = 2400;
  st.pendingReport = null;
  const before = Number(st.fair);
  runReports(db);
  const f = st.fundamentals || {};
  check('财报发出来了', Number(f.period) === 1, String(f.period));
  check('金价 +10% → 增速为正', Number(f.growth) > 0.1, (Number(f.growth) * 100).toFixed(2) + '%');
  // 增量用同一条票做确定性对比（关掉随机浮动），只看金价那一段
  const g0 = Number(genNextReport(st, { goldReturn: 0, goldCoef: 2.2, goldJitter: 0 }).growth);
  const g1 = Number(genNextReport(st, { goldReturn: 0.1, goldCoef: 2.2, goldJitter: 0 }).growth);
  check('金价 +10% 带来的增量 ≈ 10% × 2.2（吃规模衰减）',
    g1 - g0 > 0.10 && g1 - g0 < 0.25, `${((g1 - g0) * 100).toFixed(1)}pp`);
  check('金价基准已推到 2640', Math.abs(Number(db.gold.reportBase) - 2640) < 1e-6, String(db.gold.reportBase));
  check('价值线跟着上去了', Number(st.fair) > before, `${before.toFixed(1)} → ${Number(st.fair).toFixed(1)}`);
  check('意外在随机浮动范围内',
    Math.abs(Number(st.lastSurprise)) <= Number(db.config.goldJitter) + 0.01,
    (Number(st.lastSurprise) * 100).toFixed(2) + 'pp');

  // 金价跌 → 负增长
  const db2 = mkDb({ reportIntervalTicks: 720 });
  ensureGold(db2);
  const st2 = db2.stocks.MB;
  st2.nextReportTick = db2.tick;
  db2.gold.price = 2160;                       // 2400 → 2160（−10%）
  db2.gold.reportBase = 2400;
  st2.pendingReport = null;
  runReports(db2);
  const g2 = Number(genNextReport(st, { goldReturn: -0.1, goldCoef: 2.2, goldJitter: 0 }).growth);
  check('金价 −10% → 增速被拖掉 10pp 以上', g0 - g2 > 0.10, `${((g0 - g2) * 100).toFixed(1)}pp`);
}

// ---------------------------------------------------------------- 13
log('');
log('=== 13 对外隐藏：不显示金价条、不下发金价、不给特性说明 ===');
{
  const db = mkDb();
  const payload = marketPayload(db, null);
  check('marketPayload 里没有 gold 字段', payload.gold === undefined, JSON.stringify(Object.keys(payload).filter((k) => k === 'gold')));
  const mb = payload.stocks.MB;
  check('MB 的 trait 只剩 id / 波动参数',
    Object.keys(mb.trait || {}).sort().join(',') === 'id,revMult,volMult',
    JSON.stringify(mb.trait));
  check('MB 不再有 traitName', !mb.traitName, String(mb.traitName));
  check('MB 的特性还在内部（引擎能判定）', db.stocks.MB.trait.id === 'gold' && db.stocks.MB.traitHidden === true);
  check('其它票的特性照旧下发',
    payload.stocks.TGW.traitName === '老钱' && payload.stocks.TGW.trait.drift === undefined
      ? payload.stocks.TGW.traitName === '老钱'
      : payload.stocks.TGW.traitName === '老钱',
    payload.stocks.TGW.traitName);
  check('MB 的公司简介保留（不是特性）', String(mb.desc || '').length > 0, mb.desc);
}

// ---------------------------------------------------------------- 14
log('');
log('=== 14 金价系数 / 浮动由全局配置控制（管理面板那一组是真生效的）===');
{
  const db = mkDb();
  const st = db.stocks.MB;
  const run = (ctx) => mean(Array.from({ length: 300 }, () => Number(genNextReport(st, ctx).growth)));
  const base = run({ goldReturn: 0.05, goldCoef: 2.2 });
  const strong = run({ goldReturn: 0.05, goldCoef: 4.4 });
  check('号金价系数调大 → 增速跟着变大', strong > base + 0.05,
    `${(base * 100).toFixed(1)}% → ${(strong * 100).toFixed(1)}%`);
  const tight = [];
  const loose = [];
  for (let i = 0; i < 400; i++) {
    tight.push(Number(genNextReport(st, { goldReturn: 0, goldCoef: 2.2, goldJitter: 0.01 }).growth));
    loose.push(Number(genNextReport(st, { goldReturn: 0, goldCoef: 2.2, goldJitter: 0.08 }).growth));
  }
  const spreadT = Math.max(...tight) - Math.min(...tight);
  const spreadL = Math.max(...loose) - Math.min(...loose);
  check('随机浮动跟着 goldJitter 走', spreadL > spreadT * 2,
    `${(spreadT * 100).toFixed(1)}% vs ${(spreadL * 100).toFixed(1)}%`);
}

// ---------------------------------------------------------------- 15
log('');
log('=== 15 市值设定：上市 1000 亿，目标 3000 亿 ===');
{
  const db = mkDb();
  const st = db.stocks.MB;
  check('股本 10 亿股', Number(st.shares) === 1000000000, String(st.shares));
  check('股价 100 → 市值 1000 亿',
    Math.abs(Number(st.price) * Number(st.shares) - 1e11) < 1e6,
    `${((Number(st.price) * Number(st.shares)) / 1e8).toFixed(0)} 亿`);
  check('市值目标 3000 亿', Number(st.capTarget) === 3e11, String(st.capTarget));
  check('收敛速度 0.08/期', Math.abs(Number(st.capTargetRate) - 0.08) < 1e-9, String(st.capTargetRate));
}

// ---------------------------------------------------------------- 16
log('');
log('=== 16 收敛：一路涨到 3000 亿附近，不会冲过头 ===');
{
  const db = mkDb({ reportIntervalTicks: 720 });
  ensureGold(db);
  const st = db.stocks.MB;
  const capOf = () => (Number(st.fair) * Number(st.shares)) / 1e8;
  const caps = [];
  for (let i = 1; i <= 40; i++) {
    db.tick += 720;
    st.nextReportTick = db.tick;
    st.pendingReport = null;
    runReports(db);
    caps.push(capOf());
  }
  const first = caps[0];
  const mid = caps[19];
  const last = caps[caps.length - 1];
  check('第 1 期市值就往上走了', first > 1000, `${first.toFixed(0)} 亿`);
  check('第 20 期到 2400~2800 亿', mid > 2400 && mid < 2800, `${mid.toFixed(0)} 亿`);
  check('第 40 期落在 3000 亿附近（±10%）',
    Math.abs(last - 3000) < 300, `${last.toFixed(0)} 亿`);
  check('不会冲过 3000 亿太多（<3100）', last < 3100, `${last.toFixed(0)} 亿`);
  // 金价下跌的那几期财报会差一点，市值允许小幅回落，但大方向必须向上
  const dips = caps.filter((c, i) => i > 0 && c < caps[i - 1] - 1).length;
  const maxDip = Math.max(...caps.map((c, i) => (i > 0 ? caps[i - 1] - c : 0)));
  check('大方向向上（回落不超过 15 次，单次回落 < 260 亿）',
    dips <= 15 && maxDip < 260, `回落 ${dips} 次，最大 ${maxDip.toFixed(0)} 亿`);
  check('后 10 期比前 10 期高', mean(caps.slice(-10)) > mean(caps.slice(0, 10)) * 1.3,
    `${mean(caps.slice(0, 10)).toFixed(0)} → ${mean(caps.slice(-10)).toFixed(0)} 亿`);
}

// ---------------------------------------------------------------- 17
log('');
log('=== 17 金价叠加在目标增速上（不会被市值目标吃掉）===');
{
  const db = mkDb();
  const st = db.stocks.MB;
  const run = (goldReturn) => mean(Array.from({ length: 300 },
    () => Number(genNextReport(st, { goldReturn, goldCoef: 2.2, goldJitter: 0.03 }).growth)));
  const up = run(0.05);
  const flat = run(0);
  const down = run(-0.05);
  // 目标增速会被「规模衰减」打折，所以只要求它是个明显的正数
  check('中性金价时仍有市值目标带来的正增长', flat > 0.05, (flat * 100).toFixed(1) + '%');
  check('金价涨 → 增速更高', up > flat + 0.08, `${(up * 100).toFixed(1)}%`);
  check('金价跌 → 增速更低', down < flat - 0.08, `${(down * 100).toFixed(1)}%`);
  // 规模衰减系数取决于随机种子（10%~30% 的摆动范围都算正常）
  check('金价的贡献仍然 ≈ 涨跌 × 系数',
    (up - down) > 0.10 && (up - down) < 0.32,
    `${((up - down) * 100).toFixed(1)}pp`);
  const expBase = Number(genNextReport(st, { goldReturn: 0, goldCoef: 2.2 }).expectedGrowth);
  const expGold = Number(genNextReport(st, { goldReturn: 0.02, goldCoef: 2.2 }).expectedGrowth);
  check('预期 = 市值目标那段 + 金价那段', expGold - expBase > 0.02 && expGold - expBase < 0.06,
    `+${((expGold - expBase) * 100).toFixed(2)}pp`);
  check('目标那段本身就是正的', expBase > 0.04, (expBase * 100).toFixed(1) + '%');
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
