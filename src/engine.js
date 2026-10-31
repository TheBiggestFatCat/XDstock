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
 * 新闻系统（机制照搬 bot 版）：
 *   - 全球事件：持续若干 tick，每 tick 施加 trend 冲击
 *   - 假消息：到期时自动生成辟谣，reverse = -t/(1+t) 把涨跌原样吐回去
 *   - 晚消息：价格先动，消息延后 announceIn 轮才公布
 *   - 突发：单公司一次性冲击 shock
 */
export function spawnNews(db) {
  const cfg = db.config;
  const pool = db.newsPool || [];
  if (!pool.length) return null;
  if (Math.random() > (cfg.eventChance ?? 0.015)) return null;

  const tpl = pool[Math.floor(Math.random() * pool.length)];
  let dur = Math.round(uniform(cfg.eventDurationMin ?? 30, cfg.eventDurationMax ?? 90));
  const isLate = !!tpl.late;
  // 晚消息至少要活到「公布之后」还能再走几轮，否则价格刚动就没了
  if (isLate) dur = Math.max(dur, 40);

  const ev = {
    id: 'ev_' + Math.random().toString(36).slice(2, 10),
    kind: isLate ? 'late' : tpl.fake ? 'fake' : 'global',
    text: tpl.text,
    companies: tpl.companies || [],
    trend: Number(tpl.trend) || 0,
    duration: dur,
    remaining: dur,
    createdAt: now()
  };

  // 晚消息：先不公布，价格先走
  if (isLate) {
    ev.announced = false;
    ev.announceIn = Math.floor(uniform(12, Math.max(13, Math.min(30, dur - 10))));
  } else {
    ev.announced = true;
  }

  db.events.push(ev);
  return ev;
}

/** 突发：单公司一次性冲击（瞬间打折）+ 一小段余波 */
export function spawnLocalEvent(db) {
  const cfg = db.config;
  const pool = db.localNewsPool || [];
  if (!pool.length) return null;
  if (Math.random() > (cfg.localEventChance ?? 0.004)) return null;

  const tpl = pool[Math.floor(Math.random() * pool.length)];
  const dur = Math.round(uniform(20, 50));
  const ev = {
    id: 'ev_' + Math.random().toString(36).slice(2, 10),
    kind: 'local',
    text: tpl.text,
    companies: tpl.companies || [],
    trend: Number(tpl.trend) || 0,
    duration: dur,
    remaining: dur,
    createdAt: now(),
    announced: true
  };

  // 一次性冲击立刻生效
  const shock = Number(tpl.shock) || 0;
  for (const code of ev.companies) {
    const st = db.stocks[code];
    if (!st || st.status !== 'normal') continue;
    st.price = Math.max(0.01, st.price * (1 + shock));
  }

  db.events.push(ev);
  return ev;
}

/** 推进一轮 */
export function stepMarket(db) {
  const cfg = db.config;

  // 1. 处理新闻生命周期：过期结算 + 假消息辟谣
  const survivors = [];
  for (const e of db.events) {
    e.remaining -= 1;
    if (e.remaining > 0) {
      survivors.push(e);
      continue;
    }
    // 到期：假消息自动生成一条辟谣，把之前的涨跌原样吐回去
    if (e.kind === 'fake' && !e.debunked) {
      const t = Number(e.trend) || 0;
      if (t > -1 && t !== 0) {
        const names = (e.companies || []).join('」「') || '相关公司';
        survivors.push({
          id: 'deb_' + Math.random().toString(36).slice(2, 10),
          kind: 'debunk',
          text: `「${names}」相关方正式辟谣，此前流传的消息并不属实，市场情绪迅速回落。`,
          companies: e.companies || [],
          trend: -t / (1 + t),
          duration: Number(e.duration) || 30,
          remaining: Number(e.duration) || 30,
          createdAt: now(),
          announced: true,
          sourceId: e.id
        });
      }
    }
  }
  db.events = survivors;

  // 晚消息倒计时：到点了才公布
  for (const e of db.events) {
    if (e.announced !== false) continue;
    e.announceIn = (e.announceIn ?? 1) - 1;
    if (e.announceIn <= 0) {
      e.announced = true;
      e.publishAt = now();
    }
  }

  // 2. 券商活跃度中枢
  const trades = db.tradesThisTick || 0;
  db.tradesThisTick = 0;
  const stocks = Object.values(db.stocks);
  const xd = stocks.find((s) => s.trait?.id === 'broker');
  let brokerDrift = 0;
  if (xd) {
    const alpha = cfg.brokerAlpha ?? 0.02;
    const mid = Math.max(0.002, (xd.brokerMid ?? 0.02) * (1 - alpha) + alpha * trades);
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
    stepStock(st, cfg, db.events, st.trait?.id === 'broker' ? brokerDrift : 0);

    st.series.push(Number(st.price.toFixed(4)));
    const cap = cfg.historyTicks ?? 3600;
    if (st.series.length > cap) st.series.splice(0, st.series.length - cap);
  }

  // 4. 生成新新闻（全球事件 + 突发）
  spawnNews(db);
  spawnLocalEvent(db);

  // 5. 指数：只算正常交易的票
  const live = stocks.filter((s) => s.status === 'normal');
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
