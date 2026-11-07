// 虚假成交（会推动股价）+ 游资资金 + 市场资金冲击通道
//   node tests/market-money.mjs
//
// 覆盖：
//   1. 三档金额与权重（越低档越常见）
//   2. 虚假成交真的推动股价（方向、档位、开关）
//   3. 市场资金通道（强度 / 封顶 / 衰减 / 和玩家通道互不干扰）
//   4. 游资：板块轮动节奏、每笔金额、卖旧买新、成交记录长得和散户一样
//   5. 老存档迁移
//   6. 引擎集成：跑一段，价格不炸、成交记录有游资

import { createDb, migrate } from '../src/store.js';
import { stepMarket, rebalanceIndex } from '../src/engine.js';
import {
  MARKET_TIERS, MARKET_NAMES, MARKET_EMOJIS,
  marketTierWeights, pickMarketNotional, marketIdentity, genMarketTrades
} from '../src/marketTrades.js';
import {
  hotMoneySectors, ensureHotMoney, hotMoneySwitchInterval, hotMoneyAmount,
  stepHotMoney, hotMoneyInfo
} from '../src/hotmoney.js';
import { addMarketFlow } from '../src/trading.js';

let fails = 0;
let passes = 0;
const out = [];
// migrate() 会打印「分红参数升级」这类一次性日志，先闭麦，最后统一输出结果
const realLog = console.log;
console.log = () => {};
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

/** 固定随机序列（不够长就重复最后一个） */
function withRandom(seq, fn) {
  const orig = Math.random;
  let i = 0;
  Math.random = () => seq[Math.min(i++, seq.length - 1)];
  try { return fn(); } finally { Math.random = orig; }
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 价格完全不动、也没有新闻/情绪的干净市场 */
function calmDb(patch = {}) {
  const db = migrate(createDb());
  Object.assign(db.config, {
    baseVolatility: 0, meanReversion: 0, eventChance: 0, localEventChance: 0,
    marketTradesEnabled: 0, hotMoneyEnabled: 0,
    sentimentEnabled: 0, playerImpactEnabled: 0,
    fxEnabled: 0, goldVol: 0, goldRev: 0,
    maxPremium: 1e9, reportIntervalTicks: 1e12
  }, patch);
  db.tick = 10000;
  db.events = [];
  for (const st of Object.values(db.stocks)) st.nextReportTick = 1e12;
  return db;
}

const quiet = (fn) => {
  const realLog = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = realLog; }
};

