import fs from 'node:fs';
import path from 'node:path';
import { getDb, saveDb, uid, now, AVATAR_DIR } from './store.js';
import { candlesFromSeries, changesFor, timeOfTick } from './engine.js';
import { TIMEFRAMES } from './config.js';
import { getBuild } from './build.js';
import { playerEquity, positionPnl } from './trading.js';
import { placeLimitOrder, cancelOrder } from './orders.js';
import { reportPayload } from './fundamentals.js';

const TOKEN_TTL = 30 * 24 * 3600 * 1000;

// 登录失败计数：同一 IP + 昵称 连错 5 次，锁 60 秒
const loginFailures = new Map();
const LOGIN_MAX_FAIL = 5;
const LOGIN_LOCK_MS = 60 * 1000;

function loginLockSeconds(key) {
  const rec = loginFailures.get(key);
  if (!rec || !rec.until) return 0;
  const left = rec.until - Date.now();
  if (left <= 0) {
    loginFailures.delete(key);
    return 0;
  }
  return Math.ceil(left / 1000);
}

function noteLoginFailure(key) {
  const rec = loginFailures.get(key) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_FAIL) {
    rec.until = Date.now() + LOGIN_LOCK_MS;
    rec.count = 0;
  }
  loginFailures.set(key, rec);
  if (loginFailures.size > 5000) loginFailures.clear();
}

function clientIp(ctx) {
  return (ctx.req?.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function publicPlayer(p, db) {
  const positions = {};
  for (const [code, pos] of Object.entries(p.positions || {})) {
    const st = db.stocks[code];
    if (!st) continue;
    const pnl = positionPnl(pos, st.price);
    positions[code] = {
      ...pos,
      price: st.price,
      pnl,
      pnlPct: pos.margin > 0 ? (pnl / pos.margin) * 100 : 0,
      equity: pos.margin + pnl
    };
  }
  return {
    id: p.id,
    nickname: p.nickname,
    avatar: p.avatar || null,
    cash: p.cash,
    positions,
    equity: playerEquity(db, p),
    workBank: Math.round((p.workBank || 0) * 100) / 100,
    workEarned: p.workEarned || 0,
    stealQueued: p.stealQueued || null,
    stealEarned: p.stealEarned || 0,
    stealReadyAt: p.stealReadyAt || 0,
    guardUntil: p.guardUntil || 0,
    fakeNewsReadyAt: p.fakeNewsReadyAt || 0,
    channelLevel: p.channelLevel || 0,
    redBonusEarned: p.redBonusEarned || 0,
    theme: p.theme || 'default',
    themeChangedTick: p.themeChangedTick || 0,
    themes: Array.isArray(p.themes) ? p.themes : [],
    frozen: Math.round((p.orders || []).reduce((a, o) => a + (Number(o.reserve) || 0), 0) * 100) / 100,
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
      auto: o.auto || null
    })),
    income: (p.workEarned || 0) + (p.stealEarned || 0),
    createdAt: p.createdAt
  };
}

function orderLimitBlocked(db, player) {
  const max = Number(db.config.maxOrdersPerTick ?? 1);
  if (!(max > 0)) return null;
  const sameTick = player.orderTick === db.tick;
  const used = sameTick ? (player.orderCount || 0) : 0;
  if (used < max) return null;
  const secs = Math.max(1, Math.round((db.config.tickMs || 5000) / 1000));
  return `每轮只能操作 ${max} 次，等下一轮（约 ${secs} 秒）`;
}

function auth(ctx) {
  const db = getDb();
  const h = ctx.headers['authorization'] || '';
  let token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token && ctx.query.token) token = ctx.query.token;
  if (!token) return null;
  const s = db.sessions[token];
  if (!s) return null;
  if (now() - s.at > TOKEN_TTL) {
    delete db.sessions[token];
    return null;
  }
  const player = db.players[s.playerId];
  if (!player) return null;
  // 封禁中的账号，旧 token 立即失效
  if (player.banned) {
    delete db.sessions[token];
    return null;
  }
  return { token, player, scope: s.scope || 'full' };
}

function adminAuth(ctx) {
  const db = getDb();
  const h = ctx.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : ctx.query.token;
  if (!token) return false;
  const s = db.adminSessions[token];
  if (!s) return false;
  if (now() - s.at > 12 * 3600 * 1000) {
    delete db.adminSessions[token];
    return false;
  }
  return true;
}

