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
  // 每条新闻总时长写死在 engine.js 的 NEWS_DURATION（80~200 轮，两阶段机制）：
  // 以前这里有两个 eventDurationMin/Max 配置项，面板上能改但引擎根本没读，2026-11 删掉了

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

  // ---- 个股特性「早市冲量」（LU 瑞幸咖啡）----
  // 每天 start~end 点之间，价格沿一条线性斜坡被推上去：t 时刻的目标价 =
  // 进窗口时的价格 × (1 + total × 进度)。每轮最多贴近 pull，所以是「托着涨」而不是瞬移。
  morningRallyEnabled: 1,
  morningRallyStartHour: 6,     // 窗口开始（服务器本地时间，0~23）
  morningRallyEndHour: 10,      // 窗口结束
  morningRallyTotal: 0.25,      // 窗口内累计目标涨幅（0.25 = +25%）
  morningRallyPull: 0.02,       // 每轮最多向目标价贴近多少（对数）

  // ---- 挂单 ----
  limitOrderEnabled: 1,     // 1=允许限价挂单
  orderTtlTicks: 2000,      // 挂单多久没成交自动撤（2000 轮 ≈ 2.8 小时）
  maxPendingOrders: 5,      // 每人最多同时挂几笔

  // ---- ST 与退市 ----
  stPrice: 3,          // 股价跌破这个值进入 ST

  // ---- 分红派息 ----
  dividendRate: 1,     // 派息倍率：1 = 按行业标准（金融40% 消费45% 传媒30% 外汇35% 科技12%），0 = 停发
  dividendCap: 0.015,  // 单期股息率封顶（0.015 = 最多发现价的 1.5%；0 = 不封顶）

  // ---- 公司成长 / 估值上限 ----
  growthCeiling: 8,    // 营收天花板：最多长到基准营收的多少倍（无限接近，不超过）
  maxPremium: 2.5,     // 估值上限：股价最多是 fair 的多少倍（超过会被压回这条线）
  // 整点拉升（麦当劳专属）：每天 12:00 / 18:00 各一次，幅度在这个区间里随机
  rallyMin: 0.05,
  rallyMax: 0.2,

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
  mindThemePrice: 5000000,     // 「情绪读心」主题售价（Lv.2 商店）
  // ===== 财报随机偏移（体量越大偏移越小）=====
  reportVol: 0.05,             // 基准体量（1000 亿）公司的每期偏移标准差
  fairLookback: 8,             // 价值线（fair）用最近几期财报的 EPS 趋势拟合（3~12，<3 期回退到只看最后一期）
                               // 8 期：端点权重从 60% 降到 42%，单期噪声传递 ~50%，且不像几何平均那样滞后趋势
  reportVolMin: 0.01,          // 偏移量下限（巨无霸公司）
  reportVolMax: 0.1,           // 偏移量上限（小公司）
  reportRefCap: 100000000000,  // 基准体量：1000 亿

  // ===== 金价（矿工银行的财报驱动源，游戏内模拟）=====
  goldBase: 2400,              // 基准金价（美元/盎司）
  goldVol: 0.0012,             // 每轮波动（0.0012 = 0.12%）
  goldRev: 0.002,              // 每轮向基准回归的速度
  goldCoef: 2.2,               // 财报增速 = 金价涨跌 × 该系数（个股 trait 可覆盖）
  goldJitter: 0.03,            // 财报的随机上下浮动（±3%，个股 trait 可覆盖）

  // 「情绪读心」看到假值的概率：0 = 永远准，0.5 = 一半是假的，1 = 全假
  mindFakeChance: 0.5,
  // Ⅱ 阶（进化后）看到真值的概率：0.7 = 70% 准。进化只有这一条效果，没有别的
  mindAccurateChanceEvolved: 0.7,

  // ---- 夜行者主题（Lv.2）----
  nightStartHour: 22,      // 现实时间几点开始算夜里（服务器本地时间）
  nightEndHour: 5,         // 几点结束（支持跨零点）
  nightStealCooldown: 50,  // 夜行者夜里偷钱的冷却（轮），其他情况用 stealCooldownTicks
  nightStealCooldownEvolved: 20,  // 进化后夜里偷钱冷却（硬底线 1 轮）

  // ================= 主题成就 / 主题进化（Lv1 → Lv2）=================
  // 见 docs/成就系统设计.md §9。这里只是默认值，线上以 db.config 为准。
  // 两条成就 = 2 枚结晶；进化消耗 achvShardPerEvolve 枚
  achvShardPerEvolve: 2,
  // 🐂 红红的牛
  achvRedTrendTarget: 20,          // 多头排列平仓次数
  achvRedBonusTarget: 5000000,     // 技能返现累计
  // 🐻 绿绿的熊
  achvBearTrendTarget: 20,         // 空头排列平仓次数
  achvBearBonusTarget: 5000000,    // 技能返现累计
  // 🕶️ 暗黑大手
  achvDarkHandTarget: 10000000,    // 同股同方向累计开仓额
  achvDarkHandCount: 1,            // 黑手需要成功的次数
  achvDarkPushTarget: 1,           // 推土机成功次数
  achvDarkPushWindowTicks: 200,    // 判定「别人刚开仓」的时间窗（轮）
  // 🐊 金融大鳄
  achvTycoonProphetTarget: 1,      // 先知命中次数
  achvTycoonProphetLeverage: 10,   // 先知要求的杠杆
  achvTycoonProfitTarget: 5000000, // 金融板块累计盈利
  // 🧙 隐世仙人
  achvHermitFollowTarget: 1,       // 跟随别人成交次数
  achvHermitPosTarget: 10000000,   // 单票持仓市值
  achvHermitFollowWindowTicks: 100,// 判定「别人刚成交」的时间窗（轮）
  // 🕵️ 暗中调查
  achvProbeWeakTarget: 1,          // 软柿子次数
  achvProbeWindowTicks: 100,       // 判定「别人刚建仓」的时间窗（轮）
  achvProbeTarget: 20,             // 累计调查次数
  // 🧠 情绪读心
  achvMindReadTarget: 1,           // 极强情绪顺势盈利次数
  achvMindExtreme: 0.8,            // 算「极度强烈」的门槛
  achvMindProfitTarget: 10000000,  // 带技能累计盈利
  // 🌙 夜行者
  achvNightBigSteal: 9500,         // 单次偷钱金额
  achvNightStealTarget: 200,       // 夜里偷钱成功次数

  // ===== 全局成就：价值投资（不绑主题，不产结晶，完成后上排行榜）=====
  achvValueDeviation: 0.3,         // 价格偏离价值线多少算「远离」（0.3 = 30%）
  achvValueOpenMin: 5000000,       // 单笔建仓门槛（500 万）
  achvValueHoldTicks: 17280,       // 长线要求持有轮数（24 小时 = 17280 轮）
  achvValueProfitPct: 100,         // 长线要求的收益率（按保证金算，100 = 100%）
  achvValueCrossTarget: 1,         // 价值回归任务次数
  achvValueHoldTarget: 1,          // 长线价值任务次数

  // ===== 全局成就：短线擒龙 =====
  achvShortOpenMin: 1000000,       // 单笔建仓门槛（100 万）
  achvShortNextPnlPct: 20,         // 「下一轮就平仓」的收益率门槛
  achvShortWindowTicks: 120,       // 短线窗口（10 分钟 = 120 轮）
  achvShortPnlPct: 100,            // 窗口内平仓的收益率门槛
  achvDragonNextTarget: 1,
  achvDragonFastTarget: 1,
  // 1（默认）= 两个小任务都完成才发放成就；0 = 任一完成即可
  achvGlobalRequireAll: 1,

  // ---- 进化后的技能数值（Lv2 才生效）----
  // 2026-11 按 docs/主题技能.md 重平衡：二级技能统一是「数值更强」，
  // 不再有「红牛免手续费 / 绿熊保证金减免」这两个额外效果。
  themeEvolveSkillMult: 1.5,       // 红牛/绿熊返现倍率（1.0 → 1.5，1% → 1.5%）
  darkImpactBase: 1.05,            // 暗黑大手冲击倍率（未进化，1 = 不加成）
  themeEvolveImpact: 1.1,          // 暗黑大手冲击倍率（进化后）
  themeEvolveImpactRefund: 0.2,    // 暗黑大手返还自己冲击成本的比例
  tycoonLeadTicks: 20,             // 金融大鳄提前量（未进化）
  tycoonLeadTicksEvolved: 40,      // 金融大鳄提前量（进化后）
  hermitHideChance: 0.75,          // 隐世仙人成交隐身概率
  hermitHideChanceEvolved: 1,      // 进化后隐身概率（100% = 完全隐身）
  investigateCooldownTicks: 30,    // 暗中调查冷却（未进化）
  investigateCooldownEvolved: 20,  // 暗中调查冷却（进化后）
  shopBgPrice: 5000000,        // 自定义背景（一次买断）
  shopRenamePrice: 1000000,    // 改名卡
  shopRenameCooldown: 2000,    // 改名冷却（轮）
  levelBaseAsset: 10000000,    // 升到 lv2 需要的资产（之后每级 ×10）
  levelGrowth: 2,              // 每升一级资产门槛翻几倍
  levelUpRatio: 0.6,           // 升级花掉自身资产的百分比
  // 账号等级对「每轮单笔成交上限」的加成：每个等级 +100 万。
  // 和商城「交易专属通道」叠乘——等级给底子，通道继续买。
  levelFillBonus: 1000000,
  shopThemeCooldown: 100,      // 换主题后的冷却轮数

  // 交易专属通道：每次 +10 万单笔成交上限，价格指数增长
  shopChannelBasePrice: 300000,  // 第一次购买的价格
  shopChannelRatio: 1.5,         // 每买一次价格乘这个
  shopChannelStep: 100000,       // 每次提升的成交额

  // 自动定投（Lv.2 道具）：打工钱袋一满就自动挂单买 DENG
  shopAutoDcaPrice: 5000000,     // 售价
  shopAutoDcaPremium: 0.03,      // 挂单价 = 现价 ×(1+3%)，保证下一轮能成交

  // 咸鱼代下单（Lv.1 道具）：5 分钟内所有交易手续费全免（手续费 + 印花税）
  shopFreeFeePrice: 500000,      // 售价
  shopFreeFeeTicks: 60,          // 生效时长（60 轮 = 5 分钟）
  shopFreeFeeCooldown: 100,      // 冷却（用完要等 100 轮才能再买）

  // 游资情报（Lv.3 道具）：告诉你游资下一次进场的板块
  shopHotTipPrice: 2000000,      // 售价
  shopHotTipCooldown: 500,       // 冷却（轮）

  // ---- 丰川银行 ----
  // 账号升级交的钱会存进银行；总资产低于阈值时可以取一笔救急
  bankPoorThreshold: 100000,     // 总资产低于这个数才允许取钱
  // 每次取「存款 × 随机(rateMin ~ rateMax)」，但不少于 floor（存款不足就取全部）
  bankWithdrawRateMin: 0.01,     // 1%
  bankWithdrawRateMax: 0.20,     // 20%
  bankWithdrawFloor: 100000,     // 下限 10 万

  // 暗中调查（Lv.2 主题技能）：查别人一个随机持仓的冷却轮数
  investigateCooldownTicks: 30,

  // 市场噪声成交：每轮编几笔「散户」成交，让成交列表看着像有人在交易
  // ---- 定时休市 / 循环作息（2026-11）----
  // 循环：开市 marketCycleOpenMin 分钟 → 休市 marketCycleCloseMin 分钟，按现实时间无限循环
  // 默认开 5 分 / 休 2 分（相当于「白天 5 分钟、夜里 2 分钟」，一根 5 分钟 K 线 = 一个交易日）
  marketCycleEnabled: 1,
  marketCycleOpenMin: 5,
  marketCycleCloseMin: 2,

  marketTradesEnabled: 1,
  // 出现频率：每轮笔数 = 随机(1~2) × 这个数，6 = 每轮 6~12 笔（2026-11 从 3 翻倍到 6）
  marketTradesRate: 6,
  // 2026-11 起这些「虚假成交」会真的推动股价（走独立的 st.mflow 市场资金通道）
  // 金额分三档，越低档越常见；三个数字只是权重，会按比例归一化
  marketTradesSmallP: 70,     // 一档 1 万 ~ 10 万 的占比
  marketTradesMidP: 24,       // 二档 10 万 ~ 100 万
  marketTradesBigP: 6,        // 三档 100 万 ~ 1000 万
  // 追涨系数：满幅时买盘概率 = 0.5 + 这个数/100（25 → 0.75，0 = 买卖各半）
  marketTradesChase: 25,
  // 杀跌系数：满幅时卖盘概率 = 0.5 + 这个数/100（和追涨分开调，才能做非对称手感）
  marketTradesPanic: 25,
  // 判定窗口：看最近多少轮的涨跌幅（12 轮 = 1 分钟）
  // 以前判「本轮 vs 上一轮」，每轮噪声 0.5%~1%，1% 一档几乎帧帧打满；1 分钟动量能把噪声摊平
  marketTradesWindow: 12,
  // 触发幅度：**窗口内**涨跌多少算「一档」（0.03 = 1 分钟涨跌 3%）
  // 三段式：不到 1 档不偏（死区）→ 1~2 档线性到满幅 → 超过 3 档开始减弱、5 档归零（涨太多没人追）
  marketTradesTrigger: 0.03,
  // ---- 重大利好 / 重大利空（2026-11 新增）----
  // 开关 + 节奏：平均多久一条 / 最少隔多久一条（都按小时，和 tickMs 解耦）
  majorNewsEnabled: 1,
  // 平均间隔（小时）：0 = 关掉重大新闻；概率 = tickMs / (这个 × 3600000)
  // 12 = 平均 12 小时一条（8640 轮）
  majorNewsAvgHours: 12,
  // 短期股价冲击幅度：利好 ×(1+s)、利空 ×1/(1+s)，严格互为倒数（长期零漂移）
  majorNewsPriceShock: 0.2,
  // 冲击持续多少轮（分这么多轮走完上面那段幅度）
  majorNewsTicks: 5,
  // 价值线（fair）立刻平移的幅度：同样 ×(1±f) / 1/(1±f)
  majorNewsFairShift: 0.15,
  // 下一期财报的增速偏移（对数空间，正=超预期、负=不及预期），只影响一期
  majorNewsReportBias: 0.4,
  // 公告挂多久（小时）：价格冲击只有前面几轮，公告本身在快讯里挂满这么久
  majorNewsAnnounceHours: 3,
  // 聊天室红包有效期（小时）：默认 2 小时，到点不能再抢（消息和「已抢光/已过期」状态保留）
  packetTtlHours: 2,

  // 两条重大新闻之间的最小间隔（小时）：默认 1 小时
  // 这是**硬闸**：不管概率参数怎么配，1 小时内最多出一条，避免「一下子刷出好几条」
  majorNewsMinGapHours: 1,

  // ---- 散户情绪落地（2026-11 新增）----
  // 成交笔数按**流通市值**分配：指数 1 = 完全按流通市值（大票笔数多、推动力和小票接近），
  // 0 = 各票一样多（老行为，会变成「小票被推得很猛、大票纹丝不动」）
  marketTradesSizeExp: 1,
  // 情绪对方向的影响（百分点）：情绪 v=+1 时买盘概率 +这个数/100（25 → +25pp）
  marketTradesSentBias: 25,
  // 情绪放量（百分比）：|v|=1 时这只票的成交笔数 ×(1 + 这个数/100)（60 → ×1.6）
  marketTradesSentVol: 60,
  // 指数虚假成交的权重系数：指数的「市值」= 成分股流通市值之和，
  // 再乘这个系数当抽签权重（0.15 ≈ 指数占全部虚假成交的 7%~10%；0 = 指数没有虚假成交）
  // 指数单会按权重拆给成分股：成交记录记在指数上，成交量/冲击落到每只成分股
  indexTradeScale: 0.08,
  // 开盘巨量：休市（夜间 / 定时 / 管理员）结束后的第一轮，成交笔数 ×这个倍率（3 = 三倍量）
  // 0 或 1 = 不额外放量；只作用开市后的第一轮，之后恢复正常
  reopenSurgeMult: 3,

  // ---- 游资资金（2026-11 新增）----
  // 在板块之间轮动：在一只票上买入 → 待 20~300 轮 → 换板块（卖旧买新）
  // 成交记录混在虚假成交里（同样的昵称 / 小动物头像），前端不额外展示
  hotMoneyEnabled: 1,
  hotMoneySwitchMin: 20,      // 换板块的最短间隔（轮）
  hotMoneySwitchMax: 300,     // 最长间隔
  hotMoneyMin: 10000000,      // 每一笔的下限（1000 万）
  hotMoneyMax: 30000000,      // 每一笔的上限（3000 万）

  // ---- 市场资金对价格的影响（虚假成交 + 游资共用）----
  // 和玩家冲击（st.flow）完全分开的一套通道（st.mflow），互不抢上限
  marketImpactEnabled: 1,
  marketImpactRef: 10000000,      // 压力基准：一笔 1000 万算 1 单位
  // 0.002 = 每单位压力每轮推 0.2%（再乘 impactFactor，小盘股放大）
  // 实测：一笔 1000 万虚假成交 ≈ 推动 0.3%~1%；一笔 3000 万游资 ≈ 1%~3%（tests/sim-market-flow.mjs）
  marketImpactStrength: 0.002,
  marketImpactMax: 0.008,         // 单轮最多推动 0.8%
  marketImpactDecay: 0.85,        // 压力每轮衰减系数
  marketImpactFlowMax: 8,         // 压力上限（单位）

  // 全市场新闻的冲击折扣（1 = 不打折）
  globalEventScale: 0.2,

  // 散户情绪：每隔一段随机周期重掷方向，按 tick 间隔施加随机偏移
  sentimentEnabled: 1,  sentimentStrength: 0.004,    // 情绪 1.0 时的基准偏移（0.4%）
  sentimentTicks: 12,          // 每多少 tick 施加一次
  // 方向分量：swing = v × strength × (drift + (1-drift)×U(-1,1))
  // drift = 0 是纯随机（旧行为，v 只决定抖动大小）；1 是纯方向（v 决定涨跌）
  sentimentDrift: 0.6,
  // 情绪值的「顶端难度」：v 本来是均匀抽 -1~1，套一层对数后越靠两端越难抽到
  // 0 = 保持均匀；越大越难到 ±1（默认 3，约把均值从 0.50 压到 0.39）
  sentimentEdge: 3,
  // 重掷周期改成随机范围（轮）：每次重掷从 [min, max] 里重新抽一个间隔
  // 默认 480~960 轮 ≈ 40~80 分钟，均值仍是原来的 1 小时
  sentimentRollMin: 480,
  sentimentRollMax: 960,
  // 老字段（固定周期）：只在 min/max 都没配时兜底
  sentimentRollTicks: 720,

  // 哈基蜂业抽奖：每轮触发概率 / 涨跌幅区间

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
  stealCapRatio: 0.001,     // 上限：被偷人「现金」的 0.1%（持仓里的钱偷不到）
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

// 交易周期（tick 数）：一根 K 线由多少个 tick 聚合而成
// 注意：'10 轮' 那一档 2026-11 下线了（前端按钮删掉，接口也不再支持），
// 5m / 15m 各自有独立数据包（bars5 / bars15），这里只留 1m
export const TIMEFRAMES = {
  '1m': 12,
  '5m': 60,
  '15m': 180
};

export const TF_LABELS = {
  '1m': '1 分钟',
  '5m': '5 分钟',
  '15m': '15 分钟'
};

