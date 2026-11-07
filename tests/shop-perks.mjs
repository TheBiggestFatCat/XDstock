// 两个新道具：🐟 咸鱼代下单（免手续费）+ 🕵 游资情报（下一次进场的板块）
//   node tests/shop-perks.mjs

import { createDb, migrate } from '../src/store.js';
import { openPosition, closePosition, feeRateFor } from '../src/trading.js';
import { estimateReserve, placeLimitOrder } from '../src/orders.js';
import { stepHotMoney, ensureHotMoney, hotMoneyInfo } from '../src/hotmoney.js';
import { shopNeedLevel, shopGate } from '../src/api.js';
import {
  FREE_FEE_TICKS, freeFeeActive, freeFeeLeft, freeFeeDuration, stampRateFor,
  feeRateForFree, cooldownLeft, hotTipTarget
} from '../src/perks.js';
import { ensureAchvState } from '../src/achievements.js';
import { DEFAULT_CONFIG } from '../src/config.js';

let fails = 0;
let passes = 0;
const out = [];
const realLog = console.log;
console.log = () => {};
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mkDb(patch = {}) {
  const db = migrate(createDb());
  // 先关掉跟这两个道具无关的随机性，再让测试自己覆盖
  Object.assign(db.config, {
    marketTradesEnabled: 0, hotMoneyEnabled: 0, sentimentEnabled: 0, playerImpactEnabled: 0,
    eventChance: 0, baseVolatility: 0, meanReversion: 0
  });
  Object.assign(db.config, patch);
  db.tick = 1000;
  for (const st of Object.values(db.stocks)) st.nextReportTick = 1e12;
  return db;
}

function mkPlayer(db, cash = 1e6) {
  const p = {
    id: 'p_perk', nickname: 'perk', cash, positions: {}, orders: [],
    theme: 'default', skill: 'default', level: 3, themes: [], shards: {}, themeTier: {},
    achv: {}, achvCounters: {}
  };
  ensureAchvState(p);
  db.players[p.id] = p;
  return p;
}

const lastTrade = (db) => (db.trades || [])[db.trades.length - 1] || {};

// ================================================================ 1
log('=== 1 配置默认值（管理面板能调） ===');
{
  check('咸鱼代下单售价 50 万', DEFAULT_CONFIG.shopFreeFeePrice === 500000, String(DEFAULT_CONFIG.shopFreeFeePrice));
  check('免手续费 60 轮 = 5 分钟', DEFAULT_CONFIG.shopFreeFeeTicks === 60, String(DEFAULT_CONFIG.shopFreeFeeTicks));
  check('冷却 100 轮', DEFAULT_CONFIG.shopFreeFeeCooldown === 100, String(DEFAULT_CONFIG.shopFreeFeeCooldown));
  check('游资情报售价 200 万', DEFAULT_CONFIG.shopHotTipPrice === 2000000, String(DEFAULT_CONFIG.shopHotTipPrice));
  check('游资情报冷却 500 轮', DEFAULT_CONFIG.shopHotTipCooldown === 500, String(DEFAULT_CONFIG.shopHotTipCooldown));
  check('FREE_FEE_TICKS 常量与默认值一致', FREE_FEE_TICKS === DEFAULT_CONFIG.shopFreeFeeTicks);
  check('等级门槛：咸鱼 Lv.1 / 游资情报 Lv.3',
    shopNeedLevel('freeFee') === 1 && shopNeedLevel('hotTip') === 3);
  check('Lv.2 买不到游资情报', shopGate({ level: 2 }, 'hotTip')?.needLevel === 3);
  check('Lv.3 能买游资情报', shopGate({ level: 3 }, 'hotTip') === null);
}

