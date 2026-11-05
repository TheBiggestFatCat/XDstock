// 版本公告：发布、列表、最新一条、删除、校验
//   node tests/version-post.mjs

import {
  pushVersionPost, latestVersionPost, listVersionPosts,
  deleteVersionPost, VERSION_POST_MAX
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

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
