/**
 * 前端数据包（wire）—— **什么能发给浏览器，只在这里定义一次**。
 *
 * 背景：以前首屏 `marketPayload` 和每轮 `tickPayload` 各写一份字段表，
 * 两处不一致，而且把引擎内部状态一起抖了出去（例如 `trait.volMult` /
 * `trait.drift` / `trait.lotteryChance` 直接把价格模型的参数报了，
 * F12 一看就知道哪只票多久抽一次奖、波动是几倍）。
 *
 * 现在的原则：
 *   1. **只发界面上真的会画出来的字段**（每加一个字段，先在 public/app.js 里确认有读取）
 *   2. 引擎内部状态一律不发：情绪真值与真假标记、波动率/回归倍数/漂移、
 *      抽奖概率、均值回归锚（st.fair）、金价系数、财报随机偏移、资金压力（flow/mflow）、
 *      市场资金（虚假成交/游资）的任何参数、各种随机概率
 *   3. 两个 payload 共用这里的投影函数，删字段只删一处
 *
 * 想加新字段：先确认前端要显示，再改这里，然后跑 `node tests/payload-wire.mjs`。
 */

import { changesFor, sentimentView } from './engine.js';
import {
  dividendPerShare, dividendPayout, reportPayload,
  tycoonPreviewPayload, previewInTicks, isTycoonSector
} from './fundamentals.js';
import { tycoonLeadTicks } from './achievements.js';
import { positionPnl } from './trading.js';
import { TIMEFRAMES } from './config.js';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** 财报面板真的会画出来的字段（revenue/netProfit 画折线，其余是文字/计算） */
const REPORT_KEYS = [
  'industry', 'fair', 'revenue', 'netProfit', 'eps', 'bps', 'roe', 'debt', 'growth', 'period'
];

/**
 * 前端只认识这两个「板块标记」（汇率条 / 金融板块预览）。
 * 其它 trait（volMult / revMult / drift / lotteryChance / floorRatio / goldCoef …）
 * 全是价格模型内部参数，**绝不能下发**。
 */
const WIRE_TRAIT_IDS = new Set(['fx', 'broker']);

/** 玩家可见的 config 白名单：app.js 真的会读的那一份（其余都在管理端 /api/admin/state 里） */
const CONFIG_KEYS = [
  // 交易规则与费用（下单面板算押金/手续费/冲击成本用）
  'minLeverage', 'maxLeverage', 'feeRate', 'stampDuty',
  'maxFillNotionalPerTick', 'impactCostCoef', 'impactCostMax',
  // 自己下单的价格冲击（只影响自己的成本估算，不影响别人）
  'playerImpactRef', 'playerImpactStrength',
  // ST / 退市
  'stPrice', 'stDelistTicks',
  // 分红（财报面板显示派息率/股息率）
  'dividendRate', 'dividendCap',
  // 等级
  'levelBaseAsset', 'levelGrowth', 'levelUpRatio', 'levelFillBonus',
  // 商城
  'shopFakeNewsPrice', 'shopFakeNewsChance', 'shopFakeNewsCooldown',
  'shopBodyguardPrice', 'shopBodyguardTicks',
  'shopChannelBasePrice', 'shopChannelRatio', 'shopChannelStep',
  'shopThemePrice', 'shopThemeCooldown', 'mindThemePrice',
  'shopAutoDcaPrice', 'shopAutoDcaPremium',
  // 夜行者 / 偷钱
  'nightStartHour', 'nightEndHour', 'nightStealCooldown',
  'stealCapRatio', 'stealCooldownTicks',
  // 打工
  'workRatePerTick', 'workOnlineMultiplier', 'workBankTicks',
  // 银行
  'bankPoorThreshold', 'bankWithdrawRateMin', 'bankWithdrawRateMax', 'bankWithdrawFloor',
  // 成就（进化要几枚结晶）
  'achvShardPerEvolve',
  // 新手开局资金（登录页提示）
  'startingCash'
];

/** 个股的板块标记（只有 fx / broker 有意义） */
export function traitWire(st) {
  const id = st && st.trait && st.trait.id;
  return WIRE_TRAIT_IDS.has(id) ? { id } : {};
}

/**
 * 财报（只留界面用得到的字段）。
 * `fair` 是界面上的「估值线 / 溢价率」，属于设计内的公开信息；
 * 引擎真正做均值回归用的 `st.fair` 是另一份（含平滑/天花板），不下发。
 */
export function reportWire(st) {
  const r = reportPayload(st);
  const out = {};
  for (const k of REPORT_KEYS) out[k] = r[k];
  out.history = (Array.isArray(r.history) ? r.history : []).map((h) => ({
    revenue: num(h.revenue),
    netProfit: num(h.netProfit)
  }));
  return out;
}

