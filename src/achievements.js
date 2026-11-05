/**
 * 主题专属成就 + 主题进化（Lv1 → Lv2）
 *
 * 设计稿见 docs/成就系统设计.md §9。这里只做「主题专属」那 16 条，
 * 普通/稀有/史诗成就还没做。
 *
 * 约定：
 *   - 判定全部在服务端，前端只读进度（不开放成就上报接口）
 *   - 所有阈值都走 db.config（管理面板可调），代码里不写死第二份
 *   - 一条主题成就 = 1 结晶；进化需要「两条都解锁 + 2 枚结晶」
 *   - 进化只改「技能手感」，不改本金 / 撮合上限
 */

/** 主题 → 徽章 emoji（排行榜名字旁边显示这个） */
export const THEME_EMOJI = {
  red: '🐂',
  bear: '🐻',
  dark: '🕶️',
  tycoon: '🐊',
  hermit: '🧙',
  probe: '🕵️',
  mind: '🧠',
  night: '🌙'
};

export const THEMES = Object.keys(THEME_EMOJI);

/**
 * 16 条主题成就。
 *   counter：玩家计数器名（`player.achvCounters[counter]`）
 *   targetKey：阈值在 db.config 里的键名
 *   once：true = 只判定一次（不用累计目标）
 */
export const THEME_ACHIEVEMENTS = [
  // ---------------- 🐂 红红的牛 ----------------
  {
    id: 'red_trend', theme: 'red', slot: 1, name: '顺势收割', emoji: '🐂',
    desc: '指数处于多头排列（价 > MA5 > MA10 > MA30）时平仓',
    counter: 'redTrendClose', targetKey: 'achvRedTrendTarget', unit: '次'
  },
  {
    id: 'red_bonus', theme: 'red', slot: 2, name: '牛气冲天', emoji: '🐂',
    desc: '技能返现累计到目标金额',
    counter: 'redBonusEarned', targetKey: 'achvRedBonusTarget', unit: '$'
  },
  // ---------------- 🐻 绿绿的熊 ----------------
  {
    id: 'bear_trend', theme: 'bear', slot: 1, name: '熊市舞者', emoji: '🐻',
    desc: '指数处于空头排列（价 < MA5 < MA10 < MA30）时平仓',
    counter: 'bearTrendClose', targetKey: 'achvBearTrendTarget', unit: '次'
  },
  {
    id: 'bear_bonus', theme: 'bear', slot: 2, name: '熊口拔牙', emoji: '🐻',
    desc: '技能返现累计到目标金额',
    counter: 'bearBonusEarned', targetKey: 'achvBearBonusTarget', unit: '$'
  },
  // ---------------- 🕶️ 暗黑大手 ----------------
  {
    id: 'dark_hand', theme: 'dark', slot: 1, name: '黑手', emoji: '🕶️', once: true,
    desc: '用暗黑大手在同一只票同一方向累计开出目标金额后，换别的技能在该股平仓',
    // 注意：累加额用 cfg.achvDarkHandTarget 判（在 trading.js 里），
    // 这里计的是「成功次数」，所以目标是 1 次
    counter: 'darkHand', targetKey: 'achvDarkHandCount', unit: '次'
  },
  {
    id: 'dark_push', theme: 'dark', slot: 2, name: '推土机', emoji: '🕶️', once: true,
    desc: '别人开仓后你反方向进场推价，等他平完你再平',
    counter: 'darkPush', targetKey: 'achvDarkPushTarget', unit: '次'
  },
  // ---------------- 🐊 金融大鳄 ----------------
  {
    id: 'tycoon_prophet', theme: 'tycoon', slot: 1, name: '先知', emoji: '🐊', once: true,
    desc: '金融板块财报「超预期」公布前建仓（杠杆达标），公布后平仓',
    counter: 'tycoonProphet', targetKey: 'achvTycoonProphetTarget', unit: '次'
  },
  {
    id: 'tycoon_info', theme: 'tycoon', slot: 2, name: '信息差', emoji: '🐊',
    desc: '金融板块交易累计盈利到目标金额',
    counter: 'tycoonFinancePnl', targetKey: 'achvTycoonProfitTarget', unit: '$'
  },
  // ---------------- 🧙 隐世仙人 ----------------
  {
    id: 'hermit_follow', theme: 'hermit', slot: 1, name: '来去无踪', emoji: '🧙', once: true,
    desc: '别人在这只票上成交后，你用隐世仙人跟着成交',
    counter: 'hermitFollow', targetKey: 'achvHermitFollowTarget', unit: '次'
  },
  {
    id: 'hermit_lone', theme: 'hermit', slot: 2, name: '孤狼', emoji: '🧙',
    desc: '单只票持仓市值突破目标金额',
    counter: 'hermitMaxPos', targetKey: 'achvHermitPosTarget', unit: '$'
  },
  // ---------------- 🕵️ 暗中调查 ----------------
  {
    id: 'probe_weak', theme: 'probe', slot: 1, name: '软柿子', emoji: '🕵️', once: true,
    desc: '在别的玩家刚建仓的股票上反方向开仓',
    counter: 'probeWeak', targetKey: 'achvProbeWeakTarget', unit: '次'
  },
  {
    id: 'probe_net', theme: 'probe', slot: 2, name: '情报网', emoji: '🕵️',
    desc: '累计调查到别人的持仓',
    counter: 'probeCount', targetKey: 'achvProbeTarget', unit: '次'
  },
  // ---------------- 🧠 情绪读心 ----------------
  {
    id: 'mind_read', theme: 'mind', slot: 1, name: '读心', emoji: '🧠',
    desc: '情绪极度强烈时顺方向盈利',
    counter: 'mindRead', targetKey: 'achvMindReadTarget', unit: '次'
  },
  {
    id: 'mind_profit', theme: 'mind', slot: 2, name: '情绪交易员', emoji: '🧠',
    desc: '带着情绪读心技能累计盈利到目标金额',
    counter: 'mindPnl', targetKey: 'achvMindProfitTarget', unit: '$'
  },
  // ---------------- 🌙 夜行者 ----------------
  {
    id: 'night_big', theme: 'night', slot: 1, name: '很会偷', emoji: '🌙',
    desc: '单次偷到超过目标金额',
    counter: 'nightBigSteal', targetKey: 'achvNightBigSteal', unit: '$'
  },
  {
    id: 'night_200', theme: 'night', slot: 2, name: '趁人不备', emoji: '🌙',
    desc: '夜里偷钱成功累计次数',
    counter: 'nightStealCount', targetKey: 'achvNightStealTarget', unit: '次'
  }
];