// ================================================================ 1
log('=== 1 三档金额：范围、权重、频率 ===');
{
  const want = [[10000, 100000], [100000, 1000000], [1000000, 10000000]];
  check('三档刚好是三档', MARKET_TIERS.length === 3, String(MARKET_TIERS.length));
  MARKET_TIERS.forEach((t, i) => {
    check(`第 ${i + 1} 档范围 ${want[i][0]}~${want[i][1]}`,
      t.lo === want[i][0] && t.hi === want[i][1], `${t.lo}~${t.hi}`);
  });
  check('档位单调递增（低档上限 = 高档下限）',
    MARKET_TIERS[0].hi === MARKET_TIERS[1].lo && MARKET_TIERS[1].hi === MARKET_TIERS[2].lo);

  const w = marketTierWeights({ marketTradesSmallP: 70, marketTradesMidP: 24, marketTradesBigP: 6 });
  check('权重归一化后和为 1', Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9, w.map((x) => x.toFixed(3)).join('/'));
  check('越低档权重越高', w[0] > w[1] && w[1] > w[2], w.map((x) => x.toFixed(3)).join(' > '));
  const eq = marketTierWeights({ marketTradesSmallP: 0, marketTradesMidP: 0, marketTradesBigP: 0 });
  check('三个都填 0 → 退化成等概率', Math.abs(eq[0] - 1 / 3) < 1e-9);
  const custom = marketTierWeights({ marketTradesSmallP: 100, marketTradesMidP: 100, marketTradesBigP: 800 });
  check('自定义权重按比例归一化（800 → 0.8）', Math.abs(custom[2] - 0.8) < 1e-9, custom[2].toFixed(3));
  const neg = marketTierWeights({ marketTradesSmallP: -5, marketTradesMidP: NaN, marketTradesBigP: 10 });
  check('负数 / NaN 权重被当成 0', neg[0] === 0 && neg[1] === 0 && Math.abs(neg[2] - 1) < 1e-9,
    neg.map((x) => x.toFixed(2)).join('/'));

  // 抽 4000 次：金额落在自己那一档里，且频率与权重同序
  const cfg = { marketTradesSmallP: 70, marketTradesMidP: 24, marketTradesBigP: 6 };
  const cnt = { small: 0, mid: 0, big: 0 };
  let outOfRange = 0;
  for (let i = 0; i < 4000; i++) {
    const r = pickMarketNotional(cfg);
    cnt[r.tier]++;
    if (!(r.notional >= r.lo && r.notional <= r.hi)) outOfRange++;
  }
  check('4000 次抽样全部落在档内', outOfRange === 0, `越界 ${outOfRange}`);
  check('频率排序：一档 > 二档 > 三档', cnt.small > cnt.mid && cnt.mid > cnt.big,
    `${cnt.small}/${cnt.mid}/${cnt.big}`);
  check('一档频率接近 70%', Math.abs(cnt.small / 4000 - 0.7) < 0.05, (cnt.small / 40).toFixed(1) + '%');
  check('三档频率接近 6%', Math.abs(cnt.big / 4000 - 0.06) < 0.03, (cnt.big / 40).toFixed(1) + '%');

  const lo = pickMarketNotional(cfg, () => 0);
  check('rand=0 → 一档下限', lo.tier === 'small' && lo.notional === 10000, `${lo.tier} ${lo.notional}`);
  const hi = pickMarketNotional(cfg, () => 0.999999);
  check('rand→1 → 三档上限', hi.tier === 'big' && hi.notional > 9990000, `${hi.tier} ${Math.round(hi.notional)}`);
}

