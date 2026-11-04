// 净资产（BPS）累积与账面底线回归
//
//   node tests/book-value.mjs
//
// 历史问题：bps += eps × rand(0.4, 0.9)，从不分红、从不减值，
// 于是 0.8×BPS 这条「净资产底线」越垫越高。业务在萎缩的公司
// （XD 的 EPS 只有 1 块、BPS 有 150 块）反而越活越值钱。
//
// 现在：只留存 15%~30% 的利润；账面远高于盈利估值时，
// 每期向「盈利估值×2」收敛 0.3%（半衰期约 230 期）。

import { createDb } from '../src/store.js';
import { genNextReport, industryOf, fairFromReport, nextBps } from '../src/fundamentals.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

const RETAIN_LO = 0.15;
const RETAIN_HI = 0.3;
const SHRINK = 0.003;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

function realStock(code) {
  const db = createDb();
  return JSON.parse(JSON.stringify(db.stocks[code]));
}

/** 造一家「业务缩到地板、账面很厚」的公司 */
function matureFund(st, { eps = 1.03, bps = 150, margin = 0.13, bias = -0.12 } = {}) {
  const shares = Number(st.shares) || 1;
  const revenue = (eps * shares) / margin;
  return {
    period: 10,
    revenue,
    baseRevenue: revenue * 4,
    netProfit: eps * shares,
    tradePnl: 0,
    eps,
    bps,
    roe: eps / bps,
    margin,
    growth: -0.05,
    debt: 0.4,
    dividendRate: 0.25,
    reportAt: Date.now(),
    bias,
    expectedGrowth: -0.01
  };
}

// ---------------------------------------------------------------- 1
log('=== 1 纯函数 nextBps：只留存 15%~30% 的利润 ===');
{
  const b0 = 40;
  const eps = 5;
  for (const retain of [0.15, 0.225, 0.3]) {
    const b1 = nextBps(b0, eps, { pe: 25, growth: 0, retain });
    check(`retain=${retain} → Δ = ${(eps * retain).toFixed(3)}`, near(b1 - b0, eps * retain, 1e-9),
      `实际 Δ=${(b1 - b0).toFixed(6)}`);
  }
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 账面虚高：每期向「盈利估值×2」收敛 ===');
{
  const b0 = 150;
  const eps = 1.03;
  const pe = 10;
  const growth = -0.01;
  const capBps = (eps * pe * (1 + Math.max(0, growth) * 1.5) * 2) / 0.8;
  check('上限算得对', Math.abs(capBps - 25.75) < 1e-6, `capBps=${capBps.toFixed(3)}`);
  const expected = b0 + (capBps - b0) * SHRINK;   // 超上限时不再留存，只收敛
  const got = nextBps(b0, eps, { pe, growth, retain: 0.225 });
  check('结果 = 纯收敛（不再留存利润）', near(got, expected, 1e-6),
    `${got.toFixed(4)} vs ${expected.toFixed(4)}`);
  check('净资产在下降（不再越涨越高）', got < b0, `${b0} → ${got.toFixed(3)}`);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 长期：账面托底的公司一路回落到上限附近 ===');
{
  const eps = 1.03;
  const pe = 10;
  const capBps = (eps * pe * 2) / 0.8;
  let bps = 150;
  const marks = [];
  for (let i = 1; i <= 1600; i++) {
    bps = nextBps(bps, eps, { pe, growth: 0, retain: 0.225 });
    if (i % 320 === 0) marks.push(`${i}期 ${bps.toFixed(1)}`);
  }
  check('1600 期后收敛到上限附近', bps < capBps * 1.2,
    `cap=${capBps.toFixed(1)}，轨迹 ${marks.join(' → ')}`);
  check('是缓慢下降而不是一刀切（320 期还有 60 以上）',
    Number(marks[0].split(' ')[1]) > 60, marks.join(' → '));
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 盈利托底的公司：账面该继续正常累积 ===');
{
  const b0 = 40;
  const eps = 5;
  let bps = b0;
  for (let i = 0; i < 60; i++) bps = nextBps(bps, eps, { pe: 25, growth: 0.08, retain: 0.225 });
  check('60 期后账面明显增长', bps > b0 + 60 * eps * 0.2, `40 → ${bps.toFixed(1)}`);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 接进财报：genNextReport 产出的 bps 走同一套规则 ===');
{
  const st = realStock('XD');
  st.fundamentals = matureFund(st, { eps: 1.03, bps: 150 });
  const before = st.fundamentals.bps;
  const ind = industryOf(st);
  const r = genNextReport(st, { weather: 0 });
  const byEps = r.eps * ind.pe * (1 + Math.min(0.5, Math.max(0, r.growth) * 1.5));
  const capBps = (byEps * 2) / 0.8;
  const pull = (capBps - before) * SHRINK;
  check('账面超过上限', before > capBps, `账面 ${before} > 上限 ${capBps.toFixed(1)}`);
  const delta = r.bps - before;
  check('变化量 = 纯收敛（超上限时不留存）', near(delta, pull, 1e-6),
    `Δ=${delta.toFixed(4)}，预期 ${pull.toFixed(4)}`);
  const fairOld = fairFromReport(st);
  const fairNew = fairFromReport({ ...st, fundamentals: r });
  check('fair 下降（账面托底的溢价在消退）', fairNew < fairOld,
    `${fairOld.toFixed(2)} → ${fairNew.toFixed(2)}`);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 亏损：净资产被吞掉但不会变成负数 ===');
{
  let bps = 6;
  for (let i = 0; i < 40; i++) bps = nextBps(bps, -0.5, { pe: 10, growth: -0.2, retain: 0.225 });
  check('连亏 40 期后停在 1（不会负）', bps >= 1 && bps < 2, `bps=${bps.toFixed(3)}`);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