/** id → 定义 */
export const ACHV_BY_ID = Object.fromEntries(THEME_ACHIEVEMENTS.map((a) => [a.id, a]));
/** counter → 定义[]（判定时只查相关的几条，不遍历全表） */
export const ACHV_BY_COUNTER = (() => {
  const map = {};
  for (const a of THEME_ACHIEVEMENTS) {
    (map[a.counter] ||= []).push(a);
  }
  return map;
})();

/** 计数器默认值（迁移时补） */
export function defaultCounters() {
  const out = {};
  for (const a of THEME_ACHIEVEMENTS) {
    if (out[a.counter] === undefined) out[a.counter] = 0;
  }
  return out;
}

/** 读阈值：优先 db.config，其次代码兜底 */
export function achvTarget(cfg, key) {
  const DEFAULTS = {
    achvRedTrendTarget: 20,
    achvRedBonusTarget: 5000000,
    achvBearTrendTarget: 20,
    achvBearBonusTarget: 5000000,
    achvDarkHandTarget: 10000000,
    achvDarkHandCount: 1,
    achvDarkPushTarget: 1,
    achvTycoonProphetTarget: 1,
    achvTycoonProfitTarget: 5000000,
    achvHermitFollowTarget: 1,
    achvHermitPosTarget: 10000000,
    achvProbeWeakTarget: 1,
    achvProbeTarget: 20,
    achvMindReadTarget: 1,
    achvMindProfitTarget: 10000000,
    achvNightBigSteal: 9500,
    achvNightStealTarget: 200,
    achvShardPerEvolve: 2
  };
  const v = Number((cfg || {})[key]);
  return Number.isFinite(v) && v > 0 ? v : (DEFAULTS[key] ?? 1);
}

