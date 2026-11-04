// 公告 tick 期限回归
//
//   node tests/notice-expiry.mjs
//
// 只 import src/*，不读写 data/db.json。

import { createDb } from '../src/store.js';
import { pushNotice, noticeAlive, LOTTERY_NOTICE_TICKS } from '../src/engine.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

const db = createDb();
db.tick = 1000;

// ---------------------------------------------------------------- 1
log('=== 1 设置 tick 期限的公告 ===');
{
  const n = pushNotice(db, '测试公告：30 轮后消失', 30);
  check('公告写入', !!n && db.notices.some((x) => x.id === n.id));
  check('expireTick = 当前 tick + 30', n.expireTick === 1030, `expireTick=${n.expireTick}`);
  db.tick = 1029;
  check('第 29 轮还在', noticeAlive(db, n));
  db.tick = 1030;
  check('第 30 轮到点消失', !noticeAlive(db, n));
  db.tick = 5000;
  check('之后也不会复活', !noticeAlive(db, n));
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 0 = 永久，不会因 tick 过期 ===');
{
  db.tick = 1000;
  const n = pushNotice(db, '永久公告', 0);
  check('expireTick = 0', n.expireTick === 0, `expireTick=${n.expireTick}`);
  db.tick = 9_000_000;
  check('很久以后仍然可见', noticeAlive(db, n));
  db.tick = 1000;
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 老公告（没有 expireTick）走 24 小时口径 ===');
{
  db.tick = 1000;
  const fresh = { id: 'old1', text: '老公告', at: Date.now(), tick: 900 };
  const stale = { id: 'old2', text: '很久以前', at: Date.now() - 25 * 3600 * 1000, tick: 100 };
  check('近期的老公告仍可见', noticeAlive(db, fresh));
  check('超过 24 小时的老公告不再可见', !noticeAlive(db, stale));
  check('空对象安全', !noticeAlive(db, null) && !noticeAlive(db, undefined));
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 哈基蜂业固定 30 轮 ===');
{
  check('常量是 30', LOTTERY_NOTICE_TICKS === 30, `LOTTERY_NOTICE_TICKS=${LOTTERY_NOTICE_TICKS}`);
  db.tick = 2000;
  // 模拟 engine 里的调用方式
  const n = pushNotice(db, '哈基蜂业盘面异动，直线拉升 25%，全场哗然', LOTTERY_NOTICE_TICKS, { kind: 'up' });
  check('expireTick = 2030', n.expireTick === 2030, `expireTick=${n.expireTick}`);
  check('kind 字段保留', n.kind === 'up');
  db.tick = 2029;
  check('第 29 轮还在', noticeAlive(db, n));
  db.tick = 2030;
  check('第 30 轮消失', !noticeAlive(db, n));
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 发公告时顺手清理过期公告 + 上限 20 条 ===');
{
  const d2 = createDb();
  d2.tick = 100;
  const short = pushNotice(d2, '短命公告', 10);   // expireTick 110
  d2.tick = 200;
  check('过期公告已到期', !noticeAlive(d2, short));
  pushNotice(d2, '新公告', 100);
  check('发新公告时把过期的那条清掉', !d2.notices.some((n) => n.id === short.id), `剩余 ${d2.notices.length} 条`);

  for (let i = 0; i < 30; i++) pushNotice(d2, '批量公告 ' + i, 0);
  check('最多保留 20 条', d2.notices.length === 20, `实际 ${d2.notices.length}`);
  check('保留的是最新的（最后一条在里面）', d2.notices[d2.notices.length - 1].text === '批量公告 29');
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 非法参数兜底 ===');
{
  db.tick = 3000;
  check('负数当成永久', pushNotice(db, '负数', -5).expireTick === 0);
  check('NaN 当成永久', pushNotice(db, 'NaN', NaN).expireTick === 0);
  check('小数向下取整', pushNotice(db, '小数', 30.9).expireTick === 3030, `expireTick=${pushNotice(db, 'x', 30.9).expireTick}`);
  check('超长文本截断到 300', pushNotice(db, 'A'.repeat(500), 5).text.length === 300);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
