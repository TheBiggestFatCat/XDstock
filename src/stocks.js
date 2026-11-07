// 从 bot 版搬过来的 7 只标的（不含 ETF 与海车投行）
// trait 字段与 bot 版一一对应，只把数值按 5 秒 tick 重新标定过。

export const STOCK_SEED = {
  TGW: {
    code: 'TGW',
    name: '丰川集团',
    icon: '/assets/stocks/TGW.png',
    industry: '消费娱乐',
    shares: 3000000000,   // 总股本 30 亿股
    freeFloat: 0.45,          // 流通比例
    desc: '综合商社、品牌零售、物流',
    initialPrice: 120,
    trait: {
      id: 'old_money',
      name: '老钱',
      desc: '家底厚，跌不光也涨不快',
      volMult: 0.6,
      revMult: 1.6
    }
  },
  MAMA: {
    code: 'MAMA',
    name: '无畏科技',
    icon: '/assets/stocks/MAMA.png',
    industry: '科技AI',
    shares: 800000000,   // 总股本 8 亿股
    freeFloat: 0.45,          // 流通比例
    desc: '电竞、游戏硬件、AI 算法',
    initialPrice: 150,
    trait: {
      id: 'casino',
      name: '赌场',
      desc: '一天一个样，涨得疯跌得更疯',
      volMult: 1.8,
      revMult: 0.5,
      // bot 是 120s 一轮的 +0.069%，这里按 24 倍换算
      drift: 0.000015
    }
  },
  DFY: {
    code: 'DFY',
    name: '肥鱼科技',
    icon: '/assets/stocks/DFY.png',
    industry: '科技AI',
    shares: 150000000,   // 总股本 1.5 亿股
    freeFloat: 0.45,          // 流通比例
    desc: '食品科技、直播电商、供应链',
    initialPrice: 90,
    trait: {
      id: 'hype',
      name: '话题驱动',
      desc: '平时没人看，一上新闻就翻倍反应',
      volMult: 0.8,
      eventMult: 2.0
    }
  },
  LU: {
    code: 'LU',
    name: '瑞幸咖啡',
    icon: '/assets/stocks/LU.png',
    industry: '消费娱乐',
    shares: 1500000000,   // 总股本 15 亿股
    freeFloat: 0.45,          // 流通比例
    desc: '咖啡连锁、新零售、饮品',
    initialPrice: 85,
    trait: {
      // 早市冲量：每天 6~10 点有一波「托着涨」的行情，力度在管理面板里调
      id: 'morning',
      name: '早市冲量',
      desc: '每天早上 6~10 点有一波持续的拉升',
      volMult: 1.1,
      revMult: 0.8
    }
  },
  NW: {
    code: 'NW',
    name: '奶蛙传媒',
    icon: '/assets/stocks/NW.png',
    industry: '消费娱乐',
    shares: 300000000,   // 总股本 3 亿股
    freeFloat: 0.45,          // 流通比例
    desc: '短视频、IP 运营、潮玩',
    initialPrice: 110,
    trait: {
      id: 'meme',
      name: '梗股',
      desc: '平时阴跌，突然全网玩梗就飞天',
      volMult: 0.9,
      // 原本 -0.11%/120s，按 24 倍换算
      drift: -0.00003,
      // 原本 0.6%/120s 触发一次，这里 0.025%/5s，平均同样是 5.5 小时一次
      lotteryChance: 0.00025,
      lotteryLo: 0.25,
      lotteryHi: 0.6
    }
  },
  XJ: {
    code: 'XJ',
    name: '弦卷财团',
    icon: '/assets/stocks/XJ.png',
    industry: '消费娱乐',
    shares: 2000000000,   // 总股本 20 亿股
    freeFloat: 0.45,          // 流通比例
    desc: '财团、偶像企划、游乐园',
    initialPrice: 180,
    // 长期路线：市值逐步萎缩到 5000 亿（5e11）。
    // 营收、净资产、合理价都按 capTargetRate 这个速度往目标靠，越靠越慢。
    capTarget: 500000000000,
    capTargetRate: 0.06,
    trait: {
      id: 'backstop',
      name: '护盘',
      desc: '财团在下面接着，跌不深但也涨不动',
      volMult: 1.25,
      revMult: 0.8,
      floorRatio: 0.85,
      floorBoost: 0.025
    }
  },
  MB: {
    code: 'MB',
    name: '矿工银行',
    icon: '/assets/stocks/MB.png',
    industry: '金融',
    shares: 1000000000,  // 总股本 10 亿股 → 100 × 10 亿 = 1000 亿
    freeFloat: 0.45,          // 流通比例
    desc: '矿业融资、贵金属交易、金库业务',
    // 市值目标 3000 亿：上市时 1000 亿，随着业务扩张一路往 3000 亿靠，越靠越慢
    // rate 0.08 ≈ 每期收掉 8% 的差距：首期 +16%，20 期到 2700 亿，30 期到 2900 亿
    capTarget: 300000000000,
    capTargetRate: 0.08,
    // 特性对外隐藏：前端/接口里看不到「金价驱动」这个名字和说明，
    // 玩家只能自己从「金价涨→财报好」的规律里去发现
    traitHidden: true,
    initialPrice: 100,
    trait: {
      id: 'gold',
      name: '金价驱动',
      desc: '财报跟着金价走：金价涨它就赚、跌就亏，另外每期还有一点随机浮动',
      volMult: 0.9,
      revMult: 1.0
      // 金价系数 / 随机浮动不写在这里：走全局配置 goldCoef / goldJitter
      // （特性对外隐藏，玩家能看到的只有财报本身）
    }
  },
  KFC: {
    code: 'KFC',
    name: '肯德基',
    icon: '/assets/stocks/KFC.png',
    industry: '消费娱乐',
    shares: 800000000,   // 总股本 8 亿股 → 100 × 8 亿 = 800 亿
    freeFloat: 0.45,
    desc: '快餐连锁、炸鸡、疯狂星期四',
    initialPrice: 100,
    // 市值目标 1000 亿：上市时 800 亿，慢慢往 1000 亿靠
    capTarget: 100000000000,
    capTargetRate: 0.08,
    trait: {
      id: 'mirror',
      name: '反向跟随',
      desc: '盯着麦当劳的涨跌做反向对冲：麦当劳涨它就跌，麦当劳跌它就涨；每周四中午还有一轮暴拉',
      volMult: 0.9,
      revMult: 1.0,
      // 反向加成的来源与倍数：logRet += -(对方这一轮涨跌幅) × 系数
      mirrorCode: 'MCD',
      mirrorCoef: 1,
      // 疯狂星期四：周四 11:00~13:00 之间随机一轮固定 +50%
      rallyWeekday: 4,
      rallyFrom: 11,
      rallyTo: 13,
      rallyBoost: 0.5
    }
  },
  XD: {
    code: 'XD',
    name: '小灯证券',
    icon: '/assets/stocks/XD.png',
    industry: '金融',
    shares: 600000000,   // 总股本 6 亿股
    freeFloat: 0.45,          // 流通比例
    desc: '券商、做市商、量化',
    initialPrice: 100,
    trait: {
      id: 'broker',
      name: '券商',
      desc: '靠市场成交吃饭，交易越活跃越赚',
      volMult: 0.6,
      revMult: 1.0
    }
  },
  MCD: {
    code: 'MCD',
    name: '麦当劳',
    icon: '/assets/stocks/MCD.png',
    industry: '消费娱乐',
    shares: 600000000,   // 总股本 6 亿股 → 327.35 × 6 亿 = 1964.1 亿
    freeFloat: 0.5,
    desc: '快餐连锁、品牌授权、全球门店',
    initialPrice: 327.35,
    // 2026-11 按需求**去掉市值天花板**（原来 capCeiling = 1e12 = 10000 亿，
    // 把股价硬夹在 1666.67，涨到头就再也上不去，看起来像卡死）。
    // 现在 MCD 没有专属上限，只剩两条全局规则：
    //   · 价格 ≤ fair × maxPremium（防泡沫，所有票都吃）
    //   · 营收 ≤ baseRev × growthCeiling（基本面天花板，会自然放慢增速）
    // 引擎仍然支持 capCeiling：其它票想设就写在这，跑 tests/mcd.mjs 会一起验。
    // 营收天花板：长到 4.5 倍就基本停（对应 EPS 约 80，PE 落在 20 附近，不会出现「PE 只有 8」的怪相）
    growthCeiling: 4.5,
    // 专属：每天现实时间 12:00 / 18:00 整各拉升一次
    rallyHours: [12, 18],
    trait: {
      id: 'steady',
      name: '稳步增长',
      desc: '财报稳得像闹钟，越远离天花板长得越快；每天 12 点和 18 点各拉一次',
      volMult: 0.7,
      revMult: 1.2,
      // 没有天花板时的每期增速（有 capCeiling 时越接近越慢）
      steadyGrowth: 0.028
    }
  }
};

export const STOCK_CODES = Object.keys(STOCK_SEED);

// 小灯指数：只编入市值最小的 7 家公司，调仓节奏和灯证指数一致
export const SMALL_INDEX_STOCK = {
  code: 'DENGS',
  name: '小灯指数',
  icon: '/assets/stocks/DENGS.png',
  industry: '指数',
  desc: '只编小盘股：市值最小的七家公司',
  initialPrice: 1000,
  trait: { id: 'index', name: '小盘指数', desc: '小公司的集合，波动更大' }
};

// 指数基点
export const INDEX_BASE = 1000;


// 灯证指数本身也做成一个可交易的标的（1:1 复制指数点位）
export const INDEX_STOCK = {
  code: 'DENG',
  name: '灯证指数',
  icon: '/assets/stocks/DENG.png',
  industry: '指数',
  desc: '七只标的的等权合成指数',
  initialPrice: 1000,
  trait: { id: 'index', name: '指数', desc: '跟大盘同涨同跌' }
};
