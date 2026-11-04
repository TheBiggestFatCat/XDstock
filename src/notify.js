// 站内通知（点铃铛看的那种）
//   - 只存最近 NOTIFY_MAX 条，旧的自动丢
//   - 结构：{ id, tick, at, kind, text, code, read }
//   - kind 目前有：tpsl（止盈止损触发）、tpslFill（止盈止损成交）、
//     liq（强平）、steal（被偷）、dividend（分红）——新增的 kind 前端按文字显示即可

export const NOTIFY_MAX = 30;

/** 未读条数 */
export function unreadCount(player) {
  const list = Array.isArray(player?.notices) ? player.notices : [];
  let n = 0;
  for (const x of list) if (!x.read) n++;
  return n;
}

/**
 * 推一条通知。player 里没有 notices 就建。
 * 返回这条通知本身（方便调用方顺手打日志）。
 */
export function pushNotify(player, db, { kind = 'info', text = '', code = null, tick } = {}) {
  if (!player) return null;
  const body = String(text || '').trim().slice(0, 160);
  if (!body) return null;
  if (!Array.isArray(player.notices)) player.notices = [];
  const t = Number.isFinite(Number(tick)) ? Number(tick) : Number(db?.tick) || 0;
  const item = {
    id: 'n_' + t + '_' + Math.random().toString(36).slice(2, 8),
    tick: t,
    at: Date.now(),
    kind: String(kind || 'info'),
    text: body,
    code: code ? String(code) : null,
    read: false
  };
  player.notices.push(item);
  if (player.notices.length > NOTIFY_MAX) {
    player.notices.splice(0, player.notices.length - NOTIFY_MAX);
  }
  return item;
}

/** 下发给前端的列表：最新的在前，最多 limit 条 */
export function notifyList(player, limit = 20) {
  const list = Array.isArray(player?.notices) ? player.notices : [];
  return list.slice(-Math.max(1, limit)).reverse().map((x) => ({
    id: x.id,
    tick: Number(x.tick) || 0,
    at: Number(x.at) || 0,
    kind: x.kind || 'info',
    text: x.text || '',
    code: x.code || null,
    read: !!x.read
  }));
}

/**
 * 标记已读。ids 为空 = 全部已读。
 * 返回这次真正被标掉的条数。
 */
export function markNotifyRead(player, ids = null) {
  const list = Array.isArray(player?.notices) ? player.notices : [];
  const want = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
  let n = 0;
  for (const x of list) {
    if (x.read) continue;
    if (want && !want.has(String(x.id))) continue;
    x.read = true;
    n++;
  }
  return n;
}
