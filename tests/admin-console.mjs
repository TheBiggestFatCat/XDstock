// 管理控制台数据：consoleRows（真人成交筛选 / 增量 / 汇总）
//   node tests/admin-console.mjs

import { consoleRows } from '../src/api.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

const NOW = Date.now();
const t = (id, patch) => ({
  id, at: NOW, playerId: 'p1', nickname: '人', code: 'TGW', name: '丰川集团',
  action: 'open', side: 'long', qty: 100, price: 50, leverage: 2, ...patch
});

// 真实数据是 push 进来的，所以这里也按时间正序
const db = {
  trades: [
    t('a', { at: NOW - 3 * 3600 * 1000 }),                 // 3 小时前，不算进「近 1 小时」
    t('b', { at: NOW - 60 * 1000 }),
    t('c', { at: NOW - 30 * 1000, playerId: 'p2', nickname: '乙', action: 'close', reason: 'tp' }),
    t('d', { at: NOW - 20 * 1000, action: 'dividend', qty: 0, price: 0.5, amount: 50 }),
    t('e', { at: NOW - 10 * 1000, action: 'steal', code: '', name: '偷了丙', qty: 0, price: 0, amount: 300 }),
    { id: 'm1', at: NOW, isMarket: true, code: 'TGW', qty: 10, price: 50 }   // 噪声成交
  ]
};

// ---------------------------------------------------------------- 1
log('=== 1 过滤：只要真人、只要开平仓 ===');
{
  const d = consoleRows(db, { limit: 50, onlyTrade: true });
  check('噪声成交被过滤', !d.rows.some((r) => r.id === 'm1'));
  check('分红被过滤（onlyTrade）', !d.rows.some((r) => r.id === 'd'));
  check('偷钱被过滤（onlyTrade）', !d.rows.some((r) => r.id === 'e'));
  check('开仓平仓都在', d.rows.some((r) => r.id === 'b') && d.rows.some((r) => r.id === 'c'));
  check('最新在前', d.rows[0].id === 'c', d.rows.map((r) => r.id).join(','));
  const all = consoleRows(db, { limit: 50, onlyTrade: false });
  check('关掉过滤后能看到分红/偷钱', all.rows.some((r) => r.id === 'd') && all.rows.some((r) => r.id === 'e'));
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 字段：股数 / 价格 / 金额 / 杠杆 / 方向 ===');
{
  const r = consoleRows(db, { onlyTrade: true }).rows.find((x) => x.id === 'b');
  check('股数', r.qty === 100);
  check('价格', r.price === 50);
  check('金额 = 股 × 价', r.amount === 5000, String(r.amount));
  check('杠杆', r.leverage === 2);
  check('方向', r.side === 'long');
  check('玩家昵称', r.nickname === '人');
  check('标的名称', r.name === '丰川集团' && r.code === 'TGW');
  const div = consoleRows(db, { onlyTrade: false }).rows.find((x) => x.id === 'd');
  check('分红用 amount 字段而不是 qty×price', div.amount === 50, String(div.amount));
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 增量：afterId 只拿新的 ===');
{
  const first = consoleRows(db, { limit: 2, onlyTrade: true });
  check('limit 生效', first.rows.length === 2, String(first.rows.length));
  check('latestId 是最新那条', first.latestId === 'c', first.latestId);
  const inc = consoleRows(db, { afterId: 'b', onlyTrade: true });
  check('afterId=b 只返回 c', inc.rows.length === 1 && inc.rows[0].id === 'c',
    inc.rows.map((r) => r.id).join(','));
  const none = consoleRows(db, { afterId: 'c', onlyTrade: true });
  check('afterId=最新 → 空', none.rows.length === 0);
  const miss = consoleRows(db, { afterId: '不存在的 id', onlyTrade: true });
  check('afterId 找不到 → 退回最近一批', miss.rows.length > 0);
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 汇总：近 1 小时笔数与人数 ===');
{
  const d = consoleRows(db, { limit: 50, onlyTrade: true });
  check('近 1 小时 2 笔（b、c）', d.hourCount === 2, String(d.hourCount));
  check('参与 2 个玩家', d.hourPlayers === 2, String(d.hourPlayers));
  check('累计真人开/平仓 3 笔', d.total === 3, String(d.total));
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 脏数据 ===');
{
  check('空 db 不炸', consoleRows({}, {}).rows.length === 0);
  check('null 不炸', consoleRows(null, {}).rows.length === 0);
  const weird = { trades: [null, 5, { id: 'x' }, t('y')] };
  const d = consoleRows(weird, {});
  check('没有 playerId 的被丢掉', d.rows.length === 1 && d.rows[0].id === 'y');
  check('limit 被夹在 1~300', consoleRows(db, { limit: 9999 }).rows.length <= 300);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
