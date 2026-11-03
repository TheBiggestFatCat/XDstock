// K 线时间轴归一化回归：服务器停机留下的空洞必须被压掉
//
//   node tests/chart-axis.mjs

import { tickTimeAxis, timeFromAxis, candlesFromSeries } from '../src/engine.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

const TICK_MS = 5000;
const T0 = 1793000000000;

function mkDb(segments) {
  // segments: [轮数, 该段开始前的停机毫秒]
  const times = [];
  let t = T0;
  for (const [n, gap] of segments) {
    t += gap;                    // 先停机，再继续记 tick
    for (let i = 0; i < n; i++) {
      times.push(t);
      t += TICK_MS;
    }
  }
  return { config: { tickMs: TICK_MS }, tickTimesStart: 100, tickTimes: times };
}

// ---------------------------------------------------------------- 1
log('=== 1 两小时停机 → 空洞被压掉 ===');
{
  const db = mkDb([[100, 0], [100, 2 * 3600 * 1000]]);
  const raw = db.tickTimes[100] - db.tickTimes[99];
  const axis = tickTimeAxis(db);
  const deltas = [];
  for (let i = 1; i < axis.times.length; i++) deltas.push(axis.times[i] - axis.times[i - 1]);
  check('原始数据里确实有 2 小时空洞', raw > 3600 * 1000, `${(raw / 1000).toFixed(0)} 秒`);
  check('归一化后最大间隔 ≤ 3×tickMs', Math.max(...deltas) <= TICK_MS * 3, `${Math.max(...deltas)} ms`);
  check('归一化后最小间隔 ≥ 0.25×tickMs', Math.min(...deltas) >= TICK_MS * 0.25, `${Math.min(...deltas)} ms`);
  check('严格递增（图表库硬要求）', deltas.every((d) => d > 0));
  check('最新一轮仍是最新时间（不整体漂移）',
    axis.times[axis.times.length - 1] === db.tickTimes[db.tickTimes.length - 1]);
  check('长度和 tickTimesStart 保持不变',
    axis.times.length === db.tickTimes.length && axis.start === db.tickTimesStart);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 多次停机 ===');
{
  const db = mkDb([[50, 0], [50, 600 * 1000], [50, 0], [50, 12 * 3600 * 1000], [50, 0]]);
  const axis = tickTimeAxis(db);
  const deltas = [];
  for (let i = 1; i < axis.times.length; i++) deltas.push(axis.times[i] - axis.times[i - 1]);
  check('所有空洞都被压到 15 秒内', Math.max(...deltas) <= TICK_MS * 3, `max=${Math.max(...deltas)} ms`);
  check('总跨度大幅缩短', (axis.times[axis.times.length - 1] - axis.times[0]) < 250 * TICK_MS * 2,
    `${((axis.times[axis.times.length - 1] - axis.times[0]) / 1000).toFixed(0)} 秒`);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 边界情况 ===');
{
  const empty = { config: { tickMs: TICK_MS }, tickTimesStart: 7, tickTimes: [] };
  const a0 = tickTimeAxis(empty);
  check('空数组不炸', Array.isArray(a0.times) && a0.times.length === 0 && a0.start === 7);

  const one = { config: { tickMs: TICK_MS }, tickTimesStart: 1, tickTimes: [T0] };
  const a1 = tickTimeAxis(one);
  check('只有一轮时原样返回', a1.times.length === 1 && a1.times[0] === T0);

  // 时间戳重复（理论上不该有，但存档可能坏）
  const dup = { config: { tickMs: TICK_MS }, tickTimesStart: 0, tickTimes: [T0, T0, T0 + TICK_MS] };
  const a2 = tickTimeAxis(dup);
  check('重复时间戳被拉开成递增', a2.times[1] > a2.times[0] && a2.times[2] > a2.times[1],
    JSON.stringify(a2.times.map((x, i) => (i ? x - a2.times[i - 1] : 0))));
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 越界外推 ===');
{
  const db = mkDb([[10, 0]]);
  const axis = tickTimeAxis(db);
  const lastIdx = axis.times.length - 1;
  const lastAbs = axis.start + lastIdx;
  const t1 = timeFromAxis(axis, lastAbs + 3, db);
  check('超出记录范围按 tickMs 外推', t1 === axis.times[lastIdx] + 3 * TICK_MS, `${t1}`);
  const t0 = timeFromAxis(axis, axis.start + 2, db);
  check('范围内直接查表', t0 === axis.times[2]);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 用它生成 K 线：间隔连续，没有大洞 ===');
{
  const db = mkDb([[200, 0], [200, 3 * 3600 * 1000]]);
  const axis = tickTimeAxis(db);
  const series = Array.from({ length: 400 }, (_, i) => 100 + i);
  for (const group of [10, 12, 60]) {
    const c = candlesFromSeries(series, group, TICK_MS, 0, 1200, 0,
      (absTick) => timeFromAxis(axis, absTick, db));
    const ds = [];
    for (let i = 1; i < c.length; i++) ds.push(c[i].time - c[i - 1].time);
    const expect = (group * TICK_MS) / 1000;
    check(`group=${group}：最大间隔 ≤ 2×理论值`,
      Math.max(...ds) <= expect * 2.2, `max=${Math.max(...ds)}s 理论=${expect}s`);
    check(`group=${group}：时间严格递增`, ds.every((d) => d > 0));
  }
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
