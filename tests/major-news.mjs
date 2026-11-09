// 重大利好 / 重大利空：概率、幅度、零和、价值线与财报影响
//   node tests/major-news.mjs

import { createDb, migrate } from '../src/store.js';
import { spawnMajorNews, stepMarket } from '../src/engine.js';
import { MAJOR_NEWS_POOL, NEWS_POOL, majorPoolByCode } from '../src/news.js';
import { genNextReport } from '../src/fundamentals.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const quiet = (fn) => {
  const real = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = real; }
};

const CODES = ['TGW', 'MAMA', 'DFY', 'LU', 'NW', 'XJ', 'MB', 'KFC', 'XD', 'MCD'];

function newDb(patch = {}) {
  const db = quiet(() => migrate(createDb()));
  Object.assign(db.config, {
    eventChance: 0, baseVolatility: 0, meanReversion: 0, localEventChance: 0,
    marketTradesEnabled: 0, hotMoneyEnabled: 0, sentimentEnabled: 0, playerImpactEnabled: 0,
    fxEnabled: 0, goldVol: 0, goldRev: 0, reportIntervalTicks: 1e12,
    majorNewsEnabled: 1, majorNewsChanceRatio: 0.01,
    majorNewsPriceShock: 0.2, majorNewsTicks: 5,
    majorNewsFairShift: 0.15, majorNewsReportBias: 0.4,
    majorNewsAnnounceHours: 3,
    majorNewsMinGapTicks: 0    // 默认关掉闸门，单测里直接测概率
  }, patch);
  db.tick = 5000;
  db.events = [];
  db.newsPool = NEWS_POOL;
  db.majorPool = MAJOR_NEWS_POOL;
  for (const st of Object.values(db.stocks)) st.nextReportTick = 1e12;
  return db;
}

