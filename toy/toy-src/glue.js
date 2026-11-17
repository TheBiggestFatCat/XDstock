/**
 * XDstock Toy 静态试玩版（纯前端单机）
 *
 * 复用 src/ 里真实的游戏逻辑（stepMarket / 财报 / K 线 / 撮合），
 * 用 shim 把 node:fs/path/url/zlib 换掉：
 *   - db.json 存进 localStorage（虚拟文件系统，见 toy-shims/fs.js）
 *   - /api/* 用 src/api.js#handleApi 直接处理（不再需要 Node HTTP 层）
 *   - /api/stream 用本地定时器 + EventSource 替身推送
 *   - 每 N 秒 stepMarket 推进行情；玩家操作/存档都留在浏览器本地
 */
/* eslint-disable no-console */

// ---------- 浏览器全局 polyfill（必须在 import src 之前） ----------
if (!globalThis.process) {
  globalThis.process = { env: {}, on() {}, exit() {}, nextTick: (cb) => setTimeout(cb, 0) };
}
if (!globalThis.Buffer) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  globalThis.Buffer = {
    byteLength(v) {
      if (typeof v === 'string') return enc.encode(v).length;
      return v && v.length ? v.length : 0;
    },
    from(v, encoding) {
      if (typeof v !== 'string') return new Uint8Array(v);
      if (encoding === 'base64') {
        const bin = atob(v);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      }
      return enc.encode(v);
    },
    toString(v) { return dec.decode(v); }
  };
}

const TOKEN_KEY = 'xd_token';
const DEMO_VERSION = 'toy-demo-v1';

// ---------- 加载真实游戏逻辑 ----------
const { getDb, saveDb, saveDbAuto, now } = await import('./src/store.js');
const {
  stepMarket, seedHistory, changesFor, liveIndexWeights
} = await import('./src/engine.js');
const { stockWire, positionWire } = await import('./src/wire.js');
const { playerEquity, checkPositions } = await import('./src/trading.js');
const { processOrders, fillCapFor } = await import('./src/orders.js');
const { marketPhase, phaseText } = await import('./src/schedule.js');
const { checkDelist } = await import('./src/delist.js');
const { autoDcaTick } = await import('./src/autoDca.js');
const { nightInfoFor } = await import('./src/theme.js');
const { achvPayload } = await import('./src/achievements.js');
const { notifyList } = await import('./src/notify.js');
const { visibleEmotes } = await import('./src/emoji.js');
const { latestVersionPost } = await import('./src/version.js');
const { chatUnreadFor } = await import('./src/chat.js');
const { timeframeTicks } = await import('./src/config.js');
const { NEWS_POOL, MAJOR_NEWS_POOL } = await import('./src/news.js');
const { handleApi } = await import('./src/api.js');
const { getBuild } = await import('./src/build.js');
const { __persistNow: persistFs } = await import('./toy-shims/fs.js');

// ---------- 初始化试玩存档 ----------
const DEMO_CFG = {
  tickMs: 5000,             // 5 秒一轮，方便观看
  historyTicks: 1800,       // 控制 localStorage 体积
  startingCash: 200000,     // 试玩版直接给 20 万起步，不用先打工
  marketCycleEnabled: 0,    // 试玩版不自动休市
  marketOpen: 1,
  reportIntervalTicks: 120  // 10 分钟一期财报
};

function applyDemoConfig(db) {
  let changed = false;
  for (const [k, v] of Object.entries(DEMO_CFG)) {
    if (db.config[k] !== v) { db.config[k] = v; changed = true; }
  }
  return changed;
}

const db = getDb();
db.newsPool = NEWS_POOL;
db.majorPool = MAJOR_NEWS_POOL;
db.localNewsPool = [];
db.events = (db.events || []).filter((e) => typeof e.leakTicks === 'number');
if (!db.dfItem || !(Number(db.dfItem.price) > 0)) {
  db.dfItem = { price: 31974562, chg: 0, at: Date.now(), stale: false };
}
let bootChanged = applyDemoConfig(db);
const coldStart = db.tick === 0 && Object.values(db.stocks).every(
  (st) => !Array.isArray(st.series) || st.series.length <= 1);