// ================================================================ 2
log('');
log('=== 2 虚假成交真的推动股价（方向 / 档位 / 开关）===');
{
  const db = calmDb({ marketTradesEnabled: 1, marketTradesRate: 3, marketImpactEnabled: 1 });
  // 这一段只核对「个股」逐笔符号；指数标的会按权重拆给成分股，单独在第 2 段末尾测
  db.stocks.DENG.status = 'suspended';
  db.stocks.DENGS.status = 'suspended';
  // 期望的增量：按公开的档位范围核对每笔金额
  const tiers = new Map(MARKET_TIERS.map((t) => [t.key, t]));
  let rows = 0;
  let badTier = 0;
  let badSign = 0;
  let badAmount = 0;
  const cfg = db.config;
  const ref = Math.max(1, Number(cfg.marketImpactRef));
  const capFlow = Math.max(1, Number(cfg.marketImpactFlowMax));
  for (let round = 0; round < 300; round++) {
    const before = new Map(Object.entries(db.stocks).map(([c, s]) => [c, Number(s.mflow) || 0]));
    const batch = genMarketTrades(db);
    const want = new Map(before);      // code -> 期望的 mflow（按实现顺序逐笔夹取）
    for (const r of batch) {
      rows++;
      const t = tiers.get(r.tier);
      if (!t) { badTier++; continue; }
      const amount = r.qty * r.price;
      // floor 折股数会让成交额略低于抽到的金额，但不会超出档位上限
      if (amount > t.hi + 1e-6 || amount < t.lo - r.price - 1e-6) badAmount++;
      const sign = r.side === 'long' ? 1 : -1;
      const st = db.stocks[r.code];
      if (!st.isIndex) {
        want.set(r.code, Math.max(-capFlow, Math.min(capFlow, (want.get(r.code) || 0) + (sign * amount) / ref)));
      }
      if (r.action !== 'open') badSign++;
      if (!MARKET_EMOJIS.includes(r.emoji)) badSign++;
      if (!MARKET_NAMES.includes(r.nickname)) badSign++;
    }
    for (const [code, signed] of want.entries()) {
      const actual = Number(db.stocks[code].mflow) || 0;
      if (Math.abs(actual - signed) > 1e-9) badSign++;
    }
  }
  check('生成了大量虚假成交', rows > 500, `${rows} 笔`);
  check('每笔都带合法档位', badTier === 0, `坏档位 ${badTier}`);
  check('每笔成交额落在自己那一档里', badAmount === 0, `越界 ${badAmount}`);
  check('买卖方向 -> 市场资金压力符号一致（且昵称/头像来自同一池子）', badSign === 0, `异常 ${badSign}`);

  // 开关：倍率 0 与总开关都要能真的关掉
  const off1 = calmDb({ marketTradesEnabled: 1, marketTradesRate: 0 });
  const off2 = calmDb({ marketTradesEnabled: 0, marketTradesRate: 3 });
  const r1 = genMarketTrades(off1);
  const r2 = genMarketTrades(off2);
  const m1 = Object.values(off1.stocks).reduce((a, s) => a + Math.abs(Number(s.mflow) || 0), 0);
  const m2 = Object.values(off2.stocks).reduce((a, s) => a + Math.abs(Number(s.mflow) || 0), 0);
  check('倍率 0 = 彻底不生成（以前的 bug：还会硬编 1 笔）', r1.length === 0 && m1 === 0, `rows=${r1.length}`);
  check('总开关 0 = 不生成也不加压力', r2.length === 0 && m2 === 0, `rows=${r2.length}`);

  // 指数标的：按权重拆给成分股
  const db2 = calmDb({ marketImpactEnabled: 1 });
  db2.index.weights = { TGW: 1 };
  db2.smallIndex.weights = { MCD: 1 };
  db2.stocks.TGW.mflow = 0;
  db2.stocks.MCD.mflow = 0;
  addMarketFlow(db2, db2.stocks.DENG, 10000000);
  check('买指数 DENG → 压力按 DENG 权重落到成分股',
    Math.abs(db2.stocks.TGW.mflow - 1) < 1e-9 && db2.stocks.MCD.mflow === 0,
    `TGW=${db2.stocks.TGW.mflow} MCD=${db2.stocks.MCD.mflow}`);
  addMarketFlow(db2, db2.stocks.DENGS, 10000000);
  check('买小灯指数 DENGS → 走 smallIndex 的权重表（不再错用 DENG 的）',
    db2.stocks.MCD.mflow === 1 && Math.abs(db2.stocks.TGW.mflow - 1) < 1e-9,
    `MCD=${db2.stocks.MCD.mflow}`);
}

// ================================================================ 3
log('');
log('=== 3 市场资金 → 价格：强度 / 封顶 / 衰减 / 通道隔离 ===');
{
  const db = calmDb({ marketImpactEnabled: 1, marketImpactRef: 10000000, marketImpactStrength: 0.001 });
  const st = db.stocks.TGW;
  st.price = 100;
  st.fair = 100;
  st.mflow = 1;                       // 1 单位 = 一笔 1000 万
  const freeCap = st.price * st.shares * st.freeFloat;
  db.config.impactRefFreeCap = freeCap;   // 让 factor = 1，方便手算
  quiet(() => stepMarket(db));
  check('1 单位压力 → 价格 +0.1%（factor=1 时）',
    Math.abs(st.price / 100 - 1.001) < 1e-9, `${((st.price / 100 - 1) * 100).toFixed(4)}%`);
  check('压力按 marketImpactDecay 衰减', Math.abs(st.mflow - 0.85) < 1e-9, String(st.mflow));

  // 负压力
  const db2 = calmDb({ marketImpactEnabled: 1, marketImpactStrength: 0.001 });
  const st2 = db2.stocks.TGW;
  st2.price = 100; st2.fair = 100; st2.mflow = -1;
  db2.config.impactRefFreeCap = st2.price * st2.shares * st2.freeFloat;
  quiet(() => stepMarket(db2));
  check('负压力压低价格', st2.price < 100, `${((st2.price / 100 - 1) * 100).toFixed(4)}%`);

  // 单轮封顶
  const db3 = calmDb({ marketImpactEnabled: 1, marketImpactStrength: 0.001, marketImpactMax: 0.004 });
  const st3 = db3.stocks.TGW;
  st3.price = 100; st3.fair = 100; st3.mflow = 8;
  db3.config.impactRefFreeCap = st3.price * st3.shares * st3.freeFloat;
  quiet(() => stepMarket(db3));
  check('单轮最多推 marketImpactMax（0.4%）', Math.abs(st3.price / 100 - 1.004) < 1e-9,
    `${((st3.price / 100 - 1) * 100).toFixed(4)}%`);

  // 压力消化完会归零
  const db4 = calmDb({ marketImpactEnabled: 1, marketImpactStrength: 0.001 });
  db4.stocks.TGW.mflow = 1;
  quiet(() => { for (let i = 0; i < 80; i++) stepMarket(db4); });
  check('80 轮后压力被市场消化成 0', (Number(db4.stocks.TGW.mflow) || 0) === 0,
    String(db4.stocks.TGW.mflow));

  // 关掉开关 → 完全不动
  const db5 = calmDb({ marketImpactEnabled: 0 });
  db5.stocks.TGW.price = 100;
  db5.stocks.TGW.fair = 100;
  db5.stocks.TGW.mflow = 8;
  quiet(() => stepMarket(db5));
  check('marketImpactEnabled=0 → 压力不生效', db5.stocks.TGW.price === 100);

  // 通道隔离：市场资金不动玩家的 flow
  const db6 = calmDb({ marketImpactEnabled: 1 });
  const st6 = db6.stocks.TGW;
  st6.price = 100; st6.fair = 100;
  addMarketFlow(db6, st6, 30000000);
  check('市场资金只写 mflow，不碰玩家的 flow', (st6.flow || 0) === 0 && st6.mflow > 0,
    `flow=${st6.flow} mflow=${st6.mflow}`);
}

