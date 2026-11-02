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
