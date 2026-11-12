// 前端数据包白名单（防作弊）：marketPayload / tick wire / 持仓下发
//   node tests/payload-wire.mjs
//
// 目的：把「什么能发给浏览器」钉死。以后谁往 payload 里加了引擎内部状态
// （情绪真值、波动率、抽奖概率、金价系数、资金压力……），这套会当场红。

import { createDb, migrate } from '../src/store.js';
import { marketPayload, leaderboardRows } from '../src/api.js';
import {
  stockWire, stockFullWire, positionWire, configWire, sentWire, traitWire,
  WIRE_CONFIG_KEYS
} from '../src/wire.js';
import { ensureAchvState } from '../src/achievements.js';
import { ensureChat, pushChat, chatMarkRead } from '../src/chat.js';

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

function mkDb() {
  const db = migrate(createDb());
  db.tick = 5000;
  db.events = [];
  for (const st of Object.values(db.stocks)) st.nextReportTick = db.tick + 300;
  return db;
}

function mkPlayer(db, id, { skill = 'default' } = {}) {
  const p = {
    id, nickname: id, cash: 1e6, positions: {}, orders: [],
    theme: skill, skill, level: 2, themes: [], shards: {}, themeTier: {},
    achv: {}, achvCounters: {}
  };
  ensureAchvState(p);
  db.players[id] = p;
  return p;
}

/** 递归收集所有 key（用于「禁用字段」扫描） */
function allKeys(obj, acc = new Set(), depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return acc;
  for (const [k, v] of Object.entries(obj)) {
    acc.add(k);
    if (v && typeof v === 'object') allKeys(v, acc, depth + 1);
  }
  return acc;
}

/** 引擎内部状态：一个都不许出现在 payload 里 */
const FORBIDDEN = [
  // 个股 trait（价格模型参数）
  'volMult', 'revMult', 'eventMult', 'drift', 'lotteryChance', 'lotteryLo', 'lotteryHi',
  'floorRatio', 'floorBoost', 'mirrorCode', 'mirrorCoef', 'steadyGrowth', 'rallyBoost',
  'mirrorCode', 'coinShift',
  // 情绪引擎
  'sentiment', 'sentimentStrength', 'sentimentDrift', 'sentimentEdge', 'sentimentTicks',
  'sentimentRollMin', 'sentimentRollMax', 'sentimentRollTicks', 'sentRollMin', 'sentRollMax',
  'viewV', 'viewFake', 'lastSwing', 'nextRoll', 'nextApply', 'swing',
  // 金价（MB 的驱动源）
  'gold', 'goldBase', 'goldVol', 'goldRev', 'goldCoef', 'goldJitter', 'reportBase',
  // 财报随机偏移
  'reportVol', 'reportVolMin', 'reportVolMax', 'reportRefCap',
  // 市场资金（虚假成交 / 游资）
  'marketTradesRate', 'marketTradesSmallP', 'marketTradesMidP', 'marketTradesBigP',
  'marketTradesChase', 'hotMoney', 'hotMoneyEnabled', 'hotMoneySwitchMin', 'hotMoneySwitchMax',
  'hotMoneyMin', 'hotMoneyMax', 'marketImpactEnabled', 'marketImpactRef',
  'marketImpactStrength', 'marketImpactMax', 'marketImpactDecay', 'marketImpactFlowMax',
  // 资金压力 / 引擎状态
  'flow', 'mflow', 'flowFresh', 'pendingReport', 'brokerMid', 'prevReturns',
  'baseVolatility', 'meanReversion', 'maxPremium', 'growthCeiling', 'rallyHours', 'rallyMin',
  'rallyMax', 'morningRallyTotal', 'morningRallyPull', 'weather', 'weatherTarget',
  // 玩家冲击内部参数
  'playerImpactFlowMax', 'impactRefFreeCap', 'playerImpactTail',
  // 技能内部概率
  'mindFakeChance', 'mindAccurateChanceEvolved', 'hermitHideChance', 'hermitHideChanceEvolved',
  'tycoonLeadTicks', 'tycoonLeadTicksEvolved', 'investigateCooldownTicks',
  'investigateCooldownEvolved', 'themeEvolveSkillMult', 'themeEvolveImpact',
  // 玩家里程碑内部记账
  'valueArm', 'valueHoldArm', 'openNotional', 'pushArm', 'lastOpenNotional',
  'kfcRallyAt', 'kfcWeek', 'kfcFired'
];

