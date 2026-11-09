// 交易记录：48 小时窗口 + 翻页 + 标的筛选（后端纯函数验证）
//   node tests/trade-history.mjs

import { logTrade } from '../src/trading.js';
import { migrate, createDb } from '../src/store.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

const HOUR = 3600 * 1000;
const quiet = (fn) => {
  const real = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = real; }
};

function newDb(config = {}) {
  const db = quiet(() => migrate(createDb()));
  Object.assign(db.config, { marketCycleEnabled: 0, marketOpen: 1 }, config);
  db.tick = 1000;
  db.players = {
    p1: {
      id: 'p1', nickname: '甲', cash: 1e6, positions: {}, orders: [],
      tradeLog: [], themeTier: {}, achievements: {}, counters: {}
    },
    p2: {
      id: 'p2', nickname: '乙', cash: 1e6, positions: {}, orders: [],
      tradeLog: [], themeTier: {}, achievements: {}, counters: {}
    }
  };
  return db;
}

function trade(db, pid, o = {}) {
  quiet(() => logTrade(db, {
    playerId: pid,
    code: o.code || 'TGW',
    name: o.name || '丰川集团',
    action: o.action || 'open',
    side: o.side || 'long',
    qty: o.qty ?? 100,
    price: o.price ?? 100,
    leverage: 1,
    reason: o.reason || 'manual',
    pnl: o.pnl ?? 0,
    fee: 1,
    stamp: 0
  }));
  // logTrade 用的是 now()，测试里手动改时间
  const log2 = db.players[pid].tradeLog;
  const rec = log2[log2.length - 1];
  if (rec && o.at) rec.at = o.at;
  if (rec && o.code) rec.code = o.code;
  return rec;
}

// ---------------------------------------------------------------- 1
log('=== 1 个人流水只记自己的单 ===');
{
  const db = newDb();
  trade(db, 'p1', { code: 'TGW' });
  trade(db, 'p1', { code: 'MCD' });
  trade(db, 'p2', { code: 'TGW' });
  check('p1 两条', db.players.p1.tradeLog.length === 2, String(db.players.p1.tradeLog.length));
  check('p2 一条', db.players.p2.tradeLog.length === 1, String(db.players.p2.tradeLog.length));
  check('虚假成交不进个人流水', (() => {
    quiet(() => logTrade(db, { playerId: 'p1', code: 'TGW', action: 'open', side: 'long', qty: 1, price: 1, isMarket: true }));
    return db.players.p1.tradeLog.length === 2;
  })(), String(db.players.p1.tradeLog.length));
  check('流水只存前端要用的字段（不带 playerId）', db.players.p1.tradeLog[0].playerId === undefined);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 上限 300 条 ===');
{
  const db = newDb();
  for (let i = 0; i < 320; i += 1) trade(db, 'p1', { at: Date.now() - i * 1000 });
  check('最多留 300 条', db.players.p1.tradeLog.length === 300, String(db.players.p1.tradeLog.length));
  // 插进去的 at 是递减的（越晚插越旧），所以裁掉的是数组开头那 20 条
  const kept = db.players.p1.tradeLog;
  check('保留的是最近的那批（开头比结尾新）', kept[0].at > kept[kept.length - 1].at);
  check('最老的那批被裁掉（at 不超过 now-20000）', kept[0].at <= Date.now() - 19000);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 migrate 给老存档回填最近 48 小时 ===');
{
  const nowMs = Date.now();
  const old = quiet(() => migrate(createDb()));
  old.players = { p1: { id: 'p1', nickname: '甲', cash: 1e5, positions: {}, orders: [] } };
  old.trades = [
    { id: 't1', at: nowMs - 2 * HOUR, playerId: 'p1', code: 'TGW', action: 'open' },
    { id: 't2', at: nowMs - 47 * HOUR, playerId: 'p1', code: 'MCD', action: 'close' },
    { id: 't3', at: nowMs - 50 * HOUR, playerId: 'p1', code: 'TGW', action: 'open' },  // 超过 48h
    { id: 't4', at: nowMs - 1 * HOUR, playerId: 'p2', code: 'TGW', action: 'open' }    // 别人的
  ];
  const db = quiet(() => migrate(old));
  const got = db.players.p1.tradeLog;
  check('回填了 2 条（48 小时内、自己的）', got.length === 2, String(got.length));
  check('48 小时外的不回填', !got.some((t) => t.id === 't3'));
  check('别人的不回填', !got.some((t) => t.id === 't4'));
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 48 小时窗口（接口口径） ===');
{
  const db = newDb();
  const nowMs = Date.now();
  trade(db, 'p1', { at: nowMs - 1 * HOUR, code: 'TGW' });
  trade(db, 'p1', { at: nowMs - 47 * HOUR, code: 'TGW' });
  trade(db, 'p1', { at: nowMs - 49 * HOUR, code: 'TGW' });
  const cutoff = nowMs - 48 * HOUR;
  const inWindow = db.players.p1.tradeLog.filter((t) => t.at >= cutoff);
  check('48 小时内 2 条', inWindow.length === 2, String(inWindow.length));
  check('最老的被窗口排除', !inWindow.some((t) => t.at < cutoff));
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 筛选 + 翻页（和 api 里同一套算法） ===');
{
  const db = newDb();
  const nowMs = Date.now();
  for (let i = 0; i < 45; i += 1) {
    trade(db, 'p1', { at: nowMs - (i + 1) * 60 * 1000, code: i % 3 === 0 ? 'MCD' : 'TGW' });
  }
  const cutoff = nowMs - 48 * HOUR;
  const all = db.players.p1.tradeLog.filter((t) => t.at >= cutoff)
    .slice().sort((a, b) => b.at - a.at);
  check('共 45 笔', all.length === 45, String(all.length));
  check('最新在前', all[0].at > all[44].at);

  // 标的筛选
  const mcd = all.filter((t) => t.code === 'MCD');
  check('MCD 有 15 笔', mcd.length === 15, String(mcd.length));
  const tgw = all.filter((t) => t.code === 'TGW');
  check('TGW 有 30 笔', tgw.length === 30, String(tgw.length));

  // 翻页
  const pageSize = 20;
  const pages = Math.ceil(all.length / pageSize);
  check('45 笔 / 每页 20 = 3 页', pages === 3, String(pages));
  const p1 = all.slice(0, pageSize);
  const p3 = all.slice(2 * pageSize, 3 * pageSize);
  check('第 1 页 20 条', p1.length === 20, String(p1.length));
  check('第 3 页 5 条', p3.length === 5, String(p3.length));
  check('页与页不重叠', !p1.some((t) => p3.includes(t)));
  check('合起来正好 45 条', p1.length + pageSize + p3.length === 45);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