// ================================================================ 2
log('');
log('=== 2 咸鱼代下单：60 轮内手续费 + 印花税全免 ===');
{
  const db = mkDb();
  const p = mkPlayer(db);
  db.stocks.TGW.price = 100;
  db.stocks.TGW.fair = 100;

  // 先量一次没道具时的基准
  const r0 = openPosition(db, p, { code: 'TGW', side: 'short', qty: 10, leverage: 1 });
  const t0 = lastTrade(db);
  check('没道具：开空要付手续费', r0.ok && t0.fee > 0, String(t0.fee));
  check('没道具：开空要付印花税', t0.stamp > 0, String(t0.stamp));

  // 买下道具
  p.freeFeeUntilTick = db.tick + 60;
  check('生效判定：active', freeFeeActive(db, p) === true);
  check('剩余轮数 60', freeFeeLeft(db, p) === 60, String(freeFeeLeft(db, p)));
  p.cash = 1e6;

  const r1 = openPosition(db, p, { code: 'TGW', side: 'short', qty: 10, leverage: 1 });
  const t1 = lastTrade(db);
  check('生效期内开空：手续费 0', r1.ok && t1.fee === 0, String(t1.fee));
  check('生效期内开空：印花税 0', t1.stamp === 0, String(t1.stamp));
  check('成交价照常、股数照常', t1.qty === 10 && t1.price === 100, `${t1.qty}@${t1.price}`);

  // 平仓也免
  const pos = p.positions.TGW;
  pos.qty = 10;
  p.cash = 1e6;
  const r2 = closePosition(db, p, 'TGW', 'manual');
  const t2 = lastTrade(db);
  check('生效期内平仓：手续费 0', r2.ok && t2.fee === 0, String(t2.fee));
  check('生效期内平仓：印花税 0', t2.stamp === 0, String(t2.stamp));

  // 过期后恢复收费
  db.tick = p.freeFeeUntilTick;         // 正好到期
  check('到期那一刻就不再生效', freeFeeActive(db, p) === false);
  p.cash = 1e6;
  const r3 = openPosition(db, p, { code: 'TGW', side: 'short', qty: 10, leverage: 1 });
  const t3 = lastTrade(db);
  check('过期后手续费恢复', r3.ok && t3.fee > 0, String(t3.fee));
  check('过期后印花税恢复', t3.stamp > 0, String(t3.stamp));
}

// ================================================================ 3
log('');
log('=== 3 费率函数 / 押金估算也认这个道具 ===');
{
  const db = mkDb({ feeRate: 0.001, stampDuty: 0.002 });
  const p = mkPlayer(db);
  db.stocks.TGW.price = 100;
  db.stocks.TGW.fair = 100;

  check('没生效：feeRateFor = 配置值', Math.abs(feeRateFor(db, p) - 0.001) < 1e-12, String(feeRateFor(db, p)));
  check('没生效：印花税率 = 配置值', Math.abs(stampRateFor(db, p) - 0.002) < 1e-12);
  p.freeFeeUntilTick = db.tick + 30;
  check('生效：feeRateFor = 0', feeRateFor(db, p) === 0);
  check('生效：印花税率 = 0', stampRateFor(db, p) === 0);
  check('生效：feeRateForFree = 0', feeRateForFree(db, p) === 0);
  check('生效：剩余 30 轮', freeFeeLeft(db, p) === 30);
  check('时长读 config（60）', freeFeeDuration(db) === 60, String(freeFeeDuration(db)));

  // 押金：生效期内只算保证金 + 冲击成本
  const noPerk = estimateReserve(db, db.stocks.TGW, 100, 100, 1, 'short');
  const withPerk = estimateReserve(db, db.stocks.TGW, 100, 100, 1, 'short', p);
  check('免手续费时押金更少', withPerk < noPerk, `${noPerk.toFixed(2)} → ${withPerk.toFixed(2)}`);
  check('押金差额 ≈ 手续费 + 印花税', Math.abs((noPerk - withPerk) - 100 * 100 * (0.001 + 0.002)) < 1e-6,
    (noPerk - withPerk).toFixed(4));

  // 下单真正冻结的押金也按免手续费算
  p.cash = 1e7;
  const r = placeLimitOrder(db, p, { code: 'TGW', side: 'short', qty: 100, leverage: 1, limit: 99 });
  check('挂单成功', r.ok === true, r.error || '');
  check('冻结押金 = 免手续费版', Math.abs(r.reserved - withPerk) < 1e-6,
    `${r.reserved?.toFixed(2)} vs ${withPerk.toFixed(2)}`);
}

// ================================================================ 4
log('');
log('=== 4 冷却：100 轮内不能再买 ===');
{
  const db = mkDb();
  const p = mkPlayer(db);
  p.freeFeeReadyAt = db.tick + 100;
  check('刚买完：冷却 100 轮', cooldownLeft(db, p, 'freeFeeReadyAt') === 100);
  db.tick += 99;
  check('第 99 轮仍在冷却', cooldownLeft(db, p, 'freeFeeReadyAt') === 1);
  db.tick += 1;
  check('第 100 轮冷却结束', cooldownLeft(db, p, 'freeFeeReadyAt') === 0);
  check('没有字段时冷却为 0', cooldownLeft(db, {}, 'freeFeeReadyAt') === 0);
  check('冷却不会返回负数', cooldownLeft(db, { freeFeeReadyAt: 1 }, 'freeFeeReadyAt') === 0);
}

