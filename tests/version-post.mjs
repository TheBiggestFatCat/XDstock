// 版本公告：发布、列表、最新一条、删除、编辑、校验
//   node tests/version-post.mjs

import {
  pushVersionPost, latestVersionPost, listVersionPosts,
  deleteVersionPost, updateVersionPost, VERSION_POST_MAX
} from '../src/version.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

// ---------------------------------------------------------------- 1
log('=== 1 发布 / 取最新 ===');
{
  const db = {};
  check('一开始没有版本公告', latestVersionPost(db) === null);
  const r = pushVersionPost(db, { version: 'v9.9.9', title: '测试公告', body: '第一行\n第二行', tick: 42 });
  check('发布成功', r.ok, r.error || '');
  check('id 带 v_ 前缀', String(r.post.id).startsWith('v_'), r.post.id);
  check('tick 记下来了', r.post.tick === 42, String(r.post.tick));
  check('正文里的换行保留', r.post.body.includes('\n'));

  const latest = latestVersionPost(db);
  check('latest 拿到刚发的那条', latest && latest.title === '测试公告');

  const r2 = pushVersionPost(db, { version: 'v9.9.10', title: '第二条', body: 'x' });
  check('再发一条', r2.ok);
  check('latest 变成第二条', latestVersionPost(db).title === '第二条');
  check('列表是两条（旧的在前）', listVersionPosts(db).length === 2
    && listVersionPosts(db)[0].title === '测试公告');
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 校验：空标题 / 空正文 / 超长 / 控制字符 ===');
{
  const db = {};
  check('空标题被拒', pushVersionPost(db, { title: '  ', body: 'x' }).ok === false);
  check('空正文被拒', pushVersionPost(db, { title: 'x', body: '   ' }).ok === false);
  check('两个都空被拒', pushVersionPost(db, {}).ok === false);
  check('被拒时没写进库', listVersionPosts(db).length === 0);

  const long = 'x'.repeat(9000);
  const r = pushVersionPost(db, { title: long, body: long });
  check('超长标题被夹到 60', r.post.title.length === 60, String(r.post.title.length));
  check('超长正文被夹到 4000', r.post.body.length === 4000, String(r.post.body.length));

  const dirty = pushVersionPost(db, { title: 'a\u0001b\u0007c', body: 'x\u0000y' });
  check('控制字符被清掉', dirty.post.title === 'abc' && dirty.post.body === 'xy',
    JSON.stringify([dirty.post.title, dirty.post.body]));

  const noVer = pushVersionPost(db, { title: 't', body: 'b' });
  check('版本号可以留空', noVer.ok && noVer.post.version === '');
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 上限：只留最近 20 条 ===');
{
  const db = {};
  for (let i = 0; i < VERSION_POST_MAX + 8; i++) {
    pushVersionPost(db, { version: 'v' + i, title: '第 ' + i + ' 条', body: 'b' + i });
  }
  check(`列表最多 ${VERSION_POST_MAX} 条`, listVersionPosts(db).length === VERSION_POST_MAX,
    String(listVersionPosts(db).length));
  check('留下的是最新的', latestVersionPost(db).title === '第 ' + (VERSION_POST_MAX + 7) + ' 条',
    latestVersionPost(db).title);
  check('最老的已经被挤掉', !listVersionPosts(db).some((p) => p.title === '第 0 条'));
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 删除 ===');
{
  const db = {};
  const a = pushVersionPost(db, { title: 'A', body: 'a' });
  pushVersionPost(db, { title: 'B', body: 'b' });
  check('删 A 成功', deleteVersionPost(db, a.post.id) === true);
  check('只剩 B', listVersionPosts(db).length === 1 && latestVersionPost(db).title === 'B');
  check('删不存在的返回 false', deleteVersionPost(db, 'nope') === false);
  check('删光后 latest 是 null', (() => {
    deleteVersionPost(db, latestVersionPost(db).id);
    return latestVersionPost(db) === null;
  })());
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 脏数据 ===');
{
  check('没有 db 不炸', pushVersionPost(null, { title: 'x', body: 'y' }).ok === false);
  check('latest 空 db 返回 null', latestVersionPost({}) === null);
  check('latest null db 返回 null', latestVersionPost(null) === null);
  check('list 空 db 返回 []', Array.isArray(listVersionPosts({})) && listVersionPosts({}).length === 0);
  check('delete 空 db 不炸', deleteVersionPost({}, 'x') === false);
  const weird = { versionPosts: [null, 5, { id: 'ok', title: 'T', body: 'B' }] };
  check('latest 跳过脏元素', (() => {
    const l = latestVersionPost(weird);
    return l && l.id === 'ok';
  })());
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 编辑：改内容、身份字段保留、记 editedAt（2026-11 加） ===');
{
  const db = {};
  const { post } = pushVersionPost(db, { version: 'v1.0', title: '旧标题', body: '旧正文', tick: 10 });
  const before = { ...post };
  const r = updateVersionPost(db, post.id, { version: 'v1.1', title: '新标题', body: '新正文\n第二行' });
  check('编辑成功', r.ok === true, r.error || '');
  check('标题改了', r.post.title === '新标题', r.post.title);
  check('正文改了（换行还在）', r.post.body === '新正文\n第二行', JSON.stringify(r.post.body));
  check('版本号改了', r.post.version === 'v1.1', r.post.version);
  check('id 不变', r.post.id === before.id);
  check('at 不变', r.post.at === before.at);
  check('tick 不变', r.post.tick === before.tick);
  check('记了 editedAt', r.post.editedAt > 0, String(r.post.editedAt));
  check('是改不是新增（还是 1 条）', listVersionPosts(db).length === 1);
  check('玩家看到的就是改后的标题', latestVersionPost(db).title === '新标题');
  check('玩家看到的就是改后的正文', latestVersionPost(db).body.includes('第二行'));
}

// ---------------------------------------------------------------- 7
log('');
log('=== 7 编辑：只传一项时其余保持原样 ===');
{
  const db = {};
  const { post } = pushVersionPost(db, { version: 'v2.0', title: '标题', body: '正文' });
  const r1 = updateVersionPost(db, post.id, { title: '只改标题' });
  check('只改标题：正文不动', r1.post.body === '正文', r1.post.body);
  check('只改标题：版本号不动', r1.post.version === 'v2.0', r1.post.version);
  const r2 = updateVersionPost(db, post.id, { body: '只改正文' });
  check('只改正文：标题保留上次改的', r2.post.title === '只改标题', r2.post.title);
  check('版本号可以改成空', updateVersionPost(db, post.id, { version: '' }).post.version === '');
}

// ---------------------------------------------------------------- 8
log('');
log('=== 8 编辑：校验 / 截断 / 异常 ===');
{
  const db = {};
  const { post } = pushVersionPost(db, { version: 'v3', title: 'T', body: 'B' });
  const bad1 = updateVersionPost(db, post.id, { title: '   ' });
  check('标题清空被拒', bad1.ok === false && /标题/.test(bad1.error), String(bad1.error));
  const bad2 = updateVersionPost(db, post.id, { body: '' });
  check('正文清空被拒', bad2.ok === false && /内容/.test(bad2.error), String(bad2.error));
  check('被拒后内容没变', latestVersionPost(db).title === 'T' && latestVersionPost(db).body === 'B');
  check('id 不存在 → 明确报错',
    (() => { const x = updateVersionPost(db, 'v_nope', { title: 'a', body: 'b' }); return x.ok === false && /没有这条/.test(x.error); })());
  check('空 db 不炸', updateVersionPost({}, 'x', { title: 'a', body: 'b' }).ok === false);
  check('null db 不炸', updateVersionPost(null, 'x', { title: 'a', body: 'b' }).ok === false);

  const long = 'x'.repeat(5000);
  check('超长正文编辑时也被截到 4000', updateVersionPost(db, post.id, { body: long }).post.body.length === 4000);
  check('超长标题编辑时也被截到 60', updateVersionPost(db, post.id, { title: 'y'.repeat(200) }).post.title.length === 60);
  const dirty = updateVersionPost(db, post.id, { title: 'a\u0001b\u0007c' });
  check('控制字符同样被清掉', dirty.post.title === 'abc', JSON.stringify(dirty.post.title));
}

// ---------------------------------------------------------------- 9
log('');
log('=== 9 编辑：只改目标那条，顺序和其他条不受影响 ===');
{
  const db = {};
  const a = pushVersionPost(db, { version: 'v1', title: '一', body: 'b1' }).post;
  const b = pushVersionPost(db, { version: 'v2', title: '二', body: 'b2' }).post;
  const c = pushVersionPost(db, { version: 'v3', title: '三', body: 'b3' }).post;
  updateVersionPost(db, b.id, { title: '二（改）' });
  const list = listVersionPosts(db);
  check('顺序没变', list.map((p) => p.id).join(',') === [a.id, b.id, c.id].join(','), list.map((p) => p.title).join('|'));
  check('只有目标那条被改', list.map((p) => p.title).join('|') === '一|二（改）|三', list.map((p) => p.title).join('|'));
  check('最新的还是第三条', latestVersionPost(db).id === c.id);
  check('只有改过的那条有 editedAt', !!list[1].editedAt && !list[0].editedAt && !list[2].editedAt);

  // 改完了还能删
  check('编辑过的也能删', deleteVersionPost(db, b.id) === true);
  check('删完只剩两条', listVersionPosts(db).length === 2);
  // 被挤到上限之外的老公告也能编辑
  const db2 = {};
  for (let i = 0; i < VERSION_POST_MAX + 3; i++) {
    pushVersionPost(db2, { version: 'v' + i, title: 't' + i, body: 'b' + i });
  }
  const oldest = listVersionPosts(db2)[0];
  check('留着的最老一条也能编辑', updateVersionPost(db2, oldest.id, { title: '改老的' }).ok === true);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);