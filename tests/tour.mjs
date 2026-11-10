// 锦标赛（/tournament）回归测试
//
//   node tests/tour.mjs
//
// 覆盖：开赛时间、开赛/冻结、开仓/平仓/爆仓、打工补齐、夺冠冻结、与主市场隔离。
// 只在内存里造 db，不碰 data/db.json。

import { createDb } from '../src/store.js';
import {
  createTour, ensureTour, nextStartAt, tourTick, tourOpen, tourClose, tourJob,
  tourState, tourEquity, tourStatus, joinTour,
  TOUR_START_CASH, TOUR_TARGET, TOUR_MAX_LEVERAGE
} from '../src/tour.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

function newDb() {
  const db = createDb();
  db.players = {
    a: { id: 'a', nickname: '阿甲', cash: 0, positions: {}, orders: [] },
    b: { id: 'b', nickname: '阿乙', cash: 0, positions: {}, orders: [] }
  };
  // 每个用例都从「已经开赛」开始，省得每次等 21:00
  db.tour.startAt = Date.now() - 1000;
  tourTick(db);
  // 参赛账号在第一次打开页面时就建好，这里提前建，方便用例直接改它的账
  joinTour(db.tour, pA);
  joinTour(db.tour, pB);
  return db;
}

/**
 * 把价格摆到指定位置：股价由汇率算出来，改价格会被下一轮覆盖，
 * 所以改汇率（ratio^(1/8) 反解），再清掉溢价与资金压力
 */
function setPrice(t, px) {
  // 股价 = 初始价 × (汇率 / 基准汇率)，这里反解汇率，下一轮 stepPrice 会算出同一个价
  t.fx.rate = t.fx.base * (px / t.stock.initialPrice);
  t.stock.price = px;
}

const pA = { id: 'a', nickname: '阿甲' };
const pB = { id: 'b', nickname: '阿乙' };

// ---------------- 1. 初始化 ----------------
{
  const t = createTour(Date.now());
  check('起手 30 万日元', TOUR_START_CASH === 300000, String(TOUR_START_CASH));
  check('夺冠线 2000 万日元', TOUR_TARGET === 20000000, String(TOUR_TARGET));
  check('初始状态 = 未开赛', tourStatus(t) === 'pending', tourStatus(t));
  check('标的只有 LMFX', t.stock.code === 'LMFX' && t.stock.name === '留美外汇', t.stock.code);
  check('初始价 100', t.stock.price === 100, String(t.stock.price));

  const s = new Date(t.startAt);
  check('开赛时间在 21:00 整', s.getHours() === 21 && s.getMinutes() === 0, s.toLocaleString());
  check('开赛时间晚于当前', t.startAt > Date.now(), new Date(t.startAt).toISOString());
}

{
  // 已经过了今晚 9 点 → 排到明晚
  const tonight = new Date();
  tonight.setHours(22, 30, 0, 0);
  const next = new Date(nextStartAt(tonight.getTime()));
  const expect = new Date(tonight.getTime());
  expect.setDate(expect.getDate() + 1);
  check('过了 21:00 顺延到次日', next.getDate() === expect.getDate() && next.getHours() === 21,
    next.toLocaleString());
}

{
  // 老存档补字段
  const db = { config: { tickMs: 5000 } };
  const t = ensureTour(db);
  check('空存档自动补 tour', !!db.tour && t.stock.code === 'LMFX');
  check('补出来的没有玩家', Object.keys(t.players).length === 0);
  check('补出来的有开赛时间', t.startAt > Date.now());
}

// ---------------- 2. 开赛前不能交易 ----------------
{
  const db = createDb();
  db.players.a = { id: 'a', nickname: '阿甲' };
  const blocked = tourOpen(db, pA, { side: 'long', qty: 10, leverage: 5 });
  check('开赛前开仓被拒', blocked.ok === false, blocked.error);
  check('开赛前打工被拒', tourJob(db, pA).ok === false);
  const st = tourState(db, pA);
  check('开赛前状态 pending', st.status === 'pending', st.status);
  check('开赛前也能开户（排行里能看到）', st.players === 1, String(st.players));
}

// ---------------- 3. 开赛推进 ----------------
{
  const db = createDb();
  db.tour.startAt = Date.now() - 1;
  const before = db.tour.stock.price;
  tourTick(db);
  check('到点自动开赛', db.tour.startedAt > 0 && tourStatus(db.tour) === 'running');
  check('tick 从 1 开始', db.tour.tick === 1, String(db.tour.tick));
  check('价格是有效数字', Number.isFinite(db.tour.stock.price) && db.tour.stock.price > 0,
    `${before} -> ${db.tour.stock.price}`);
  check('价格序列 +1 点', db.tour.stock.series.length === 2, String(db.tour.stock.series.length));

  for (let i = 0; i < 5; i++) tourTick(db);
  check('连续推进 tick 累加', db.tour.tick === 6, String(db.tour.tick));

  for (let i = 0; i < 40; i++) tourTick(db);
  check('价格会真的走（40 轮里出现多个价位）',
    new Set(db.tour.stock.series).size > 1, String(new Set(db.tour.stock.series).size));
  check('价格始终为正', db.tour.stock.price > 0, String(db.tour.stock.price));
}

