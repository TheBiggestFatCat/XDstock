import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, saveDb, now, backupDb } from './src/store.js';
import { getBuild } from './src/build.js';
import { stepMarket, seedHistory, changesFor, noticeAlive, noticeLink, liveIndexWeights } from './src/engine.js';
import { stockWire, positionWire } from './src/wire.js';
import { stealCooldownFor, nightInfoFor, isNightWindow } from './src/theme.js';
import { TIMEFRAMES, timeframeTicks } from './src/config.js';
import { checkPositions, playerEquity, logTrade } from './src/trading.js';
import { processOrders, fillCapFor } from './src/orders.js';
import { autoDcaTick } from './src/autoDca.js';
import { tourTick, setTourRate, setTourHist, TOUR_TFS, TOUR_TICK_MS } from './src/tour.js';
import { marketPhase, phaseText } from './src/schedule.js';
import { checkDelist } from './src/delist.js';
import { fetchAudJpy, fetchAudJpyBars } from './src/fx.js';
import { dfItemRequestUrl, parseDfItemPrice, ensureDfItem } from './src/dfItem.js';
import { handleApi } from './src/api.js';
import { NEWS_POOL, MAJOR_NEWS_POOL } from './src/news.js';
import { pushNotify, notifyList } from './src/notify.js';
import { visibleEmotes } from './src/emoji.js';
import { latestVersionPost } from './src/version.js';
import { stealAmount } from './src/steal.js';
import { chatUnreadFor } from './src/chat.js';
import {
  achvPayload, ensureAchvState, bumpAchv, isEvolved, ownsTheme
} from './src/achievements.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const PORT = Number(process.env.PORT || 8971);

const db = getDb();
// 新闻池以代码为准，每次启动都刷新（改 news.js 后重启即可生效）
db.newsPool = NEWS_POOL;
db.majorPool = MAJOR_NEWS_POOL;   // 重大利好/重大利空（概率 1/100）
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
  // 锦标赛独立路由：/tournament（含 /tour 别名、带不带结尾斜杠都行）
  if (rel === '/tournament' || rel === '/tournament/' || rel === '/tour') rel = '/tournament.html';
  const full = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('403');
    return;
  }
  return serveStatic(res, full);
});

// ---------------- 游戏主循环 ----------------
// 金融大鳄：下期财报预览（提前 20 轮）
// 注意：每轮的 SSE 广播用的是「无玩家」的公共 payload，所以预览必须在
/** tickPayload 里用的当前开市状态（每次都按现实时间重算，免得跨过边界还发旧值） */
function phaseNow(d) {
  return marketPhase(d, now());
}

