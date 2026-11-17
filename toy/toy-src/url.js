// 浏览器版 node:url —— 只实现 store.js 用到的 fileURLToPath
export function fileURLToPath(u) {
  const s = typeof u === 'string' ? u : String(u && u.href ? u.href : u);
  try {
    return decodeURIComponent(new URL(s).pathname);
  } catch {
    return s;
  }
}
export default { fileURLToPath };
