// 站内通知：推送 / 上限 / 未读 / 已读
//   node tests/notify.mjs

import { pushNotify, notifyList, markNotifyRead, unreadCount, NOTIFY_MAX } from '../src/notify.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

const db = { tick: 1000 };

// ---------------------------------------------------------------- 1
log('=== 1 推一条：结构对、默认未读 ===');
{
  const p = {};
  const n = pushNotify(p, db, { kind: 'tpsl', code: 'XJ', text: '弦卷财团 止盈触发 · 现价 263.50，已自动挂出平仓单' });
  check('返回了这条通知', !!n && !!n.id);
  check('存进 player.notices', p.notices.length === 1);
  check('kind 正确', p.notices[0].kind === 'tpsl');
  check('code 正确', p.notices[0].code === 'XJ');
  check('带 tick', p.notices[0].tick === 1000);
  check('带时间戳', Number(p.notices[0].at) > 0);
  check('默认未读', p.notices[0].read === false);
  check('未读数 = 1', unreadCount(p) === 1);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 空内容不推，超长截断 ===');
{
  const p = {};
  check('空字符串不推', pushNotify(p, db, { text: '   ' }) === null);
  check('没有 player 不崩', pushNotify(null, db, { text: 'x' }) === null);
  check('空内容没写进去', !p.notices);
  const long = 'x'.repeat(500);
  pushNotify(p, db, { text: long });
  check('超长截到 160 字', p.notices[0].text.length === 160, String(p.notices[0].text.length));
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 上限：只留最近 NOTIFY_MAX 条 ===');
{
  const p = {};
  for (let i = 0; i < NOTIFY_MAX + 12; i++) {
    pushNotify(p, db, { kind: 'tpslFill', text: '第 ' + i + ' 条' });
  }
  check('长度被夹住', p.notices.length === NOTIFY_MAX, String(p.notices.length));
  check('留下的是最新的', p.notices[p.notices.length - 1].text === '第 ' + (NOTIFY_MAX + 11) + ' 条');
  check('最老的被丢掉', !p.notices.some((x) => x.text === '第 0 条'));
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 下发给前端：最新在前、字段齐 ===');
{
  const p = {};
  pushNotify(p, db, { kind: 'a', text: '旧' });
  pushNotify(p, db, { kind: 'b', text: '新' });
  const list = notifyList(p, 20);
  check('倒序（最新在前）', list[0].text === '新' && list[1].text === '旧');
  check('字段齐全', ['id', 'tick', 'at', 'kind', 'text', 'code', 'read'].every((k) => k in list[0]));
  check('空 player 返回空数组', notifyList({}, 20).length === 0);
  check('null 也不炸', notifyList(null, 20).length === 0);
  const only = notifyList(p, 1);
  check('limit 生效', only.length === 1 && only[0].text === '新');
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 标已读：单条 / 全部 / 重复调用 ===');
{
  const p = {};
  const a = pushNotify(p, db, { text: 'A' });
  const b = pushNotify(p, db, { text: 'B' });
  pushNotify(p, db, { text: 'C' });
  check('初始未读 3', unreadCount(p) === 3);
  check('标 1 条返回 1', markNotifyRead(p, [a.id]) === 1);
  check('未读变 2', unreadCount(p) === 2);
  check('重复标同一条返回 0', markNotifyRead(p, [a.id]) === 0);
  check('标全部返回 2', markNotifyRead(p, null) === 2);
  check('全部已读', unreadCount(p) === 0);
  check('再标全部还是 0', markNotifyRead(p, null) === 0);
  check('不存在的 id 不报错', markNotifyRead(p, ['nope']) === 0);
  const c = pushNotify(p, db, { text: 'D' });
  check('新通知仍是未读', c.read === false && unreadCount(p) === 1);
  void b;
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 坏数据不会炸 ===');
{
  const p = { notices: 'not-an-array' };
  check('notices 不是数组时未读算 0', unreadCount(p) === 0);
  pushNotify(p, db, { text: '修复' });
  check('push 会把它纠正成数组', Array.isArray(p.notices) && p.notices.length === 1);
  check('markNotifyRead 对坏数据返回 0', markNotifyRead({ notices: 'x' }, null) === 0);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
