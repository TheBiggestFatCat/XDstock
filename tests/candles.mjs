// K 线聚合回归：逐 tick 档改成 10 轮一根 + 上限 1200 根
//
//   node tests/candles.mjs

import { TIMEFRAMES, TF_LABELS } from '../src/config.js';
import { candlesFromSeries } from '../src/engine.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

const TICK_MS = 5000;
// 价格 = 100 + 下标，方便核对 open/high/low/close
const series = (n) => Array.from({ length: n }, (_, i) => 100 + i);

// ---------------------------------------------------------------- 1
log('=== 1 常量 ===');
{
  check("TIMEFRAMES.tick = 10", TIMEFRAMES.tick === 10, String(TIMEFRAMES.tick));
  check("其它周期没被动（12/60/180）",
    TIMEFRAMES['1m'] === 12 && TIMEFRAMES['5m'] === 60 && TIMEFRAMES['15m'] === 180,
    `${TIMEFRAMES['1m']}/${TIMEFRAMES['5m']}/${TIMEFRAMES['15m']}`);
  check('按钮文案改成 10 轮', TF_LABELS.tick === '10 轮', TF_LABELS.tick);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 3600 轮历史 → 360 根（10 轮一根）===');
{
  const s = series(3600);
  const c = candlesFromSeries(s, TIMEFRAMES.tick, TICK_MS, 0, 1200, 0, null);
  check('根数 = 3600 / 10 = 360', c.length === 360, `${c.length} 根`);
  check('第一根聚合 0~9 轮',
    c[0].open === 100 && c[0].close === 109 && c[0].low === 100 && c[0].high === 109,
    JSON.stringify(c[0]));
  check('第二根从第 10 轮开始', c[1].open === 110 && c[1].close === 119, JSON.stringify(c[1]));
  check('最后一根是最近的 10 轮', c[c.length - 1].close === 100 + 3599, JSON.stringify(c[c.length - 1]).slice(0, 80));
  check('每根间隔 50 秒', c[1].time - c[0].time === 50, `${c[1].time - c[0].time}s`);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 上限 1200 ===');
{
  const big = series(12000);
  const c = candlesFromSeries(big, TIMEFRAMES.tick, TICK_MS, 0, 1200, 0, null);
  check('12000 轮 → 恰好 1200 根（不超上限）', c.length === 1200, `${c.length} 根`);
  const c2 = candlesFromSeries(big, TIMEFRAMES.tick, TICK_MS, 0, 400, 0, null);
  check('显式给 400 时只返回 400（上限参数仍生效）', c2.length === 400, `${c2.length} 根`);
  check('截断取的是最近的（最后一根是末尾）', c2[c2.length - 1].close === 100 + 11999);
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 默认上限已改成 1200 ===');
{
  const c = candlesFromSeries(series(12000), TIMEFRAMES.tick, TICK_MS, 0, undefined, 0, null);
  check('不传 maxCandles 时默认 1200', c.length === 1200, `${c.length} 根`);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 其它周期不受影响 ===');
{
  const s = series(3600);
  const c1m = candlesFromSeries(s, TIMEFRAMES['1m'], TICK_MS, 0, 1200, 0, null);
  const c5m = candlesFromSeries(s, TIMEFRAMES['5m'], TICK_MS, 0, 1200, 0, null);
  const c15m = candlesFromSeries(s, TIMEFRAMES['15m'], TICK_MS, 0, 1200, 0, null);
  check('1 分钟 → 300 根', c1m.length === 300, `${c1m.length}`);
  check('5 分钟 → 60 根', c5m.length === 60, `${c5m.length}`);
  check('15 分钟 → 20 根', c15m.length === 20, `${c15m.length}`);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