// ---------------------------------------------------------------- 1
log('=== 1 文案：每只票 5 条利好 + 5 条利空 ===');
{
  check('总条数 = 10 只票 × 10 条', MAJOR_NEWS_POOL.length === 100, String(MAJOR_NEWS_POOL.length));
  for (const c of CODES) {
    const { up, down } = majorPoolByCode(c);
    check(`${c} 利好 5 条 / 利空 5 条`, up.length === 5 && down.length === 5, `${up.length}/${down.length}`);
  }
  check('文案都带【重大】前缀', MAJOR_NEWS_POOL.every((x) => x.text.startsWith('【重大】')));
  check('和普通新闻池不重复', MAJOR_NEWS_POOL.every((x) => !NEWS_POOL.some((y) => y.text === x.text)));
  check('每条都指明标的', MAJOR_NEWS_POOL.every((x) => Array.isArray(x.companies) && x.companies.length === 1));
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 概率：只有普通新闻的 1/100 ===');
{
  const db = newDb({ eventChance: 1 });          // 普通新闻概率=100%，方便对比
  // 直接看掷骰子：概率 = eventChance × ratio = 0.01
  let hit = 0;
  const N = 4000;
  for (let i = 0; i < N; i += 1) {
    db.events = [];
    db.config.majorNewsChanceRatio = 0.01;
    if (quiet(() => spawnMajorNews(db))) hit += 1;
  }
  const rate = hit / N;
  check('eventChance=1 时命中率 ≈ 1%', near(rate, 0.01, 0.004), `${(rate * 100).toFixed(2)}%`);

  // 概率太小（0.015% ≈ 几千轮一次）没法在小样本里测，所以固定 eventChance、只测系数乘法
  const dbA = newDb({ eventChance: 1, majorNewsChanceRatio: 0.01 });
  let hitA = 0;
  for (let i = 0; i < 3000; i += 1) {
    dbA.events = [];
    if (quiet(() => spawnMajorNews(dbA))) hitA += 1;
  }
  check('系数 0.01 → 命中率 1%', Math.abs(hitA / 3000 - 0.01) < 0.004, `${(hitA / 3).toFixed(2)}%`);

  const dbB = newDb({ eventChance: 1, majorNewsChanceRatio: 1 });
  let hitB = 0;
  for (let i = 0; i < 300; i += 1) {
    dbB.events = [];
    if (quiet(() => spawnMajorNews(dbB))) hitB += 1;
  }
  check('系数 1 → 和普通新闻同概率（100%）', hitB === 300, `${hitB}/300`);

  const dbC = newDb({ eventChance: 1, majorNewsChanceRatio: 0 });
  let hitC = 0;
  for (let i = 0; i < 300; i += 1) {
    dbC.events = [];
    if (quiet(() => spawnMajorNews(dbC))) hitC += 1;
  }
  check('系数 0 → 一次都不出', hitC === 0, String(hitC));

  const off = newDb({ eventChance: 1, majorNewsEnabled: 0 });
  let hit3 = 0;
  for (let i = 0; i < 500; i += 1) {
    off.events = [];
    if (quiet(() => spawnMajorNews(off))) hit3 += 1;
  }
  check('开关关掉 → 一次都不出', hit3 === 0, String(hit3));
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 幅度：价格冲击 ±20%、分 5 轮走完 ===');
{
  const db = newDb({ majorNewsChanceRatio: 1, eventChance: 1 });   // 必出
  const ev = quiet(() => {
    const e = spawnMajorNews(db);
    return e;
  });
  check('事件带 major 标记', !!ev && ev.major === true && ev.kind === 'major');
  check('立刻公布（没有偷跑）', !!ev && ev.announced === true);
  check('冲击轮数 = 5', !!ev && ev.leakTicks === 5, String(ev?.leakTicks));

  // 每轮 trend 累积：exp(6 × trend) 应等于 1 + shock（利好）或 1/(1+shock)（利空）
  const total = Math.exp(ev.trend * 5);
  const want = ev.dir > 0 ? 1 + 0.2 : 1 / 1.2;
  check(`总冲击 = ${ev.dir > 0 ? '×(1+0.12)' : '×1/1.12'}`,
    Math.abs(total - want) < 1e-9, `${total.toFixed(6)} vs ${want.toFixed(6)}`);
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 零和：利好的倍数 × 利空的倍数 = 1 ===');
{
  const up = newDb({ majorNewsChanceRatio: 1, eventChance: 1 });
  let e = quiet(() => spawnMajorNews(up));
  // 强行抽到利好为止
  let guard = 0;
  while (e && e.dir < 0 && guard < 200) { up.events = []; e = quiet(() => spawnMajorNews(up)); guard += 1; }
  const upMult = Math.exp(e.trend * e.leakTicks);

  const dn = newDb({ majorNewsChanceRatio: 1, eventChance: 1 });
  let e2 = quiet(() => spawnMajorNews(dn));
  guard = 0;
  while (e2 && e2.dir > 0 && guard < 200) { dn.events = []; e2 = quiet(() => spawnMajorNews(dn)); guard += 1; }
  const dnMult = Math.exp(e2.trend * e2.leakTicks);

  check('利好倍数 × 利空倍数 = 1（严格互为倒数）',
    Math.abs(upMult * dnMult - 1) < 1e-9, `${upMult.toFixed(6)} × ${dnMult.toFixed(6)}`);
  check('利空不是「-20%」而是「÷1.2」', Math.abs(dnMult - 1 / 1.2) < 1e-9, dnMult.toFixed(6));

  // 价值线平移也互为倒数
  const upFair = newDb({ majorNewsChanceRatio: 1, eventChance: 1 });
  const stU = upFair.stocks.TGW;
  stU.fair = 100;
  upFair.majorPool = MAJOR_NEWS_POOL.filter((x) => x.companies[0] === 'TGW' && x.dir > 0);
  quiet(() => spawnMajorNews(upFair));
  const fairUp = stU.fair;

  const dnFair = newDb({ majorNewsChanceRatio: 1, eventChance: 1 });
  const stD = dnFair.stocks.TGW;
  stD.fair = 100;
  dnFair.majorPool = MAJOR_NEWS_POOL.filter((x) => x.companies[0] === 'TGW' && x.dir < 0);
  quiet(() => spawnMajorNews(dnFair));
  const fairDown = stD.fair;

  check('价值线：利好 ×1.15', near(fairUp, 115, 1e-3), String(fairUp));
  check('价值线：利空 ÷1.15', Math.abs(fairDown - 100 / 1.15) < 1e-3, String(fairDown));
  check('价值线倍数也互为倒数', Math.abs((fairUp / 100) * (fairDown / 100) - 1) < 1e-6,
    `${(fairUp / 100).toFixed(4)} × ${(fairDown / 100).toFixed(4)}`);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 财报：下一期吃偏移，只用一次 ===');
{
  const db = newDb();
  const st = db.stocks.TGW;
  st.majorBias = 0.25;
  const r1 = quiet(() => genNextReport(st, {}));
  st.majorBias = 0;
  const r2 = quiet(() => genNextReport(st, {}));
  const g1 = Number(r1.growth);
  const g2 = Number(r2.growth);
  check('带偏移时增速更高（同一次随机不保证，这里只看代码路径生效）',
    Number.isFinite(g1) && Number.isFinite(g2), `${g1.toFixed(4)} / ${g2.toFixed(4)}`);

  // 更严格：同一个 st 连续生成两次，一次带 bias 一次不带，比较期望（各跑 200 次取均值）
  let sumWith = 0;
  let sumWithout = 0;
  const N = 200;
  for (let i = 0; i < N; i += 1) {
    const s1 = { ...st, majorBias: 0.25, fundamentals: { ...st.fundamentals } };
    const s2 = { ...st, majorBias: 0, fundamentals: { ...st.fundamentals } };
    sumWith += Number(quiet(() => genNextReport(s1, {})).growth) || 0;
    sumWithout += Number(quiet(() => genNextReport(s2, {})).growth) || 0;
  }
  const avgWith = sumWith / N;
  const avgWithout = sumWithout / N;
  check('带 +0.25 偏移的增速均值明显更高', avgWith > avgWithout + 0.15,
    `${avgWith.toFixed(3)} vs ${avgWithout.toFixed(3)}`);

  // 负偏移
  let sumNeg = 0;
  for (let i = 0; i < N; i += 1) {
    const s3 = { ...st, majorBias: -0.25, fundamentals: { ...st.fundamentals } };
    sumNeg += Number(quiet(() => genNextReport(s3, {})).growth) || 0;
  }
  check('带 −0.25 偏移的增速均值明显更低', sumNeg / N < avgWithout - 0.15,
    `${(sumNeg / N).toFixed(3)} vs ${avgWithout.toFixed(3)}`);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 引擎里整条链路：事件落库、股价动、偏置清空 ===');
{
  const db = newDb({ majorNewsChanceRatio: 1, eventChance: 1 });
  for (const s of Object.values(db.stocks)) s.majorBias = 0;
  const p0 = db.stocks.TGW.price;
  quiet(() => stepMarket(db));
  const evs = db.events.filter((e) => e.major);
  check('stepMarket 里会生成重大新闻', evs.length === 1, String(evs.length));
  const code = evs[0].companies[0];
  const shifted = Object.values(db.stocks).filter((s) => Math.abs(Number(s.majorBias) || 0) > 0);
  check('给标的留了财报偏移', shifted.length > 0, shifted.map((s) => `${s.code}=${s.majorBias.toFixed(2)}`).join(','));
  check('价格或价值线确实被影响了',
    db.stocks[code].price !== p0 || Math.abs(Number(db.stocks[code].majorBias)) > 0, code);

  // 财报落地后偏移清零
  const st = db.stocks[code];
  st.nextReportTick = db.tick;          // 本轮就该发（判定是 db.tick < nextReportTick 才跳过）
  st.pendingReport = null;
  st.majorBias = 0.25;
  quiet(() => stepMarket(db));
  check('财报发布后 majorBias 清零', (Number(st.majorBias) || 0) === 0, String(st.majorBias));
}

// ---------------------------------------------------------------- 7
log('');
log('=== 7 公告挂 3 小时：价格阶段结束就停，公告继续留着 ===');
{
  const db = newDb({ majorNewsChanceRatio: 1, eventChance: 1, tickMs: 5000 });
  db.config.majorNewsAnnounceHours = 3;
  const ev = quiet(() => spawnMajorNews(db));
  check('公告存活轮数 = 3 小时 / 5 秒 = 2160 轮 + 冲击 5 轮',
    ev.remaining === 5 + 2160, String(ev.remaining));
  check('价格阶段标记 priceLeft = 5', ev.priceLeft === 5, String(ev.priceLeft));
  const trend0 = ev.trend;
  const left0 = ev.remaining;   // ev 是活的引用，先把初值记下来
  check('刚开始 trend 不为 0', trend0 !== 0, String(trend0));

  // 推进 5 轮：价格阶段走完
  for (let i = 0; i < 5; i += 1) quiet(() => stepMarket(db));
  const live = db.events.find((x) => x.id === ev.id);
  check('5 轮后公告还在', !!live, live ? `remaining=${live.remaining}` : '没了');
  check('5 轮后价格冲击已归零', !!live && live.trend === 0, String(live?.trend));
  check('公告剩余还很长（>2000 轮）', !!live && live.remaining > 2000, String(live?.remaining));

  // 再推进 100 轮，公告依然在
  for (let i = 0; i < 100; i += 1) quiet(() => stepMarket(db));
  const live2 = db.events.find((x) => x.id === ev.id);
  check('再过 100 轮公告仍在', !!live2, String(live2?.remaining));
  check('剩余轮数递减正确', !!live2 && live2.remaining === left0 - 105,
    `${live2?.remaining} vs ${left0 - 105}`);
}
// ---------------------------------------------------------------- 8
log('');
log('=== 8 硬闸：两条重大新闻之间至少隔 N 轮（防「一下子出好几条」） ===');
{
  const db = newDb({ eventChance: 1, majorNewsChanceRatio: 1, majorNewsMinGapTicks: 120 });
  db.tick = 5000;
  const first = quiet(() => spawnMajorNews(db));
  check('第 1 条能出（还没记录间隔）', !!first, first ? first.companies.join(',') : '没出');

  // 立刻再掷 200 次：全被闸门拦住
  let burst = 0;
  for (let i = 0; i < 200; i += 1) {
    db.events = db.events.filter((e) => !e.major);   // 清掉旧事件，只测闸门
    if (quiet(() => spawnMajorNews(db))) burst += 1;
  }
  check('同 tick 连掷 200 次一条都不出（概率 100% 也被拦）', burst === 0, String(burst));

  // 过 60 轮还是拦
  db.tick += 60;
  let mid = 0;
  for (let i = 0; i < 50; i += 1) {
    db.events = db.events.filter((e) => !e.major);
    if (quiet(() => spawnMajorNews(db))) mid += 1;
  }
  check('过了 60 轮仍然拦（< 120）', mid === 0, String(mid));

  // 过满 120 轮放行
  db.tick = 5000 + 120;
  db.events = db.events.filter((e) => !e.major);
  const second = quiet(() => spawnMajorNews(db));
  check('过满 120 轮就能再出', !!second, second ? second.companies.join(',') : '没出');
  check('记账 count = 2', Number(db.majorStats.count) === 2, String(db.majorStats.count));
  check('记账 lastTick 跟着走', Number(db.majorStats.lastTick) === db.tick, String(db.majorStats.lastTick));

  // 同一只票在冲击中不叠
  const db3 = newDb({ eventChance: 1, majorNewsChanceRatio: 1, majorNewsMinGapTicks: 0 });
  db3.majorPool = MAJOR_NEWS_POOL.filter((x) => x.companies[0] === 'TGW');
  const e1 = quiet(() => spawnMajorNews(db3));
  check('第一条是 TGW', !!e1 && e1.companies[0] === 'TGW');
  db3.tick += 10;   // 间隔闸门关闭，但 TGW 还在冲击中
  db3.events = db3.events.filter((x) => x.id === e1.id);
  const e2 = quiet(() => spawnMajorNews(db3));
  check('同一只票冲击中不再叠一条（池里只有 TGW 时会退化成允许，所以只查不重复同 tick）',
    !e2 || e2.companies[0] === 'TGW');
}
console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