if (coldStart) {
  // 和 Node 版首次启动一致：先空跑一段历史把 K 线铺满
  try { seedHistory(db, 1800); } catch (e) { console.warn('[toy] seedHistory 失败', e); }
  bootChanged = true;
}
if (db.__toyDemo !== DEMO_VERSION) { db.__toyDemo = DEMO_VERSION; bootChanged = true; }
// 老试玩存档里可能有上一版塞进去的本地 bot，纯单机版清掉
for (const id of Object.keys(db.players || {})) {
  if (/^toybot/.test(id)) { delete db.players[id]; bootChanged = true; }
}
if (bootChanged) saveDb(true);

// ---------- Toy 容器：全服排行榜（唯一保留的联机能力） ----------
// Toy JS SDK 由 index.html 里的 //s1.hdslb.com/.../toy-sdk.js 注入，暴露 window.toy。
// 注意：/toy/preview/ 预览页禁止写操作，submitScore 会 reject，这里静默忽略。
const TOY_BOARD = 1;               // Toy 排行榜板位 1~5，默认 1
const TOY_SCORE_MAX = 16777215;    // SDK 限制 score ∈ [-2^24, 2^24-1]
let toySdkState = null;            // null=未探测，false=不可用，object=SDK
let toyRankCache = { at: 0, rows: [] };
let toyScoreLastAt = 0;

function inToyPreview() {
  return /\/toy\/preview\//.test(location.pathname);
}
function inToyContainerPath() {
  return /\/toy\//.test(location.pathname);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    sleep(ms).then(() => fallback)
  ]);
}
function setRankNote(text) {
  const el = document.querySelector('#toyRankNote');
  if (el) el.textContent = text;
}
async function getToySdk() {
  if (toySdkState !== null) return toySdkState || null;
  // 本地预览（非 Toy 路径）不去等 SDK，直接走本地兜底
  if (!inToyContainerPath()) { toySdkState = false; return null; }
  for (let i = 0; i < 40 && !window.toy; i++) {
    await sleep(100);
  }
  if (!window.toy) { toySdkState = false; return null; }
  try {
    // isSupport 不依赖登录态，用来判断是否真的跑在 Toy 容器里
    const ok = await withTimeout(window.toy.isSupport('getRankList'), 1500, false);
    if (!ok) { toySdkState = false; return null; }
    toySdkState = window.toy;
    return toySdkState;
  } catch {
    toySdkState = false;
    return null;
  }
}

