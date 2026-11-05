// 静态体检：跨模块函数「用了但没 import」
//
//   node tests/imports.mjs
//
// 由来：2026-11 上线主题成就时，server.js 里写了 `isNightWindow(d)` 却忘了加进
// import 列表。`node --check` 只查语法，查不出未定义标识符；本地测试也没走到偷钱分支，
// 结果线上每个 tick 抛一次 ReferenceError，systemd 重启循环，40 秒后才被热修。
// 这个测试把成就/主题模块的导出逐个对一遍「用到就必须 import」，几毫秒跑完。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

/** 需要「用到就必须 import」的模块 */
const PROVIDERS = ['src/achievements.js', 'src/theme.js', 'src/trading.js'];
/** 会消费这些模块的文件（server.js 不在 src 下，单独列） */
const CONSUMERS = [
  'server.js', 'src/api.js', 'src/trading.js', 'src/engine.js',
  'src/store.js', 'src/theme.js', 'src/fundamentals.js'
];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 去掉注释，避免注释里的名字造成误报 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * 解析 import 语句 → Map(from → { imported:Set<导入名>, local:Set<本地名> })
 * 别名（`THEMES as ACHV_THEMES`）两边都要记：
 *   正向检查用 local（代码里出现的是本地名），反向检查用 imported（模块里得有这个导出）
 */
function parseImports(src) {
  const map = new Map();
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const key = m[2];
    if (!map.has(key)) map.set(key, { imported: new Set(), local: new Set() });
    const slot = map.get(key);
    for (const part of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
      const bits = part.split(/\s+as\s+/);
      slot.imported.add(bits[0].trim());
      slot.local.add((bits[1] || bits[0]).trim());
    }
  }
  return map;
}

/** 文件自己声明的名字（函数/常量/类） */
function declaredNames(src) {
  const names = new Set();
  const re = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  return names;
}

// ---------------------------------------------------------------- 1
log('=== 1 取各模块的导出清单 ===');
const exportsOf = {};
for (const rel of PROVIDERS) {
  const mod = await import('file:///' + path.join(ROOT, rel).replace(/\\/g, '/'));
  exportsOf[rel] = Object.keys(mod).filter((k) => k !== 'default');
  check(`${rel} 导出 ${exportsOf[rel].length} 个名字`, exportsOf[rel].length > 0);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 逐个消费者检查「用了必须 import」===');
for (const rel of CONSUMERS) {
  const raw = read(rel);
  const src = stripComments(raw);
  const imports = parseImports(src);
  const own = declaredNames(src);
  // 自己身上声明的名字（有可能和别的模块同名，比如 trading.js 自己导出了 feeRateFor）
  const selfExports = new Set(exportsOf[rel] || []);
  const missing = [];
  for (const [prov, names] of Object.entries(exportsOf)) {
    if (prov === rel) continue;                        // 自己导出的不用 import
    const importedHere = new Set();
    for (const [from, slot] of imports) {
      if (from.endsWith(prov.replace(/^src\//, './')) || from === prov || from.endsWith(prov)) {
        for (const n of slot.local) importedHere.add(n);
      }
    }
    for (const name of names) {
      if (own.has(name) || selfExports.has(name)) continue;
      const used = new RegExp(`(^|[^\\w.$])${name.replace(/\$/g, '\\$')}\\s*[(.\\[;,\\s)]`).test(src);
      if (!used) continue;
      if (!importedHere.has(name)) missing.push(`${name}（来自 ${prov}）`);
    }
  }
  check(`${rel} 没有「用了但没 import」`, missing.length === 0, missing.join(', ') || '');
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 反向检查：import 了不存在的导出 ===');
for (const rel of CONSUMERS) {
  const src = stripComments(read(rel));
  const imports = parseImports(src);
  const bad = [];
  for (const [from, slot] of imports) {
    if (!from.startsWith('.')) continue;               // 只看本地模块
    const target = from.replace(/^\.\//, '').replace(/^\.\.\//, '');
    const candidates = [target, path.posix.join(path.posix.dirname(rel.replace(/\\/g, '/')), target)];
    const prov = PROVIDERS.find((p) => candidates.includes(p) || p.endsWith('/' + target));
    if (!prov) continue;                               // 非这三个模块（如 orders.js）不在本测试范围
    for (const n of slot.imported) {
      if (!exportsOf[prov].includes(n)) bad.push(`${n}（${prov} 没有这个导出）`);
    }
  }
  check(`${rel} 的 import 名字都存在`, bad.length === 0, bad.join(', ') || '');
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
