/**
 * 版本更新公告（固定显示在「市场快讯」上方的那一栏）
 *
 * 和普通公告（`db.notices`，会过期、和新闻混在一起）不是一回事：
 *   - 版本公告是**长期挂着**的，点了能看完整内容（弹层）
 *   - 只保留最近 `VERSION_POST_MAX` 条，前端默认展示最新那一条
 *   - 结构：{ id, version, title, body, at, tick }
 */

export const VERSION_POST_MAX = 20;
const VERSION_MAX = 24;
const TITLE_MAX = 60;
const BODY_MAX = 4000;

/** 去掉控制字符、夹长度 */
function clean(text, max) {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
    .slice(0, max);
}

/**
 * 发一条版本公告。
 * @returns {{ok:boolean, error?:string, post?:object}}
 */
export function pushVersionPost(db, { version, title, body, tick = 0 } = {}) {
  if (!db) return { ok: false, error: '参数不对' };
  const v = clean(version, VERSION_MAX);
  const t = clean(title, TITLE_MAX);
  const b = clean(body, BODY_MAX);
  if (!t) return { ok: false, error: '标题不能为空' };
  if (!b) return { ok: false, error: '内容不能为空' };

  if (!Array.isArray(db.versionPosts)) db.versionPosts = [];
  const post = {
    id: 'v_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    version: v,
    title: t,
    body: b,
    at: Date.now(),
    tick: Number(tick) || 0
  };
  db.versionPosts.push(post);
  if (db.versionPosts.length > VERSION_POST_MAX) {
    db.versionPosts.splice(0, db.versionPosts.length - VERSION_POST_MAX);
  }
  return { ok: true, post };
}

/** 最新一条（没有就 null） */
export function latestVersionPost(db) {
  const list = Array.isArray(db?.versionPosts) ? db.versionPosts : [];
  return list.length ? list[list.length - 1] : null;
}

/** 全部（旧的在前，管理面板用） */
export function listVersionPosts(db) {
  const list = Array.isArray(db?.versionPosts) ? db.versionPosts : [];
  return list.slice(-VERSION_POST_MAX);
}

/** 删一条 */
export function deleteVersionPost(db, id) {
  if (!db || !Array.isArray(db.versionPosts)) return false;
  const before = db.versionPosts.length;
  db.versionPosts = db.versionPosts.filter((p) => p && p.id !== String(id));
  return db.versionPosts.length !== before;
}
