/**
 * 聊天大厅（全服聊天室）
 *
 * - 只保留最近 `CHAT_MAX` 条（默认 500），按 seq 递增，前端每轮 tick 拉增量
 * - 三种消息：文字（text）/ 表情贴纸（emoji）/ 红包（packet）
 * - 红包是「拼手气」：创建时就把钱按二倍均值法拆好并打乱，抢的时候按顺序发
 *   - 创建即扣现金；抢到的直接进现金
 *   - 不能抢自己的；同一个红包每人只能抢一次；10 分钟没抢完就过期回收（钱不退，已发出的份就是发出去了）
 *
 * 数据都在 db 里：`db.chat = { seq, messages: [] }`、`db.redPackets = { id: 红包 }`
 */

export const CHAT_MAX = 500;              // 保留最近多少条
export const CHAT_TEXT_MAX = 200;         // 单条文字最长
export const CHAT_GAP_MS = 3000;          // 同一人两条消息最小间隔（防刷屏）
export const PACKET_MIN_AMOUNT = 100;     // 红包最少总额
export const PACKET_MAX_COUNT = 20;       // 一个红包最多几份
/** 红包有效期（毫秒）：由 config.packetTtlHours 决定，默认 2 小时 */
export const PACKET_TTL_HOURS_DEFAULT = 2;
export function packetTtlMs(cfg = {}) {
  const hours = Number(cfg.packetTtlHours ?? PACKET_TTL_HOURS_DEFAULT);
  const safe = Number.isFinite(hours) && hours > 0 ? Math.min(72, hours) : PACKET_TTL_HOURS_DEFAULT;
  return safe * 3600 * 1000;
}
/** 兼容老代码：默认 2 小时 */
export const PACKET_TTL_MS = PACKET_TTL_HOURS_DEFAULT * 3600 * 1000;
export const PACKET_COOLDOWN_MS = 10 * 1000;

/** 老存档 / 新库都补齐结构 */
export function ensureChat(db) {
  if (!db.chat || typeof db.chat !== 'object') db.chat = { seq: 0, messages: [] };
  const c = db.chat;
  if (!Array.isArray(c.messages)) c.messages = [];
  if (!Number.isFinite(Number(c.seq))) {
    const last = c.messages[c.messages.length - 1];
    c.seq = last ? Number(last.seq) || 0 : 0;
  }
  if (!db.redPackets || typeof db.redPackets !== 'object') db.redPackets = {};
  return c;
}

/**
 * 裁到 CHAT_MAX 条，并维护红包：
 * - 消息还在窗口里 → 红包对象留着（气泡要显示「已抢 x/y / 已抢光」）
 * - 超过 TTL → 只打 dead 标记（不能再抢），不删，否则气泡会突然变成「红包已过期」
 * - 消息被裁掉了 → 红包才真正删掉（控制体积）
 */
function housekeep(db) {
  const c = ensureChat(db);
  if (c.messages.length > CHAT_MAX) c.messages = c.messages.slice(-CHAT_MAX);
  const nowMs = Date.now();
  const referenced = new Set();
  for (const m of c.messages) {
    if (m && m.type === 'packet' && m.packetId) referenced.add(m.packetId);
  }
  for (const [id, pk] of Object.entries(db.redPackets)) {
    if (!pk || !referenced.has(id)) { delete db.redPackets[id]; continue; }
    if (Number(pk.at) + packetTtlMs(db.config || {}) < nowMs) pk.dead = true;
  }
}

/**
 * 往大厅塞一条消息。
 * @param {object} db
 * @param {object} player 发消息的人
 * @param {object} payload { type, text?, emo?, packetId? }
 */
export function pushChat(db, player, payload = {}) {
  const c = ensureChat(db);
  const msg = {
    seq: ++c.seq,
    at: Date.now(),
    tick: Number(db.tick) || 0,
    pid: player.id,
    nick: player.nickname || '匿名',
    lv: Number(player.level) || 1,
    avatar: player.avatar || null,   // 落一份当快照（玩家删号后还能显示）
    type: payload.type || 'text'
  };
  if (payload.text !== undefined) msg.text = String(payload.text);
  if (payload.emo !== undefined) msg.emo = String(payload.emo);
  if (payload.packetId !== undefined) msg.packetId = String(payload.packetId);
  c.messages.push(msg);
  housekeep(db);
  return msg;
}

