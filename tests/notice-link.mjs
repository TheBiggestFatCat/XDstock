// 公告跳转链接（2026-11 加）
//
//   node tests/notice-link.mjs
//
// 只 import src/*，不读写 data/db.json。
// 覆盖：noticeLink 白名单、pushNotice 透传 href、两处 payload 是否下发。

import { createDb } from '../src/store.js';
import { pushNotice, noticeLink } from '../src/engine.js';
import { marketPayload } from '../src/api.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

// ---------------------------------------------------------------- 1
log('=== 1 站内路径放行 ===');
{
  check('/tournament 放行', noticeLink({ href: '/tournament' }) === '/tournament');
  check('带查询串放行', noticeLink({ href: '/tournament?x=1#a' }) === '/tournament?x=1#a');
  check('多级路径放行', noticeLink({ href: '/a/b-c_d.html' }) === '/a/b-c_d.html');
  check('前后空格去掉', noticeLink({ href: '  /tournament  ' }) === '/tournament');
}

// ---------------------------------------------------------------- 2
log('=== 2 非站内地址一律挡掉 ===');
{
  const bad = [
    'https://evil.com', 'http://evil.com', '//evil.com', 'javascript:alert(1)',
    'data:text/html,<script>', 'tournament', '/to"ur', '/a<>b', '', null, undefined
  ];
  for (const h of bad) {
    check(`挡掉 ${JSON.stringify(h)}`, noticeLink({ href: h }) === '', `got=${JSON.stringify(noticeLink({ href: h }))}`);
  }
  check('没有 href 字段返回空', noticeLink({}) === '');
  check('null 公告返回空', noticeLink(null) === '');
}

// ---------------------------------------------------------------- 3
log('=== 3 发公告时透传 href ===');
{
  const db = createDb();
  db.tick = 100;
  const n = pushNotice(db, '锦标赛今晚 21:00 开赛', 720, { href: '/tournament' });
  check('存档里带 href', n.href === '/tournament', JSON.stringify(n.href));
  check('不影响 text', n.text === '锦标赛今晚 21:00 开赛');
  check('不影响 expireTick', n.expireTick === 820, `expireTick=${n.expireTick}`);

  const plain = pushNotice(db, '普通公告', 10);
  check('不传 extra 时没有 href', plain.href === undefined);
}

// ---------------------------------------------------------------- 4
log('=== 4 /api/market 下发 href ===');
{
  const db = createDb();
  db.tick = 50;
  pushNotice(db, '带链接的公告', 100, { href: '/tournament' });
  pushNotice(db, '没有链接的公告', 100);
  pushNotice(db, '外链公告', 100, { href: 'javascript:alert(1)' });

  const p = marketPayload(db, null);
  const byText = (s) => p.notices.find((n) => n.text === s);
  check('带链接的下发 href', byText('带链接的公告').href === '/tournament');
  check('没链接的下发 null', byText('没有链接的公告').href === null);
  check('外链被清洗成 null', byText('外链公告').href === null);
}

// ---------------------------------------------------------------- 5
log('=== 5 过期公告不下发 ===');
{
  const db = createDb();
  db.tick = 10;
  pushNotice(db, '马上过期', 5, { href: '/tournament' });
  db.tick = 20;
  const p = marketPayload(db, null);
  check('过期后不在列表里', !p.notices.some((n) => n.text === '马上过期'));
}

// ---------------------------------------------------------------- 汇总
log('');
log(`---- ${passes} 通过 / ${fails} 失败 ----`);
console.log(out.join('\n'));
process.exit(fails ? 1 : 0);
