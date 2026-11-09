/**
 * 主题技能文案（商城里每张主题卡下面那段「技能：…」）
 *
 * 规则：**这里只生成一次，前端不再写死的数字**。
 * 所有数字都从 `db.config` 读，后台把参数改了（比如大鳄提前量 20 → 12），
 * 商城卡片上的文案立刻跟着变，不会出现「描述写 20 轮、实际跑 30 轮」。
 *
 * 每个主题给两段：
 *   t1 = 一级技能（买了就能用）
 *   t2 = 二级技能（进化后解锁，`player.themeTier[theme] === 2`）
 *
 * 纯函数、不读 db，方便单测（tests/skill-text.mjs）。
 */

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const pct = (v, d = 0) => `${(num(v, 0) * 100).toFixed(d)}%`;
const pctInt = (v) => {
  const n = Math.round(num(v, 0) * 100);
  return `${n}%`;
};
const hh = (v, d) => `${String(Math.round(num(v, d))).padStart(2, '0')}:00`;
/** 数值变化的方向词：配置被改反了也不能说反话（「降到」写成「升到」） */
const shiftWord = (from, to, up = '提高到', down = '降到') => {
  const a = Number(from);
  const b = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '调整为';
  if (b > a) return up;
  if (b < a) return down;
  return '保持';
};

/** 默认值要和 src/config.js 保持一致（只为「配置缺字段」时兜底，不参与业务） */
const DEFAULTS = {
  tycoonLeadTicks: 20,
  tycoonLeadTicksEvolved: 40,
  hermitHideChance: 0.75,
  hermitHideChanceEvolved: 1,
  redBonusRate: 0.01,
  bearBonusRate: 0.01,
  redBonusMinTicks: 12,
  bearBonusMinTicks: 12,
  themeEvolveSkillMult: 1.5,
  darkImpactBase: 1.05,
  themeEvolveImpact: 1.1,
  themeEvolveImpactRefund: 0.2,
  investigateCooldownTicks: 30,
  investigateCooldownEvolved: 20,
  mindFakeChance: 0.5,
  mindAccurateChanceEvolved: 0.7,
  nightStartHour: 22,
  nightEndHour: 5,
  nightStealCooldown: 50,
  nightStealCooldownEvolved: 20,
  stealCooldownTicks: 60
};

/**
 * 生成全部主题的技能文案。
 * @param {object} cfg db.config
 * @returns {Record<string, {t1: string, t2: string}>}
 */