// ---------------- 4. 开仓 / 平仓 ----------------
{
  const db = newDb();
  const t = db.tour;
  t.stock.price = 100;
  t.stock.prev = 100;
  const g = db.tour.players.a;
  const r = tourOpen(db, pA, { side: 'long', qty: 1000, leverage: 10 });
  check('开多成功', r.ok === true, r.error || '');
  check('建立了持仓', g.positions.LMFX?.qty === 1000, String(g.positions.LMFX?.qty));
  check('保证金 = 名义 / 杠杆', near(g.positions.LMFX.margin, 1000 * 100 / 10), String(g.positions.LMFX.margin));
  check('现金 = 30 万 − 保证金 − 手续费',
    near(g.cash, 300000 - 10000 - 1000 * 100 * 0.0002), String(g.cash));
  check('权益 = 现金 + 保证金（不亏不赚）', near(tourEquity(t, g), g.cash + 10000), String(tourEquity(t, g)));
  check('开仓计入战绩', g.opens === 1, String(g.opens));
  check('开仓写了流水', g.log.length === 1 && g.log[0].action === 'open', JSON.stringify(g.log[0]));

  // 价格涨 10%，10 倍杠杆 → 保证金翻倍
  t.stock.price = 110;
  const eqUp = tourEquity(t, g);
  check('涨 10% × 10 倍 → 权益 +1 万', near(eqUp, g.cash + 10000 + 10000, 1e-6), String(eqUp));

  const c = tourClose(db, pA, {});
  check('平仓成功', c.ok === true, c.error || '');
  check('平仓后没有持仓', !g.positions.LMFX);
  check('平仓盈亏 = 1 万（扣手续费）', near(c.pnl, 10000), String(c.pnl));
  check('平仓计入战绩', g.closes === 1, String(g.closes));
  check('无持仓时再平仓报错', tourClose(db, pA, {}).ok === false);
}

// ---------------- 5. 做空方向正确 ----------------
{
  const db = newDb();
  const t = db.tour;
  t.stock.price = 100;
  const g = t.players.a;
  tourOpen(db, pA, { side: 'short', qty: 500, leverage: 5 });
  t.stock.price = 90;
  const eq = tourEquity(t, g);
  // 500 份跌 10 日元 = +5000
  check('做空跌 10% 赚钱', near(eq, g.cash + 500 * 100 / 5 + 5000), String(eq));
  const c = tourClose(db, pA, {});
  check('做空平仓盈利 5000', near(c.pnl, 5000), String(c.pnl));
}

// ---------------- 6. 校验与拦截 ----------------
{
  const db = newDb();
  const g = db.tour.players.a;
  check('数量 0 被拒', tourOpen(db, pA, { side: 'long', qty: 0 }).ok === false);
  check('数量负数被拒', tourOpen(db, pA, { side: 'long', qty: -5 }).ok === false);
  check('数量非数字被拒', tourOpen(db, pA, { side: 'long', qty: 'abc' }).ok === false);
  check('现金不够被拒', tourOpen(db, pA, { side: 'long', qty: 1000000, leverage: 1 }).ok === false);

  tourOpen(db, pA, { side: 'long', qty: 100, leverage: 999 });
  check(`杠杆超上限被夹到 ${TOUR_MAX_LEVERAGE}`, Math.round(g.positions.LMFX.leverage) === TOUR_MAX_LEVERAGE,
    String(g.positions.LMFX.leverage));
  const rev = tourOpen(db, pA, { side: 'short', qty: 100, leverage: 5 });
  check('反手被拒（先平再开）', rev.ok === false, rev.error);
  check('反手指令没有动现金', g.cash > 0, String(g.cash));
}

// ---------------- 7. 爆仓 ----------------
{
  const db = newDb();
  const t = db.tour;
  t.stock.price = 100;
  const g = t.players.a;
  tourOpen(db, pA, { side: 'long', qty: 1000, leverage: 10 });
  const cashAfter = g.cash;
  setPrice(t, 50);                    // 腰斩，10 倍杠杆必爆
  tourTick(db);
  check('爆仓后没有持仓', !g.positions.LMFX);
  check('爆仓计数 +1', g.liquidations === 1, String(g.liquidations));
  check('爆仓后现金不为负', g.cash >= 0, String(g.cash));
  check('爆仓把保证金吃光（只剩原来的现金）', near(g.cash, cashAfter, 1e-6), `${g.cash} vs ${cashAfter}`);
  check('爆仓写了流水', g.log.some((r) => r.action === 'liquidate'));
}

