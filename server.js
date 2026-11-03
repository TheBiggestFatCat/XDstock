import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, saveDb, now, backupDb } from './src/store.js';
import { getBuild } from './src/build.js';
import { stepMarket, seedHistory, changesFor, noticeAlive } from './src/engine.js';
import { TIMEFRAMES } from './src/config.js';
import { checkPositions, playerEquity, positionPnl, logTrade } from './src/trading.js';
import { processOrders, fillCapFor } from './src/orders.js';
import { autoDcaTick } from './src/autoDca.js';
import { checkDelist } from './src/delist.js';
import { fetchAudJpy } from './src/fx.js';
import { handleApi } from './src/api.js';
import { NEWS_POOL } from './src/news.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const PORT = Number(process.env.PORT || 8971);

const db = getDb();
// 新闻池以代码为准，每次启动都刷新（改 news.js 后重启即可生效）
db.newsPool = NEWS_POOL;
db.localNewsPool = [];
// 清掉旧机制留下的新闻（没有 leakTicks 字段的都是上一版的）
const stale = (db.events || []).filter((e) => typeof e.leakTicks !== 'number');
db.events = (db.events || []).filter((e) => typeof e.leakTicks === 'number');
if (stale.length) console.log(`  清理了 ${stale.length} 条旧格式新闻`);
saveDb(true);

// 全新存档：先空跑两小时把 K 线铺出来
if (db.tick === 0 && Object.values(db.stocks).every((s) => s.series.length <= 1)) {
  console.log('  首次启动，正在生成历史 K 线…');
  seedHistory(db, 2400);
  saveDb(true);
  console.log(`  已铺满 ${db.tick} 轮历史`);
}

// ---------------- SSE ----------------
const clients = new Set();
let onlineIds = new Set();   // 本轮有 SSE 连接的玩家

function broadcast(payload, targetPlayerId = null) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) {
    if (targetPlayerId && c.playerId !== targetPlayerId) continue;
    try {
      c.res.write(data);
    } catch {
      clients.delete(c);
    }
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

function serveStatic(res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const noCache = ['.html', '.js', '.css', '.webmanifest'].includes(ext);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache, must-revalidate' : 'public, max-age=3600'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------- HTTP ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  // CORS（本地开发方便）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // SSE
  if (pathname === '/api/stream') {
    const token = url.searchParams.get('token') || '';
    const d = getDb();
    const s = token ? d.sessions[token] : null;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    const client = { res, playerId: s ? s.playerId : null, token };
    clients.add(client);
    // 心跳，防止代理断开
    const hb = setInterval(() => {
      try {
        res.write(': hb\n\n');
      } catch {
        clearInterval(hb);
        clients.delete(client);
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(hb);
      clients.delete(client);
    });
    return;
  }

  // 头像
  if (pathname.startsWith('/avatars/')) {
    const name = path.basename(pathname);
    return serveStatic(res, path.join(DATA_DIR, 'avatars', name));
  }

  // API
  if (pathname.startsWith('/api/')) {
    let body = {};
    if (req.method === 'POST') {
      try {
        const raw = await readBody(req);
        body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '请求体解析失败' }));
        return;
      }
    }
    const query = Object.fromEntries(url.searchParams.entries());
    try {
      await handleApi({ req, res, method: req.method, pathname, query, body, headers: req.headers });
    } catch (e) {
      console.error('[api]', pathname, e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '服务器内部错误: ' + e.message }));
      }
    }
    return;
  }

  // 静态资源
  let rel = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('403');
    return;
  }
  return serveStatic(res, full);
});

