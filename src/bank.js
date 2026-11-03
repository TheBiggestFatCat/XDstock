// 丰川银行
//
//   · 账号升级交的钱不再凭空消失，直接存进玩家的银行账户
//   · 银行存款不计入总资产（否则「总资产低于阈值」这个条件永远不成立）
//   · 总资产低于阈值时，允许取一笔钱救急（默认 10 万）

import { playerEquity } from './trading.js';

/** 银行规则（管理面板里可改） */
export function bankRules(db) {
  const cfg = (db && db.config) || {};
  let rateMin = Number(cfg.bankWithdrawRateMin ?? 0.01);
  let rateMax = Number(cfg.bankWithdrawRateMax ?? 0.20);
  if (!Number.isFinite(rateMin) || rateMin < 0) rateMin = 0.01;
  if (!Number.isFinite(rateMax) || rateMax < 0) rateMax = 0.20;
  if (rateMax < rateMin) {
    const tmp = rateMin;
    rateMin = rateMax;
    rateMax = tmp;
  }
  return {
    poorThreshold: Math.max(0, Number(cfg.bankPoorThreshold ?? 100000)),
    rateMin: Math.min(1, rateMin),
    rateMax: Math.min(1, rateMax),
    floor: Math.max(1, Number(cfg.bankWithdrawFloor ?? 100000))
  };
}

/** 这一次能取的区间（给前端显示，实际金额在取款时才掷） */
export function withdrawRange(db, bank) {
  const { rateMin, rateMax, floor } = bankRules(db);
  const money = Math.max(0, Number(bank) || 0);
  const low = Math.min(money, Math.max(floor, Math.floor(money * rateMin)));
  const high = Math.min(money, Math.max(floor, Math.floor(money * rateMax)));
  return { low, high, rateMin, rateMax, floor };
}

/** 给前端看的银行状态 */
export function bankStatus(db, player) {
  const { poorThreshold, rateMin, rateMax, floor } = bankRules(db);
  const equity = playerEquity(db, player);
  const bank = Math.max(0, Number(player.bank) || 0);
  const poor = equity < poorThreshold;
  const range = withdrawRange(db, bank);
  return {
    bank,
    deposited: Math.max(0, Number(player.bankDeposited) || 0),
    equity,
    poorThreshold,
    rateMin,
    rateMax,
    floor,
    // 现在能不能取、大概能取多少
    poor,
    canWithdraw: poor && bank > 0,
    withdrawMin: poor ? range.low : 0,
    withdrawMax: poor ? range.high : 0
  };
}

/**
 * 账号升级：钱从现金转进银行（不再直接消失）
 * 返回 { ok, status?, error? , level, cost, cash, bank }
 */
export function levelUpPlayer(db, player) {
  const lv = Math.max(1, Math.floor(Number(player.level) || 1));
  const base = Number(db.config.levelBaseAsset ?? 10000000);
  const growth = Math.max(1, Number(db.config.levelGrowth ?? 2));
  const need = base * Math.pow(growth, lv - 1);
  const equity = playerEquity(db, player);
  if (equity < need) {
    return {
      ok: false,
      status: 400,
      error: `升级需要总资产达到 ${Math.round(need).toLocaleString('en-US')}，你现在 ${Math.round(equity).toLocaleString('en-US')}`
    };
  }
  const ratio = Math.min(0.99, Math.max(0, Number(db.config.levelUpRatio ?? 0.6)));
  const cost = Math.floor(equity * ratio);
  const cash = Number(player.cash) || 0;
  if (cash < cost) {
    return {
      ok: false,
      status: 400,
      error: `升级要付 ${Math.round(cost).toLocaleString('en-US')} 现金（总资产的 ${(ratio * 100).toFixed(0)}%），你只有 ${Math.round(cash).toLocaleString('en-US')}`
    };
  }
  player.cash = cash - cost;
  player.bank = (Number(player.bank) || 0) + cost;
  player.bankDeposited = (Number(player.bankDeposited) || 0) + cost;
  player.level = lv + 1;
  return { ok: true, level: player.level, cost, cash: player.cash, bank: player.bank };
}

/**
 * 取钱救急：总资产低于阈值时才允许。
 * 金额 = 存款 × 随机(rateMin ~ rateMax)，但不少于 floor；存款不足就取全部。
 */
export function withdrawFromBank(db, player) {
  const { poorThreshold, rateMin, rateMax, floor } = bankRules(db);
  const equity = playerEquity(db, player);
  if (!(equity < poorThreshold)) {
    return {
      ok: false,
      status: 400,
      error: `总资产要低于 ${Math.round(poorThreshold).toLocaleString('en-US')} 才能取钱（你现在 ${Math.round(equity).toLocaleString('en-US')}）`
    };
  }
  const bank = Math.max(0, Number(player.bank) || 0);
  if (bank < 1) {
    return { ok: false, status: 400, error: '银行里没有存款，先升级账号才会存钱进来' };
  }
  const rate = rateMin + Math.random() * (rateMax - rateMin);
  const amount = Math.min(bank, Math.max(floor, Math.floor(bank * rate)));
  player.bank = bank - amount;
  player.cash = (Number(player.cash) || 0) + amount;
  return { ok: true, amount, rate, bank: player.bank, cash: player.cash };
}
