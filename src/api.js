import fs from 'node:fs';
import path from 'node:path';
import { getDb, saveDb, uid, now, AVATAR_DIR } from './store.js';
import { candlesFromSeries, changesFor, timeFromAxis, tickTimeAxis, pushNotice, noticeAlive, liveIndexWeights } from './engine.js';
import { stockFullWire, configWire, positionWire } from './wire.js';
import { bars15Candles } from './bars15.js';
import { unlockedEmojis, pushEmote, visibleEmotes } from './emoji.js';
import { pushVersionPost, latestVersionPost, listVersionPosts, deleteVersionPost, updateVersionPost } from './version.js';
import { nightInfoFor } from './theme.js';
import { TIMEFRAMES } from './config.js';
import { getBuild } from './build.js';
import { playerEquity, positionPnl } from './trading.js';
import { levelUpPlayer, withdrawFromBank, bankStatus } from './bank.js';
import { placeLimitOrder, cancelOrder, orderLimitBlocked, consumeOrderSlot, fillCapFor } from './orders.js';
import {
  THEMES as ACHV_THEMES, THEME_EMOJI, THEME_ACHIEVEMENTS, achvPayload, ensureAchvState,
  themeEmojiList, themeTier, isEvolved, evolveTheme, canEvolve, bumpAchv, achvEmojiList
} from './achievements.js';

const TOKEN_TTL = 30 * 24 * 3600 * 1000;

/** 所有可购买的主题 */
const THEMES = ['red', 'bear', 'dark', 'tycoon', 'hermit', 'probe', 'mind', 'night'];
/** 需要账号等级的主题（其余 Lv.1 就能买） */
import { notifyList, unreadCount, markNotifyRead } from './notify.js';
import {
  freeFeeDuration, cooldownLeft, hotTipTarget
} from './perks.js';
import { skillTextPayload } from './skillText.js';

const THEME_NEED_LEVEL = { probe: 2, mind: 2, night: 2 };

/** 表情目录：等级 → 资源目录（前端拼 /assets/<dir>/<file>，白名单才是通行证） */
const EMOJI_DIRS = { 1: 'emo_lv1' };

/**
 * 商店里每个商品需要的账号等级。
 *
 * 这是**唯一一份**等级门槛配置：
 *   - `marketPayload.config.shopItems` 会原样下发给前端 → 卡片上显示「Lv.N 解锁」并置灰
 *   - 每个 `/api/shop/*` 接口进来先过 `shopGate()` → 前端绕过去也没用
 * 主题的等级在 `THEME_NEED_LEVEL` 里另算（按主题 code 区分）。
 */
const SHOP_NEED_LEVEL = {
  // 道具
  fakeNews: 1,
  bodyguard: 1,
  channel: 1,
  freeFee: 1,        // 咸鱼代下单：Lv.1
  bg: 2,
  rename: 2,
  autoDca: 2,
  hotTip: 3,         // 游资情报：Lv.3
  // 其他
  levelUp: 1,
  comingSoon: 3
};

/** 商店商品的等级要求（至少 1 级） */
export function shopNeedLevel(key) {
  return Math.max(1, Number(SHOP_NEED_LEVEL[key]) || 1);
}

/**
 * 等级不够就返回 { error, needLevel, level }，够了返回 null。
 * 调用方：`const gate = shopGate(me, 'rename'); if (gate) return json(res, 403, gate);`
 */
export function shopGate(me, key) {
  const need = shopNeedLevel(key);
  const lv = Math.max(1, Math.floor(Number(me?.level) || 1));
  if (lv >= need) return null;
  return {
    error: `这个商品要 Lv.${need} 才能买，你现在是 Lv.${lv}`,
    needLevel: need,
    level: lv
  };
}

/**
 * 保镖订单：把「买几份」折算成总价和总时长。
 * 商城有「购买」和「一次买十份」两个按钮，但服务端只认 qty ——
 * 这样两个按钮的算法不会跑偏，也挡住前端乱传份数。
 */
export function bodyguardOrder(cfg, qty) {
  const unitPrice = Math.max(1, Number(cfg?.shopBodyguardPrice ?? 50000));
  const unitTicks = Math.max(1, Math.round(Number(cfg?.shopBodyguardTicks ?? 720)));
  const n = Math.max(1, Math.min(10, Math.round(Number(qty) || 1)));
  return { qty: n, unitPrice, total: unitPrice * n, unitTicks, addTicks: unitTicks * n };
}

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
    positions[code] = positionWire(pos, st);
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
    // 夜行者主题：此刻的偷钱 CD 和夜里状态（前端显示用）
    night: nightInfoFor(db, p),
    investigateReadyAt: Number(p.investigateReadyAt) || 0,
    guardUntil: p.guardUntil || 0,
    fakeNewsReadyAt: p.fakeNewsReadyAt || 0,
    channelLevel: p.channelLevel || 0,
    redBonusEarned: p.redBonusEarned || 0,
    bearBonusEarned: p.bearBonusEarned || 0,
    dividendEarned: p.dividendEarned || 0,
    theme: p.theme || 'default',
    skill: p.skill || p.theme || 'default',
    level: Math.max(1, Math.floor(Number(p.level) || 1)),
    bgUnlocked: !!p.bgUnlocked,
    background: p.background || '',
    // 自定义背景的不透明度（0~100）；前端用 1 减它当作「透明度」
    bgOpacity: Number.isFinite(Number(p.bgOpacity)) ? Math.max(0, Math.min(100, Number(p.bgOpacity))) : 100,
    renameReadyAt: Number(p.renameReadyAt) || 0,
    // -1 = 从没换过技能
    skillChangedTick: Number.isFinite(Number(p.skillChangedTick)) ? Number(p.skillChangedTick) : -1,
    themes: Array.isArray(p.themes) ? p.themes : [],
    // 主题成就 / 进化（进度、结晶、阶数都在这）
    achv: achvPayload(db, p),
    frozen: Math.round((p.orders || []).reduce((a, o) => a + (Number(o.reserve) || 0), 0) * 100) / 100,
    // 这个玩家本轮的「单笔成交上限」（基础 + 商城通道 + 账号等级）
    fillCap: fillCapFor(db, p),
    // 自动定投：autoDca = 买过这件道具，autoDcaOn = 当前是否开着
    autoDca: !!p.autoDca,
    autoDcaOn: p.autoDcaOn !== false,
    // 🐟 咸鱼代下单：免手续费生效到哪一轮 / 冷却到哪一轮
    freeFeeUntilTick: Number(p.freeFeeUntilTick) || 0,
    freeFeeReadyAt: Number(p.freeFeeReadyAt) || 0,
    // 🕵 游资情报：冷却到哪一轮
    hotTipReadyAt: Number(p.hotTipReadyAt) || 0,
    // 丰川银行：bank = 余额（不算进总资产），bankDeposited = 累计存入
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
      autoDca: !!o.autoDca
    })),
    income: (p.workEarned || 0) + (p.stealEarned || 0),
    // 站内通知：最新 20 条（网页端目前不显示，但安卓壳靠它发系统通知）
    notices: notifyList(p, 20),
    // 表情互动：这个等级解锁了哪些贴纸
    emojis: unlockedEmojis(p.level),
    createdAt: p.createdAt
  };
}

