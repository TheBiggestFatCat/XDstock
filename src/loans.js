import { now } from './store.js';
import { playerEquity } from './trading.js';

/** 每 tick 给欠款滚利息，到期还不上就送上天台 */
export function accrueLoans(db) {
  const cfg = db.config;
  if (!cfg.loanEnabled) return [];
  const tickDays = (cfg.tickMs ?? 5000) / 86400000;
  const perTickRate = Math.pow(1 + (cfg.loanDailyRate ?? 0.08), tickDays) - 1;
  const deaths = [];

  for (const player of Object.values(db.players)) {
    if (player.bankrupt) continue;
    const loan = player.loan;
    if (!loan || loan.principal <= 0) continue;

    loan.debt *= 1 + perTickRate;

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
        // 自动扣款
        player.cash -= loan.debt;
        player.loan = null;
      }
    }
  }
  return deaths;
}

export function borrow(db, player, amount) {
  const cfg = db.config;
  if (!cfg.loanEnabled) return { ok: false, error: '高利贷暂时关闭' };
  if (player.bankrupt) return { ok: false, error: '你已经在天台楼下记录册里了' };
  amount = Number(amount);
  if (!(amount > 0)) return { ok: false, error: '金额无效' };
  if (amount > (cfg.loanMaxAmount ?? 5e6)) {
    return { ok: false, error: `单笔最多 $${(cfg.loanMaxAmount ?? 5e6).toLocaleString()}` };
  }
  if (player.loan && player.loan.principal > 0) {
    return { ok: false, error: '你身上还有一笔高利贷没还清' };
  }

  const dueAt = now() + (cfg.loanTermHours ?? 2) * 3600 * 1000;
  player.cash += amount;
  player.loan = {
    principal: amount,
    debt: amount,
    takenAt: now(),
    dueAt
  };
  return { ok: true, loan: player.loan };
}

export function repay(db, player) {
  const loan = player.loan;
  if (!loan || loan.principal <= 0) return { ok: false, error: '你没有欠款' };
  if (player.cash < loan.debt) {
    return { ok: false, error: `还不上，需要 $${loan.debt.toFixed(2)}，你只有 $${player.cash.toFixed(2)}` };
  }
  player.cash -= loan.debt;
  player.loan = null;
  return { ok: true };
}
