// 浏览器版 node:zlib —— 试玩版不发 gzip（fake fetch 不带 accept-encoding）
export function gzipSync(buf) { return buf; }
export function createGzip() { return null; }
export default { gzipSync, createGzip };
