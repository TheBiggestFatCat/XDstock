import { INDEX_BASE } from './stocks.js';
import { now } from './store.js';

let gaussSpare = null;
export function gauss() {
  if (gaussSpare !== null) {
    const v = gaussSpare;
    gaussSpare = null;
    return v;
  }
  let u = 0, v = 0, s = 0;
  do {
    u = Math.random() * 2 - 1;
    v = Math.random() * 2 - 1;
    s = u * u + v * v;
  } while (s === 0 || s >= 1);
  const mul = Math.sqrt((-2 * Math.log(s)) / s);
  gaussSpare = v * mul;
  return u * mul;
}

function uniform(lo, hi) {
  return lo + Math.random() * (hi - lo);
}

/** 单只股票走一步 */
function stepStock(st, cfg, events, brokerDrift) {
  const t = st.trait || {};
  const sigma = cfg.baseVolatility * (t.volMult ?? 1);
  let logRet = gauss() * sigma;

  if (t.drift) logRet += t.drift;

  // 新闻冲击
  let evImpact = 0;
  for (const ev of events) {
    if (!ev.companies || !ev.companies.length) continue;
    if (!ev.companies.includes(st.code)) continue;
    evImpact += ev.trend;
  }
  if (evImpact !== 0) {
    logRet += evImpact * (cfg.eventImpactScale ?? 1) * (t.eventMult ?? 1);
  }

  // 券商：全市场成交活跃度
  if (t.id === 'broker' && brokerDrift) logRet += brokerDrift;

  // 梗股彩票
  if (t.id === 'meme' && Math.random() < (t.lotteryChance ?? 0)) {
    logRet += Math.log(1 + uniform(t.lotteryLo ?? 0.25, t.lotteryHi ?? 0.6));
  }

  let p = st.price * Math.exp(logRet);

  // 反转王：连击
  if (t.id === 'reversal') {
    const n = t.streak ?? 3;
    if (st.streak >= n) {
      p *= 1 + uniform(t.bounceLo ?? 0.04, t.bounceHi ?? 0.08);
      st.streak = 0;
    } else if (st.streak <= -n) {
      p *= 1 - uniform(t.bounceLo ?? 0.04, t.bounceHi ?? 0.08);
      st.streak = 0;
    }
  }

  // 护盘：跌破合理估值的比例就有买盘
  if (t.id === 'backstop' && t.floorRatio) {
    if (p < st.fair * t.floorRatio) p *= 1 + (t.floorBoost ?? 0.025);
  }

  // 均值回归（对数空间）
  const k = (cfg.meanReversion ?? 0) * (t.revMult ?? 1);
  if (k > 0 && st.fair > 0 && p > 0) {
    p *= Math.exp(k * Math.log(st.fair / p));
  }

  if (!Number.isFinite(p) || p <= 0) p = st.price;
  p = Math.max(0.01, p);

  // 连击计数
  const prev = st.price;
  if (t.id === 'reversal') {
    const move = p / prev - 1;
    if (move > 0.002) st.streak = st.streak > 0 ? st.streak + 1 : 1;
    else if (move < -0.002) st.streak = st.streak < 0 ? st.streak - 1 : -1;
    else st.streak = 0;
  }

  st.price = p;
}

/**
 * 新闻系统：两阶段
 *
 *   阶段一「偷跑」：5~10 轮大幅变动，此时不公布（市场莫名其妙就动了）
 *   阶段二「公布」：新闻放出后继续走完 80~200 轮
 *        · 50% 继续小幅同向
 *        · 50% 直接反转（利好发出来反而跌）
 */
export function spawnNews(db) {
  const cfg = db.config;
  const pool = db.newsPool || [];
  if (!pool.length) return null;
  if (Math.random() > (cfg.eventChance ?? 0.015)) return null;

  const tpl = pool[Math.floor(Math.random() * pool.length)];
  const dir = tpl.dir >= 0 ? 1 : -1;

  const leakTicks = Math.round(uniform(5, 10));
  const total = Math.round(uniform(80, 200));

  const ev = {
    id: 'ev_' + Math.random().toString(36).slice(2, 10),
    kind: 'leak',
    text: tpl.text,
    companies: tpl.companies || [],
    dir,
    trend: dir * uniform(0.005, 0.009),
    leakTicks,
    leakLeft: leakTicks,
    duration: total,
    remaining: total,
    createdAt: now(),
    announced: false
  };

  db.events.push(ev);
  return ev;
}

/** 偷跑结束 → 公布新闻，掷骰子决定「继续」还是「打脸」 */
function publishEvent(e) {
  e.announced = true;
  e.kind = 'after';
  e.publishedAt = now();
  const keep = Math.random() < 0.5;
  if (keep) {
    e.after = 'continue';
    e.trend = e.dir * uniform(0.0002, 0.0005);
  } else {
    e.after = 'reverse';
    e.trend = -e.dir * uniform(0.0004, 0.0008);
  }
  return e;
}