// ================================================================ 5
log('');
log('=== 5 游资情报：说哪就去哪（情报必须是真的） ===');
{
  const db = mkDb({ hotMoneyEnabled: 1 });
  db.tick = 5000;
  const hm = ensureHotMoney(db);
  hm.code = '';
  hm.industry = '';
  hm.nextSwitchTick = 0;
  hm.nextIndustry = '';
  const rnd = mulberry32(20261107);

  const first = stepHotMoney(db, { rand: rnd });
  check('第一次进场买入', first && first.bought, first?.bought?.code);
  const cur1 = hm.industry;
  check('进场后抽好了下一次的板块', !!hm.nextIndustry, hm.nextIndustry);
  check('下一次的板块和现在不同', hm.nextIndustry !== cur1, `${cur1} → ${hm.nextIndustry}`);
  check('下一次的金额也抽好了（1000万~3000万）',
    hm.nextAmount >= 10000000 && hm.nextAmount <= 30000000, String(Math.round(hm.nextAmount)));

  const tip = hotTipTarget(db);
  check('情报接口给出下一次的板块', tip && tip.industry === hm.nextIndustry, JSON.stringify(tip));
  check('情报带「还有多少轮进场」', tip.leftTicks > 0 && tip.leftTicks <= 300, String(tip?.leftTicks));

  // 到点：必须去情报说的那个板块
  const want = hm.nextIndustry;
  db.tick = hm.nextSwitchTick;
  const second = stepHotMoney(db, { rand: rnd });
  check('到点真的去了情报说的板块', second.industry === want, `${want} vs ${second.industry}`);
  check('买入的票属于那个板块', db.stocks[second.code].industry === want,
    `${db.stocks[second.code].industry}`);
  check('卖旧 + 买新都发生了', !!second.sold && !!second.bought);
  check('换完又抽好了下下个板块', !!hm.nextIndustry && hm.nextIndustry !== hm.industry, hm.nextIndustry);
  check('不会连续两次同板块', (() => {
    const rnd2 = mulberry32(99);
    const db2 = mkDb({ hotMoneyEnabled: 1 });
    db2.tick = 100;
    const h2 = ensureHotMoney(db2);
    h2.code = '';
    let prev = '';
    let bad = 0;
    for (let i = 0; i < 40; i++) {
      db2.tick = h2.nextSwitchTick || db2.tick;
      const r = stepHotMoney(db2, { rand: rnd2 });
      if (!r) break;
      if (prev && r.industry === prev) bad++;
      prev = r.industry;
    }
    return bad === 0;
  })());

  // 关掉游资 → 没有情报（也不收钱，路由里判断）
  db.config.hotMoneyEnabled = 0;
  check('游资关掉后没有情报', hotTipTarget(db) === null);
  db.config.hotMoneyEnabled = 1;
  hm.nextIndustry = '';
  check('还没抽好下一次时也没有情报', hotTipTarget(db) === null);

  // 老存档 / 刚上线：手里有票但没抽过下一次 → 下一轮自动补出来，情报立刻可用
  const db3 = mkDb({ hotMoneyEnabled: 1 });
  db3.tick = 7000;
  const h3 = ensureHotMoney(db3);
  h3.code = 'DFY';
  h3.industry = '科技AI';
  h3.nextSwitchTick = db3.tick + 200;
  h3.nextIndustry = '';
  h3.nextAmount = 0;
  check('补之前没法买情报', hotTipTarget(db3) === null);
  stepHotMoney(db3, { rand: mulberry32(5) });
  const tip3 = hotTipTarget(db3);
  check('没到换仓也会把下一次的板块补出来', !!tip3 && tip3.industry.length > 0, JSON.stringify(tip3));
  check('补出来的板块和现在不同', tip3.industry !== h3.industry, `${h3.industry} → ${tip3?.industry}`);
  check('补出来的金额在 1000 万~3000 万之间',
    tip3.amount >= 10000000 && tip3.amount <= 30000000, String(tip3.amount));
}

// ================================================================ 6
log('');
log('=== 6 老存档 / 脏数据不炸 ===');
{
  const db = mkDb({ hotMoneyEnabled: 1 });
  delete db.hotMoney;
  const hm = ensureHotMoney(db);
  check('缺 hotMoney 能补出来', !!hm && hm.nextIndustry === '' && hm.nextAmount === 0,
    JSON.stringify(hm));
  check('没抽到情报时 hotTipTarget 为 null', hotTipTarget(db) === null);
  check('hotTipTarget 不传 db 也返回 null', hotTipTarget(null) === null);

  const p = { freeFeeUntilTick: 'abc' };
  check('脏字段当没生效', freeFeeActive(db, p) === false);
  check('脏字段剩余 0', freeFeeLeft(db, p) === 0);
  check('null 玩家不炸', freeFeeActive(db, null) === false && stampRateFor(db, null) === 0
    + Number(db.config.stampDuty));

  // 游资摘要仍正常
  const info = hotMoneyInfo(db);
  check('hotMoneyInfo 可用', !!info && typeof info.switches === 'number', JSON.stringify(info));
}

console.log = realLog;
console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
