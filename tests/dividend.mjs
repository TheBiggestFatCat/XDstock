// 分红派息
//
//   node tests/dividend.mjs
//
// 规则：每期财报公布时，按 max(0,EPS) × 派息率 派息，再按现价 × 封顶比例截断；
//      持满一期的多头收钱，空头补息（扣到 0 为止），本期才开的仓不参与。

import { createDb } from '../src/store.js';
import { dividendPerShare } from '../src/fundamentals.js';
import { runReports } from '../src/engine.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

function stock(eps, price, dividendRate = 0.35) {
  return { price, fundamentals: { eps, dividendRate } };
}

/** 造一只带财报的股票；EPS 近似等于传入值，营收多给一点保证不贴地板 */
function seedStock(db, code, { eps = 2, price = 70, dividendRate = 0.35 } = {}) {
  const st = db.stocks[code];
  const shares = Number(st.shares) || 1;
  st.price = price;
  st.fundamentals = {
    period: 10,
    revenue: (eps * shares) / 0.15,
    baseRevenue: ((eps * shares) / 0.15) * 1.2,
    netProfit: eps * shares,
    tradePnl: 0,
    eps,
    bps: 100,
    roe: eps / 100,
    margin: 0.15,
    growth: 0,
    debt: 0.4,
    dividendRate,
    reportAt: Date.now(),
    bias: 0,
    expectedGrowth: 0
  };
  return st;
}

function runOneTick(db) {
  const realLog = console.log;
  console.log = () => {};
  try {
    runReports(db);
  } finally {
    console.log = realLog;
  }
}

