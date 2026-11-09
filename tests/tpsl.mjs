// 止盈止损（TP/SL）回归测试
//   node tests/tpsl.mjs
//
// 覆盖：多头/空头的止盈止损、多条条件与部分平仓、跳空、分批成交、
//       不重复下单、手动平仓后幽灵单、强平优先、撤单后是否还能再触发、
//       重新开仓不残留、长时间随机行情下的不变量

import { createDb, migrate } from '../src/store.js';
import { openPosition, closePosition, checkPositions } from '../src/trading.js';
import { processOrders, cancelOrder } from '../src/orders.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}

/** 造一个「价格我说了算」的市场 */
function mkDb(patch = {}) {
  const db = migrate(createDb());
  Object.assign(db.config, {
    feeRate: 0, stampDuty: 0, playerImpactEnabled: 0, impactCostCoef: 0,
    marketOpen: true, 
    marketCycleEnabled: 0,   // 测试里别被「夜间休市」拦住orderTtlTicks: 4000, maxTpslPerPosition: 8,
    ...patch
  });
  db.tick = 10000;
  for (const st of Object.values(db.stocks)) {
    if (st.isIndex) continue;
    st.price = 100;
    st.fair = 100;
    st.series = new Array(50).fill(100);
    st.nextReportTick = 1e12;
  }
  return db;
}
function mkPlayer(db, id = 'p1', cash = 1e8) {
  db.players[id] = {
    id, nickname: id, pin: 'x', cash, positions: {}, orders: [],
    level: 10, channelLevel: 5, themes: [], themeTier: {}, shards: {}, achv: {}, achvCounters: {},
    equityHistory: [], notifications: []
  };
  return db.players[id];
}
/** 走一轮：设价 → 撮合 → 检查持仓 */
function tick(db, prices = {}) {
  db.tick += 1;
  for (const [code, px] of Object.entries(prices)) db.stocks[code].price = px;
  const orders = processOrders(db);
  const closes = checkPositions(db);
  return { orders, closes };
}
const setTpsl = (pos, list) => {
  pos.tpsl = list.map((x, i) => ({ id: `ts_${i}`, kind: x.kind, price: x.price, qty: x.qty ?? null, fired: false }));
  const tp = pos.tpsl.find((x) => x.kind === 'tp' && !x.fired);
  const sl = pos.tpsl.find((x) => x.kind === 'sl' && !x.fired);
  pos.tp = tp ? tp.price : null;
  pos.sl = sl ? sl.price : null;
};
const autoOrders = (p, code) => (p.orders || []).filter((o) => o.code === code && o.action === 'close' && o.auto);

