// 海洋之泪 HYZL：财报完全由三角洲物品价格决定（纯物价驱动）+ 平衡价锚定 200
//   node tests/dfitem-stock.mjs
//
// 覆盖：物品价格解析 / EPS·fair 映射公式 / 无随机性 / 发报集成 / 均值回归方向 / payload
import { createDb, migrate } from '../src/store.js';
import { STOCK_SEED, STOCK_CODES } from '../src/stocks.js';
import {
  DF_ITEM_OBJECT_ID, dfItemRequestUrl, parseDfItemPrice, ensureDfItem,
  dfItemEps, dfItemFair
} from '../src/dfItem.js';
import {
  genNextReport, dfItemSeedFundamentals, industryOf, reportPayload
} from '../src/fundamentals.js';
import { runReports, stepMarket } from '../src/engine.js';
import { marketPayload } from '../src/api.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(Number(a) - Number(b)) < eps;
const quiet = (fn) => {
  const real = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = real; }
};

// ---------------------------------------------------------------- 1
log('=== 1 股票种子：HYZL 海洋之泪 ===');
{
  check('HYZL 在 STOCK_CODES 里', STOCK_CODES.includes('HYZL'), STOCK_CODES.join(','));
  const seed = STOCK_SEED.HYZL;
  check('名字/图标正确', seed.name === '海洋之泪' && seed.icon === '/assets/stocks/HYZL.png');
  check('上市价 100（5 折上市）', seed.initialPrice === 100, String(seed.initialPrice));
  check('平衡价锚定 200', seed.dfAnchorFair === 200, String(seed.dfAnchorFair));
  check('参考物价 = 2026-11 官方均值', seed.dfRefPrice === 31974562, String(seed.dfRefPrice));
  check('物价弹性 power = 1', seed.dfPower === 1, String(seed.dfPower));
  check('股本 20 亿股（初始市值 2000 亿，股价不上调）', seed.shares === 2000000000, String(seed.shares));
  check('100 元上市 → 初始市值 2000 亿', seed.shares * seed.initialPrice === 2e11,
    String(seed.shares * seed.initialPrice));
  check('trait = dfitem', seed.trait.id === 'dfitem');
  check('trait 波动参数 0.5/1.8', seed.trait.volMult === 0.5 && seed.trait.revMult === 1.8);
  check('弱情绪 0.001（防价格飘离 200）', seed.trait.sentStrength === 0.001,
    String(seed.trait.sentStrength));
  check('行业映射到消费（PE 18）', industryOf(seed).pe === 18, String(industryOf(seed).pe));
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 官方 AMS 请求与价格解析 ===');
{
  const url = dfItemRequestUrl();
  check('走 dfm/object.list', url.includes('method=dfm%2Fobject.list') || url.includes('method=dfm/object.list'));
  check('带公开 token', url.includes('sIdeToken=YWRywA'));
  check('param 里是 props/collection', decodeURIComponent(url).includes('"primary":"props"'));
  check('objectID 常量 = 15080050142', DF_ITEM_OBJECT_ID === 15080050142, String(DF_ITEM_OBJECT_ID));

  const sample = {
    ret: 0,
    jData: {
      data: {
        code: 0,
        data: {
          list: [
            { objectID: 15080050142, objectName: '海洋之泪', avgPrice: 31974562, priceChangeRate: 75 },
            { objectID: 1, objectName: '别的物品', avgPrice: 100, priceChangeRate: 1 }
          ]
        }
      }
    }
  };
  const got = parseDfItemPrice(sample);
  check('解析到海洋之泪', got.found === true);
  check('价格 = 31,974,562', got.price === 31974562, String(got.price));
  check('涨跌幅 = 75', got.chg === 75, String(got.chg));
  check('名字正确', got.name === '海洋之泪', got.name);

  const missing = { ret: 0, jData: { data: { data: { list: [{ objectID: 1, avgPrice: 5 }] } } } };
  check('列表里没有该物品 → found=false', parseDfItemPrice(missing).found === false);
  const zero = { jData: { data: { data: { list: [{ objectID: 15080050142, avgPrice: 0 }] } } } };
  check('avgPrice=0（不可交易）→ found=false', parseDfItemPrice(zero).found === false);
  check('脏响应不炸', parseDfItemPrice(null).found === false && parseDfItemPrice({}).found === false);
  check('ensureDfItem 补默认结构', (() => {
    const d = ensureDfItem({});
    return d.price === 0 && d.stale === true && d.at === 0;
  })());
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 EPS / fair 映射公式（锚定 200，power 弹性） ===');
{
  const ref = 31974562;
  const pe = 18;
  const epsRef = 200 / pe;
  check('参考价 → EPS = 200/18', near(dfItemEps({ price: ref, refPrice: ref, power: 1, anchorFair: 200, pe }), epsRef));
  check('参考价 → fair = 200', near(dfItemFair({ price: ref, refPrice: ref, power: 1, anchorFair: 200 }), 200));
  check('物价 +10% → EPS +10%（power=1）',
    near(dfItemEps({ price: ref * 1.1, refPrice: ref, power: 1, anchorFair: 200, pe }), epsRef * 1.1, 1e-9));
  check('物价 +10% → fair 220',
    near(dfItemFair({ price: ref * 1.1, refPrice: ref, power: 1, anchorFair: 200 }), 220, 1e-9));
  check('power=0 → 财报/平衡价不随物价变',
    near(dfItemFair({ price: ref * 2, refPrice: ref, power: 0, anchorFair: 200 }), 200)
    && near(dfItemEps({ price: ref * 2, refPrice: ref, power: 0, anchorFair: 200, pe }), epsRef));
  check('power=2 → 价差平方（1.21 → fair 242）',
    near(dfItemFair({ price: ref * 1.1, refPrice: ref, power: 2, anchorFair: 200 }), 242, 1e-6));
  check('价格 0 → 回退参考价（fair 仍 200）',
    near(dfItemFair({ price: 0, refPrice: ref, power: 1, anchorFair: 200 }), 200));
  check('power 脏值被夹在 0~4', (() => {
    const a = dfItemFair({ price: ref * 2, refPrice: ref, power: -5, anchorFair: 200 });
    const b = dfItemFair({ price: ref * 2, refPrice: ref, power: 99, anchorFair: 200 });
    return a === 200 && near(b, 200 * 16, 1e-6);
  })());
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 财报完全由物价决定：同一价格必须算出同一份财报（无随机） ===');
{
  const st = {
    code: 'HYZL', industry: '消费娱乐', shares: 100000000,
    price: 100, fair: 200, dfRefPrice: 31974562, dfPower: 1, dfAnchorFair: 200,
    trait: { id: 'dfitem' },
    fundamentals: dfItemSeedFundamentals({
      industry: '消费娱乐', shares: 100000000, dfAnchorFair: 200, price: 100
    })
  };
  const origRandom = Math.random;
  let r1 = null;
  let r2 = null;
  try {
    // 分支里不该有任何 Math.random（否则「完全由物价决定」就不成立）
    Math.random = () => { throw new Error('dfitem 财报不应该调用 Math.random'); };
    r1 = genNextReport(st, { dfItemPrice: st.dfRefPrice });
    r2 = genNextReport(st, { dfItemPrice: st.dfRefPrice });
  } finally {
    Math.random = origRandom;
  }
  check('两次发报结果完全一致（零随机）',
    r1 && r2 && near(r1.eps, r2.eps) && near(r1.growth, r2.growth) && near(r1.revenue, r2.revenue),
    `${r1 && r1.eps} vs ${r2 && r2.eps}`);
  check('参考价时 pricing 中性：growth≈0、expectedGrowth=0',
    near(r1.growth, 0, 1e-9) && r1.expectedGrowth === 0, `growth=${r1.growth}`);

  const up = genNextReport(st, { dfItemPrice: st.dfRefPrice * 1.1 });
  const baseEps = Number(st.fundamentals.eps) || 0;
  check('物价 +10% → EPS +10%', near(up.eps, baseEps * 1.1, 1e-9), `${baseEps} → ${up.eps}`);
  check('物价 +10% → 财报增速 ≈ +10%', near(up.growth, 0.1, 1e-6), String(up.growth));
  const down = genNextReport(st, { dfItemPrice: st.dfRefPrice * 0.9 });
  check('物价 −10% → 财报负增长 ≈ −10%', near(down.growth, -0.1, 1e-6), String(down.growth));
  check('物价不动 → 下一期增速 0（不会凭空抖）', (() => {
    const st2 = { ...st, fundamentals: { ...st.fundamentals, eps: up.eps } };
    const same = genNextReport(st2, { dfItemPrice: st.dfRefPrice * 1.1 });
    return near(same.growth, 0, 1e-9);
  })());
  check('抓不到价时沿用上一次发报的价', (() => {
    const st3 = { ...st, dfLastItemPrice: st.dfRefPrice * 1.2, fundamentals: dfItemSeedFundamentals(st) };
    const r = genNextReport(st3, { dfItemPrice: 0 });
    return near(r.eps, (200 / 18) * 1.2, 1e-6);
  })(), '用 dfLastItemPrice');
  check('连上一次价格都没有时才回退参考价', (() => {
    const st4 = { ...st, dfLastItemPrice: 0, fundamentals: dfItemSeedFundamentals(st) };
    const r = genNextReport(st4, { dfItemPrice: 0 });
    return near(r.eps, 200 / 18, 1e-6);
  })(), '按参考价兜底');
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 migrate：新存档自动补出 HYZL（上市价 100 / fair 200） ===');
let db;
{
  db = migrate(createDb());
  const st = db.stocks.HYZL;
  check('migrate 后有 HYZL', !!st);
  check('上市价 100', st.price === 100, String(st.price));
  check('fair = 200（锚定值，不是 100）', near(st.fair, 200, 0.01), String(st.fair));
  check('初始 EPS = 200/PE', near(st.fundamentals.eps, 200 / 18, 1e-6), String(st.fundamentals?.eps));
  check('初始财报 period=0', st.fundamentals.period === 0);
  check('db.dfItem 结构补齐', db.dfItem && db.dfItem.price === 0 && db.dfItem.stale === true);
  check('df 参数同步进存档', st.dfRefPrice === 31974562 && st.dfPower === 1 && st.dfAnchorFair === 200);
  check('trait 的弱情绪也同步', st.trait.sentStrength === 0.001);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 发报集成：物价涨 10% → EPS/Fair/冲击全部跟着走 ===');
{
  const st = db.stocks.HYZL;
  // 隔离：只让 HYZL 本期发报，别让其它票插进来
  db.tick = 1000;                 // runReports 用 `if (!st.nextReportTick)` 判断是否需要排期，tick 不能是 0
  for (const s of Object.values(db.stocks)) {
    if (s !== st) s.nextReportTick = 1e12;
    else s.nextReportTick = db.tick;
  }
  db.config.dividendRate = 0;      // 关派息，便于看纯冲击
  db.dfItem = { price: st.dfRefPrice * 1.1, chg: 0, at: Date.now(), stale: false };
  const epsBefore = Number(st.fundamentals.eps);
  quiet(() => runReports(db));
  check('EPS 涨 10%', near(st.fundamentals.eps, epsBefore * 1.1, 1e-6),
    `${epsBefore.toFixed(4)} → ${st.fundamentals.eps.toFixed(4)}`);
  check('fair 锚到 220（200 × 1.1）', near(st.fair, 220, 0.01), String(st.fair));
  check('财报增速 ≈ 10%', near(st.fundamentals.growth, 0.1, 1e-6), String(st.fundamentals.growth));
  check('市场预期 = 0（没人能猜物价）', st.fundamentals.expectedGrowth === 0);
  check('超预期 ≈ 10%（= 实质增速）', near(st.lastSurprise, 0.1, 1e-6), String(st.lastSurprise));
  check('价格冲击封顶 +6%（引擎规则）', near(st.price, 106, 1e-6), String(st.price));
  check('期数 +1', st.fundamentals.period === 1, String(st.fundamentals.period));
  check('下一期发报时间排上', st.nextReportTick > db.tick, String(st.nextReportTick));
  check('财报历史多一条', Array.isArray(st.reportHistory) && st.reportHistory.length >= 1);
}

// ---------------------------------------------------------------- 7
log('');
log('=== 7 均值回归方向：价格 100 < fair 220 → 应该往上修（不会往下掉） ===');
{
  const st = db.stocks.HYZL;
  for (const s of Object.values(db.stocks)) s.nextReportTick = 1e12;
  Object.assign(db.config, {
    baseVolatility: 0, meanReversion: 0.00017, sentimentEnabled: 0,
    marketTradesEnabled: 0, marketTradesRate: 0, hotMoneyEnabled: 0,
    playerImpactEnabled: 0, eventChance: 0, localEventChance: 0, majorNewsEnabled: 0
  });
  st.price = 100;
  st.fair = 220;
  quiet(() => { for (let i = 0; i < 1000; i += 1) stepMarket(db); });
  check('1000 轮后价格向 220 靠（>110）', st.price > 110, st.price.toFixed(2));
  check('1000 轮后还没超过 fair（理性修复）', st.price < 200, st.price.toFixed(2));
  const p1 = st.price;
  quiet(() => { for (let i = 0; i < 1000; i += 1) stepMarket(db); });
  check('继续向 fair 收敛（单调方向）', st.price > p1, `${p1.toFixed(2)} → ${st.price.toFixed(2)}`);
}

// ---------------------------------------------------------------- 8
log('');
log('=== 8 payload：HYZL 出现、trait 隐藏、估值线用锚定 fair ===');
{
  const st = db.stocks.HYZL;
  st.fair = 220;
  st.fundamentals = { ...st.fundamentals, eps: 12.222 };
  const pay = marketPayload(db, null);
  check('首屏有 HYZL', !!pay.stocks.HYZL, Object.keys(pay.stocks).join(','));
  check('个股字段不含 df 内部参数',
    pay.stocks.HYZL.dfRefPrice === undefined && pay.stocks.HYZL.dfPower === undefined);
  check('trait 不泄露（只留空对象）',
    Object.keys(pay.stocks.HYZL.trait || {}).length === 0, JSON.stringify(pay.stocks.HYZL.trait));
  check('payload 的估值线 = 锚定 fair', near(pay.stocks.HYZL.report.fair, 220, 0.01),
    String(pay.stocks.HYZL.report && pay.stocks.HYZL.report.fair));
  check('reportPayload 也走 st.fair', near(reportPayload(st).fair, 220, 0.01),
    String(reportPayload(st).fair));
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
