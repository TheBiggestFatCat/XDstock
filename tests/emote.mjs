// 表情互动：解锁、last-wins、可见窗口、脏数据
//   node tests/emote.mjs

import {
  unlockedEmojis, isEmojiUnlocked, tierDirOf,
  pushEmote, visibleEmotes, filterEmotesByCode, EMOTE_MAX, EMOTE_PER_TICK_MAX
} from '../src/emoji.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

// ---------------------------------------------------------------- 1
log('=== 1 解锁：Lv.1 就有全套 ===');
{
  const all = unlockedEmojis(1);
  check('Lv.1 解锁 18 个', all.length === 18, String(all.length));
  check('文件名都对', all.every((f) => /^Emo_00001_\d+\.png$/.test(f)), all[0]);
  check('等级空值按 Lv.1 算', unlockedEmojis(undefined).length === 18);
  check('负数等级也按 Lv.1 算', unlockedEmojis(-3).length === 18);
  check('Lv.5 也是 18 个（暂时没有更高档）', unlockedEmojis(5).length === 18);
  check('目录映射对', tierDirOf(all[0]) === 'emo_lv1');
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 白名单：乱传的文件名一律不认 ===');
{
  check('认识的放行', isEmojiUnlocked(1, 'Emo_00001_0.png') === true);
  check('不认识的拒绝', isEmojiUnlocked(1, 'Emo_99999_0.png') === false);
  check('路径穿越拒绝', isEmojiUnlocked(1, '../../etc/passwd') === false);
  check('空字符串拒绝', isEmojiUnlocked(1, '') === false);
  check('null 拒绝', isEmojiUnlocked(1, null) === false);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 同一轮点多次：只留最后一个 ===');
{
  const db = { tick: 100, emotes: [] };
  const p = { id: 'p1', nickname: '甲', level: 1 };
  const a = pushEmote(db, p, { file: 'Emo_00001_1.png', code: 'tgw' });
  check('第一次成功', a.ok && !a.replaced, a.error || '');
  const b = pushEmote(db, p, { file: 'Emo_00001_5.png', code: 'TGW' });
  check('第二次是替换', b.ok && b.replaced === true);
  check('只留一条', db.emotes.length === 1, String(db.emotes.length));
  check('留下的是最后那个', db.emotes[0].emo === 'Emo_00001_5.png', db.emotes[0].emo);
  check('代码已大写', db.emotes[0].code === 'TGW');
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 可见窗口：上一轮的才显示，再下一轮消失 ===');
{
  const db = { tick: 100, emotes: [] };
  pushEmote(db, { id: 'p1', nickname: '甲', level: 1 }, { file: 'Emo_00001_2.png' });
  check('当轮还看不到（等下一轮）', visibleEmotes(db).length === 0);
  db.tick = 101;
  const seen = visibleEmotes(db);
  check('下一轮能看到', seen.length === 1, String(seen.length));
  check('带玩家昵称', seen[0].nickname === '甲');
  check('带目录', seen[0].dir === 'emo_lv1');
  db.tick = 102;
  check('再下一轮就消失', visibleEmotes(db).length === 0);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 多人同时：一轮里的都在 ===');
{
  const db = { tick: 7, emotes: [] };
  for (let i = 0; i < 3; i++) {
    pushEmote(db, { id: 'p' + i, nickname: '人' + i, level: 1 }, { file: 'Emo_00001_0.png' });
  }
  check('三条都在 db 里', db.emotes.length === 3);
  db.tick = 8;
  check('下一轮三条一起显示', visibleEmotes(db).length === 3);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 上限与脏数据 ===');
{
  const db = { tick: 1, emotes: [] };
  for (let i = 0; i < EMOTE_MAX + 20; i++) {
    db.tick = 1 + i;
    pushEmote(db, { id: 'p' + i, nickname: 'n', level: 1 }, { file: 'Emo_00001_3.png' });
  }
  check(`db 长度封顶在 ${EMOTE_MAX}`, db.emotes.length <= EMOTE_MAX, String(db.emotes.length));

  const db2 = { tick: 5, emotes: [] };
  for (let i = 0; i < EMOTE_PER_TICK_MAX + 6; i++) {
    pushEmote(db2, { id: 'q' + i, nickname: 'n', level: 1 }, { file: 'Emo_00001_4.png' });
  }
  check(`一轮最多 ${EMOTE_PER_TICK_MAX} 条`, db2.emotes.length === EMOTE_PER_TICK_MAX, String(db2.emotes.length));

  check('没表情时返回空数组', visibleEmotes({ tick: 3 }).length === 0);
  check('db 为空不炸', visibleEmotes(null).length === 0);
  check('push 到空 db 不炸', pushEmote({}, { id: 'x', level: 1 }, { file: 'Emo_00001_0.png' }).ok === true);
  check('没玩家不炸', pushEmote({ tick: 1 }, null, { file: 'Emo_00001_0.png' }).ok === false);
  check('未解锁的推不进去',
    pushEmote({ tick: 1, emotes: [] }, { id: 'y', level: 1 }, { file: 'nope.png' }).ok === false);
}

// ---------------------------------------------------------------- 7
log('');
log('=== 7 一只票一个互动区：只显示当前这只票的 ===');
{
  const db = { tick: 500, emotes: [] };
  pushEmote(db, { id: 'p1', nickname: '甲', level: 1 }, { file: 'Emo_00001_0.png', code: 'TGW' });
  pushEmote(db, { id: 'p2', nickname: '乙', level: 1 }, { file: 'Emo_00001_1.png', code: 'MCD' });
  pushEmote(db, { id: 'p3', nickname: '丙', level: 1 }, { file: 'Emo_00001_2.png', code: 'tgw' });
  db.tick = 501;
  const all = visibleEmotes(db);
  check('全局这批有 3 条', all.length === 3, String(all.length));

  const tgw = filterEmotesByCode(all, 'TGW');
  check('TGW 页面只看到 TGW 的 2 条', tgw.length === 2, String(tgw.length));
  check('含大小写不同的那条', tgw.some((e) => e.nickname === '丙'));
  const mcd = filterEmotesByCode(all, 'mcd');
  check('MCD 页面看到 1 条', mcd.length === 1 && mcd[0].nickname === '乙', String(mcd.length));
  check('别的票（LU）什么都看不到', filterEmotesByCode(all, 'LU').length === 0);

  check('空 code 不匹配任何表情', filterEmotesByCode(all, '').length === 0);
  check('code 为空的老数据不显示', filterEmotesByCode([{ id: 'x', code: '' }], 'TGW').length === 0);
  check('列表为空不炸', filterEmotesByCode([], 'TGW').length === 0);
  check('null 不炸', filterEmotesByCode(null, 'TGW').length === 0);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