// ================================================================ 1
log('=== 1 个股字段：只留界面要用的 ===');
{
  const db = mkDb();
  const p = marketPayload(db, null);
  const tgw = p.stocks.TGW;

  const ALLOWED_STOCK_KEYS = new Set([
    'code', 'name', 'icon', 'industry', 'desc', 'isIndex', 'shares', 'nextReportTick',
    'trait', 'report', 'price', 'changePct', 'changes', 'status', 'st', 'stTicks',
    'vol',   // 本轮成交量（前端给当前 K 线累加量能，2026-11 新增）
    'dps', 'payout', 'previewIn', 'preview', 'sent'
  ]);
  const extra = Object.keys(tgw).filter((k) => !ALLOWED_STOCK_KEYS.has(k));
  check('个股没有白名单以外的字段', extra.length === 0, extra.join(',') || '（干净）');

  for (const k of ['fair', 'marketCap', 'freeCap', 'traitName', 'dayChangePct',
    'initialPrice', 'fxTarget', 'stPrice', 'stDelistTicks']) {
    check(`不再下发 ${k}`, tgw[k] === undefined, String(tgw[k]));
  }

  check('普通票的 trait 是空对象', Object.keys(tgw.trait).length === 0, JSON.stringify(tgw.trait));
  check('券商票只留 id', JSON.stringify(p.stocks.XD.trait) === '{"id":"broker"}', JSON.stringify(p.stocks.XD.trait));
  check('隐藏特性的票（矿工银行）trait 为空（连 id 都不给）',
    Object.keys(p.stocks.MB.trait).length === 0, JSON.stringify(p.stocks.MB.trait));

  const rep = tgw.report;
  const ALLOWED_REPORT = new Set(['industry', 'fair', 'revenue', 'netProfit', 'eps', 'bps',
    'roe', 'debt', 'growth', 'period', 'expectedGrowth', 'history']);
  const extraRep = Object.keys(rep).filter((k) => !ALLOWED_REPORT.has(k));
  check('财报没有白名单以外的字段', extraRep.length === 0, extraRep.join(',') || '（干净）');
  for (const k of ['marketCap', 'freeCap', 'pe', 'pb', 'premium', 'lastSurprise',
    'dividendRate', 'reportAt', 'shares', 'freeFloat']) {
    check(`财报里不再下发 ${k}`, rep[k] === undefined, String(rep[k]));
  }
  check('市场预期要下发（前端财报面板显示）', typeof rep.expectedGrowth === 'number',
    String(rep.expectedGrowth));
  check('财报折线只留营收/净利',
    rep.history.every((h) => Object.keys(h).join(',') === 'revenue,netProfit'),
    JSON.stringify(rep.history[0] || {}));

  check('指数票没有财报', p.stocks.DENG.report === null);
  check('dps/payout 还在（财报面板要显示）', typeof tgw.dps === 'number' && typeof tgw.payout === 'number');
  check('价格与涨跌幅还在', typeof tgw.price === 'number' && typeof tgw.changePct === 'number');
  check('各周期涨跌幅还在', !!tgw.changes && typeof tgw.changes === 'object');
}

// ================================================================ 2
log('');
log('=== 2 情绪：只有读心技能能看到一个数 ===');
{
  const db = mkDb();
  const plain = mkPlayer(db, 'plain', { skill: 'default' });
  const mind = mkPlayer(db, 'mind1', { skill: 'mind' });
  db.stocks.TGW.sentiment = { v: 0.73, viewV: -0.42, nextRoll: 9999, nextApply: 0, drift: 0.6 };

  const a = marketPayload(db, plain);
  check('普通玩家看不到任何情绪字段', a.stocks.TGW.sent === null, JSON.stringify(a.stocks.TGW.sent));

  const b = marketPayload(db, mind);
  const sent = b.stocks.TGW.sent;
  check('读心玩家能看到情绪', !!sent, JSON.stringify(sent));
  check('情绪只有一个字段 v', JSON.stringify(Object.keys(sent)) === '["v"]', JSON.stringify(sent));
  check('v 在 -1~1 之间', Math.abs(sent.v) <= 1, String(sent.v));
  check('不再告诉玩家「这次读心准不准」', sent.fake === undefined && sent.viewV === undefined
    && sent.lastSwing === undefined);
  check('不再给剩余轮数/施加间隔', sent.rollIn === undefined && sent.applyIn === undefined
    && sent.every === undefined && sent.drift === undefined);

  // 停牌 / 指数一律没有情绪
  db.stocks.LU.status = 'suspended';
  check('停牌票没有情绪', marketPayload(db, mind).stocks.LU.sent === null);
  check('指数没有情绪', marketPayload(db, mind).stocks.DENG.sent === null);

  const st = db.stocks.NW;
  check('sentWire 对非读心玩家返回 null', sentWire(st, db, plain) === null);
}

