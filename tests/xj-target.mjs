// 弦卷财团：市值逐步萎缩到 5000 亿
//   node tests/xj-target.mjs

import { createDb, migrate } from '../src/store.js';
import { backDerive } from '../src/fundamentals.js';
import { genNextReport } from '../src/fundamentals.js';
import { runReports } from '../src/engine.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

const TARGET = 5000; // 亿

/** 造一个确定性的起点：fair≈price≈740（市值 ~14800 亿），避免随机起点把断言跑飞 */
function seedState(st, price) {
  const ind = { pe: 18, margin: [0.06, 0.16] };          // 消费行业
  const shares = st.shares;
  const eps = price / ind.pe;
  const revenue = (eps * shares) / 0.11;                 // 净利率 11%
  st.fundamentals = {
    period: 50,
    revenue,
    baseRevenue: revenue,
    netProfit: revenue * 0.11,
    eps,
    bps: 912,
    margin: 0.11,
    growth: 0.01,
    expectedGrowth: 0.01,
    roe: 0.042
  };
  st.fair = price;
  st.price = price;
  return st;
}


// ---------------------------------------------------------------- 1
log('=== 1 配置：XJ 有市值目标，别的票没有 ===');
{
  const db = migrate({});
  const xj = db.stocks.XJ;
  check('XJ 有 capTarget', xj.capTarget === 500000000000, String(xj.capTarget));
  check('XJ 有收敛速度', xj.capTargetRate === 0.06, String(xj.capTargetRate));
  check('XJ 总股本 20 亿股', xj.shares === 2000000000);
  // 矿工银行（MB）也有市值目标（1000 亿 → 3000 亿），这里只检查除 XJ / MB 之外的票
  const others = Object.entries(db.stocks).filter(([c, s]) => !s.isIndex && !['XJ', 'MB', 'KFC'].includes(c));
  check('其他票都没有 capTarget', others.every(([, s]) => !s.capTarget));
  check('MB 的市值目标是 3000 亿', db.stocks.MB.capTarget === 3e11, String(db.stocks.MB.capTarget));
  check('KFC 的市值目标是 1000 亿', db.stocks.KFC.capTarget === 1e11, String(db.stocks.KFC.capTarget));
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 老存档没有这个字段也会被补上（不然线上不生效）===');
{
  const db = createDb();                          // 造一个「老存档」
  db.stocks.XJ.capTarget = undefined;
  db.stocks.XJ.capTargetRate = undefined;
  db.stocks.XJ.price = 740;
  const old = db.stocks.XJ;
  const merged = migrate({ ...db, tick: 100 });
  check('迁移后补上 capTarget', merged.stocks.XJ.capTarget === 500000000000);
  check('迁移后补上 capTargetRate', merged.stocks.XJ.capTargetRate === 0.06);
  check('迁移不改变股本', merged.stocks.XJ.shares === old.shares);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 从 14800 亿一路缩到 5000 亿，中间不反弹 ===');
{
  const db = migrate({});
  const xj = db.stocks.XJ;
  // 造一个和线上接近的起点：合理价 ~740（市值 ~14800 亿）
  seedState(xj, 740);
  for (const s of Object.values(db.stocks)) {
    if (!s.isIndex) s.nextReportTick = s.code === 'XJ' ? 0 : 1e12;
  }
  db.config.reportIntervalTicks = 720;
  db.config.dividendRate = 0;
  db.tick = 1000;
  const caps = [];
  const realLog = console.log;
  console.log = () => {};
  try {
    for (let n = 1; n <= 120; n++) {
      db.tick += 720;
      xj.nextReportTick = db.tick;
      runReports(db);
      caps.push((Number(xj.fair) * xj.shares) / 1e8);
    }
  } finally {
    console.log = realLog;
  }
  check('起点在 1 万亿以上', caps[0] > 10000, caps[0].toFixed(0) + ' 亿');
  // 目标上方一路向下（允许 0.5% 以内的取整微抖），靠近目标后可以做小波动
  // 只看「还在目标上方 5% 以外」的那段：靠近目标之后允许正常的随机微抖
  const bigRebounds = caps
    .map((v, i) => (i > 0 && caps[i - 1] > TARGET * 1.05 && v > caps[i - 1] * 1.005
      ? v / caps[i - 1] - 1
      : 0))
    .filter((x) => x > 0);
  check('目标上方没有像样的反弹（>0.5%）', bigRebounds.length === 0,
    `最大反弹 ${(Math.max(0, ...bigRebounds) * 100).toFixed(2)}%`);
  check('24 小时内至少缩掉三分之一', caps[23] < caps[0] * 0.67, `${caps[0].toFixed(0)} → ${caps[23].toFixed(0)} 亿`);
  check('48 小时内缩到 6500 亿以下（起点随机浮动，留点余量）', caps[47] < 6500, caps[47].toFixed(0) + ' 亿');
  const end = caps[caps.length - 1];
  check('120 小时后落在 5000±3%', Math.abs(end - TARGET) / TARGET < 0.03, end.toFixed(0) + ' 亿');
  check('最终不低于 4800 亿（不会缩过头）', end > 4800, end.toFixed(0) + ' 亿');
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 基本面一起缩，PE 不会失真 ===');
{
  const db = migrate({});
  const xj = db.stocks.XJ;
  seedState(xj, 740);
  for (const s of Object.values(db.stocks)) {
    if (!s.isIndex) s.nextReportTick = s.code === 'XJ' ? 0 : 1e12;
  }
  db.config.reportIntervalTicks = 720;
  db.config.dividendRate = 0;
  db.tick = 1000;
  const rev0 = Number(xj.fundamentals.revenue);
  const bps0 = Number(xj.fundamentals.bps);
  const realLog = console.log;
  console.log = () => {};
  try {
    for (let n = 1; n <= 96; n++) {
      db.tick += 720;
      xj.nextReportTick = db.tick;
      runReports(db);
    }
  } finally {
    console.log = realLog;
  }
  const f = xj.fundamentals;
  const pe = f.eps > 0 ? xj.fair / f.eps : 0;
  check('营收也缩了（至少 -30%）', f.revenue < rev0 * 0.7,
    `${(rev0 / 1e8).toFixed(0)} 亿 → ${(f.revenue / 1e8).toFixed(0)} 亿`);
  // 净资产会收敛到「配得上 5000 亿」的水平（目标价 / 0.8 × 0.95 ≈ 297），
  // 起点高就往下降、起点低反而会往上补——所以断言「收敛到目标附近」而不是「一定下降」
  check('净资产收敛到目标水平附近', Math.abs(f.bps - 297) < 60,
    `BPS ${bps0.toFixed(0)} → ${f.bps.toFixed(0)}（目标 ~297）`);
  check('PE 落在合理区间（8~40）', pe > 8 && pe < 40, 'PE ' + pe.toFixed(1));
  check('报的增速和营收真实变化一致（没有假财报）', (() => {
    const st2 = JSON.parse(JSON.stringify(xj));
    const before = Number(st2.fundamentals.revenue);
    const r = genNextReport(st2, {});
    const actual = Number(r.revenue) / before - 1;
    return Math.abs(actual - Number(r.growth)) < 0.01;
  })());
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
