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
  startingCash: 0,          // 新开户从 0 开始，得先打工
  feeRate: 0.0005,          // 手续费（开平仓都收，按成交额）
  stampDuty: 0.0005,        // 印花税（卖出方向收）
  minLeverage: 1,
  maxLeverage: 20,
  liquidationBuffer: 0.0,   // 保证金亏到 0 就强平
  maxOrdersPerTick: 5,       // 每人每轮最多操作几次（只限制个人，全服不限）

  // ---- 新闻 ----
  eventChance: 0.012,       // 每 tick 触发一条新新闻的概率
  // 每条新闻总时长 80~200 轮（见 engine.js 的两阶段机制）
  eventDurationMin: 80,
  eventDurationMax: 200,

  // ---- 打工（自动积累）----
  workRatePerTick: 50,      // 每轮自动往钱袋里攒多少
  workOnlineMultiplier: 2,  // 在线时攒的速度翻倍
  workBankTicks: 1440,      // 钱袋上限按多少轮算（1440 轮 = 2 小时）

  // ---- 玩家资金冲击（真实股市感）----
  playerImpactEnabled: 1,        // 1=开启
  playerImpactRef: 1000000,      // 参考成交额：一笔 100 万算 1 单位压力
  impactRefFreeCap: 10000000000, // 参考流通市值（100 亿）：小盘股冲击放大、大盘股削弱
  playerImpactStrength: 0.0009,  // 每单位压力推动多少价格（0.0009 = 0.09%）
  playerImpactDecay: 0.88,       // 压力每轮衰减系数
  // 后续影响倍率：1 = 照常；0.5 = 只有首轮全额，之后每轮只有一半力度
  // 首轮冲击不受影响（首轮永远按 1 倍算）
  playerImpactTail: 1,
  playerImpactMax: 0.008,        // 单轮最多推动 0.8%
  playerImpactFlowMax: 12,       // 压力上限（防止堆到离谱；也限制大单的极限涨幅）

  // 冲击成本：下单的人要为自己制造的价格冲击付钱
  //   费率 = 成交额 / 参考额 × 推力系数 × 本系数（封顶 impactCostMax）
  //   默认 6 → 「买入 → 等涨 → 卖出」这种自洗来回的收益变成负数
  impactCostCoef: 6,
  impactCostMax: 0.06,

  // ---- 挂单 ----
  limitOrderEnabled: 1,     // 1=允许限价挂单
  orderTtlTicks: 720,       // 挂单多久没成交自动撤（720 轮 = 1 小时）
  maxPendingOrders: 5,      // 每人最多同时挂几笔

  // ---- ST 与退市 ----
  stPrice: 3,          // 股价跌破这个值进入 ST

  // ---- 实时汇率（留美外汇的驱动）----
  fxEnabled: 1,        // 1=开启 0=纯随机
  fxRefreshMs: 60000,  // 多久抓一次汇率
  fxCoef: 1,           // 汇率涨跌放大系数
  fxLeverage: 8,       // 杠杆倍数（和系数相乘）
  fxTrack: 0.06,       // 每轮向目标价靠拢的比例
  stDelistTicks: 100,  // 连续这么多轮低于该值就退市

  // ---- 商城 ----
  shopFakeNewsPrice: 100000,   // 假新闻售价
  shopFakeNewsChance: 0.2,     // 真的会影响市场的概率（其余只显示不生效）
  shopFakeNewsCooldown: 120,   // 冷却轮数（120 轮 = 10 分钟）
  shopBodyguardPrice: 50000,   // 保镖售价
  shopBodyguardTicks: 720,     // 保护时长（720 轮 = 1 小时）
  shopThemePrice: 2000000,     // 主题配色售价
  shopBgPrice: 5000000,        // 自定义背景（一次买断）
  shopRenamePrice: 1000000,    // 改名卡
  shopRenameCooldown: 2000,    // 改名冷却（轮）
  levelBaseAsset: 10000000,    // 升到 lv2 需要的资产（之后每级 ×10）
  levelGrowth: 2,              // 每升一级资产门槛翻几倍
  levelUpRatio: 0.6,           // 升级花掉自身资产的百分比
  shopThemeCooldown: 100,      // 换主题后的冷却轮数

  // 交易专属通道：每次 +10 万单笔成交上限，价格指数增长
  shopChannelBasePrice: 300000,  // 第一次购买的价格
  shopChannelRatio: 1.5,         // 每买一次价格乘这个
  shopChannelStep: 100000,       // 每次提升的成交额

  // 暗中调查（Lv.2 主题技能）：查别人一个随机持仓的冷却轮数
  investigateCooldownTicks: 30,

  // 市场噪声成交：每轮编几笔「散户」成交，让成交列表看着像有人在交易
  marketTradesEnabled: 1,
  marketTradesRate: 3,        // 噪声成交数量倍率（3 = 三倍）

  // 全市场新闻的冲击折扣（1 = 不打折）
  globalEventScale: 0.2,

  // 散户情绪：每小时随机一个方向，按 tick 间隔施加随机偏移
  sentimentEnabled: 1,
  sentimentStrength: 0.004,    // 情绪 1.0 时的基准偏移（0.4%）
  sentimentTicks: 12,          // 每多少 tick 施加一次
  sentimentRollTicks: 720,     // 多少 tick 重掷一次情绪（720 = 1 小时）

  // 哈基蜂业抽奖：每轮触发概率 / 涨跌幅区间
  weatherLotteryChance: 0.0006,
  weatherLotteryLo: 0.12,
  weatherLotteryHi: 0.40,

  // 财报：每多少轮发一期（720 轮 = 1 小时）
  reportIntervalTicks: 720,

  // 指数调仓周期（2160 轮 = 3 小时 = 一个「季度」）
  indexRebalanceTicks: 2160,


  // 「红红的牛」技能：指数处于上升趋势时平仓，额外返 1% 成交额
  redBonusRate: 0.01,
  bearBonusRate: 0.01,
  redBonusMinTicks: 12,
  bearBonusMinTicks: 12,        // 持仓至少满这么多轮才算（防开平刷奖励）

  // ---- 成交节奏 ----
  // 挂单可以挂任意数量，但每轮最多成交这么多「金额」
  // 用成交额而不是股数：杠杆只是少占用保证金，实际买卖的市场冲击按金额算，
  // 所以 1 倍和 20 倍杠杆在这一项上完全一样，不会出现「小资金大冲击」
  maxFillNotionalPerTick: 300000,

  // ---- 收益曲线 ----
  equitySampleTicks: 12,    // 每多少轮记录一次资产快照（12 轮 ≈ 1 分钟）
  equityMaxPoints: 400,     // 每人最多留多少个点（≈ 6.7 小时）

  // ---- 偷钱 ----
  stealMin: 100,            // 单次最少偷多少
  stealMax: 10000,          // 单次最多偷多少
  stealCapRatio: 0.001,     // 上限：被偷人「总资产」的 0.1%（实际只能从现金里拿）
  stealCooldownTicks: 60,   // 偷钱冷却：得手后多少轮才能再偷（60 轮 ≈ 5 分钟）

  // ---- 券商特质（小灯证券）----
  brokerMidpoint: 0.1,      // 每 tick 成交笔数的中性点（约 1 笔 / 50 秒）
  brokerMidFloor: 0.05,     // 中性点的地板：不设地板的话冷淡期 ratio≈1，
                            // 等于「没有成交也不跌」，业绩效应就会单边往上累积
  brokerSensitivity: 0.00002,   // 每轮业绩修正 = sens × ln(实际/中枢)
  brokerCap: 0.000025,          // 单轮修正上限 ±0.0025%
  brokerAlpha: 0.05,        // 中性点追踪速度（越大越快吃掉短期波动）

  // ---- 市场状态 ----
  marketOpen: true,         // 休市 = 冻结行情（价格不动、新闻不刷、利息暂停）

  // ---- 管理 ----
  adminPin: '135791',       // 管理员口令（部署后可在管理面板里改）
  allowRegister: true,
  pinLength: 6              // 玩家 PIN 位数
};

// 交易周期（tick 数）
export const TIMEFRAMES = {
  'tick': 1,     // 每个 tick 一根
  '1m': 12,
  '5m': 60,
  '15m': 180
};

export const TF_LABELS = {
  'tick': '逐 tick',
  '1m': '1 分钟',
  '5m': '5 分钟',
  '15m': '15 分钟'
};

