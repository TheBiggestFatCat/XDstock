// 浏览器版 node:path（POSIX 语义，Toy 运行环境足够用）
function normParts(p) {
  const s = String(p == null ? '' : p).replace(/\\/g, '/');
  const abs = s.startsWith('/');
  const out = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return { abs, parts: out };
}
function join(...args) {
  const segs = [];
  let abs = false;
  for (const a of args.flat()) {
    const s = String(a == null ? '' : a).replace(/\\/g, '/');
    if (s.startsWith('/')) abs = true;
    for (const part of s.split('/')) if (part && part !== '.') segs.push(part);
  }
  const out = [];
  for (const seg of segs) {
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return (abs ? '/' : '') + out.join('/');
}
function dirname(p) {
  const { abs, parts } = normParts(p);
  parts.pop();
  return (abs ? '/' : '') + parts.join('/');
}
function resolve(...args) {
  let out = '';
  for (const a of args.flat()) out = join(out, a);
  return join('/', out);
}
function normalize(p) {
  const { abs, parts } = normParts(p);
  const s = (abs ? '/' : '') + parts.join('/');
  return s || (abs ? '/' : '.');
}
function basename(p, ext) {
  const { parts } = normParts(p);
  let name = parts[parts.length - 1] || '';
  if (ext && name.endsWith(ext)) name = name.slice(0, -ext.length);
  return name;
}
function extname(p) {
  const name = basename(p);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i) : '';
}

export default { sep: '/', join, dirname, resolve, normalize, basename, extname };
export { join, dirname, resolve, normalize, basename, extname };
