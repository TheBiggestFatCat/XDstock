// K 线粒度跟随 tickMs：改 tickMs 后 1m / 5m / 15m 都必须仍是真实分钟
//   node tests/candles-tickms.mjs
import { TIMEFRAMES, timeframeTicks, SERIES_1M_BARS, seriesRetentionTicks } from '../src/config.js';
import {
  BAR5_TICKS, BAR15_TICKS, bar5TicksFor, bar15TicksFor, rebucketBars,
  bars5Candles, bars15Candles, seedBars5
} from '../src/bars15.js';
import { candlesFromSeries, changesFor, stepMarket } from '../src/engine.js';
import { createDb, migrate } from '../src/store.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
const near = (a, b, eps = 1e-9) => Math.abs(Number(a) - Number(b)) < eps;
const quiet = (fn) => {
  const real = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = real; }
};

// ---------------------------------------------------------------- 1
log('=== 1 周期换算：tickMs 变了，每个周期要的 tick 数跟着变 ===');
{
  const base = timeframeTicks(5000);
  check('5000ms 基准保持 12/60/180',
    base['1m'] === 12 && base['5m'] === 60 && base['15m'] === 180, JSON.stringify(base));
  const fast = timeframeTicks(2000);
  check('2000ms → 1m=30 / 5m=150 / 15m=450',
    fast['1m'] === 30 && fast['5m'] === 150 && fast['15m'] === 450, JSON.stringify(fast));
  const slow = timeframeTicks(10000);
  check('10000ms → 1m=6 / 5m=30 / 15m=90',
    slow['1m'] === 6 && slow['5m'] === 30 && slow['15m'] === 90, JSON.stringify(slow));
  check('脏 tickMs 回退 5000ms',
    timeframeTicks(0)['1m'] === 12 && timeframeTicks(NaN)['1m'] === 12);
  check('TIMEFRAMES 仍是基准值（不直接被改）',
    TIMEFRAMES['1m'] === 12 && TIMEFRAMES['5m'] === 60 && TIMEFRAMES['15m'] === 180);
  check('SERIES_1M_BARS = 300（和 5m 根数一致）', SERIES_1M_BARS === 300, String(SERIES_1M_BARS));
  check('series 保留量：5000ms → 3600 tick', seriesRetentionTicks(5000) === 3600, String(seriesRetentionTicks(5000)));
  check('series 保留量：2000ms → 9000 tick', seriesRetentionTicks(2000) === 9000, String(seriesRetentionTicks(2000)));
  check('series 保留量：3000ms → 6000 tick', seriesRetentionTicks(3000) === 6000, String(seriesRetentionTicks(3000)));
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 5m / 15m 分桶：按 tickMs 算，不再写死 60 / 180 ===');
{
  check('2000ms：5m=150 tick', bar5TicksFor(2000) === 150, String(bar5TicksFor(2000)));
  check('2000ms：15m=450 tick', bar15TicksFor(2000) === 450, String(bar15TicksFor(2000)));
  check('5000ms：5m=60 / 15m=180',
    bar5TicksFor(5000) === 60 && bar15TicksFor(5000) === 180);
  check('1000ms：5m=300 tick', bar5TicksFor(1000) === 300, String(bar5TicksFor(1000)));
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 1m 聚合：group=30 + tickMs=2000 时一根正好 60 秒 ===');
{
  const series = Array.from({ length: 300 }, (_, i) => 100 + i * 0.01);
  const candles = candlesFromSeries(series, timeframeTicks(2000)['1m'], 2000, 0);
  check('300 tick → 10 根 1m', candles.length === 10, String(candles.length));
  const gaps = candles.slice(1).map((c, i) => c.time - candles[i].time);
  check('每根间隔 60 秒', gaps.every((g) => g === 60), gaps.join(','));
  const series5 = Array.from({ length: 300 }, (_, i) => 100 + i * 0.01);
  const c5 = candlesFromSeries(series5, timeframeTicks(2000)['5m'], 2000, 0);
  check('300 tick → 2 根 5m', c5.length === 2, String(c5.length));
  check('5m 每根间隔 300 秒', c5[1].time - c5[0].time === 300, String(c5[1].time - c5[0].time));
  const big = Array.from({ length: seriesRetentionTicks(2000) }, (_, i) => 100 + i * 0.001);
  const c1m300 = candlesFromSeries(big, timeframeTicks(2000)['1m'], 2000, 0);
  check('9000 tick → 300 根 1m（和 5m 一样多）', c1m300.length === 300, String(c1m300.length));
  check('1m 仍是 60 秒一根', c1m300[1].time - c1m300[0].time === 60, String(c1m300[1].time - c1m300[0].time));
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 5m/15m 数据包：时间轴间隔 = 真实分钟 ===');
{
  const list = [
    [0, 10, 11, 9, 10, 120],
    [1, 10, 12, 9.5, 11, 150],
    [2, 11, 13, 10, 12, 90]
  ];
  const timeOf = (absTick) => absTick * 2000;   // 真实时间轴：2000ms/tick
  const c5 = bars5Candles(list, timeOf, bar5TicksFor(2000));
  check('5m：3 根 → 时间 [0,300,600] 秒',
    c5.length === 3 && c5[0].time === 0 && c5[1].time === 300 && c5[2].time === 600,
    c5.map((c) => c.time).join(','));
  const c15 = bars15Candles(list, timeOf, bar15TicksFor(2000));
  check('15m：间隔 900 秒',
    c15.length === 3 && c15[1].time - c15[0].time === 900,
    c15.map((c) => c.time).join(','));
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 老存档重分桶：60 tick/根 → 150 tick/根 ===');
{
  const old = [
    [0, 10, 11, 9, 10, 5],
    [1, 10, 12, 9, 11, 7],
    [2, 11, 13, 10, 12, 3]
  ];
  const merged = rebucketBars(old, 60, 150, 300);
  check('三根 2 分钟合成一根 5 分钟', merged.length === 1, JSON.stringify(merged[0]));
  check('OHLCV 正确合并', near(merged[0][1], 10) && near(merged[0][2], 13)
    && near(merged[0][3], 9) && near(merged[0][4], 12) && near(merged[0][5], 15),
    JSON.stringify(merged[0]));
  const finer = rebucketBars(old, 60, 30, 300);
  check('变细时每根独立保留', finer.length === 3, finer.map((b) => b[0]).join(','));
  check('变细后 bucket 按比例映射', finer[1][0] === 2 && finer[2][0] === 4,
    finer.map((b) => b[0]).join(','));
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 migrate：tickMs 变了会按新节奏重铺 K 线历史 ===');
{
  let db = quiet(() => migrate(createDb()));
  db.config.tickMs = 2000;
  // 造一份「旧粒度」K 线（没有 metadata），模拟改 tickMs 前攒下的数据
  const st = db.stocks.TGW;
  st.bars5 = [];
  for (let i = 0; i < 20; i++) st.bars5.push([i, 100 + i, 101 + i, 99 + i, 100.5 + i, 10]);
  delete st.bars5Ticks;
  delete st.bars15Ticks;
  db = quiet(() => migrate(db));
  const st2 = db.stocks.TGW;
  check('bars5Ticks = 150（2000ms）', Number(st2.bars5Ticks) === 150, String(st2.bars5Ticks));
  check('bars15Ticks = 450（2000ms）', Number(st2.bars15Ticks) === 450, String(st2.bars15Ticks));
  check('bars5 按新节奏重铺满 300 根', st2.bars5.length === 300, String(st2.bars5.length));
  check('series 重铺到 9000 tick（300 根 1m）', st2.series.length === 9000, String(st2.series.length));
  check('tickTimes 也补齐到 9000', db.tickTimes.length === 9000, String(db.tickTimes.length));
  check('tickTimes 相邻间隔 = tickMs（2000）',
    db.tickTimes.length > 10 && db.tickTimes[db.tickTimes.length - 1] - db.tickTimes[db.tickTimes.length - 2] === 2000,
    String(db.tickTimes[db.tickTimes.length - 1] - db.tickTimes[db.tickTimes.length - 2]));
  check('记录了 tickMsSeen', Number(db.tickMsSeen) === 2000, String(db.tickMsSeen));
  // 再迁移一次（tickMs 没变）：不能再重铺/清掉已有数据
  const before = db.stocks.TGW.series.length;
  db = quiet(() => migrate(db));
  check('tickMs 不变时不重置 K 线', db.stocks.TGW.series.length === before, String(db.stocks.TGW.series.length));
}

// ---------------------------------------------------------------- 7
log('');
log('=== 7 引擎：tickMs=2000 时 push 的桶号按 150 / 450 tick ===');
{
  let db = quiet(() => migrate(createDb()));
  Object.assign(db.config, {
    tickMs: 2000, baseVolatility: 0, meanReversion: 0, eventChance: 0,
    sentimentEnabled: 0, marketTradesEnabled: 0, hotMoneyEnabled: 0,
    playerImpactEnabled: 0, marketImpactEnabled: 0, majorNewsEnabled: 0,
    morningRallyEnabled: 0, marketCycleEnabled: 0
  });
  // 模拟「改 tickMs 后重启」：migrate 按新节奏重铺 9000 tick
  db = quiet(() => migrate(db));
  db.events = [];
  for (const s of Object.values(db.stocks)) {
    s.nextReportTick = 1e12;
    s.rallyHours = [];
  }
  const steps = 320;
  quiet(() => { for (let i = 0; i < steps; i++) stepMarket(db); });
  const st = db.stocks.TGW;
  check('引擎记录 bars5Ticks = 150', Number(st.bars5Ticks) === 150, String(st.bars5Ticks));
  check('引擎记录 bars15Ticks = 450', Number(st.bars15Ticks) === 450, String(st.bars15Ticks));
  const last5 = st.bars5[st.bars5.length - 1][0];
  check('bars5 最后一根桶号 = floor((tick-1)/150)',
    last5 === Math.floor((db.tick - 1) / 150), `${last5} vs ${Math.floor((db.tick - 1) / 150)}`);
  const last15 = st.bars15[st.bars15.length - 1][0];
  check('bars15 最后一根桶号 = floor((tick-1)/450)',
    last15 === Math.floor((db.tick - 1) / 450), `${last15} vs ${Math.floor((db.tick - 1) / 450)}`);
  check('引擎运行后 1m series 保持 9000（300 根）', st.series.length === 9000, String(st.series.length));
  check('bars5 保持 300 根种子 + 新桶',
    st.bars5.length >= 300 && st.bars5.length <= 305, String(st.bars5.length));
}

// ---------------------------------------------------------------- 8
log('');
log('=== 8 涨跌幅窗口：1m/5m/15m 用换算后的 tick 数 ===');
{
  const series = Array.from({ length: 500 }, (_, i) => 100 + i);   // 每 tick +1
  const tfs = timeframeTicks(2000);
  const chg = changesFor(series, tfs);
  const last = series[series.length - 1];
  const pct = (ticks) => ((last - series[series.length - 1 - ticks]) / series[series.length - 1 - ticks]) * 100;
  check('1m 涨跌幅用 30 tick', near(chg['1m'], pct(30), 1e-9), `${chg['1m']} vs ${pct(30)}`);
  check('5m 涨跌幅用 150 tick', near(chg['5m'], pct(150), 1e-9), `${chg['5m']} vs ${pct(150)}`);
  check('15m 涨跌幅用 450 tick', near(chg['15m'], pct(450), 1e-9), `${chg['15m']} vs ${pct(450)}`);
}

// ---------------------------------------------------------------- 9
log('');
log('=== 9 seedBars5 默认值兼容（tickMs=5000 仍是 60） ===');
{
  const bars = seedBars5([], 100, 600, 0.02);
  check('默认 seed 按 60 tick/根', bars.length === 300, String(bars.length));
  const lastTwo = bars.slice(-2);
  check('相邻两根 bucket 差 1', lastTwo[1][0] - lastTwo[0][0] === 1,
    `${lastTwo[0][0]},${lastTwo[1][0]}`);
  check('BAR5_TICKS / BAR15_TICKS 常量仍是 60 / 180',
    BAR5_TICKS === 60 && BAR15_TICKS === 180, `${BAR5_TICKS}/${BAR15_TICKS}`);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
