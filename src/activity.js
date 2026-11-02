import { playerEquity, closePosition } from './trading.js';

/** 活动状态：idle（未开始） / running（进行中） / done（已结束） */
const DEFAULT = () => ({
  participants: [],
  status: 'idle',
  results: [],
  lastResult: null
});

export function ensureActivity(db) {
  if (!db.activity) db.activity = DEFAULT();
  const a = db.activity;
  if (!Array.isArray(a.participants)) a.participants = [];
  if (!Array.isArray(a.results)) a.results = [];
  if (!a.status) a.status = 'idle';
  if (a.lastResult === undefined) a.lastResult = null;
  return a;
}

/** 配置里的目标名单（昵称数组） */
export function targetNames(db) {
  const raw = db.config.activityTargets;
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
  const one = String(db.config.activityTarget || '').trim();
  return one ? [one] : [];
}

/** 按昵称找出玩家对象（去空格、忽略大小写） */
export function findTargets(db) {
  const want = new Set(targetNames(db).map((n) => n.toLowerCase()));
  return Object.values(db.players).filter(
    (p) => want.has(String(p.nickname || '').trim().toLowerCase())
  );
}

/** 已经在 results 里被瓜分过的玩家 id */
function raidedIds(a) {
  return new Set((a.results || []).map((r) => r.targetId));
}

export function activityPayload(db, viewer) {
  const a = ensureActivity(db);
  const cfg = db.config;
  const targets = findTargets(db);
  const done = raidedIds(a);

  const list = targets.map((p) => ({
    id: p.id,
    name: p.nickname,
    equity: playerEquity(db, p),
    raided: done.has(p.id)
  }));
  const alive = list.filter((t) => !t.raided);

  return {
    name: '打倒量化资本',
    status: a.status,
    threshold: Number(cfg.activityThreshold ?? 500000),
    reward: Number(cfg.activityReward ?? 4000000),
    targets: list,
    aliveCount: alive.length,
    totalEquity: alive.reduce((s, t) => s + t.equity, 0),
    participantCount: a.participants.length,
    joined: !!(viewer && a.participants.includes(viewer.id)),
    isTarget: !!(viewer && targets.some((p) => p.id === viewer.id)),
    results: a.results,
    lastResult: a.lastResult
  };
}

export function joinActivity(db, player, join = true) {
  const a = ensureActivity(db);
  if (a.status !== 'running') {
    return { ok: false, error: a.status === 'done' ? '活动已经结束了' : '活动还没开始' };
  }
  if (Number(db.config.activityEnabled ?? 1) === 0) {
    return { ok: false, error: '活动暂未开放' };
  }
  const targets = findTargets(db);
  if (targets.some((p) => p.id === player.id)) {
    return { ok: false, error: '你在被瓜分名单里，不能参加' };
  }

  const i = a.participants.indexOf(player.id);
  if (join && i < 0) a.participants.push(player.id);
  if (!join && i >= 0) a.participants.splice(i, 1);
  return { ok: true, joined: join, count: a.participants.length };
}

/** 管理员：名单 / 启动 / 停止 / 重置 */
export function adminActivity(db, action, targets) {
  const a = ensureActivity(db);
  if (action === 'targets') {
    db.config.activityTargets = (Array.isArray(targets) ? targets : [])
      .map((x) => String(x).trim()).filter(Boolean);
    // 名单变了：回到未开始状态，等管理员重新启动
    a.results = [];
    a.lastResult = null;
    a.participants = [];
    a.status = 'idle';
    return { ok: true };
  }
  if (action === 'start') {
    a.participants = [];
    a.results = [];
    a.lastResult = null;
    a.status = 'running';
    return { ok: true };
  }
  if (action === 'stop') {
    a.status = 'done';
    return { ok: true };
  }
  if (action === 'reset') {
    a.participants = [];
    a.results = [];
    a.lastResult = null;
    a.status = 'idle';
    return { ok: true };
  }
  return { ok: false, error: '未知操作' };
}

/** 每个 tick 检查：名单里资产超线的就地强平并平分 */
export function checkActivity(db) {
  const a = ensureActivity(db);
  const cfg = db.config;
  if (Number(cfg.activityEnabled ?? 1) === 0) return null;
  if (a.status !== 'running') return null;
  if (!a.participants.length) return null;

  const threshold = Number(cfg.activityThreshold ?? 500000);
  const reward = Math.max(0, Number(cfg.activityReward ?? 4000000));
  const done = raidedIds(a);
  const hits = [];

  for (const target of findTargets(db)) {
    if (done.has(target.id)) continue;
    const equity = playerEquity(db, target);
    if (!(equity > threshold)) continue;

    // ---- 强平 ----
    let closed = 0;
    for (const code of Object.keys(target.positions || {})) {
      const pos = target.positions[code];
      if (!pos || !(pos.qty > 0)) continue;
      const r = closePosition(db, target, code, 'activity', pos.qty);
      if (r && r.ok) closed += 1;
    }

    // ---- 平分 ----
    const pool = Math.min(Math.max(0, target.cash), reward);
    const ids = a.participants.filter((id) => db.players[id] && id !== target.id);
    const share = ids.length ? pool / ids.length : 0;
    if (pool > 0 && ids.length) {
      target.cash -= pool;
      for (const id of ids) db.players[id].cash += share;
    }

    const result = {
      at: Date.now(),
      targetId: target.id,
      targetName: target.nickname,
      equity,
      threshold,
      closed,
      pool,
      share,
      winners: ids.length,
      winnerNames: ids.map((id) => db.players[id].nickname).slice(0, 20)
    };
    a.results.push(result);
    a.lastResult = result;
    hits.push(result);

    if (Array.isArray(db.notices)) {
      db.notices.push({
        id: 'nt_' + Math.random().toString(36).slice(2, 10),
        text: `【打倒量化资本】${target.nickname} 总资产 $${Math.round(equity).toLocaleString()} 突破 `
          + `$${threshold.toLocaleString()}，${closed} 个仓位被强制平仓，`
          + `$${Math.round(pool).toLocaleString()} 平分给 ${ids.length} 位参与者`
          + (ids.length ? `（每人 $${Math.round(share).toLocaleString()}）` : ''),
        at: Date.now()
      });
      if (db.notices.length > 20) db.notices.shift();
    }
  }

  // 名单全被打完了就结束
  if (hits.length && findTargets(db).every((t) => raidedIds(a).has(t.id))) {
    a.status = 'done';
  }
  return hits.length ? hits : null;
}
