// 实时汇率：澳元兑日元（AUD/JPY）
//
// 给「留美外汇」这只票用：公司拿自营盘高杠杆押注 AUD/JPY，
// 汇率一动，股价按 系数 × 杠杆 放大反应。
//
// 数据源按顺序尝试，全部失败就沿用上一次的值（不让股价乱跳）

const SOURCES = [
  {
    name: 'swissquote',
    url: 'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/AUD/JPY',
    parse(json) {
      if (!Array.isArray(json) || !json.length) return null;
      const mids = [];
      for (const q of json) {
        for (const p of q.spreadProfilePrices || []) {
          if (p && p.bid > 0 && p.ask > 0) mids.push((p.bid + p.ask) / 2);
        }
      }
      if (!mids.length) return null;
      return mids.reduce((a, b) => a + b, 0) / mids.length;
    }
  },
  {
    name: 'fxratesapi',
    url: 'https://api.fxratesapi.com/latest?base=AUD&currencies=JPY',
    parse(json) {
      const r = json && json.rates && json.rates.JPY;
      return Number.isFinite(r) && r > 0 ? r : null;
    }
  }
];

let lastOk = null;

/**
 * 抓一次 AUD/JPY
 * @returns {Promise<{rate:number, at:number, source:string}|null>}
 */
export async function fetchAudJpy(timeoutMs = 8000) {
  for (const src of SOURCES) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(src.url, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; XDStock/1.0)',
          Accept: 'application/json'
        }
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const json = await res.json();
      const rate = src.parse(json);
      if (!Number.isFinite(rate) || rate <= 0) continue;
      lastOk = { rate, at: Date.now(), source: src.name };
      return lastOk;
    } catch {
      // 试下一个源
    }
  }
  return null;
}

export function getLastFx() {
  return lastOk;
}

// ---------- 历史 K 线 ----------
//
// 赛区自己只从服务启动那一刻开始攒 5 秒一个的报价点，1 分钟图攒满 5 小时要一天，
// 5 分钟 / 15 分钟（主站那两档是 25 小时 / 48 小时）更不可能。
// 既然股价本来就等于汇率，历史直接取真实行情包，和主站给的根数一致。
//
// 源：东方财富外汇行情（secid 119.AUDJPY），klt 1/5/15 对应 1/5/15 分钟，
// 时间是北京时间，这里按 UTC+8 硬算成 unix 秒，跟服务器时区无关。
// 注意：东财的时间戳标的是**这根 K 线的收盘时刻**（实测 5m 的 02:55 那根
// 正好等于 1m 的 02:51~02:55 五根），而图表和赛区实时聚合都按「开盘时刻」算，
// 所以统一减掉一个周期，否则接缝处会出现两根错位/一根落在未来的柱子。
const EM_KLT = { '1m': 1, '5m': 5, '15m': 15 };
const EM_SEC = { '1m': 60, '5m': 300, '15m': 900 };

function bjToSec(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return 0;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5]) / 1000);
}

/**
 * 抓一段 AUD/JPY 历史 K 线
 * @param {'1m'|'5m'|'15m'} tf
 * @param {number} limit 想要多少根（东方财富一般给到 320 上下）
 * @returns {Promise<Array<{time:number,open:number,high:number,low:number,close:number}>|null>}
 */
export async function fetchAudJpyBars(tf = '1m', limit = 320, timeoutMs = 8000) {
  const klt = EM_KLT[tf];
  if (!klt) return null;
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
    + `?secid=119.AUDJPY&klt=${klt}&fqt=0&lmt=${Math.max(20, limit)}&end=20500101`
    + '&fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; XDStock/1.0)', Accept: 'application/json' }
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    const rows = json && json.data && json.data.klines;
    if (!Array.isArray(rows) || !rows.length) return null;
    const bars = [];
    for (const row of rows) {
      // 字段顺序：时间, 开, 收, 高, 低
      const p = String(row).split(',');
      const time = bjToSec(p[0]) - EM_SEC[tf];
      const open = Number(p[1]);
      const close = Number(p[2]);
      const high = Number(p[3]);
      const low = Number(p[4]);
      if (!(time > 0) || !(open > 0) || !(close > 0)) continue;
      bars.push({
        time,
        open,
        high: Math.max(high || 0, open, close),
        low: Math.min(low > 0 ? low : open, open, close),
        close
      });
    }
    return bars.length ? bars : null;
  } catch {
    return null;
  }
}
