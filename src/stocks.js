// 从 bot 版搬过来的 7 只标的（不含 ETF 与海车投行）
// trait 字段与 bot 版一一对应，只把数值按 5 秒 tick 重新标定过。

export const STOCK_SEED = {
  TGW: {
    code: 'TGW',
    name: '丰川集团',
    icon: '/assets/stocks/TGW.png',
    industry: '消费娱乐',
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
    desc: '咖啡连锁、新零售、饮品',
    initialPrice: 85,
    trait: {
      id: 'reversal',
      name: '反转王',
      desc: '连跌必反弹，连涨必回落',
      volMult: 1.3,
      revMult: 0.7,
      streak: 72,
      bounceLo: 0.04,
      bounceHi: 0.08
    }
  },
  NW: {
    code: 'NW',
    name: '奶蛙传媒',
    icon: '/assets/stocks/NW.png',
    industry: '消费娱乐',
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
    desc: '财团、偶像企划、游乐园',
    initialPrice: 180,
    trait: {
      id: 'backstop',
      name: '护盘',
      desc: '财团在下面接着，跌不深但也涨不动',
      revMult: 0.8,
      floorRatio: 0.85,
      floorBoost: 0.025
    }
  },
  XD: {
    code: 'XD',
    name: '小灯证券',
    icon: '/assets/stocks/XD.png',
    industry: '金融',
    desc: '券商、做市商、量化',
    initialPrice: 100,
    trait: {
      id: 'broker',
      name: '券商',
      desc: '靠市场成交吃饭，交易越活跃越赚',
      volMult: 0.6,
      revMult: 1.0
    }
  }
};

export const STOCK_CODES = Object.keys(STOCK_SEED);

// 指数基点
export const INDEX_BASE = 1000;
