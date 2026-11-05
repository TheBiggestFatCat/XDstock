// 15 分钟 K 线：收集、封顶、冷启动铺满、转成 K 线对象
//   node tests/candles15.mjs

import { pushBar15, seedBars15, seedVolFromConfig, bars15Candles, BAR15_TICKS, BAR15_MAX } from '../src/bars15.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

// ---------------------------------------------------------------- 1
log('=== 1 常量：15 分钟一根，48 小时 192 根 ===');
{
  check('一根 180 tick', BAR15_TICKS === 180);
  check('最多 192 根', BAR15_MAX === 192);
  check('180 tick × 5 秒 = 15 分钟', BAR15_TICKS * 5 === 900);
  check('192 根 × 15 分钟 = 48 小时', (BAR15_MAX * 15) / 60 === 48);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 同一根里更新 high / low / close ===');
{
  const list = [];
  pushBar15(list, 100, 10);
  check('第一笔：开高低收都是 10', JSON.stringify(list[0]) === '[100,10,10,10,10]', JSON.stringify(list[0]));
  pushBar15(list, 100, 12);
  check('涨到 12：high 更新', list[0][2] === 12, JSON.stringify(list[0]));
  check('close 跟着走', list[0][4] === 12);
  check('open 不动', list[0][1] === 10);
  pushBar15(list, 100, 8);
  check('跌到 8：low 更新', list[0][3] === 8, JSON.stringify(list[0]));
  check('仍然只有一根', list.length === 1);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 跨桶新开一根、封顶丢最老 ===');
{
  const list = [];
  pushBar15(list, 100, 10);
  pushBar15(list, 101, 11);
  check('跨桶后两根', list.length === 2);
  check('新一根从 11 起', JSON.stringify(list[1]) === '[101,11,11,11,11]', JSON.stringify(list[1]));

  check('乱序（老桶）直接忽略', (() => {
    const before = JSON.stringify(list);
    pushBar15(list, 99, 5);
    return JSON.stringify(list) === before;
  })());

  for (let i = 0; i < BAR15_MAX + 30; i++) pushBar15(list, 200 + i, 10 + i % 7);
  check('长度封顶在 192', list.length === BAR15_MAX, String(list.length));
  check('保留的是最新的', list[list.length - 1][0] === 200 + BAR15_MAX + 29, String(list[list.length - 1][0]));
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 脏数据不炸 ===');
{
  const list = [];
  check('非数组原样返回', pushBar15(null, 1, 10) === null);
  pushBar15(list, 1, NaN);
  pushBar15(list, 1, -5);
  pushBar15(list, NaN, 10);
  pushBar15(list, 1, 0);
  check('非法价格/桶都不写进去', list.length === 0, String(list.length));
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 冷启动铺满 48 小时，且尾部接上现价 ===');
{
  const list = seedBars15([], 3284.54, 12000, seedVolFromConfig({ baseVolatility: 0.01 }));
  check('铺满 192 根', list.length === BAR15_MAX, String(list.length));
  check('时间递增', list.every((b, i) => i === 0 || b[0] > list[i - 1][0]));
  check('桶号连续（每根差 1）', list.every((b, i) => i === 0 || b[0] - list[i - 1][0] === 1));
  check('最后一根收在现价', Math.abs(list[list.length - 1][4] - 3284.54) < 0.01,
    String(list[list.length - 1][4]));
  check('每根 high ≥ max(open,close)', list.every((b) => b[2] >= Math.max(b[1], b[4]) - 1e-9));
  check('每根 low ≤ min(open,close)', list.every((b) => b[3] <= Math.min(b[1], b[4]) + 1e-9));
  check('价格全为正', list.every((b) => b[1] > 0 && b[2] > 0 && b[3] > 0 && b[4] > 0));
  const tickNow = 12000;
  // 冷启动数据的波动要跟真盘面一个量级，否则最后一根真 K 线会像一根大阳线
  const bodies = list.map((b) => Math.abs(b[4] / b[1] - 1) * 100);
  const avgBody = bodies.reduce((a, b) => a + b, 0) / bodies.length;
  check('单根实体不是「一条直线」（均值 > 1.5%）', avgBody > 1.5, avgBody.toFixed(2) + '%');
  check('单根实体也没夸张到离谱（均值 < 15%）', avgBody < 15, avgBody.toFixed(2) + '%');
  const rangePct = (Math.max(...list.map((b) => b[2])) / Math.min(...list.map((b) => b[3])) - 1) * 100;
  check('48 小时振幅在 30%~250% 之间', rangePct > 30 && rangePct < 250, rangePct.toFixed(0) + '%');
  check('最后一根桶号 = floor(tick/180)',
    list[list.length - 1][0] === Math.floor(tickNow / BAR15_TICKS),
    `${list[list.length - 1][0]} vs ${Math.floor(tickNow / BAR15_TICKS)}`);
}

// ---------------------------------------------------------------- 5.5
log('');
log('=== 5.5 冷启动波动由 baseVolatility 推出来 ===');
{
  const v1 = seedVolFromConfig({ baseVolatility: 0.01 });
  const v2 = seedVolFromConfig({ baseVolatility: 0.02 });
  check('1%/tick → 单根 σ 约 10%', Math.abs(v1 - 0.101) < 0.02, (v1 * 100).toFixed(1) + '%');
  check('波动翻倍，种子也翻倍', v2 > v1 * 1.8, (v2 * 100).toFixed(1) + '%');
  check('空配置用默认值不炸', seedVolFromConfig(null) > 0.01);
  check('极端配置被夹住', seedVolFromConfig({ baseVolatility: 1 }) <= 0.2);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 转成 K 线对象 ===');
{
  const list = [[10, 100, 105, 98, 103], [11, 103, 104, 99, 99.5]];
  const candles = bars15Candles(list, (absTick) => absTick * 5000);
  check('条数对', candles.length === 2);
  check('time 是秒（毫秒/1000）', candles[0].time === Math.floor(10 * BAR15_TICKS * 5000 / 1000),
    String(candles[0].time));
  check('o/h/l/c 保留 4 位', JSON.stringify(candles[0]) === '{"time":9000,"open":100,"high":105,"low":98,"close":103}',
    JSON.stringify(candles[0]));
  check('时间递增', candles[1].time > candles[0].time);
  check('空数组不炸', bars15Candles(null).length === 0 && bars15Candles([]).length === 0);
  check('坏行被跳过', bars15Candles([[1, 1, 1], [2, 0, 1, 1, 1]]).length === 0);
  check('high/low 会按 o/c 兜底',
    bars15Candles([[1, 10, 10, 10, 20]], () => 0)[0].high === 20);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
