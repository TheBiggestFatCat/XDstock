// 聊天大厅：拆分算法 / 500 条上限 / 抢红包规则（纯函数）
//   node tests/chat.mjs

import {
  ensureChat, pushChat, chatRows, splitPacket, createPacket, grabPacket, packetView,
  packetTtlMs, PACKET_TTL_HOURS_DEFAULT, CHAT_MAX, CHAT_TEXT_MAX,
  chatSeqOf, chatReadSeqOf, chatUnreadFor, chatMarkRead
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

  // 过期：默认 2 小时
  const db2 = db0();
  const pk2 = createPacket(db2, owner, 500, 2);
  pk2.at = Date.now() - 121 * 60 * 1000;      // 2 小时 1 分
  const r5 = grabPacket(pk2, a, {});
  check('默认超过 2 小时算过期', r5.ok === false && /过期/.test(r5.error), r5.error);

  const pk2b = createPacket(db2, owner, 500, 2);
  pk2b.at = Date.now() - 110 * 60 * 1000;     // 1 小时 50 分（还在有效期内）
  const r5b = grabPacket(pk2b, a, {});
  check('1 小时 50 分还能抢', r5b.ok === true, r5b.error || '');

  // 可配置
  check('默认 TTL = 2 小时', PACKET_TTL_HOURS_DEFAULT === 2, String(PACKET_TTL_HOURS_DEFAULT));
  check('packetTtlHours=2 → 7200000ms', packetTtlMs({ packetTtlHours: 2 }) === 2 * 3600 * 1000);
  check('packetTtlHours=6 → 6 小时', packetTtlMs({ packetTtlHours: 6 }) === 6 * 3600 * 1000);
  check('填 0/负数 → 回落默认 2 小时', packetTtlMs({ packetTtlHours: 0 }) === 2 * 3600 * 1000);
  check('填 999 → 夹到 72 小时', packetTtlMs({ packetTtlHours: 999 }) === 72 * 3600 * 1000);

  const pk2c = createPacket(db2, owner, 500, 2);
  pk2c.at = Date.now() - 3 * 3600 * 1000;     // 3 小时前
  const r6 = grabPacket(pk2c, a, { packetTtlHours: 6 });
  check('后台把有效期改成 6 小时 → 3 小时前的还能抢', r6.ok === true, r6.error || '');
  const pk2d = createPacket(db2, owner, 500, 2);
  pk2d.at = Date.now() - 3 * 3600 * 1000;
  const r7 = grabPacket(pk2d, a, { packetTtlHours: 1 });
  check('改成 1 小时 → 3 小时前的就过期了', r7.ok === false && /过期/.test(r7.error), r7.error);
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

// ---------------------------------------------------------------- 7
log('');
log('=== 7 未读红点的已读游标（服务端存，手机/电脑同步） ===');
{
  const db = db0();
  const p = mkPlayer('reader', '读的人');
  check('空大厅 seq = 0', chatSeqOf(db) === 0, String(chatSeqOf(db)));
  check('空大厅没有未读', chatUnreadFor(db, p) === false);
  check('空 db / 空玩家不炸', chatSeqOf(null) === 0 && chatUnreadFor(null, null) === false);

  pushChat(db, mkPlayer('other1'), { type: 'text', text: 'hi' });
  check('有人说话后 seq = 1', chatSeqOf(db) === 1, String(chatSeqOf(db)));
  check('没读过 → 有未读（红点亮）', chatUnreadFor(db, p) === true);

  check('读到最新 → 游标 = 1', chatMarkRead(db, p) === 1, String(p.chatReadSeq));
  check('读完后没有未读（红点灭）', chatUnreadFor(db, p) === false);

  pushChat(db, mkPlayer('other2'), { type: 'text', text: 'yo' });
  check('又来一条 → 又有未读', chatUnreadFor(db, p) === true);
  check('upto=1 只推到第 1 条', chatMarkRead(db, p, 1) === 1, String(p.chatReadSeq));
  check('推到第 1 条后还剩未读（当前 seq=2）', chatUnreadFor(db, p) === true);
  check('upto 超过最新会被夹到最新', chatMarkRead(db, p, 999) === 2, String(p.chatReadSeq));
  check('再标已读不会倒退（传 0）', chatMarkRead(db, p, 0) === 2, String(p.chatReadSeq));
  check('全部读完后没有未读', chatUnreadFor(db, p) === false);

  // 脏数据：游标是负数 / 字符串 / 字段缺失，一律当 0（老存档由 migrate 补基线）
  check('负数游标当 0', chatReadSeqOf({ chatReadSeq: -5 }) === 0);
  check('字符串游标当 0', chatReadSeqOf({ chatReadSeq: 'x' }) === 0);
  check('没有游标当 0', chatReadSeqOf({}) === 0);
  check('没有游标的老玩家按「全都未读」算', chatUnreadFor(db, {}) === true);
  check('chatMarkRead 不往未来推（空大厅）', chatMarkRead({ chat: {} }, { chatReadSeq: 0 }) === 0);

  // 两个设备共用服务端那一份 player.chatReadSeq：A 读了之后，B 下一轮拉到的也没有红点
  const p2 = mkPlayer('reader2');
  p2.chatReadSeq = 0;
  pushChat(db, mkPlayer('other3'), { type: 'text', text: 'z' });
  check('第二台设备初始有未读', chatUnreadFor(db, { ...p2 }) === true);
  chatMarkRead(db, p2);                        // 设备 A 读了（写服务端同一份 player）
  check('设备 A 读完，服务端游标 = 最新', chatReadSeqOf(p2) === chatSeqOf(db));
  check('设备 B 再拉 payload 时没有红点（游标在服务端共享）',
    chatUnreadFor(db, { ...p2 }) === false);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