/** 玩家成就状态归零 / 补齐（migrate 与新玩家都要过一遍） */
export function ensureAchvState(player) {
  if (!player || typeof player !== 'object') return player;
  if (!player.achv || typeof player.achv !== 'object') player.achv = {};
  if (!player.achvCounters || typeof player.achvCounters !== 'object') player.achvCounters = {};
  const def = defaultCounters();
  for (const k of Object.keys(def)) {
    if (!Number.isFinite(Number(player.achvCounters[k]))) player.achvCounters[k] = def[k];
  }
  if (!player.shards || typeof player.shards !== 'object') player.shards = {};
  for (const t of THEMES) {
    if (!Number.isFinite(Number(player.shards[t]))) player.shards[t] = 0;
  }
  if (!player.themeTier || typeof player.themeTier !== 'object') player.themeTier = {};
  for (const t of THEMES) {
    const n = Math.floor(Number(player.themeTier[t]));
    player.themeTier[t] = n === 2 ? 2 : 1;
  }
  if (!Number.isFinite(Number(player.achvPoints))) player.achvPoints = 0;
  return player;
}

/** 主题进化阶（1 = 原版，2 = 进化后） */
export function themeTier(player, theme) {
  const n = Math.floor(Number(player?.themeTier?.[theme]));
  return n === 2 ? 2 : 1;
}

/** 是否已进化 */
export function isEvolved(player, theme) {
  return themeTier(player, theme) === 2;
}

/**
 * 技能强度倍率：进化后 1.5（红牛/绿熊返现用这个乘）。
 * 具体上限仍由 `redBonusRate` / `bearBonusRate` 控制，不在这里写死金额。
 */
export function skillMult(db, player, theme) {
  if (!isEvolved(player, theme)) return 1;
  const v = Number((db?.config || {}).themeEvolveSkillMult);
  return Number.isFinite(v) && v > 0 ? v : 1.5;
}

/** 该主题的成就解锁情况 */
export function themeAchvProgress(player, theme) {
  const defs = THEME_ACHIEVEMENTS.filter((a) => a.theme === theme).sort((x, y) => x.slot - y.slot);
  return defs.map((d) => {
    const got = !!player?.achv?.[d.id];
    return {
      id: d.id,
      slot: d.slot,
      name: d.name,
      desc: d.desc,
      emoji: d.emoji,
      got,
      at: got ? Number(player.achv[d.id].at) || 0 : 0,
      counter: d.counter,
      targetKey: d.targetKey,
      progress: Math.max(0, Number(player?.achvCounters?.[d.counter]) || 0)
    };
  });
}

/**
 * 解锁一条成就。
 * @returns 解锁的定义（已经解锁过返回 null）
 */
export function unlockAchv(db, player, def) {
  if (!def || !player) return null;
  if (!player.achv || typeof player.achv !== 'object') player.achv = {};
  if (player.achv[def.id]) return null;
  player.achv[def.id] = { at: Number(db?.tick) || 0, seen: false };
  player.achvPoints = (Number(player.achvPoints) || 0) + 40;
  if (!player.shards || typeof player.shards !== 'object') player.shards = {};
  player.shards[def.theme] = (Number(player.shards[def.theme]) || 0) + 1;
  return def;
}

/**
 * 计数器累加并按需解锁。
 * @param {number} amount 累加值
 * @param {'add'|'max'} mode add = 累加，max = 取较大值（持仓市值这类）
 * @returns 本次新解锁的定义数组
 */