/** 推进一轮 */
export function stepMarket(db) {
  const cfg = db.config;

  // 1. 新闻：推进阶段 + 到期清理
  const survivors = [];
  for (const e of db.events) {
    e.remaining -= 1;

    if (!e.announced) {
      e.leakLeft -= 1;
      if (e.leakLeft <= 0) publishEvent(e);
    }

    if (e.remaining > 0) survivors.push(e);
  }
  db.events = survivors;

  // 2. 券商活跃度中枢
  const trades = db.tradesThisTick || 0;
  db.tradesThisTick = 0;
  const stocks = Object.values(db.stocks);
  const xd = stocks.find((s) => s.trait?.id === 'broker');
  let brokerDrift = 0;
  if (xd) {
    const alpha = cfg.brokerAlpha ?? 0.02;
    const floor = Number(cfg.brokerMidFloor ?? 0.05);
    const mid = Math.max(floor, (xd.brokerMid ?? 0.1) * (1 - alpha) + alpha * trades);
    xd.brokerMid = mid;
    const ratio = (trades + 0.1) / (mid + 0.1);
    brokerDrift = Math.max(
      -(cfg.brokerCap ?? 0.01),
      Math.min(cfg.brokerCap ?? 0.01, (cfg.brokerSensitivity ?? 0.02) * Math.log(ratio))
    );
  }

  // 3. 每只票走一步
  for (const st of stocks) {
    if (st.status !== 'normal') continue;
    if (st.isIndex) continue;   // 指数不自己走，等下面按成分算
    stepStock(st, cfg, db.events, st.trait?.id === 'broker' ? brokerDrift : 0);

    st.series.push(Number(st.price.toFixed(4)));
    const cap = cfg.historyTicks ?? 3600;
    if (st.series.length > cap) st.series.splice(0, st.series.length - cap);
  }

  // 4. 生成新新闻
  spawnNews(db);

  // 5. 指数：只算正常交易的真股票（不含指数自己）
  const live = stocks.filter((s) => s.status === 'normal' && !s.isIndex);
  if (live.length) {
    const ratio =
      live.reduce((sum, s) => sum + s.price / s.initialPrice, 0) / live.length;
    db.index.value = Number((ratio * INDEX_BASE).toFixed(2));
  }
  db.index.series.push(db.index.value);
  const cap = cfg.historyTicks ?? 3600;
  if (db.index.series.length > cap) {
    db.index.series.splice(0, db.index.series.length - cap);
  }

  // 指数标的的价格 = 指数点位
  const idxStock = db.stocks.DENG;
  if (idxStock) {
    idxStock.price = db.index.value;
    idxStock.series.push(Number(db.index.value.toFixed(4)));
    if (idxStock.series.length > cap) {
      idxStock.series.splice(0, idxStock.series.length - cap);
    }
  }

  db.tick += 1;
  return brokerDrift;
}

/** 从 tick 序列聚合出 K 线（按绝对 tick 编号分桶，保证前后端一致） */
export function candlesFromSeries(series, group, tickMs, tickStart, maxCandles = 400, baseMs = 0) {
  const out = [];
  if (!series || !series.length) return out;

  let curBucket = null;
  let cur = null;
  for (let i = 0; i < series.length; i++) {
    const absTick = tickStart + i;
    const bucket = Math.floor(absTick / group);
    const v = series[i];
    if (bucket !== curBucket) {
      if (cur) out.push(cur);
      curBucket = bucket;
      cur = {
        time: Math.floor((baseMs + bucket * group * tickMs) / 1000),
        open: v,
        high: v,
        low: v,
        close: v
      };
    } else {
      if (v > cur.high) cur.high = v;
      if (v < cur.low) cur.low = v;
      cur.close = v;
    }
  }
  if (cur) out.push(cur);

  return out.slice(-maxCandles).map((c) => ({
    time: c.time,
    open: Number(c.open.toFixed(4)),
    high: Number(c.high.toFixed(4)),
    low: Number(c.low.toFixed(4)),
    close: Number(c.close.toFixed(4))
  }));
}


/**
 * 冷启动时先空跑若干 tick，把 K 线铺满。
 * 否则刚开局图表上一根 K 线都没有，观感很差。
 */
export function seedHistory(db, ticks = 2400) {
  const realChance = db.config.eventChance;
  db.config.eventChance = 0;          // 历史里不生成新闻
  for (let i = 0; i < ticks; i++) {
    stepMarket(db);
    db.events = [];
  }
  db.config.eventChance = realChance;
  db.tradesThisTick = 0;
  db.startedAt = Date.now() - db.tick * (db.config.tickMs || 5000);
}


/**
 * 按 K 线跨度算涨跌幅：取「当前 tick 往前推 N 个 tick」的价格作为基准。
 * N 就是各周期的 tick 数（1m=12, 5m=60, 15m=180, 1h=720, 4h=2880）。
 */
export function changesFor(series, tfTicks) {
  const out = {};
  if (!series || series.length < 2) {
    for (const k of Object.keys(tfTicks)) out[k] = 0;
    return out;
  }
  const last = series[series.length - 1];
  for (const [key, ticks] of Object.entries(tfTicks)) {
    const idx = Math.max(0, series.length - 1 - ticks);
    const base = series[idx];
    out[key] = base ? ((last - base) / base) * 100 : 0;
  }
  return out;
}
