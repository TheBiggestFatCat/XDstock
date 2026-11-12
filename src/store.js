import fs from 'node:fs';
import { ensureChat, chatSeqOf } from './chat.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from './config.js';
import { STOCK_SEED, STOCK_CODES, INDEX_BASE, INDEX_STOCK, SMALL_INDEX_STOCK } from './stocks.js';
import { ensureGold } from './gold.js';
import { createTour, ensureTour } from './tour.js';
import { backDerive, fairFromReport, dfItemSeedFundamentals } from './fundamentals.js';
import { ensureDfItem, dfItemFair } from './dfItem.js';
import {
  seedBars15, seedBars5, seedVolFromConfig,
  bar5TicksFor, bar15TicksFor,
  BAR15_MAX, BAR15_SEED_VER, BAR5_MAX, BAR5_SEED_VER
} from './bars15.js';
import { ensureSchedules } from './schedule.js';
import { ensureAchvState, GLOBAL_ACHIEVEMENTS, achvTarget } from './achievements.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const DB_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(AVATAR_DIR, { recursive: true });

let db = null;
let dirty = false;

function freshStock(code) {
  const seed = STOCK_SEED[code];
  return {
    code,
    name: seed.name,
    icon: seed.icon || '',
    industry: seed.industry,
    desc: seed.desc,
    initialPrice: seed.initialPrice,
    trait: seed.trait,
    // 市值天花板（如麦当劳 10000 亿）与整点拉升时间，都是个股专属设定
    capCeiling: Number(seed.capCeiling) || 0,
    // 市值目标（如弦卷财团逐步萎缩到 5000 亿）+ 每期靠近目标的速度
    capTarget: Number(seed.capTarget) || 0,
    capTargetRate: Number(seed.capTargetRate) || 0,
    growthCeiling: Number(seed.growthCeiling) || 0,
    rallyHours: Array.isArray(seed.rallyHours) ? [...seed.rallyHours] : [],
    traitHidden: !!seed.traitHidden,
    // 海洋之泪（HYZL）：物价驱动的财报参数（平衡价锚 + 参考物价 + 弹性）
    dfRefPrice: Number(seed.dfRefPrice) || 0,
    dfPower: Number.isFinite(Number(seed.dfPower)) ? Number(seed.dfPower) : 1,
    dfAnchorFair: Number(seed.dfAnchorFair) || 0,
    price: seed.initialPrice,
    // HYZL 上市价 100、平衡价 200：fair 一开始就是 200，均值回归把价格往上修
    fair: Number(seed.dfAnchorFair) || seed.initialPrice,
    flow: 0,          // 玩家资金冲击累积（正=净买入，负=净卖出）
    mflow: 0,         // 市场资金冲击累积（虚假成交 / 游资，和 flow 分开）
    // 停牌 / 退市
    status: 'normal', // normal | suspended | delisted
    statusUntil: 0,
    series: [seed.initialPrice],
    volSeries: [0],       // 每轮成交量，和 series 一一对应（K 线成交量柱）
  // 15 分钟 K 线单独存一份（48 小时 = 192 根），见 engine.js#pushBar15
  bars15: [],
  bars15Seeded: false,
    streak: 0,
    // 券商特质的活跃度中枢
    brokerMid: DEFAULT_CONFIG.brokerMidpoint
  };
}

export function createDb() {
  const stocks = {};
  // 指数排在最前面
  stocks[INDEX_STOCK.code] = {
    ...freshStock('TGW'),          // 借一份骨架
    code: INDEX_STOCK.code,
    name: INDEX_STOCK.name,
    icon: INDEX_STOCK.icon,
    industry: INDEX_STOCK.industry,
    desc: INDEX_STOCK.desc,
    initialPrice: INDEX_STOCK.initialPrice,
    trait: INDEX_STOCK.trait,
    price: INDEX_BASE,
    fair: INDEX_BASE,
    series: [INDEX_BASE],
    isIndex: true
  };
  for (const code of STOCK_CODES) stocks[code] = freshStock(code);

  return {
    version: 1,
    createdAt: Date.now(),
    startedAt: Date.now(),   // K 线时间轴基准
    tick: 0,
    tickMs: DEFAULT_CONFIG.tickMs,
    config: { ...DEFAULT_CONFIG },
    stocks,
  // 实时汇率：留美外汇的股价由它驱动
  fx: { rate: 0, prevRate: 0, base: 0, at: 0, source: '', stale: true },
    index: { value: INDEX_BASE, series: [INDEX_BASE] },
  smallIndex: { value: INDEX_BASE, series: [INDEX_BASE] },
    // 游资：在板块之间轮动的「一笔资金」，状态见 src/hotmoney.js
    hotMoney: { code: '', industry: '', nextSwitchTick: 0, switches: 0, startedTick: 0 },
    players: {},
    sessions: {},
    adminSessions: {},
    events: [],
    trades: [],          // 交易流水（最多保留 TRADE_LOG_MAX 条）
    notices: [],         // 管理员公告（不影响行情）
    newsPool: [],
    localNewsPool: [],
    tradesThisTick: 0,
    newsPool: [],
    // 锦标赛（独立赛区，见 src/tour.js）
    tour: createTour()
  };
}

