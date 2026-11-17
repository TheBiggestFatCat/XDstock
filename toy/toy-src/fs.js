// 浏览器虚拟文件系统：把 store.js / api.js 的 fs 调用映射到内存 + localStorage
// 只实现 Toy 试玩版用到的同步 API。db.json 与头像都存在 localStorage 里。
const KEY = 'xd_toy_fs_v1';
const files = new Map();

function norm(p) {
  let s = String(p == null ? '' : p).replace(/\\/g, '/');
  const abs = s.startsWith('/');
  const out = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return (abs ? '/' : '') + out.join('/');
}
function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s || '');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    for (const [k, v] of Object.entries(JSON.parse(raw))) files.set(k, v);
  } catch (e) { console.warn('[toy] 本地存档读取失败', e); }
}
function persistNow() {
  try {
    const obj = {};
    for (const [k, v] of files) obj[k] = v;
    localStorage.setItem(KEY, JSON.stringify(obj));
  } catch (e) { console.warn('[toy] 本地存档写入失败（可能超出 localStorage 限额）', e); }
}
let persistTimer = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persistNow(); }, 300);
}
load();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', persistNow);
  window.addEventListener('pagehide', persistNow);
}

function makeRecord(data) {
  if (typeof data === 'string') return { t: 's', v: data };
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return { t: 'b', v: b64(bytes) };
}

const fs = {
  mkdirSync() {},
  existsSync(p) { return files.has(norm(p)); },
  statSync(p) {
    const rec = files.get(norm(p));
    if (!rec) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; }
    const size = rec.t === 's' ? rec.v.length : unb64(rec.v).length;
    return { isFile: () => true, isDirectory: () => false, size, mtimeMs: Date.now() };
  },
  readFileSync(p, encoding) {
    const key = norm(p);
    const rec = files.get(key);
    if (!rec) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; }
    if (encoding === 'utf8' || encoding === 'utf-8' || typeof encoding === 'object') return rec.v;
    return rec.t === 's' ? new TextEncoder().encode(rec.v) : unb64(rec.v);
  },
  writeFileSync(p, data) {
    files.set(norm(p), makeRecord(data));
    schedulePersist();
  },
  renameSync(a, b) {
    const from = norm(a);
    const rec = files.get(from);
    if (!rec) return;
    files.delete(from);
    files.set(norm(b), rec);
    schedulePersist();
  },
  copyFileSync(a, b) {
    const rec = files.get(norm(a));
    if (rec) files.set(norm(b), { ...rec });
    schedulePersist();
  },
  readdirSync(p) {
    const prefix = norm(p).replace(/\/$/, '') + '/';
    const names = new Set();
    for (const k of files.keys()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      names.add(rest);
    }
    return [...names];
  },
  unlinkSync(p) { files.delete(norm(p)); schedulePersist(); }
};

export default fs;
export { files as __files, persistNow as __persistNow };
