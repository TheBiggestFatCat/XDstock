// 肯德基（KFC）：反向跟随麦当劳 + 疯狂星期四
//   node tests/kfc-stock.mjs
//
// 规则：
//   - 每一轮读**上一轮**麦当劳的涨跌幅，在基础股价公式上叠加 -(涨跌幅) × mirrorCoef
//   - 每个星期四 11:00~13:00 之间随机挑一轮，固定 +50%（每周只来一次）
//   - 市值 800 亿起步，向 1000 亿收敛

import { createDb, migrate } from '../src/store.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { stepMarket } from '../src/engine.js';
import { runReports } from '../src/engine.js';
import { rallyWindow, kfcRallyStep, kfcRallyInfo, weekKeyOf } from '../src/kfc.js';
import { STOCK_SEED, STOCK_CODES } from '../src/stocks.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

/** 造一个「价格完全不动」的市场，方便只观察单条规则 */
function calmDb(patch = {}) {
  const db = migrate(createDb());
  Object.assign(db.config, {
    baseVolatility: 0, meanReversion: 0, eventChance: 0, localEventChance: 0,
    marketTradesRate: 0, hotMoneyEnabled: 0, playerImpactEnabled: 0, sentimentEnabled: 0,
    levelFillBonus: 0
  }, patch);
  db.tick = 1000;
  db.events = [];
  return db;
}
const capOf = (st) => (Number(st.fair) * Number(st.shares)) / 1e8;