// ---------------------------------------------------------------- 1
log('=== 1 每股股息 = EPS × 派息率，再按现价封顶 ===');
{
  const s = stock(2, 400);        // 400×0.5% = 2.0，封顶不生效
  check('未触发封顶：2 × 35% = 0.70', near(dividendPerShare(s, { rate: 0.35, cap: 0.005 }), 0.7),
    dividendPerShare(s, { rate: 0.35, cap: 0.005 }).toFixed(4));
  const cheap = stock(2, 20);      // 自然值 0.7，但 20×0.5% = 0.1
  check('低 PE 被封顶：0.10', near(dividendPerShare(cheap, { rate: 0.35, cap: 0.005 }), 0.1),
    dividendPerShare(cheap, { rate: 0.35, cap: 0.005 }).toFixed(4));
  check('封顶填 0 = 不封顶', near(dividendPerShare(cheap, { rate: 0.35, cap: 0 }), 0.7));
  check('派息率填 0 = 停发', dividendPerShare(s, { rate: 0, cap: 0.005 }) === 0);
  check('亏损不分红', dividendPerShare(stock(-1, 100), { rate: 0.35, cap: 0.005 }) === 0);
  check('没传 rate 时用个股自己的 dividendRate',
    near(dividendPerShare(stock(2, 400, 0.5), { cap: 0.005 }), 1.0), '2×0.5');
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 股价每轮变动 → 封顶后的每股股息跟着变 ===');
{
  const s = stock(2, 20);
  const a = dividendPerShare(s, { rate: 0.35, cap: 0.005 });   // 20 → 0.10
  s.price = 40;
  const b = dividendPerShare(s, { rate: 0.35, cap: 0.005 });   // 40 → 0.20
  s.price = 200;
  const c = dividendPerShare(s, { rate: 0.35, cap: 0.005 });   // 200 → 0.70（自然值）
  check('20 元 → 0.10', near(a, 0.1), a.toFixed(4));
  check('40 元 → 0.20', near(b, 0.2), b.toFixed(4));
  check('200 元 → 0.70（自然值）', near(c, 0.7), c.toFixed(4));
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 实跑引擎：多头收钱、空头补息、本期新开仓不参与 ===');
{
  const db = createDb();
  db.tick = 1000;
  db.config.reportIntervalTicks = 720;
  db.config.dividendRate = 0.35;
  db.config.dividendCap = 0.005;
  const st = seedStock(db, 'XD', { eps: 2, price: 70 });   // 封顶 70×0.5% = 0.35
  db.players = {
    p1: { id: 'p1', nickname: '多头', cash: 0, positions: { XD: { code: 'XD', side: 'long', qty: 1000, entry: 70, margin: 7000, leverage: 10, openedTick: 100 } } },
    p2: { id: 'p2', nickname: '空头', cash: 1000, positions: { XD: { code: 'XD', side: 'short', qty: 500, entry: 70, margin: 3500, leverage: 10, openedTick: 100 } } },
    p3: { id: 'p3', nickname: '刚开', cash: 0, positions: { XD: { code: 'XD', side: 'long', qty: 800, entry: 70, margin: 5600, leverage: 10, openedTick: 900 } } },
    p4: { id: 'p4', nickname: '没仓位', cash: 0, positions: {} }
  };
  st.nextReportTick = 1000;
  runOneTick(db);

  const ev = db.dividendEvents || [];
  const dps = ev.length ? ev[0].dps : 0;
  check('每股股息被现价封顶到 0.35 附近', Math.abs(dps - 0.35) < 0.02, `dps=${dps.toFixed(4)}`);
  check('多头现金 = 1000 × dps', near(db.players.p1.cash, 1000 * dps), db.players.p1.cash.toFixed(2));
  check('多头累计股息同步', near(db.players.p1.dividendEarned, 1000 * dps),
    db.players.p1.dividendEarned.toFixed(2));
  check('空头补息 = 500 × dps', near(db.players.p2.cash, 1000 - 500 * dps), db.players.p2.cash.toFixed(2));
  check('空头累计为负', near(db.players.p2.dividendEarned, -500 * dps),
    db.players.p2.dividendEarned.toFixed(2));
  check('本期新开仓不参与', db.players.p3.cash === 0, String(db.players.p3.cash));
  check('没仓位的人不受影响', db.players.p4.cash === 0);
  check('事件只有 2 条（多头 + 空头）', ev.length === 2, ev.map((e) => e.playerId).join(','));
  check('事件里带 playerId / dps / amount / side',
    ev.every((e) => e.playerId && e.dps > 0 && Number.isFinite(e.amount) && e.side));
  check('推了派息公告', (db.notices || []).some((n) => String(n.text || '').includes('派息')),
    JSON.stringify((db.notices || []).slice(-1)));
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 空头现金不够：扣到 0 为止，不追缴 ===');
{
  const db = createDb();
  db.tick = 1000;
  db.config.reportIntervalTicks = 720;
  db.config.dividendRate = 0.35;
  db.config.dividendCap = 0.005;
  const st = seedStock(db, 'XD', { eps: 2, price: 70 });
  st.nextReportTick = 1000;
  db.players = {
    p1: {
      id: 'p1', nickname: '穷空头', cash: 10,
      positions: { XD: { code: 'XD', side: 'short', qty: 10000, entry: 70, margin: 70000, leverage: 10, openedTick: 100 } }
    }
  };
  runOneTick(db);
  check('现金被扣到 0', db.players.p1.cash === 0, String(db.players.p1.cash));
  check('累计股息按实扣记 -10', near(db.players.p1.dividendEarned, -10, 1e-9),
    db.players.p1.dividendEarned.toFixed(2));
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 关掉分红（派息率 0）就什么都不发 ===');
{
  const db = createDb();
  db.tick = 1000;
  db.config.reportIntervalTicks = 720;
  db.config.dividendRate = 0;
  const st = seedStock(db, 'XD', { eps: 2, price: 70 });
  st.nextReportTick = 1000;
  db.players = {
    p1: { id: 'p1', nickname: '多头', cash: 0, positions: { XD: { code: 'XD', side: 'long', qty: 1000, entry: 70, margin: 7000, leverage: 10, openedTick: 100 } } }
  };
  runOneTick(db);
  check('派息率 0 → 不发钱', db.players.p1.cash === 0 && db.dividendEvents.length === 0,
    `cash=${db.players.p1.cash} events=${db.dividendEvents.length}`);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 每股股息小于 0.001 也要照发（不截断） ===');
{
  const s = stock(0.01, 100);   // 0.01×0.35 = 0.0035
  const v = dividendPerShare(s, { rate: 0.35, cap: 0.005 });
  check('0.0035 保留精度', near(v, 0.0035, 1e-9), v.toFixed(6));
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