export function bumpAchv(db, player, counter, amount = 1, mode = 'add') {
  if (!player || !counter) return [];
  const defs = ACHV_BY_COUNTER[counter];
  if (!defs || !defs.length) return [];
  ensureAchvState(player);
  const cur = Number(player.achvCounters[counter]) || 0;
  const val = mode === 'max' ? Math.max(cur, Number(amount) || 0) : cur + (Number(amount) || 0);
  player.achvCounters[counter] = val;
  const out = [];
  for (const def of defs) {
    if (player.achv[def.id]) continue;
    const target = achvTarget(db?.config, def.targetKey);
    if (val + 1e-9 >= target) {
      const got = unlockAchv(db, player, def);
      if (got) out.push(got);
    }
  }
  return out;
}

/** 直接解锁（不看计数器，挑战类成就用） */
export function grantAchv(db, player, id) {
  const def = ACHV_BY_ID[id];
  if (!def) return [];
  ensureAchvState(player);
  if (player.achv[def.id]) return [];
  const got = unlockAchv(db, player, def);
  return got ? [got] : [];
}

/** 已解锁的主题成就 emoji 列表（排行榜用） */
export function themeEmojiList(player) {
  const out = [];
  for (const t of THEMES) {
    const got = THEME_ACHIEVEMENTS.some((a) => a.theme === t && player?.achv?.[a.id]);
    if (!got) continue;
    out.push(isEvolved(player, t) ? `${THEME_EMOJI[t]}✦` : THEME_EMOJI[t]);
  }
  return out;
}

/** 能否进化（两条全解 + 结晶够 + 还没进化） */
export function canEvolve(db, player, theme) {
  if (!THEMES.includes(theme)) return false;
  if (!player?.themes?.includes(theme)) return false;
  if (isEvolved(player, theme)) return false;
  const list = themeAchvProgress(player, theme);
  if (!list.every((x) => x.got)) return false;
  const need = achvTarget(db?.config, 'achvShardPerEvolve');
  return (Number(player.shards?.[theme]) || 0) >= need;
}

/**
 * 进化主题：扣结晶、阶数 +1。
 * @returns {{ok:boolean, error?:string, tier?:number}}
 */
export function evolveTheme(db, player, theme) {
  if (!THEMES.includes(theme)) return { ok: false, error: '没有这个主题' };
  if (!player?.themes?.includes(theme)) return { ok: false, error: '还没买这个主题' };
  if (isEvolved(player, theme)) return { ok: false, error: '这个主题已经进化过了' };
  ensureAchvState(player);
  const list = themeAchvProgress(player, theme);
  const missing = list.filter((x) => !x.got);
  if (missing.length) {
    return { ok: false, error: `还差成就：${missing.map((x) => x.name).join(' / ')}` };
  }
  const need = achvTarget(db?.config, 'achvShardPerEvolve');
  const have = Number(player.shards[theme]) || 0;
  if (have < need) return { ok: false, error: `结晶不够（${have}/${need}）` };
  player.shards[theme] = have - need;
  player.themeTier[theme] = 2;
  return { ok: true, tier: 2 };
}

/** 给 payload 用的紧凑快照 */
export function achvPayload(db, player) {
  const me = ensureAchvState(player);
  const themes = {};
  for (const t of THEMES) {
    const list = themeAchvProgress(me, t);
    themes[t] = {
      tier: themeTier(me, t),
      shards: Number(me.shards[t]) || 0,
      got: list.filter((x) => x.got).length,
      total: list.length,
      canEvolve: canEvolve(db, me, t),
      list: list.map((x) => ({
        id: x.id, name: x.name, desc: x.desc, emoji: x.emoji, got: x.got,
        progress: x.progress, target: achvTarget(db?.config, x.targetKey)
      }))
    };
  }
  return { points: Number(me.achvPoints) || 0, themes, emojis: themeEmojiList(me) };
}

/** 大鳄的提前量：进化后从 20 轮变 30 轮（配置可调） */
export function tycoonLeadTicks(db, player) {
  const base = Math.max(1, Number((db?.config || {}).tycoonLeadTicks) || 20);
  if (!player || player.skill !== 'tycoon' || !isEvolved(player, 'tycoon')) return base;
  const v = Number((db?.config || {}).tycoonLeadTicksEvolved);
  return Math.max(base, Number.isFinite(v) && v > 0 ? v : 30);
}
