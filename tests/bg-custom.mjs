// 自定义背景：透明度 + 取消背景
//   node tests/bg-custom.mjs
//
// 规则（api.js）：
//   - bgOpacity 存的是「不透明度」0~100，没设置过默认 100（原图）
//   - 前端滑条是「透明度」：透明度 = 100 - 不透明度
//   - 取消背景只清图片，保留 bgUnlocked（随时能再传）
//   - 没解锁时两个接口都拒绝

import { normalizeBgOpacity } from '../src/api.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

// ---------------------------------------------------------------- 1
log('=== 1 不透明度的取值规则 ===');
{
  check('正常值原样保留', normalizeBgOpacity(42) === 42);
  check('0 = 完全透明', normalizeBgOpacity(0) === 0);
  check('100 = 原图', normalizeBgOpacity(100) === 100);
  check('负数夹到 0', normalizeBgOpacity(-30) === 0);
  check('超过 100 夹到 100', normalizeBgOpacity(250) === 100);
  check('小数四舍五入', normalizeBgOpacity(63.6) === 64);
  check('字符串数字也能用', normalizeBgOpacity('35') === 35);
  check('非数字返回 null', normalizeBgOpacity('abc') === null);
  check('undefined 返回 null', normalizeBgOpacity(undefined) === null);
  check('NaN 返回 null', normalizeBgOpacity(NaN) === null);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 前端「透明度」↔ 后端「不透明度」换算 ===');
{
  const toOpacity = (transparency) => 100 - Math.max(0, Math.min(100, Number(transparency) || 0));
  check('滑条 0% → 不透明度 100（原图）', toOpacity(0) === 100);
  check('滑条 100% → 不透明度 0（看不见）', toOpacity(100) === 0);
  check('滑条 30% → 不透明度 70', toOpacity(30) === 70);
  check('滑条越界也安全', toOpacity(-5) === 100 && toOpacity(500) === 0);
  check('换算再换回来不变', 100 - toOpacity(37) === 37);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 取消背景 / 重新上传时的字段变化 ===');
{
  // 模拟 api.js 里 /api/shop/bg/clear
  const me = { bgUnlocked: true, background: 'data:image/jpeg;base64,AAAA', bgOpacity: 40 };
  me.background = '';
  check('取消背景只清图', me.background === '');
  check('解锁状态还在', me.bgUnlocked === true);
  check('不透明度还留着', me.bgOpacity === 40);

  // 模拟 /api/shop/bg/save 里补默认值
  if (!Number.isFinite(Number(me.bgOpacity))) me.bgOpacity = 100;
  check('重新上传沿用之前的不透明度', me.bgOpacity === 40);

  const fresh = { bgUnlocked: true, background: 'data:image/jpeg;base64,BBBB' };
  if (!Number.isFinite(Number(fresh.bgOpacity))) fresh.bgOpacity = 100;
  check('第一次上传默认 100', fresh.bgOpacity === 100);
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 没解锁时不许动 ===');
{
  const guard = (me) => (me.bgUnlocked ? 'ok' : 'denied');
  check('已解锁可以调透明度', guard({ bgUnlocked: true }) === 'ok');
  check('已解锁可以取消', guard({ bgUnlocked: true }) === 'ok');
  check('没解锁两个都拒绝', guard({}) === 'denied');
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
