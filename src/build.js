// 前端版本号：index.html / app.js / styles.css 一变，版本号就变。
// 客户端收到新的版本号会自动刷新，玩家不用手动按 F5。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(HERE, '..', 'public');

const FILES = ['index.html', 'app.js', 'styles.css', 'vendor/lightweight-charts.js'];

let cached = '';
let cachedAt = 0;

/** 计算前端版本号；2 秒内的重复调用走缓存 */
export function getBuild() {
  const t = Date.now();
  if (cached && t - cachedAt < 2000) return cached;

  const h = crypto.createHash('sha1');
  for (const f of FILES) {
    try {
      const st = fs.statSync(path.join(PUB, f));
      h.update(`${f}:${Math.round(st.mtimeMs)}:${st.size};`);
    } catch {
      h.update(`${f}:missing;`);
    }
  }
  cached = h.digest('hex').slice(0, 10);
  cachedAt = t;
  return cached;
}
