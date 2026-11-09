// 管理面板参数表的一致性（静态体检，不启服务）
//   node tests/admin-panel.mjs
//
// 守的几件事：
//   1. 面板上的每个字段都必须是 DEFAULT_CONFIG 里真实存在的键（不能有幽灵设置）
//   2. 除了 marketOpen（有「开市/休市」按钮），每个配置项都要能在面板上调
//   3. 面板字段必须都在 api.js 的管理员白名单里，否则点保存会被静默丢掉
//   4. 同一个键不能在面板里出现两次（以前红牛返现、偷钱、散户情绪都各出现了两遍）
//   5. 字段元组第 3 位要么是 'text'（输入框类型），要么是一句说明；说明不能为空

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../src/config.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'src/api.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

/** 从源码里抠出一个 `const X = [...]` 数组并求值（纯数据，可以直接 eval） */
function grabArray(src, name) {
  const mark = 'const ' + name + ' = [';
  const i = src.indexOf(mark);
  if (i < 0) throw new Error('找不到 ' + name);
  const j = i + mark.length - 1;
  let depth = 0;
  let end = -1;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '[') depth++;
    else if (src[k] === ']') { depth--; if (depth === 0) { end = k; break; } }
  }
  if (end < 0) throw new Error(name + ' 括号不配平');
  return (0, eval)('(' + src.slice(j, end + 1) + ')');
}

const cats = grabArray(appSrc, 'CFG_CATS');
const stockGroups = grabArray(appSrc, 'STOCK_CFG_GROUPS');
const configKeys = new Set(Object.keys(DEFAULT_CONFIG));

// ---------- 1 面板字段结构 ----------
const panel = [];
let badTuple = 0;
const walk = (groups, where) => {
  for (const g of groups) {
    if (!g.title || !Array.isArray(g.fields)) { badTuple++; continue; }
    for (const f of g.fields) {
      if (!Array.isArray(f) || typeof f[0] !== 'string' || !f[0]) { badTuple++; continue; }
      const meta = f[2];
      if (meta !== undefined && typeof meta !== 'string') badTuple++;
      if (typeof meta === 'string' && !meta.trim()) badTuple++;
      panel.push({ key: f[0], label: f[1], hint: typeof meta === 'string' && meta !== 'text' ? meta : null, where });
    }
  }
};
for (const c of cats) walk(c.groups, c.name);
walk(stockGroups, '个股页');

// 手写在 index.html 里的 data-cfg（定时休市的循环作息那块）也算「面板可调」
const htmlCfgKeys = new Set();
for (const m of htmlSrc.matchAll(/data-cfg="([A-Za-z0-9_]+)"/g)) htmlCfgKeys.add(m[1]);
for (const k of htmlCfgKeys) {
  if (!panel.some((p) => p.key === k)) {
    panel.push({ key: k, label: '(手写 HTML) ' + k, hint: null, where: '市场页' });
  }
}

check('19 大类/组结构没坏元组', badTuple === 0, `坏 ${badTuple}`);
check('面板字段都在 DEFAULT_CONFIG 里',
  panel.every((p) => configKeys.has(p.key)),
  panel.filter((p) => !configKeys.has(p.key)).map((p) => p.key).join(',') || '全部命中');
const dupes = panel.map((p) => p.key).filter((k, i, a) => a.indexOf(k) !== i);
check('同一个键没在面板里出现两次', dupes.length === 0, [...new Set(dupes)].join(',') || '无重复');
check('每个字段都有标签', panel.every((p) => typeof p.label === 'string' && p.label.trim().length > 0));

// ---------- 2 覆盖：除 marketOpen 外都能调 ----------
const missing = [...configKeys].filter((k) => k !== 'marketOpen' && !panel.some((p) => p.key === k));
check('除 marketOpen（有开市按钮）外，每个配置项都能在面板上调', missing.length === 0, missing.join(',') || '全覆盖');
check('面板上没有 marketOpen（走的是休市按钮）', !panel.some((p) => p.key === 'marketOpen'));

// ---------- 3 白名单：面板上的键必须能保存 ----------
// api.js 里有多个 allowed 数组，取包含 tickMs 的那个（配置项白名单）
const allowedBlocks = [...apiSrc.matchAll(/const allowed = \[([\s\S]*?)\n\s*\];/g)].map((m) => m[1]);
const cfgAllowedSrc = allowedBlocks.find((b) => b.includes("'tickMs'"));
check('找到管理员配置白名单', !!cfgAllowedSrc);
const allowed = new Set(
  // 先去掉 // 注释，否则注释后面那个键会被一起吞掉
  (cfgAllowedSrc || '').replace(/\/\/[^\n]*/g, '')
    .split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter((s) => /^[a-zA-Z0-9_]+$/.test(s))
);
const notAllowed = panel.filter((p) => !allowed.has(p.key)).map((p) => p.key);
check('面板字段都在管理员白名单里（保存不会静默丢键）', notAllowed.length === 0,
  [...new Set(notAllowed)].join(',') || '全部在内');
const allowedGhost = [...allowed].filter((k) => !configKeys.has(k));
check('白名单里没有 config 不存在的键', allowedGhost.length === 0, allowedGhost.join(',') || '干净');

// ---------- 4 说明文字 ----------
const withHint = panel.filter((p) => p.hint).length;
check('至少一半字段写了说明', withHint >= Math.floor(panel.length / 2), `${withHint}/${panel.length}`);
check('说明不是重复标签', panel.filter((p) => p.hint && p.hint === p.label).length === 0);

// ---------- 5 个股页容器存在 ----------
check('index.html 有 #stockGlobalCfg 容器', htmlSrc.includes('id="stockGlobalCfg"'));
check('index.html 有个股参数保存按钮', htmlSrc.includes('id="stockCfgSaveBtn"'));
check('app.js 会把个股组渲染进容器', /stockGlobalCfg/.test(appSrc) && /STOCK_CFG_GROUPS\.map/.test(appSrc));
check('保存函数扫描整个管理面板（两个容器都收）', /#adminPanel \[data-cfg\]/.test(appSrc));

// ---------- 6 已删掉的废弃键 ----------
check('eventDurationMin 已从 config 删除', !configKeys.has('eventDurationMin'));
check('eventDurationMax 已从 config 删除', !configKeys.has('eventDurationMax'));
check('面板里也没有 news 时长这两个废弃字段', !panel.some((p) => p.key.startsWith('eventDuration')));

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