// ================================================================ 4
log('');
log('=== 4 游资：轮动节奏 / 每笔金额 / 卖旧买新 ===');
{
  const db = calmDb({ hotMoneyEnabled: 1 });
  const sectors = hotMoneySectors(db);
  check('板块按 industry 分组', sectors.size >= 3, [...sectors.keys()].join('/'));
  check('指数不算板块', ![...sectors.values()].some((list) => list.some((s) => s.isIndex)));

  const hm0 = ensureHotMoney(db);
  check('游资状态默认空壳', hm0.code === '' && hm0.switches === 0, JSON.stringify(hm0));

  // 间隔与金额
  let badInt = 0;
  for (let i = 0; i < 500; i++) {
    const n = hotMoneySwitchInterval({ hotMoneySwitchMin: 20, hotMoneySwitchMax: 300 });
    if (n < 20 || n > 300) badInt++;
  }
  check('换板块间隔恒在 20~300 轮', badInt === 0, `越界 ${badInt}`);
  const swapped = hotMoneySwitchInterval({ hotMoneySwitchMin: 300, hotMoneySwitchMax: 20 });
  check('min/max 写反也能兜住', swapped >= 20 && swapped <= 300, String(swapped));
  check('间隔=下限（rand=0）', hotMoneySwitchInterval({ hotMoneySwitchMin: 20, hotMoneySwitchMax: 300 }, () => 0) === 20);

  let badAmt = 0;
  for (let i = 0; i < 500; i++) {
    const a = hotMoneyAmount({ hotMoneyMin: 10000000, hotMoneyMax: 30000000 });
    if (!(a >= 10000000 && a <= 30000000)) badAmt++;
  }
  check('每笔金额恒在 1000 万~3000 万', badAmt === 0, `越界 ${badAmt}`);

  // 第一次：只买不卖
  const db2 = calmDb({ hotMoneyEnabled: 1 });
  const r0 = ensureHotMoney(db2);
  r0.nextSwitchTick = 0;
  const first = stepHotMoney(db2, { rand: mulberry32(7) });
  check('第一次出手只买入（没有旧仓可卖）', first && first.sold === null && first.bought,
    JSON.stringify({ sold: first?.sold, code: first?.code }));
  check('买入后记下当前票和板块', r0.code === first.code && r0.industry === first.industry,
    `${r0.code}/${r0.industry}`);
  check('买入金额落在 1000 万~3000 万',
    first.bought.qty * first.bought.price >= 10000000 - 100 && first.bought.qty * first.bought.price <= 30000000,
    String(Math.round(first.bought.qty * first.bought.price)));
  check('买入把价格压力推到正方向', db2.stocks[first.code].mflow > 0, String(db2.stocks[first.code].mflow));
  check('换板块计时落在范围内',
    r0.nextSwitchTick - db2.tick >= 20 && r0.nextSwitchTick - db2.tick <= 300,
    String(r0.nextSwitchTick - db2.tick));

  // 没到点：什么都不做
  const quietStep = stepHotMoney(db2, { rand: mulberry32(8) });
  check('没到换板块的时候不动手', quietStep === null);

  // 到点：卖旧买新，且板块换了
  db2.tick = r0.nextSwitchTick;
  const oldCode = r0.code;
  const oldIndustry = r0.industry;
  const mflowBefore = {
    [oldCode]: Number(db2.stocks[oldCode].mflow) || 0
  };
  const second = stepHotMoney(db2, { rand: mulberry32(9) });
  check('到点先卖掉旧票', second && second.sold && second.sold.code === oldCode, second?.sold?.code);
  check('卖单是 close + long（显示成「卖」）',
    second.sold.action === 'close' && second.sold.side === 'long');
  check('再买入新票', second && second.bought && second.bought.code !== oldCode, second?.bought?.code);
  check('新板块和旧板块不同', second.industry !== oldIndustry, `${oldIndustry} → ${second.industry}`);
  check('卖出让旧票的压力往下走、买入把新票的压力往上推',
    (Number(db2.stocks[oldCode].mflow) || 0) < mflowBefore[oldCode]
    && (Number(db2.stocks[second.code].mflow) || 0) > 0,
    `${oldCode} ${mflowBefore[oldCode]} → ${db2.stocks[oldCode].mflow}；${second.code}=${db2.stocks[second.code].mflow}`);
  check('换板块次数 +1', r0.switches === 2, String(r0.switches));

  // 成交记录：和虚假成交长得一模一样（玩家分不出来）
  const rows = db2.trades.filter((t) => t.hot);
  check('游资成交写进了流水', rows.length === 3, String(rows.length));
  check('全部标成 isMarket（不进管理控制台 / 不影响券商营收）',
    rows.every((t) => t.isMarket === true));
  check('昵称来自散户池', rows.every((t) => MARKET_NAMES.includes(t.nickname)));
  check('头像来自小动物池', rows.every((t) => MARKET_EMOJIS.includes(t.emoji)));
  check('playerId 也是 mkt_ 前缀（接口会下发这个字段，不能露馅）',
    rows.every((t) => String(t.playerId).startsWith('mkt_')));
  check('杠杆 1~10（和虚假成交同款）', rows.every((t) => t.leverage >= 1 && t.leverage <= 10));
  check('流水带时间戳与价格', rows.every((t) => t.at > 0 && t.price > 0));

  // 关掉开关
  const db3 = calmDb({ hotMoneyEnabled: 0 });
  const r3 = stepHotMoney(db3);
  check('hotMoneyEnabled=0 → 完全不动', r3 === null && db3.trades.length === 0);

  // 停牌 / 退市不影响节奏
  const db4 = calmDb({ hotMoneyEnabled: 1 });
  const hm4 = ensureHotMoney(db4);
  hm4.code = 'TGW';
  hm4.industry = '消费';
  hm4.nextSwitchTick = db4.tick;
  db4.stocks.TGW.status = 'suspended';
  const r4 = stepHotMoney(db4, { rand: mulberry32(11) });
  check('旧票停牌时卖不出去，但照样能换板块买新的',
    r4 && r4.sold === null && r4.bought, JSON.stringify({ sold: r4?.sold, code: r4?.code }));

  const info = hotMoneyInfo(db2);
  check('hotMoneyInfo 给出当前票与剩余轮数', info && info.code && info.leftTicks >= 0,
    JSON.stringify(info));
}

