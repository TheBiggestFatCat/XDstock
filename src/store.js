import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from './config.js';
import { STOCK_SEED, STOCK_CODES, INDEX_BASE, INDEX_STOCK } from './stocks.js';

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
    index: { value: INDEX_BASE, series: [INDEX_BASE] },
    players: {},
    sessions: {},
    adminSessions: {},
    events: [],
    trades: [],          // 交易流水（最多保留 TRADE_LOG_MAX 条）
    notices: [],         // 管理员公告（不影响行情）
    newsPool: [],
    localNewsPool: [],
    tradesThisTick: 0,
    book: [], // 天台楼下记录册
    newsPool: []
  };
}

export function loadDb() {
  if (db) return db;
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      db = migrate(parsed);
      return db;
    }
  } catch (e) {
    console.error('[store] 读取 db.json 失败，将使用全新存档:', e.message);
    try {
      fs.copyFileSync(DB_FILE, DB_FILE + '.broken-' + Date.now());
    } catch { /* ignore */ }
  }
  db = createDb();
  saveDb(true);
  return db;
}

function migrate(d) {
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
  merged.book = d.book || [];
  merged.newsPool = d.newsPool || [];
  merged.localNewsPool = d.localNewsPool || [];
  if (!d.startedAt) {
    merged.startedAt = Date.now() - (merged.tick || 0) * (merged.tickMs || 5000);
  }
  // 管理员口令统一成 6 位：老的 '0000' 补两个 0
  const ap = String(merged.config.adminPin ?? '000000');
  if (ap.length < 6) merged.config.adminPin = ap.padEnd(6, '0');
  if (merged.closedAt === undefined) merged.closedAt = 0;
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
