// 新闻模板。trend 是「每 tick 的对数冲击」，
// 0.004 ≈ 每 tick +0.4%，持续 60 tick 就是 +27%。
// companies 为空数组表示全市场。

export const DEFAULT_NEWS = [
  { text: '「丰川集团」拿下海外老牌百货的独家代理，首批门店开始改造。', companies: ['TGW'], trend: 0.004 },
  { text: '「丰川集团」物流枢纽环评未过被叫停，前期投入全额计提。', companies: ['TGW'], trend: -0.004 },
  { text: '「无畏科技」新一代 DMA 板良率翻倍，订单排到下季度。', companies: ['MAMA'], trend: 0.005 },
  { text: '「无畏科技」外挂业务被跨省协查，代理商连夜清库存。', companies: ['MAMA'], trend: -0.005 },
  { text: '「肥鱼科技」和头部主播签下年度独家供货协议。', companies: ['DFY'], trend: 0.005 },
  { text: '「肥鱼科技」冷链批次被检出问题，全线召回。', companies: ['DFY'], trend: -0.005 },
  { text: '「瑞幸咖啡」门店总数破万，单季营收同比大涨。', companies: ['LU'], trend: 0.004 },
  { text: '「瑞幸咖啡」联名活动被指虚假宣传，监管介入。', companies: ['LU'], trend: -0.004 },
  { text: '「奶蛙传媒」新综艺首播登顶，周边三分钟售罄。', companies: ['NW'], trend: 0.004 },
  { text: '「奶蛙传媒」核心团队集体出走，新公司就在隔壁。', companies: ['NW'], trend: -0.004 },
  { text: '「弦卷财团」官宣收购海外乐园运营权，二期同步动工。', companies: ['XJ'], trend: 0.004 },
  { text: '「弦卷财团」游乐园被投诉安全事故，项目暂停整改。', companies: ['XJ'], trend: -0.004 },
  { text: '「小灯证券」获评行业最高评级，多项业务资格同步获批。', companies: ['XD'], trend: 0.003 },
  { text: '「小灯证券」两融业务被暂停三个月，限期整改。', companies: ['XD'], trend: -0.003 },

  { text: '「丰川集团」与「瑞幸咖啡」联名门店开业，排队绕楼两圈。', companies: ['TGW', 'LU'], trend: 0.004 },
  { text: '「弦卷财团」与「奶蛙传媒」合资 IP 公司完成注册。', companies: ['XJ', 'NW'], trend: 0.004 },
  { text: '「无畏科技」与「肥鱼科技」联合赛事首日门票售罄。', companies: ['MAMA', 'DFY'], trend: 0.004 },
  { text: '「奶蛙传媒」与「肥鱼科技」联名产品被认定标签违规，全线下架。', companies: ['NW', 'DFY'], trend: -0.004 },
  { text: '「弦卷财团」终止与「瑞幸咖啡」的园区供应合约。', companies: ['XJ', 'LU'], trend: -0.004 },
  { text: '「丰川集团」下架「无畏科技」全部外设产品，渠道合作终止。', companies: ['TGW', 'MAMA'], trend: -0.004 },

  { text: '央行宣布降准 0.5 个百分点，市场流动性明显宽松。', companies: [], trend: 0.0025 },
  { text: '多家券商同步上调行业评级，研报标题清一色「拐点已现」。', companies: [], trend: 0.002 },
  { text: '长期资金入市方案落地，首批资金已经到位。', companies: [], trend: 0.0025 },
  { text: '外资连续三日净流入，机构同步提高仓位。', companies: [], trend: 0.002 },
  { text: '交易经手费上调，短线资金成本明显上升。', companies: [], trend: -0.002 },
  { text: '数据合规新规落地，平台类企业需要重新申报。', companies: [], trend: -0.002 },
  { text: '质量专项抽查启动，多款在售产品被抽检。', companies: [], trend: -0.0025 },
  { text: '杠杆新规落地，保证金比例上调，成交量断崖下滑。', companies: [], trend: -0.0025 }
];
