import fs from 'node:fs';
import path from 'node:path';
import { getDb, saveDb, uid, now, AVATAR_DIR } from './store.js';
import { candlesFromSeries, changesFor } from './engine.js';
import { TIMEFRAMES } from './config.js';
import { playerEquity, openPosition, closePosition, positionPnl } from './trading.js';

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
    stocks[code] = {
      code,
      name: st.name,
      icon: st.icon || '',
      industry: st.industry,
      desc: st.desc,
      price: st.price,
      isIndex: !!st.isIndex,
      // 按各 K 线周期算涨跌幅（前端跟着当前周期显示）
      changes: changesFor(st.series, TIMEFRAMES),
      changePct: prev ? ((st.price - prev) / prev) * 100 : 0,
      dayChangePct: ((st.price - st.initialPrice) / st.initialPrice) * 100,
      status: st.status,
      initialPrice: st.initialPrice
    };
  }
  return {
    tick: db.tick,
    tickMs: db.config.tickMs,
    marketOpen: db.config.marketOpen !== false,
    startedAt: db.startedAt || 0,
    serverTime: now(),
    index: {
      value: db.index.value,
      series: db.index.series.slice(-600),
      changes: changesFor(db.index.series, TIMEFRAMES)
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
        createdAt: e.createdAt
      })),
    notices: (db.notices || [])
      .filter((n) => now() - n.at < 24 * 3600 * 1000)
      .map((n) => ({ id: n.id, text: n.text, at: n.at })),
    me: me ? publicPlayer(me, db) : null,
    config: {
      minLeverage: db.config.minLeverage,
      maxLeverage: db.config.maxLeverage,
      feeRate: db.config.feeRate,
      stampDuty: db.config.stampDuty,
      maxOrdersPerTick: db.config.maxOrdersPerTick,
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
    const nickname = String(body.nickname || '').trim().slice(0, 16);
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
      Math.max(0, db.tick - src.series.length), 400, db.startedAt || 0
    );
    return json(res, 200, { code, tf, candles });
  }

  if (pathname === '/api/leaderboard' && method === 'GET') {
    const rows = Object.values(db.players).map((p) => {
      const equity = playerEquity(db, p);
      const positions = Object.entries(p.positions || {}).map(([code, pos]) => {
        const st = db.stocks[code];
        return {
          code,
          name: st?.name || code,
          side: pos.side,
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
        traitName: s.trait?.name
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
      if (body.price) {
        st.price = Number(body.price);
        st.series.push(Number(body.price.toFixed(4)));
      }
      if (body.fair) st.fair = Number(body.fair);
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
    db.events.push(ev);
    saveDb();
    return json(res, 200, { ok: true, event: ev });
  }

  if (pathname === '/api/admin/announce' && method === 'POST') {
    const text = String(body.text || '').trim().slice(0, 300);
    if (!text) return json(res, 400, { error: '公告内容为空' });
    if (!Array.isArray(db.notices)) db.notices = [];
    const notice = { id: 'n_' + Math.random().toString(36).slice(2, 10), text, at: now() };
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
      'eventChance', 'localEventChance', 'eventDurationMin', 'eventDurationMax',
      'workRatePerTick', 'workOnlineMultiplier', 'workBankTicks', 'stealMin', 'stealMax', 'stealCapRatio', 'stealCooldownTicks',
      'equitySampleTicks', 'equityMaxPoints',
      'maxOrdersPerTick',
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

  if (pathname === '/api/order' && method === 'POST') {
    if (db.config.marketOpen === false) return json(res, 423, { error: '休市中，暂停交易' });
    if (me.bankrupt) return json(res, 403, { error: '你已破产，只能看不能玩' });
    if (orderBlocked) return json(res, 429, { error: orderBlocked });
    const result = openPosition(db, me, {
      code: String(body.code || '').toUpperCase(),
      side: body.side,
      qty: body.qty,
      leverage: body.leverage,
      tp: body.tp,
      sl: body.sl
    });
    if (!result.ok) return json(res, 400, result);
    consumeSlot();
    saveDb();
    return json(res, 200, { ok: true, player: publicPlayer(me, db) });
  }

  if (pathname === '/api/close' && method === 'POST') {
    if (db.config.marketOpen === false) return json(res, 423, { error: '休市中，暂停交易' });
    if (orderBlocked) return json(res, 429, { error: orderBlocked });
    const code = String(body.code || '').toUpperCase();
    const r = closePosition(db, me, code, 'manual');
    if (!r.ok) return json(res, 400, r);
    consumeSlot();
    saveDb();
    return json(res, 200, { ok: true, result: r, player: publicPlayer(me, db) });
  }

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
    const rows = all.slice(-limit).reverse().map((t) => {
      const owner = db.players[t.playerId];
      const buy = t.action === 'open' ? t.side === 'long' : t.side === 'short';
      const notional = Number(t.qty) * Number(t.price);
      return {
        id: t.id,
        at: t.at,
        playerId: t.playerId,
        nickname: t.nickname,
        avatar: owner ? owner.avatar || null : null,
        action: t.action,
        side: t.side,
        buy,
        leverage: Number(t.leverage) || 1,
        qty: t.qty,
        price: t.price,
        amount: t.action === 'open'
          ? notional
          : Number(t.returned ?? notional)
      };
    });
    return json(res, 200, { total: all.length, rows });
  }

  if (pathname === '/api/equity-curve' && method === 'GET') {
    const points = (me.eq || []).map((p) => ({
      // [tick, 总资产, 累计外部收入]
      tick: p[0],
      time: Math.floor((db.startedAt + p[0] * (db.config.tickMs || 5000)) / 1000),
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

  if (pathname === '/api/tpsl' && method === 'POST') {
    const code = String(body.code || '').toUpperCase();
    const pos = me.positions[code];
    if (!pos) return json(res, 400, { error: '没有这只票的持仓' });
    pos.tp = body.tp ? Number(body.tp) : null;
    pos.sl = body.sl ? Number(body.sl) : null;
    saveDb();
    return json(res, 200, { ok: true, position: pos });
  }

  return json(res, 404, { error: '接口不存在' });
}
