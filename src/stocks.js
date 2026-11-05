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
  LMFX: {
    code: 'LMFX',
    name: '留美外汇',
    icon: '/assets/stocks/LMFX.jpeg',
    industry: '金融',
    shares: 200000000,   // 总股本 2 亿股
    freeFloat: 0.45,          // 流通比例
    desc: '外汇自营、套息交易、高杠杆',
    initialPrice: 100,
    trait: {
      id: 'fx',
      name: '汇率杠杆',
      desc: '拿自营盘加杠杆押注澳元兑日元，汇率一动它就剧烈反应',
      volMult: 0.35,
      revMult: 0,
      // 股价 = 初始价 × (1 + 汇率涨跌 × 系数 × 杠杆)
      coef: 1,
      lev: 8,
      fxEnabled: 1,     // 1=由汇率驱动 0=纯随机
      refreshMs: 60000, // 多久抓一次汇率
      track: 0.06       // 每轮向目标价靠拢的比例
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
    // 市值天花板：10000 亿（1e12），无限接近但不超过
    capCeiling: 1000000000000,
    // 营收天花板：长到 4.5 倍就基本停（对应 EPS 约 80，PE 落在 20 附近，不会出现「PE 只有 8」的怪相）
    growthCeiling: 4.5,
    // 专属：每天现实时间 12:00 / 18:00 整各拉升一次
    rallyHours: [12, 18],
    trait: {
      id: 'steady',
      name: '稳步增长',
      desc: '财报稳得像闹钟，市值一点点往一万亿靠；每天 12 点和 18 点各拉一次',
      volMult: 0.7,
      revMult: 1.2,
      // 离天花板最远时的每期增速（越接近天花板越慢）
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
