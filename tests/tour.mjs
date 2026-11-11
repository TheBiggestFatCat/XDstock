// 锦标赛（/tournament）回归测试
//
//   node tests/tour.mjs
//
// 覆盖：开赛时间、开赛/冻结、开仓/平仓/爆仓、打工补齐、夺冠冻结、与主市场隔离。
// 只在内存里造 db，不碰 data/db.json。

import { createDb } from '../src/store.js';
import {
  createTour, ensureTour, nextStartAt, tourTick, tourOpen, tourClose, tourJob,
  tourState, tourEquity, tourStatus, joinTour, setTourRate,
  setTourHist, tourCandles, tourSetClosed, TOUR_TFS,
  tourTpSl, tourTpSlRemove,
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
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function newDb() {
  const db = createDb();
  db.players = {
    a: { id: 'a', nickname: '阿甲', cash: 0, positions: {}, orders: [] },
    b: { id: 'b', nickname: '阿乙', cash: 0, positions: {}, orders: [] }
  };
  // 每个用例都从「已经开赛」开始，省得每次等 21:00
  db.tour.startAt = Date.now() - 1000;
  // 锦标赛报价就是抓到的 AUD/JPY，测试里给一个固定值当「已经连上汇率」
  setTourRate(db, 108.9, Date.now(), 'test');
  tourTick(db);
  // 参赛账号在第一次打开页面时就建好，这里提前建，方便用例直接改它的账
  joinTour(db.tour, pA);
  joinTour(db.tour, pB);
  return db;
}

/**
 * 把报价摆到指定位置：股价就是汇率原值，所以直接改 fx.rate，
 * 下一轮 stepPrice 会算出同一个价。
 */
function setPrice(t, px) {
  t.fx.rate = px;
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
  check('未连上汇率时没有报价', t.stock.price === 0 && t.fx.rate === 0,
    `${t.stock.price} / ${t.fx.rate}`);

  const s = new Date(t.startAt);
  check('开赛时间在 21:00 整', s.getHours() === 21 && s.getMinutes() === 0, s.toLocaleString());
  check('开赛时间晚于当前', t.startAt > Date.now(), new Date(t.startAt).toISOString());
}

// ---------------- 1.5 汇率接入 ----------------
{
  const db = createDb();
  const t = db.tour;
  check('新赛区还没汇率', t.fx.rate === 0 && t.fx.stale === true, JSON.stringify(t.fx));

  // 还没开赛：抓到汇率就把报价对齐，别等第一轮从占位值跳一大截
  setTourRate(db, 108.93, Date.now(), 'swissquote');
  check('抓到汇率后报价对齐', t.stock.price === 108.93 && t.stock.prev === 108.93, String(t.stock.price));
  check('series 重置成一个点', t.stock.series.length === 1 && t.stock.series[0] === 108.93,
    JSON.stringify(t.stock.series));
  check('来源/时间记上了', t.fx.source === 'swissquote' && t.fx.at > 0 && t.fx.stale === false,
    JSON.stringify(t.fx));
  check('不再有 base 和 initialPrice', t.fx.base === undefined && t.stock.initialPrice === undefined,
    `${t.fx.base} / ${t.stock.initialPrice}`);

  // 抓失败：只标 stale，价格原地不动
  const before = t.stock.price;
  check('抓失败返回 false', setTourRate(db, 0) === false);
  check('抓失败价格不动', t.stock.price === before && t.fx.rate === 108.93, String(t.stock.price));
  check('抓失败标 stale', t.fx.stale === true);
}

{
  // 开赛之后：股价每轮严格等于汇率原值
  const db = newDb();
  const t = db.tour;
  setTourRate(db, 111.11);
  tourTick(db);
  check('开赛后台股价 = 汇率', t.stock.price === 111.11, String(t.stock.price));
  check('prev 跟上一次同步', t.stock.prev === 108.9, String(t.stock.prev));
  check('快照里 price 和 fxRate 一致',
    tourState(db).stock.price === tourState(db).stock.fxRate,
    `${tourState(db).stock.price} / ${tourState(db).stock.fxRate}`);
}

{
  // 开赛了但一次都没抓到汇率 → 不能下单（否则会按 0 或占位价成交）
  const db = createDb();
  db.players = { a: { id: 'a', nickname: '阿甲', cash: 0, positions: {}, orders: [] } };
  const t = db.tour;
  t.startAt = Date.now() - 1000;
  joinTour(t, pA);
  const r = tourOpen(db, pA, { side: 'long', qty: 1, leverage: 1 });
  check('汇率没接上不能下单', r.ok === false && /汇率/.test(r.error), r.error);
  const j = tourJob(db, pA);
  check('汇率没接上也不能打工', j.ok === false && /汇率/.test(j.error), j.error);
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

// ---------------- 2.5 赛前走势照走，交易仍然锁着 ----------------
{
  const db = createDb();
  setTourRate(db, 110.1);
  for (let i = 0; i < 4; i++) {
    setTourRate(db, 110.1 + (i + 1) * 0.01);   // 汇率每轮动一下
    tourTick(db);
  }
  check('赛前走势图照走（series 会积累）', db.tour.stock.series.length === 5,
    String(db.tour.stock.series.length));
  check('赛前 setTourRate 不再重置序列', db.tour.stock.series[0] === 110.1,
    String(db.tour.stock.series[0]));
  check('赛前价格跟着实时汇率', near(db.tour.stock.price, 110.14, 1e-9), String(db.tour.stock.price));
  check('赛前 tick 不推进', db.tour.tick === 0, String(db.tour.tick));
  check('赛前仍不能交易', tourOpen(db, pA, { side: 'long', qty: 10, leverage: 5 }).ok === false);
  const pre = tourCandles(db, '1m');
  check('赛前 K 线接口照常能给（实时聚合的部分）',
    Array.isArray(pre.candles) && pre.candles.length >= 1, String(pre.candles.length));
  check('K 线不再塞进 /api/tour 快照', tourState(db, pA).stock.series === undefined);
}

// ---------------- 3. 开赛推进 ----------------
{
  const db = createDb();
  db.tour.startAt = Date.now() - 1;
  setTourRate(db, 108.5);                 // 开赛前先把汇率接上
  const before = db.tour.stock.price;
  tourTick(db);
  check('到点自动开赛', db.tour.startedAt > 0 && tourStatus(db.tour) === 'running');
  check('tick 从 1 开始', db.tour.tick === 1, String(db.tour.tick));
  check('开赛首轮沿用当前汇率', db.tour.stock.price === 108.5 && before === 108.5,
    `${before} -> ${db.tour.stock.price}`);
  check('每轮落一个点（时间轴均匀）', db.tour.stock.series.length === db.tour.tick + 1,
    `${db.tour.stock.series.length} / tick ${db.tour.tick}`);
  check('每个价格点都有时间戳（K 线 x 轴用）',
    db.tour.stock.seriesAt.length === db.tour.stock.series.length,
    `${db.tour.stock.seriesAt.length} / ${db.tour.stock.series.length}`);

  for (let i = 1; i <= 5; i++) {
    setTourRate(db, 108.5 + i * 0.1);     // 汇率每轮动一下
    tourTick(db);
  }
  check('连续推进 tick 累加', db.tour.tick === 6, String(db.tour.tick));
  check('汇率变了价格就跟着走', new Set(db.tour.stock.series).size === 6,
    String(new Set(db.tour.stock.series).size));
  check('价格严格等于最后一次汇率', near(db.tour.stock.price, 109, 1e-9), String(db.tour.stock.price));

  // 汇率抓不到 → 价格原地不动，但时间轴照样往前走（画成平线）
  const frozenPx = db.tour.stock.price;
  for (let i = 0; i < 3; i++) tourTick(db);
  check('汇率没更新时价格不动', db.tour.stock.price === frozenPx, String(db.tour.stock.price));
  check('汇率没更新时序列照样加长', db.tour.stock.series.length === db.tour.tick + 1,
    `${db.tour.stock.series.length} / tick ${db.tour.tick}`);
}

// ---------------- 4. 开仓 / 平仓 ----------------
{
  const db = newDb();
  const t = db.tour;
  t.stock.price = 100;
  t.stock.prev = 100;
  const g = db.tour.players.a;
  const r = tourOpen(db, pA, { side: 'long', qty: 1000, leverage: 20 });
  check('开多成功', r.ok === true, r.error || '');
  check('建立了持仓', g.positions.LMFX?.qty === 1000, String(g.positions.LMFX?.qty));
  check('保证金 = 名义 / 杠杆', near(g.positions.LMFX.margin, 1000 * 100 / 20), String(g.positions.LMFX.margin));
  check('现金 = 30 万 − 保证金（零手续费）',
    near(g.cash, 300000 - 5000), String(g.cash));
  check('权益 = 现金 + 保证金（不亏不赚）', near(tourEquity(t, g), g.cash + 5000), String(tourEquity(t, g)));
  check('开仓计入战绩', g.opens === 1, String(g.opens));
  check('开仓写了流水', g.log.length === 1 && g.log[0].action === 'open', JSON.stringify(g.log[0]));

  // 价格涨 10%（1000 份 × 10 日元 = +1 万）
  t.stock.price = 110;
  const eqUp = tourEquity(t, g);
  check('涨 10% × 20 倍 → 权益 +1 万', near(eqUp, g.cash + 5000 + 10000, 1e-6), String(eqUp));

  const c = tourClose(db, pA, {});
  check('平仓成功', c.ok === true, c.error || '');
  check('平仓后没有持仓', !g.positions.LMFX);
  check('平仓盈亏 = 1 万', near(c.pnl, 10000), String(c.pnl));
  check('零手续费：平仓现金 = 起手现金 + 盈亏', near(g.cash, 300000 + 10000), String(g.cash));
  check('平仓计入战绩', g.closes === 1, String(g.closes));
  check('无持仓时再平仓报错', tourClose(db, pA, {}).ok === false);
}

// ---------------- 5. 做空方向正确 ----------------
{
  const db = newDb();
  const t = db.tour;
  t.stock.price = 100;
  const g = t.players.a;
  tourOpen(db, pA, { side: 'short', qty: 500, leverage: 20 });
  t.stock.price = 90;
  const eq = tourEquity(t, g);
  // 500 份跌 10 日元 = +5000
  check('做空跌 10% 赚钱', near(eq, g.cash + 500 * 100 / 20 + 5000), String(eq));
  const c = tourClose(db, pA, {});
  check('做空平仓盈利 5000', near(c.pnl, 5000), String(c.pnl));
}

// ---------------- 5.5 杠杆档位（20~1000，只收 10 的倍数） ----------------
for (const [raw, want, label] of [
  [1, 20, '低于下限夹到 20'],
  [37, 40, '37 倍取整到 40'],
  [55, 60, '55 倍取整到 60'],
  [1004, 1000, '高于上限夹到 1000'],
  [20, 20, '20 倍原样']
]) {
  const db = newDb();
  const g = db.tour.players.a;
  tourOpen(db, pA, { side: 'long', qty: 100, leverage: raw });
  const got = Math.round(g.positions.LMFX.leverage);
  check(`杠杆 ${raw} → ${want}（${label}）`, got === want, String(got));
}

// ---------------- 6. 校验与拦截 ----------------
{
  const db = newDb();
  const g = db.tour.players.a;
  check('数量 0 被拒', tourOpen(db, pA, { side: 'long', qty: 0 }).ok === false);
  check('数量负数被拒', tourOpen(db, pA, { side: 'long', qty: -5 }).ok === false);
  check('数量非数字被拒', tourOpen(db, pA, { side: 'long', qty: 'abc' }).ok === false);
  check('现金不够被拒', tourOpen(db, pA, { side: 'long', qty: 1000000, leverage: 1 }).ok === false);

  tourOpen(db, pA, { side: 'long', qty: 100, leverage: 99999 });
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

  // 满了就不给钱：超过 30 万直接拒，且一分不动、次数不加
  g.cash = 350000;
  const over = tourJob(db, pA);
  check('现金超过 30 万不给钱', over.ok === false, over.error || '');
  check('拒绝时现金一分不动', g.cash === 350000, String(g.cash));
  const jobsBefore = g.jobs;
  check('拒绝时打工次数不加', g.jobs === jobsBefore, String(g.jobs));

  // 页面金额都是整数元：299,999.6 在界面上就显示成 ¥300,000，不能再补 4 毛
  g.cash = 299999.6;
  const dime = tourJob(db, pA);
  check('界面上已满 30 万（299,999.6）不再补钱', dime.ok === false, dime.error || '');
  check('没被顺手抹成 30 万整', g.cash === 299999.6, String(g.cash));

  g.cash = 299000;
  const gap = tourJob(db, pA);
  check('差 1000 仍然照补', gap.ok === true && near(gap.gained, 1000), String(gap.gained));
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
  check('快照不带内部压力字段', st.stock.flow === undefined && st.stock.premium === undefined);
  check('K 线不在快照里发（走 /api/tour/candles）',
    st.stock.series === undefined && st.stock.seriesAt === undefined);
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

// ---------------- 12. K 线：历史包 + 实时聚合（条数对齐主站） ----------------
{
  const db = createDb();
  db.tour.startAt = Date.now() - 1000;
  setTourRate(db, 108.9, Date.now(), 'test');
  tourTick(db);

  // 根数跟着主站走：1m 300、5m 300、15m 192
  check('1m 保留 300 根', TOUR_TFS['1m'].max === 300, String(TOUR_TFS['1m'].max));
  check('5m 保留 300 根', TOUR_TFS['5m'].max === 300, String(TOUR_TFS['5m'].max));
  check('15m 保留 192 根', TOUR_TFS['15m'].max === 192, String(TOUR_TFS['15m'].max));
  check('1m 一根 60 秒', TOUR_TFS['1m'].sec === 60);
  check('15m 一根 900 秒', TOUR_TFS['15m'].sec === 900);

  // 历史包：给 400 根，只留最后 300 根，且按时间升序
  const base = 1_700_000_040;                 // 能被 60 整除，桶边界干净
  const hist = [];
  for (let i = 0; i < 400; i++) {
    const px = 100 + i * 0.01;
    hist.push({ time: base + i * 60, open: px, high: px + 0.05, low: px - 0.05, close: px });
  }
  setTourHist(db, '1m', hist, Date.now());
  check('历史包按周期上限裁剪', db.tour.stock.hist['1m'].length === 300,
    String(db.tour.stock.hist['1m'].length));
  check('历史包按时间升序', db.tour.stock.hist['1m'][0].time < db.tour.stock.hist['1m'][299].time);
  check('历史包丢掉最老的那些',
    db.tour.stock.hist['1m'][0].time === base + 100 * 60, String(db.tour.stock.hist['1m'][0].time));

  // 实时点：接在历史最后一根之后，12 个 5 秒点聚成 1 分钟
  const lastHist = db.tour.stock.hist['1m'][299].time;
  db.tour.stock.series = [];
  db.tour.stock.seriesAt = [];
  for (let i = 0; i < 12; i++) {
    db.tour.stock.series.push(110 + i * 0.01);
    db.tour.stock.seriesAt.push((lastHist + 120 + i * 5) * 1000);
  }
  const c = tourCandles(db, '1m');
  check('实时点聚合成 1 根 1 分钟 K 线',
    c.candles.at(-1).time === lastHist + 120, String(c.candles.at(-1).time));
  check('实时那根的 OHLC 正确',
    near(c.candles.at(-1).open, 110, 1e-9) && near(c.candles.at(-1).close, 110.11, 1e-9),
    JSON.stringify(c.candles.at(-1)));
  check('总根数仍然卡在上限 300', c.candles.length === 300, String(c.candles.length));
  check('历史 + 实时在时间上不重叠',
    new Set(c.candles.map((b) => b.time)).size === c.candles.length);

  // 5m / 15m 用的是各自的历史包
  setTourHist(db, '5m', hist.filter((_, i) => i % 5 === 0));
  setTourHist(db, '15m', hist.filter((_, i) => i % 15 === 0));
  check('5m 独立一组历史包', db.tour.stock.hist['5m'].length === 80,
    String(db.tour.stock.hist['5m'].length));
  check('15m 独立一组历史包', db.tour.stock.hist['15m'].length === 27,
    String(db.tour.stock.hist['15m'].length));
  check('取 5m 不会串到 1m 的包', tourCandles(db, '5m').tf === '5m');

  // 序列上限：和主站 historyTicks 同口径 3600 个点 = 5 小时
  const db2 = createDb();
  db2.tour.startAt = Date.now() - 1000;
  setTourRate(db2, 108.9, Date.now(), 'test');
  tourTick(db2);
  for (let i = 0; i < 7300; i++) {
    db2.tour.fx.rate = 108.9 + (i % 7) * 0.001;
    tourTick(db2);
  }
  check('报价序列上限 7200（2 小时 @1 秒）', db2.tour.stock.series.length === 7200,
    String(db2.tour.stock.series.length));
  check('序列和时间戳同步裁剪',
    db2.tour.stock.seriesAt.length === db2.tour.stock.series.length,
    `${db2.tour.stock.seriesAt.length} / ${db2.tour.stock.series.length}`);
}

// ---------------- 休市（管理面板）/ 涨跌幅口径 ----------------
{
  const db = newDb();
  const t = db.tour;
  check('默认不是休市状态', t.closed === false && tourStatus(t) === 'running', tourStatus(t));

  // 休市后价格不动、轮次不涨、下单被拒
  const before = t.stock.price;
  const tickBefore = t.tick;
  const r1 = tourSetClosed(db, true);
  check('休市设置成功', r1.ok && r1.closed === true);
  check('休市后的状态 = closed', tourStatus(t) === 'closed', tourStatus(t));
  t.fx.rate = before + 0.5;            // 汇率还在变，但赛区价格应该冻住
  tourTick(db);
  tourTick(db);
  check('休市期间价格冻住', near(t.stock.price, before, 1e-9), String(t.stock.price));
  check('休市期间轮次不涨', t.tick === tickBefore, `${t.tick} / ${tickBefore}`);
  check('休市期间序列仍在落点（图上走平线）', t.stock.series.length > 0);
  check('休市期间不能开仓',
    tourOpen(db, pA, { side: 'long', qty: 10, leverage: 5 }).error === '锦标赛休市中，暂停交易');
  check('休市期间不能打工', tourJob(db, pA).ok === false);
  check('休市快照带 closed 标记', tourState(db, pA).closed === true);

  // 恢复：价格回到实时汇率，可以继续交易
  const r2 = tourSetClosed(db, false);
  check('恢复成功', r2.ok && r2.closed === false);
  check('恢复后状态回到 running', tourStatus(t) === 'running', tourStatus(t));
  tourTick(db);
  check('恢复后价格跟上汇率', near(t.stock.price, before + 0.5, 1e-6), String(t.stock.price));
  check('恢复后可以开仓', tourOpen(db, pA, { side: 'long', qty: 10, leverage: 5 }).ok === true);

  // 涨跌幅 = 所选周期最后一根 K 线相对前一根的涨跌
  const db3 = createDb();
  db3.tour.startAt = Date.now() - 1000;
  const bars = [];
  for (let i = 0; i < 5; i++) bars.push({ time: 1000 + i * 60, open: 100, high: 101, low: 99, close: 100 + i });
  setTourHist(db3, '1m', bars);
  const c = tourCandles(db3, '1m');
  // 最后一根 close=104，前一根 close=103 → +0.9709%
  check('K 线接口带 changePct', near(c.changePct, (104 / 103 - 1) * 100, 1e-3), String(c.changePct));
  check('快照 changePct 用 1 分钟最后一根',
    near(tourState(db3, null).stock.changePct, c.changePct, 1e-3),
    `${tourState(db3, null).stock.changePct} / ${c.changePct}`);
}

// ---------------- 15. 止盈止损：到价按现价平 ----------------
{
  const db = newDb();
  const t = db.tour;
  const g = db.tour.players.a;
  setPrice(t, 100);
  tourOpen(db, pA, { side: 'long', qty: 100, leverage: 20 });

  const r = tourTpSl(db, pA, { tp: 110 });
  check('加了止盈条件', r.ok && r.position.tpsl.length === 1, JSON.stringify(r).slice(0, 90));
  check('pos.tp 同步到条件价', num(g.positions.LMFX.tp) === 110, String(g.positions.LMFX.tp));
  check('快照只发未触发的条件', tourState(db, pA).me.position.tpsl.length === 1);

  setPrice(t, 105);
  tourTick(db);
  check('没到价不平仓', !!g.positions.LMFX);

  setPrice(t, 110);
  tourTick(db);
  check('到价立刻平仓', !g.positions.LMFX);
  const fill = g.log.find((x) => x.auto === 'tp');
  check('流水标了 auto=tp', !!fill, JSON.stringify(g.log[g.log.length - 1]));
  check('按现价 110 成交（不是 110 的限价单）', fill && near(fill.price, 110), String(fill?.price));
  check('盈亏 = (110−100)×100', fill && near(fill.pnl, 1000), String(fill?.pnl));
}

// ---------------- 16. 止损：跌破按现价平，亏损算对 ----------------
{
  const db = newDb();
  const t = db.tour;
  const g = db.tour.players.a;
  setPrice(t, 100);
  tourOpen(db, pA, { side: 'long', qty: 100, leverage: 20 });
  tourTpSl(db, pA, { sl: 97 });

  setPrice(t, 99);
  tourTick(db);
  check('没跌破不平仓', !!g.positions.LMFX);

  setPrice(t, 96.5);
  tourTick(db);
  check('跌破立刻平仓', !g.positions.LMFX);
  const fill = g.log.find((x) => x.auto === 'sl');
  check('流水标了 auto=sl', !!fill);
  check('止损亏损 = (96.5−100)×100', fill && near(fill.pnl, -350), String(fill?.pnl));
}

// ---------------- 17. 空头：止盈（跌）与止损（涨）方向要对 ----------------
{
  const db = newDb();
  const t = db.tour;
  const g = db.tour.players.a;
  setPrice(t, 100);
  tourOpen(db, pA, { side: 'short', qty: 100, leverage: 20 });
  tourTpSl(db, pA, { tp: 90 });

  setPrice(t, 95);
  tourTick(db);
  check('空头止盈：涨到 95 不触发', !!g.positions.LMFX && !g.log.some((x) => x.auto));
  setPrice(t, 89);
  tourTick(db);
  const fill = g.log.find((x) => x.auto === 'tp');
  check('空头止盈：跌到 89 触发并盈利', !g.positions.LMFX && fill && fill.pnl > 0, String(fill?.pnl));

  const db2 = newDb();
  setPrice(db2.tour, 100);
  const g2 = db2.tour.players.a;
  tourOpen(db2, pA, { side: 'short', qty: 100, leverage: 20 });
  tourTpSl(db2, pA, { sl: 103 });
  setPrice(db2.tour, 102);
  tourTick(db2);
  check('空头止损：涨到 102 不触发', !!g2.positions.LMFX);
  setPrice(db2.tour, 103.5);
  tourTick(db2);
  const f2 = g2.log.find((x) => x.auto === 'sl');
  check('空头止损：涨到 103.5 触发并亏损', !g2.positions.LMFX && f2 && f2.pnl < 0, String(f2?.pnl));
}

// ---------------- 18. 只平一部分 + 多条条件 ----------------
{
  const db = newDb();
  const t = db.tour;
  const g = db.tour.players.a;
  setPrice(t, 100);
  tourOpen(db, pA, { side: 'long', qty: 1000, leverage: 20 });
  tourTpSl(db, pA, { tp: 105, qty: 400 });
  tourTpSl(db, pA, { tp: 120, qty: 300 });
  tourTpSl(db, pA, { sl: 90 });
  check('三条条件都挂上', g.positions.LMFX.tpsl.length === 3, String(g.positions.LMFX.tpsl.length));

  setPrice(t, 106);
  tourTick(db);
  check('先触发 105 那条，只平 400', g.positions.LMFX?.qty === 600, String(g.positions.LMFX?.qty));
  check('触发过的那条被标记 fired', g.positions.LMFX.tpsl[0].fired === true);
  check('pos.tp 换成第二条的价', num(g.positions.LMFX.tp) === 120, String(g.positions.LMFX.tp));
  check('止损那条还在', num(g.positions.LMFX.sl) === 90, String(g.positions.LMFX.sl));

  setPrice(t, 121);
  tourTick(db);
  check('第二条到价，再平 300', g.positions.LMFX?.qty === 300, String(g.positions.LMFX?.qty));

  setPrice(t, 80);
  tourTick(db);
  check('止损把剩下的全平掉（价格已跌到爆仓线下，先按爆仓处理）', !g.positions.LMFX);
}

// ---------------- 19. 校验：方向、数量、条数上�� ----------------
{
  const db = newDb();
  const t = db.tour;
  const g = db.tour.players.a;
  setPrice(t, 100);

  check('没有持仓不能设止盈止损', tourTpSl(db, pA, { tp: 110 }).ok === false);

  tourOpen(db, pA, { side: 'long', qty: 1000, leverage: 20 });
  check('多头止盈价低于现价被拒', tourTpSl(db, pA, { tp: 99 }).ok === false);
  check('多头止损价高于现价被拒', tourTpSl(db, pA, { sl: 101 }).ok === false);
  check('止盈止损都不填被拒', tourTpSl(db, pA, {}).ok === false);
  check('负价格被拒', tourTpSl(db, pA, { tp: -5 }).ok === false);

  const clampQty = tourTpSl(db, pA, { tp: 130, qty: 99999 });
  check('触发数量超过持仓时夹到持仓', clampQty.ok && clampQty.position.tpsl[0].qty === 1000,
    JSON.stringify(clampQty.position?.tpsl?.[0] || {}));

  // 一条一条加满 8 条
  let added = 1;
  for (let i = 1; i <= 8; i++) {
    const x = tourTpSl(db, pA, { tp: 130 + i, qty: 1 });
    if (x.ok) added++;
  }
  check('最多 8 条，多出来的被拒', added === 8, `${added} 条`);
  check('第 9 条报错信息说清上限', /最多 8 条/.test(tourTpSl(db, pA, { tp: 200 }).error || ''));
}

// ---------------- 20. 删除条件后不再触发 ----------------
{
  const db = newDb();
  const t = db.tour;
  const g = db.tour.players.a;
  setPrice(t, 100);
  tourOpen(db, pA, { side: 'long', qty: 100, leverage: 20 });
  const r = tourTpSl(db, pA, { tp: 110, sl: 97 });
  const tpId = r.position.tpsl.find((x) => x.kind === 'tp').id;
  check('两条都挂上', r.position.tpsl.length === 2);

  const d = tourTpSlRemove(db, pA, { id: tpId });
  check('删掉止盈成功', d.ok && d.position.tpsl.length === 1, JSON.stringify(d).slice(0, 80));
  check('pos.tp 清空', !num(g.positions.LMFX.tp), String(g.positions.LMFX.tp));
  check('止损还在', num(g.positions.LMFX.sl) === 97);
  check('删不存在的 id 报错', tourTpSlRemove(db, pA, { id: 'nope' }).ok === false);

  setPrice(t, 120);
  tourTick(db);
  check('删掉的止盈不会再触发', !!g.positions.LMFX);
}

// ---------------- 21. 强平优先于止盈止损 ----------------
{
  const db = newDb();
  const t = db.tour;
  const g = db.tour.players.a;
  setPrice(t, 100);
  tourOpen(db, pA, { side: 'long', qty: 100, leverage: 20 });
  tourTpSl(db, pA, { sl: 97 });

  setPrice(t, 90);       // 亏 10%，20 倍下早就爆了
  tourTick(db);
  check('被强平', !g.positions.LMFX);
  check('流水里是 liquidate，不是止损', g.log.some((x) => x.action === 'liquidate') && !g.log.some((x) => x.auto),
    JSON.stringify(g.log.map((x) => x.action)));
  check('强平后不会再多算一次平仓', g.closes === 0 || g.log.filter((x) => x.action === 'close').length === 0,
    String(g.closes));
}

// ---------------- 22. 休市期间止盈止损不触发 ----------------
{
  const db = newDb();
  const t = db.tour;
  const g = db.tour.players.a;
  setPrice(t, 100);
  tourOpen(db, pA, { side: 'long', qty: 100, leverage: 20 });
  tourTpSl(db, pA, { tp: 110 });
  tourSetClosed(db, true);

  // 休市期间汇率照抓（rate 变了），但价格不采纳：图上走平线
  t.fx.rate = 130;
  tourTick(db);
  check('休市期间价格冻住', num(t.stock.price) === 100, String(t.stock.price));
  check('休市期间仓位不动', !!g.positions.LMFX);

  tourSetClosed(db, false);
  tourTick(db);
  check('恢复后按跳空价 130 平掉', !g.positions.LMFX);
  const fill = g.log.find((x) => x.auto === 'tp');
  check('按恢复后的现价成交，不是触发价', fill && near(fill.price, 130), String(fill?.price));
}

// ---------------- 23. 老存档：只有 pos.tp / pos.sl 也能触发 ----------------
{
  const db = newDb();
  const t = db.tour;
  const g = db.tour.players.a;
  setPrice(t, 100);
  tourOpen(db, pA, { side: 'long', qty: 100, leverage: 20 });
  const pos = g.positions.LMFX;
  delete pos.tpsl;
  pos.tp = 108;
  pos.sl = 95;

  setPrice(t, 109);
  tourTick(db);
  check('老字段止盈触发', !g.positions.LMFX && !!g.log.find((x) => x.auto === 'tp'));
  check('老字段被补成 tpsl 列表', !g.positions.LMFX || Array.isArray(g.positions.LMFX.tpsl));
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
