// 暗中调查（Lv.2 主题技能）回归
//
//   node tests/investigate.mjs
//
// 只 import src/*，不读写 data/db.json。

import { createDb } from '../src/store.js';
import { investigatePlayer } from '../src/api.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

function newDb(cd) {
  const db = createDb();
  db.tick = 1000;
  // 测试里固定成 30 轮；也可以传别的值验证读配置
  db.config.investigateCooldownTicks = cd === undefined ? 30 : cd;
  for (const st of Object.values(db.stocks)) st.price = 100;
  return db;
}

function mkPlayer(id, extra = {}) {
  return {
    id,
    nickname: id,
    cash: 100000,
    positions: {},
    orders: [],
    theme: 'default',
  skill: 'default',
    level: 1,
    ...extra
  };
}

function mkPos(code, side, qty) {
  return {
    code,
    side,
    qty,
    entry: 100,
    margin: qty * 100,
    leverage: 1,
    openedTick: 950
  };
}

// ---------------------------------------------------------------- 1
log('=== 1 前置条件 ===');
{
  const db = newDb();
  const me = mkPlayer('me', { theme: 'default' });
  const target = mkPlayer('t1', { positions: { TGW: mkPos('TGW', 'long', 100) } });
  db.players = { me, t1: target };

  const r1 = investigatePlayer(db, me, 't1');
  check('没装备主题 → 403', !r1.ok && r1.status === 403, r1.error || '');

  me.theme = 'probe';
  me.skill = 'probe';
  const r2 = investigatePlayer(db, me, 'me');
  check('调查自己 → 400', !r2.ok && r2.status === 400, r2.error || '');

  const r3 = investigatePlayer(db, me, 'nobody');
  check('目标不存在 → 404', !r3.ok && r3.status === 404, r3.error || '');

  const empty = mkPlayer('t2');
  db.players.t2 = empty;
  const r4 = investigatePlayer(db, me, 't2');
  check('目标空仓 → 400', !r4.ok && r4.status === 400, r4.error || '');
  check('空手而归不消耗冷却', !me.investigateReadyAt, `readyAt=${me.investigateReadyAt}`);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 正常调查 ===');
{
  const db = newDb();
  const me = mkPlayer('me', { theme: 'probe', skill: 'probe', level: 2 });
  const target = mkPlayer('t1', {
    positions: {
      TGW: mkPos('TGW', 'long', 100),
      LU: mkPos('LU', 'short', 50)
    }
  });
  db.players = { me, t1: target };

  const r = investigatePlayer(db, me, 't1');
  check('调查成功', r.ok, r.error || '');
  check('只能看到 1 个持仓（不是全部）', !!r.position && !r.positions, JSON.stringify(r.position));
  check('拿到的确实是目标的持仓', ['TGW', 'LU'].includes(r.position.code), `code=${r.position.code}`);
  check('字段齐全', ['code', 'name', 'side', 'qty', 'entry', 'price', 'leverage', 'margin', 'pnl', 'pnlPct', 'heldTicks']
    .every((k) => r.position[k] !== undefined), Object.keys(r.position).join(','));
  check('方向原样返回', ['long', 'short'].includes(r.position.side), r.position.side);
  check('持有轮数 = 当前 tick - 开仓 tick', r.position.heldTicks === 50, `heldTicks=${r.position.heldTicks}`);
  check('冷却写回玩家', r.readyAt === 1030 && me.investigateReadyAt === 1030, `readyAt=${r.readyAt}`);
  check('返回冷却轮数', r.cooldownTicks === 30);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 冷却 ===');
{
  const db = newDb();
  const me = mkPlayer('me', { theme: 'probe', skill: 'probe' });
  const target = mkPlayer('t1', { positions: { TGW: mkPos('TGW', 'long', 100) } });
  db.players = { me, t1: target };

  const first = investigatePlayer(db, me, 't1');
  check('第一次成功', first.ok);

  const blocked = investigatePlayer(db, me, 't1');
  check('立刻再查 → 429', !blocked.ok && blocked.status === 429, blocked.error || '');
  check('返回剩余冷却', blocked.leftTicks === 30, `leftTicks=${blocked.leftTicks}`);

  db.tick = 1029;
  check('第 29 轮还在冷却', !investigatePlayer(db, me, 't1').ok);
  db.tick = 1030;
  check('第 30 轮冷却结束', investigatePlayer(db, me, 't1').ok);
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 冷却轮数读配置，缺省 30 ===');
{
  const db = newDb(5);
  const me = mkPlayer('me', { theme: 'probe', skill: 'probe' });
  db.players = { me, t1: mkPlayer('t1', { positions: { TGW: mkPos('TGW', 'long', 10) } }) };
  const r = investigatePlayer(db, me, 't1');
  check('配置 5 轮 → readyAt = 1005', r.readyAt === 1005, `readyAt=${r.readyAt}`);

  const db2 = createDb();
  db2.tick = 500;
  delete db2.config.investigateCooldownTicks;
  const me2 = mkPlayer('me2', { theme: 'probe', skill: 'probe' });
  db2.players = { me2, t9: mkPlayer('t9', { positions: { LU: mkPos('LU', 'long', 10) } }) };
  const r2 = investigatePlayer(db2, me2, 't9');
  check('没配 → 默认 30 轮', r2.readyAt === 530, `readyAt=${r2.readyAt}`);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 多次调查能覆盖到不同持仓 ===');
{
  const db = newDb(0);   // 冷却 0，方便连查
  const me = mkPlayer('me', { theme: 'probe', skill: 'probe' });
  const target = mkPlayer('t1', {
    positions: { TGW: mkPos('TGW', 'long', 1), LU: mkPos('LU', 'long', 1), NW: mkPos('NW', 'long', 1) }
  });
  db.players = { me, t1: target };
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const r = investigatePlayer(db, me, 't1');
    if (r.ok) seen.add(r.position.code);
  }
  check('60 次抽样能覆盖全部 3 个持仓', seen.size === 3, [...seen].join(','));
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
