// 5 分钟 K 线单独打包（2026-11）
//   node tests/candles5.mjs
//
// 背景：series 只留 3600 个 tick（5 小时），5 分钟一根要 60 tick，
// 从 series 里最多凑 60 根；而 1 分钟图有 300 根。
// 现在 5 分钟单独存 300 根（25 小时），和 1 分钟一样多。

import { pushBar5, seedBars5, seedVolFromConfig, bars5Candles, BAR5_TICKS, BAR5_MAX, BAR5_SEED_VER } from '../src/bars15.js';
import { createDb, migrate } from '../src/store.js';
import { stepMarket } from '../src/engine.js';

let fails = 0;
let passes = 0;
const out = [];
const realLog = console.log;
console.log = () => {};
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

// ================================================================ 1
log('=== 1 常量：一根 60 tick、最多 300 根 ===');
{
  check('BAR5_TICKS = 60（5 分钟）', BAR5_TICKS === 60, String(BAR5_TICKS));
  check('BAR5_MAX = 300 根（25 小时）', BAR5_MAX === 300, String(BAR5_MAX));
  check('300 根 × 60 tick / 12 tick 每轮 = 和 1 分钟的 300 根等价',
    (BAR5_MAX * BAR5_TICKS) / 12 === 1500, String((BAR5_MAX * BAR5_TICKS) / 12));
  check('有冷启动版本号', Number(BAR5_SEED_VER) >= 1, String(BAR5_SEED_VER));
}

// ================================================================ 2
log('');
log('=== 2 同一根里累加、跨桶新开 ===');
{
  const list = [];
  pushBar5(list, 100, 10, 500);
  pushBar5(list, 100, 12, 300);
  check('同一根：high 更新 + 成交量累加', list[0][2] === 12 && list[0][5] === 800, JSON.stringify(list[0]));
  pushBar5(list, 100, 8);
  check('同一根：low 更新', list[0][3] === 8 && list[0][4] === 8);
  pushBar5(list, 101, 11, 200);
  check('跨桶新开一根', list.length === 2 && list[1][0] === 101, JSON.stringify(list[1]));
  check('乱序忽略', (() => {
    const before = JSON.stringify(list);
    pushBar5(list, 99, 5);
    return JSON.stringify(list) === before;
  })());
}

// ================================================================ 3
log('');
log('=== 3 封顶 300 根 ===');
{
  const list = [];
  for (let i = 0; i < BAR5_MAX + 40; i++) pushBar5(list, 1000 + i, 10 + (i % 5));
  check('长度封顶在 300', list.length === BAR5_MAX, String(list.length));
  check('保留的是最新的', list[list.length - 1][0] === 1000 + BAR5_MAX + 39, String(list[list.length - 1][0]));
}

// ================================================================ 4
log('');
log('=== 4 冷启动铺 300 根、尾部接现价 ===');
{
  const list = seedBars5([], 250, 6000, seedVolFromConfig({ baseVolatility: 0.01 }, BAR5_TICKS));
  check('铺满 300 根', list.length === BAR5_MAX, String(list.length));
  check('时间正序', list.every((b, i) => i === 0 || b[0] > list[i - 1][0]));
  check('尾部收盘价接上现价', Math.abs(list[list.length - 1][4] - 250) < 1e-6, String(list[list.length - 1][4]));
  check('每根都有 OHLC', list.every((b) => b[1] > 0 && b[2] >= b[1] && b[3] <= b[1]));
  check('bucket 按 60 tick 一分', list[1][0] - list[0][0] === 1);
}

// ================================================================ 5
log('');
log('=== 5 转成 K 线对象（时间 / 成交量）===');
{
  const list = [];
  pushBar5(list, 100, 10, 500);
  pushBar5(list, 101, 11, 200);
  const candles = bars5Candles(list, (absTick) => absTick * 5000);
  check('根数对', candles.length === 2);
  check('时间 = bucket × 60 × tickMs / 1000', candles[0].time === Math.floor((100 * BAR5_TICKS * 5000) / 1000), String(candles[0].time));
  check('带成交量', candles[0].volume === 500 && candles[1].volume === 200, JSON.stringify(candles.map((c) => c.volume)));
  check('空数组不炸', bars5Candles(null).length === 0 && bars5Candles([]).length === 0);
}

// ================================================================ 6
log('');
log('=== 6 跑几轮引擎：bars5 真的在长，且和 series 解耦 ===');
{
  const db = migrate(createDb());
  Object.assign(db.config, {
    baseVolatility: 0.01, marketTradesEnabled: 1, marketTradesRate: 20,
    hotMoneyEnabled: 1, marketCycleEnabled: 0, marketOpen: 1, morningRallyEnabled: 0
  });
  db.players = {};
  for (let i = 0; i < 12; i++) stepMarket(db);
  const st = db.stocks.TGW;
  check('个股 bars5 有 300 根（冷启动铺满）', st.bars5.length === BAR5_MAX, String(st.bars5.length));
  check('指数 bars5 也有', db.stocks.DENG.bars5.length === BAR5_MAX && db.stocks.DENGS.bars5.length === BAR5_MAX);
  const last = st.bars5[st.bars5.length - 1];
  check('最后一根就是当前这一桶', last[0] === Math.floor(db.tick / BAR5_TICKS), `${last[0]} vs ${Math.floor(db.tick / BAR5_TICKS)}`);
  check('成交量累加进去了（> 0）', Number(last[5]) > 0, String(last[5]));
  // 5 分钟根数应远多于 series 直接算出来的
  const fromSeries = Math.floor(st.series.length / BAR5_TICKS);
  check('bars5 根数 > 用 series 现算的根数', st.bars5.length > fromSeries,
    `${st.bars5.length} vs ${fromSeries}`);
}

console.log = realLog;
console.log(out.join('\n'));
console.log('');
console.log(fails ? `---- ${passes} 通过 / ${fails} 失败 ----` : `---- ${passes} 通过 / 0 失败 ----`);
process.exit(fails ? 1 : 0);