// ---------------- 8. 打工 ----------------
{
  const db = newDb();
  const g = db.tour.players.a;
  check('30 万整不能打工', tourJob(db, pA).ok === false);

  g.cash = 120000;
  const r = tourJob(db, pA);
  check('现金不足时打工成功', r.ok === true, r.error || '');
  check('一次性补齐到 30 万', g.cash === 300000, String(g.cash));
  check('返回补齐金额', r.gained === 180000, String(r.gained));
  check('打工次数 +1', g.jobs === 1, String(g.jobs));

  // 亏光一次打一次，次数不设上限
  for (let i = 0; i < 3; i++) {
    g.cash = 0;
    tourJob(db, pA);
  }
  check('无次数限制（第 4 次仍然可以）', g.jobs === 4, String(g.jobs));

  g.cash = 299999;
  check('差 1 日元也算不足，可以打工', tourJob(db, pA).ok === true);
}

// ---------------- 9. 夺冠冻结 ----------------
{
  const db = newDb();
  const t = db.tour;
  const g = t.players.a;
  g.cash = TOUR_TARGET;
  tourTick(db);
  check('权益摸到 2000 万即夺冠', t.frozen === true && !!t.winner, JSON.stringify(t.winner));
  check('冠军是阿甲', t.winner?.id === 'a', t.winner?.nickname);
  check('状态变成 ended', tourStatus(t) === 'ended');
  check('夺冠后不能再开仓', tourOpen(db, pA, { side: 'long', qty: 10, leverage: 2 }).ok === false);
  check('夺冠后不能再打工', tourJob(db, pA).ok === false);

  const priceAfter = t.stock.price;
  const tickAfter = t.tick;
  for (let i = 0; i < 10; i++) tourTick(db);
  check('冻结后价格不动', t.stock.price === priceAfter, `${priceAfter} -> ${t.stock.price}`);
  check('冻结后 tick 不再前进', t.tick === tickAfter, `${tickAfter} -> ${t.tick}`);
  check('排行榜第一名是冠军', tourState(db, pA).ranks[0].id === 'a');
  check('冠军标记下发给前端', tourState(db, null).winner?.id === 'a');
}

// ---------------- 10. 排行与快照 ----------------
{
  const db = newDb();
  const t = db.tour;
  t.stock.price = 100;
  tourOpen(db, pA, { side: 'long', qty: 100, leverage: 5 });
  tourOpen(db, pB, { side: 'long', qty: 1000, leverage: 5 });
  // 直接摆价，不走 tick（tick 会按汇率重算价格）
  t.stock.price = 110;

  const st = tourState(db, pA);
  check('排行按权益降序', st.ranks[0].equity >= st.ranks[1].equity,
    `${st.ranks[0].equity} / ${st.ranks[1].equity}`);
  check('买得多的阿乙排前面', st.ranks[0].id === 'b', st.ranks[0].id);
  check('自己的名次正确', st.me.rank === 2, String(st.me.rank));
  check('快照带持仓', st.me.position?.side === 'long', JSON.stringify(st.me.position));
  check('快照带收益率', Number.isFinite(st.me.retPct), String(st.me.retPct));
  check('快照不带内部压力字段', st.stock.flow === undefined && st.stock.series !== undefined);
  check('快照带走势序列', Array.isArray(st.stock.series) && st.stock.series.length > 0);
  check('未登录也能看排行', tourState(db, null).ranks.length === 2);
  check('未登录没有个人数据', tourState(db, null).me === null);
}

// ---------------- 11. 与主市场完全隔离 ----------------
{
  const db = newDb();
  const before = {
    cash: db.players.a.cash,
    positions: JSON.stringify(db.players.a.positions),
    tick: db.tick,
    stocks: Object.keys(db.stocks).length,
    price: db.stocks.TGW?.price
  };
  db.tour.stock.price = 100;
  tourOpen(db, pA, { side: 'long', qty: 5000, leverage: 20 });
  for (let i = 0; i < 5; i++) tourTick(db);
  tourClose(db, pA, {});
  check('主市场现金没动', db.players.a.cash === before.cash, `${before.cash} -> ${db.players.a.cash}`);
  check('主市场持仓没动', JSON.stringify(db.players.a.positions) === before.positions);
  check('主市场 tick 没动', db.tick === before.tick);
  check('没有往主市场塞标的', Object.keys(db.stocks).length === before.stocks);
  check('主市场股价没动', db.stocks.TGW?.price === before.price);
  check('锦标赛账户独立记账', !!db.tour.players.a);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