/** Toy 排行榜返回结构做兼容：items / list / data.items 都认 */
function pickRankItems(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  for (const key of ['items', 'list', 'rows', 'rankList', 'data']) {
    const v = raw[key];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const inner = pickRankItems(v);
      if (inner.length) return inner;
    }
  }
  return [];
}
function normalizeToyRows(raw) {
  return pickRankItems(raw).map((it, i) => {
    const row = it && typeof it === 'object' ? it : {};
    const u = row.user || row.player || row.account || row.member || row;
    const score = Number(row.score ?? row.value ?? row.total ?? row.equity
      ?? u.score ?? u.total ?? 0) || 0;
    const uid = u.mid ?? u.uid ?? u.id ?? u.toyOpenId ?? u.toy_open_id
      ?? row.mid ?? row.uid ?? ('toy-' + (i + 1));
    let avatar = u.avatar || u.face || row.avatar || null;
    if (typeof avatar === 'string' && avatar.startsWith('//')) avatar = 'https:' + avatar;
    return {
      id: 'toy_' + uid,
      nickname: String(u.nickname || u.uname || u.name || row.nickname || ('玩家' + (i + 1))),
      avatar,
      level: Math.max(1, Number(row.level) || 1),
      cash: 0,
      equity: score,
      bank: 0,
      total: score,
      achvEmojis: []
    };
  }).filter((r) => r.nickname && Number.isFinite(r.total));
}
async function fetchToyRank() {
  if (Date.now() - toyRankCache.at < 15000) return toyRankCache.rows;
  const toy = await getToySdk();
  if (!toy) return [];
  const raw = await withTimeout(
    toy.getRankList({ board: TOY_BOARD, period: 'all', limit: 50 }),
    2500,
    null
  );
  if (!raw) return [];
  const rows = normalizeToyRows(raw)
    .sort((a, b) => b.total - a.total)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  toyRankCache = { at: Date.now(), rows };
  return rows;
}
function currentLocalPlayer() {
  try {
    const token = localStorage.getItem(TOKEN_KEY) || '';
    const s = token ? getDb().sessions[token] : null;
    return s ? getDb().players[s.playerId] : null;
  } catch {
    return null;
  }
}
function localTotalAssets(p) {
  return playerEquity(getDb(), p) + Math.max(0, Number(p.bank) || 0);
}
/** 提交总资产到 Toy 排行榜；预览页 / 限流 / 未登录都静默失败 */
async function submitToyScore(force = false) {
  const toy = await getToySdk();
  if (!toy || inToyPreview()) return;
  const t = Date.now();
  if (!force && t - toyScoreLastAt < 60000) return;
  toyScoreLastAt = t;
  const p = currentLocalPlayer();
  if (!p) return;
  const score = Math.max(1, Math.min(TOY_SCORE_MAX, Math.floor(localTotalAssets(p))));
  try {
    await toy.submitScore({ board: TOY_BOARD, score });
  } catch {
    // 307044 限流 / 预览环境 / 未登录：单机玩法不受影响
  }
}
window.addEventListener('pagehide', () => { submitToyScore(true); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') submitToyScore(true);
});

// ---------- tickPayload（从 server.js 复制，去掉 Node 相关部分） ----------
function phaseNow(d) {
  return marketPhase(d, now());
}

const onlineIds = new Set();