// ---------------- 游戏主循环 ----------------
function tickPayload(forPlayerId) {
  const d = getDb();
  const tp = forPlayerId ? d.players[forPlayerId] : null;
  const isTycoon = tp && tp.theme === 'tycoon';
  const stocks = {};
  for (const [code, st] of Object.entries(d.stocks)) {
    const prev = st.series.length > 1 ? st.series[st.series.length - 2] : st.price;
    stocks[code] = {
      price: Number(st.price.toFixed(4)),
      changePct: prev ? ((st.price - prev) / prev) * 100 : 0,
      changes: changesFor(st.series, TIMEFRAMES),
      status: st.status
    };
    // 金融大鳄：每轮都下发预览状态，否则前端只在刷新时才知道
    if (isTycoon && !st.isIndex) {
      const pend = st.pendingReport;
      stocks[code].preview = pend
        ? {
          eps: Number(pend.eps) || 0,
          revenue: Number(pend.revenue) || 0,
          netProfit: Number(pend.netProfit) || 0,
          growth: Number(pend.growth) || 0,
          tickLeft: Math.max(0, (Number(st.nextReportTick) || 0) - d.tick),
          expectPct: (() => {
            const oldEps = Number(st.fundamentals?.eps) || 0;
            return oldEps > 0 ? ((Number(pend.eps) || 0) / oldEps - 1) * 100 : 0;
          })()
        }
        : null;
    }
  }
  let me = null;
  if (forPlayerId && d.players[forPlayerId]) {
    const p = d.players[forPlayerId];
    const positions = {};
    for (const [code, pos] of Object.entries(p.positions || {})) {
      const st = d.stocks[code];
      positions[code] = {
        code,
        side: pos.side,
        qty: pos.qty,
        entry: pos.entry,
        price: st.price,
        pnl: positionPnl(pos, st.price),
        pnlPct: pos.margin > 0 ? (positionPnl(pos, st.price) / pos.margin) * 100 : 0,
        margin: pos.margin,
        leverage: pos.leverage,
        tp: pos.tp,
        tpsl: Array.isArray(pos.tpsl)
          ? pos.tpsl.filter((x) => !x.fired).map((x) => ({
            id: x.id, kind: x.kind, price: x.price, qty: x.qty || null
          }))
          : [],
        sl: pos.sl,
        // 分批平仓中的状态，前端要显示「止损中」
        closing: pos.closing || null
      };
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
        autoDca: !!o.autoDca
      }))
    };
  }
  return {
    type: 'tick',
    build: getBuild(),
    tick: d.tick,
    closed: d.config.marketOpen === false,
    index: d.index.value,
    indexChanges: changesFor(d.index.series, TIMEFRAMES),
    // 调仓后权重会变，不推的话前端面板一直是进页面时那份
    indexWeights: Object.entries(d.index.weights || {}).map(([code, w]) => {
      const st2 = d.stocks[code] || {};
      const sh = Number(st2.shares) || 0;
      const px2 = Number(st2.price) || 0;
      return {
        code, name: st2.name || code, weight: w, price: px2,
        marketCap: px2 * sh,
        freeCap: px2 * sh * (Number(st2.freeFloat) || 0.45)
      };
    }).sort((a, b) => b.weight - a.weight),
    smallIndex: {
      value: Number(d.smallIndex?.value) || 0,
      weights: Object.entries(d.smallIndex?.weights || {}).map(([code, w]) => {
        const st2 = d.stocks[code] || {};
        const sh = Number(st2.shares) || 0;
        const px2 = Number(st2.price) || 0;
        return {
          code, name: st2.name || code, weight: w, price: px2,
          marketCap: px2 * sh,
          freeCap: px2 * sh * (Number(st2.freeFloat) || 0.45)
        };
      }).sort((a, b) => b.weight - a.weight),
      nextRebalanceTick: Number(d.smallIndex?.nextRebalanceTick) || 0,
      rebalanceTick: Number(d.smallIndex?.rebalanceTick) || 0
    },
    fx: {
      rate: Number(d.fx?.rate) || 0,
      prevRate: Number(d.fx?.prevRate) || 0,
      base: Number(d.fx?.base) || 0,
      at: d.fx?.at || 0,
      stale: !!d.fx?.stale
    },
    stocks,
    config: {
      minLeverage: d.config.minLeverage,
      maxLeverage: d.config.maxLeverage,
      feeRate: d.config.feeRate,
      stampDuty: d.config.stampDuty,
      maxOrdersPerTick: d.config.maxOrdersPerTick,
      workRatePerTick: d.config.workRatePerTick ?? 50,
      workOnlineMultiplier: d.config.workOnlineMultiplier ?? 2,
      workBankTicks: d.config.workBankTicks ?? 1440
    },
    notices: (d.notices || [])
      .filter((n) => noticeAlive(d, n))
      .map((n) => ({
        id: n.id, text: n.text, at: n.at,
        kind: n.kind || null,
        ageTicks: Number(n.tick) > 0 ? Math.max(0, d.tick - Number(n.tick)) : null,
        leftTicks: Number(n.expireTick) > 0 ? Math.max(0, Number(n.expireTick) - d.tick) : null
      })),
    events: d.events
      .filter((e) => e.announced !== false)
      // 同样只下发已公布的文案和方向
      .map((e) => ({
        id: e.id,
        text: e.text,
        companies: e.companies,
        dir: e.dir || (e.trend > 0 ? 1 : -1),
        createdAt: e.createdAt,
        ageTicks: Number(e.createdTick) > 0
          ? Math.max(0, d.tick - Number(e.createdTick))
          : Math.max(0, (Number(e.duration) || 0) - (Number(e.remaining) || 0))
      })),
    me
  };
}

