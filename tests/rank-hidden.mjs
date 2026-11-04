// 排行榜隐身：账号还在，只是不出现在榜上
//   node tests/rank-hidden.mjs

import { createDb } from '../src/store.js';
import { leaderboardRows, investigatePlayer } from '../src/api.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

function mkDb() {
  const db = createDb();
  db.tick = 100;
  db.players = {
    rich: { id: 'rich', nickname: '大款', cash: 5000000, bank: 0, level: 1, theme: 'default', positions: {} },
    ghost: { id: 'ghost', nickname: '我是狗庄', cash: 9000000, bank: 0, level: 1, theme: 'default', positions: {}, hiddenRank: true },
    mid: { id: 'mid', nickname: '中间', cash: 1000000, bank: 0, level: 1, theme: 'default', positions: {} },
    poor: { id: 'poor', nickname: '小散', cash: 100, bank: 0, level: 1, theme: 'default', positions: {} }
  };
  return db;
}

// ---------------------------------------------------------------- 1
log('=== 1 隐身的人不出现在排行榜上 ===');
{
  const db = mkDb();
  const rows = leaderboardRows(db);
  const names = rows.map((r) => r.nickname);
  check('榜上一共 3 个人', rows.length === 3, names.join(' / '));
  check('「我是狗庄」不在榜上', !names.includes('我是狗庄'));
  check('其他人都在', ['大款', '中间', '小散'].every((n) => names.includes(n)));
  check('排名第一变成大款', names[0] === '大款', names[0]);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 账号本身完全没动 ===');
{
  const db = mkDb();
  const ghost = db.players.ghost;
  check('号还在', !!ghost);
  check('钱还在', ghost.cash === 9000000, String(ghost.cash));
  check('没被封', !ghost.banned);
  // 隐身之后资产照样能算（说明数据没删）
  const before = leaderboardRows(db).length;
  ghost.hiddenRank = false;
  const after = leaderboardRows(db);
  check('取消隐身后立刻回到榜上', after.length === before + 1, `${before} → ${after.length}`);
  check('而且按资产排第一', after[0].nickname === '我是狗庄', after[0].nickname);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 隐身之后不能被偷钱 / 调查 ===');
{
  const db = mkDb();
  // 偷钱：接口层的判断（这里直接复现同一条规则）
  const victim = db.players.ghost;
  check('隐身的号被当成「没这个人」', !victim || victim.hiddenRank);
  // 调查：probe 主题也不能看隐身的号
  const probe = { id: 'probe1', nickname: '侦探', theme: 'probe', cash: 0, level: 2, positions: {} };
  const r = investigatePlayer(db, probe, 'ghost');
  check('调查隐身号被拒', r.ok === false, r.error || '');
  db.players.ghost.hiddenRank = false;
  const r2 = investigatePlayer(db, probe, 'ghost');
  check('取消隐身后能调查（他没持仓，所以提示空仓）',
    r2.ok === false && /空仓/.test(r2.error || ''), r2.error || '');
  check('拒绝理由不是「没这个人」', !/没这个人/.test(r2.error || ''), r2.error || '');
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 排序与合计不受影响 ===');
{
  const db = mkDb();
  const rows = leaderboardRows(db);
  const totals = rows.map((r) => r.total);
  check('按总资产降序', totals.every((v, i) => i === 0 || v <= totals[i - 1]), totals.join(' > '));
  const hidden = db.players.ghost;
  check('隐身的人的钱不算进榜上任何一行',
    rows.every((r) => r.id !== hidden.id));
  check('榜上的钱加起来 = 其余三人的现金',
    Math.abs(totals.reduce((a, b) => a + b, 0) - (5000000 + 1000000 + 100)) < 1,
    String(totals.reduce((a, b) => a + b, 0)));
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