export function buildSkillText(cfg = {}) {
  const c = (k) => (cfg && cfg[k] !== undefined ? cfg[k] : DEFAULTS[k]);

  const lead = Math.round(num(c('tycoonLeadTicks'), DEFAULTS.tycoonLeadTicks));
  const leadEv = Math.round(num(c('tycoonLeadTicksEvolved'), DEFAULTS.tycoonLeadTicksEvolved));

  const hide = pctInt(c('hermitHideChance'));
  const hideEv = pctInt(c('hermitHideChanceEvolved'));

  const redRate = pct(c('redBonusRate'), 2).replace(/\.?0+%$/, '%');
  const bearRate = pct(c('bearBonusRate'), 2).replace(/\.?0+%$/, '%');
  const redMin = Math.round(num(c('redBonusMinTicks'), DEFAULTS.redBonusMinTicks));
  const bearMin = Math.round(num(c('bearBonusMinTicks'), DEFAULTS.bearBonusMinTicks));
  // 02 阶的技能就是「同一件事做得更好」：返现倍率 ×themeEvolveSkillMult（默认 1.5）
  const evoMult = Number(num(c('themeEvolveSkillMult'), DEFAULTS.themeEvolveSkillMult).toFixed(2));
  const mulRate = (rate) => pct(num(rate, 0) * evoMult, 2).replace(/\.?0+%$/, '%');
  const redRateEv = mulRate(c('redBonusRate'));
  const bearRateEv = mulRate(c('bearBonusRate'));

  const darkBase = num(c('darkImpactBase'), DEFAULTS.darkImpactBase).toFixed(2);
  const darkBasePct = Math.round((num(c('darkImpactBase'), DEFAULTS.darkImpactBase) - 1) * 100);
  const darkEvo = num(c('themeEvolveImpact'), DEFAULTS.themeEvolveImpact).toFixed(2);
  const darkRefund = pctInt(c('themeEvolveImpactRefund'));

  const probeCd = Math.round(num(c('investigateCooldownTicks'), DEFAULTS.investigateCooldownTicks));
  const probeCdEv = Math.round(num(c('investigateCooldownEvolved'), DEFAULTS.investigateCooldownEvolved));

  const fakeChance = pctInt(c('mindFakeChance'));
  const mindAcc = pctInt(c('mindAccurateChanceEvolved'));
  const mindFakeEvo = Math.max(0, 100 - Math.round(num(c('mindAccurateChanceEvolved'), DEFAULTS.mindAccurateChanceEvolved) * 100));

  const start = hh(c('nightStartHour'), DEFAULTS.nightStartHour);
  const end = hh(c('nightEndHour'), DEFAULTS.nightEndHour);
  const cdDay = Math.round(num(c('stealCooldownTicks'), DEFAULTS.stealCooldownTicks));
  const cdNight = Math.round(num(c('nightStealCooldown'), DEFAULTS.nightStealCooldown));
  const cdNightEv = Math.round(num(c('nightStealCooldownEvolved'), DEFAULTS.nightStealCooldownEvolved));

  return {
    tycoon: {
      t1: `金融板块（券商 / 外汇）的下一期财报提前 ${lead} 轮可见，直接标明超预期还是不及预期`,
      t2: `提前量${shiftWord(lead, leadEv)} ${leadEv} 轮（最早的「先知」就是靠这个提前埋伏）`
    },
    hermit: {
      t1: `你的成交有 ${hide} 概率不出现在成交记录里，别人看不出你在进出`,
      t2: `隐身概率${shiftWord(num(c('hermitHideChance'), DEFAULTS.hermitHideChance), num(c('hermitHideChanceEvolved'), DEFAULTS.hermitHideChanceEvolved))} ${hideEv}，排行榜上你的资产只显示成「≈X」，精确身家不再公开`
    },
    red: {
      t1: `指数多头排列（价 > MA5 > MA10 > MA30）时平仓，额外返 ${redRate} 成交额（持仓满 ${redMin} 轮才算）`,
      t2: `返现倍率 ×${evoMult}：多头排列平仓额外返 ${redRateEv} 成交额（同一套持仓门槛）`
    },
    bear: {
      t1: `指数空头排列（价 < MA5 < MA10 < MA30）时平仓，额外返 ${bearRate} 成交额（持仓满 ${bearMin} 轮才算）`,
      t2: `返现倍率 ×${evoMult}：空头排列平仓额外返 ${bearRateEv} 成交额（同一套持仓门槛）`
    },
    dark: {
      t1: `你的成交对市场的冲击 ×${darkBase}（比常人狠 ${darkBasePct}%），撬动价格更明显`,
      t2: `冲击${shiftWord(num(c('darkImpactBase'), DEFAULTS.darkImpactBase), num(c('themeEvolveImpact'), DEFAULTS.themeEvolveImpact))} ×${darkEvo}，并且自己吃掉的冲击成本返还 ${darkRefund}`
    },
    probe: {
      t1: `排行榜「偷钱」旁边多一个「调查」：随机看一名玩家的一笔持仓（方向 / 数量 / 成本 / 浮盈），冷却 ${probeCd} 轮`,
      t2: `冷却${shiftWord(probeCd, probeCdEv)} ${probeCdEv} 轮，而且一次把他全部持仓都看光`
    },
    mind: {
      t1: `每只票多一条双向情绪条（左绿看空、右红看多，长度就是强弱）；但有 ${fakeChance} 概率是假的，真假自己判断`,
      t2: `看到真值的概率${shiftWord(num(c('mindFakeChance'), DEFAULTS.mindFakeChance) > 0 ? 1 - num(c('mindFakeChance'), DEFAULTS.mindFakeChance) : 1, num(c('mindAccurateChanceEvolved'), DEFAULTS.mindAccurateChanceEvolved))} ${mindAcc}（假读数只剩 ${mindFakeEvo}%）`
    },
    night: {
      t1: `现实时间 ${start} ~ ${end} 生效：夜里偷钱冷却从 ${cdDay} 轮${shiftWord(cdDay, cdNight, '升到', '降到')} ${cdNight} 轮（白天照常）`,
      t2: `夜里偷钱冷却再${shiftWord(cdNight, cdNightEv, '升到', '降到')} ${cdNightEv} 轮（进化后的夜行者最凶）`
    }
  };
}

/** 给接口用：带上生成时间，方便前端判断要不要重新拉 */
export function skillTextPayload(db) {
  return {
    texts: buildSkillText((db && db.config) || {}),
    at: Date.now()
  };
}

export const SKILL_TEXT_THEMES = ['tycoon', 'hermit', 'red', 'bear', 'dark', 'probe', 'mind', 'night'];