function tickPayload(forPlayerId) {
  const d = getDb();
  const tp = forPlayerId ? d.players[forPlayerId] : null;
  const stocks = {};
  for (const [code, st] of Object.entries(d.stocks)) {
    stocks[code] = stockWire(d, st, tp);
  }
  let me = null;
  if (forPlayerId && d.players[forPlayerId]) {
    const p = d.players[forPlayerId];
    const positions = {};
    for (const [code, pos] of Object.entries(p.positions || {})) {
      const st = d.stocks[code];
      if (!st) continue;
      positions[code] = positionWire(pos, st);
    }
    me = {
      cash: p.cash,
      equity: playerEquity(d, p),
      positions,
      workBank: Math.round((p.workBank || 0) * 100) / 100,
      workEarned: p.workEarned || 0,
      workOnline: onlineIds.has(p.id),
      stealQueued: p.stealQueued || null,
      stealEarned: p.stealEarned || 0,
      stealReadyAt: p.stealReadyAt || 0,
      night: nightInfoFor(d, p),
      investigateReadyAt: Number(p.investigateReadyAt) || 0,
      guardUntil: p.guardUntil || 0,
      fakeNewsReadyAt: p.fakeNewsReadyAt || 0,
      channelLevel: p.channelLevel || 0,
      redBonusEarned: p.redBonusEarned || 0,
      bearBonusEarned: p.bearBonusEarned || 0,
      frozen: Math.round((p.orders || []).reduce((a, o) => a + (Number(o.reserve) || 0), 0) * 100) / 100,
      fillCap: fillCapFor(d, p),
      autoDca: !!p.autoDca,
      autoDcaOn: p.autoDcaOn !== false,
      freeFeeUntilTick: Number(p.freeFeeUntilTick) || 0,
      freeFeeReadyAt: Number(p.freeFeeReadyAt) || 0,
      hotTipReadyAt: Number(p.hotTipReadyAt) || 0,
      bank: Math.round((Number(p.bank) || 0) * 100) / 100,
      bankDeposited: Math.round((Number(p.bankDeposited) || 0) * 100) / 100,
      orders: (p.orders || []).map((o) => ({
        id: o.id,
        code: o.code,
        name: o.name,
        action: o.action,
        side: o.side,
        qty: o.qty,
        limit: o.limit,
        leverage: o.leverage,
        reserve: Math.round((o.reserve || 0) * 100) / 100,
        expireTick: o.expireTick,
        createdAt: o.createdAt,
        auto: o.auto || null,
        autoDca: !!o.autoDca,
        simple: !!o.simple
      })),
      achv: achvPayload(d, p),
      notices: notifyList(p, 20),
      chatUnread: chatUnreadFor(d, p)
    };
  }
  const phase = phaseNow(d);
  return {
    type: 'tick',
    build: getBuild(),
    tick: d.tick,
    emotes: visibleEmotes(d),
    versionPost: latestVersionPost(d),
    closed: phase.open === false,
    closedReason: phase.reason,
    closedLabel: phase.label,
    closedText: phaseText(phase, now()),
    closedUntil: phase.nextOpenAt,
    nextChangeAt: phase.nextChangeAt,
    index: d.index.value,
    indexChanges: changesFor(d.index.series, timeframeTicks(d.config.tickMs)),
    indexWeights: (() => {
      const live = liveIndexWeights(d, 'index');
      return Object.entries(d.index.weights || {}).map(([code, w]) => {
        const st2 = d.stocks[code] || {};
        const px2 = Number(st2.price) || 0;
        return {
          code, name: st2.name || code, weight: w,
          liveWeight: Number(live[code]) || 0,
          freeCap: px2 * (Number(st2.shares) || 0) * (Number(st2.freeFloat) || 0.45)
        };
      }).sort((a, b) => b.weight - a.weight);
    })(),
    smallIndex: (() => {
      const live = liveIndexWeights(d, 'smallIndex');
      return {
        value: Number(d.smallIndex?.value) || 0,
        weights: Object.entries(d.smallIndex?.weights || {}).map(([code, w]) => {
          const st2 = d.stocks[code] || {};
          const px2 = Number(st2.price) || 0;
          return {
            code, name: st2.name || code, weight: w,
            liveWeight: Number(live[code]) || 0,
            freeCap: px2 * (Number(st2.shares) || 0) * (Number(st2.freeFloat) || 0.45)
          };
        }).sort((a, b) => b.weight - a.weight),
        nextRebalanceTick: Number(d.smallIndex?.nextRebalanceTick) || 0,
        rebalanceTick: Number(d.smallIndex?.rebalanceTick) || 0
      };
    })(),
    stocks,
    config: {
      minLeverage: d.config.minLeverage,
      maxLeverage: d.config.maxLeverage,
      feeRate: d.config.feeRate,
      stampDuty: d.config.stampDuty,
      workRatePerTick: d.config.workRatePerTick ?? 50,
      workOnlineMultiplier: d.config.workOnlineMultiplier ?? 2,
      workBankTicks: d.config.workBankTicks ?? 1440
    },
    notices: (d.notices || [])
      .filter((n) => n && n.announced !== false)
      .map((n) => ({
        id: n.id, text: n.text, at: n.at,
        kind: n.kind || null,
        href: n.href || null,
        ageTicks: Number(n.tick) > 0 ? Math.max(0, d.tick - Number(n.tick)) : null,
        leftTicks: Number(n.expireTick) > 0 ? Math.max(0, Number(n.expireTick) - d.tick) : null
      })),
    events: (d.events || [])
      .filter((e) => e.announced !== false)
      .map((e) => ({
        id: e.id,
        text: e.text,
        companies: e.companies,
        dir: e.dir || (e.trend > 0 ? 1 : -1),
        major: !!e.major,
        leftTicks: e.major ? Math.max(0, Number(e.remaining) || 0) : undefined,
        createdAt: e.createdAt,
        ageTicks: Number(e.createdTick) > 0
          ? Math.max(0, d.tick - Number(e.createdTick))
          : Math.max(0, (Number(e.duration) || 0) - (Number(e.remaining) || 0))
      })),
    me
  };
}

