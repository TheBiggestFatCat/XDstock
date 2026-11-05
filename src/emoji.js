/**
 * 表情互动（贴纸）
 *
 * 玩法：在个股/指数详情页点表情 → 所有玩家**下一轮 tick** 会在页面随机位置看到它
 * 弹出（从小放大），持续一轮后消失。
 *
 * 规则：
 *   - 每轮每个玩家只留**最后一个**表情（同一轮点多次，最后那个生效）
 *   - 表情按等级分层：`emo_lv1` 是 Lv.1 就解锁的，以后加 `emo_lv2` 只给高等级玩家
 *   - 只有白名单里的文件名才认（防止路径穿越）
 */

/** 每一档表情对应需要的最低账号等级 */
export const EMO_TIERS = [
  // 顺序就是面板里的展示顺序
  { level: 1, dir: 'emo_lv1', files: [
    'Emo_00001_0.png',
    'Emo_00001_1.png',
    'Emo_00001_2.png',
    'Emo_00001_3.png',
    'Emo_00001_4.png',
    'Emo_00001_5.png',
    'Emo_00001_6.png',
    'Emo_00001_7.png',
    'Emo_00001_8.png',
    'Emo_00001_10.png',
    'Emo_00001_11.png',
    'Emo_00001_12.png',
    'Emo_00001_888.png',
    'Emo_00001_966.png',
    'Emo_00001_983.png',
    'Emo_00001_984.png',
    'Emo_00001_996.png',
    'Emo_00001_997.png'
  ] }
];

/** 这个等级能用的全部表情（文件名） */
export function unlockedEmojis(level) {
  const lv = Math.max(1, Math.floor(Number(level) || 1));
  const out = [];
  for (const tier of EMO_TIERS) {
    if (lv >= tier.level) out.push(...tier.files);
  }
  return out;
}

/** 文件名 → 目录（下发时前端拼 `/assets/<dir>/<file>`） */
export function tierDirOf(file) {
  for (const tier of EMO_TIERS) {
    if (tier.files.includes(file)) return tier.dir;
  }
  return '';
}

/** 这个玩家能不能用这个表情 */
export function isEmojiUnlocked(level, file) {
  const name = String(file || '');
  if (!name) return false;
  return unlockedEmojis(level).includes(name);
}

/** 「同屏可见」的表情最多留几条，防止 db 无上限增长 */
export const EMOTE_MAX = 60;

/** 一轮里最多允许多少人同时冒表情（省得满屏都是） */
export const EMOTE_PER_TICK_MAX = 12;

/**
 * 推一个表情。
 * 同一个玩家在同一 tick 里再点，**替换掉**自己上一条（最后一个生效）。
 *
 * @returns {{ok:boolean, error?:string, emote?:object}}
 */
export function pushEmote(db, player, { file, code } = {}) {
  if (!db || !player) return { ok: false, error: '参数不对' };
  const name = String(file || '');
  if (!isEmojiUnlocked(player.level, name)) {
    return { ok: false, error: '这个表情你还没解锁' };
  }
  if (!Array.isArray(db.emotes)) db.emotes = [];
  const tick = Number(db.tick) || 0;

  // 本轮自己已经发过 → 覆盖成最新的那个
  const mine = db.emotes.find((e) => e && e.playerId === player.id && e.tick === tick);
  if (mine) {
    mine.emo = name;
    mine.code = String(code || '').toUpperCase().slice(0, 12);
    mine.at = Date.now();
    return { ok: true, emote: mine, replaced: true };
  }

  // 一轮最多这么多条，超出就丢掉最老的（老的表情早就该消失了）
  const thisTick = db.emotes.filter((e) => e && e.tick === tick);
  if (thisTick.length >= EMOTE_PER_TICK_MAX) {
    const drop = thisTick[0];
    const idx = db.emotes.indexOf(drop);
    if (idx >= 0) db.emotes.splice(idx, 1);
  }

  const emote = {
    id: 'e_' + tick + '_' + Math.random().toString(36).slice(2, 8),
    playerId: player.id,
    nickname: String(player.nickname || '').slice(0, 20),
    emo: name,
    code: String(code || '').toUpperCase().slice(0, 12),
    tick,
    at: Date.now()
  };
  db.emotes.push(emote);

  // 只留最近几轮，别让存档越滚越大
  if (db.emotes.length > EMOTE_MAX) {
    db.emotes.splice(0, db.emotes.length - EMOTE_MAX);
  }
  return { ok: true, emote };
}

/**
 * 表情只属于「发它的那只票」。
 * 客户端拿到全局那一批之后，用这个函数筛出当前正在看的那只票的。
 * `code` 比对不区分大小写；没有 code 的老数据按「不显示」处理。
 */
export function filterEmotesByCode(list, code) {
  const want = String(code || '').toUpperCase();
  if (!want || !Array.isArray(list)) return [];
  return list.filter((e) => e && String(e.code || '').toUpperCase() === want);
}

/**
 * 这一刻该给玩家看哪些表情。
 * 规则：看**上一轮**发出来的（玩家点完，下一轮才冒出来），
 * 再下一轮就被过滤掉 → 天然「只活一轮」。
 */
export function visibleEmotes(db, nowTick = null) {
  const list = Array.isArray(db?.emotes) ? db.emotes : [];
  const tick = (nowTick === null || nowTick === undefined || !Number.isFinite(Number(nowTick)))
    ? (Number(db?.tick) || 0)
    : Number(nowTick);
  return list
    .filter((e) => e && e.tick === tick - 1)
    .map((e) => ({
      id: e.id,
      nickname: e.nickname,
      emo: e.emo,
      dir: tierDirOf(e.emo),
      code: e.code || ''
    }));
}
