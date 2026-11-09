// 自动定投（Lv.2 道具）回归
//
//   node tests/auto-dca.mjs
//
// 只 import src/*，不读写 data/db.json。

import { createDb } from '../src/store.js';
import { autoDcaTick, autoDcaPlan, AUTO_DCA_CODE } from '../src/autoDca.js';
import { processOrders, estimateReserve } from '../src/orders.js';
import { playerEquity } from '../src/trading.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const PRICE = 2178;
const BANK_CAP = 72000;   // workRate 50 × workBankTicks 1440

function newDb() {
  const db = createDb();
  db.tick = 100;
  Object.assign(db.config, {
    marketCycleEnabled: 0,   // 测试里别被「夜间休市」拦住
    feeRate: 0.0005,
    stampDuty: 0.0005,
    impactCostCoef: 0,
    playerImpactEnabled: 0,
    workRatePerTick: 50,
    workBankTicks: 1440,
    shopAutoDcaPrice: 5000000,
    shopAutoDcaPremium: 0.03,
    maxFillNotionalPerTick: 1000000,
    maxPendingOrders: 5
  });
  for (const st of Object.values(db.stocks)) { st.price = PRICE; st.fair = PRICE; }
  return db;
}

function mkPlayer(db, id, extra = {}) {
  db.players[id] = {
    id, nickname: id, cash: 0, positions: {}, orders: [],
    level: 2, workBank: 0, autoDca: true, autoDcaOn: true,
    ...extra
  };
  return db.players[id];
}

// ---------------------------------------------------------------- 1
log('=== 1 挂单计划：现价 +3%，股数按挂单价算 ===');
{
  const db = newDb();
  const p = autoDcaPlan(db, BANK_CAP);
  const wantLimit = Math.round(PRICE * 1.03 * 100) / 100;
  check('标的是 DENG', p.code === AUTO_DCA_CODE && p.code === 'DENG');
  check('挂单价 = 现价 ×1.03', near(p.limit, wantLimit), `limit=${p.limit}`);
  check('股数 = 存款 ÷ 挂单价', p.qty === Math.floor(BANK_CAP / wantLimit), `qty=${p.qty}`);
  check('钱袋 72000 大约买 32 股', p.qty === 32, `${p.qty} 股`);

  const d2 = newDb();
  d2.config.shopAutoDcaPremium = 0.1;
  check('溢价可调（0.1 → ×1.1）', near(autoDcaPlan(d2, BANK_CAP).limit, Math.round(PRICE * 1.1 * 100) / 100));

  // 押金含冲击成本时，股数要自动回缩到「钱袋一定付得起」
  const d3 = newDb();
  d3.config.impactCostCoef = 6;
  d3.config.playerImpactRef = 1000;      // 人为放大冲击成本
  d3.config.playerImpactStrength = 0.01;
  const plan3 = autoDcaPlan(d3, BANK_CAP);
  check('冲击成本大时股数回缩', plan3.qty < 32 && plan3.qty > 0, `qty=${plan3.qty}`);
  check('回缩后押金不超钱袋',
    estimateReserve(d3, d3.stocks.DENG, plan3.limit, plan3.qty, 1, 'long') <= BANK_CAP + 1e-6,
    `need=${estimateReserve(d3, d3.stocks.DENG, plan3.limit, plan3.qty, 1, 'long').toFixed(2)}`);
}

// ---------------------------------------------------------------- 2
log('');
log('=== 2 触发条件 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'a', { workBank: BANK_CAP - 1 });
  autoDcaTick(db, BANK_CAP);
  check('没攒满不触发', p.orders.length === 0 && p.workBank === BANK_CAP - 1);

  p.workBank = BANK_CAP;
  autoDcaTick(db, BANK_CAP);
  check('攒满 → 自动挂出一张单', p.orders.length === 1, `orders=${p.orders.length}`);
  check('单子标记为定投', p.orders[0].autoDca === true);
  check('钱袋清空（相当于自动收钱）', p.workBank === 0, `workBank=${p.workBank}`);
  check('挂单价 / 股数正确', near(p.orders[0].limit, Math.round(PRICE * 1.03 * 100) / 100) && p.orders[0].qty === 32,
    `limit=${p.orders[0].limit} qty=${p.orders[0].qty}`);

  // 上一张还没成交时不重复挂
  autoDcaTick(db, BANK_CAP);
  check('已有一张定投单时不重复挂', p.orders.length === 1);
}