// ---------- 本地 SSE（EventSource 替身） ----------
const clients = new Set();

class DemoSse {
  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.onmessage = null;
    this.onerror = null;
    this.onopen = null;
    this._listeners = {};
    this._closed = false;
    this.playerId = null;
    try {
      const u = new URL(this.url, location.href);
      const token = u.searchParams.get('token') || '';
      const s = token ? getDb().sessions[token] : null;
      this.playerId = s ? s.playerId : null;
    } catch { /* ignore */ }
    clients.add(this);
    setTimeout(() => {
      if (this._closed) return;
      this.readyState = 1;
      this._emit('open', {});
    }, 100);
  }
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  _emit(type, ev) {
    for (const fn of this._listeners[type] || []) {
      try { fn(ev); } catch (e) { console.error('[toy] SSE listener', e); }
    }
    const h = this['on' + type];
    if (typeof h === 'function') {
      try { h(ev); } catch (e) { console.error('[toy] SSE handler', e); }
    }
  }
  deliver(data) {
    if (this._closed) return;
    this._emit('message', { data });
  }
  close() {
    this._closed = true;
    this.readyState = 2;
    clients.delete(this);
  }
}
window.EventSource = DemoSse;

// ---------- 本地 fetch 路由到 src/api.js#handleApi ----------
function headersToObject(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === 'function') {
    h.forEach((v, k) => { out[String(k).toLowerCase()] = v; });
    return out;
  }
  for (const [k, v] of Object.entries(h)) out[String(k).toLowerCase()] = v;
  return out;
}
function decodeBody(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  return String(data);
}

async function mockApiRequest(url, init) {
  const method = String(init.method || 'GET').toUpperCase();
  const headers = headersToObject(init.headers);
  headers['accept-encoding'] = '';       // 不走 gzip，浏览器端直接拿 JSON
  let body = {};
  if (init.body) {
    try { body = JSON.parse(typeof init.body === 'string' ? init.body : decodeBody(init.body)); }
    catch { body = {}; }
  }
  const query = Object.fromEntries(url.searchParams.entries());
  const req = {
    method,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    on() {}
  };
  let done = false;
  let resolveRes;
  const waited = new Promise((r) => { resolveRes = r; });
  const res = {
    statusCode: 200,
    headersSent: false,
    req,
    writeHead(code, hdrs) {
      this.statusCode = code;
      this.headersSent = true;
      this._headers = hdrs || {};
    },
    setHeader(k, v) {
      this._headers = this._headers || {};
      this._headers[String(k)] = v;
    },
    end(data) {
      if (done) return;
      done = true;
      resolveRes({ status: this.statusCode || 200, headers: this._headers || {}, body: decodeBody(data) });
    }
  };
  try {
    await handleApi({ req, res, method, pathname: url.pathname, query, body, headers });
  } catch (e) {
    console.error('[toy] api error', url.pathname, e);
    if (!done) {
      return {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: '试玩版接口出错: ' + (e && e.message) })
      };
    }
  }
  // handleApi 没 end 的兜底
  const timeout = new Promise((r) => setTimeout(() => r({ status: 500, headers: {}, body: JSON.stringify({ error: '接口超时' }) }), 8000));
  const result = await Promise.race([waited, timeout]);
  // 写操作立刻落盘：否则登录/下单后马上刷新页面会丢会话（Node 版靠 800ms 防抖 + 进程常驻）
  if (method !== 'GET' || url.pathname === '/api/market') {
    try { saveDb(true); persistFs(); } catch (e) { console.warn('[toy] 立即存档失败', e); }
  }
  return result;
}

const realFetch = window.fetch.bind(window);

