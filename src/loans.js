// 丰川银行（高利贷）
// 计息规则：每 100 轮（5s × 100 ≈ 8.3 分钟）复利一次，固定利率。
// 到期还不上 → 破产，昵称写进「天台楼下记录册」。
import { now } from './store.js';
import { playerEquity } from './trading.js';

const PERIOD = 100;

/** 每个 tick 调一次：跨过 100 轮就结一次息，到期就判生死 */
export function accrueLoans(db) {
  const cfg = db.config;
  if (!cfg.loanEnabled) return [];
  const rate = Number(cfg.loanRatePer100Ticks ?? 0.03);
  const deaths = [];

  for (const player of Object.values(db.players)) {
    if (player.bankrupt) continue;
    const loan = player.loan;
    if (!loan || loan.debt <= 0) continue;

    // ---- 结息：按 100 tick 为一期，跨了几期就滚几次 ----
    const lastTick = loan.lastTick ?? db.tick;
    let periods = Math.floor((db.tick - lastTick) / PERIOD);
    if (periods > 0) {
      for (let i = 0; i < periods; i++) loan.debt *= 1 + rate;
      loan.lastTick = lastTick + periods * PERIOD;
      loan.interestPeriods = (loan.interestPeriods || 0) + periods;
    }

    // ---- 到期结算 ----
    if (now() >= loan.dueAt) {
      const equity = playerEquity(db, player);
      if (equity < loan.debt) {
        player.bankrupt = true;
        player.bankruptAt = now();
        player.bankruptDebt = loan.debt;
        db.book.push({
          nickname: player.nickname,
          amount: Number(loan.debt.toFixed(2)),
          cash: Number(player.cash.toFixed(2)),
          equity: Number(equity.toFixed(2)),
          borrowedAt: loan.takenAt,
          at: now()
        });
        deaths.push({
          playerId: player.id,
          nickname: player.nickname,
          debt: loan.debt,
          equity
        });
      } else {
        player.cash -= loan.debt;
        player.loan = null;
      }
    }
  }
  return deaths;
}

/** 借款：只接受配置里的三个固定档位 */
export function borrow(db, player, amount) {
  const cfg = db.config;
  if (!cfg.loanEnabled) return { ok: false, error: '丰川银行暂时停业' };
  if (player.bankrupt) return { ok: false, error: '你已经在天台楼下记录册里了' };

  const tiers = (cfg.loanTiers || [50000, 200000, 1000000]).map(Number);
  const amountNum = Number(amount);
  if (!tiers.includes(amountNum)) {
    return { ok: false, error: `只能借 ${tiers.map((t) => '$' + t.toLocaleString()).join(' / ')}` };
  }
  if (player.loan && player.loan.debt > 0) {
    return { ok: false, error: '你身上还有一笔没还清，先还完再借' };
  }

  const dueAt = now() + (cfg.loanTermHours ?? 2) * 3600 * 1000;
  player.cash += amountNum;
  player.loan = {
    principal: amountNum,
    debt: amountNum,
    takenAt: now(),
    dueAt,
    lastTick: db.tick,
    interestPeriods: 0
  };
  return { ok: true, loan: player.loan };
}

/**
 * 手动还款。
 * 传 amount 就是部分还款，不传就是一次还清。
 */
export function repay(db, player, amount) {
  const loan = player.loan;
  if (!loan || loan.debt <= 0) return { ok: false, error: '你没有欠款' };

  const cash = Number(player.cash) || 0;
  let pay;
  if (amount === undefined || amount === null || amount === '' ) {
    pay = Math.min(cash, loan.debt);
  } else {
    pay = Number(amount);
    if (!Number.isFinite(pay) || pay <= 0) return { ok: false, error: '还款金额无效' };
    const min = Number(db.config.loanMinRepay ?? 1000);
    if (pay < min) return { ok: false, error: `单次至少还 $${min.toLocaleString()}` };
    pay = Math.min(pay, cash, loan.debt);
  }

  if (pay <= 0) {
    return { ok: false, error: `现金不够，当前欠款 $${loan.debt.toFixed(2)}` };
  }

  player.cash = cash - pay;
  loan.debt -= pay;

  const cleared = loan.debt < 0.01;
  if (cleared) player.loan = null;

  return {
    ok: true,
    paid: pay,
    remaining: cleared ? 0 : loan.debt,
    cleared
  };
}