function marketPayload(db, me) {
  const stocks = {};
  // 指数排在最前面
  const ordered = Object.values(db.stocks).sort((a, b) => (b.isIndex ? 1 : 0) - (a.isIndex ? 1 : 0));
  for (const st of ordered) {
    const code = st.code;
    const prev = st.series.length > 1 ? st.series[st.series.length - 2] : st.price;
    const report = st.isIndex ? null : reportPayload(st);
    stocks[code] = {
      code,
      name: st.name,
      icon: st.icon || '',
      industry: st.industry,
      desc: st.desc,
      price: st.price,
      isIndex: !!st.isIndex,
      shares: Number(st.shares) || 0,
      marketCap: report ? report.marketCap : 0,
      freeCap: report ? report.freeCap : 0,
      fair: Number(st.fair) || 0,
      nextReportTick: Number(st.nextReportTick) || 0,
      weather: st.weather
        ? {
          score: Number(st.weather.score) || 0,
          label: st.weather.label || '',
          target: Number(st.weatherTarget) || 0
        }
        : null,
      report,
      // 金融大鳄：提前看到金融板块的下一期财报
      preview: (me && me.theme === 'tycoon' && st.pendingReport)
        ? {
          eps: Number(st.pendingReport.eps) || 0,
          revenue: Number(st.pendingReport.revenue) || 0,
          netProfit: Number(st.pendingReport.netProfit) || 0,
          growth: Number(st.pendingReport.growth) || 0,
          tickLeft: Math.max(0, (Number(st.nextReportTick) || 0) - db.tick),
          expectPct: (() => {
            const f = st.fundamentals || {};
            const oldEps = Number(f.eps) || 0;
            const newEps = Number(st.pendingReport.eps) || 0;
            return oldEps > 0 ? ((newEps / oldEps) - 1) * 100 : 0;
          })()
        }
        : null,
      // 按各 K 线周期算涨跌幅（前端跟着当前周期显示）
      changes: changesFor(st.series, TIMEFRAMES),
      changePct: prev ? ((st.price - prev) / prev) * 100 : 0,
      dayChangePct: ((st.price - st.initialPrice) / st.initialPrice) * 100,
      status: st.status,
      initialPrice: st.initialPrice,
      // 标的性格（涨跌特征），前端用来显示特质说明
      trait: st.trait || {},
      traitName: st.trait?.name || '',
      st: !!st.st,
      stTicks: st.stTicks || 0,
      fxTarget: st.fxTarget || 0,
      stPrice: db.config.stPrice ?? 3,
      stDelistTicks: db.config.stDelistTicks ?? 100
    };
  }
  return {
    build: getBuild(),
    tick: db.tick,
    tickMs: db.config.tickMs,
    marketOpen: db.config.marketOpen !== false,
    startedAt: db.startedAt || 0,
    serverTime: now(),
    index: {
      value: db.index.value,
      series: db.index.series.slice(-600),
      changes: changesFor(db.index.series, TIMEFRAMES),
      nextRebalanceTick: Number(db.index.nextRebalanceTick) || 0,
      rebalanceTick: Number(db.index.rebalanceTick) || 0,
      weights: Object.entries(db.index.weights || {})
        .map(([code, w]) => {
          const st2 = db.stocks[code] || {};
          const sh = Number(st2.shares) || 0;
          const px2 = Number(st2.price) || 0;
          return {
            code,
            name: st2.name || code,
            weight: w,
            price: px2,
            marketCap: px2 * sh,
            freeCap: px2 * sh * (Number(st2.freeFloat) || 0.45)
          };
        })
        .sort((a, b) => b.weight - a.weight)
    },
    stocks,
    events: db.events
      .filter((e) => e.announced !== false)
      // 只下发「已经公布」的信息：文案 + 方向
      // trend / after 属于未来走势，绝不能给前端，否则 F12 一看就知道会不会反转
      .map((e) => ({
        id: e.id,
        text: e.text,
        companies: e.companies,
        dir: e.dir || (e.trend > 0 ? 1 : -1),
        createdAt: e.createdAt,
        ageTicks: Number(e.createdTick) > 0
          ? Math.max(0, db.tick - Number(e.createdTick))
          : Math.max(0, (Number(e.duration) || 0) - (Number(e.remaining) || 0))
      })),
    notices: (db.notices || [])
      .filter((n) => now() - n.at < 24 * 3600 * 1000)
      .map((n) => ({
        id: n.id, text: n.text, at: n.at, kind: n.kind || null,
        ageTicks: Number(n.tick) > 0 ? Math.max(0, db.tick - Number(n.tick)) : null
      })),
    me: me ? publicPlayer(me, db) : null,
    fx: {
      rate: Number(db.fx?.rate) || 0,
      prevRate: Number(db.fx?.prevRate) || 0,
      base: Number(db.fx?.base) || 0,
      at: db.fx?.at || 0,
      source: db.fx?.source || '',
      stale: !!db.fx?.stale
    },
    config: {
      fxEnabled: db.config.fxEnabled ?? 1,
      fxCoef: db.config.fxCoef ?? 1,
      fxLeverage: db.config.fxLeverage ?? 8,
      fxRefreshMs: db.config.fxRefreshMs ?? 60000,
      stPrice: db.config.stPrice ?? 3,
      stDelistTicks: db.config.stDelistTicks ?? 100,
      playerImpactTail: db.config.playerImpactTail ?? 1,
      impactCostCoef: db.config.impactCostCoef ?? 6,
      impactCostMax: db.config.impactCostMax ?? 0.06,
      minLeverage: db.config.minLeverage,
      maxLeverage: db.config.maxLeverage,
      feeRate: db.config.feeRate,
      stampDuty: db.config.stampDuty,
      maxOrdersPerTick: db.config.maxOrdersPerTick,
      globalEventScale: db.config.globalEventScale ?? 0.2,

      maxFillNotionalPerTick: db.config.maxFillNotionalPerTick ?? 150000,
      shopFakeNewsPrice: db.config.shopFakeNewsPrice ?? 500000,
      shopFakeNewsChance: db.config.shopFakeNewsChance ?? 0.2,
      shopFakeNewsCooldown: db.config.shopFakeNewsCooldown ?? 120,
      shopBodyguardPrice: db.config.shopBodyguardPrice ?? 50000,
      shopBodyguardTicks: db.config.shopBodyguardTicks ?? 720,
      shopThemePrice: db.config.shopThemePrice ?? 2000000,
      shopChannelBasePrice: db.config.shopChannelBasePrice ?? 300000,
      shopChannelRatio: db.config.shopChannelRatio ?? 1.5,
      shopChannelStep: db.config.shopChannelStep ?? 100000,
      maxFillNotionalPerTick: db.config.maxFillNotionalPerTick ?? 300000,
      redBonusRate: db.config.redBonusRate ?? 0.01,
      redBonusMinTicks: db.config.redBonusMinTicks ?? 12,
      limitOrderEnabled: db.config.limitOrderEnabled ?? 1,
      orderTtlTicks: db.config.orderTtlTicks ?? 720,
      maxPendingOrders: db.config.maxPendingOrders ?? 5,
      playerImpactEnabled: db.config.playerImpactEnabled ?? 1,
      workRatePerTick: db.config.workRatePerTick ?? 50,
      workOnlineMultiplier: db.config.workOnlineMultiplier ?? 2,
      workBankTicks: db.config.workBankTicks ?? 1440,
      stealMin: db.config.stealMin ?? 100,
      stealMax: db.config.stealMax ?? 10000,
      stealCapRatio: db.config.stealCapRatio ?? 0.001,
      stealCooldownTicks: db.config.stealCooldownTicks ?? 60,
      startingCash: db.config.startingCash
    }
  };
}