export function loadDb() {
  if (db) return db;

  // 1. 先把文件读出来，解析失败也不能动玩家数据
  let parsed = null;
  try {
    if (fs.existsSync(DB_FILE)) {
      parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[store] db.json 解析失败:', e.message);
    try {
      fs.copyFileSync(DB_FILE, DB_FILE + '.broken-' + Date.now());
    } catch { /* ignore */ }
  }

  if (!parsed) {
    // 全新存档也要过一遍 migrate：freshStock 只给骨架，
    // 股本 / 基本面 / 合理价 / K 线都是在 migrate 里补的
    db = migrate(createDb());
    saveDb(true);
    return db;
  }

  // 2. 迁移失败绝不能清空存档：退回未迁移的原始数据继续跑
  try {
    db = migrate(parsed);
    saveDb(true);
    return db;
  } catch (e) {
    console.error('[store] 迁移失败，使用原始数据继续运行:', e.message);
    db = parsed;
    return db;
  }
}

export function migrate(d) {
  const base = createDb();
  const merged = { ...base, ...d };
  merged.config = { ...base.config, ...(d.config || {}) };
  merged.stocks = { ...base.stocks, ...(d.stocks || {}) };
  // 补齐指数标的
  if (!merged.stocks[INDEX_STOCK.code]) {
    merged.stocks[INDEX_STOCK.code] = {
      code: INDEX_STOCK.code,
      name: INDEX_STOCK.name,
      icon: INDEX_STOCK.icon,
      industry: INDEX_STOCK.industry,
      desc: INDEX_STOCK.desc,
      initialPrice: INDEX_STOCK.initialPrice,
      trait: INDEX_STOCK.trait,
      price: merged.index?.value || INDEX_BASE,
      fair: merged.index?.value || INDEX_BASE,
      status: 'normal',
      statusUntil: 0,
      series: (merged.index?.series || [INDEX_BASE]).slice(-3600),
      streak: 0,
      brokerMid: DEFAULT_CONFIG.brokerMidpoint,
      isIndex: true
    };
  }
  merged.stocks[INDEX_STOCK.code].isIndex = true;
  // 指数图标始终以代码为准，换图标不用改存档
  merged.stocks[INDEX_STOCK.code].icon = INDEX_STOCK.icon;

  // 小灯指数：标的和状态都要补
  if (!merged.stocks[SMALL_INDEX_STOCK.code]) {
    merged.stocks[SMALL_INDEX_STOCK.code] = {
      code: SMALL_INDEX_STOCK.code,
      name: SMALL_INDEX_STOCK.name,
      icon: SMALL_INDEX_STOCK.icon,
      industry: SMALL_INDEX_STOCK.industry,
      desc: SMALL_INDEX_STOCK.desc,
      initialPrice: SMALL_INDEX_STOCK.initialPrice,
      trait: SMALL_INDEX_STOCK.trait,
      price: merged.smallIndex?.value || INDEX_BASE,
      fair: merged.smallIndex?.value || INDEX_BASE,
      status: 'normal',
      statusUntil: 0,
      series: (merged.smallIndex?.series || [INDEX_BASE]).slice(-3600),
      streak: 0,
      isIndex: true
    };
  }
  merged.stocks[SMALL_INDEX_STOCK.code].isIndex = true;
  merged.stocks[SMALL_INDEX_STOCK.code].icon = SMALL_INDEX_STOCK.icon;
  if (!merged.smallIndex || typeof merged.smallIndex !== 'object') {
    merged.smallIndex = { value: INDEX_BASE, series: [INDEX_BASE] };
  }

  // 老存档补上汇率缓存
  if (!merged.fx || typeof merged.fx !== 'object') {
    merged.fx = { rate: 0, prevRate: 0, base: 0, at: 0, source: '', stale: true };
  }

  // 老存档：汇率类标的补上新参数
  for (const s2 of Object.values(merged.stocks)) {
    if (s2.trait && s2.trait.id === 'fx') {
      const seed = STOCK_SEED[s2.code]?.trait || {};
      if (typeof s2.trait.fxEnabled !== 'number') s2.trait.fxEnabled = seed.fxEnabled ?? 1;
      if (typeof s2.trait.refreshMs !== 'number') s2.trait.refreshMs = seed.refreshMs ?? 60000;
      if (typeof s2.trait.track !== 'number') s2.trait.track = seed.track ?? 0.06;
      if (typeof s2.trait.coef !== 'number') s2.trait.coef = seed.coef ?? 1;
      if (typeof s2.trait.lev !== 'number') s2.trait.lev = seed.lev ?? 8;
    }
  }

  // 散户情绪：**全局参数是默认值，个股 trait 里的同名字段是「覆盖」**。
  // 老存档曾给每只票都种了一遍出厂默认值（0.004 / 12 / 480~960），
  // 而引擎是「个股优先、全局兜底」，结果全局参数被永久遮住 —— 改全局不生效。
  // 这里做一次性清理：把「等于出厂默认」的个股字段删掉，改回跟随全局。
  // 只跑一次，之后管理面板写进个股的值不会被再清掉。
  if (!merged.sentTraitMigrated) {
    const SENT_DEFAULTS = {
      sentStrength: 0.004,
      sentTicks: 12,
      sentRollTicks: 720,
      sentRollMin: 480,
      sentRollMax: 960
    };
    let cleaned = 0;
    for (const st of Object.values(merged.stocks)) {
      if (st.isIndex || !st.trait) continue;
      for (const [k, dv] of Object.entries(SENT_DEFAULTS)) {
        if (!Number.isFinite(Number(st.trait[k]))) {
          if (k in st.trait) delete st.trait[k];
          continue;
        }
        if (Math.abs(Number(st.trait[k]) - dv) < 1e-9) {
          delete st.trait[k];
          cleaned += 1;
        }
      }
    }
    merged.sentTraitMigrated = true;
    if (cleaned) console.log(`  清理了个股情绪默认值 ${cleaned} 项，改为跟随全局参数`);
  }

  // 分红语义升级：以前 dividendRate 是「绝对派息率」（0.35），现在改成「倍率」（1 = 行业标准）。
  // 老存档里的 0.1~1 会被误当成倍率（等于几乎停发），这里一次性重置。
  if (!merged.dividendMigrated) {
    merged.config.dividendRate = 1;
    if (!(Number(merged.config.dividendCap) > 0.005)) merged.config.dividendCap = 0.015;
    merged.dividendMigrated = true;
    console.log('  分红参数升级为「行业派息率 × 倍率」：倍率 1、封顶 1.5%/期');
  }

  // K 线粒度跟随 tickMs（2026-11：管理员可把 tickMs 改成 2000ms 等）。
  // tickMs 一变，老存档的 series / bars 是按旧节奏攒的：时间轴会混两种 cadence，
  // 5m/15m 会画成「2 分钟 / 6 分钟」一根。这里统一重置成同一节奏的合成历史，
  // 只影响 K 线外观（不动持仓、资金、财报、订单）。
  const tickMsNow = Math.max(1000, Number(merged.config.tickMs) || 5000);
  const b5Ticks = bar5TicksFor(tickMsNow);
  const b15Ticks = bar15TicksFor(tickMsNow);
  const prevTickMs = Math.max(0, Number(merged.tickMsSeen) || 0);
  const tickMsChanged = prevTickMs !== tickMsNow;
  merged.tickMsSeen = tickMsNow;
  if (tickMsChanged) {
    const n = Math.max(60, Math.min(3600, Math.floor(Number(merged.config.historyTicks) || 3600)));
    const sig = Math.max(0.0005, Number(merged.config.baseVolatility) || 0.0022);
    // 从现价往回随机走一段，尾巴接回现价（和 seedBars 同一套观感）
    const synth = (price) => {
      const anchor = Math.max(0.01, Number(price) || 1);
      const out = [anchor];
      let cur = anchor;
      for (let i = 1; i < n; i++) {
        const g = (Math.random() + Math.random() - 1) * sig * 1.4;
        cur = Math.max(0.01, cur / (1 + g));
        out.push(cur);
      }
      out.reverse();
      out[out.length - 1] = anchor;
      return out;
    };
    for (const st of Object.values(merged.stocks)) {
      const px = Math.max(0.01, Number(st.price) || Number(st.initialPrice) || 1);
      st.series = synth(px);
      st.volSeries = new Array(n).fill(0);
      st.bars5 = [];
      st.bars15 = [];
      st.bars5Ver = -1;      // 强制下面按新 tick 数重铺
      st.bars15Ver = -1;
    }
    if (merged.index) merged.index.series = synth(merged.index.value || INDEX_BASE);
    if (merged.smallIndex) merged.smallIndex.series = synth(merged.smallIndex.value || INDEX_BASE);
    const nowMs = Date.now();
    merged.tickTimes = Array.from({ length: n }, (_, i) => nowMs - (n - 1 - i) * tickMsNow);
    merged.tickTimesStart = Math.max(0, (Number(merged.tick) || 0) - n + 1);
    merged.startedAt = nowMs - (Number(merged.tick) || 0) * tickMsNow;
    console.log(`  tickMs ${prevTickMs || '?'} → ${tickMsNow}ms：K 线历史按新节奏重新铺 ${n} 根`);
  }
  for (const st of Object.values(merged.stocks)) {
    st.bars5Ticks = b5Ticks;
    st.bars15Ticks = b15Ticks;
  }

  // 指数标的（DENG / DENGS）也要 15 分钟 K 线，但上面那段按 isIndex 跳过了，这里补
  for (const st of Object.values(merged.stocks)) {
    if (!st.isIndex) continue;
    if (!Array.isArray(st.bars5) || st.bars5.length < 8
      || Number(st.bars5Ver) !== BAR5_SEED_VER) {
      const price5 = Math.max(0.01, Number(st.price) || Number(st.initialPrice) || 1);
      st.bars5 = seedBars5(st.bars5, price5, Number(merged.tick) || 0,
        seedVolFromConfig(merged.config, b5Ticks) * 0.8, b5Ticks);
      st.bars5Seeded = true;
      st.bars5Ver = BAR5_SEED_VER;
    }
    if (st.bars5.length > BAR5_MAX) {
      st.bars5.splice(0, st.bars5.length - BAR5_MAX);
    }
    if (!Array.isArray(st.bars15) || st.bars15.length < 8
      || Number(st.bars15Ver) !== BAR15_SEED_VER) {
      const price = Math.max(0.01, Number(st.price) || INDEX_BASE);
      st.bars15 = seedBars15(st.bars15, price, Number(merged.tick) || 0,
        seedVolFromConfig(merged.config, b15Ticks) * 0.8, b15Ticks);   // 指数波动比个股小一点
      st.bars15Seeded = true;
      st.bars15Ver = BAR15_SEED_VER;
    }
    if (st.bars15.length > BAR15_MAX) {
      st.bars15.splice(0, st.bars15.length - BAR15_MAX);
    }
  }

  // 老存档补上股本与财报（按现价倒推，让 fair ≈ 现价）
  for (const st of Object.values(merged.stocks)) {
    if (st.isIndex) continue;
    const seed = STOCK_SEED[st.code];
    if (!(Number(st.shares) > 0)) st.shares = Number(seed?.shares) || 500000000;
    if (!(Number(st.freeFloat) > 0)) st.freeFloat = Number(seed?.freeFloat) || 0.45;
    if (st.industry === undefined && seed) st.industry = seed.industry;
    // 个股专属设定一律以代码里的种子为准（老存档里没有这些字段，改种子也要能生效）
    if (seed) {
      st.capCeiling = Number(seed.capCeiling) || 0;
      st.capTarget = Number(seed.capTarget) || 0;
      st.capTargetRate = Number(seed.capTargetRate) || 0;
      st.growthCeiling = Number(seed.growthCeiling) || 0;
      st.rallyHours = Array.isArray(seed.rallyHours) ? [...seed.rallyHours] : [];
      st.traitHidden = !!seed.traitHidden;
      // 海洋之泪（HYZL）：物价驱动参数一律以种子为准
      st.dfRefPrice = Number(seed.dfRefPrice) || 0;
      st.dfPower = Number.isFinite(Number(seed.dfPower)) ? Number(seed.dfPower) : 1;
      st.dfAnchorFair = Number(seed.dfAnchorFair) || 0;
      // 股本也跟种子对齐（2026-11 重新上市：20 亿股 / 市值 2000 亿）
      if (seed.trait?.id === 'dfitem' && Number(seed.shares) > 0) st.shares = Number(seed.shares);
    }
    if (!st.fundamentals) {
      st.fundamentals = st.trait?.id === 'dfitem'
        ? dfItemSeedFundamentals(st)
        : backDerive(st, Math.max(0.01, Number(st.price) || Number(st.initialPrice) || 1));
    }
    // 15 分钟 K 线：老档没有就铺满 48 小时（尾部接上现价，图上不会断）。
    // 单根波动直接由 baseVolatility 推（每 tick σ × √180），第一次铺得太安静
    // 会让「最后一根真 K 线」显得像一根大阳线 —— 所以按版本号决定要不要重铺。
    if (!Array.isArray(st.bars5) || st.bars5.length < 8
      || Number(st.bars5Ver) !== BAR5_SEED_VER) {
      const price5 = Math.max(0.01, Number(st.price) || Number(st.initialPrice) || 1);
      st.bars5 = seedBars5(st.bars5, price5, Number(merged.tick) || 0,
        seedVolFromConfig(merged.config, b5Ticks), b5Ticks);
      st.bars5Seeded = true;
      st.bars5Ver = BAR5_SEED_VER;
    }
    if (st.bars5.length > BAR5_MAX) {
      st.bars5.splice(0, st.bars5.length - BAR5_MAX);
    }
    if (!Array.isArray(st.bars15) || st.bars15.length < 8
      || Number(st.bars15Ver) !== BAR15_SEED_VER) {
      const price = Math.max(0.01, Number(st.price) || Number(st.initialPrice) || 1);
      st.bars15 = seedBars15(st.bars15, price, Number(merged.tick) || 0,
        seedVolFromConfig(merged.config, b15Ticks), b15Ticks);
      st.bars15Seeded = true;
      st.bars15Ver = BAR15_SEED_VER;
    }
    if (st.bars15.length > BAR15_MAX) {
      st.bars15.splice(0, st.bars15.length - BAR15_MAX);
    }
    if (!Array.isArray(st.bars15)) st.bars15 = [];
    // 合理价跟着财报走
    st.fair = Number(fairFromReport(st).toFixed(4));
    // 海洋之泪（HYZL）：平衡价锚定 200（×物价/参考价），不受 fairFromReport 的成长溢价影响
    if (st.trait?.id === 'dfitem') {
      st.fair = Number(dfItemFair({
        price: Number(merged.dfItem?.price) || 0,
        refPrice: st.dfRefPrice,
        power: st.dfPower,
        anchorFair: st.dfAnchorFair
      }).toFixed(4));
    }

    // 老存档没有财报历史，按当前这一期的数字往前倒推几期，图表才有东西看。
    // 新上市的票（period 还没几期）不补：否则会编出一串「第 1 期」在前面、真的一期在最后，
    // 图上看起来像期号倒着走（MCD 刚上架构时就踩过这个）
    if (!Array.isArray(st.reportHistory) || !st.reportHistory.length) {
      const f = st.fundamentals || {};
      const g = Number(f.growth) || 0;
      const rev = Number(f.revenue) || 0;
      const np = Number(f.netProfit) || 0;
      const eps = Number(f.eps) || 0;
      const period = Number(f.period) || 0;
      const hist = [];
      if (period >= 6) {
        for (let k = 5; k >= 1; k--) {
          const back = Math.pow(1 + g, -k);
          hist.push({
            period: period - k,
            revenue: rev * back * (1 + (Math.random() - 0.5) * 0.04),
            netProfit: np * back * (1 + (Math.random() - 0.5) * 0.06),
            eps: eps * back,
            growth: g * (1 + (Math.random() - 0.5) * 0.3),
            margin: Number(f.margin) || 0,
            backfill: true
          });
        }
      }
      hist.push({
        period,
        revenue: rev,
        netProfit: np,
        eps,
        growth: g,
        margin: Number(f.margin) || 0
      });
      st.reportHistory = hist;
    } else if ((Number(st.fundamentals?.period) || 0) < 6) {
      // 新票如果存着一堆「倒推」出来的历史，清掉（真实期数还不够，编数据只会更乱）
      st.reportHistory = st.reportHistory.filter((h) => !h.backfill);
    }
    if (typeof st.nextReportTick !== 'number') st.nextReportTick = 0;
  }

  // 老存档补上 ST 字段
  for (const s2 of Object.values(merged.stocks)) {
    if (typeof s2.stTicks !== 'number') s2.stTicks = 0;
    if (typeof s2.st !== 'boolean') s2.st = false;
  }

  // 天气老存档：以前只掷一次骰子就永远冻住（PVZ/HJF 会连续几年负增长）。
  // 解冻时先归零（平平无奇），不用一次随机结果决定这两只票的命运；
  // 从下一期财报开始由引擎正常重掷。
  if (merged.weather && !Number.isFinite(Number(merged.weather.rollTick))) {
    merged.weather = { score: 0, label: '平平无奇', rollTick: Number(merged.tick) || 0 };
    for (const s2 of Object.values(merged.stocks)) {
      if (s2.trait?.id !== 'weather') continue;
      s2.weather = merged.weather;
      s2.weatherTarget = 0;   // 让引擎按新天气重算目标价
    }
  }
  // 天气股：以前「提前靠拢」摆幅太大，两期财报之间会把合理价拖低 27%
  for (const s2 of Object.values(merged.stocks)) {
    if (s2.trait?.id !== 'weather') continue;
    if (typeof s2.trait.anticipate !== 'number' || Math.abs(s2.trait.anticipate - 0.004) < 1e-9) {
      s2.trait.anticipate = 0.001;
    }
  }
  // 指数标的的历史用指数序列补全，否则各周期涨跌幅会算成同一个数
  const idxStock = merged.stocks[INDEX_STOCK.code];
  const idxSeries = merged.index?.series || [];
  if (idxSeries.length > (idxStock.series?.length || 0)) {
    idxStock.series = idxSeries.slice(-(merged.config?.historyTicks || 3600));
  }
  idxStock.price = merged.index?.value ?? idxStock.price;

  // 清理「代码里已经删掉」的标的（这次是退市的 LMFX）：
  // 先把玩家的持仓按最后价格平掉、现金退回，再把挂单撤掉，最后删掉行情。
  // 不加这一步的话，持仓会挂在半空中（前端查不到 stock 直接报错）。
  {
    const keep = new Set([...STOCK_CODES, INDEX_STOCK.code, SMALL_INDEX_STOCK.code]);
    const dropped = Object.keys(merged.stocks).filter((c) => !keep.has(c));
    for (const code of dropped) {
      const st = merged.stocks[code] || {};
      const last = Math.max(0.01, Number(st.price) || 0);
      let settled = 0;
      for (const p of Object.values(merged.players || {})) {
        const pos = p.positions && p.positions[code];
        if (pos) {
          const qty = Number(pos.qty) || 0;
          const entry = Number(pos.entry) || last;
          const dir = pos.side === 'short' ? -1 : 1;
          const pnl = (last - entry) * qty * dir;
          p.cash = (Number(p.cash) || 0) + (Number(pos.margin) || 0) + pnl;
          delete p.positions[code];
          settled += 1;
        }
        // 挂单：同票的全部撤掉，押金按「市价成交」退回
        if (Array.isArray(p.orders)) {
          const keepOrders = [];
          for (const o of p.orders) {
            if (o.code !== code) { keepOrders.push(o); continue; }
            p.cash = (Number(p.cash) || 0) + (Number(o.reserve) || 0);
          }
          p.orders = keepOrders.filter(Boolean);
        }
      }
      delete merged.stocks[code];
      console.log(`  清理已退市标的 ${code}${st.name ? `（${st.name}）` : ''}` +
        (settled ? `，结算了 ${settled} 个持仓` : ''));
    }
  }

  // 金价状态（矿工银行的财报驱动源）
  ensureGold(merged);
  // 三角洲物品价格状态（海洋之泪 HYZL 的财报驱动源；由 server.js 定时抓取）
  ensureDfItem(merged);

  // 补齐新增标的 / 补字段
  for (const code of STOCK_CODES) {
    if (!merged.stocks[code]) {
      merged.stocks[code] = freshStock(code);
    } else if (!merged.stocks[code].icon) {
      merged.stocks[code].icon = STOCK_SEED[code].icon || '';
    }
  }
  merged.players = d.players || {};
  merged.sessions = d.sessions || {};
  merged.adminSessions = d.adminSessions || {};
  merged.events = d.events || [];
  merged.trades = d.trades || [];
  merged.notices = d.notices || [];
  // 市场资金（虚假成交 / 游资）通道：老存档没有 mflow，补 0；
  // 游资状态缺了就补一个空壳（下一次 tick 会自己在板块里开仓）
  for (const s of Object.values(merged.stocks)) {
    if (!Number.isFinite(Number(s.mflow))) s.mflow = 0;
    // 每轮成交量（K 线成交量柱用）：和 series 一一对应，老存档前面补 0
    if (!Array.isArray(s.volSeries)) s.volSeries = [];
    const seriesLen = Array.isArray(s.series) ? s.series.length : 0;
    if (s.volSeries.length < seriesLen) {
      s.volSeries = [...new Array(seriesLen - s.volSeries.length).fill(0), ...s.volSeries];
    }
    if (typeof s.volTick !== 'number') s.volTick = 0;
  }
  // 聊天大厅：消息 / 红包结构补齐（老存档第一次启动就是空的）
  ensureChat(merged);

  // 定时休市计划：一次性 / 每天（脏数据顺手清掉，过期的一次性自动停用）
  ensureSchedules(merged);
  if (!merged.hotMoney || typeof merged.hotMoney !== 'object') {
    merged.hotMoney = { code: '', industry: '', nextSwitchTick: 0, switches: 0, startedTick: 0 };
  }
  // 成交活跃度的长期基准（券商/外汇营收按「相对活跃度」算，见 engine.js#volumeFactorOf）
  if (!(Number(merged.volumeRef) > 0)) {
    merged.volumeRef = Math.max(0.05, Number(merged.volumeAvg) || 0.05);
  }
  // 自愈：券商 / 外汇的营收如果贴着 25% 地板（每期财报都是「同比 0.00%」，
  // 金融大鳄的预览也永远是「符合预期 +0.00%」），把基准营收拉回现值。
  // 只在真的贴地板时才动手，正常存档不会被改。
  for (const st of Object.values(merged.stocks)) {
    if (st.isIndex || !st.fundamentals) continue;
    const id = st.trait && st.trait.id;
    if (id !== 'broker' && id !== 'fx') continue;
    const rev = Number(st.fundamentals.revenue) || 0;
    const base = Number(st.fundamentals.baseRevenue) || 0;
    if (rev > 0 && base > 0 && rev <= base * 0.26) {
      st.fundamentals.baseRevenue = rev;
      console.log(`[券商] ${st.name} 营收贴着地板（${((rev / base) * 100).toFixed(1)}%），基准营收已重置为现值`);
    }
  }
  // 「我的 → 交易记录」：老存档还没有个人流水，从全局日志回填最近 48 小时
  // （全局日志只留 4000 条，回填到多少算多少，之后由 logTrade 持续写）
  {
    const histCut = Date.now() - 48 * 3600 * 1000;
    for (const p of Object.values(merged.players)) {
      if (Array.isArray(p.tradeLog)) continue;
      const mine = (merged.trades || []).filter((t) => t && t.playerId === p.id && t.at >= histCut);
      p.tradeLog = mine.slice(-300);
    }
  }
  // 老的贷款功能已下线，存档里的残留字段一并清掉
  for (const p of Object.values(merged.players)) {
    delete p.loan;
    delete p.bankrupt;
    delete p.bankruptAt;
    delete p.bankruptDebt;
  }
  // LU 2026-11 换了专属特性（反转王 → 早市冲量）：老存档里存的是旧 trait，这里迁移一次。
  // 只在「还是旧 id」时才覆盖，玩家/管理员后来手调过的参数不会被冲掉。
  const luNow = merged.stocks && merged.stocks.LU;
  const luSeed = base.stocks && base.stocks.LU;
  if (luNow && luSeed && luNow.trait && luNow.trait.id === 'reversal') {
    luNow.trait = { ...luSeed.trait };
    delete luNow.streak;                 // 连击计数是旧特性留下的
    luNow.morningSlot = '';
    luNow.morningBase = 0;
  }

  // 老存档补账号等级
  for (const p of Object.values(merged.players || {})) {
    if (!Number.isFinite(Number(p.level)) || Number(p.level) < 1) p.level = 1;
    // 主题拆成了「外观(theme)」和「技能(skill)」两部分：老存档里两者是同一个值
    if (typeof p.skill !== 'string' || !p.skill) p.skill = p.theme || 'default';
    if (typeof p.theme !== 'string' || !p.theme) p.theme = 'default';
    // 老字段名：换主题冷却记在 themeChangedTick，现在只有换技能才吃冷却。
    // -1 = 从没换过技能（这样 tick 0 换技能也能正常开始冷却）
    if (!Number.isFinite(Number(p.skillChangedTick))) {
      const oldTick = Number(p.themeChangedTick);
      p.skillChangedTick = Number.isFinite(oldTick) && oldTick > 0 ? oldTick : -1;
    }
    // 聊天未读红点（2026-11）：老存档没有已读游标，按「这次启动时大厅最新 seq」当基线。
    // 不补历史红点，否则所有老玩家一上线就全是红点；之后的新消息才亮。
    if (!Number.isFinite(Number(p.chatReadSeq))) p.chatReadSeq = chatSeqOf(merged);
    // 主题成就 / 进化字段（老存档补 0，新存档原样保留）
    ensureAchvState(p);
    // 全局成就规则改过：以前「任一子任务完成」就发，现在要求两个都完成。
    // 老存档里那些只完成一个就发出去的，这里作废并退回 40 成就点。
    for (const g of GLOBAL_ACHIEVEMENTS) {
      if (!p.achv || !p.achv[g.id]) continue;
      const allDone = g.tasks.every((t) => {
        const need = achvTarget(merged.config, t.targetKey);
        return (Number(p.achvCounters?.[t.counter]) || 0) + 1e-9 >= need;
      });
      if (allDone) continue;
      delete p.achv[g.id];
      p.achvPoints = Math.max(0, (Number(p.achvPoints) || 0) - 40);
    }
  }
  delete merged.book;
  for (const k of Object.keys(merged.config)) {
    if (k.toLowerCase().includes('loan')) delete merged.config[k];
  }
  // 2026-11 股价上限（fair × maxPremium）已整体移除：老存档里的配置键一并清掉，
  // 否则面板/白名单里都没有它了，存档里还留着一个永远不会生效的旧值。
  delete merged.config.maxPremium;
  merged.newsPool = d.newsPool || [];
  merged.localNewsPool = d.localNewsPool || [];
  if (!d.startedAt) {
    merged.startedAt = Date.now() - (merged.tick || 0) * (merged.tickMs || 5000);
  }
  // 管理员口令统一成 6 位：老的 '0000' 补两个 0
  const ap = String(merged.config.adminPin ?? '000000');
  if (ap.length < 6) merged.config.adminPin = ap.padEnd(6, '0');
  if (merged.closedAt === undefined) merged.closedAt = 0;
  // 老存档没有逐轮时间表：按现在的时间回填一段，保证坐标轴末端就是「现在」
  if (!Array.isArray(merged.tickTimes) || !merged.tickTimes.length) {
    const tms = merged.config.tickMs || 5000;
    const cap = Math.max(600, Number(merged.config.historyTicks ?? 3600) + 600);
    const n = Math.max(1, Math.min(cap, merged.tick + 1));
    const nowMs = Date.now();
    merged.tickTimes = Array.from({ length: n }, (_, i) => nowMs - (n - 1 - i) * tms);
    merged.tickTimesStart = merged.tick - n + 1;
    // 基准也一起对齐，避免回填之前那段用旧基准算出来对不上
    merged.startedAt = nowMs - merged.tick * tms;
  }
  // 锦标赛赛区：老存档没有就补一份（开赛时间 = 下一个 21:00）
  ensureTour(merged);
  return merged;
}

export function getDb() {
  return loadDb();
}

let saveTimer = null;
export function saveDb(immediate = false) {
  dirty = true;
  if (immediate) {
    flush();
    return;
  }
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, 800);
}

function flush() {
  if (!dirty || !db) return;
  dirty = false;
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error('[store] 保存失败:', e.message);
  }
}

// 进程退出前落盘
process.on('SIGINT', () => { flush(); process.exit(0); });
process.on('SIGTERM', () => { flush(); process.exit(0); });
process.on('exit', () => { flush(); });

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = 40;

/** 把当前 db.json 复制一份到 data/backups/，最多保留 40 份 */
export function backupDb(tag = '') {
  try {
    if (!db) return null;
    flush();
    if (!fs.existsSync(DB_FILE)) return null;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
      `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const name = `db-${stamp}${tag ? '-' + tag : ''}.json`;
    const target = path.join(BACKUP_DIR, name);
    fs.copyFileSync(DB_FILE, target);
    // 只保留最近 N 份
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('db-') && f.endsWith('.json'))
      .sort();
    while (files.length > BACKUP_KEEP) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch { /* ignore */ }
    }
    return target;
  } catch (e) {
    console.error('[store] 备份失败:', e.message);
    return null;
  }
}

export function uid(len = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  const buf = new Uint8Array(len);
  globalThis.crypto.getRandomValues(buf);
  for (const b of buf) s += chars[b % chars.length];
  return s;
}

export function now() {
  return Date.now();
}
