import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from './config.js';
import { STOCK_SEED, STOCK_CODES, INDEX_BASE, INDEX_STOCK, SMALL_INDEX_STOCK } from './stocks.js';
import { backDerive, fairFromReport } from './fundamentals.js';

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
    price: seed.initialPrice,
    fair: seed.initialPrice,
    flow: 0,          // 玩家资金冲击累积（正=净买入，负=净卖出）
    // 停牌 / 退市
    status: 'normal', // normal | suspended | delisted
    statusUntil: 0,
    series: [seed.initialPrice],
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
    players: {},
    sessions: {},
    adminSessions: {},
    events: [],
    trades: [],          // 交易流水（最多保留 TRADE_LOG_MAX 条）
    notices: [],         // 管理员公告（不影响行情）
    newsPool: [],
    localNewsPool: [],
    tradesThisTick: 0,
    newsPool: []
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
    db = createDb();
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

  // 老存档补上股本与财报（按现价倒推，让 fair ≈ 现价）
  for (const st of Object.values(merged.stocks)) {
    if (st.isIndex) continue;
    const seed = STOCK_SEED[st.code];
    if (!(Number(st.shares) > 0)) st.shares = Number(seed?.shares) || 500000000;
    if (!(Number(st.freeFloat) > 0)) st.freeFloat = Number(seed?.freeFloat) || 0.45;
    if (st.industry === undefined && seed) st.industry = seed.industry;
    if (!st.fundamentals) {
      st.fundamentals = backDerive(st, Math.max(0.01, Number(st.price) || Number(st.initialPrice) || 1));
    }
    // 合理价跟着财报走
    st.fair = Number(fairFromReport(st).toFixed(4));

    // 老存档没有财报历史，按当前这一期的数字往前倒推几期，图表才有东西看
    if (!Array.isArray(st.reportHistory) || !st.reportHistory.length) {
      const f = st.fundamentals || {};
      const g = Number(f.growth) || 0;
      const rev = Number(f.revenue) || 0;
      const np = Number(f.netProfit) || 0;
      const eps = Number(f.eps) || 0;
      const period = Number(f.period) || 0;
      const hist = [];
      for (let k = 5; k >= 1; k--) {
        const back = Math.pow(1 + g, -k);
        hist.push({
          period: Math.max(1, period - k),
          revenue: rev * back * (1 + (Math.random() - 0.5) * 0.04),
          netProfit: np * back * (1 + (Math.random() - 0.5) * 0.06),
          eps: eps * back,
          growth: g * (1 + (Math.random() - 0.5) * 0.3),
          margin: Number(f.margin) || 0,
          backfill: true
        });
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
  // 老的贷款功能已下线，存档里的残留字段一并清掉
  for (const p of Object.values(merged.players)) {
    delete p.loan;
    delete p.bankrupt;
    delete p.bankruptAt;
    delete p.bankruptDebt;
  }
  // 老存档补账号等级
  for (const p of Object.values(merged.players || {})) {
    if (!Number.isFinite(Number(p.level)) || Number(p.level) < 1) p.level = 1;
  }
  delete merged.book;
  for (const k of Object.keys(merged.config)) {
    if (k.toLowerCase().includes('loan')) delete merged.config[k];
  }
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