// ---------------------------------------------------------------- 3
log('');
log('=== 3 开关 / 没买 / 离线 ===');
{
  const db = newDb();
  const off = mkPlayer(db, 'off', { workBank: BANK_CAP, autoDcaOn: false });
  autoDcaTick(db, BANK_CAP);
  check('暂停时不挂单', off.orders.length === 0 && off.workBank === BANK_CAP);

  const none = mkPlayer(db, 'none', { workBank: BANK_CAP, autoDca: false });
  autoDcaTick(db, BANK_CAP);
  check('没买这件道具不挂单', none.orders.length === 0);

  // 离线：整段逻辑不看在线状态
  const idle = mkPlayer(db, 'idle', { workBank: BANK_CAP, workOnline: false });
  autoDcaTick(db, BANK_CAP);
  check('离线玩家同样生效', idle.orders.length === 1, `orders=${idle.orders.length}`);
}

// ---------------------------------------------------------------- 4
log('');
log('=== 4 挂不上时把钱还回去 ===');
{
  const db = newDb();
  // 故意给一个反向持仓，placeLimitOrder 会拒绝（还是反向持仓，先平掉再挂）
  const p = mkPlayer(db, 'rev', {
    workBank: BANK_CAP,
    cash: 1234,
    positions: { [AUTO_DCA_CODE]: { code: AUTO_DCA_CODE, side: 'short', qty: 1, entry: PRICE, margin: PRICE, leverage: 1, openedTick: 90 } }
  });
  const beforeCash = p.cash;
  const runs = autoDcaTick(db, BANK_CAP);
  check('下单被拒（反向持仓）', runs.length === 1 && runs[0].ok === false, runs[0]?.reason || '');
  check('钱袋原样退回', p.workBank === BANK_CAP, `workBank=${p.workBank}`);
  check('现金没被动', p.cash === beforeCash, `cash=${p.cash}`);
  check('没有挂单残留', p.orders.length === 0);
}

// ---------------------------------------------------------------- 5
log('');
log('=== 5 不占用玩家的手动挂单名额 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'full', { workBank: BANK_CAP, cash: 1e8 });
  // 先塞满 5 张手动单（不同标的）
  const codes = ['TGW', 'LU', 'NW', 'XJ', 'DFY'];
  for (const c of codes) {
    p.orders.push({ id: 'm_' + c, code: c, name: c, action: 'open', side: 'long', qty: 1, limit: PRICE * 2, leverage: 1, reserve: 0, createdAt: Date.now(), createdTick: 90, expireTick: 9999 });
  }
  check('手动名额已满（5 张）', p.orders.length === 5);
  const runs = autoDcaTick(db, BANK_CAP);
  check('定投单仍然挂得出去（系统单不吃名额）', runs.length === 1 && runs[0].ok === true, runs[0]?.reason || '');
  check('总挂单变成 6 张', p.orders.length === 6, `orders=${p.orders.length}`);
}

// ---------------------------------------------------------------- 6
log('');
log('=== 6 下一轮按市价成交，押金差额退回 ===');
{
  const db = newDb();
  const p = mkPlayer(db, 'a', { workBank: BANK_CAP });
  const cashBefore = p.cash;           // 收钱之前的现金（这里就是 0）
  autoDcaTick(db, BANK_CAP);
  const order = p.orders[0];
  const reserve = Number(order.reserve);
  check('押金按挂单价冻结', near(reserve, 32 * Math.round(PRICE * 1.03 * 100) / 100 * (1 + 0.0005), 1e-3), `reserve=${reserve.toFixed(2)}`);

  db.tick += 1;
  const ev = processOrders(db);
  check('下一轮成交', ev.some((e) => e.type === 'fill'), JSON.stringify(ev.map((e) => e.type)));
  check('成交价是市价，不是挂单价', ev[0].price === PRICE, `price=${ev[0].price}`);
  check('持仓 32 股 DENG', p.positions.DENG?.qty === 32, `qty=${p.positions.DENG?.qty}`);
  check('定投单已出队', p.orders.filter((o) => o.autoDca).length === 0);
  const actualCost = 32 * PRICE * (1 + 0.0005);
  check('现金 = 收钱前 + 钱袋 - 实际成本（押金差额退回）',
    near(p.cash, cashBefore + BANK_CAP - actualCost, 1e-3),
    `cash=${p.cash.toFixed(2)} 期望=${(cashBefore + BANK_CAP - actualCost).toFixed(2)}`);
  // 只被收了一次开仓手续费（押金里的手续费只是冻结，成交后按实际重算）
  check('总资产 = 钱袋 - 一次手续费',
    near(playerEquity(db, p), cashBefore + BANK_CAP - 32 * PRICE * 0.0005, 1e-3),
    `equity=${playerEquity(db, p).toFixed(2)}`);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