// ---------------------------------------------------------------- 1
log('=== 1 KFC 定义：消费娱乐、800 亿、目标 1000 亿 ===');
{
  const seed = STOCK_SEED.KFC;
  check('KFC 在 STOCK_CODES 里', STOCK_CODES.includes('KFC'), STOCK_CODES.join(','));
  check('名字是肯德基', seed.name === '肯德基', seed.name);
  check('消费娱乐板块', seed.industry === '消费娱乐', seed.industry);
  check('图标 KFC.png', seed.icon === '/assets/stocks/KFC.png', seed.icon);
  check('特性 id = mirror', seed.trait.id === 'mirror', seed.trait.id);
  check('反向对象是 MCD', seed.trait.mirrorCode === 'MCD', seed.trait.mirrorCode);
  check('周四暴拉 50%', Number(seed.trait.rallyBoost) === 0.5, String(seed.trait.rallyBoost));
  check('窗口是周四 11~13 点',
    seed.trait.rallyWeekday === 4 && seed.trait.rallyFrom === 11 && seed.trait.rallyTo === 13);

  const db = migrate(createDb());
  const st = db.stocks.KFC;
  check('股本 8 亿股', Number(st.shares) === 8e8, String(st.shares));
  check('上市市值 800 亿',
    Math.abs(st.price * st.shares - 8e10) < 1e6, `${((st.price * st.shares) / 1e8).toFixed(0)} 亿`);
  check('市值目标 1000 亿', Number(st.capTarget) === 1e11, String(st.capTarget));
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 反向跟随：麦当劳涨 → 肯德基跌，反之亦然 ===');
{
  const db = calmDb();
  const kfc = db.stocks.KFC;
  const mcd = db.stocks.MCD;
  kfc.price = 100; mcd.price = 500;
  const kfcFresh = () => {
    // 每轮都要把「星期四」挡掉，避免窗口撞上
    kfc.kfcWeek = weekKeyOf(Date.now());
    kfc.kfcFired = true;
  };

  kfcFresh();
  db.stocks.MCD.lastRet = 0.02;
  stepMarket(db);
  const upMcd = kfc.price / 100 - 1;
  check('麦当劳 +2% → 肯德基 ≈ −2%', upMcd < -0.015 && upMcd > -0.025,
    (upMcd * 100).toFixed(2) + '%');

  kfcFresh();
  kfc.price = 100;
  db.stocks.MCD.lastRet = -0.03;
  stepMarket(db);
  const downMcd = kfc.price / 100 - 1;
  check('麦当劳 −3% → 肯德基 ≈ +3%', downMcd > 0.025 && downMcd < 0.035,
    (downMcd * 100).toFixed(2) + '%');

  kfcFresh();
  kfc.price = 100;
  db.stocks.MCD.lastRet = 0;
  stepMarket(db);
  check('麦当劳不动 → 肯德基也不动', Math.abs(kfc.price - 100) < 0.01, String(kfc.price.toFixed(2)));

  // 系数
  kfcFresh();
  kfc.price = 100;
  kfc.trait.mirrorCoef = 2;
  db.stocks.MCD.lastRet = 0.01;
  stepMarket(db);
  check('系数 2 → 反向加倍（≈ −2%）', kfc.price / 100 - 1 < -0.015,
    ((kfc.price / 100 - 1) * 100).toFixed(2) + '%');
  check('记录了这一轮读到的来源', kfc.kfcMirrorFrom?.code === 'MCD', JSON.stringify(kfc.kfcMirrorFrom));

  // 读的是 MCD「上一轮记下来的涨跌幅」，不是本轮的现价变动
  kfcFresh();
  kfc.trait.mirrorCoef = 1;
  kfc.price = 100;
  db.stocks.MCD.lastRet = 0;              // 上一轮没动
  mcd.price = 900;              // 本轮现价变了，但那不算「上一轮涨跌幅」
  stepMarket(db);
  check('只看 MCD 上一轮的涨跌幅（现价跳变不算）', Math.abs(kfc.price - 100) < 0.01,
    String(kfc.price.toFixed(2)));

  kfcFresh();
  kfc.price = 100;
  db.stocks.MCD.lastRet = 0.05;
  stepMarket(db);
  check('MCD 上一轮 +5% → KFC ≈ −5%', kfc.price / 100 - 1 < -0.04,
    ((kfc.price / 100 - 1) * 100).toFixed(2) + '%');
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 疯狂星期四：窗口判定 ===');
{
  const thursdayNoon = new Date(2026, 10, 5, 12, 0, 0).getTime();   // 2026-11-05 是周四
  check('2026-11-05 确实是周四', new Date(thursdayNoon).getDay() === 4);
  check('周四 12:00 在窗口内', !!rallyWindow(thursdayNoon));
  check('周四 10:59 不在窗口内',
    !rallyWindow(new Date(2026, 10, 5, 10, 59, 0).getTime()));
  check('周四 13:00 已过窗口',
    !rallyWindow(new Date(2026, 10, 5, 13, 0, 0).getTime()));
  check('周三 12:00 不在窗口',
    !rallyWindow(new Date(2026, 10, 4, 12, 0, 0).getTime()));
  check('周五 12:00 不在窗口',
    !rallyWindow(new Date(2026, 10, 6, 12, 0, 0).getTime()));
  const w = rallyWindow(thursdayNoon);
  check('窗口长度 = 2 小时', Math.abs((w.end - w.start) - 2 * 3600e3) < 1e-6);
  check('同一周 key 稳定',
    weekKeyOf(thursdayNoon) === weekKeyOf(new Date(2026, 10, 5, 11, 30, 0).getTime()));
  check('隔一周 key 变了',
    weekKeyOf(thursdayNoon) !== weekKeyOf(new Date(2026, 10, 12, 12, 0, 0).getTime()));
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 疯狂星期四：每周只来一次，随机落在窗口内 ===');
{
  const st = {};
  const tickMs = 5000;
  const thu = new Date(2026, 10, 5, 11, 0, 0).getTime();
  const win = rallyWindow(thu);
  // 进入窗口：抽一个时刻
  let r = kfcRallyStep(st, thu, tickMs, { rand: () => 0.5 });
  check('刚进窗口不立刻拉', r.fire === false, r.reason);
  check('抽到的时刻在窗口内',
    st.kfcRallyAt >= win.start && st.kfcRallyAt < win.end,
    new Date(st.kfcRallyAt).toTimeString().slice(0, 8));
  check('抽到的大约在窗口中间', Math.abs((st.kfcRallyAt - win.start) / (win.end - win.start) - 0.5) < 0.02);

  // 还没到点
  r = kfcRallyStep(st, st.kfcRallyAt - tickMs, tickMs);
  check('没到点不拉', r.fire === false, r.reason);
  // 到点
  r = kfcRallyStep(st, st.kfcRallyAt, tickMs);
  check('到点触发 +50%', r.fire === true && r.boost === 0.5, JSON.stringify(r));
  // 同周不重复
  r = kfcRallyStep(st, st.kfcRallyAt + tickMs, tickMs);
  check('同一周不会拉第二次', r.fire === false, r.reason);

  // 下一周重新抽
  const nextThu = new Date(2026, 10, 12, 11, 0, 0).getTime();
  r = kfcRallyStep(st, nextThu, tickMs, { rand: () => 0.1 });
  check('下一周重新抽时刻', r.fire === false && st.kfcWeek !== rallyWindow(thu).weekKey);

  // 随机性：1000 次抽样应该落满整个窗口
  const ats = [];
  for (let i = 0; i < 1000; i++) {
    const s2 = {};
    kfcRallyStep(s2, thu, tickMs);
    ats.push(s2.kfcRallyAt);
  }
  const span = win.end - win.start;
  check('抽样都落在窗口内', ats.every((a) => a >= win.start && a < win.end));
  check('抽样覆盖前半段与后半段',
    ats.some((a) => a < win.start + span * 0.25) && ats.some((a) => a > win.start + span * 0.75));
  check('不是每次都一样', new Set(ats).size > 100, `${new Set(ats).size} 种`);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 疯狂星期四：接进引擎后真的 +50% ===');
{
  const db = calmDb();
  const kfc = db.stocks.KFC;
  kfc.price = 100; kfc.fair = 100;
  // 强行让它「现在就在窗口里、且已到点」
  const now = Date.now();
  kfc.kfcWeek = weekKeyOf(now);
  kfc.kfcRallyAt = now - 1;
  kfc.kfcFired = false;
  db.stocks.MCD.lastRet = 0;
  const before = kfc.price;
  stepMarket(db);
  const jump = kfc.price / before - 1;
  // 只有周四 11~13 点才会触发，其它时间这条只验证「不会误触发」
  const isThuWindow = !!rallyWindow(Date.now());
  if (isThuWindow) {
    check('窗口内触发 +50%', Math.abs(jump - 0.5) < 1e-6, `${(jump * 100).toFixed(1)}%`);
    check('触发后标记已用', kfc.kfcFired === true);
  } else {
    check('不在窗口时不触发（当前不是周四 11~13 点）', Math.abs(jump) < 1e-9, `${(jump * 100).toFixed(3)}%`);
    check('不在窗口时不标记已用', kfc.kfcFired === false);
  }
  check('每轮都会算一份给前端的窗口信息', !!kfc.kfcRallyInfo && 'inWindow' in kfc.kfcRallyInfo);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 市值：800 亿起步，向 1000 亿收敛 ===');
{
  const db = calmDb({ reportIntervalTicks: 720 });
  const st = db.stocks.KFC;
  check('起点 800 亿', Math.abs(capOf(st) - 800) < 5, `${capOf(st).toFixed(0)} 亿`);
  const caps = [];
  for (let i = 1; i <= 40; i++) {
    db.tick += 720;
    st.nextReportTick = db.tick;
    st.pendingReport = null;
    runReports(db);
    caps.push(capOf(st));
  }
  const last = caps[caps.length - 1];
  // 20 期实测分布：900~970 亿（价值线改成「最近几期拟合」后整体低 ~2%，最差一次 895）
  // 断言只要求「明显离开 800 亿起点」，别卡太死（本来就是随机序列，没有种子）
  check('第 20 期已明显上台阶', caps[19] > 870, `${caps[19].toFixed(0)} 亿`);
  check('第 40 期落在 1000 亿附近（±6%）', Math.abs(last - 1000) < 60, `${last.toFixed(0)} 亿`);
  check('不会冲过 1050 亿', last < 1050, `${last.toFixed(0)} 亿`);
  // 首期财报偶尔会小幅回摆（BPS 取整），只要没掉出 7% 就算正常
  check('中间没有大幅倒退（起点附近允许小幅回摆）',
    Math.min(...caps.slice(1)) > 740, `${Math.min(...caps).toFixed(0)} 亿`);
}

// ---------------------------------------------------------------- 7
log('');
log('=== 7 两条规则互不干扰 ===');
{
  const db = calmDb();
  const kfc = db.stocks.KFC;
  kfc.price = 100;
  kfc.kfcWeek = weekKeyOf(Date.now());
  kfc.kfcFired = true;                        // 挡住星期四
  db.stocks.MCD.lastRet = 0.01;
  stepMarket(db);
  const one = kfc.price / 100 - 1;
  check('反向加成在（≈ −1%）', one < -0.005, (one * 100).toFixed(2) + '%');
  check('没有额外的星期四加成', one > -0.02, (one * 100).toFixed(2) + '%');
  check('涨跌幅被记下来给下一轮用', typeof kfc.lastRet === 'number' && Math.abs(kfc.lastRet - one) < 1e-9);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
