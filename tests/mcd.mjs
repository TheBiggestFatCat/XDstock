// 麦当劳（MCD）：稳步增长 + 市值天花板 + 整点拉升
//   node tests/mcd.mjs
//
// 设定：
//   1. 上市市值 1964.1 亿（327.35 × 6 亿股）
//   2. 财报稳步增长，市值无限靠近 10000 亿（capCeiling），永远不超过
//   3. 每天 12:00 / 18:00 整各拉升一次，幅度 5%~20%

import { createDb, migrate } from '../src/store.js';
import { genNextReport, fairFromReport } from '../src/fundamentals.js';
import { stepMarket, rallySlotFor, runReports } from '../src/engine.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
const at = (day, h, m) => new Date(2026, 10, day, h, m, 30).getTime();
const capOf = (st) => st.price * st.shares;

// ---------------------------------------------------------------- 1
log('=== 1 上市设定 ===');
{
  const db = migrate({});
  const st = db.stocks.MCD;
  check('MCD 已入库', !!st && st.name === '麦当劳');
  check('图标指向 assets', st.icon === '/assets/stocks/MCD.png');
  check('总股本 6 亿股', st.shares === 600000000, String(st.shares));
  check('上市市值 1964.1 亿', Math.abs(capOf(st) / 1e8 - 1964.1) < 0.05,
    (capOf(st) / 1e8).toFixed(2) + ' 亿');
  // 2026-11：按需求去掉 MCD 专属的 10000 亿市值天花板（它把股价硬夹在 1666.67）
  check('没有市值天花板（capCeiling 已去掉）', !st.capCeiling, String(st.capCeiling));
  check('营收天花板仍然保留（4.5 倍）', Number(st.growthCeiling) === 4.5, String(st.growthCeiling));
  check('拉升时间 12 / 18 点', JSON.stringify(st.rallyHours) === '[12,18]');
  check('起点不打折（fair ≈ 现价）', Math.abs(st.fair / st.price - 1) < 0.02,
    `fair ${st.fair.toFixed(2)} / 价 ${st.price.toFixed(2)}`);
  check('股票总数 9 只（PVZ/HJF 已下市）',
    Object.values(db.stocks).filter((s) => !s.isIndex).length >= 9);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 稳步增长：营收一期一期往上走，增速很稳 ===');
{
  const db = migrate({});
  const st = db.stocks.MCD;
  const revs = [];
  const growths = [];
  const realLog = console.log;
  console.log = () => {};
  try {
    for (let i = 0; i < 40; i++) {
      st.fundamentals = genNextReport(st, { growthCeiling: 8 });
      revs.push(st.fundamentals.revenue);
      growths.push(st.fundamentals.growth);
      // 模拟 runReports 里 fair 的 70/30 平滑
      const computed = fairFromReport(st);
      st.fair = computed * 0.7 + st.fair * 0.3;
    }
  } finally {
    console.log = realLog;
  }
  check('营收一直在涨', revs.every((v, i) => i === 0 || v > revs[i - 1]));
  check('40 期涨了 1.5 倍以上', revs[revs.length - 1] / revs[0] > 1.5,
    (revs[revs.length - 1] / revs[0]).toFixed(2) + '×');
  const avg = growths.reduce((a, b) => a + b, 0) / growths.length;
  const spread = Math.max(...growths) - Math.min(...growths);
  check('平均增速 1.2%~4%', avg > 0.012 && avg < 0.04, (avg * 100).toFixed(2) + '%');
  check('增速波动很小（不像别的票那样乱跳）', spread < 0.02, spread.toFixed(4));
  check('fair 跟着涨', st.fair > 327.35, st.fair.toFixed(2));
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 不再有市值天花板：400 期实跑，fair 市值会越过 10000 亿 ===');
{
  const db = migrate({});
  const st = db.stocks.MCD;
  // 只让 MCD 发报：其他票推到很远的将来
  for (const s of Object.values(db.stocks)) {
    if (s.isIndex) continue;
    s.nextReportTick = s.code === 'MCD' ? 0 : 1e12;
  }
  db.tick = 1000;
  db.config.reportIntervalTicks = 720;
  db.config.dividendRate = 0;      // 这段只关心市值曲线
  db.players = {};
  const baseRev = Number(st.fundamentals.revenue) || 1;
  const revCeil = baseRev * 4.5;
  const realLog = console.log;
  let maxCap = 0;
  const marks = {};
  const growths = {};
  let maxRev = 0;
  try {
    console.log = () => {};
    for (let i = 1; i <= 400; i++) {
      db.tick += 720;
      st.nextReportTick = db.tick;
      runReports(db);
      const cap = st.fair * st.shares;
      if (cap > maxCap) maxCap = cap;
      maxRev = Math.max(maxRev, Number(st.fundamentals.revenue) || 0);
      if ([10, 50, 150, 300, 400].includes(i)) {
        marks[i] = cap / 1e8;
        growths[i] = Number(st.fundamentals.growth) || 0;
      }
    }
  } finally {
    console.log = realLog;
  }
  check('fair 市值已经越过 10000 亿（说明没有硬顶了）', maxCap > 1e12,
    '最高 ' + (maxCap / 1e8).toFixed(0) + ' 亿');
  check('越往后长得越慢（营收逼近天花板）', growths[10] > growths[400] * 1.5,
    `第10期 ${(growths[10] * 100).toFixed(2)}% vs 第400期 ${(growths[400] * 100).toFixed(3)}%`);
  check('营收仍然守着 baseRev × 4.5 的天花板', maxRev <= revCeil * 1.0001,
    `${(maxRev / 1e8).toFixed(0)} 亿 / 上限 ${(revCeil / 1e8).toFixed(0)} 亿`);
  const pe = st.fundamentals.eps > 0 ? st.fair / st.fundamentals.eps : 0;
  check('PE 没跑飞（10~40 之间）', pe > 10 && pe < 40, 'PE ' + pe.toFixed(1));
  void marks;
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 整点拉升的判定 ===');
{
  const s = { rallyHours: [12, 18] };
  check('12:00 触发', !!rallySlotFor(s, at(4, 12, 0)));
  s.lastRallySlot = rallySlotFor(s, at(4, 12, 0));
  check('同一天同一档只触发一次', rallySlotFor(s, at(4, 12, 3)) === null);
  check('18:00 是另一档，照样触发', !!rallySlotFor(s, at(4, 18, 0)));
  s.lastRallySlot = rallySlotFor(s, at(4, 18, 0));
  check('第二天 12:00 重新触发', !!rallySlotFor(s, at(5, 12, 0)));
  check('11:00 不触发', rallySlotFor(s, at(4, 11, 59)) === null);
  check('12:15 已经过了窗口，不补拉', rallySlotFor(s, at(4, 12, 15)) === null);
  check('没有 rallyHours 的票永不触发', rallySlotFor({}, at(4, 12, 0)) === null);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 真的会拉升：幅度落在 5%~20%，而且不会连拉 ===');
{
  const db = createDb();
  Object.assign(db.config, {
    baseVolatility: 0, meanReversion: 0, eventChance: 0, localEventChance: 0,
    marketTradesRate: 0, hotMoneyEnabled: 0, playerImpactEnabled: 0, sentimentEnabled: 0,
    maxPremium: 1e9, rallyMin: 0.05, rallyMax: 0.2
  });
  const st = db.stocks.MCD;
  st.shares = 600000000;
  st.capCeiling = 0;              // 这段只看拉升幅度，先不让天花板夹
  st.price = 327.35;
  st.fair = 327.35;
  st.nextReportTick = 1e12;
  st.rallyHours = [12];
  st.lastRallySlot = '';
  // 把「现在」钉在 12:00:30，避免测试结果跟当前时间有关
  const realNow = Date.now;
  const fakeNow = new Date(2026, 10, 4, 12, 0, 30).getTime();
  Date.now = () => fakeNow;
  const realLog = console.log;
  console.log = () => {};
  db.notices = [];
  let after = 0;
  let again = 0;
  let boostSum = 0;
  let minB = 1;
  let maxB = 0;
  try {
    for (let i = 0; i < 30; i++) {
      const before = st.price;
      const slotBefore = st.lastRallySlot;
      stepMarket(db);
      const move = st.price / before - 1;
      if (st.lastRallySlot !== slotBefore) {
        after = move;
        boostSum++;
        minB = Math.min(minB, move);
        maxB = Math.max(maxB, move);
      } else if (boostSum > 0) {
        again = move;
      }
    }
  } finally {
    console.log = realLog;
    Date.now = realNow;
  }
  check('整点窗口里拉了一次', boostSum === 1, `拉了 ${boostSum} 次`);
  check('幅度在 5%~20% 之间', after >= 0.0499 && after <= 0.2001,
    '+' + (after * 100).toFixed(2) + '%');
  check('后面 29 轮都没有再拉', Math.abs(again) < 1e-12, (again * 100).toFixed(4) + '%');
  // 2026-11：整点拉升不再发公告，只动价格
  const rallyNotices = (db.notices || []).filter((n) => String(n.text || '').includes('整点拉升'));
  check('整点拉升不发公告', rallyNotices.length === 0, `${rallyNotices.length} 条公告`);
  void minB; void maxB;
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 引擎仍然支持 capCeiling（只是 MCD 不再设），且现在价格不会被夹在 1666.67 ===');
{
  // 6a：MCD 没有天花板 → 价格可以站上 1666.67
  {
    const db = createDb();
    Object.assign(db.config, {
      baseVolatility: 0, meanReversion: 0, eventChance: 0, localEventChance: 0,
      marketTradesRate: 0, hotMoneyEnabled: 0, playerImpactEnabled: 0, sentimentEnabled: 0, maxPremium: 1e9
    });
    const st = db.stocks.MCD;
    st.shares = 600000000;
    st.capCeiling = 0;
    st.price = 1700;
    st.fair = 1700;
    st.nextReportTick = 1e12;
    st.rallyHours = [];
    const realLog = console.log;
    console.log = () => {};
    try {
      for (let i = 0; i < 50; i++) stepMarket(db);
    } finally {
      console.log = realLog;
    }
    check('没有天花板时 1700 不会被夹到 1666.67', st.price > 1666.67 + 1,
      st.price.toFixed(2));
    check('市值可以超过 10000 亿', capOf(st) > 1e12, (capOf(st) / 1e8).toFixed(0) + ' 亿');
  }

  // 6b：手动给某只票设 capCeiling，硬推还是推不过（引擎能力保留）
  {
    const db = createDb();
    Object.assign(db.config, {
      baseVolatility: 0, meanReversion: 0, eventChance: 0, localEventChance: 0,
      marketTradesRate: 0, hotMoneyEnabled: 0, playerImpactEnabled: 0, sentimentEnabled: 0, maxPremium: 1e9
    });
    const st = db.stocks.MCD;
    st.shares = 600000000;
    st.capCeiling = 1000000000000;
    st.price = 1600;
    st.fair = 1600;
    st.nextReportTick = 1e12;
    st.rallyHours = [];
    const realLog = console.log;
    console.log = () => {};
    try {
      for (let i = 0; i < 50; i++) stepMarket(db);
    } finally {
      console.log = realLog;
    }
    check('设了 capCeiling 时股价仍被压在上限内', st.price <= 1000000000000 / 600000000 + 1e-9,
      st.price.toFixed(2));
    check('设了 capCeiling 时市值不超过上限', capOf(st) <= 1e12 + 1e3,
      (capOf(st) / 1e8).toFixed(1) + ' 亿');
  }
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