function tickPayload(forPlayerId) {
  const d = getDb();
  const tp = forPlayerId ? d.players[forPlayerId] : null;
  const stocks = {};
  for (const [code, st] of Object.entries(d.stocks)) {
    // 字段白名单见 src/wire.js：trait / fair / 情绪真值 / 资金压力都不下发
    stocks[code] = stockWire(d, st, tp);
  }
  let me = null;
  if (forPlayerId && d.players[forPlayerId]) {
    const p = d.players[forPlayerId];
    const positions = {};
    for (const [code, pos] of Object.entries(p.positions || {})) {
      const st = d.stocks[code];
      if (!st) continue;
      // 和首屏 / 止盈止损接口用同一个下发格式（src/wire.js）
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
      // 夜行者：此刻的偷钱 CD 和夜里状态
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
      // 🐟 咸鱼代下单 / 🕵 游资情报 的状态（和 publicPlayer 保持一致）
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
      // 主题成就 / 进化（进度、结晶、阶数）
      achv: achvPayload(d, p),
      // 站内通知：最新一份（安卓壳靠它发系统通知；网页端不显示）
      notices: notifyList(p, 20),
      // 聊天大厅：有没有未读消息（导航「聊天」标签的红点）。
      // 已读游标 chatReadSeq 存在服务端，手机/电脑共享同一个状态
      chatUnread: chatUnreadFor(d, p)
    };
  }
  return {
    type: 'tick',
    build: getBuild(),
    tick: d.tick,
    // 表情互动：本轮该冒出来的那些（上一轮发出来的，下一轮自动消失）
    emotes: visibleEmotes(d),
    // 版本公告：管理员发完，在线玩家下一轮就能看到（不用刷新）
    versionPost: latestVersionPost(d),
    closed: phaseNow(d).open === false,
    closedReason: phaseNow(d).reason,
    closedLabel: phaseNow(d).label,
    closedText: phaseText(phaseNow(d), now()),
    closedUntil: phaseNow(d).nextOpenAt,
    nextChangeAt: phaseNow(d).nextChangeAt,
    index: d.index.value,
    indexChanges: changesFor(d.index.series, timeframeTicks(d.config.tickMs)),
    // 调仓后权重会变，不推的话前端面板一直是进页面时那份
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
    smallIndex: {
      value: Number(d.smallIndex?.value) || 0,
      weights: (() => {
        const live = liveIndexWeights(d, 'smallIndex');
        return Object.entries(d.smallIndex?.weights || {}).map(([code, w]) => {
          const st2 = d.stocks[code] || {};
          const px2 = Number(st2.price) || 0;
          return {
            code, name: st2.name || code, weight: w,
            liveWeight: Number(live[code]) || 0,
            freeCap: px2 * (Number(st2.shares) || 0) * (Number(st2.freeFloat) || 0.45)
          };
        }).sort((a, b) => b.weight - a.weight);
      })(),
      nextRebalanceTick: Number(d.smallIndex?.nextRebalanceTick) || 0,
      rebalanceTick: Number(d.smallIndex?.rebalanceTick) || 0
    },
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
      .filter((n) => noticeAlive(d, n))
      .map((n) => ({
        id: n.id, text: n.text, at: n.at,
        kind: n.kind || null,
        // 公告可带一个站内跳转地址（如 /tournament），前端渲染成可点链接
        href: noticeLink(n) || null,
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
        major: !!e.major,          // 重大利好/重大利空（前端红底闪烁 + 排最前）
        leftTicks: e.major ? Math.max(0, Number(e.remaining) || 0) : undefined,
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

  // 休市（管理员一刀切 / 定时休市 / 循环作息）：冻结行情，只推状态不给价格
  const phase = marketPhase(d, now());
  if (!phase.open) {
    // 记一下「现在是休市」，开市后第一轮据此放一波巨量（见 marketTrades.js#genMarketTrades）
    d.marketWasClosed = true;
    const frozen = tickPayload(null);
    for (const c of clients) {
      const personal = tickPayload(c.playerId);
      const payload = {
        ...frozen,
        me: personal.me,
        activity: personal.activity,
        closed: true,
        closedReason: phase.reason,
        closedLabel: phase.label,
        closedText: phaseText(phase, now()),
        closedUntil: phase.nextOpenAt
      };
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

  // 刚休完市的第一轮：打上开盘巨量标记（genMarketTrades 消费掉就清空）
  if (d.marketWasClosed) {
    d.marketWasClosed = false;
    d.reopenSurge = true;
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

  // 止盈止损「成交」：撮合把自动单打完时推一条（带盈亏）
  for (const e of orderEvents) {
    if (!e || e.type !== 'fill' || !e.auto) continue;
    const owner = d.players[e.playerId];
    if (!owner) continue;
    const st = d.stocks[e.code];
    const name = e.name || st?.name || e.code;
    const word = e.auto === 'tp' ? '止盈' : e.auto === 'sl' ? '止损' : '风控';
    const pnl = Number(e.pnl) || 0;
    pushNotify(owner, d, {
      kind: 'tpslFill',
      code: e.code,
      text: `${name} ${word}成交 · ${e.qty} 股 @${Number(e.price || 0).toFixed(2)}，`
        + `${pnl >= 0 ? '盈利' : '亏损'} $${Math.abs(pnl).toFixed(2)}`
        + (e.rest > 0 ? `，还剩 ${e.rest} 股在平` : '')
    });
  }

  // 止盈止损「触发」：给本人推一条站内通知（不依赖他是否在线看 toast）
  for (const c of closes) {
    if (!c || !c.ok || !c.autoOrder || c.qty) continue;
    const owner = d.players[c.playerId];
    if (!owner) continue;
    const st = d.stocks[c.code];
    const name = st?.name || c.code;
    const word = c.autoOrder === 'tp' ? '止盈' : '止损';
    pushNotify(owner, d, {
      kind: 'tpsl',
      code: c.code,
      text: `${name} ${word}触发 · 现价 ${Number(c.price || st?.price || 0).toFixed(2)}，已自动挂出平仓单`
    });
  }

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

    // 上限按「对方现金」算（不是总资产）：持仓里的钱偷不到，
    // 所以百分比挂在现金上——对方现金越多，能摸走的越多
    let amount = stealAmount({
      victimCash,
      capRatio,
      stealMin,
      stealMax
    });

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
    // 冷却按人算：夜行者主题在夜里只有 5 轮，其余 60 轮
    const cd = stealCooldownFor(d, p);
    if (cd > 0) p.stealReadyAt = d.tick + cd;

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

    // 🌙 夜行者成就：很会偷（单次金额）+ 趁人不备（夜里得手次数）
    ensureAchvState(p);
    if (p.skill === 'night') {
      bumpAchv(d, p, 'nightBigSteal', amount, 'max');
      if (isNightWindow(d)) bumpAchv(d, p, 'nightStealCount', 1);
    }

    pushAlert(p.id, { type: 'steal', ok: true, mine: true, target: victim.nickname, amount, cd });
    // 🌙 进化后夜里偷东西不再通知受害者（「趁人不备」）
    const silentNight = p.skill === 'night' && isNightWindow(d) && isEvolved(p, 'night');
    if (!silentNight) {
      pushAlert(victim.id, { type: 'steal', ok: true, mine: false, from: p.nickname, amount });
    }
  }

  // 锦标赛不走这里了：它有自己 1 秒一条的循环（startTourLoop），
  // 主站休市时 loop 直接 return，赛区也不会跟着停

  // 通知到个人
  const byPlayer = new Map();
  for (const c of closes) {
    if (!c || !c.ok) continue;
    // 真正平掉时再推一条（带盈亏），和「触发」分开两条，玩家一眼能看出挂单有没有成交
    const owner = d.players[c.playerId];
    if (owner && c.qty) {
      const st = d.stocks[c.code];
      const name = st?.name || c.code;
      const word = c.reason === 'tp' ? '止盈' : c.reason === 'sl' ? '止损' : c.reason === 'liq' ? '强平' : '平仓';
      const pnl = Number(c.pnl) || 0;
      pushNotify(owner, d, {
        kind: c.reason === 'tp' || c.reason === 'sl' ? 'tpslFill' : 'close',
        code: c.code,
        text: `${name} ${word}成交 · ${c.qty} 股 @${Number(c.price || 0).toFixed(2)}，`
          + `${pnl >= 0 ? '盈利' : '亏损'} $${Math.abs(pnl).toFixed(2)}`
      });
    }
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
    const personal = tickPayload(c.playerId);
    const payload = { ...base, me: personal.me };
    // 金融大鳄 / 情绪读心：公共 payload 里没有按人算的 preview / sent，这里补一份
    if (cp && (cp.theme === 'tycoon' || cp.theme === 'mind') && personal.stocks) {
      const merged = {};
      for (const [code, s] of Object.entries(base.stocks)) {
        const p = personal.stocks[code];
        let row = s;
        if (p && p.preview !== undefined) row = { ...row, preview: p.preview };
        if (p && p.sent !== undefined) row = { ...row, sent: p.sent };
        merged[code] = row;
      }
      payload.stocks = merged;
    }
    const notes = byPlayer.get(c.playerId);
    if (notes) payload.closes = notes;
    // 派息：本轮有我的股息事件就单独下发（公共 payload 里没有）
    const myDiv = (d.dividendEvents || []).filter((e) => e.playerId === c.playerId);
    if (myDiv.length) payload.dividends = myDiv;
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

// ---------------- 实时汇率（主市场 fx 票 + 锦标赛 LMFX 共用一次抓取）----------------
async function refreshFx() {
  const d = getDb();
  if (!d.fx) d.fx = { rate: 0, base: 0, prevRate: 0, at: 0, source: '' };
  const r = await fetchAudJpy();
  if (!r) {
    d.fx.stale = true;
    setTourRate(d, 0);            // 抓失败：赛区只标 stale，价格原地不动
    return;
  }
  d.fx.prevRate = d.fx.rate || r.rate;
  d.fx.rate = r.rate;
  d.fx.at = r.at;
  d.fx.source = r.source;
  d.fx.stale = false;
  // 第一次抓到的汇率作为基准点，之后股价按相对它涨跌
  if (!d.fx.base) d.fx.base = r.rate;
  // 锦标赛的 LMFX 直接报这个汇率，不做任何再计算
  setTourRate(d, r.rate, r.at, r.source);
}

let fxTimer = null;
let fxLastAt = 0;
let fxBusy = false;
function startFxLoop() {  // 每 1 秒瞄一眼：到点没到点、开没开，都是现读个股设置。
  // 主市场已经没有 fx 票了（LMFX 退市），这个循环现在主要喂锦标赛：
  // 赛区 1 秒一拍，汇率也得 1 秒抓一次，否则价格 15 秒才动一下、1 秒刷新就是白刷。
  // 源是 swissquote 的实时 BBO，实测单次 0.7~1.2 秒，所以用 fxBusy 防重入
  // （上一笔没回来就不发下一笔），实际节奏约 1.2~1.5 秒一个新报价。
  // 有 fx 票的主站市场仍按个股 refreshMs 走，一行没改。
  const pull = () => {
    if (fxBusy) return;
    fxBusy = true;
    fxLastAt = Date.now();
    refreshFx()
      .catch((e) => console.error('[fx] 抓取失败:', e.message))
      .finally(() => { fxBusy = false; });
  };
  const tick = () => {
    const d = getDb();
    const fxStock = Object.values(d.stocks).find((st) => st.trait?.id === 'fx');
    const t = fxStock ? (fxStock.trait || {}) : {};
    if (fxStock && Number(t.fxEnabled ?? d.config.fxEnabled ?? 1) === 0) return;
    // 没 fx 票 = 纯喂赛区，跟着赛区 1 秒走；有票就还按那只票自己的刷新节奏
    const ms = fxStock
      ? Math.max(1000, Number(t.refreshMs ?? d.config.fxRefreshMs ?? 60000))
      : TOUR_TICK_MS;
    if (Date.now() - fxLastAt < ms) return;
    pull();
  };
  pull();
  fxLastAt = Date.now();
  const timer = setInterval(tick, 1000);
  if (timer.unref) timer.unref();
}

// ---------------- 三角洲物品价格（海洋之泪 HYZL 的财报驱动源）----------------
// 官方 AMS 接口：免费、无需登录；2026-11 实测数据约每小时刷新一次，
// 所以 10 分钟拉一次足够（只在发报时用价格，不需要高频）。
// 抓失败：沿用上一次价格并标 stale —— 财报按旧价算，绝不自己编一个数。
let dfItemLastAt = 0;
let dfItemBusy = false;
async function refreshDfItem() {
  const d = getDb();
  ensureDfItem(d);
  const res = await fetch(dfItemRequestUrl(), {
    method: 'POST',
    headers: {
      'User-Agent': 'XDstock/1.0 (+https://github.com/TheBiggestFatCat/XDstock)'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const got = parseDfItemPrice(json);
  if (!got.found) throw new Error('响应里没有海洋之泪的 avgPrice');
  d.dfItem.price = got.price;
  d.dfItem.chg = got.chg;
  d.dfItem.at = now();
  d.dfItem.stale = false;
  saveDb();
  return got.price;
}
function startDfItemLoop() {
  const pull = () => {
    if (dfItemBusy) return;
    dfItemBusy = true;
    dfItemLastAt = Date.now();
    refreshDfItem()
      .then((price) => console.log(`[dfItem] 海洋之泪 avgPrice = ${price}`))
      .catch((e) => {
        const d = getDb();
        ensureDfItem(d);
        d.dfItem.stale = true;
        console.error('[dfItem] 抓取失败（沿用上一次价格）:', e.message);
      })
      .finally(() => { dfItemBusy = false; });
  };
  const tick = () => {
    if (Date.now() - dfItemLastAt < 10 * 60 * 1000) return;
    pull();
  };
  pull();
  const timer = setInterval(tick, 60 * 1000);
  if (timer.unref) timer.unref();
}

// 锦标赛：赛区自己一条 1 秒的循环，不跟主站 tickMs（5 秒）绑在一起。
// 这样主站休市（loop 开头直接 return）时赛区照样走，报价点也不会被主站节奏拖慢。
// 落盘压到 5 秒一次 —— db.json 三兆多，每秒整库 stringify + rename 太浪费，
// saveDb 自带 800ms 防抖，攒 5 秒正好合并成一次。
let tourSaveAt = 0;
function startTourLoop() {
  const tick = () => {
    const d = getDb();
    try {
      tourTick(d);
    } catch (e) {
      console.error('[tour] 推进出错:', e.message);
    }
    const nowMs = Date.now();
    if (nowMs - tourSaveAt >= 5000) {
      tourSaveAt = nowMs;
      saveDb();
    }
  };
  tick();   // 启动先走一拍，别让页面空等 1 秒
  const timer = setInterval(tick, TOUR_TICK_MS);
  if (timer.unref) timer.unref();
}

// 赛区 K 线的历史部分：赛区只从服务启动那刻开始攒 1 秒报价点，
// 1m 的 300 根（5 小时）、5m 的 25 小时、15m 的 48 小时都攒不出来，
// 所以定期抓真实行情的历史包补上（3 个请求一次，5 分钟一轮，很轻）。
let histLastAt = 0;
async function refreshTourHist() {
  const d = getDb();
  for (const tf of Object.keys(TOUR_TFS)) {
    const bars = await fetchAudJpyBars(tf, TOUR_TFS[tf].max + 20);
    if (bars) setTourHist(d, tf, bars);
  }
  saveDb();
}
function startTourHistLoop() {
  const tick = () => {
    if (Date.now() - histLastAt < 5 * 60 * 1000) return;
    histLastAt = Date.now();
    refreshTourHist().catch((e) => console.error('[tour] 历史 K 线抓取失败:', e.message));
  };
  histLastAt = Date.now();
  refreshTourHist().catch((e) => console.error('[tour] 历史 K 线初始化失败:', e.message));
  const timer = setInterval(tick, 60 * 1000);
  if (timer.unref) timer.unref();
}

const timer = setInterval(loop, Math.max(1000, db.config.tickMs || 5000));

// 启动时先备份一次，之后每 30 分钟一份
backupDb('boot');
setInterval(() => backupDb(), 30 * 60 * 1000);

startFxLoop();
startDfItemLoop();
startTourLoop();
startTourHistLoop();

server.listen(PORT, () => {
  console.log(`\n  小灯证券 · 网页版`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  tick = ${db.config.tickMs}ms, 玩家 ${Object.keys(db.players).length} 人\n`);
});
