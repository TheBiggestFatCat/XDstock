// 分红派息（含除权）
//
//   node tests/dividend.mjs
//
// 规则：
//   1. 每期财报公布时派息，金额 = max(0,EPS) × 行业派息率 × 后台倍率，
//      再按「现价 × 封顶」截断
//   2. 持满一期的多头收钱，空头补息（扣到 0 为止），本期才开的仓不参与
//   3. 派完立刻除权：股价下调相同的每股金额，多头总资产不变

import { createDb } from '../src/store.js';
import { dividendPerShare, dividendPayout } from '../src/fundamentals.js';
import { runReports } from '../src/engine.js';
import { logTrade } from '../src/trading.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

function mk(industry, eps, price) {
  return { industry, price, fundamentals: { eps } };
}

/** 造一只带财报的股票；EPS 近似等于传入值 */
function seedStock(db, code, { eps = 2, price = 70, industry = '' } = {}) {
  const st = db.stocks[code];
  const shares = Number(st.shares) || 1;
  if (industry) st.industry = industry;
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
    dividendRate: 0.35,   // 老字段，已经不用了
    reportAt: Date.now(),
    bias: 0,
    expectedGrowth: 0
  };
  return st;
}

/** 复现引擎：除权（4 位小数）→ 财报惊喜冲击（|shock| ≤ 0.0005 时不生效）→ 再 4 位小数 */
function priceAfterEx(before, dps, st) {
  const ex = Number((before - dps).toFixed(4));
  const shock = Math.max(-0.06, Math.min(0.06, Number(st.lastSurprise || 0) * 0.8));
  if (!(Math.abs(shock) > 0.0005)) return { price: ex, shock: 0 };
  return { price: Number((ex * (1 + shock)).toFixed(4)), shock };
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
log('=== 1 派息率按行业（参考现实：成长股少分、金融多分） ===');
{
  const cases = [
    ['金融', 0.4], ['消费娱乐', 0.45], ['科技AI', 0.12], ['传媒', 0.3], ['外汇经营', 0.35]
  ];
  for (const [ind, want] of cases) {
    const got = dividendPayout(mk(ind, 2, 100), 1);
    check(`${ind} → ${(want * 100).toFixed(0)}%`, near(got, want), (got * 100).toFixed(0) + '%');
  }
  check('倍率 2 → 翻倍', near(dividendPayout(mk('金融', 2, 100), 2), 0.8));
  check('倍率 0 → 停发', dividendPayout(mk('金融', 2, 100), 0) === 0);
  check('倍率超范围被夹住（5 → 100% 上限）',
    near(dividendPayout(mk('消费娱乐', 2, 100), 9), 1), String(dividendPayout(mk('消费娱乐', 2, 100), 9)));
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 每股股息 = EPS × 派息率，再按现价封顶 1.5% ===');
{
  const s = mk('消费娱乐', 2, 400);     // 2×0.45 = 0.9，封顶 400×1.5% = 6 → 不封顶
  check('消费 45%：2 → 0.90', near(dividendPerShare(s, { rate: 1, cap: 0.015 }), 0.9),
    dividendPerShare(s, { rate: 1, cap: 0.015 }).toFixed(4));
  const cheap = mk('金融', 2, 20);      // 2×0.4 = 0.8，封顶 20×1.5% = 0.3
  check('低 PE 被封顶：0.30', near(dividendPerShare(cheap, { rate: 1, cap: 0.015 }), 0.3),
    dividendPerShare(cheap, { rate: 1, cap: 0.015 }).toFixed(4));
  check('封顶填 0 = 不封顶', near(dividendPerShare(cheap, { rate: 1, cap: 0 }), 0.8));
  check('亏损不分红', dividendPerShare(mk('金融', -1, 100), { rate: 1, cap: 0.015 }) === 0);
  check('倍率控制总量', near(dividendPerShare(s, { rate: 2, cap: 0.015 }), 1.8));
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 股价每轮变动 → 封顶后的每股股息跟着变 ===');
{
  const s = mk('金融', 2, 20);
  const a = dividendPerShare(s, { rate: 1, cap: 0.015 });   // 20 → 0.30
  s.price = 40;
  const b = dividendPerShare(s, { rate: 1, cap: 0.015 });   // 40 → 0.60
  s.price = 100;
  const c = dividendPerShare(s, { rate: 1, cap: 0.015 });   // 100 → 0.80（自然值）
  check('20 元 → 0.30', near(a, 0.3), a.toFixed(4));
  check('40 元 → 0.60', near(b, 0.6), b.toFixed(4));
  check('100 元 → 0.80（自然值）', near(c, 0.8), c.toFixed(4));
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 实跑引擎：派息 + 除权，多头总资产不变 ===');
{
  const db = createDb();
  db.tick = 1000;
  db.config.reportIntervalTicks = 720;
  db.config.dividendRate = 1;
  db.config.dividendCap = 0.015;
  const st = seedStock(db, 'XD', { eps: 2, price: 70, industry: '金融' });
  st.nextReportTick = 1000;
  db.players = {
    p1: { id: 'p1', nickname: '多头', cash: 0, positions: { XD: { code: 'XD', side: 'long', qty: 1000, entry: 70, margin: 7000, leverage: 10, openedTick: 100 } } },
    p2: { id: 'p2', nickname: '空头', cash: 1000, positions: { XD: { code: 'XD', side: 'short', qty: 500, entry: 70, margin: 3500, leverage: 10, openedTick: 100 } } },
    p3: { id: 'p3', nickname: '刚开', cash: 0, positions: { XD: { code: 'XD', side: 'long', qty: 800, entry: 70, margin: 5600, leverage: 10, openedTick: 900 } } }
  };
  const priceBefore = st.price;
  runOneTick(db);

  const ev = db.dividendEvents || [];
  const dps = ev.length ? ev[0].dps : 0;
  const epsNow = st.fundamentals.eps;
  const natural = Math.min(epsNow * 0.4, priceBefore * 0.015);
  check('派息率按金融 40%（EPS × 40%，未撞封顶）', near(dps, natural, 1e-6),
    `dps=${dps.toFixed(4)}，EPS=${epsNow.toFixed(3)}`);
  check('多头现金 = 1000 × dps', near(db.players.p1.cash, 1000 * dps), db.players.p1.cash.toFixed(2));
  check('空头补息 = 500 × dps', near(db.players.p2.cash, 1000 - 500 * dps), db.players.p2.cash.toFixed(2));
  check('本期新开仓不参与', db.players.p3.cash === 0);
  check('事件 2 条', ev.length === 2, ev.map((e) => e.playerId).join(','));

  // 除权：价格先减 dps，再乘财报惊喜冲击（±6%）
  const exp = priceAfterEx(priceBefore, dps, st);
  const shock = exp.shock;
  const expectPrice = exp.price;
  check('除权：股价先减掉每股股息', near(st.price, expectPrice, 1e-4),
    `${priceBefore.toFixed(2)} 除权 ${(priceBefore - dps).toFixed(2)} 后冲击 → ${st.price.toFixed(2)}（预期 ${expectPrice}）`);
  // 多头：拿到现金 1000×dps，持仓市值因除权跌掉 1000×dps（剩下的差额来自 ±6% 财报冲击）
  const exPrice = shock > 0 || shock < 0 ? st.price / (1 + shock) : st.price;
  const posLoss = (priceBefore - exPrice) * 1000;
  check('持仓市值跌幅 = 拿到的现金（总资产中性）', near(posLoss, 1000 * dps, 0.2),
    `现金 +${(1000 * dps).toFixed(2)}，持仓 ${posLoss.toFixed(2)}`);
  check('推了派息公告（含除权价）',
    (db.notices || []).some((n) => String(n.text || '').includes('派息') && String(n.text || '').includes('除权价')),
    JSON.stringify((db.notices || []).slice(-1)));
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 没人持有也要除权（现实中所有股份都除权）===');
{
  const db = createDb();
  db.tick = 1000;
  db.config.reportIntervalTicks = 720;
  db.config.dividendRate = 1;
  db.config.dividendCap = 0.015;
  const st = seedStock(db, 'XD', { eps: 2, price: 70, industry: '金融' });
  st.nextReportTick = 1000;
  db.players = {};
  const before = st.price;
  runOneTick(db);
  const dps = Math.min(st.fundamentals.eps * 0.4, before * 0.015);
  const exp = priceAfterEx(before, dps, st);
  const shock = exp.shock;
  const expectPrice = exp.price;
  check('价格照样下调', near(st.price, expectPrice, 1e-4),
    `${before.toFixed(2)} 除权 ${(before - dps).toFixed(2)} 后 → ${st.price.toFixed(2)}（预期 ${expectPrice}）`);
  check('没人持有就不发公告', !(db.notices || []).some((n) => String(n.text || '').includes('派息')));
  check('没有派息事件', (db.dividendEvents || []).length === 0);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 空头现金不够：扣到 0 为止，不追缴 ===');
{
  const db = createDb();
  db.tick = 1000;
  db.config.reportIntervalTicks = 720;
  db.config.dividendRate = 1;
  db.config.dividendCap = 0.015;
  const st = seedStock(db, 'XD', { eps: 2, price: 70, industry: '金融' });
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

// ---------------------------------------------------------------- 7
log('');
log('=== 7 倍率 0 = 停发（不改股价）===');
{
  const db = createDb();
  db.tick = 1000;
  db.config.reportIntervalTicks = 720;
  db.config.dividendRate = 0;
  const st = seedStock(db, 'XD', { eps: 2, price: 70, industry: '金融' });
  st.nextReportTick = 1000;
  db.players = {
    p1: { id: 'p1', nickname: '多头', cash: 0, positions: { XD: { code: 'XD', side: 'long', qty: 1000, entry: 70, margin: 7000, leverage: 10, openedTick: 100 } } }
  };
  const before = st.price;
  runOneTick(db);
  const shock = Math.max(-0.06, Math.min(0.06, Number(st.lastSurprise || 0) * 0.8));
  check('不发钱', db.players.p1.cash === 0 && (db.dividendEvents || []).length === 0);
  // ⚠️ 引擎只在 |shock| > 0.0005 时才改价（太小就不动），期望值要跟这个门槛一致，
  // 否则随机 EPS 偶尔落在死区里、测试就会偶发失败（2026-11 修）
  const expectPrice = Math.abs(shock) > 0.0005 ? Number((before * (1 + shock)).toFixed(4)) : before;
  check('也不除权（只有财报冲击）', near(st.price, expectPrice, 1e-4),
    `${before.toFixed(2)} → ${st.price.toFixed(2)}（预期 ${expectPrice.toFixed(2)}）`);
}

// ---------------------------------------------------------------- 8
log('');
log('=== 8 派息要写进交易记录（不然玩家只能看到一条一闪而过的提示）===');
{
  const db = createDb();
  db.tick = 1000;
  db.config.reportIntervalTicks = 720;
  db.config.dividendRate = 1;
  db.config.dividendCap = 0.015;
  const st = seedStock(db, 'XD', { eps: 2, price: 70, industry: '金融' });
  st.nextReportTick = 1000;
  db.players = {
    long1: { id: 'long1', nickname: '多头一号', cash: 0,
      positions: { XD: { code: 'XD', side: 'long', qty: 1000, entry: 70, margin: 7000, leverage: 10, openedTick: 100 } } },
    short1: { id: 'short1', nickname: '空头一号', cash: 500,
      positions: { XD: { code: 'XD', side: 'short', qty: 400, entry: 70, margin: 2800, leverage: 10, openedTick: 100 } } },
    fresh1: { id: 'fresh1', nickname: '刚开仓', cash: 0,
      positions: { XD: { code: 'XD', side: 'long', qty: 900, entry: 70, margin: 6300, leverage: 10, openedTick: 990 } } }
  };
  // dps 在这一轮里是用**新一期**财报算的，所以不能拿跑之前的 dps 比，
  // 只能拿记录自己的「每股 × 股数」互相校验，再跟 dividendEvents 对一下
  const dps = dividendPerShare(st, { rate: 1, cap: 0.015 });
  void dps;
  runOneTick(db);
  const divs = (db.trades || []).filter((t) => t.action === 'dividend');
  check('交易记录里有派息记录', divs.length === 2, `共 ${divs.length} 条`);
  const longRow = divs.find((t) => t.playerId === 'long1');
  const shortRow = divs.find((t) => t.playerId === 'short1');
  check('多头那条金额 = 股数 × 每股', !!longRow && near(longRow.amount, longRow.qty * longRow.price, 1e-6),
    longRow ? `${longRow.amount.toFixed(4)} vs ${(longRow.qty * longRow.price).toFixed(4)}` : '没有多头记录');
  check('多头那条带股数和每股金额', !!longRow && longRow.qty === 1000 && Number(longRow.price) > 0);
  const longEvent = (db.dividendEvents || []).find((e) => e.playerId === 'long1');
  check('跟 dividendEvents 的金额一致', !!longRow && !!longEvent && near(longRow.amount, longEvent.amount, 1e-9),
    longRow && longEvent ? `${longRow.amount.toFixed(4)} / ${longEvent.amount.toFixed(4)}` : '缺数据');
  check('多头那条 reason = dividend', !!longRow && longRow.reason === 'dividend');
  check('多头那条 pnl 为正', !!longRow && longRow.pnl > 0);
  check('空头那条金额为负（补息）', !!shortRow && shortRow.amount < 0,
    shortRow ? shortRow.amount.toFixed(2) : '没有空头记录');
  check('空头那条方向记的是空', !!shortRow && shortRow.side === 'short');
  check('本期才开的仓没有派息记录', !divs.some((t) => t.playerId === 'fresh1'));
  check('记录里带了昵称和股票名', !!longRow && longRow.nickname === '多头一号' && !!longRow.name);

  // 分红 / 贴息（空头补息）不是换手，不能算进成交量
  const volTicks = Number(st.volTick) || 0;
  const volSum = (st.volSeries || []).reduce((a, b) => a + (Number(b) || 0), 0);
  check('分红没有往本轮成交量里加股数', volTicks === 0, `volTick=${volTicks}`);
  check('分红没有写进成交量序列', volSum === 0, `volSeries 合计=${volSum}`);

  // 对照：真实开平仓还是要记量
  const st2 = db.stocks.MB;
  st2.volTick = 0;
  logTrade(db, { playerId: 'x', code: 'MB', action: 'open', side: 'long', qty: 500, price: 10 });
  check('开仓照常记成交量', Number(st2.volTick) === 500, String(st2.volTick));
  logTrade(db, { playerId: 'x', code: 'MB', action: 'close', side: 'long', qty: 300, price: 10 });
  check('平仓也记成交量', Number(st2.volTick) === 800, String(st2.volTick));
  logTrade(db, { playerId: 'x', code: 'MB', action: 'dividend', side: 'long', qty: 999, price: 1 });
  check('股息流水不加量', Number(st2.volTick) === 800, String(st2.volTick));
  logTrade(db, { playerId: 'x', code: 'MB', action: 'steal', side: 'long', qty: 0, price: 0 });
  check('偷钱流水不加量', Number(st2.volTick) === 800, String(st2.volTick));
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