/** 拼手气拆分：二倍均值法，每份 ≥ 1，合计 = amount */
export function splitPacket(amount, count, rand = Math.random) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const total = Math.max(n, Math.floor(Number(amount) || n));
  const out = [];
  let left = total;
  let leftN = n;
  for (let i = 0; i < n - 1; i += 1) {
    const cap = Math.max(1, Math.floor((left / leftN) * 2));
    const v = Math.max(1, Math.min(left - (leftN - 1), 1 + Math.floor(rand() * cap)));
    out.push(v);
    left -= v;
    leftN -= 1;
  }
  out.push(left);
  return out;
}

function shuffle(list, rand = Math.random) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const t = list[i];
    list[i] = list[j];
    list[j] = t;
  }
  return list;
}

/** 发红包（钱已经从玩家账上扣掉了，这里只负责建结构） */
export function createPacket(db, player, amount, count, rand = Math.random) {
  ensureChat(db);
  const parts = shuffle(splitPacket(amount, count, rand), rand);
  const id = 'rp_' + Math.random().toString(36).slice(2, 10);
  const pk = {
    id,
    pid: player.id,
    nick: player.nickname || '匿名',
    amount: Math.floor(Number(amount) || 0),
    count: parts.length,
    parts,
    taken: [],
    at: Date.now()
  };
  db.redPackets[id] = pk;
  return pk;
}

/** 给前端的红包状态（带最近几个抢到的人） */
export function packetView(pk) {
  if (!pk) return null;
  return {
    id: pk.id,
    nick: pk.nick,
    pid: pk.pid,
    amount: pk.amount,
    count: pk.count,
    left: Math.max(0, pk.parts.length - pk.taken.length),
    expired: !!pk.dead,
    shares: pk.taken.slice(-5).map((t) => ({ nick: t.nick, amount: t.amount })),
    at: pk.at
  };
}

/**
 * 抢红包：返回 { ok, amount?, error? }
 * @param {object} pk 红包
 * @param {object} player 抢的人
 * @param {object} [cfg] db.config（用来读 packetTtlHours）
 */
export function grabPacket(pk, player, cfg = {}) {
  if (!pk) return { ok: false, error: '红包不存在或已过期' };
  if (pk.dead || Number(pk.at) + packetTtlMs(cfg) < Date.now()) return { ok: false, error: '红包已过期' };
  if (pk.pid === player.id) return { ok: false, error: '不能抢自己发的红包' };
  if (pk.taken.length >= pk.parts.length) return { ok: false, error: '手慢了，红包已经被抢光了' };
  if (pk.taken.some((t) => t.pid === player.id)) return { ok: false, error: '这个红包你已经抢过了' };
  const amount = pk.parts[pk.taken.length];
  pk.taken.push({ pid: player.id, nick: player.nickname || '匿名', amount, at: Date.now() });
  return { ok: true, amount, left: pk.parts.length - pk.taken.length };
}

/**
 * 拉消息。
 * @param {object} db
 * @param {object} o
 * @param {number} [o.afterSeq] 只要这个 seq 之后的新消息（增量）
 * @param {number} [o.limit]    不给 afterSeq 时返回最近多少条
 */
export function chatRows(db, { afterSeq = 0, limit = 100 } = {}) {
  const c = ensureChat(db);
  housekeep(db);
  const all = c.messages;
  const after = Math.max(0, Number(afterSeq) || 0);
  let rows;
  if (after > 0) {
    rows = all.filter((m) => Number(m.seq) > after);
    const max = Math.max(1, Math.min(200, Number(limit) || 100));
    if (rows.length > max) rows = rows.slice(-max);
  } else {
    const max = Math.max(1, Math.min(CHAT_MAX, Number(limit) || 100));
    rows = all.slice(-max);
  }
  // 红包消息附上当前状态（前端要显示「已抢 x/y」）
  const packets = {};
  for (const pk of Object.values(db.redPackets)) {
    if (pk) packets[pk.id] = packetView(pk);
  }
  /**
   * 头像按「玩家现在的头像」实时解析：
   * 换头像之后，聊天室里他以前发过的消息也跟着变（不是快照）。
   * 玩家被删号了才退回消息里存的那份。
   */
  const avatars = {};
  for (const m of all) {
    if (!m || !m.pid || Object.prototype.hasOwnProperty.call(avatars, m.pid)) continue;
    const owner = db.players ? db.players[m.pid] : null;
    avatars[m.pid] = (owner && owner.avatar) || m.avatar || null;
  }
  return {
    seq: c.seq,
    rows: rows.map((m) => {
      const out = { ...m, avatar: avatars[m.pid] ?? m.avatar ?? null };
      if (m.type === 'packet') out.packet = packets[m.packetId] || null;
      return out;
    }),
    avatars,
    packets,
    max: CHAT_MAX,
    total: all.length
  };
}
