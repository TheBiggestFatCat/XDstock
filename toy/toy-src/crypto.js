// 浏览器版 node:crypto —— build.js 已被替换，这里只做兜底
export function randomUUID() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'toy-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
export default { randomUUID };
