import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, saveDb, now, backupDb } from './src/store.js';
import { stepMarket, seedHistory } from './src/engine.js';
import { checkPositions, playerEquity, positionPnl } from './src/trading.js';
import { accrueLoans } from './src/loans.js';
import { handleApi } from './src/api.js';
import { GLOBAL_NEWS, LOCAL_NEWS } from './src/news.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const PORT = Number(process.env.PORT || 8971);

const db = getDb();
// 新闻池以代码为准，每次启动都刷新（改 news.js 后重启即可生效）
db.newsPool = GLOBAL_NEWS;
db.localNewsPool = LOCAL_NEWS;
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
  '.ico': 'image/x-icon'
};

function serveStatic(res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=600'
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
  const stocks = {};
  for (const [code, st] of Object.entries(d.stocks)) {
    const prev = st.series.length > 1 ? st.series[st.series.length - 2] : st.price;
    stocks[code] = {
      price: Number(st.price.toFixed(4)),
      changePct: prev ? ((st.price - prev) / prev) * 100 : 0,
      status: st.status
    };
  }
  let me = null;
  if (forPlayerId && d.players[forPlayerId]) {
    const p = d.players[forPlayerId];
    const positions = {};
    for (const [code, pos] of Object.entries(p.positions || {})) {
      const st = d.stocks[code];
      positions[code] = {
        side: pos.side,
        qty: pos.qty,
        entry: pos.entry,
        price: st.price,
        pnl: positionPnl(pos, st.price),
        margin: pos.margin,
        leverage: pos.leverage,
        tp: pos.tp,
        sl: pos.sl
      };
    }
    me = { cash: p.cash, equity: playerEquity(d, p), positions, loan: p.loan, bankrupt: !!p.bankrupt };
  }
  return {
    type: 'tick',
    tick: d.tick,
    index: d.index.value,
    stocks,
    events: d.events
      .filter((e) => e.announced !== false)
      .map((e) => ({
        id: e.id,
        kind: e.kind || 'global',
        text: e.text,
        companies: e.companies,
        trend: e.trend,
        remaining: e.remaining,
        createdAt: e.createdAt
      })),
    me
  };
}

let lastTickAt = now();

function loop() {
  const d = getDb();
  const cfg = d.config;

  // 停牌到期自动复牌
  for (const st of Object.values(d.stocks)) {
    if (st.status === 'suspended' && st.statusUntil && now() >= st.statusUntil) {
      st.status = 'normal';
      st.statusUntil = 0;
    }
  }

  stepMarket(d);

  const closes = checkPositions(d);
  const deaths = accrueLoans(d);

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
  for (const dd of deaths) {
    if (!byPlayer.has(dd.playerId)) byPlayer.set(dd.playerId, []);
    byPlayer.get(dd.playerId).push({
      bankrupt: true,
      nickname: dd.nickname,
      debt: dd.debt,
      equity: dd.equity
    });
  }

  const base = tickPayload(null);
  for (const c of clients) {
    const payload = { ...base, me: tickPayload(c.playerId).me };
    const notes = byPlayer.get(c.playerId);
    if (notes) payload.closes = notes;
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

const timer = setInterval(loop, Math.max(1000, db.config.tickMs || 5000));

// 启动时先备份一次，之后每 30 分钟一份
backupDb('boot');
setInterval(() => backupDb(), 30 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`\n  小灯证券 · 网页版`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  tick = ${db.config.tickMs}ms, 玩家 ${Object.keys(db.players).length} 人\n`);
});