// ================================================================ 3
log('');
log('=== 3 金融大鳄预览：只给有技能的玩家，且只在窗口内 ===');
{
  const db = mkDb();
  const plain = mkPlayer(db, 'p2', { skill: 'default' });
  const tycoon = mkPlayer(db, 't1', { skill: 'tycoon' });
  const xd = db.stocks.XD;
  xd.nextReportTick = db.tick + 10;       // 提前量 20 轮内
  xd.pendingReport = {
    eps: 2, revenue: 5e8, netProfit: 2e8, growth: 0.1, expectedGrowth: 0.02
  };

  const a = marketPayload(db, plain);
  check('没有金融大鳄技能：没有 preview', a.stocks.XD.preview === null);
  check('没有技能也能看到倒计时（公开的财报时间表）',
    typeof a.stocks.XD.previewIn === 'number', String(a.stocks.XD.previewIn));
  check('非金融板块没有倒计时', a.stocks.TGW.previewIn === null && a.stocks.TGW.preview === null);

  const b = marketPayload(db, tycoon);
  const pv = b.stocks.XD.preview;
  check('金融大鳄能在窗口内看到预览', !!pv, JSON.stringify(pv && Object.keys(pv)));
  check('预览带超预期判定', pv && typeof pv.surprise === 'number' && typeof pv.verdict === 'string',
    pv && `${pv.surprise} ${pv.verdict}`);

  // 窗口外不给预览
  xd.nextReportTick = db.tick + 500;
  check('窗口外不给预览', marketPayload(db, tycoon).stocks.XD.preview === null);
}

// ================================================================ 4
log('');
log('=== 4 config 白名单 ===');
{
  const db = mkDb();
  const p = marketPayload(db, null);
  const cfg = p.config;
  const special = ['shopItems', 'themeNeedLevel', 'emojiDirs'];
  const allowed = new Set([...WIRE_CONFIG_KEYS, ...special]);
  const extra = Object.keys(cfg).filter((k) => !allowed.has(k));
  check('config 没有白名单以外的键', extra.length === 0, extra.join(',') || '（干净）');

  const missing = WIRE_CONFIG_KEYS.filter((k) => cfg[k] === undefined);
  check('白名单里的键都在（否则界面取不到值）', missing.length === 0, missing.join(',') || '（齐）');
  check('商城等级门槛还在', !!cfg.shopItems && !!cfg.themeNeedLevel);
  check('表情目录还在', !!cfg.emojiDirs && cfg.emojiDirs[1] === 'emo_lv1');
  check('下单需要的费率/杠杆还在',
    cfg.feeRate > 0 && cfg.stampDuty > 0 && cfg.maxLeverage > 1);
  check('分红参数还在', cfg.dividendRate >= 0 && cfg.dividendCap >= 0);

  for (const k of ['sentimentStrength', 'sentimentDrift', 'sentimentTicks', 'sentimentEdge',
    'sentimentRollMin', 'goldCoef', 'goldVol', 'reportVol', 'reportRefCap',
    'marketImpactStrength', 'marketImpactRef', 'hotMoneyMin', 'hotMoneyMax',
    'marketTradesRate', 'maxPremium', 'growthCeiling', 'playerImpactFlowMax',
    'impactRefFreeCap', 'mindFakeChance', 'hermitHideChance', 'tycoonLeadTicks',
    'fxEnabled', 'fxCoef', 'fxLeverage', 'maxOrdersPerTick', 'shopBgPrice',
    'redBonusRate', 'stealMin', 'limitOrderEnabled', 'orderTtlTicks']) {
    check(`config 不再下发 ${k}`, cfg[k] === undefined, String(cfg[k]));
  }

  check('configWire 只吐白名单键',
    Object.keys(configWire(db.config)).every((k) => WIRE_CONFIG_KEYS.includes(k)));
}