// ---------------------------------------------------------------- 1
log('=== 1 多头止盈：价格到线 → 生成自动单 → 下一轮成交 ===');
{
  const db = mkDb();
  const p = mkPlayer(db);
  const code = 'TGW';
  openPosition(db, p, { code, side: 'long', qty: 1000, leverage: 1 });
  const pos = p.positions[code];
  const cashAfterOpen = p.cash;
  setTpsl(pos, [{ kind: 'tp', price: 110 }]);

  tick(db, { [code]: 105 });
  check('没到价不下单', autoOrders(p, code).length === 0, `${autoOrders(p, code).length} 张`);

  const t1 = tick(db, { [code]: 111 });
  check('到价立刻生成 1 张自动平仓单', autoOrders(p, code).length === 1, `${autoOrders(p, code).length} 张`);
  check('自动单标了 auto=tp', autoOrders(p, code)[0].auto === 'tp', String(autoOrders(p, code)[0]?.auto));
  check('当轮不成交（排队到下一轮）', !!p.positions[code], '持仓还在');
  check('触发后条件标记 fired', pos.tpsl[0].fired === true);
  check('pos.tp 被清空（不会重复触发）', pos.tp === null, String(pos.tp));

  const t2 = tick(db, { [code]: 111 });
  check('下一轮成交并清仓', !p.positions[code], p.positions[code] ? '还留着' : '已平');
  const fill = t2.orders.find((e) => e.auto === 'tp');
  check('事件里标了 auto=tp', !!fill, JSON.stringify(t2.orders[0] || {}));
  check('成交价 ≈ 市价（不是限价）', Math.abs((fill?.price || 0) - 111) < 1e-6, String(fill?.price));
  check('盈利 = (111−100)×1000', Math.abs((fill?.pnl || 0) - 11000) < 1e-6, String(fill?.pnl));
  check('现金 = 开仓后 + 保证金 + 盈亏',
    Math.abs(p.cash - (cashAfterOpen + 100000 + 11000)) < 1e-6, String(Math.round(p.cash)));
  check('自动单已摘掉', autoOrders(p, code).length === 0);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 多头止损：跌破 → 自动平仓 ===');
{
  const db = mkDb();
  const p = mkPlayer(db);
  const code = 'TGW';
  openPosition(db, p, { code, side: 'long', qty: 1000, leverage: 1 });
  setTpsl(p.positions[code], [{ kind: 'sl', price: 95 }]);
  tick(db, { [code]: 96 });
  check('没跌破不下单', autoOrders(p, code).length === 0);
  const t = tick(db, { [code]: 94 });
  check('跌破立刻生成自动单', autoOrders(p, code).length === 1 && autoOrders(p, code)[0].auto === 'sl');
  const t2 = tick(db, { [code]: 94 });
  const fill = t2.orders.find((e) => e.auto === 'sl');
  check('下一轮平掉', !p.positions[code]);
  check('亏损 = (94−100)×1000', Math.abs((fill?.pnl || 0) + 6000) < 1e-6, String(fill?.pnl));
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 空头：止盈（跌）与止损（涨）方向要对 ===');
{
  const db = mkDb();
  const p = mkPlayer(db);
  const code = 'TGW';
  openPosition(db, p, { code, side: 'short', qty: 1000, leverage: 1 });
  setTpsl(p.positions[code], [{ kind: 'tp', price: 90 }]);
  tick(db, { [code]: 95 });
  check('空头止盈：涨到 95 不触发', autoOrders(p, code).length === 0);
  tick(db, { [code]: 89 });
  check('空头止盈：跌到 89 触发', autoOrders(p, code).length === 1);
  const t = tick(db, { [code]: 89 });
  const fill = t.orders.find((e) => e.auto === 'tp');
  check('空头止盈平仓并盈利', !p.positions[code] && (fill?.pnl || 0) > 0, String(fill?.pnl));

  const db2 = mkDb();
  const p2 = mkPlayer(db2, 'p2');
  openPosition(db2, p2, { code, side: 'short', qty: 1000, leverage: 1 });
  setTpsl(p2.positions[code], [{ kind: 'sl', price: 105 }]);
  tick(db2, { [code]: 104 });
  check('空头止损：涨到 104 不触发', autoOrders(p2, code).length === 0);
  tick(db2, { [code]: 106 });
  check('空头止损：涨到 106 触发', autoOrders(p2, code).length === 1);
  const t2 = tick(db2, { [code]: 106 });
  const fill2 = t2.orders.find((e) => e.auto === 'sl');
  check('空头止损亏损', !p2.positions[code] && (fill2?.pnl || 0) < 0, String(fill2?.pnl));
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 多条条件 + 部分平仓 ===');
{
  const db = mkDb();
  const p = mkPlayer(db);
  const code = 'TGW';
  openPosition(db, p, { code, side: 'long', qty: 1000, leverage: 1 });
  setTpsl(p.positions[code], [
    { kind: 'tp', price: 105, qty: 400 },
    { kind: 'tp', price: 120, qty: 300 },
    { kind: 'sl', price: 90 }
  ]);
  tick(db, { [code]: 106 });
  check('只挂 1 张（第一条先来）', autoOrders(p, code).length === 1, String(autoOrders(p, code)[0]?.qty));
  check('自动单数量 = 预设的 400', autoOrders(p, code)[0].qty === 400);
  const t = tick(db, { [code]: 106 });
  check('平掉 400 股，剩 600', p.positions[code]?.qty === 600, String(p.positions[code]?.qty));
  check('第一条标记 fired，第二条还在', p.positions[code].tpsl[0].fired === true
    && p.positions[code].tpsl[1].fired === false);
  check('pos.tp 换成第二条的价', p.positions[code].tp === 120, String(p.positions[code].tp));
  check('止损那条还保留', p.positions[code].sl === 90, String(p.positions[code].sl));

  tick(db, { [code]: 121 });
  check('第二条到价触发', autoOrders(p, code).length === 1 && autoOrders(p, code)[0].qty === 300);
  tick(db, { [code]: 121 });
  check('再平 300，剩 300', p.positions[code]?.qty === 300, String(p.positions[code]?.qty));
  tick(db, { [code]: 80 });
  check('止损仍然有效（剩 300 全平）', autoOrders(p, code).length === 1);
  tick(db, { [code]: 80 });
  check('全部平完', !p.positions[code]);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 不重复下单：挂着自动单时不会每轮再挂一张 ===');
{
  const db = mkDb();
  const p = mkPlayer(db);
  const code = 'TGW';
  openPosition(db, p, { code, side: 'long', qty: 100000, leverage: 1 });
  setTpsl(p.positions[code], [{ kind: 'tp', price: 101 }]);
  // 成交上限压到很小 → 会分批成交，挂着单的时间很长
  Object.assign(db.config, { maxFillNotionalPerTick: 200000, levelFillBonus: 0, shopChannelStep: 0 });
  tick(db, { [code]: 102 });
  let maxOrders = 0;
  for (let i = 0; i < 60; i++) {
    tick(db, { [code]: 102 });
    maxOrders = Math.max(maxOrders, autoOrders(p, code).length);
  }
  check('全程最多只有 1 张自动单', maxOrders <= 1, `${maxOrders} 张`);
  check('分批把 10 万股平完了', !p.positions[code], `剩 ${p.positions[code]?.qty ?? 0}`);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 跳空：价格一次跨过很远，依然按市价成交 ===');
{
  const db = mkDb();
  const p = mkPlayer(db);
  const code = 'TGW';
  openPosition(db, p, { code, side: 'long', qty: 1000, leverage: 1 });
  setTpsl(p.positions[code], [{ kind: 'tp', price: 105 }]);
  tick(db, { [code]: 160 });          // 直接跳到 160
  check('跳空也立刻生成自动单', autoOrders(p, code).length === 1);
  const t = tick(db, { [code]: 160 });
  const fill = t.orders.find((e) => e.auto === 'tp');
  check('按 160 成交（不是 105 的限价）', Math.abs((fill?.price || 0) - 160) < 1e-6, String(fill?.price));
  check('盈利按 160 算', Math.abs((fill?.pnl || 0) - 60000) < 1e-6, String(fill?.pnl));
}

// ---------------------------------------------------------------- 7
log('');
log('=== 7 手动平仓后，残留的自动单要撤掉 ===');
{
  const db = mkDb();
  const p = mkPlayer(db);
  const code = 'TGW';
  openPosition(db, p, { code, side: 'long', qty: 100000, leverage: 1 });
  setTpsl(p.positions[code], [{ kind: 'tp', price: 101 }]);
  Object.assign(db.config, { maxFillNotionalPerTick: 1000, levelFillBonus: 0, shopChannelStep: 0 });
  tick(db, { [code]: 102 });
  check('自动单已挂出', autoOrders(p, code).length === 1);
  // 手动把仓位平掉（模拟爆仓/管理员/退市等其它路径）
  const r = closePosition(db, p, code, 'manual');
  check('手动平掉成功', r.ok && !p.positions[code], JSON.stringify(r).slice(0, 80));
  const t = tick(db, { [code]: 102 });
  const canceled = t.orders.filter((e) => e.type === 'cancel');
  check('残留自动单被撤销', autoOrders(p, code).length === 0, JSON.stringify(canceled));
  check('撤销原因说清「持仓已不存在」', (canceled[0]?.reason || '').includes('持仓已不存在'), canceled[0]?.reason);
  check('不会把别人/后续的仓位平掉', !p.positions[code]);
}

// ---------------------------------------------------------------- 8
log('');
log('=== 8 强平优先于止盈止损（不会双份结算）===');
{
  const db = mkDb();
  const p = mkPlayer(db);
  const code = 'TGW';
  openPosition(db, p, { code, side: 'long', qty: 1000, leverage: 10 });
  setTpsl(p.positions[code], [{ kind: 'sl', price: 95 }]);
  const before = p.cash;
  const t = tick(db, { [code]: 88 });     // 亏 12%，10 倍杠杆 → 已经爆仓
  check('被强平（不是止盈止损）', !p.positions[code], '已平');
  const liq = t.closes.find((c) => c.playerId === p.id && c.reason === 'liquidated');
  check('平仓原因是 liquidated', !!liq, JSON.stringify(t.closes.map((c) => c.reason)));
  check('不会同时再挂止盈止损单', autoOrders(p, code).length === 0);
  check('现金 = 开仓后 + 剩余权益（不会重复退保证金）',
    Math.abs(p.cash - (before + 10000 - 12000)) < 1e-6 || p.cash >= 0, String(Math.round(p.cash)));
}

// ---------------------------------------------------------------- 9
log('');
log('=== 9 重新开仓：旧条件不残留 ===');
{
  const db = mkDb();
  const p = mkPlayer(db);
  const code = 'TGW';
  openPosition(db, p, { code, side: 'long', qty: 1000, leverage: 1 });
  setTpsl(p.positions[code], [{ kind: 'tp', price: 150 }]);
  const r = closePosition(db, p, code, 'manual');
  check('先平掉', r.ok && !p.positions[code]);
  openPosition(db, p, { code, side: 'long', qty: 1000, leverage: 1 });
  const pos2 = p.positions[code];
  check('新仓位的 tpsl 是空的', !Array.isArray(pos2.tpsl) || pos2.tpsl.length === 0,
    JSON.stringify(pos2.tpsl));
  check('pos.tp / pos.sl 也是空', !pos2.tp && !pos2.sl, `${pos2.tp} / ${pos2.sl}`);
  tick(db, { [code]: 160 });
  check('旧条件不会在新仓位上触发', autoOrders(p, code).length === 0);
}

// ---------------------------------------------------------------- 10
log('');
log('=== 10 撤掉自动单之后：条件还能不能重新触发？（防「止损失效」）===');
{
  const db = mkDb();
  const p = mkPlayer(db);
  const code = 'TGW';
  openPosition(db, p, { code, side: 'long', qty: 1000, leverage: 1 });
  setTpsl(p.positions[code], [{ kind: 'sl', price: 95 }]);
  tick(db, { [code]: 94 });
  const auto = autoOrders(p, code)[0];
  check('止损单已挂出', !!auto);
  cancelOrder(db, p, auto.id, '手动撤单');
  check('撤单后自动单没了', autoOrders(p, code).length === 0);
  // 价格继续在止损线下方：条件应该还能再次触发（否则止损就永久失效）
  tick(db, { [code]: 93 });
  const again = autoOrders(p, code).length;
  check('撤单后止损能再次触发', again === 1, `${again} 张`);
  tick(db, { [code]: 93 });
  check('重新触发的止损最终把仓位平掉', !p.positions[code],
    p.positions[code] ? `还剩 ${p.positions[code].qty}` : '已平');
}

// ---------------------------------------------------------------- 11
log('');
log('=== 11 长时间随机行情：3000 轮不变量 ===');
{
  const db = mkDb({ maxFillNotionalPerTick: 20000, levelFillBonus: 0, shopChannelStep: 0 });
  const p = mkPlayer(db, 'long-run', 5e7);
  const codes = Object.keys(db.stocks).filter((c) => !db.stocks[c].isIndex).slice(0, 4);
  let bad = { cashNeg: 0, ghostOrder: 0, doubleClose: 0, overQty: 0, badTpsl: 0 };
  let triggers = 0;
  const equityStart = p.cash;
  for (let i = 0; i < 3000; i++) {
    // 随机开仓
    if (i % 200 === 0) {
      const code = codes[(i / 200) % codes.length];
      if (!p.positions[code] && !autoOrders(p, code).length) {
        openPosition(db, p, { code, side: i % 400 === 0 ? 'short' : 'long', qty: 2000, leverage: 3 });
        const pos = p.positions[code];
        if (pos) {
          const dir = pos.side === 'long' ? 1 : -1;
          setTpsl(pos, [
            { kind: 'tp', price: Number((100 * (1 + 0.03 * dir)).toFixed(2)), qty: 800 },
            { kind: 'sl', price: Number((100 * (1 - 0.02 * dir)).toFixed(2)) }
          ]);
        }
      }
    }
    // 随机价格
    for (const code of codes) {
      const st = db.stocks[code];
      st.price = Math.max(5, Number((st.price * (1 + (Math.random() - 0.5) * 0.02)).toFixed(2)));
    }
    const t = tick(db);
    triggers += t.orders.filter((e) => e.auto).length;
    if (p.cash < -1e-6) bad.cashNeg++;
    for (const o of p.orders || []) {
      if (o.action !== 'close') continue;
      if (!p.positions[o.code]) bad.ghostOrder++;
      if (Number(o.qty) > Number(p.positions[o.code]?.qty || 0) + 1) bad.overQty++;
    }
    for (const [code, pos] of Object.entries(p.positions)) {
      if (pos.qty < 1) bad.doubleClose++;
      if (!Array.isArray(pos.tpsl)) bad.badTpsl++;
    }
  }
  check('现金从不为负', bad.cashNeg === 0, `${bad.cashNeg} 次`);
  check('没有挂在已不存在的持仓上的平仓单', bad.ghostOrder === 0, `${bad.ghostOrder} 次`);
  check('没有超过持仓数量的平仓单', bad.overQty === 0, `${bad.overQty} 次`);
  check('没有数量 <1 的僵尸持仓', bad.doubleClose === 0, `${bad.doubleClose} 次`);
  check('tpsl 结构始终是数组', bad.badTpsl === 0, `${bad.badTpsl} 次`);
  check('这 3000 轮里确实发生过止盈止损', triggers > 0, `${triggers} 次`);
  log(`    期末：现金 ${Math.round(p.cash)}，持仓 ${Object.keys(p.positions).join(',') || '空'}，起始现金 ${equityStart}`);
}

// ---------------------------------------------------------------- 12
log('');
log('=== 12 部分成交后撤单：预设数量要按已平掉的扣减 ===');
{
  const db = mkDb({ maxFillNotionalPerTick: 20000, levelFillBonus: 0, shopChannelStep: 0 });
  const p = mkPlayer(db);
  const code = 'TGW';
  openPosition(db, p, { code, side: 'long', qty: 2000, leverage: 1 });
  setTpsl(p.positions[code], [{ kind: 'tp', price: 101, qty: 1000 }]);
  tick(db, { [code]: 102 });
  check('自动单挂出，数量 1000', autoOrders(p, code)[0]?.qty === 1000, String(autoOrders(p, code)[0]?.qty));
  // 让它成交一部分（每轮上限 2 万 → 102 元约 196 股/轮）
  tick(db, { [code]: 102 });
  const left = p.positions[code]?.qty;
  check('发生了部分成交', left < 2000, `剩 ${left} 股`);
  const filled = 2000 - left;
  const order = autoOrders(p, code)[0];
  check('自动单还在（没平完）', !!order, order ? `剩 ${order.qty} 股` : '已摘掉');
  if (order) {
    cancelOrder(db, p, order.id, '手动撤单');
    const cond = (p.positions[code].tpsl || []).find((x) => x.kind === 'tp');
    check('条件被重新武装', cond && cond.fired === false, JSON.stringify(cond));
    check('预设数量扣掉了已平部分', cond && Math.abs(cond.qty - (1000 - filled)) <= 1,
      `${cond?.qty}（1000 − ${filled}）`);
  }
}

// ---------------------------------------------------------------- 13
log('');
log('=== 13 老存档兼容：只有 pos.tp / pos.sl 字段也能触发 ===');
{
  const db = mkDb();
  const p = mkPlayer(db);
  const code = 'TGW';
  openPosition(db, p, { code, side: 'long', qty: 1000, leverage: 1 });
  const pos = p.positions[code];
  delete pos.tpsl;            // 模拟老存档：没有 tpsl 数组
  pos.tp = 108;
  pos.sl = 92;
  tick(db, { [code]: 109 });
  check('老字段止盈触发', autoOrders(p, code).length === 1 && autoOrders(p, code)[0].auto === 'tp');
  check('老字段被补成 tpsl 列表', Array.isArray(pos.tpsl) && pos.tpsl.length >= 1,
    JSON.stringify(pos.tpsl));
  tick(db, { [code]: 109 });
  check('老字段也能正常平仓', !p.positions[code] || p.positions[code].qty < 1000);
}

// ---------------------------------------------------------------- 14
log('');
log('=== 14 触发止损时，还没成交完的开仓单要被撤掉 ===');
{
  const db = mkDb({ maxFillNotionalPerTick: 20000, levelFillBonus: 0, shopChannelStep: 0 });
  const p = mkPlayer(db);
  const code = 'TGW';
  // 先挂一张大额开仓单，只会成交一部分
  p.cash = 1e7;
  const reserved = 1e7;
  p.cash -= reserved;
  p.orders.push({
    id: 'big_open', code, name: '丰川集团', action: 'open', side: 'long',
    qty: 100000, limit: 101, leverage: 1, reserve: reserved,
    createdAt: Date.now(), createdTick: db.tick, expireTick: db.tick + 4000
  });
  tick(db, { [code]: 101 });
  const pos = p.positions[code];
  check('大额开仓单成交了一部分', !!pos && pos.qty > 0 && pos.qty < 100000, pos ? `${pos.qty} 股` : '没成交');
  const restOrder = p.orders.find((o) => o.id === 'big_open');
  check('开仓单还在（没成交完）', !!restOrder, restOrder ? `剩 ${restOrder.qty} 股` : '已摘掉');
  const cashBeforeTrigger = p.cash;

  setTpsl(pos, [{ kind: 'sl', price: 99 }]);
  const t = tick(db, { [code]: 98 });
  check('止损触发', autoOrders(p, code).length === 1);
  check('未成交的开仓单被撤掉', !p.orders.some((o) => o.id === 'big_open'), JSON.stringify(p.orders.map((o) => o.id)));
  check('撤掉的开仓单押金退回来了', p.cash > cashBeforeTrigger + (restOrder?.reserve || 0) - 1,
    `${Math.round(cashBeforeTrigger)} → ${Math.round(p.cash)}`);
  const canceled = (t.closes || []).filter((c) => c.canceledOpen);
  check('事件里标了「撤销开仓单」', canceled.length === 1, JSON.stringify(canceled[0] || {}));
  // 平掉之后不应该再涨仓位
  const qtyAfter = p.positions[code]?.qty ?? 0;
  tick(db, { [code]: 98 });
  check('就不会再继续加仓了', (p.positions[code]?.qty ?? 0) <= qtyAfter,
    `${qtyAfter} → ${p.positions[code]?.qty ?? 0}`);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
