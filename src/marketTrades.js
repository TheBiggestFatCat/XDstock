/**
 * 市场噪声成交
 *
 * 每轮从「随机波动」里编几笔成交记录，让成交列表看起来是真有人在交易。
 * 方向由本轮涨跌决定：涨得多就多是买单，跌得多就多是卖单；
 * 成交额也跟涨跌幅挂钩（行情越猛，出手越大）。
 */

const NAMES = [
  '散户老王', '追涨杀跌', '北向资金', '游资小李', '量化打板', '值班交易员',
  '长线阿姨', '梭哈哥', '割肉侠', '抄底王', '打新中签', '融资客',
  '隔壁老张', '机构通道', '小仓位试水', '尾盘偷袭', '日内高手', '躺平持仓',
  '私募三号', '网格交易', '追梦少年', '老韭菜', '技术流', '躺赢选手'
];

const EMOJIS = [
  '🦊', '🐯', '🐼', '🐸', '🐵', '🦁', '🐺', '🐷', '🐨', '🦉',
  '🐙', '🦈', '🐲', '🦄', '🐢', '🦅', '🐳', '🦖', '🐝', '🦔'
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (a, b) => a + Math.random() * (b - a);

/**
 * 生成 1~2 笔市场成交并写入流水
 * @param {object} db
 * @param {number} maxTrades 本轮最多几笔
 */
export function genMarketTrades(db, maxTrades = 2) {
  if (!Array.isArray(db.trades)) db.trades = [];
  const cfg = db.config || {};
  if (Number(cfg.marketTradesEnabled ?? 1) === 0) return [];

  const list = Object.values(db.stocks).filter((s) => !s.isIndex && s.status === 'normal');
  if (!list.length) return [];

  const out = [];
  const n = Math.max(1, Math.round(rand(1, maxTrades)));

  for (let i = 0; i < n; i++) {
    const st = pick(list);
    const ser = st.series || [];
    const prev = ser.length > 1 ? ser[ser.length - 2] : st.price;
    const chg = prev > 0 ? (st.price / prev - 1) : 0;

    // 涨了偏买，跌了偏卖
    const buyProb = Math.max(0.1, Math.min(0.9, 0.5 + chg * 25));
    const isBuy = Math.random() < buyProb;

    // 波动越大，出手越大
    const sizeBoost = 1 + Math.min(6, Math.abs(chg) * 120);
    const notional = rand(20000, 180000) * sizeBoost;
    const qty = Math.max(1, Math.floor(notional / Math.max(0.01, st.price)));

    const row = {
      id: 'mk_' + Math.random().toString(36).slice(2, 10),
      at: Date.now(),
      code: st.code,
      name: st.name,
      action: 'open',
      side: isBuy ? 'long' : 'short',
      qty,
      price: Number(st.price.toFixed(2)),
      leverage: Math.round(rand(1, 10)),
      fee: 0,
      stampDuty: 0,
      margin: 0,
      impact: 0,
      reason: 'market',
      playerId: 'mkt_' + (i + 1),
      nickname: pick(NAMES),
      emoji: pick(EMOJIS),
      isMarket: true
    };
    out.push(row);
  }

  db.trades.push(...out);
  const cap = Number(cfg.tradeLogMax) || 3000;
  if (db.trades.length > cap) db.trades.splice(0, db.trades.length - cap);
  return out;
}
