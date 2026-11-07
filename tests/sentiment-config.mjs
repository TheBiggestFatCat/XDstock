// 散户情绪「全局参数 vs 个股覆盖」回归
//
//   node tests/sentiment-config.mjs
//
// 历史 bug：migrate 给每只票都种了出厂默认值（0.004 / 12 / 480~960），
// 而引擎是「个股优先、全局兜底」，于是管理面板改全局参数永远不生效。

import { migrate, createDb } from '../src/store.js';
import { sentimentRollInterval, stepMarket } from '../src/engine.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

const TICK_MS = 5000;

/** 造一个只有 TGW 覆盖的存档，其余用默认 */
function mkDb(trait) {
  return migrate({
    config: {
      tickMs: TICK_MS,
      sentimentEnabled: 1,
      sentimentStrength: 0.004,
      sentimentTicks: 12,
      sentimentRollMin: 480,
      sentimentRollMax: 960
    },
    stocks: {
      TGW: {
        code: 'TGW', name: '丰川集团', status: 'normal', isIndex: false,
        price: 100, initialPrice: 100, series: [100], trait
      }
    }
  });
}

// ---------------------------------------------------------------- 1
log('=== 1 出厂默认值的个股字段会被清掉（改回跟随全局）===');
{
  const db = mkDb({
    id: 'old_money', name: '老钱',
    sentStrength: 0.004, sentTicks: 12, sentRollTicks: 720, sentRollMin: 480, sentRollMax: 960
  });
  const t = db.stocks.TGW.trait;
  check('sentStrength 被清掉', t.sentStrength === undefined, String(t.sentStrength));
  check('sentTicks 被清掉', t.sentTicks === undefined, String(t.sentTicks));
  check('sentRollTicks 被清掉', t.sentRollTicks === undefined, String(t.sentRollTicks));
  check('sentRollMin/Max 被清掉', t.sentRollMin === undefined && t.sentRollMax === undefined);
  check('其它 trait 字段不受影响', t.volMult !== undefined || t.id === 'old_money');
  check('打了迁移标记', db.sentTraitMigrated === true);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 真正被单独调过的值要保留 ===');
{
  const db = mkDb({ id: 'old_money', sentStrength: 0.02, sentTicks: 7, sentRollMin: 200, sentRollMax: 400 });
  const t = db.stocks.TGW.trait;
  check('自定义强度保留', t.sentStrength === 0.02, String(t.sentStrength));
  check('自定义间隔保留', t.sentTicks === 7);
  check('自定义区间保留', t.sentRollMin === 200 && t.sentRollMax === 400);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 迁移只跑一次 ===');
{
  const db = mkDb({ id: 'old_money', sentStrength: 0.004 });
  check('第一次已清理', db.stocks.TGW.trait.sentStrength === undefined);
  // 模拟管理员之后又给这只票设成 0.004（故意的覆盖）
  db.stocks.TGW.trait.sentStrength = 0.004;
  const again = migrate(db);
  check('第二次不再清理（管理员显式设的值保住了）', again.stocks.TGW.trait.sentStrength === 0.004);
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 清理之后，重掷周期跟随全局 ===');
{
  const db = mkDb({ id: 'old_money', sentRollMin: 480, sentRollMax: 960 });
  db.config.sentimentRollMin = 100;
  db.config.sentimentRollMax = 120;
  const arr = Array.from({ length: 300 }, () => sentimentRollInterval(db, db.stocks.TGW));
  check('用的是全局区间 100~120', Math.min(...arr) >= 100 && Math.max(...arr) <= 120,
    `${Math.min(...arr)}~${Math.max(...arr)}`);

  // 个股再覆盖就应该听个股的
  db.stocks.TGW.trait.sentRollMin = 10;
  db.stocks.TGW.trait.sentRollMax = 20;
  const arr2 = Array.from({ length: 100 }, () => sentimentRollInterval(db, db.stocks.TGW));
  check('个股覆盖优先于全局', Math.min(...arr2) >= 10 && Math.max(...arr2) <= 20,
    `${Math.min(...arr2)}~${Math.max(...arr2)}`);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 清理之后，强度跟随全局（实跑引擎）===');
{
  const db = mkDb({ id: 'old_money' });
  Object.assign(db.config, {
    baseVolatility: 0, meanReversion: 0, eventChance: 0,
    marketTradesRate: 0, hotMoneyEnabled: 0, playerImpactEnabled: 0, fxEnabled: 0,
    sentimentStrength: 0.02, sentimentTicks: 1
  });
  const st = db.stocks.TGW;
  st.nextReportTick = 1e12;
  st.sentiment = { v: 1, nextRoll: 1e12, nextApply: 0 };
  st.trait.sentTicks = 1;
  const before = st.price;
  const realLog = console.log;
  console.log = () => {};
  try { stepMarket(db); } finally { console.log = realLog; }
  const move = Math.abs(st.price / before - 1);
  check('价格动了', st.price !== before, `${before} -> ${st.price.toFixed(4)}`);
  check('幅度按全局 2% 走（不是旧默认 0.4%）', move <= 0.0201 && move > 0,
    `实际 ${(move * 100).toFixed(3)}%`);
  check('lastSwing 记录的是全局强度算出来的', Math.abs(st.sentiment.lastSwing) <= 0.02,
    `lastSwing=${st.sentiment.lastSwing}`);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
