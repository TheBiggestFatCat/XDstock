// 聊天大厅：拆分算法 / 500 条上限 / 抢红包规则（纯函数）
//   node tests/chat.mjs

import {
  ensureChat, pushChat, chatRows, splitPacket, createPacket, grabPacket, packetView,
  CHAT_MAX, CHAT_TEXT_MAX
} from '../src/chat.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

const mkPlayer = (id, nick = id, extra = {}) => ({ id, nickname: nick, level: 3, cash: 1e6, ...extra });
const db0 = () => ({ tick: 100, players: {}, redPackets: {} });

// ---------------------------------------------------------------- 1
log('=== 1 结构初始化 ===');
{
  const db = db0();
  ensureChat(db);
  check('没有 chat 时补上 messages', Array.isArray(db.chat.messages));
  check('seq 从 0 开始', db.chat.seq === 0);
  const db2 = { chat: { messages: [{ seq: 7, at: 1, type: 'text', text: 'x' }] } };
  ensureChat(db2);
  check('seq 缺失时按最后一条推回来', db2.chat.seq === 7, String(db2.chat.seq));
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 发消息 / 500 条上限 ===');
{
  const db = db0();
  const p = mkPlayer('p1');
  for (let i = 0; i < CHAT_MAX + 30; i += 1) pushChat(db, p, { type: 'text', text: 'm' + i });
  check('只保留 500 条', db.chat.messages.length === CHAT_MAX, String(db.chat.messages.length));
  check('seq 一直递增', db.chat.seq === CHAT_MAX + 30, String(db.chat.seq));
  const last = db.chat.messages[db.chat.messages.length - 1];
  check('最后一条是最新的', last.text === 'm' + (CHAT_MAX + 29), last.text);
  check('消息带昵称/等级/时间', !!last.nick && !!last.lv && !!last.at);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 增量拉取 after / 首次拉最近 N 条 ===');
{
  const db = db0();
  const p = mkPlayer('p1');
  for (let i = 0; i < 20; i += 1) pushChat(db, p, { type: 'text', text: 'x' + i });
  const all = chatRows(db, { limit: 10 });
  check('不给 after 时给最近 10 条', all.rows.length === 10, String(all.rows.length));
  check('最新一条在最前还是在后？（按 seq 升序，新在后）', all.rows[all.rows.length - 1].text === 'x19');
  const mid = chatRows(db, { afterSeq: 10, limit: 100 });
  check('after=10 只给 11~20', mid.rows.length === 10, String(mid.rows.length));
  check('after 拉到的第一条是 seq11', mid.rows[0].seq === 11, String(mid.rows[0].seq));
  const none = chatRows(db, { afterSeq: 20 });
  check('没有新消息时为空', none.rows.length === 0);
  check('返回 seq 游标', none.seq === 20, String(none.seq));
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 拼手气拆分 ===');
{
  const parts = splitPacket(1000, 5, () => 0.5);
  check('份数对', parts.length === 5, String(parts.length));
  check('合计 = 总额', parts.reduce((a, b) => a + b, 0) === 1000, String(parts.reduce((a, b) => a + b, 0)));
  check('每份 ≥ 1', parts.every((v) => v >= 1));

  // 极端：1 元 1 份；总额 = 份数
  check('1 份 = 全额', JSON.stringify(splitPacket(500, 1)) === '[500]');
  const even = splitPacket(5, 5, () => 0.999);
  check('每份最少 1（总额=份数）', even.every((v) => v >= 1) && even.reduce((a, b) => a + b, 0) === 5, JSON.stringify(even));

  // 随机性：多次拆分不会全都一样
  const set = new Set();
  for (let i = 0; i < 20; i += 1) set.add(JSON.stringify(splitPacket(1000, 5).slice().sort((a, b) => a - b)));
  check('确实是随机的（20 次至少 10 种结果）', set.size >= 10, String(set.size));
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 抢红包规则 ===');
{
  const db = db0();
  const owner = mkPlayer('owner', '发红包的');
  const a = mkPlayer('a', '甲');
  const b = mkPlayer('b', '乙');
  const pk = createPacket(db, owner, 1000, 3);

  check('创建后 money 不在这里扣（由 api 扣）', pk.amount === 1000);
  check('3 份', pk.parts.length === 3, String(pk.parts.length));

  const r0 = grabPacket(pk, owner);
  check('不能抢自己的', r0.ok === false && /自己/.test(r0.error), r0.error);

  const r1 = grabPacket(pk, a);
  check('别人能抢到', r1.ok === true, r1.error);
  check('抢到的金额 > 0', r1.amount >= 1, String(r1.amount));
  const r1b = grabPacket(pk, a);
  check('同一个红包只能抢一次', r1b.ok === false && /抢过/.test(r1b.error), r1b.error);

  const r2 = grabPacket(pk, b);
  check('第二个人也能抢', r2.ok === true, r2.error);
  const r3 = grabPacket(pk, mkPlayer('c', '丙'));
  check('第三份还能抢', r3.ok === true, r3.error);
  const r4 = grabPacket(pk, mkPlayer('d', '丁'));
  check('抢光后再抢提示抢光了', r4.ok === false && /抢光/.test(r4.error), r4.error);
  check('三份金额合计 = 总额', r1.amount + r2.amount + r3.amount === 1000,
    String(r1.amount + r2.amount + r3.amount));

  const view = packetView(pk);
  check('view 里 left = 0', view.left === 0, String(view.left));
  check('view 带最近抢到的人', view.shares.length === 3, String(view.shares.length));

  // 过期
  const db2 = db0();
  const pk2 = createPacket(db2, owner, 500, 2);
  pk2.at = Date.now() - 11 * 60 * 1000;
  const r5 = grabPacket(pk2, a);
  check('超过 10 分钟算过期', r5.ok === false && /过期/.test(r5.error), r5.error);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 表情消息 / 文字长度 ===');
{
  const db = db0();
  const p = mkPlayer('p1');
  const emo = pushChat(db, p, { type: 'emoji', emo: 'Emo_00001_0.png' });
  check('表情消息带 emo 字段', emo.type === 'emoji' && emo.emo === 'Emo_00001_0.png');
  const long = 'x'.repeat(CHAT_TEXT_MAX + 50);
  const msg = pushChat(db, p, { type: 'text', text: long });
  check('服务端不强裁（api 层裁 200）', msg.text.length === CHAT_TEXT_MAX + 50);
  check('CHAT_TEXT_MAX = 200', CHAT_TEXT_MAX === 200, String(CHAT_TEXT_MAX));
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
