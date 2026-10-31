import fs from 'node:fs';
import path from 'node:path';
import { getDb, saveDb, uid, now, AVATAR_DIR } from './store.js';
import { candlesFromSeries } from './engine.js';
import { TIMEFRAMES } from './config.js';
import { playerEquity, openPosition, closePosition, positionPnl } from './trading.js';
import { borrow, repay } from './loans.js';

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
    loan: p.loan || null,
    bankrupt: !!p.bankrupt,
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
  for (const [code, st] of Object.entries(db.stocks)) {
    const prev = st.series.length > 1 ? st.series[st.series.length - 2] : st.price;
    stocks[code] = {
      code,
      name: st.name,
      icon: st.icon || '',
      industry: st.industry,
      desc: st.desc,
      price: st.price,
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
    index: { value: db.index.value, series: db.index.series.slice(-600) },
    stocks,
    events: db.events
      .filter((e) => e.announced !== false)
      .map((e) => ({
        id: e.id,
        kind: e.kind || 'global',
        text: e.text,
        companies: e.companies,
        trend: e.trend,
        remaining: e.remaining,
        duration: e.duration,
        createdAt: e.createdAt
      })),
    me: me ? publicPlayer(me, db) : null,
    config: {
      minLeverage: db.config.minLeverage,
      maxLeverage: db.config.maxLeverage,
      feeRate: db.config.feeRate,
      stampDuty: db.config.stampDuty,
      loanEnabled: db.config.loanEnabled,
      loanTiers: db.config.loanTiers,
      loanRatePer100Ticks: db.config.loanRatePer100Ticks,
      loanTermHours: db.config.loanTermHours,
      loanMinRepay: db.config.loanMinRepay,
      maxOrdersPerTick: db.config.maxOrdersPerTick,
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
        loan: null,
        bankrupt: false,
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
        bankrupt: !!p.bankrupt,
        positions
      };
    });
    rows.sort((a, b) => b.equity - a.equity);
    return json(res, 200, { rows });
  }

  if (pathname === '/api/book' && method === 'GET') {
    return json(res, 200, { book: db.book.slice().reverse() });
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
        cash: p.cash,
        bankrupt: !!p.bankrupt
      })),
      book: db.book.slice().reverse()
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
    const trend = Number(body.trend ?? 0.004);
    const duration = Math.max(1, Math.round(Number(body.duration || 60)));
    const ev = {
      id: 'ev_' + Math.random().toString(36).slice(2, 10),
      text,
      companies,
      trend,
      duration,
      remaining: duration,
      createdAt: now(),
      manual: true
    };
    db.events.push(ev);
    saveDb();
    return json(res, 200, { ok: true, event: ev });
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
      // 开市：把休市这段时间补给所有贷款，别让人白等
      const delta = db.closedAt ? now() - db.closedAt : 0;
      if (delta > 0) {
        for (const p of Object.values(db.players)) {
          if (p.loan && p.loan.dueAt) p.loan.dueAt += delta;
        }
      }
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
      'loanEnabled', 'loanRatePer100Ticks', 'loanTermHours', 'loanMinRepay',
      'maxOrdersPerTick',
      'brokerMidpoint', 'brokerSensitivity', 'brokerCap', 'brokerAlpha',
      'adminPin', 'allowRegister', 'marketOpen', 'pinLength'
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

  if (pathname === '/api/tpsl' && method === 'POST') {
    const code = String(body.code || '').toUpperCase();
    const pos = me.positions[code];
    if (!pos) return json(res, 400, { error: '没有这只票的持仓' });
    pos.tp = body.tp ? Number(body.tp) : null;
    pos.sl = body.sl ? Number(body.sl) : null;
    saveDb();
    return json(res, 200, { ok: true, position: pos });
  }

  if (pathname === '/api/loan/borrow' && method === 'POST') {
    const r = borrow(db, me, body.amount);
    if (!r.ok) return json(res, 400, r);
    saveDb();
    return json(res, 200, { ok: true, player: publicPlayer(me, db) });
  }

  if (pathname === '/api/loan/repay' && method === 'POST') {
    const r = repay(db, me, body.amount);
    if (!r.ok) return json(res, 400, r);
    saveDb();
    return json(res, 200, { ok: true, result: r, player: publicPlayer(me, db) });
  }

  return json(res, 404, { error: '接口不存在' });
}
