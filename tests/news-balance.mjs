// 新闻池体检：每只票都有新闻，而且利好/利空「零和」
//   node tests/news-balance.mjs
//
// 为什么要求零和：新闻按 dir 推价格，如果一只票的利好比利空多，
// 它就会长期被新闻往上顶（或往下压），等于白送一个永久漂移。

import { NEWS_POOL } from '../src/news.js';
import { STOCK_CODES } from '../src/stocks.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

const up = {};
const down = {};
const total = {};
for (const c of STOCK_CODES) { up[c] = 0; down[c] = 0; total[c] = 0; }
const unknown = new Set();
let globalUp = 0;
let globalDown = 0;
const seen = new Set();
const dups = [];
let badDir = 0;
let emptyText = 0;

for (const n of NEWS_POOL) {
  const text = String(n.text || '');
  if (!text.trim()) emptyText++;
  if (seen.has(text)) dups.push(text.slice(0, 24));
  seen.add(text);
  if (n.dir !== 1 && n.dir !== -1) badDir++;
  const cs = (n.companies || []).filter(Boolean);
  if (!cs.length) {
    if (n.dir > 0) globalUp++; else globalDown++;
    continue;
  }
  for (const c of cs) {
    if (!(c in up)) { unknown.add(c); continue; }
    total[c]++;
    if (n.dir > 0) up[c]++; else down[c]++;
  }
}

log('=== 1 每只票都有新闻 ===');
for (const c of STOCK_CODES) {
  check(`${c} 有新闻`, total[c] > 0, `${total[c]} 条`);
}

log('');
log('=== 2 每只票利好 / 利空数量相等（零和）===');
for (const c of STOCK_CODES) {
  check(`${c} 零和`, up[c] === down[c], `利好 ${up[c]} / 利空 ${down[c]}`);
}

log('');
log('=== 3 全市场联播也零和 ===');
check('全市场利好 = 利空', globalUp === globalDown, `利好 ${globalUp} / 利空 ${globalDown}`);
check('全市场有一批库存', globalUp + globalDown >= 8, `${globalUp + globalDown} 条`);

log('');
log('=== 4 池子本身干净 ===');
check('没有引用已下市的票', unknown.size === 0, [...unknown].join(', ') || '无');
check('没有重复文案', dups.length === 0, dups.join(' / ') || '无');
check('dir 只有 +1 / -1', badDir === 0, `${badDir} 条异常`);
check('文案都不为空', emptyText === 0, `${emptyText} 条空的`);
check('池子够大（>= 100 条）', NEWS_POOL.length >= 100, `${NEWS_POOL.length} 条`);
// 每只票至少 6 条，避免某只票长期只循环那两三条
for (const c of STOCK_CODES) {
  check(`${c} 至少有 6 条`, total[c] >= 6, `${total[c]} 条`);
}

log('');
log('=== 5 一览表 ===');
for (const c of STOCK_CODES) {
  log(`  ${c.padEnd(6)} 利好 ${String(up[c]).padStart(3)} / 利空 ${String(down[c]).padStart(3)}  共 ${total[c]}`);
}
log(`  全市场   利好 ${String(globalUp).padStart(3)} / 利空 ${String(globalDown).padStart(3)}  共 ${globalUp + globalDown}`);

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