let lastTickAt = now();

function loop() {
  const d = getDb();
  const cfg = d.config;

  // 休市：冻结行情，只推状态不给价格
  if (d.config.marketOpen === false) {
    const frozen = tickPayload(null);
    for (const c of clients) {
      const personal = tickPayload(c.playerId);
      const payload = { ...frozen, me: personal.me, activity: personal.activity, closed: true };
      try {
        c.res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        clients.delete(c);
      }
    }
    saveDb();
    lastTickAt = now();
    return;
  }

  // 停牌到期自动复牌
  for (const st of Object.values(d.stocks)) {
    if (st.status === 'suspended' && st.statusUntil && now() >= st.statusUntil) {
      st.status = 'normal';
      st.statusUntil = 0;
    }
  }

  stepMarket(d);

  // ST 连续低于阈值 → 自动退市（先平仓，下面的撮合会撤掉它的挂单）
  try {
    const gone = checkDelist(d);
    if (gone.length) {
      for (const g of gone) {
        console.log(`[delist] ${g.name}(${g.code}) 退市，清掉 ${g.closed} 个持仓`);
      }
      saveDb();
    }
  } catch (e) {
    console.error('[delist] 退市处理出错:', e.message);
  }

  // 挂单撮合：价格已经更新，先看看有没有到价的单子
  let orderEvents = [];
  try {
    orderEvents = processOrders(d);
  } catch (e) {
    console.error('[orders] 撮合出错:', e.message);
  }

  const closes = checkPositions(d);

  // 打工：自动往钱袋里攒，在线翻倍，攒满就不再涨
  const workRate = Math.max(0, Number(d.config.workRatePerTick ?? 50));
  const workMult = Math.max(1, Number(d.config.workOnlineMultiplier ?? 2));
  const workCapTicks = Math.max(1, Number(d.config.workBankTicks ?? 1440));
  const bankCap = workRate * workCapTicks;

  const onlineNow = new Set();
  for (const c of clients) {
    if (c.playerId) onlineNow.add(c.playerId);
  }
  onlineIds = onlineNow;

  if (workRate > 0) {
    for (const p of Object.values(d.players)) {
      const isOnline = onlineNow.has(p.id);
      const gain = workRate * (isOnline ? workMult : 1);
      const cur = Math.max(0, Number(p.workBank) || 0);
      p.workBank = Math.min(bankCap, cur + gain);
      p.workOnline = isOnline;
    }
  }

  // 自动定投：钱袋一满就自动挂单买 DENG（离线也生效）
  try {
    const dcaRuns = autoDcaTick(d, bankCap);
    if (dcaRuns.some((x) => x.ok)) saveDb();
  } catch (e) {
    console.error('[autoDca] 出错:', e.message);
  }

  // 收益曲线快照：每 N 轮记一次 [tick, 总资产, 累计打工+偷钱收入]
  const sampleTicks = Math.max(1, Number(d.config.equitySampleTicks ?? 12));
  const maxPoints = Math.max(20, Number(d.config.equityMaxPoints ?? 400));
  if (d.tick % sampleTicks === 0) {
    for (const p of Object.values(d.players)) {
      if (!Array.isArray(p.eq)) p.eq = [];
      const income = (p.workEarned || 0) + (p.stealEarned || 0);
      p.eq.push([d.tick, Math.round(playerEquity(d, p) * 100) / 100, Math.round(income * 100) / 100]);
      if (p.eq.length > maxPoints) p.eq.splice(0, p.eq.length - maxPoints);
    }
  }

  // 偷钱结算：上一轮派出去的，这一轮动手
  const stealMin = Number(d.config.stealMin ?? 100);
  const stealMax = Number(d.config.stealMax ?? 10000);
  const capRatio = Number(d.config.stealCapRatio ?? 0.001);
  const stealCd = Math.max(0, Number(d.config.stealCooldownTicks ?? 60));
  const stealAlerts = new Map();   // playerId -> [alert...]
  const pushAlert = (id, alert) => {
    if (!stealAlerts.has(id)) stealAlerts.set(id, []);
    stealAlerts.get(id).push(alert);
  };

  for (const p of Object.values(d.players)) {
    const q = p.stealQueued;
    if (!q) continue;
    p.stealQueued = null;

    const victim = d.players[q.targetId];
    if (!victim || victim.id === p.id) continue;

    // 边界一：对方现金必须 > 0，否则没得偷
    // 派出小偷之后对方才买的保镖也算数
    const victimGuard = Number(victim.guardUntil || 0) - d.tick;
    if (victimGuard > 0) {
      pushAlert(p.id, {
        type: 'steal',
        ok: false,
        guarded: true,
        target: victim.nickname,
        amount: 0
      });
      continue;
    }

    const victimCash = Math.max(0, Number(victim.cash) || 0);
    if (victimCash < 1) {
      pushAlert(p.id, { type: 'steal', ok: false, target: victim.nickname, amount: 0 });
      continue;
    }

    // 边界二：上限按「总资产」算，但总资产可能是负的（浮亏爆表），先夹到 0
    const equity = Math.max(0, playerEquity(d, victim));
    const cap = equity * capRatio;

    // 边界三：随机区间可能小于 0（配置写反），兜一下
    const lo = Math.max(0, Math.min(stealMin, stealMax));
    const hi = Math.max(lo, stealMax);
    const want = lo + Math.random() * (hi - lo);

    // 边界四：取三者最小，再保证不超过对方现金、不出现负数
    let amount = Math.floor(Math.min(want, cap, victimCash));
    if (!Number.isFinite(amount) || amount < 0) amount = 0;

    // 边界五：兜底 1 块钱以下的变动没意义，直接算空手
    if (amount < 1 || victimCash <= 0) {
      pushAlert(p.id, { type: 'steal', ok: false, target: victim.nickname, amount: 0 });
      continue;
    }

    // 边界六：真扣的时候再夹一次，绝不让现金变负
    amount = Math.min(amount, victimCash);
    victim.cash = Math.max(0, victimCash - amount);
    p.cash = (Number(p.cash) || 0) + amount;
    p.stealEarned = (p.stealEarned || 0) + amount;
    // 得手才进冷却，空手不罚
    if (stealCd > 0) p.stealReadyAt = d.tick + stealCd;

    // 双方都记一笔流水
    logTrade(d, {
      playerId: p.id,
      nickname: p.nickname,
      code: '',
      name: `偷了 ${victim.nickname}`,
      action: 'steal',
      side: 'long',
      qty: 0,
      price: 0,
      leverage: 1,
      amount,
      pnl: amount,
      fee: 0,
      stamp: 0,
      reason: 'steal'
    });
    logTrade(d, {
      playerId: victim.id,
      nickname: victim.nickname,
      code: '',
      name: `被 ${p.nickname} 偷走`,
      action: 'stolen',
      side: 'long',
      qty: 0,
      price: 0,
      leverage: 1,
      amount,
      pnl: -amount,
      fee: 0,
      stamp: 0,
      reason: 'stolen'
    });

    pushAlert(p.id, { type: 'steal', ok: true, mine: true, target: victim.nickname, amount, cd: stealCd });
    pushAlert(victim.id, { type: 'steal', ok: true, mine: false, from: p.nickname, amount });
  }

  // 通知到个人
  const byPlayer = new Map();
  for (const c of closes) {
    if (!c || !c.ok) continue;
    if (!byPlayer.has(c.playerId)) byPlayer.set(c.playerId, []);
    byPlayer.get(c.playerId).push({
      code: c.code,
      side: c.side,
      qty: c.qty,
      entry: c.entry,
      price: c.price,
      pnl: c.pnl,
      reason: c.reason
    });
  }
  const base = tickPayload(null);
  for (const c of clients) {
    // 被封禁的立即断开
    const cp = d.players[c.playerId];
    if (cp && cp.banned) {
      try {
        c.res.write(`data: ${JSON.stringify({ banned: true, reason: cp.banReason || '' })}\n\n`);
        c.res.end();
      } catch { /* ignore */ }
      clients.delete(c);
      continue;
    }
    // activity 里有 joined（我参没参加），必须按人算，不能共用 base
    const payload = { ...base, me: tickPayload(c.playerId).me };
    const notes = byPlayer.get(c.playerId);
    if (notes) payload.closes = notes;
    const alerts = stealAlerts.get(c.playerId);
    if (alerts) payload.alerts = alerts;

    const myOrders = orderEvents.filter((e) => e.playerId === c.playerId);
    if (myOrders.length) payload.orderEvents = myOrders;
    try {
      c.res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      clients.delete(c);
    }
  }
  // 没有 SSE 客户端时也保持 tick 推进（上面已 stepMarket）

  saveDb();
  lastTickAt = now();
}

