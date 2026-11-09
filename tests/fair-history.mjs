// 价值线（fair）= 最近 N 期 EPS 趋势拟合，不再只认最后一期财报
//   node tests/fair-history.mjs
//
// 旧口径 `fairFromReport(st)`：只看最后一期的 eps / bps / growth。
// 新口径 `fairFromHistory(st, lookback)`：最近 N 期（默认 8，可配 3~12）EPS 取对数回归，
// 取拟合线在最后一期的值，成长溢价用拟合斜率；净资产底线仍用当前 bps × 0.8；
// 样本 < 3 期返回 null（调用方回退旧口径）。
// 为什么是 8 期：5 期时端点权重 60%、单期噪声传递 90%，基本等于没改（见开发者文档 §6.2.0）。

import { createDb, migrate } from '../src/store.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  fairFromHistory, fairFromReport, genNextReport, industryOf, EXPECT_LOOKBACK
} from '../src/fundamentals.js';
import { runReports } from '../src/engine.js';

let fails = 0;
let passes = 0;
const out = [];
const log = (...a) => out.push(a.join(' '));
function check(label, cond, detail = '') {
  if (cond) passes++; else fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const rel = (a, b) => (b > 0 ? a / b - 1 : 0);

/** 造一只票：eps 序列交给调用方，bps 用最新值 */
function mkStock(epsList, { bps = 0, growth = 0, industry = '科技' } = {}) {
  const history = epsList.map((eps, i) => ({
    period: i + 1,
    revenue: eps * 1e9,
    netProfit: eps * 1e8,
    eps,
    growth,
    margin: 0.2
  }));
  const last = epsList[epsList.length - 1] || 1;
  return {
    code: 'TST', name: '测试股', industry, shares: 1e9,
    trait: { id: 'reversal' },
    reportHistory: history,
    fundamentals: { period: epsList.length, revenue: last * 1e9, eps: last, bps, growth, margin: 0.2, baseRevenue: 1e9 }
  };
}

// ================================================================ 1
log('=== 1 趋势是等比时：拟合值和最后一期几乎一样（直线不会跑偏）===');
{
  check('看最近 5 期', EXPECT_LOOKBACK === 5, String(EXPECT_LOOKBACK));
  // eps 每期 ×1.05
  const eps = [0, 1, 2, 3, 4].map((i) => 1 * 1.05 ** i);
  const st = mkStock(eps, { growth: 0.05 });
  const fit = fairFromHistory(st);
  const ind = industryOf(st);
  const premium = 1 + Math.min(0.5, Math.max(0, 0.05) * 1.5);
  const epsLast = eps[4];
  check('等比走势：拟合 EPS ≈ 最后一期 EPS（差 <0.5%）',
    Math.abs(rel(Math.exp(Math.log(fit) - Math.log(epsLast * ind.pe * premium)), 1)) < 0.005 ||
    near(fit, epsLast * ind.pe * premium, epsLast * ind.pe * premium * 0.005),
    `fit=${fit.toFixed(3)} vs 直算=${(epsLast * ind.pe * premium).toFixed(3)}`);
  check('和旧口径 fairFromReport 基本一致',
    Math.abs(rel(fit, fairFromReport(st))) < 0.02, `旧=${fairFromReport(st).toFixed(2)} 新=${fit.toFixed(2)}`);
}

// ================================================================ 2
log('');
log('=== 2 最后一期暴涨/暴跌：新口径不会被单期财报拽走 ===');
{
  // 前 4 期平稳在 1.00，最后一期 eps 翻倍
  const spiked = mkStock([1, 1, 1, 1, 2], { growth: 0 });
  const oldFair = fairFromReport(spiked);
  const newFair = fairFromHistory(spiked);
  const base = fairFromReport(mkStock([1, 1, 1, 1, 1], { growth: 0 }));   // 平稳时的价值线
  check('旧口径被最后一期翻倍带走（≈2×）', Math.abs(rel(oldFair, base) - 1) < 0.02 && oldFair > base * 1.9,
    `旧=${oldFair.toFixed(2)} 平稳=${base.toFixed(2)}`);
  // 5 点回归里，端点自己的权重是 60%（拟合线在最后一期的值），所以翻倍仍会带动约 1.8×，
  // 但比旧口径的 2× 收敛了 —— 中间几期的噪声才是被彻底摊平的那部分
  check('新口径比旧口径收敛（<1.95×，旧的是 2×）', newFair > base * 1.5 && newFair < base * 1.95,
    `新=${newFair.toFixed(2)}（${(rel(newFair, base) * 100).toFixed(1)}%）`);
  check('新口径小于旧口径', newFair < oldFair, `${newFair.toFixed(2)} vs ${oldFair.toFixed(2)}`);

  // 最后一期腰斩
  const dump = mkStock([1, 1, 1, 1, 0.5], { growth: 0 });
  const oldDump = fairFromReport(dump);
  const newDump = fairFromHistory(dump);
  check('腰斩：旧口径直接砍半', oldDump < base * 0.55, `旧=${oldDump.toFixed(2)}`);
  check('腰斩：新口径只回落一点', newDump > base * 0.6 && newDump < base * 0.95,
    `新=${newDump.toFixed(2)}（${(rel(newDump, base) * 100).toFixed(1)}%）`);
}

// ================================================================ 3
log('');
log('=== 3 中间一期噪声：新口径把它摊平 ===');
{
  const noisy = [1, 1, 1.6, 1, 1];      // 第 3 期抽风
  const st = mkStock(noisy, { growth: 0 });
  const flat = mkStock([1, 1, 1, 1, 1], { growth: 0 });
  const fit = fairFromHistory(st);
  const flatFit = fairFromHistory(flat);
  check('中间一期抽风：只抬一点点（<15%，旧口径那条线根本不受影响但也完全看不到趋势）', fit > flatFit && fit < flatFit * 1.15,
    `fit=${fit.toFixed(2)} 平稳=${flatFit.toFixed(2)}（${(rel(fit, flatFit) * 100).toFixed(1)}%）`);
  check('旧口径只看最后一期 → 完全不受影响', near(fairFromReport(st), fairFromReport(flat), 1e-9));
}

// ================================================================ 4
log('');
log('=== 4 成长溢价用拟合斜率（不是最后一期的 growth 字段）===');
{
  const up = mkStock([1, 1.05, 1.1025, 1.1576, 1.2155], { growth: 0 });
  const flat = mkStock([1, 1, 1, 1, 1], { growth: 0.5 });     // growth 字段写 50%，但 EPS 是平的
  const ind = industryOf({ industry: '科技' });
  const upFair = fairFromHistory(up);
  const espUp = 1.2155;
  check('上涨趋势 → 带成长溢价（> EPS×PE）',
    upFair > espUp * ind.pe, `fair=${upFair.toFixed(2)} eps×pe=${(espUp * ind.pe).toFixed(2)}`);
  const flatFair = fairFromHistory(flat);
  check('EPS 持平的票不吃 growth 字段的虚高溢价（≈EPS×PE）',
    Math.abs(rel(flatFair, ind.pe)) < 0.02, `fair=${flatFair.toFixed(2)} eps×pe=${ind.pe.toFixed(2)}`);
  check('拟合溢价封顶（最多 +50%）', (() => {
    const crazy = mkStock([1, 3, 9, 27, 81]);
    const c = fairFromHistory(crazy);
    return c <= 81 * ind.pe * 1.5 + 1e-6;
  })());
}

// ================================================================ 5
log('');
log('=== 5 净资产底线还在 ===');
{
  const st = mkStock([0.01, 0.01, 0.01, 0.01, 0.01], { bps: 500 });
  const fit = fairFromHistory(st);
  check('EPS 很小但净资产高 → 价值线按 bps×0.8', near(fit, 500 * 0.8, 1e-6), String(fit));
  check('和旧口径的底线一致', near(fit, fairFromReport(st), 1e-6), `${fit} vs ${fairFromReport(st)}`);
}

// ================================================================ 6
log('');
log('=== 6 历史不够 / 脏数据 → null（调用方回退旧口径）===');
{
  check('2 期 → null', fairFromHistory(mkStock([1, 1.1])) === null);
  check('没有历史 → null', fairFromHistory({ fundamentals: { eps: 1, bps: 1 } }) === null);
  check('传 null 不炸', fairFromHistory(null) === null);
  check('全是非正 EPS → null', fairFromHistory(mkStock([0, -1, 0, -2, 0])) === null);
  check('5 期里只有 2 个正值 → null', fairFromHistory(mkStock([1, 0, 0, 0, 1.1])) === null);
  const dirty = mkStock([1, 1.1, 1.21, 1.33, 1.46]);
  dirty.reportHistory[0] = null;
  dirty.reportHistory[1] = { eps: 'x' };
  check('脏行被跳过（剩 3 期照样能拟合）', Number.isFinite(fairFromHistory(dirty)), String(fairFromHistory(dirty)));
  check('结果永远是正数', (() => {
    const v = fairFromHistory(mkStock([0.001, 0.0012, 0.0011, 0.0013, 0.0012]));
    return Number.isFinite(v) && v > 0;
  })());
}

// ================================================================ 7
log('');
log('=== 7 接进 runReports：价值线走拟合值，而不是最后一期 ===');
{
  const db = migrate(createDb());
  const st = db.stocks.TGW;
  Object.assign(db.config, {
    marketOpen: true, 
    marketCycleEnabled: 0,   // 测试里别被「夜间休市」拦住dividendRate: 0, reportIntervalTicks: 720,
    baseVolatility: 0, meanReversion: 0, eventChance: 0, marketTradesRate: 0,
    hotMoneyEnabled: 0, sentimentEnabled: 0, playerImpactEnabled: 0
  });
  db.tick = 1000;
  // 造 5 期平稳 + 最后一期翻倍的历史
  st.reportHistory = [1, 1, 1, 1, 2].map((eps, i) => ({
    period: 100 + i, revenue: eps * 1e9, netProfit: eps * 1e8, eps, growth: 0, margin: 0.2
  }));
  st.fundamentals = {
    ...st.fundamentals,
    period: 105, revenue: 2e9, netProfit: 2e8, eps: 2, bps: 0, growth: 0, margin: 0.2
  };
  st.fair = 100;
  st.nextReportTick = db.tick;
  st.pendingReport = {
    period: 106, revenue: 2e9, netProfit: 2e8, eps: 2, bps: 0, growth: 0, margin: 0.2,
    baseRevenue: 1e9, debt: 0.3, dividendRate: 0.1, roe: 0.1, reportAt: Date.now(), expectedGrowth: 0
  };
  for (const s of Object.values(db.stocks)) if (!s.isIndex && s.code !== 'TGW') s.nextReportTick = 1e12;

  const fitBefore = fairFromHistory(st);
  const oldBefore = fairFromReport(st);
  runReports(db);
  // 平滑公式：fair = 0.7 × computed + 0.3 × before
  const expectNew = fitBefore * 0.7 + 100 * 0.3;
  const expectOld = oldBefore * 0.7 + 100 * 0.3;
  check('runReports 用的是拟合值（fair ≈ 0.7×拟合 + 0.3×上期）',
    Math.abs(rel(st.fair, expectNew)) < 0.01, `fair=${st.fair} 期望=${expectNew.toFixed(2)}`);
  check('拟合值确实低于「只看最后一期」的算法', fitBefore < oldBefore, `拟合=${fitBefore.toFixed(2)} 旧=${oldBefore.toFixed(2)}`);
  check('结果更接近拟合口径（差 <1%），不是旧口径', Math.abs(rel(st.fair, expectNew)) < 0.01,
    `fair=${st.fair} 拟合口径=${expectNew.toFixed(2)} 旧口径=${expectOld.toFixed(2)}`);
}

// ================================================================ 9
log('');
log('=== 9 拟合期数可配（cfg.fairLookback，默认 8）===');
{
  // 前 7 期一路涨、最后 1 期持平；窗口越长，末端权重越低
  const eps = [1, 1.1, 1.21, 1.331, 1.4641, 1.6105, 1.7716, 1.7716];
  const st = mkStock(eps, { growth: 0 });
  const f5 = fairFromHistory(st, 5);
  const f8 = fairFromHistory(st, 8);
  check('5 期和 8 期窗口结果不同', Math.abs(rel(f5, f8)) > 0.001,
    `5期=${f5.toFixed(2)} 8期=${f8.toFixed(2)}`);
  check('默认窗口 = 8 期（DEFAULT_CONFIG.fairLookback）', Number(DEFAULT_CONFIG.fairLookback) === 8, String(DEFAULT_CONFIG.fairLookback));
  check('传 0 用默认 8 期', near(fairFromHistory(st, 0), f8, 1e-9));
  check('传 2 期（不足 3 个点）→ null，调用方回退', fairFromHistory(st, 2) === null);

  const db = migrate(createDb());
  Object.assign(db.config, {
    marketOpen: true, 
    marketCycleEnabled: 0,   // 测试里别被「夜间休市」拦住dividendRate: 0, reportIntervalTicks: 720,
    baseVolatility: 0, meanReversion: 0, eventChance: 0, marketTradesRate: 0,
    hotMoneyEnabled: 0, sentimentEnabled: 0, playerImpactEnabled: 0, fairLookback: 8
  });
  db.tick = 2000;
  const live = db.stocks.MCD;
  live.reportHistory = eps.map((e0, i) => ({
    period: 200 + i, revenue: e0 * 1e9, netProfit: e0 * 1e8, eps: e0, growth: 0, margin: 0.2
  }));
  live.fundamentals = {
    ...live.fundamentals, period: 208, revenue: 1.77e9, netProfit: 1.77e8,
    eps: 1.7716, bps: 0, growth: 0, margin: 0.2
  };
  live.fair = 1;
  live.nextReportTick = db.tick;
  live.pendingReport = {
    period: 209, revenue: 1.77e9, netProfit: 1.77e8, eps: 1.7716, bps: 0, growth: 0, margin: 0.2,
    baseRevenue: 1e9, debt: 0.3, dividendRate: 0.1, roe: 0.1, reportAt: Date.now(), expectedGrowth: 0
  };
  for (const s of Object.values(db.stocks)) if (!s.isIndex && s.code !== 'MCD') s.nextReportTick = 1e12;
  const fHistory8 = fairFromHistory(live, 8);
  const fHistory5 = fairFromHistory(live, 5);
  runReports(db);
  const expect8 = fHistory8 * 0.7 + 0.3;
  const expect5 = fHistory5 * 0.7 + 0.3;
  check('cfg.fairLookback=8 时 runReports 用 8 期窗口',
    Math.abs(rel(live.fair, expect8)) < 0.01 && Math.abs(rel(live.fair, expect5)) > 0.001,
    `fair=${live.fair.toFixed(2)} 8期=${expect8.toFixed(2)} 5期=${expect5.toFixed(2)}`);
}

// ================================================================ 10
log('');
log('=== 10 和「市场预期」共用同一套回归口径（都是对数回归）===');
{
  // 拟合出来的每期对数增速，应该和 expectedGrowthFromHistory 的 growth 完全对上
  const { expectedGrowthFromHistory } = await import('../src/fundamentals.js');
  const eps = [1, 1.1, 1.21, 1.331, 1.4641];
  const st = mkStock(eps, { growth: 0 });
  const g = expectedGrowthFromHistory(st.reportHistory.map((h) => ({ revenue: h.eps })), 5).growth;
  const ind = industryOf(st);
  const fair = fairFromHistory(st);
  const premium = 1 + Math.min(0.5, Math.max(0, g) * 1.5);
  check('按同一套斜率算出来的价值线 = fairFromHistory',
    Math.abs(rel(fair, eps[4] * ind.pe * premium)) < 0.01,
    `fair=${fair.toFixed(2)} 直算=${(eps[4] * ind.pe * premium).toFixed(2)}`);
}

// 兜底：生成下一期财报不依赖 reportHistory，别把生成逻辑带歪
{
  const st = mkStock([1, 1, 1, 1, 1], { growth: 0 });
  const r = genNextReport(st, { growthCeiling: 8 });
  check('genNextReport 正常出数（不 import 价值线）', Number(r.eps) > 0 && Number(r.revenue) > 0);
}

console.log(out.join('\n'));
console.log(`\n---- ${passes} 通过 / ${fails} 失败 ----`);
if (fails > 0) process.exit(1);
