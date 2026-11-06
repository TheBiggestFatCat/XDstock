/**
 * 「情绪读心」的读数规则。
 *
 * 背景：读心看到的情绪值可能是假的（`st.sentiment.viewV` 是每次重掷时另抽的一个同分布值）。
 * 以前是全局一次骰子（`mindFakeChance`），所有读心玩家一起看真 / 一起看假。
 *
 * 现在改成**按玩家判定**：
 *   - 未进化：准确率 = 1 − mindFakeChance（默认 0.5 → 50%）
 *   - Ⅱ 阶：准确率 = mindAccurateChanceEvolved（默认 0.7 → 70%），**没有其他额外效果**
 * 判定用的是「玩家 + 股票 + 这次重掷周期」的稳定哈希，所以：
 *   - 同一次重掷期间，同一个人看到的永远一样（不会每轮闪）
 *   - 不同玩家互相独立，各按各自的准确率
 */

import { isEvolved } from './achievements.js';

/** 稳定哈希：字符串 → [0,1) */
export function hash01(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** 这个玩家「看到真值」的概率（0~1） */
export function mindAccurateChance(db, player) {
  const cfg = (db && db.config) || {};
  if (!player) return 1;
  if (player.skill !== 'mind') return 1;
  if (isEvolved(player, 'mind')) {
    const v = Number(cfg.mindAccurateChanceEvolved);
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.7;
  }
  const fake = Number(cfg.mindFakeChance);
  const f = Number.isFinite(fake) ? Math.max(0, Math.min(1, fake)) : 0.5;
  return 1 - f;
}

/**
 * 这个玩家此刻看到的情绪值。
 * @returns {{v:number, fake:boolean}}
 */
export function maskSentiment(st, db, player) {
  const s = (st && st.sentiment) || {};
  const real = Number(s.v) || 0;
  const fakeV = Number.isFinite(Number(s.viewV)) ? Number(s.viewV) : real;
  if (!player || player.skill !== 'mind') return { v: real, fake: false };
  const acc = mindAccurateChance(db, player);
  if (acc >= 1) return { v: real, fake: false };
  if (acc <= 0) return { v: fakeV, fake: true };
  const seed = hash01(`${player.id}|${st?.code || st?.name || ''}|${Number(s.nextRoll) || 0}`);
  const showReal = seed < acc;
  return { v: showReal ? real : fakeV, fake: !showReal };
}