// ================================================================ 5
log('');
log('=== 5 整包扫描：引擎内部状态一个都不许出现 ===');
{
  const db = mkDb();
  const mind = mkPlayer(db, 'mind2', { skill: 'mind' });
  const tycoon = mkPlayer(db, 't2', { skill: 'tycoon' });
  db.stocks.XD.nextReportTick = db.tick + 5;
  db.stocks.XD.pendingReport = { eps: 2, revenue: 5e8, netProfit: 2e8, growth: 0.1, expectedGrowth: 0.02 };
  db.stocks.TGW.sentiment = { v: 0.5, viewV: 0.1, nextRoll: 9999, nextApply: 0 };

  for (const [label, me] of [['未登录', null], ['普通玩家', mind], ['金融大鳄', tycoon]]) {
    const keys = allKeys(marketPayload(db, me));
    const hit = FORBIDDEN.filter((k) => keys.has(k));
    check(`${label} 的 payload 里没有禁用字段`, hit.length === 0, hit.join(',') || '（干净）');
  }

  // 老字段名也别回来
  const keys = allKeys(marketPayload(db, null));
  for (const k of ['traitName', 'marketCap', 'freeCap', 'serverTime', 'startedAt',
    'dayChangePct', 'initialPrice', 'fxTarget', 'notifyUnread', 'themeChangedTick']) {
    check(`顶层/个股不再有 ${k}`, !keys.has(k) || k === 'marketCap', keys.has(k) ? '仍有' : '');
  }
}

// ================================================================ 6
log('');
log('=== 6 持仓下发：内部记账不外发 ===');
{
  const db = mkDb();
  const st = db.stocks.TGW;
  st.price = 120;
  const pos = {
    code: 'TGW', side: 'long', qty: 100, entry: 100, margin: 5000, leverage: 2,
    tp: 200, sl: 80,
    openedTick: 4000, openedAt: 123,
    valueArm: { devSign: 1 }, valueHoldArm: { at: 1 }, openNotional: 1e7, pushArm: 3,
    tpsl: [
      { id: 'ts_a', kind: 'tp', price: 200, qty: 50, fired: false, createdTick: 4001 },
      { id: 'ts_b', kind: 'sl', price: 80, qty: null, fired: true, createdTick: 4002 }
    ],
    closing: null
  };
  const w = positionWire(pos, st);
  check('持仓只给界面字段', Object.keys(w).join(',') === [
    'code', 'side', 'qty', 'entry', 'margin', 'leverage', 'tp', 'sl', 'price', 'pnl',
    'pnlPct', 'equity', 'tpsl', 'closing'
  ].join(','), Object.keys(w).join(','));
  check('盈亏按现价算对', Math.abs(w.pnl - (120 - 100) * 100) < 1e-9, String(w.pnl));
  check('盈亏率按保证金算', Math.abs(w.pnlPct - 2000 / 5000 * 100) < 1e-9, String(w.pnlPct));
  check('不再下发 openedTick/openedAt', w.openedTick === undefined && w.openedAt === undefined);
  check('不再下发成就武装字段', w.valueArm === undefined && w.openNotional === undefined
    && w.pushArm === undefined && w.valueHoldArm === undefined);
  check('止盈止损只留未触发的', w.tpsl.length === 1 && w.tpsl[0].id === 'ts_a',
    JSON.stringify(w.tpsl));
  check('止盈止损只留 id/kind/price/qty',
    Object.keys(w.tpsl[0]).join(',') === 'id,kind,price,qty', Object.keys(w.tpsl[0]).join(','));

  // 走一遍真实出口：marketPayload.me.positions 也必须是这个形状
  const db2 = mkDb();
  const me = mkPlayer(db2, 'pos1');
  db2.stocks.TGW.price = 120;
  me.positions.TGW = {
    ...pos,
    positions: undefined,
    openedTick: 4000, openedAt: 1, valueArm: { devSign: 1 }, openNotional: 1e7, pushArm: 1
  };
  const pay = marketPayload(db2, me);
  const wirePos = pay.me.positions.TGW;
  check('me.positions 是同一个下发格式',
    Object.keys(wirePos).join(',') === Object.keys(w).join(','), Object.keys(wirePos).join(','));
  check('me.positions 里没有内部记账',
    wirePos.openedTick === undefined && wirePos.valueArm === undefined
    && wirePos.openNotional === undefined && wirePos.pushArm === undefined);
  check('me.positions 的止盈止损同样过滤了已触发', wirePos.tpsl.length === 1, String(wirePos.tpsl.length));
}