// ================================================================ 5
log('');
log('=== 5 老存档迁移 ===');
{
  const raw = createDb();
  for (const s of Object.values(raw.stocks)) delete s.mflow;
  delete raw.hotMoney;
  const d = migrate(raw);
  check('migrate 给每只票补 mflow = 0',
    Object.values(d.stocks).every((s) => s.mflow === 0));
  check('migrate 补出游资状态', d.hotMoney && typeof d.hotMoney === 'object'
    && d.hotMoney.code === '' && d.hotMoney.switches === 0, JSON.stringify(d.hotMoney));

  // 已有的值不能被冲掉
  const raw2 = createDb();
  raw2.stocks.TGW.mflow = 2.5;
  raw2.hotMoney = { code: 'LU', industry: '消费娱乐', nextSwitchTick: 999, switches: 4, startedTick: 5 };
  const d2 = migrate(migrate(raw2));
  check('已有的 mflow 不会被 migrate 清零', d2.stocks.TGW.mflow === 2.5, String(d2.stocks.TGW.mflow));
  check('游资状态原样保留', d2.hotMoney.code === 'LU' && d2.hotMoney.switches === 4,
    JSON.stringify(d2.hotMoney));
}

// ================================================================ 6
log('');
log('=== 6 引擎集成：跑一段，价格不炸、流水里有游资 ===');
{
  const orig = Math.random;
  Math.random = mulberry32(20261123);
  const db = migrate(createDb());
  Object.assign(db.config, {
    baseVolatility: 0.01, meanReversion: 0.002, eventChance: 0,
    marketTradesEnabled: 1, marketTradesRate: 3, hotMoneyEnabled: 1,
    marketImpactEnabled: 1, sentimentEnabled: 1, maxPremium: 2.5
  });
  try {
    quiet(() => { for (let i = 0; i < 1500; i++) stepMarket(db); });
  } finally {
    Math.random = orig;
  }
  const prices = Object.values(db.stocks).filter((s) => !s.isIndex);
  check('所有价格都还是正数', prices.every((s) => Number.isFinite(s.price) && s.price > 0));
  check('没有票突破 fair × maxPremium', prices.every((s) => s.price <= s.fair * 2.5 + 1e-6));
  check('1500 轮后溢价没有离谱（中位数 < 60%）', (() => {
    const devs = prices.map((s) => Math.abs(Math.log(s.price / s.fair))).sort((a, b) => a - b);
    return Math.exp(devs[Math.floor(devs.length / 2)]) - 1 < 0.6;
  })());

  const marketRows = db.trades.filter((t) => t.isMarket);
  const hotRows = db.trades.filter((t) => t.hot);
  check('流水里有虚假成交', marketRows.length > 100, String(marketRows.length));
  check('流水里有游资成交', hotRows.length > 0, String(hotRows.length));
  check('游资成交既有买也有卖',
    hotRows.some((t) => t.action === 'open') && hotRows.some((t) => t.action === 'close'),
    `open=${hotRows.filter((t) => t.action === 'open').length} close=${hotRows.filter((t) => t.action === 'close').length}`);
  check('游资一直在轮动（切换次数 > 0，且流水里有对应的成交）',
    db.hotMoney.switches > 0 && hotRows.filter((t) => t.action === 'open').length > 0,
    `switches=${db.hotMoney.switches} 流水里 open=${hotRows.filter((t) => t.action === 'open').length}`);
  check('游资不会连续两次买同一个板块（≥3 个板块时）', (() => {
    const buys = hotRows.filter((t) => t.action === 'open');
    let same = 0;
    for (let i = 1; i < buys.length; i++) {
      const a = db.stocks[buys[i - 1].code]?.industry;
      const b = db.stocks[buys[i].code]?.industry;
      if (a && b && a === b) same++;
    }
    return same === 0;
  })());
  // 停掉市场资金之后，残留的压力会被慢慢消化干净（不会永久抬价）
  db.config.marketTradesEnabled = 0;
  db.config.hotMoneyEnabled = 0;
  quiet(() => { for (let i = 0; i < 120; i++) stepMarket(db); });
  check('停掉之后压力被彻底消化（没有永久残留）',
    Object.values(db.stocks).every((s) => Math.abs(Number(s.mflow) || 0) < 0.02),
    Object.entries(db.stocks)
      .filter(([, s]) => Math.abs(Number(s.mflow) || 0) >= 0.02)
      .map(([c, s]) => `${c}=${s.mflow}`).join(',') || '干净');
}

console.log = realLog;
console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