/**
 * 「情绪读心」下发的那一个数：只有 v。
 * 真假标记、剩余轮数、施加间隔、方向分量都是引擎内部状态，一律不给
 * （给了就等于告诉玩家「这次读心准不准」）。
 */
export function sentWire(st, db, player) {
  if (!player || player.skill !== 'mind') return null;
  // 停牌 / 退市的票不推进情绪，别把上一次的旧值当成「现在」
  if (!st || st.isIndex || st.status !== 'normal') return null;
  const view = sentimentView(st, db, player);
  if (!view) return null;
  return { v: Math.max(-1, Math.min(1, num(view.v))) };
}

/**
 * 每轮都会变的行情字段（首屏 + tick 共用）。
 * 注意：这里**不含** trait / fair / 资金压力 / 情绪真值。
 */
export function stockWire(db, st, me) {
  const cfg = db.config || {};
  const prev = st.series.length > 1 ? st.series[st.series.length - 2] : st.price;
  const out = {
    price: num(Number(st.price).toFixed(4)),
    changePct: prev > 0 ? ((st.price - prev) / prev) * 100 : 0,
    changes: changesFor(st.series, TIMEFRAMES),
    status: st.status,
    st: !!st.st,
    stTicks: num(st.stTicks),
    // 本期每股股息（跟现价封顶，每轮都变）
    dps: st.isIndex ? 0 : dividendPerShare(st, { rate: cfg.dividendRate, cap: cfg.dividendCap }),
    payout: st.isIndex ? 0 : dividendPayout(st, cfg.dividendRate)
  };

  // 金融大鳄：只有金融板块有预览/倒计时
  if (!st.isIndex && isTycoonSector(st)) {
    const lead = tycoonLeadTicks(db, me);
    const left = previewInTicks(st, db.tick, lead);
    out.previewIn = left;
    const isTycoon = !!me && (me.skill || me.theme) === 'tycoon';
    out.preview = (isTycoon && left <= 0) ? tycoonPreviewPayload(st, db.tick, lead) : null;
  } else {
    out.previewIn = null;
    out.preview = null;
  }

  // 情绪读心：没有这个技能就是 null（不是省略，前端要用 null 清掉上一条）
  out.sent = sentWire(st, db, me);
  return out;
}

/** 首屏：静态资料 + 每轮字段 */
export function stockFullWire(db, st, me) {
  return {
    code: st.code,
    name: st.name,
    icon: st.icon || '',
    industry: st.industry || '',
    desc: st.desc || '',
    isIndex: !!st.isIndex,
    shares: num(st.shares),
    nextReportTick: num(st.nextReportTick),
    trait: traitWire(st),
    report: st.isIndex ? null : reportWire(st),
    ...stockWire(db, st, me)
  };
}

/**
 * 玩家可见的 config（标量部分）。
 * 三个对象型配置（shopItems / themeNeedLevel / emojiDirs）由 api.js 补，
 * 因为它们的唯一真相在那边（商城等级门槛、表情目录）。
 */
export function configWire(cfg) {
  const src = cfg || {};
  const out = {};
  for (const k of CONFIG_KEYS) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

/** 供测试 / 排查用：白名单本身 */
export const WIRE_CONFIG_KEYS = [...CONFIG_KEYS];
export const WIRE_REPORT_KEYS = [...REPORT_KEYS];

/**
 * 持仓下发格式（首屏 / 每轮 / 止盈止损接口共用）。
 * 只给界面要画的字段：成本、数量、保证金、杠杆、盈亏、止盈止损、平仓中状态。
 * 内部记账（valueArm / openNotional / pushArm / openedTick …）不下发。
 */
export function positionWire(pos, st) {
  const price = num(st && st.price);
  const pnl = positionPnl(pos, price);
  const margin = num(pos.margin);
  return {
    code: pos.code,
    side: pos.side === 'short' ? 'short' : 'long',
    qty: num(pos.qty),
    entry: num(pos.entry),
    margin,
    leverage: num(pos.leverage, 1),
    tp: pos.tp === undefined || pos.tp === null ? null : num(pos.tp),
    sl: pos.sl === undefined || pos.sl === null ? null : num(pos.sl),
    price,
    pnl,
    pnlPct: margin > 0 ? (pnl / margin) * 100 : 0,
    equity: margin + pnl,
    // 只给还没触发的条件单（触发的已经变成挂单 / 已成交，界面不需要）
    tpsl: (Array.isArray(pos.tpsl) ? pos.tpsl : [])
      .filter((x) => x && !x.fired)
      .map((x) => ({
        id: x.id,
        kind: x.kind === 'sl' ? 'sl' : 'tp',
        price: num(x.price),
        qty: x.qty ? num(x.qty) : null
      })),
    closing: pos.closing || null
  };
}