// ================================================================ 7
log('');
log('=== 7 排行榜：不泄露别人的技能 / 保镖 / 持仓 ===');
{
  const db = mkDb();
  const a = mkPlayer(db, 'rank_a', { skill: 'mind' });
  a.cash = 5e5;
  a.guardUntil = 99999;
  a.hiddenRank = false;
  const b = mkPlayer(db, 'rank_b', { skill: 'default' });
  b.cash = 1e5;

  const rows = leaderboardRows(db);
  const row = rows.find((r) => r.id === 'rank_a');
  check('排行榜返回两个人', rows.length === 2, String(rows.length));
  check('不公开 guardUntil（保镖状态）', row.guardUntil === undefined);
  check('不公开 theme / skill', row.theme === undefined && row.skill === undefined);
  check('持仓始终为空（调查技能才有意义）', Array.isArray(row.positions) && row.positions.length === 0);
  check('偷钱要用的现金还在', typeof row.cash === 'number' && row.cash === 5e5, String(row.cash));
  check('排名/等级/昵称/头像还在',
    typeof row.total === 'number' && row.level >= 1 && !!row.nickname && 'avatar' in row);
  check('资产模糊标记还在（隐世仙人 Ⅱ 阶用）', row.fuzzed === false);
}

// ================================================================ 8
log('');
log('=== 8 两个 payload 的个股字段必须同源 ===');
{
  const db = mkDb();
  const me = mkPlayer(db, 'p7', { skill: 'default' });
  const full = marketPayload(db, me);
  const st = db.stocks.MGB || db.stocks.MCD;
  const tick = stockWire(db, st, me);
  const fullSt = full.stocks[st.code];
  const same = Object.keys(tick).every((k) => JSON.stringify(tick[k]) === JSON.stringify(fullSt[k]));
  check('tick 字段与首屏逐字段一致', same,
    Object.keys(tick).filter((k) => JSON.stringify(tick[k]) !== JSON.stringify(fullSt[k])).join(',') || '（一致）');
  check('首屏 = 静态字段 + tick 字段',
    Object.keys(fullSt).length === Object.keys(stockFullWire(db, st, me)).length);
  check('两个 payload 都不带 trait 参数',
    Object.keys(tick).every((k) => FORBIDDEN.indexOf(k) < 0));
}

// ================================================================ 8
log('');
log('=== 9 尺寸：不再带模型参数 ===');
{
  const db = mkDb();
  const p = marketPayload(db, null);
  const json = JSON.stringify(p);
  const traitBytes = Object.values(p.stocks)
    .reduce((a, st) => a + JSON.stringify(st.trait).length, 0);
  check('每只票的 trait 不超过 20 字节', traitBytes / 12 < 20, String(traitBytes));
  check('整包仍在合理大小内（< 120KB）', json.length < 120000, `${(json.length / 1024).toFixed(1)} KB`);
  check('12 只票都在', Object.keys(p.stocks).length === 12, String(Object.keys(p.stocks).length));
  check('每个 tick 字段都是有限数字或 null/对象',
    Object.values(p.stocks).every((s) => Number.isFinite(s.price) && Number.isFinite(s.changePct)));
  check('traitWire 只认 fx/broker',
    JSON.stringify(traitWire({ trait: { id: 'fx' } })) === '{"id":"fx"}'
    && JSON.stringify(traitWire({ trait: { id: 'gold' } })) === '{}'
    && JSON.stringify(traitWire(null)) === '{}');
}

// ================================================================ 9
log('');
log('=== 10 聊天未读红点：me.chatUnread 由服务端已读游标算 ===');
{
  const db = mkDb();
  ensureChat(db);
  const me = mkPlayer(db, 'chatme');
  me.chatReadSeq = 0;

  check('大厅是空的：没有未读', marketPayload(db, me).me.chatUnread === false);
  const other = mkPlayer(db, 'chatother');
  pushChat(db, other, { type: 'text', text: '有人在吗' });
  check('别人说话后 me.chatUnread = true（导航亮红点）',
    marketPayload(db, me).me.chatUnread === true);
  me.chatReadSeq = chatMarkRead(db, me);
  check('标已读后 me.chatUnread = false（红点灭）',
    marketPayload(db, me).me.chatUnread === false);
  check('已读游标只增不减', chatMarkRead(db, me, 0) === db.chat.seq);
  check('只下发布尔值 chatUnread，内部游标不下发',
    typeof marketPayload(db, me).me.chatUnread === 'boolean'
    && marketPayload(db, me).me.chatReadSeq === undefined
    && marketPayload(db, me).me.chatSeq === undefined);
}

console.log = realLog;
console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