// ---------------- 实时汇率（留美外汇的驱动）----------------
async function refreshFx() {
  const d = getDb();
  if (!d.fx) d.fx = { rate: 0, base: 0, prevRate: 0, at: 0, source: '' };
  const r = await fetchAudJpy();
  if (!r) {
    d.fx.stale = true;
    return;
  }
  d.fx.prevRate = d.fx.rate || r.rate;
  d.fx.rate = r.rate;
  d.fx.at = r.at;
  d.fx.source = r.source;
  d.fx.stale = false;
  // 第一次抓到的汇率作为基准点，之后股价按相对它涨跌
  if (!d.fx.base) d.fx.base = r.rate;
}

let fxTimer = null;
let fxLastAt = 0;
function startFxLoop() {
  // 每 5 秒瞄一眼：到点没到点、开没开，都是现读个股设置
  const tick = () => {
    const d = getDb();
    const fxStock = Object.values(d.stocks).find((st) => st.trait?.id === 'fx');
    if (!fxStock) return;
    const t = fxStock.trait || {};
    if (Number(t.fxEnabled ?? d.config.fxEnabled ?? 1) === 0) return;
    const ms = Math.max(15000, Number(t.refreshMs ?? d.config.fxRefreshMs ?? 60000));
    if (Date.now() - fxLastAt < ms) return;
    fxLastAt = Date.now();
    refreshFx().catch((e) => console.error('[fx] 抓取失败:', e.message));
  };
  refreshFx().catch((e) => console.error('[fx] 初始化失败:', e.message));
  fxLastAt = Date.now();
  const timer = setInterval(tick, 5000);
  if (timer.unref) timer.unref();
}

const timer = setInterval(loop, Math.max(1000, db.config.tickMs || 5000));

// 启动时先备份一次，之后每 30 分钟一份
backupDb('boot');
setInterval(() => backupDb(), 30 * 60 * 1000);

startFxLoop();

server.listen(PORT, () => {
  console.log(`\n  小灯证券 · 网页版`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  tick = ${db.config.tickMs}ms, 玩家 ${Object.keys(db.players).length} 人\n`);
});
