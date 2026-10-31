// 全局可调参数。管理面板改的就是这里被持久化的那一份。
export const DEFAULT_CONFIG = {
  // ---- 时间 ----
  tickMs: 5000,             // 一轮 5 秒
  historyTicks: 3600,       // 每只票保留多少个 tick 的价格（5s × 3600 = 5 小时）

  // ---- 波动 ----
  // 原来 bot 是 120s 一轮、σ≈3%/轮。这里改成 5s 一轮，
  // 用 0.22%/轮 把日波动压到约 29%（17280 轮/天），比原来温和很多。
  baseVolatility: 0.0022,
  meanReversion: 0.00017,   // 对数空间回归，半衰期约 5.7 小时
  eventImpactScale: 1.0,    // 新闻冲击倍率

  // ---- 交易 ----
  startingCash: 100000,
  feeRate: 0.0005,          // 手续费（开平仓都收，按成交额）
  stampDuty: 0.0005,        // 印花税（卖出方向收）
  minLeverage: 1,
  maxLeverage: 20,
  liquidationBuffer: 0.0,   // 保证金亏到 0 就强平
  maxOrdersPerTick: 1,      // 每人每轮最多下几单（防止刷成交额抬小灯证券）

  // ---- 新闻 ----
  eventChance: 0.015,       // 每 tick 出全球新闻的概率
  localEventChance: 0.004,  // 每 tick 出「突发」的概率
  eventDurationMin: 30,     // 新闻持续 tick 数
  eventDurationMax: 90,

  // ---- 丰川银行（高利贷）----
  loanEnabled: true,
  loanTiers: [50000, 200000, 1000000],  // 三个固定档位
  loanRatePer100Ticks: 0.03,            // 每 100 轮（约 8.3 分钟）复利 3%
  loanTermHours: 2,                     // 借多久必须还
  loanMinRepay: 1000,                   // 手动还款最小金额

  // ---- 券商特质（小灯证券）----
  brokerMidpoint: 0.1,      // 每 tick 成交笔数的中性点（约 1 笔 / 50 秒）
  brokerSensitivity: 0.0001,
  brokerCap: 0.0002,
  brokerAlpha: 0.02,        // 中性点漂移速度

  // ---- 市场状态 ----
  marketOpen: true,         // 休市 = 冻结行情（价格不动、新闻不刷、利息暂停）

  // ---- 管理 ----
  adminPin: '000000',
  allowRegister: true,
  pinLength: 6              // 玩家 PIN 位数
};

// 交易周期（tick 数）
export const TIMEFRAMES = {
  '1m': 12,
  '5m': 60,
  '15m': 180,
  '1h': 720,
  '4h': 2880
};

export const TF_LABELS = {
  '1m': '1 分钟',
  '5m': '5 分钟',
  '15m': '15 分钟',
  '1h': '1 小时',
  '4h': '4 小时'
};

// 每多少 tick 结一次利息
export const LOAN_PERIOD_TICKS = 100;