/**
 * 管理端「控制台」：真人玩家最近的成交。
 *
 * - 过滤掉 `isMarket` 的噪声成交（那些不是人下的单）
 * - `onlyTrade` 只要开仓/平仓；关掉后连分红、偷钱也一起看
 * - `afterId`：增量轮询用。给了就从这条之后取新的；找不到（日志被裁掉了）就当首次
 * 返回的 rows 是**最新在前**，字段按「成交记录」那套：股数 / 价格 / 金额 / 杠杆 / 方向。
 */
export function consoleRows(db, { afterId = '', limit = 60, onlyTrade = true } = {}) {
  const all = Array.isArray(db?.trades) ? db.trades : [];
  let real = all.filter((t) => t && t.playerId && !t.isMarket);
  if (onlyTrade) real = real.filter((t) => t.action === 'open' || t.action === 'close');

  const max = Math.max(1, Math.min(300, Math.floor(Number(limit) || 60)));
  let start = 0;
  if (afterId) {
    const idx = real.findIndex((t) => t.id === afterId);
    if (idx >= 0) start = idx + 1;
  }
  const slice = real.slice(start);
  const rows = slice.slice(-max).reverse().map((t) => {
    const qty = Number(t.qty) || 0;
    const price = Number(t.price) || 0;
    const amount = Number.isFinite(Number(t.amount))
      ? Number(t.amount)
      : Math.round(qty * price * 100) / 100;
    return {
      id: t.id,
      at: Number(t.at) || 0,
      playerId: t.playerId,
      nickname: t.nickname || '',
      code: t.code || '',
      name: t.name || t.code || '',
      action: t.action || '',
      side: t.side || 'long',
      qty,
      price,
      amount,
      leverage: Number(t.leverage) || 1,
      fee: Number(t.fee) || 0,
      pnl: Number(t.pnl) || 0,
      reason: t.reason || ''
    };
  });

  // 最近一小时的小结（前端顶栏显示）
  const since = Date.now() - 3600 * 1000;
  const hour = real.filter((t) => (Number(t.at) || 0) >= since);
  const players = new Set(hour.map((t) => t.playerId));

  return {
    rows,
    total: real.length,
    latestId: rows.length ? rows[0].id : (real.length ? real[real.length - 1].id : ''),
    hourCount: hour.length,
    hourPlayers: players.size,
    now: Date.now()
  };
}

/**
 * 排行榜数据（按总资产降序）。
 * `hiddenRank` 的号直接跳过：账号还在、能登录能交易，只是不出现在榜上，
 * 也就不会被别人在榜里点到「偷钱 / 调查」。
 */
export function leaderboardRows(db) {
  const rows = Object.values(db.players || {})
    .filter((p) => p && !p.hiddenRank)
    .map((p) => {
      const equity = playerEquity(db, p);
      const bank = Math.max(0, Number(p.bank) || 0);
      // 🧙 隐世仙人进化：排行榜上自己的资产模糊成「≈X」（不暴露精确身家）
      const blur = p.skill === 'hermit' && isEvolved(p, 'hermit');
      const fuzz = (v) => {
        const n = Math.max(0, Number(v) || 0);
        if (n <= 0) return 0;
        const mag = Math.pow(10, Math.max(0, Math.floor(Math.log10(n)) - 1));
        return Math.round(n / mag) * mag;      // 保留 2 位有效数字
      };
      return {
        id: p.id,
        nickname: p.nickname,
        avatar: p.avatar || null,
        cash: p.cash,
        // 名字旁边显示的成就徽章（🐂 / 🐊✦ …）
        achvEmojis: achvEmojiList(p),
        fuzzed: !!blur,
        // equity = 交易资产（现金 + 持仓 + 冻结），偷钱上限仍按这个算
        equity: blur ? fuzz(equity) : equity,
        bank,
        // total = 排名用的总资产（含银行存款）
        total: Math.round(((blur ? fuzz(equity) : equity) + bank) * 100) / 100,
        level: Math.max(1, Math.floor(Number(p.level) || 1)),
        // 故意留空：排行榜不公开任何人的持仓（「暗中调查」技能才有价值）
        // 也不发 theme / skill / guardUntil —— 那等于把别人的保镖和技能提前亮出来
        positions: []
      };
    });
  rows.sort((a, b) => b.total - a.total || b.equity - a.equity);
  return rows;
}

/**
 * 自定义背景的不透明度：夹到 0~100 的整数。
 * 非数字返回 null（调用方据此报错）。
 */