// 纯单机版：除了排行榜，所有涉及其他玩家的联机接口一律关闭
const BLOCKED_APIS = new Set([
  '/api/steal', '/api/investigate', '/api/emote',
  '/api/chat', '/api/chat/read', '/api/chat/emoji', '/api/chat/grab', '/api/chat/packet',
  '/api/shop/fakeNews', '/api/shop/bodyguard'
]);
function jsonReply(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

window.fetch = async (input, init = {}) => {
  let url;
  try {
    url = new URL(typeof input === 'string' ? input : input.url, location.href);
  } catch {
    return realFetch(input, init);
  }
  if (url.origin !== location.origin) return realFetch(input, init);
  if (url.pathname.startsWith('/avatars/')) return new Response('', { status: 404 });
  if (!url.pathname.startsWith('/api/') || url.pathname === '/api/stream') return realFetch(input, init);

  if (BLOCKED_APIS.has(url.pathname)) {
    return jsonReply({ error: '单机版不提供该联机功能' }, 403);
  }

  // 排行榜是唯一保留的联机功能：优先读 Toy 全服榜，读不到再退回本地
  if (url.pathname === '/api/leaderboard' && String(init.method || 'GET').toUpperCase() === 'GET') {
    submitToyScore();   // 打开排行榜时顺手同步一次成绩（受 60 秒节流，预览页会跳过）
    try {
      const rows = await fetchToyRank();
      if (rows.length) {
        setRankNote(inToyPreview()
          ? `Toy 全服排行榜（预览环境，成绩需正式发布后才写入）`
          : `Toy 全服排行榜 · 第 ${TOY_BOARD} 榜`);
        return jsonReply({ rows, source: 'toy' });
      }
    } catch {
      // 未登录 / 排行榜未开通 / 网络问题：退回本地
    }
    setRankNote(inToyPreview()
      ? '预览环境：Toy 排行榜暂无数据，显示本地排行'
      : '未连接 Toy 容器（或排行榜为空），显示本地排行');
  }

  const r = await mockApiRequest(url, init);
  return new Response(r.body, { status: r.status, headers: r.headers });
};

// ---------- 推进行情 ----------
function broadcastTick() {
  const base = tickPayload(null);
  for (const c of clients) {
    try {
      const personal = tickPayload(c.playerId);
      c.deliver(JSON.stringify({ ...base, me: personal.me }));
    } catch (e) {
      console.error('[toy] 推送失败', e);
    }
  }
}

function gameTick() {
  const d = getDb();
  try {
    stepMarket(d);
  } catch (e) { console.error('[toy] stepMarket', e); }
  try { checkDelist(d); } catch (e) { console.error('[toy] delist', e); }
  try { processOrders(d); } catch (e) { console.error('[toy] orders', e); }
  try { checkPositions(d); } catch (e) { console.error('[toy] positions', e); }
  try { autoDcaTick(d); } catch (e) { console.error('[toy] autoDca', e); }

  // 打工：在线玩家每轮攒钱（和 Node 版口径一致）
  const online = new Set();
  for (const c of clients) if (c.playerId) online.add(c.playerId);
  onlineIds.clear();
  for (const id of online) onlineIds.add(id);
  const rate = Math.max(0, Number(d.config.workRatePerTick ?? 50));
  const mult = Math.max(1, Number(d.config.workOnlineMultiplier ?? 2));
  const cap = rate * Math.max(1, Number(d.config.workBankTicks ?? 1440));
  if (rate > 0) {
    for (const p of Object.values(d.players || {})) {
      if (!online.has(p.id)) continue;
      p.workBank = Math.min(cap, (Number(p.workBank) || 0) + rate * mult);
    }
  }
  saveDbAuto();
  broadcastTick();
  // 每隔约 1 分钟把总资产同步到 Toy 排行榜（预览页/限流会静默失败）
  if (Number(d.tick) % 12 === 0) submitToyScore();
}

const tickMs = Math.max(1000, Number(db.config.tickMs) || 5000);
setInterval(gameTick, tickMs);

// ---------- 启动前端 ----------
window.__XD_TOY_DEMO__ = { version: DEMO_VERSION, getDb };
await import('./app.js');