export async function handleApi(ctx) {
  const db = getDb();
  const { method, pathname, query, body, res } = ctx;

  // ---------- 登录 ----------
  if (pathname === '/api/login' && method === 'POST') {
    if (!db.config.allowRegister) return json(res, 403, { error: '当前关闭注册' });
    // 封禁检查（按昵称先查一遍）
    {
      const wantName = String(body.nickname || '').trim();
      const hit = Object.values(db.players).find((p) => p.nickname === wantName && p.banned);
      if (hit) {
        return json(res, 403, {
          error: `该账号已被封禁${hit.banReason ? '：' + hit.banReason : ''}`
        });
      }
    }
    // 去掉 HTML 特殊字符，避免昵称被当成标签渲染
    const nickname = String(body.nickname || '')
      .replace(/[<>&"'`\\]/g, '')
      .replace(/[\u0000-\u001f]/g, '')
      .trim()
      .slice(0, 16);
    const pin = String(body.pin || '').trim();
    if (nickname.length < 1) return json(res, 400, { error: '昵称不能为空' });
    if (nickname.length > 16) return json(res, 400, { error: '昵称最多 16 个字' });
    // 老账号可能还是 4 位，这里只做宽松校验；严格 6 位在「新建账号」分支里判
    if (!/^\d{4,6}$/.test(pin)) return json(res, 400, { error: 'PIN 必须是 4~6 位数字' });

    const guardKey = `${clientIp(ctx)}:${nickname}`;
    const locked = loginLockSeconds(guardKey);
    if (locked > 0) {
      return json(res, 429, { error: `密码错误次数过多，请 ${locked} 秒后再试` });
    }

    const PIN_LEN = Number(db.config.pinLength ?? 6);
    let player = Object.values(db.players).find((p) => p.nickname === nickname);

    if (player) {
      // 老账号还是 4 位 PIN：允许登进来，但只能用来改密码
      const legacy = String(player.pin || '').length !== PIN_LEN;
      const pinOk = legacy
        ? String(player.pin || '') === pin
        : String(player.pin || '') === pin;
      if (!pinOk) {
        noteLoginFailure(guardKey);
        return json(res, 401, { error: 'PIN 不对' });
      }
      loginFailures.delete(guardKey);

      if (legacy) {
        const t = uid(32);
        db.sessions[t] = { playerId: player.id, at: now(), scope: 'upgrade' };
        saveDb();
        return json(res, 200, {
          needPinUpgrade: true,
          token: t,
          player: { id: player.id, nickname: player.nickname, avatar: player.avatar || null }
        });
      }
    } else {
      if (!new RegExp(`^\\d{${PIN_LEN}}$`).test(pin)) {
        return json(res, 400, { error: `PIN 必须是 ${PIN_LEN} 位数字` });
      }
      const id = uid(10);
      player = {
        id,
        nickname,
        pin,
        avatar: null,
        cash: db.config.startingCash ?? 100000,
        positions: {},
        workBank: 0,
        workEarned: 0,
        stealQueued: null,
        stealEarned: 0,
        stealReadyAt: 0,
        guardUntil: 0,
        fakeNewsReadyAt: 0,
        channelLevel: 0,
        redBonusEarned: 0,
        theme: 'default',
        themes: [],
        orders: [],
        eq: [],
        createdAt: now()
      };
      db.players[id] = player;
    }

    const token = uid(32);
    db.sessions[token] = { playerId: player.id, at: now() };
    saveDb();
    return json(res, 200, { token, player: publicPlayer(player, db) });
  }

  // ---------- 公共行情 ----------
  if (pathname === '/api/market' && method === 'GET') {
    const a = auth(ctx);
    return json(res, 200, marketPayload(db, a?.player));
  }

  if (pathname === '/api/candles' && method === 'GET') {
    const code = String(query.code || '').toUpperCase();
    const tf = String(query.tf || '1m');
    const group = TIMEFRAMES[tf] || 12;
    const isIndex = code === 'INDEX';
    const src = isIndex ? db.index : db.stocks[code];
    if (!src) return json(res, 404, { error: '标的不存在' });
    const candles = candlesFromSeries(
      src.series, group, db.config.tickMs ?? 5000,
      Math.max(0, db.tick - src.series.length), 400, db.startedAt || 0,
      (absTick) => timeOfTick(db, absTick)
    );
    return json(res, 200, { code, tf, candles });
  }

  if (pathname === '/api/leaderboard' && method === 'GET') {
    const viewer = auth(ctx)?.player;
    const rows = Object.values(db.players).map((p) => {
      const equity = playerEquity(db, p);
      // 暗黑大手：别人看到的持仓方向也是随机的
      const stealth = p.theme === 'dark' && (!viewer || viewer.id !== p.id);
      // 隐世仙人：别人看不到他的持仓（成交记录照旧可见）
      const hermit = p.theme === 'hermit' && (!viewer || viewer.id !== p.id);
      if (hermit) {
        return {
          id: p.id,
          nickname: p.nickname,
          avatar: p.avatar || null,
          cash: p.cash,
          equity,
          guardUntil: p.guardUntil || 0,
          positions: [],
          theme: p.theme,
          hidden: true
        };
      }
      const positions = Object.entries(p.positions || {}).map(([code, pos]) => {
        const st = db.stocks[code];
        return {
          code,
          name: st?.name || code,
          side: stealth && Math.random() < 0.5
            ? (pos.side === 'long' ? 'short' : 'long')
            : pos.side,
          qty: pos.qty,
          entry: pos.entry,
          price: st?.price ?? 0,
          leverage: pos.leverage,
          pnl: st ? positionPnl(pos, st.price) : 0
        };
      });
      return {
        id: p.id,
        nickname: p.nickname,
        avatar: p.avatar || null,
        cash: p.cash,
        equity,
        guardUntil: p.guardUntil || 0,
        positions
      };
    });
    rows.sort((a, b) => b.equity - a.equity);
    return json(res, 200, { rows });
  }

  // ---------- 管理 ----------
  if (pathname === '/api/admin/login' && method === 'POST') {
    if (String(body.pin || '') !== String(db.config.adminPin || '0000')) {
      return json(res, 401, { error: '管理员口令不对' });
    }
    const t = uid(24);
    db.adminSessions[t] = { at: now() };
    saveDb();
    return json(res, 200, { token: t });
  }

  if (pathname.startsWith('/api/admin/')) {
    if (!adminAuth(ctx)) return json(res, 401, { error: '需要管理员权限' });
  }

  if (pathname === '/api/admin/state' && method === 'GET') {
    return json(res, 200, {
      config: db.config,
      marketOpen: db.config.marketOpen !== false,
      notices: db.notices || [],
      closedAt: db.closedAt || 0,
      stocks: Object.values(db.stocks).map((s) => ({
        code: s.code,
        name: s.name,
        price: s.price,
        status: s.status,
        statusUntil: s.statusUntil,
        st: !!s.st,
        stTicks: s.stTicks || 0,
        isIndex: !!s.isIndex,
        traitName: s.trait?.name,
        trait: s.trait || {}
      })),
      events: db.events,
      players: Object.values(db.players).map((p) => ({
        id: p.id,
        nickname: p.nickname,
        equity: playerEquity(db, p),
        cash: p.cash
      })),
      marketOpen: db.config.marketOpen !== false
    });
  }

  if (pathname === '/api/admin/player' && method === 'POST') {
    const id = String(body.id || '');
    const p = db.players[id];
    if (!p) return json(res, 404, { error: '没有这个玩家' });
    const action = String(body.action || '');
    if (action === 'ban') {
      p.banned = true;
      p.banReason = String(body.reason || '').slice(0, 40);
      p.bannedAt = now();
      // 踢掉他所有会话
      let kicked = 0;
      for (const [tk, sess] of Object.entries(db.sessions || {})) {
        if (sess.playerId === id) { delete db.sessions[tk]; kicked += 1; }
      }
      saveDb();
      return json(res, 200, { ok: true, banned: true, kicked });
    }
    if (action === 'unban') {
      p.banned = false;
      p.banReason = '';
      p.bannedAt = 0;
      saveDb();
      return json(res, 200, { ok: true, banned: false });
    }
    if (action === 'delete') {
      // 删号是不可逆的，必须已经封禁过
      if (!p.banned) return json(res, 400, { error: '请先封禁再删号' });
      const gone = id;
      const nick = p.nickname;
      delete db.players[gone];
      for (const [tk, sess] of Object.entries(db.sessions || {})) {
        if (sess.playerId === gone) delete db.sessions[tk];
      }
      saveDb();
      return json(res, 200, { ok: true, deleted: true, nickname: nick });
    }
    return json(res, 400, { error: '未知操作' });
  }

  if (pathname === '/api/admin/players' && (method === 'GET' || method === 'POST')) {
    const rows = Object.values(db.players)
      .map((p) => ({
        id: p.id,
        nickname: p.nickname,
        avatar: p.avatar || null,
        equity: playerEquity(db, p),
        cash: p.cash || 0,
        banned: !!p.banned,
        banReason: p.banReason || '',
        online: !!p.online
      }))
      .sort((a, b) => b.equity - a.equity);
    return json(res, 200, { players: rows });
  }

  if (pathname === '/api/admin/stock-trait' && method === 'POST') {
    const code = String(body.code || '').toUpperCase();
    const st = db.stocks[code];
    if (!st) return json(res, 404, { error: '没有这个标的' });
    if (!st.trait) st.trait = {};

    const allowed = [
      'volMult', 'revMult', 'eventMult', 'drift',
      'streak', 'bounceLo', 'bounceHi',
      'lotteryChance', 'lotteryLo', 'lotteryHi',
      'floorRatio', 'floorBoost',
      // 实时汇率（留美外汇）
      'coef', 'lev', 'fxEnabled', 'refreshMs', 'track'
    ];
    const changed = {};
    for (const [k, v] of Object.entries(body.patch || {})) {
      if (!allowed.includes(k)) continue;
      const num = Number(v);
      if (!Number.isFinite(num)) continue;
      st.trait[k] = num;
      changed[k] = num;
    }
    saveDb();
    return json(res, 200, { ok: true, code, trait: st.trait, changed });
  }

  if (pathname === '/api/admin/stock' && method === 'POST') {
    const code = String(body.code || '').toUpperCase();
    const st = db.stocks[code];
    if (!st) return json(res, 400, { error: '标的不存在' });
    const action = String(body.action || '');
    if (action === 'suspend') {
      st.status = 'suspended';
      st.statusUntil = now() + Number(body.hours || 1) * 3600 * 1000;
    } else if (action === 'resume') {
      st.status = 'normal';
      st.statusUntil = 0;
    } else if (action === 'delist') {
      st.status = 'delisted';
      st.statusUntil = 0;
    } else if (action === 'list') {
      st.status = 'normal';
      st.statusUntil = 0;
    } else if (action === 'set') {
      const price = Number(body.price);
      if (!Number.isFinite(price) || price <= 0) {
        return json(res, 400, { error: '股价必须是大于 0 的数字' });
      }
      const p = Math.max(0.01, Math.round(price * 100) / 100);
      st.price = p;
      // 合理价一起设过去，否则均值回归会慢慢把价格拉回原位
      st.fair = Math.round(p * 100) / 100;
      if (!Array.isArray(st.series)) st.series = [];
      st.series.push(Number(p.toFixed(4)));
      // 设完价重新判定一次 ST
      const stLine = Math.max(0.01, Number(db.config.stPrice ?? 3));
      if (!st.isIndex && st.status !== 'delisted') {
        st.st = p < stLine;
        if (!st.st) st.stTicks = 0;
      }
    } else {
      return json(res, 400, { error: '未知操作' });
    }
    saveDb();
    return json(res, 200, { ok: true, stock: st });
  }

  if (pathname === '/api/admin/news' && method === 'POST') {
    const text = String(body.text || '').trim();
    if (!text) return json(res, 400, { error: '新闻内容为空' });
    const companies = Array.isArray(body.companies)
      ? body.companies.map((c) => String(c).toUpperCase()).filter((c) => db.stocks[c])
      : [];
    const dir = Number(body.dir ?? 1) >= 0 ? 1 : -1;
    const duration = Math.min(200, Math.max(80, Math.round(Number(body.duration || 120))));
    const leakTicks = Math.min(10, Math.max(5, Math.round(Number(body.leakTicks || 7))));
    // 手动新闻也走两阶段：先偷跑 5~10 轮，再公布
    const ev = {
      id: 'ev_' + Math.random().toString(36).slice(2, 10),
      kind: 'leak',
      text,
      companies,
      dir,
      trend: dir * (0.005 + Math.random() * 0.004),
      leakTicks,
      leakLeft: leakTicks,
      duration,
      remaining: duration,
      createdAt: now(),
      announced: false,
      manual: true
    };
    ev.createdTick = db.tick;
    db.events.push(ev);
    saveDb();
    return json(res, 200, { ok: true, event: ev });
  }

  if (pathname === '/api/admin/announce' && method === 'POST') {
    const text = String(body.text || '').trim().slice(0, 300);
    if (!text) return json(res, 400, { error: '公告内容为空' });
    if (!Array.isArray(db.notices)) db.notices = [];
    const notice = {
      id: 'n_' + Math.random().toString(36).slice(2, 10),
      text,
      at: now(),
      tick: db.tick
    };
    db.notices.push(notice);
    if (db.notices.length > 20) db.notices.splice(0, db.notices.length - 20);
    saveDb();
    return json(res, 200, { ok: true, notice });
  }

  if (pathname === '/api/admin/announce/delete' && method === 'POST') {
    const id = String(body.id || '');
    const before = (db.notices || []).length;
    db.notices = (db.notices || []).filter((n) => n.id !== id);
    saveDb();
    return json(res, 200, { ok: true, removed: before - db.notices.length });
  }

  if (pathname === '/api/admin/market' && method === 'POST') {
    const wantOpen = body.open !== false;
    const wasOpen = db.config.marketOpen !== false;
    if (wantOpen === wasOpen) {
      return json(res, 200, { ok: true, marketOpen: wantOpen, unchanged: true });
    }
    db.config.marketOpen = wantOpen;
    if (!wantOpen) {
      db.closedAt = now();
    } else {
      db.closedAt = 0;
    }
    saveDb();
    return json(res, 200, { ok: true, marketOpen: db.config.marketOpen });
  }

  if (pathname === '/api/admin/event/clear' && method === 'POST') {
    db.events = [];
    saveDb();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/admin/config' && method === 'POST') {
    const patch = body.patch || {};
    const allowed = [
      'tickMs', 'baseVolatility', 'meanReversion', 'eventImpactScale',
      'feeRate', 'stampDuty', 'minLeverage', 'maxLeverage',
      'eventChance', 'localEventChance', 'eventDurationMin', 'eventDurationMax', 'globalEventScale',
      'workRatePerTick', 'workOnlineMultiplier', 'workBankTicks', 'stealMin', 'stealMax', 'stealCapRatio', 'stealCooldownTicks',
      'equitySampleTicks', 'equityMaxPoints',
      'shopFakeNewsPrice', 'shopFakeNewsChance', 'shopFakeNewsCooldown',
      'shopBodyguardPrice', 'shopBodyguardTicks', 'shopThemePrice',
      'shopChannelBasePrice', 'shopChannelRatio', 'shopChannelStep',
      'stPrice', 'stDelistTicks',
      'marketTradesEnabled',
      'fxEnabled', 'fxCoef', 'fxLeverage', 'fxRefreshMs', 'fxTrack',
      'impactCostCoef', 'impactCostMax', 'playerImpactTail',
      'maxOrdersPerTick', 'maxFillNotionalPerTick',
      'limitOrderEnabled', 'orderTtlTicks', 'maxPendingOrders',
      'playerImpactEnabled', 'playerImpactRef', 'playerImpactStrength',
      'playerImpactDecay', 'playerImpactMax', 'playerImpactFlowMax',
      'brokerMidpoint', 'brokerMidFloor', 'brokerSensitivity', 'brokerCap', 'brokerAlpha',
      'startingCash', 'adminPin', 'allowRegister', 'marketOpen', 'pinLength'
    ];
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.includes(k)) continue;
      db.config[k] = v;
    }
    saveDb();
    return json(res, 200, { ok: true, config: db.config });
  }

  // ---------- 需要登录 ----------
  const a = auth(ctx);
  if (!a) return json(res, 401, { error: '请先登录' });
  const me = a.player;

  // 老账号（4 位 PIN）：只能改密码，其它接口一律挡住
  if (a.scope === 'upgrade' && pathname !== '/api/pin/upgrade') {
    return json(res, 403, { error: '请先把 PIN 改成 6 位', needPinUpgrade: true });
  }

  if (pathname === '/api/pin/upgrade' && method === 'POST') {
    const pin = String(body.pin || '');
    if (!/^\d{6}$/.test(pin)) return json(res, 400, { error: 'PIN 必须是 6 位数字' });
    me.pin = pin;
    delete db.sessions[a.token];
    const t = uid(32);
    db.sessions[t] = { playerId: me.id, at: now() };
    saveDb();
    return json(res, 200, { ok: true, token: t, player: publicPlayer(me, db) });
  }

  if (pathname === '/api/me' && method === 'GET') {
    saveDb();
    return json(res, 200, { player: publicPlayer(me, db) });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    delete db.sessions[a.token];
    saveDb();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/avatar' && method === 'POST') {
    const dataUrl = String(body.dataUrl || '');
    const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(dataUrl);
    if (!m) return json(res, 400, { error: '图片格式不支持' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 800 * 1024) return json(res, 400, { error: '图片太大（限 800KB）' });
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const file = `${me.id}.${ext}`;
    fs.writeFileSync(path.join(AVATAR_DIR, file), buf);
    me.avatar = `/avatars/${file}?v=${Date.now()}`;
    saveDb();
    return json(res, 200, { avatar: me.avatar });
  }

  // ---- 每轮下单次数限制（防止刷成交额把小灯证券抬上去）----
  const orderBlocked = orderLimitBlocked(db, me);
  const consumeSlot = () => {
    const same = me.orderTick === db.tick;
    const prev = same ? (me.orderCount || 0) : 0;
    me.orderTick = db.tick;
    me.orderCount = Math.min(prev + 1, 1e6);
  };

  if (pathname === '/api/work/collect' && method === 'POST') {
    const bank = Math.max(0, Number(me.workBank) || 0);
    if (bank < 1) {
      return json(res, 400, { error: '钱袋还是空的，再等等' });
    }
    me.cash = (Number(me.cash) || 0) + bank;
    me.workEarned = (me.workEarned || 0) + bank;
    me.workBank = 0;
    saveDb();
    return json(res, 200, {
      ok: true,
      amount: Math.round(bank * 100) / 100,
      cash: me.cash,
      workEarned: me.workEarned
    });
  }

  if (pathname === '/api/steal' && method === 'POST') {
    const targetId = String(body.targetId || '');
    const victim = db.players[targetId];
    if (!victim) return json(res, 404, { error: '没这个人' });
    if (victim.id === me.id) return json(res, 400, { error: '偷自己不算本事' });

    const guardLeft = Number(victim.guardUntil || 0) - db.tick;
    if (guardLeft > 0) {
      return json(res, 400, {
        error: `${victim.nickname} 身边有保镖，还剩 ${guardLeft} 轮（约 ${Math.ceil(guardLeft * 5 / 60)} 分钟）`
      });
    }

    // 冷却中直接拦下来
    const cdUntil = Number(me.stealReadyAt) || 0;
    if (db.tick < cdUntil) {
      const left = cdUntil - db.tick;
      const ms = left * Number(db.config.tickMs || 5000);
      return json(res, 429, {
        error: `偷钱冷却中，还要等 ${left} 轮（约 ${Math.ceil(ms / 60000)} 分钟）`,
        cooldownLeft: left,
        readyAt: cdUntil
      });
    }

    if (me.stealQueued) return json(res, 429, { error: '这一轮已经派过小偷了，等下一轮' });
    if (victim.cash <= 0) return json(res, 400, { error: `${victim.nickname} 口袋比脸还干净` });

    me.stealQueued = { targetId: victim.id, targetName: victim.nickname, at: db.tick };
    saveDb();
    return json(res, 200, { ok: true, target: victim.nickname });
  }

  if (pathname === '/api/stock-trades' && method === 'GET') {
    const code = String(query.code || '').toUpperCase();
    if (!db.stocks[code]) return json(res, 404, { error: '没有这个标的' });
    const limit = Math.min(120, Math.max(1, Number(query.limit) || 40));

    const all = (db.trades || []).filter(
      (t) => t.code === code && (t.action === 'open' || t.action === 'close')
    );
    const rows = all
      .slice(-limit)
      .reverse()
      .map((t) => {
      const owner = db.players[t.playerId];
      // 「暗黑大手」主题技能：别人看到的成交方向是随机的（自己看自己是真的）
      const isStealth = owner && owner.theme === 'dark' && (!me || me.id !== t.playerId);
      const shownSide = isStealth && Math.random() < 0.5
        ? (t.side === 'long' ? 'short' : 'long')
        : t.side;
      const buy = t.action === 'open' ? shownSide === 'long' : shownSide === 'short';
      const notional = Number(t.qty) * Number(t.price);
      return {
        id: t.id,
        at: t.at,
        playerId: t.playerId,
        nickname: t.nickname,
        avatar: owner ? owner.avatar || null : null,
        emoji: t.emoji || null,
        isMarket: !!t.isMarket,
        action: t.action,
        side: shownSide,
        buy,
        leverage: Number(t.leverage) || 1,
        qty: t.qty,
        price: t.price,
        // 统一显示成交额（股数 × 价格），平仓不要显示返还现金，
        // 否则带杠杆的平仓看起来像「只成交了一点点」
        amount: notional
      };
    });
    return json(res, 200, { total: rows.length, rows });
  }

  if (pathname === '/api/equity-curve' && method === 'GET') {
    const points = (me.eq || []).map((p) => ({
      // [tick, 总资产, 累计外部收入]
      tick: p[0],
      time: Math.floor(timeOfTick(db, p[0]) / 1000),
      equity: p[1],
      income: p[2],
      trading: p[1] - p[2]
    }));
    return json(res, 200, {
      points,
      sampleTicks: db.config.equitySampleTicks || 12,
      tick: db.tick
    });
  }

  if (pathname === '/api/trades' && method === 'GET') {
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 50));
    const code = query.code ? String(query.code).toUpperCase() : '';
    let mine = (db.trades || []).filter((t) => t.playerId === me.id);
    if (code) mine = mine.filter((t) => t.code === code);
    const rows = mine.slice(-limit).reverse();
    return json(res, 200, { total: mine.length, rows });
  }

  if (pathname === '/api/order/limit' && method === 'POST') {
    const r = placeLimitOrder(db, me, body);
    if (!r.ok) return json(res, 400, r);
    saveDb();
    return json(res, 200, { ok: true, order: r.order, player: publicPlayer(me, db) });
  }

  if (pathname === '/api/order/cancel' && method === 'POST') {
    const r = cancelOrder(db, me, String(body.id || ''));
    if (!r.ok) return json(res, 400, r);
    saveDb();
    return json(res, 200, { ok: true, player: publicPlayer(me, db) });
  }

  // ---------- 商城 ----------
  if (pathname === '/api/shop/fake-news' && method === 'POST') {
    const price = Number(db.config.shopFakeNewsPrice ?? 100000);
    const chance = Math.max(0, Math.min(1, Number(db.config.shopFakeNewsChance ?? 0.2)));
    const cdTicks = Math.max(0, Number(db.config.shopFakeNewsCooldown ?? 120));

    const text = String(body.text || '').trim().slice(0, 120);
    if (text.length < 4) return json(res, 400, { error: '内容至少 4 个字' });
    const dir = Number(body.dir ?? 1) >= 0 ? 1 : -1;

    // 冷却中不许再买
    const readyAt = Number(me.fakeNewsReadyAt || 0);
    if (db.tick < readyAt) {
      const left = readyAt - db.tick;
      const sec = Math.ceil((left * (db.config.tickMs ?? 5000)) / 1000);
      return json(res, 429, {
        error: `假新闻冷却中，还要等 ${left} 轮（约 ${Math.ceil(sec / 60)} 分钟）`,
        leftTicks: left
      });
    }

    // 影响范围：不传 / 空数组 = 全市场
    let companies = [];
    if (Array.isArray(body.companies)) {
      companies = body.companies
        .map((c) => String(c).toUpperCase())
        .filter((c) => db.stocks[c] && !db.stocks[c].isIndex);
      companies = [...new Set(companies)];
    }

    if (me.cash < price) {
      return json(res, 400, {
        error: `现金不足，售价 $${price.toLocaleString()}，你只有 $${me.cash.toFixed(2)}`
      });
    }

    me.cash -= price;
    me.shopSpent = (me.shopSpent || 0) + price;
    me.fakeNewsReadyAt = db.tick + cdTicks;

    const hit = Math.random() < chance;
    const duration = 80 + Math.floor(Math.random() * 60);
    const ev = {
      id: 'ev_' + Math.random().toString(36).slice(2, 10),
      kind: 'leak',
      text,
      companies,
      dir,
      trend: hit ? dir * (0.0003 + Math.random() * 0.0003) : 0,
      leakTicks: 0,
      leakLeft: 0,
      duration,
      remaining: duration,
      createdAt: now(),
      announced: true,
      fake: true,
      buyerId: me.id
    };
    db.events.push(ev);
    saveDb();

    return json(res, 200, {
      ok: true,
      hit,
      price,
      cash: me.cash,
      companies,
      readyAt: me.fakeNewsReadyAt,
      cooldownTicks: cdTicks,
      event: { id: ev.id, text: ev.text, dir: ev.dir, companies, createdAt: ev.createdAt }
    });
  }

  if (pathname === '/api/shop/channel' && method === 'POST') {
    const basePrice = Math.max(1, Number(db.config.shopChannelBasePrice ?? 300000));
    const ratio = Math.max(1, Number(db.config.shopChannelRatio ?? 1.5));
    const step = Math.max(0, Number(db.config.shopChannelStep ?? 100000));
    const baseCap = Math.max(1, Number(db.config.maxFillNotionalPerTick ?? 300000));

    const level = Math.max(0, Math.floor(Number(me.channelLevel || 0)));
    const price = Math.round(basePrice * Math.pow(ratio, level));

    if (me.cash < price) {
      return json(res, 400, {
        error: `现金不足，这次要 $${price.toLocaleString()}，你只有 $${me.cash.toFixed(2)}`
      });
    }

    me.cash -= price;
    me.shopSpent = (me.shopSpent || 0) + price;
    me.channelLevel = level + 1;
    saveDb();

    return json(res, 200, {
      ok: true,
      level: me.channelLevel,
      paid: price,
      cap: baseCap + step * me.channelLevel,
      nextPrice: Math.round(basePrice * Math.pow(ratio, me.channelLevel)),
      cash: me.cash
    });
  }

  // ---------- 主题配色 ----------
  const THEMES = ['red', 'dark', 'tycoon', 'hermit'];

  if (pathname === '/api/shop/theme' && method === 'POST') {
    const code = String(body.theme || '').trim();
    if (!THEMES.includes(code)) return json(res, 400, { error: '没有这个主题' });

    const price = Number(db.config.shopThemePrice ?? 2000000);
    if (!Array.isArray(me.themes)) me.themes = [];

    // 主题切换冷却
    const cd = Math.max(0, Number(db.config.shopThemeCooldown ?? 100));
    const lastAt = Number(me.themeChangedTick || 0);
    if (cd > 0 && lastAt > 0 && db.tick - lastAt < cd) {
      const left = cd - (db.tick - lastAt);
      return json(res, 429, {
        error: `主题刚换过，还要等 ${left} 轮（约 ${Math.ceil(left * (db.config.tickMs ?? 5000) / 60000)} 分钟）`,
        leftTicks: left
      });
    }
    if (!me.themes.includes(code)) {
      if (me.cash < price) {
        return json(res, 400, {
          error: `现金不足，售价 $${price.toLocaleString()}，你只有 $${me.cash.toFixed(2)}`
        });
      }
      me.cash -= price;
      me.shopSpent = (me.shopSpent || 0) + price;
      me.themes.push(code);
    }
    me.theme = code;
    me.themeChangedTick = db.tick;
    saveDb();
    return json(res, 200, {
      ok: true, theme: code, themes: me.themes, price, cash: me.cash,
      changedTick: me.themeChangedTick
    });
  }

  if (pathname === '/api/shop/theme/select' && method === 'POST') {
    const code = String(body.theme || 'default').trim();
    if (code !== 'default' && !(Array.isArray(me.themes) && me.themes.includes(code))) {
      return json(res, 400, { error: '还没买这个主题' });
    }
    const cd = Math.max(0, Number(db.config.shopThemeCooldown ?? 100));
    const lastAt = Number(me.themeChangedTick || 0);
    if (code !== me.theme && cd > 0 && lastAt > 0 && db.tick - lastAt < cd) {
      const left = cd - (db.tick - lastAt);
      return json(res, 429, { error: `主题刚换过，还要等 ${left} 轮`, leftTicks: left });
    }
    if (code !== me.theme) me.themeChangedTick = db.tick;
    me.theme = code;
    saveDb();
    return json(res, 200, { ok: true, theme: code, changedTick: me.themeChangedTick });
  }

  if (pathname === '/api/shop/bodyguard' && method === 'POST') {
    const price = Number(db.config.shopBodyguardPrice ?? 50000);
    const ticks = Math.max(1, Math.round(Number(db.config.shopBodyguardTicks ?? 720)));

    if (me.cash < price) {
      return json(res, 400, {
        error: `现金不足，售价 $${price.toLocaleString()}，你只有 $${me.cash.toFixed(2)}`
      });
    }

    me.cash -= price;
    me.shopSpent = (me.shopSpent || 0) + price;
    // 还在保护期内再买一次就叠加时长
    const base = Math.max(Number(me.guardUntil || 0), db.tick);
    me.guardUntil = base + ticks;
    saveDb();

    return json(res, 200, {
      ok: true,
      price,
      guardUntil: me.guardUntil,
      leftTicks: me.guardUntil - db.tick,
      cash: me.cash
    });
  }

  if (pathname === '/api/tpsl' && method === 'POST') {
    const code = String(body.code || '').toUpperCase();
    const pos = me.positions[code];
    if (!pos) return json(res, 400, { error: '没有这只票的持仓' });

    const st = db.stocks[code];
    if (!st) return json(res, 400, { error: '标的不存在' });
    const price = st.price;
    const dir = pos.side === 'long' ? 1 : -1;

    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    const parse = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : NaN;
    };

    // 只改请求里出现的字段，没传的保持原样（避免并发编辑互相覆盖）
    let tp = pos.tp ?? null;
    let sl = pos.sl ?? null;
    let tpQty = pos.tpQty ?? null;
    let slQty = pos.slQty ?? null;

    if (has('tp')) {
      const v = parse(body.tp);
      if (v !== null) {
        if (!Number.isFinite(v) || v <= 0) return json(res, 400, { error: '止盈价必须是正数' });
        if ((v - price) * dir <= 0) {
          return json(res, 400, {
            error: `止盈价必须${dir > 0 ? '高于' : '低于'}现价 ${price.toFixed(2)}，否则会立刻成交`
          });
        }
      }
      tp = v;
    }

    if (has('sl')) {
      const v = parse(body.sl);
      if (v !== null) {
        if (!Number.isFinite(v) || v <= 0) return json(res, 400, { error: '止损价必须是正数' });
        if ((v - price) * dir >= 0) {
          return json(res, 400, {
            error: `止损价必须${dir > 0 ? '低于' : '高于'}现价 ${price.toFixed(2)}，否则会立刻成交`
          });
        }
      }
      sl = v;
    }

    pos.tp = tp;
    pos.sl = sl;
    // 触发时只平这么多股（留空 = 全平）
    const toQty = (v) => {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) && n > 0 ? Math.min(pos.qty, n) : null;
    };
    if (body.tpQty !== undefined) tpQty = toQty(body.tpQty);
    if (body.slQty !== undefined) slQty = toQty(body.slQty);
    pos.tpQty = tpQty;
    pos.slQty = slQty;
    saveDb();
    return json(res, 200, { ok: true, position: pos });
  }

  return json(res, 404, { error: '接口不存在' });
}