export function normalizeBgOpacity(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * 暗中调查（Lv.2 主题「暗中调查」的技能）：随机看目标玩家的一个持仓
 * 返回 { ok:true, ... } 或 { ok:false, status, error, leftTicks? }
 */
export function investigatePlayer(db, me, targetId) {
  if (me.skill !== 'probe') {
    return { ok: false, status: 403, error: '需要装备「暗中调查」主题才能调查' };
  }
  const evolved = isEvolved(me, 'probe');
  const cdBase = Math.max(0, Math.round(Number(db.config.investigateCooldownTicks ?? 30)));
  const cdEvo = Math.max(0, Math.round(Number(db.config.investigateCooldownEvolved ?? 20)));
  const cd = evolved ? Math.min(cdBase, cdEvo) : cdBase;
  const readyAt = Number(me.investigateReadyAt) || 0;
  if (db.tick < readyAt) {
    const left = readyAt - db.tick;
    return { ok: false, status: 429, error: `调查冷却中，还要等 ${left} 轮`, leftTicks: left };
  }
  const victim = db.players[String(targetId || '')];
  // 隐身的号同样不能被调查
  if (!victim || victim.hiddenRank) return { ok: false, status: 404, error: '没这个人' };
  if (victim.id === me.id) return { ok: false, status: 400, error: '调查自己没意义' };

  const list = Object.entries(victim.positions || {}).filter(([code]) => db.stocks[code]);
  if (!list.length) {
    return { ok: false, status: 400, error: `${victim.nickname} 现在空仓，什么也查不到` };
  }

  // 未进化：随机看一个持仓；进化后（Ⅱ 阶）：直接看全部持仓 + 对方的成本价
  const picked = evolved
    ? list
    : [list[Math.floor(Math.random() * list.length)]];
  const pickOne = ([code, pos]) => {
    const st = db.stocks[code];
    const price = Number(st.price) || 0;
    const pnl = positionPnl(pos, price);
    const margin = Number(pos.margin) || 0;
    return {
      code,
      name: st.name || code,
      side: pos.side === 'short' ? 'short' : 'long',
      qty: Number(pos.qty) || 0,
      entry: Number(pos.entry) || 0,
      price,
      leverage: Number(pos.leverage) || 1,
      margin,
      pnl,
      pnlPct: margin > 0 ? (pnl / margin) * 100 : 0,
      heldTicks: Math.max(0, db.tick - (Number(pos.openedTick) || db.tick))
    };
  };
  const positions = picked.map(pickOne);
  const [code, pos] = picked[0];
  const st = db.stocks[code];
  const price = Number(st.price) || 0;
  const pnl = positionPnl(pos, price);
  const margin = Number(pos.margin) || 0;

  // 查到了才进冷却，空手而归不罚
  me.investigateReadyAt = db.tick + cd;
  // 🕵️ 情报网：累计调查成功次数
  ensureAchvState(me);
  bumpAchv(db, me, 'probeCount', 1);

  return {
    // 进化后前端用这个列表渲染全部持仓；未进化只给单个 position（不下发列表）
    evolved,
    ...(evolved ? { positions } : {}),
    cooldownTicks: cd,
    ok: true,
    target: { id: victim.id, nickname: victim.nickname, avatar: victim.avatar || null },
    position: {
      code,
      name: st.name || code,
      side: pos.side === 'short' ? 'short' : 'long',
      qty: Number(pos.qty) || 0,
      entry: Number(pos.entry) || 0,
      price,
      leverage: Number(pos.leverage) || 1,
      margin,
      pnl,
      pnlPct: margin > 0 ? (pnl / margin) * 100 : 0,
      heldTicks: Math.max(0, db.tick - (Number(pos.openedTick) || db.tick))
    },
    readyAt: me.investigateReadyAt
  };
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

export function marketPayload(db, me) {
  const stocks = {};
  // 指数排在最前面
  const ordered = Object.values(db.stocks).sort((a, b) => (b.isIndex ? 1 : 0) - (a.isIndex ? 1 : 0));
  for (const st of ordered) {
    // 只发 src/wire.js 白名单里的字段：价格/涨跌幅/财报/ST/预览/情绪(仅读心)
    stocks[st.code] = stockFullWire(db, st, me);
  }
  return {
    build: getBuild(),
    tick: db.tick,
    tickMs: db.config.tickMs,
    marketOpen: db.config.marketOpen !== false,
    // 首屏就能看到的表情（上一轮发出来的那些）
    emotes: visibleEmotes(db),
    // 版本更新公告（「市场快讯」上方固定那一栏；没有就 null）
    versionPost: latestVersionPost(db),
    index: {
      value: db.index.value,
      series: db.index.series.slice(-600),
      changes: changesFor(db.index.series, TIMEFRAMES),
      nextRebalanceTick: Number(db.index.nextRebalanceTick) || 0,
      rebalanceTick: Number(db.index.rebalanceTick) || 0,
      weights: (() => {
        const live = liveIndexWeights(db, 'index');
        return Object.entries(db.index.weights || {})
          .map(([code, w]) => {
            const st2 = db.stocks[code] || {};
            const px2 = Number(st2.price) || 0;
            return {
              code,
              name: st2.name || code,
              weight: w,
              liveWeight: Number(live[code]) || 0,
              freeCap: px2 * (Number(st2.shares) || 0) * (Number(st2.freeFloat) || 0.45)
            };
          })
          .sort((a, b) => b.weight - a.weight);
      })()
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
      .filter((n) => noticeAlive(db, n))
      .map((n) => ({
        id: n.id, text: n.text, at: n.at, kind: n.kind || null,
        ageTicks: Number(n.tick) > 0 ? Math.max(0, db.tick - Number(n.tick)) : null,
        // 有 tick 期限的公告，前端可以用来显示「还剩 N 轮」
        leftTicks: Number(n.expireTick) > 0 ? Math.max(0, Number(n.expireTick) - db.tick) : null
      })),
    smallIndex: (() => {
      const si = db.smallIndex || {};
      const liveS = liveIndexWeights(db, 'smallIndex');
      return {
        value: Number(si.value) || 0,
        weights: Object.entries(si.weights || {})
          .map(([code, w]) => {
            const st2 = db.stocks[code] || {};
            const px2 = Number(st2.price) || 0;
            return {
              code, name: st2.name || code, weight: w,
              liveWeight: Number(liveS[code]) || 0,
              freeCap: px2 * (Number(st2.shares) || 0) * (Number(st2.freeFloat) || 0.45)
            };
          })
          .sort((a, b) => b.weight - a.weight),
        nextRebalanceTick: Number(si.nextRebalanceTick) || 0,
        rebalanceTick: Number(si.rebalanceTick) || 0
      };
    })(),
    me: me ? publicPlayer(me, db) : null,
    // 玩家可见的配置：白名单在 src/wire.js（引擎参数一律不下发）
    config: {
      ...configWire(db.config),
      // 三个对象型配置：唯一真相就在这个文件里（等级门槛 / 表情目录）
      shopItems: SHOP_NEED_LEVEL,
      themeNeedLevel: THEME_NEED_LEVEL,
      emojiDirs: EMOJI_DIRS,
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

  // 主题技能文案：数字全部按当前后台配置生成（商城里不再写死「20 轮 / 50%」）
  if (pathname === '/api/skill-text' && method === 'GET') {
    return json(res, 200, skillTextPayload(db));
  }

  if (pathname === '/api/candles' && method === 'GET') {
    const code = String(query.code || '').toUpperCase();
    const tf = String(query.tf || '1m');
    const group = TIMEFRAMES[tf] || 12;
    const isIndex = code === 'INDEX';
    const src = isIndex ? db.index : db.stocks[code];
    if (!src) return json(res, 404, { error: '标的不存在' });
    // 时间轴：真实时间，但把停机空洞压掉（否则 K 线会出现大段空白）
    const axis = tickTimeAxis(db);
    const candles = candlesFromSeries(
      src.series, group, db.config.tickMs ?? 5000,
      Math.max(0, db.tick - src.series.length), 1200, db.startedAt || 0,
      (absTick) => timeFromAxis(axis, absTick, db)
    );
    return json(res, 200, { code, tf, candles });
  }

  // 15 分钟 K 线：单独一份 48 小时的包（192 根，约 10~16 KB）
  // 主 series 只有 5 小时，凑不出 48 小时的 15m，所以单独存、单独发
  if (pathname === '/api/candles15' && method === 'GET') {
    const code = String(query.code || '').toUpperCase();
    const src = db.stocks[code];
    if (!src) return json(res, 404, { error: '标的不存在' });
    const axis = tickTimeAxis(db);
    const candles = bars15Candles(src.bars15 || [], (absTick) => timeFromAxis(axis, absTick, db));
    return json(res, 200, { code, tf: '15m', candles, max: candles.length });
  }

  if (pathname === '/api/leaderboard' && method === 'GET') {
    // 排行榜只公开资产，不再公开任何人的持仓
    // 被管理员设成「隐身」的号不出现在榜上（账号照常能登录、能交易，只是别人看不到）
    return json(res, 200, { rows: leaderboardRows(db) });
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
      tick: db.tick,
      // 过期的公告不再下发，管理面板看到的和玩家看到的一致
      notices: (db.notices || []).filter((n) => noticeAlive(db, n)),
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
      versionPosts: listVersionPosts(db),
      players: Object.values(db.players).map((p) => ({
        id: p.id,
        nickname: p.nickname,
        equity: playerEquity(db, p),
        cash: p.cash
      })),
      marketOpen: db.config.marketOpen !== false
    });
  }

  // 版本公告：发一条 / 删一条
  if (pathname === '/api/admin/version-post' && method === 'POST') {
    const r = pushVersionPost(db, { version: body.version, title: body.title, body: body.body, tick: db.tick });
    if (!r.ok) return json(res, 400, { error: r.error });
    saveDb();
    return json(res, 200, { ok: true, post: r.post, posts: listVersionPosts(db) });
  }

  // 改一条已有的版本公告（只改 version/title/body，id/at/tick 保留）
  if (pathname === '/api/admin/version-post/update' && method === 'POST') {
    const r = updateVersionPost(db, body.id, { version: body.version, title: body.title, body: body.body });
    if (!r.ok) return json(res, r.error === '没有这条版本公告' ? 404 : 400, { error: r.error });
    saveDb();
    return json(res, 200, { ok: true, post: r.post, posts: listVersionPosts(db) });
  }

  if (pathname === '/api/admin/version-post/delete' && method === 'POST') {
    const removed = deleteVersionPost(db, body.id);
    if (!removed) return json(res, 404, { error: '没有这条版本公告' });
    saveDb();
    return json(res, 200, { ok: true, posts: listVersionPosts(db) });
  }

  // 控制台：真人玩家最近成交（前端每 3 秒拉一次，用 afterId 增量）
  if (pathname === '/api/admin/console' && method === 'GET') {
    const data = consoleRows(db, {
      afterId: String(query.afterId || ''),
      limit: Number(query.limit) || 60,
      onlyTrade: String(query.onlyTrade ?? '1') !== '0'
    });
    return json(res, 200, { ...data, tick: db.tick });
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
    // 排行榜隐身：账号不动，只是不出现在榜上（也不当别人的偷钱目标）
    if (action === 'hide' || action === 'show') {
      p.hiddenRank = action === 'hide';
      saveDb();
      return json(res, 200, { ok: true, hidden: p.hiddenRank, nickname: p.nickname });
    }
    if (action === 'logout') {
      // 只踢下线，不封号：清掉这个玩家的所有会话
      let killed = 0;
      for (const [tk, sess] of Object.entries(db.sessions || {})) {
        if (sess && sess.playerId === id) { delete db.sessions[tk]; killed += 1; }
      }
      saveDb();
      return json(res, 200, { ok: true, kicked: killed });
    }
    if (action === 'bank') {
      // 管理端给指定玩家的银行账户打钱（负数 = 扣钱），方便发补偿/活动奖励
      const raw = Number(body.amount);
      if (!Number.isFinite(raw) || raw === 0) {
        return json(res, 400, { error: '金额要填非零数字' });
      }
      if (Math.abs(raw) > 1e12) return json(res, 400, { error: '金额太大了' });
      const amount = Math.trunc(raw);
      const before = Math.max(0, Number(p.bank) || 0);
      const after = Math.max(0, before + amount);
      p.bank = Math.round(after * 100) / 100;
      // 只有真的存进去了才计入「累计存入」
      const delta = p.bank - before;
      if (delta > 0) {
        p.bankDeposited = Math.round((Number(p.bankDeposited) || 0) + delta);
      }
      saveDb();
      return json(res, 200, {
        ok: true, nickname: p.nickname,
        amount: delta, before, bank: p.bank, bankDeposited: p.bankDeposited || 0
      });
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
        bank: Math.round((Number(p.bank) || 0) * 100) / 100,
        banned: !!p.banned,
        banReason: p.banReason || '',
        hidden: !!p.hiddenRank,
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
      // 散户情绪：只在这个个股上覆盖全局参数（留空 = 跟随全局）
      'sentStrength', 'sentTicks', 'sentRollMin', 'sentRollMax', 'sentRollTicks', 'sentDrift', 'sentEdge',
      // 实时汇率（留美外汇）
      'coef', 'lev', 'fxEnabled', 'refreshMs', 'track'
    ];
    const changed = {};
    for (const [k, v] of Object.entries(body.patch || {})) {
      if (!allowed.includes(k)) continue;
      // null / '' = 删掉这层覆盖，回到跟随全局参数
      if (v === null || v === undefined || v === '') {
        if (k in st.trait) {
          delete st.trait[k];
          changed[k] = null;
        }
        continue;
      }
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
    // 显示时长（轮）：0 / 负数 / 不传 = 永久，不自动消失
    const rawTicks = Number(body.ticks);
    const ticks = Number.isFinite(rawTicks) && rawTicks > 0
      ? Math.min(43200, Math.round(rawTicks))
      : 0;
    const notice = pushNotice(db, text, ticks);
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
      'dividendRate', 'dividendCap',
      'growthCeiling', 'maxPremium', 'indexRebalanceTicks', 'rallyMin', 'rallyMax',
      'eventChance', 'eventDurationMin', 'eventDurationMax', 'globalEventScale',
      'workRatePerTick', 'workOnlineMultiplier', 'workBankTicks', 'stealMin', 'stealMax', 'stealCapRatio', 'stealCooldownTicks',
      'equitySampleTicks', 'equityMaxPoints',
      'shopFakeNewsPrice', 'shopFakeNewsChance', 'shopFakeNewsCooldown',
      'shopBodyguardPrice', 'shopBodyguardTicks', 'shopThemePrice', 'mindThemePrice', 'mindFakeChance',
      'mindAccurateChanceEvolved',
      'goldBase', 'goldVol', 'goldRev', 'goldCoef', 'goldJitter',
      'reportVol', 'reportVolMin', 'reportVolMax', 'fairLookback', 'reportRefCap',
      'nightStartHour', 'nightEndHour', 'nightStealCooldown',
      'shopChannelBasePrice', 'shopChannelRatio', 'shopChannelStep',
      'shopAutoDcaPrice', 'shopAutoDcaPremium',
      'shopFreeFeePrice', 'shopFreeFeeTicks', 'shopFreeFeeCooldown',
      'shopHotTipPrice', 'shopHotTipCooldown',
      'bankPoorThreshold', 'bankWithdrawRateMin', 'bankWithdrawRateMax', 'bankWithdrawFloor',
      'stPrice', 'stDelistTicks',
      'marketTradesEnabled',
      'sentimentEnabled', 'sentimentStrength', 'sentimentTicks', 'sentimentRollTicks',
      'sentimentRollMin', 'sentimentRollMax', 'sentimentDrift', 'sentimentEdge',
      'marketTradesRate', 'redBonusRate', 'redBonusMinTicks', 'bearBonusRate', 'bearBonusMinTicks',
      // ---- 虚假成交（会推动股价）/ 游资 / 市场资金冲击 ----
      'marketTradesSmallP', 'marketTradesMidP', 'marketTradesBigP', 'marketTradesChase',
      'hotMoneyEnabled', 'hotMoneySwitchMin', 'hotMoneySwitchMax', 'hotMoneyMin', 'hotMoneyMax',
      'marketImpactEnabled', 'marketImpactRef', 'marketImpactStrength', 'marketImpactMax',
      'marketImpactDecay', 'marketImpactFlowMax',
      'fxEnabled', 'fxCoef', 'fxLeverage', 'fxRefreshMs', 'fxTrack',
      'impactCostCoef', 'impactCostMax', 'playerImpactTail',
      'maxOrdersPerTick', 'maxFillNotionalPerTick',
      'limitOrderEnabled', 'orderTtlTicks', 'maxPendingOrders',
      'morningRallyEnabled', 'morningRallyStartHour', 'morningRallyEndHour',
      'morningRallyTotal', 'morningRallyPull',
      'investigateCooldownTicks',
      'levelBaseAsset', 'levelGrowth', 'levelUpRatio', 'levelFillBonus',
      'playerImpactEnabled', 'playerImpactRef', 'playerImpactStrength', 'impactRefFreeCap',
      'playerImpactDecay', 'playerImpactMax', 'playerImpactFlowMax',
      'brokerMidpoint', 'brokerMidFloor', 'brokerSensitivity', 'brokerCap', 'brokerAlpha',
      'startingCash', 'adminPin', 'allowRegister', 'marketOpen', 'pinLength',
      // ---- 主题成就 / 进化 ----
      'achvShardPerEvolve',
      'achvRedTrendTarget', 'achvRedBonusTarget',
      'achvBearTrendTarget', 'achvBearBonusTarget',
      'achvDarkHandTarget', 'achvDarkHandCount', 'achvDarkPushTarget', 'achvDarkPushWindowTicks',
      'achvTycoonProphetTarget', 'achvTycoonProphetLeverage', 'achvTycoonProfitTarget',
      'achvHermitFollowTarget', 'achvHermitPosTarget', 'achvHermitFollowWindowTicks',
      'achvProbeWeakTarget', 'achvProbeWindowTicks', 'achvProbeTarget',
      'achvMindReadTarget', 'achvMindExtreme', 'achvMindProfitTarget',
      'achvNightBigSteal', 'achvNightStealTarget',
      'achvValueDeviation', 'achvValueOpenMin', 'achvValueHoldTicks', 'achvValueProfitPct',
      'achvValueCrossTarget', 'achvValueHoldTarget',
      'achvShortOpenMin', 'achvShortNextPnlPct', 'achvShortWindowTicks', 'achvShortPnlPct',
      'achvDragonNextTarget', 'achvDragonFastTarget', 'achvGlobalRequireAll',
      'themeEvolveSkillMult', 'themeEvolveImpact', 'themeEvolveImpactRefund', 'darkImpactBase',
      'tycoonLeadTicks', 'tycoonLeadTicksEvolved',
      'hermitHideChance', 'hermitHideChanceEvolved',
      'investigateCooldownEvolved',
      'nightStealCooldownEvolved'
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

  // 表情互动：同一个人同一轮只留最后一个（点多少次都只算最后那个）
  if (pathname === '/api/emote' && method === 'POST') {
    const r = pushEmote(db, me, { file: body.emo, code: body.code });
    if (!r.ok) return json(res, 400, { error: r.error });
    saveDb();
    return json(res, 200, {
      ok: true,
      replaced: !!r.replaced,
      tick: db.tick,
      emo: r.emote.emo
    });
  }

  // 站内通知：标已读（不传 ids = 全部已读）
  if (pathname === '/api/notify/read' && method === 'POST') {
    const n = markNotifyRead(me, Array.isArray(body.ids) ? body.ids : null);
    saveDb();
    return json(res, 200, {
      ok: true,
      marked: n,
      notices: notifyList(me, 20),
      notifyUnread: unreadCount(me)
    });
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
  // 逻辑在 src/orders.js，挂单成功后必须调用 consumeOrderSlot 才算用掉一次机会

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
    // 隐身的号在榜上找不到，也不接受偷钱（否则能从「被偷」提示里把他扒出来）
    if (!victim || victim.hiddenRank) return json(res, 404, { error: '没这个人' });
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

  // 暗中调查：Lv.2 主题技能，随机看目标的一个持仓（30 轮冷却）
  if (pathname === '/api/investigate' && method === 'POST') {
    const r = investigatePlayer(db, me, body.targetId);
    if (!r.ok) return json(res, r.status || 400, r);
    saveDb();
    return json(res, 200, r);
  }

  if (pathname === '/api/stock-trades' && method === 'GET') {
    const code = String(query.code || '').toUpperCase();
    if (!db.stocks[code]) return json(res, 404, { error: '没有这个标的' });
    const limit = Math.min(120, Math.max(1, Number(query.limit) || 40));

    // 隐世仙人：每笔成交有 50%（进化后 75%）概率不出现在别人的成交记录里
    const hideRatio = (() => {
      const base = Number(db.config.hermitHideChance ?? 0.5);
      const evo = Number(db.config.hermitHideChanceEvolved ?? 0.75);
      return { base: Number.isFinite(base) ? base : 0.5, evo: Number.isFinite(evo) ? evo : 0.75 };
    })();
    const hideHalf = (t) => {
      const owner = db.players[t.playerId];
      if (!owner || owner.skill !== 'hermit') return false;
      if (me && me.id === t.playerId) return false;          // 自己看得到自己的
      // 用单号做哈希，保证同一笔每次请求结果一致，不会闪
      let h = 0;
      const id = String(t.id || '');
      for (let k = 0; k < id.length; k++) h = (h * 31 + id.charCodeAt(k)) | 0;
      // 用 0~999 的稳定哈希去比概率，同一笔单每次请求结果一致
      const roll = Math.abs(h) % 1000;
      const chance = isEvolved(owner, 'hermit') ? hideRatio.evo : hideRatio.base;
      return roll < Math.round(Math.max(0, Math.min(1, chance)) * 1000);
    };
    const all = (db.trades || []).filter(
      (t) => t.code === code && (t.action === 'open' || t.action === 'close')
    ).filter((t) => !hideHalf(t));
    const rows = all
      .slice(-limit)
      .reverse()
      .map((t) => {
      const owner = db.players[t.playerId];
      // 「暗黑大手」主题技能：别人看到的成交方向是随机的（自己看自己是真的）
      // 暗黑大手不再伪装方向，成交方向如实显示
      const shownSide = t.side;
      const buy = t.action === 'open' ? shownSide === 'long' : shownSide === 'short';
      const notional = Number(t.qty) * Number(t.price);
      return {
        id: t.id,
        at: t.at,
        // 不下发 playerId：否则 F12 就能把每笔成交对回具体玩家（跟着大户抄单）
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
    // 和 K 线用同一条归一化时间轴，避免停机空洞把收益曲线拉断
    const axis = tickTimeAxis(db);
    const points = (me.eq || []).map((p) => ({
      // [tick, 总资产, 累计外部收入]
      tick: p[0],
      time: Math.floor(timeFromAxis(axis, p[0], db) / 1000),
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
    const blocked = orderLimitBlocked(db, me);
    if (blocked) return json(res, 429, { error: blocked });
    const r = placeLimitOrder(db, me, body);
    if (!r.ok) return json(res, r.status || 400, r);
    // 成功挂出去才算用掉一次操作机会
    consumeOrderSlot(db, me);
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
    const gate = shopGate(me, 'fakeNews');
    if (gate) return json(res, 403, gate);
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

  // ---------- 账号等级 ----------
  if (pathname === '/api/shop/level-up' && method === 'POST') {
    const r = levelUpPlayer(db, me);
    if (!r.ok) return json(res, r.status || 400, r);
    saveDb();
    return json(res, 200, {
      ok: true, level: r.level, cost: r.cost, cash: r.cash, bank: r.bank,
      player: publicPlayer(me, db)
    });
  }

  // ---------- 丰川银行 ----------
  if (pathname === '/api/bank' && method === 'GET') {
    return json(res, 200, bankStatus(db, me));
  }

  if (pathname === '/api/bank/withdraw' && method === 'POST') {
    const r = withdrawFromBank(db, me);
    if (!r.ok) return json(res, r.status || 400, r);
    saveDb();
    return json(res, 200, { ...r, status: bankStatus(db, me) });
  }

  // ---------- 自定义背景 ----------
  if (pathname === '/api/shop/bg' && method === 'POST') {
    const gate = shopGate(me, 'bg');
    if (gate) return json(res, 403, gate);
    if (me.bgUnlocked) return json(res, 200, { ok: true, already: true });
    const price = Number(db.config.shopBgPrice ?? 5000000);
    if (Number(me.cash) < price) {
      return json(res, 400, { error: `现金不足，需要 ${Math.round(price).toLocaleString('en-US')}` });
    }
    me.cash = Number(me.cash) - price;
    me.bgUnlocked = true;
    saveDb();
    return json(res, 200, { ok: true, player: publicPlayer(me, db) });
  }

  if (pathname === '/api/shop/bg/save' && method === 'POST') {
    if (!me.bgUnlocked) return json(res, 400, { error: '还没解锁自定义背景' });
    const data = String(body.data || '');
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(data)) {
      return json(res, 400, { error: '图片格式不支持' });
    }
    if (data.length > 1600 * 1024) {
      return json(res, 413, { error: '图片太大，换个小的（建议 500KB 以内）' });
    }
    me.background = data;
    if (!Number.isFinite(Number(me.bgOpacity))) me.bgOpacity = 100;
    saveDb();
    return json(res, 200, { ok: true, size: data.length, bgOpacity: me.bgOpacity });
  }

  // 背景不透明度（0~100）
  if (pathname === '/api/shop/bg/opacity' && method === 'POST') {
    if (!me.bgUnlocked) return json(res, 400, { error: '还没解锁自定义背景' });
    const op = normalizeBgOpacity(body.opacity);
    if (op === null) return json(res, 400, { error: '不透明度要是数字' });
    me.bgOpacity = op;
    saveDb();
    return json(res, 200, { ok: true, bgOpacity: me.bgOpacity });
  }

  // 取消背景（保留「已解锁」，随时可以再传一张）
  if (pathname === '/api/shop/bg/clear' && method === 'POST') {
    if (!me.bgUnlocked) return json(res, 400, { error: '还没解锁自定义背景' });
    me.background = '';
    saveDb();
    return json(res, 200, { ok: true, cleared: true });
  }

  // ---------- 改名卡 ----------
  if (pathname === '/api/shop/rename' && method === 'POST') {
    const gate = shopGate(me, 'rename');
    if (gate) return json(res, 403, gate);
    const cd = Math.max(0, Number(db.config.shopRenameCooldown ?? 2000));
    const last = Number(me.renameReadyAt || 0);
    if (cd > 0 && last > db.tick) {
      return json(res, 429, { error: `改名冷却中，还要等 ${last - db.tick} 轮`, leftTicks: last - db.tick });
    }
    const name = String(body.nickname || '').trim();
    if (name.length < 2 || name.length > 12) return json(res, 400, { error: '名字要 2~12 个字' });
    const taken = Object.values(db.players).some((p) => p.id !== me.id && p.nickname === name);
    if (taken) return json(res, 400, { error: '这个名字有人用了' });
    const price = Number(db.config.shopRenamePrice ?? 1000000);
    if (Number(me.cash) < price) {
      return json(res, 400, { error: `现金不足，需要 ${Math.round(price).toLocaleString('en-US')}` });
    }
    me.cash = Number(me.cash) - price;
    me.nickname = name;
    me.renameReadyAt = db.tick + cd;
    saveDb();
    return json(res, 200, { ok: true, nickname: name, readyAt: me.renameReadyAt, player: publicPlayer(me, db) });
  }

  if (pathname === '/api/shop/channel' && method === 'POST') {
    const gate = shopGate(me, 'channel');
    if (gate) return json(res, 403, gate);
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
      // 真实上限 = 基础 + 通道 + 账号等级加成，和撮合用的是同一个函数
      cap: fillCapFor(db, me),
      channelCap: baseCap + step * me.channelLevel,
      step,
      nextPrice: Math.round(basePrice * Math.pow(ratio, me.channelLevel)),
      cash: me.cash
    });
  }

  // ---------- 主题进化（成就 → 结晶 → Ⅱ 阶） ----------
  if (pathname === '/api/theme/evolve' && method === 'POST') {
    const theme = String(body.theme || '').trim();
    ensureAchvState(me);
    const r = evolveTheme(db, me, theme);
    if (!r.ok) return json(res, 400, { error: r.error });
    saveDb();
    return json(res, 200, {
      ok: true,
      theme,
      tier: r.tier,
      shards: Number(me.shards?.[theme]) || 0,
      achv: achvPayload(db, me)
    });
  }

  // ---------- 主题配色 ----------
  // probe（暗中调查）是 Lv.2 主题，购买时要检查账号等级
  // 个别主题单独定价（其余走 shopThemePrice）
  const THEME_PRICE = { mind: Number(db.config.mindThemePrice ?? 5000000) };

  // 买/换主题。
  //   part='look'  → 只换外观，**不吃冷却**（外观随时换）
  //   part='skill' → 只换技能，吃 shopThemeCooldown
  //   part 省略     → 两者都换（老接口行为，仍吃冷却）
  // 价钱只在「第一次买这个主题」时收：买过之后外观/技能可以自由切。
  if (pathname === '/api/shop/theme' && method === 'POST') {
    const code = String(body.theme || '').trim();
    if (!THEMES.includes(code)) return json(res, 400, { error: '没有这个主题' });
    const part = body.part === 'look' || body.part === 'skill' ? body.part : 'both';

    const needLv = Math.max(1, Number(THEME_NEED_LEVEL[code]) || 1);
    if ((Math.floor(Number(me.level)) || 1) < needLv) {
      return json(res, 403, { error: `这个主题要 Lv.${needLv} 才能买` });
    }

    const price = Number(THEME_PRICE[code] ?? db.config.shopThemePrice ?? 2000000);
    if (!Array.isArray(me.themes)) me.themes = [];
    const owned = me.themes.includes(code);

    // 只有「换技能」才吃冷却；换外观永远不拦
    const wantsSkill = part === 'skill' || part === 'both';
    const cd = Math.max(0, Number(db.config.shopThemeCooldown ?? 100));
    // -1 / 缺省 = 从没换过技能；0 是合法 tick（服务刚启动时也能正常冷却）
    const rawLast = me.skillChangedTick ?? me.themeChangedTick;
    const lastAt = Number.isFinite(Number(rawLast)) ? Number(rawLast) : -1;
    if (wantsSkill && cd > 0 && lastAt >= 0 && db.tick - lastAt < cd) {
      const left = cd - (db.tick - lastAt);
      return json(res, 429, {
        error: `技能刚换过，还要等 ${left} 轮（约 ${Math.ceil(left * (db.config.tickMs ?? 5000) / 60000)} 分钟）`,
        leftTicks: left
      });
    }

    let spent = 0;
    if (!owned) {
      if (me.cash < price) {
        return json(res, 400, {
          error: `现金不足，售价 $${price.toLocaleString()}，你只有 $${me.cash.toFixed(2)}`
        });
      }
      me.cash -= price;
      me.shopSpent = (me.shopSpent || 0) + price;
      me.themes.push(code);
      spent = price;
    }

    if (part === 'look' || part === 'both') me.theme = code;
    if (wantsSkill) {
      me.skill = code;
      me.skillChangedTick = db.tick;
    }
    saveDb();
    return json(res, 200, {
      ok: true,
      part,
      theme: me.theme,
      skill: me.skill,
      themes: me.themes,
      price,
      spent,
      cash: me.cash,
      cdLeft: Math.max(0, cd - (db.tick - Number(me.skillChangedTick ?? -1))),
      changedTick: Number(me.skillChangedTick ?? -1)
    });
  }

  // 只切外观（老的快捷切换走这里）：不吃冷却，也不动技能
  if (pathname === '/api/shop/theme/select' && method === 'POST') {
    const code = String(body.theme || 'default').trim();
    if (code !== 'default' && !(Array.isArray(me.themes) && me.themes.includes(code))) {
      return json(res, 400, { error: '还没买这个主题' });
    }
    me.theme = code;
    saveDb();
    return json(res, 200, { ok: true, theme: code, skill: me.skill || me.theme });
  }

  // ---------- 自动定投（Lv.2 道具）----------
  if (pathname === '/api/shop/auto-dca' && method === 'POST') {
    const gate = shopGate(me, 'autoDca');
    if (gate) return json(res, 403, gate);
    const price = Number(db.config.shopAutoDcaPrice ?? 5000000);
    if (me.autoDca) {
      return json(res, 200, {
        ok: true, already: true, price, cash: me.cash,
        autoDca: true, autoDcaOn: me.autoDcaOn !== false
      });
    }
    if (Number(me.cash) < price) {
      return json(res, 400, {
        error: `现金不足，售价 $${price.toLocaleString()}，你只有 $${Number(me.cash).toFixed(2)}`
      });
    }
    me.cash -= price;
    me.shopSpent = (me.shopSpent || 0) + price;
    me.autoDca = true;
    me.autoDcaOn = true;
    me.autoDcaAt = now();
    saveDb();
    return json(res, 200, { ok: true, price, cash: me.cash, autoDca: true, autoDcaOn: true });
  }

  // 暂停 / 继续定投
  if (pathname === '/api/shop/auto-dca/toggle' && method === 'POST') {
    if (!me.autoDca) return json(res, 400, { error: '还没买自动定投' });
    const on = body.on !== false;
    me.autoDcaOn = on;
    saveDb();
    return json(res, 200, { ok: true, autoDcaOn: on });
  }

  // 🐟 咸鱼代下单（Lv.1）：60 轮内所有交易手续费全免
  if (pathname === '/api/shop/free-fee' && method === 'POST') {
    const gate = shopGate(me, 'freeFee');
    if (gate) return json(res, 403, gate);
    const price = Math.max(0, Number(db.config.shopFreeFeePrice ?? 500000));
    const cd = Math.max(0, Math.round(Number(db.config.shopFreeFeeCooldown ?? 100)));
    const left = cooldownLeft(db, me, 'freeFeeReadyAt');
    if (left > 0) {
      return json(res, 429, { error: `冷却中，还有 ${left} 轮才能再买`, leftTicks: left });
    }
    if (Number(me.cash) < price) {
      return json(res, 400, {
        error: `现金不足，售价 $${price.toLocaleString()}，你只有 $${Number(me.cash).toFixed(2)}`
      });
    }
    const ticks = freeFeeDuration(db);
    me.cash -= price;
    me.shopSpent = (Number(me.shopSpent) || 0) + price;
    // 已经在生效中再买一次：时长接上去，不浪费
    const from = Math.max(Number(db.tick) || 0, Number(me.freeFeeUntilTick) || 0);
    me.freeFeeUntilTick = from + ticks;
    me.freeFeeReadyAt = (Number(db.tick) || 0) + cd;
    saveDb();
    return json(res, 200, {
      ok: true,
      price,
      cash: me.cash,
      ticks,
      untilTick: me.freeFeeUntilTick,
      leftTicks: ticks,
      freeFeeUntilTick: me.freeFeeUntilTick,
      freeFeeReadyAt: me.freeFeeReadyAt
    });
  }

  // 🕵 游资情报（Lv.3）：告诉你游资下一次进场的板块
  if (pathname === '/api/shop/hot-tip' && method === 'POST') {
    const gate = shopGate(me, 'hotTip');
    if (gate) return json(res, 403, gate);
    const price = Math.max(0, Number(db.config.shopHotTipPrice ?? 2000000));
    const cd = Math.max(0, Math.round(Number(db.config.shopHotTipCooldown ?? 500)));
    const left = cooldownLeft(db, me, 'hotTipReadyAt');
    if (left > 0) {
      return json(res, 429, { error: `冷却中，还有 ${left} 轮才能再买`, leftTicks: left });
    }
    // 没有情报就不收钱、也不进冷却（空手不罚，和「暗中调查」一个口径）
    const tip = hotTipTarget(db);
    if (!tip) return json(res, 400, { error: '游资暂时没有动向（可能已关闭），这次不收钱' });
    if (Number(me.cash) < price) {
      return json(res, 400, {
        error: `现金不足，售价 $${price.toLocaleString()}，你只有 $${Number(me.cash).toFixed(2)}`
      });
    }
    me.cash -= price;
    me.shopSpent = (Number(me.shopSpent) || 0) + price;
    me.hotTipReadyAt = (Number(db.tick) || 0) + cd;
    me.lastHotTip = { industry: tip.industry, tick: db.tick, at: now() };
    saveDb();
    return json(res, 200, {
      ok: true,
      price,
      cash: me.cash,
      industry: tip.industry,
      leftTicks: tip.leftTicks,
      hotTipReadyAt: me.hotTipReadyAt
    });
  }

  if (pathname === '/api/shop/bodyguard' && method === 'POST') {
    const gate = shopGate(me, 'bodyguard');
    if (gate) return json(res, 403, gate);
    // qty 缺省 1；前端「一次买十份」传 10，价格和时长按份数等比放大（不打折）
    const { qty, unitPrice, total, addTicks } = bodyguardOrder(db.config, body.qty);

    if (me.cash < total) {
      return json(res, 400, {
        error: qty > 1
          ? `现金不足，买 ${qty} 份要 $${total.toLocaleString()}，你只有 $${me.cash.toFixed(2)}`
          : `现金不足，售价 $${total.toLocaleString()}，你只有 $${me.cash.toFixed(2)}`
      });
    }

    me.cash -= total;
    me.shopSpent = (me.shopSpent || 0) + total;
    // 还在保护期内再买一次就叠加时长
    const base = Math.max(Number(me.guardUntil || 0), db.tick);
    me.guardUntil = base + addTicks;
    saveDb();

    return json(res, 200, {
      ok: true,
      qty,
      unitPrice,
      price: total,
      guardUntil: me.guardUntil,
      leftTicks: me.guardUntil - db.tick,
      cash: me.cash
    });
  }

  // 追加一条止盈/止损条件（可以加多条，到一条触发一条）
  if (pathname === '/api/tpsl' && method === 'POST') {
    const code = String(body.code || '').toUpperCase();
    const pos = me.positions[code];
    if (!pos) return json(res, 400, { error: '没有这只票的持仓' });

    const st = db.stocks[code];
    if (!st) return json(res, 400, { error: '标的不存在' });
    const price = st.price;
    const dir = pos.side === 'long' ? 1 : -1;

    if (!Array.isArray(pos.tpsl)) pos.tpsl = [];
    const max = Math.max(1, Number(db.config.maxTpslPerPosition ?? 8));
    if (pos.tpsl.length >= max) {
      return json(res, 400, { error: `每笔持仓最多 ${max} 条止盈止损，先删掉一些` });
    }

    const parse = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : NaN;
    };
    const qty = (() => {
      const n = Math.floor(Number(body.qty));
      return Number.isFinite(n) && n > 0 ? Math.min(pos.qty, n) : null;
    })();

    const added = [];

    const tpV = parse(body.tp);
    if (tpV !== null) {
      if (!Number.isFinite(tpV) || tpV <= 0) return json(res, 400, { error: '止盈价必须是正数' });
      if ((tpV - price) * dir <= 0) {
        return json(res, 400, {
          error: `止盈价必须${dir > 0 ? '高于' : '低于'}现价 ${price.toFixed(2)}`
        });
      }
      added.push({
        id: 'ts_' + Math.random().toString(36).slice(2, 9),
        kind: 'tp', price: tpV, qty, fired: false, createdTick: db.tick
      });
    }

    const slV = parse(body.sl);
    if (slV !== null) {
      if (!Number.isFinite(slV) || slV <= 0) return json(res, 400, { error: '止损价必须是正数' });
      if ((slV - price) * dir >= 0) {
        return json(res, 400, {
          error: `止损价必须${dir > 0 ? '低于' : '高于'}现价 ${price.toFixed(2)}`
        });
      }
      added.push({
        id: 'ts_' + Math.random().toString(36).slice(2, 9),
        kind: 'sl', price: slV, qty, fired: false, createdTick: db.tick
      });
    }

    if (!added.length) return json(res, 400, { error: '止盈和止损至少要填一个' });

    pos.tpsl.push(...added);
    // 老字段同步一份，兼容老逻辑
    const firstTp = pos.tpsl.find((x) => x.kind === 'tp' && !x.fired);
    const firstSl = pos.tpsl.find((x) => x.kind === 'sl' && !x.fired);
    pos.tp = firstTp ? firstTp.price : null;
    pos.sl = firstSl ? firstSl.price : null;
    saveDb();
    return json(res, 200, { ok: true, added, position: positionWire(pos, st) });
  }

  // 删掉一条止盈止损
  if (pathname === '/api/tpsl/remove' && method === 'POST') {
    const code = String(body.code || '').toUpperCase();
    const pos = me.positions[code];
    if (!pos) return json(res, 400, { error: '没有这只票的持仓' });
    const id = String(body.id || '');
    if (!Array.isArray(pos.tpsl)) pos.tpsl = [];
    const before = pos.tpsl.length;
    pos.tpsl = pos.tpsl.filter((x) => x.id !== id);
    if (pos.tpsl.length === before) return json(res, 400, { error: '没有这条记录' });
    const firstTp = pos.tpsl.find((x) => x.kind === 'tp' && !x.fired);
    const firstSl = pos.tpsl.find((x) => x.kind === 'sl' && !x.fired);
    pos.tp = firstTp ? firstTp.price : null;
    pos.sl = firstSl ? firstSl.price : null;
    saveDb();
    return json(res, 200, { ok: true, position: positionWire(pos, db.stocks[code]) });
  }

  return json(res, 404, { error: '接口不存在' });
}
