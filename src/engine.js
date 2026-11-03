import { INDEX_BASE, SMALL_INDEX_STOCK } from './stocks.js';
import { genNextReport, fairFromReport, impactFactor, industryMidGrowth } from './fundamentals.js';
import { genMarketTrades } from './marketTrades.js';
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
function stepStock(st, cfg, events, brokerDrift, fxData, db) {
  const t = st.trait || {};
  const sigma = cfg.baseVolatility * (t.volMult ?? 1);
  let logRet = gauss() * sigma;

  if (t.drift) logRet += t.drift;

  // 新闻冲击
  let evImpact = 0;
  const globalScale = Math.max(0, Number(cfg.globalEventScale ?? 0.2));
  for (const ev of events) {
    // 不指定标的 = 全市场新闻
    const isGlobal = !(ev.companies && ev.companies.length);
    if (!isGlobal && !ev.companies.includes(st.code)) continue;
    // 全市场新闻对每只票的冲击打 2 折，否则一条顶几十条个股新闻
    evImpact += (ev.trend || 0) * (isGlobal ? globalScale : 1);
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

  // 汇率杠杆：股价被 AUD/JPY 牵着走
  let fxTarget = 0;
  if (t.id === 'fx') {
    const fx = fxData || {};
    const rate = Number(fx.rate) || 0;
    const base = Number(fx.base) || rate || 0;
    const coef = Number(t.coef ?? cfg.fxCoef ?? 1);
    const lev = Number(t.lev ?? cfg.fxLeverage ?? 8);
    const fxOn = Number(t.fxEnabled ?? cfg.fxEnabled ?? 1) !== 0;
    if (rate > 0 && base > 0 && fxOn) {
      // 汇率涨跌 × 系数 × 杠杆 = 股价应有的涨跌
      const implied = 1 + (rate / base - 1) * coef * lev;
      fxTarget = st.initialPrice * Math.max(0.1, implied);
      st.fxTarget = fxTarget;
      // 每轮朝目标靠一点，汇率更新时不会一根直线跳完
      const track = Math.max(0, Math.min(1, Number(t.track ?? cfg.fxTrack ?? 0.06)));
      if (track > 0 && fxTarget > 0) {
        p *= Math.exp(track * Math.log(fxTarget / p));
      }
    }
  }

  // 均值回归（对数空间）
  const k = (cfg.meanReversion ?? 0) * (t.revMult ?? 1);
  if (k > 0 && st.fair > 0 && p > 0) {
    p *= Math.exp(k * Math.log(st.fair / p));
  }

  // 散户情绪：每小时重掷方向，按固定间隔施加随机偏移（每只票独立）
  if (db && Number(cfg.sentimentEnabled ?? 1) !== 0) {
    const t2 = st.trait || {};
    const strength = Math.max(0, Number(t2.sentStrength ?? cfg.sentimentStrength ?? 0.004));
    const every = Math.max(1, Math.floor(Number(t2.sentTicks ?? cfg.sentimentTicks ?? 12)));
    const rollEvery = Math.max(60, Math.floor(Number(t2.sentRollTicks ?? cfg.sentimentRollTicks ?? 720)));
    if (!st.sentiment || typeof st.sentiment !== 'object') {
      st.sentiment = { v: 0, nextRoll: 0, nextApply: 0 };
    }
    if (!(Number(st.sentiment.nextRoll) > 0) || db.tick >= Number(st.sentiment.nextRoll)) {
      st.sentiment = {
        v: Math.random() * 2 - 1,
        nextRoll: db.tick + rollEvery,
        nextApply: db.tick
      };
    }
    if (db.tick >= Number(st.sentiment.nextApply || 0)) {
      const swing = st.sentiment.v * strength * (Math.random() * 2 - 1);
      logRet += swing;
      st.sentiment.nextApply = db.tick + every;
      st.sentiment.lastSwing = swing;
    }
  }

  // 玩家资金冲击：短时间内的大额净买入/净卖出会推着价格走
  // 流通盘越小，同样一笔钱推动得越猛
  const flow = Number(st.flow) || 0;
  if (flow !== 0 && Number(cfg.playerImpactEnabled ?? 1) !== 0) {
    const refCap = Number(cfg.impactRefFreeCap) || 0;
    const factor = refCap > 0 ? impactFactor(st, refCap) : 1;
    const strength = Number(cfg.playerImpactStrength ?? 0.0009) * factor;
    const capPerTick = Number(cfg.playerImpactMax ?? 0.008);
    // 首轮全额，后续按「后续影响倍率」打折
    const tail = st.flowFresh ? 1 : Number(cfg.playerImpactTail ?? 1);
    let impact = flow * strength * tail;
    impact = Math.max(-capPerTick, Math.min(capPerTick, impact));
    p *= 1 + impact;
    // 压力逐轮衰减，冲击是「消化掉」而不是永久抬价
    st.flow = flow * Number(cfg.playerImpactDecay ?? 0.88);
    if (Math.abs(st.flow) < 0.02) st.flow = 0;
    st.flowFresh = false;
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

  // ST 判定：连续低于阈值就戴帽，回到阈值上方自动摘帽
  const stPrice = Math.max(0.01, Number(cfg.stPrice ?? 3));
  if (!st.isIndex && st.status !== 'delisted') {
    if (st.price < stPrice) {
      st.stTicks = (st.stTicks || 0) + 1;
      st.st = true;
    } else {
      st.stTicks = 0;
      st.st = false;
    }
  }
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

  if (typeof ev.createdTick !== 'number') ev.createdTick = db.tick;
  db.events.push(ev);
  return ev;
}

/** 偷跑结束 → 公布新闻，掷骰子决定「继续」还是「打脸」 */
function publishEvent(e) {
  e.announced = true;
  e.kind = 'after';
  e.publishedAt = now();
  // 继续 / 反转 的概率和幅度要配平，否则每轮都有一点点净下行，
  // 积少成多会让所有股票长期阴跌（之前是 50/50，但反转幅度是继续的 2 倍）
  //   继续：60% × 平均 +0.0004 = +0.00024
  //   反转：40% × 平均 -0.0006 = -0.00024   ← 期望值正好抵消
  const keep = Math.random() < 0.6;
  if (keep) {
    e.after = 'continue';
    e.trend = e.dir * uniform(0.0003, 0.0005);
  } else {
    e.after = 'reverse';
    e.trend = -e.dir * uniform(0.0005, 0.0007);
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
  // 成交活跃度 EMA（给券商的财报用）
  const alphaV = 0.02;
  db.volumeAvg = (db.volumeAvg || trades) * (1 - alphaV) + trades * alphaV;
  // 汇率波动 EMA（给外汇的财报用）
  {
    const fx = db.fx || {};
    const r = Number(fx.rate) || 0;
    const prev = Number(fx.prevRate) || r;
    const vol = (r > 0 && prev > 0) ? Math.abs(r / prev - 1) : 0;
    db.fxVolAvg = (db.fxVolAvg || vol) * (1 - 0.1) + vol * 0.1;
  }
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
    stepStock(st, cfg, db.events, st.trait?.id === 'broker' ? brokerDrift : 0, db.fx, db);

    st.series.push(Number(st.price.toFixed(4)));
    const cap = cfg.historyTicks ?? 3600;
    if (st.series.length > cap) st.series.splice(0, st.series.length - cap);
  }

  // 3.5 生成市场噪声成交（反映本轮的随机波动）
  genMarketTrades(db);

  // 3.55 蜜蜂脾气：低概率突然暴力拉升或砸盘
  for (const st of stocks) {
    if (st.isIndex || !st.trait?.lottery) continue;
    // 面板参数优先，没配就用股票特质里的
    const chance = Math.max(0, Math.min(1,
      Number(cfg.weatherLotteryChance ?? st.trait.lotteryChance) || 0));
    if (!(chance > 0) || Math.random() >= chance) continue;
    const lo = Math.max(0.01, Number(cfg.weatherLotteryLo ?? st.trait.lotteryLo) || 0.12);
    const hi = Math.max(lo, Number(cfg.weatherLotteryHi ?? st.trait.lotteryHi) || 0.40);
    const pct = lo + Math.random() * (hi - lo);
    const up = Math.random() < 0.5;
    st.price = Number((st.price * (1 + (up ? pct : -pct))).toFixed(4));
    st.lotteryAt = db.tick;
    st.lastLottery = { pct, up, tick: db.tick };
    db.notices = db.notices || [];
    db.notices.push({
      id: 'n_' + Math.random().toString(36).slice(2, 10),
      text: `${st.name}盘面异动，${up ? '直线拉升' : '闪崩下杀'} ${(pct * 100).toFixed(0)}%，全场哗然`,
      at: Date.now(),
      tick: db.tick,
      kind: up ? 'up' : 'down'
    });
    if (db.notices.length > 20) db.notices.splice(0, db.notices.length - 20);
  }

  // 3.58 天气股对齐（共用天气、同时发报）
  {
    let first = null;
    for (const st of stocks) {
      if (st.isIndex || st.trait?.id !== 'weather') continue;
      if (!first) { first = st; continue; }
      // 天气共用
      if (db.weather) st.weather = db.weather;
      else if (first.weather) st.weather = first.weather;
      // 发报轮次对齐（取更早的那个，保证同时公布）
      const a = Number(first.nextReportTick) || 0;
      const b = Number(st.nextReportTick) || 0;
      const same = Math.min(a || b, b || a);
      if (same > 0) {
        first.nextReportTick = same;
        st.nextReportTick = same;
      }
      // 目标价也要跟着算出来，否则不会提前靠拢
      if (st.weather && !(Number(st.weatherTarget) > 0)) {
        const swing = Math.max(0.1, Number(st.trait?.swing) || 0.5);
        st.weatherTarget = Math.max(0.5, Number(st.fair) * (1 + st.weather.score * swing));
      }
    }
    if (!db.weather && first?.weather) db.weather = first.weather;
  }

  // 3.6 种业：市场提前向天气预期靠拢
  for (const s2 of stocks) {
    if (s2.isIndex || s2.trait?.id !== 'weather') continue;
    if (!(Number(s2.weatherTarget) > 0)) continue;
    const rate = Math.max(0, Math.min(0.05, Number(s2.trait?.anticipate) || 0.004));
    s2.fair = Number((s2.fair + (s2.weatherTarget - s2.fair) * rate).toFixed(4));
  }

  // 4. 生成新新闻
  spawnNews(db);

  // 5. 指数：权重按季度调仓，期内权重冻结
  const live = stocks.filter((s) => s.status === 'normal' && !s.isIndex);
  if (live.length) {
    const idx = db.index;
    const period = Math.max(60, Number(cfg.indexRebalanceTicks ?? 2160));
    // 有新股上市（权重表里没有它）就立刻调仓，不用等到季度末
    const missing = live.some((x) => !(Number(idx.weights?.[x.code]) > 0));
    if (!idx.weights || !idx.basePrices || !(idx.nextRebalanceTick > 0)
      || missing || db.tick >= idx.nextRebalanceTick) {
      rebalanceIndex(db, live, period);
      if (missing) console.log('[指数] 发现新成分股，已调仓纳入');
    }
    let sum = 0;
    for (const s of live) {
      const w = Number(idx.weights?.[s.code]) || 0;
      const b = Number(idx.basePrices?.[s.code]) || 0;
      if (w > 0 && b > 0) sum += w * (s.price / b);
    }
    if (sum > 0) {
      db.index.value = Number(((Number(idx.scale) || INDEX_BASE) * sum).toFixed(2));
      const idxStock = db.stocks.DENG;
      if (idxStock) {
        idxStock.price = db.index.value;
        if (!Array.isArray(idxStock.series)) idxStock.series = [];
        idxStock.series.push(db.index.value);
        if (idxStock.series.length > 3600) {
          idxStock.series.splice(0, idxStock.series.length - 3600);
        }
        idxStock.changePct = 0;
      }
    }

    // ---- 小灯指数：只编市值最小的 7 家，节奏和灯证指数一致 ----
    if (!db.smallIndex || typeof db.smallIndex !== 'object') {
      db.smallIndex = { value: INDEX_BASE, series: [INDEX_BASE] };
    }
    const sidx = db.smallIndex;
    const byCap = live
      .map((x) => ({ x, cap: x.price * (Number(x.shares) || 0) * (Number(x.freeFloat) || 0.45) }))
      .filter((o) => o.cap > 0)
      .sort((a, b) => a.cap - b.cap)
      .slice(0, 7)
      .map((o) => o.x);

    const sMissing = byCap.some((x) => !(Number(sidx.weights?.[x.code]) > 0));
    // 调仓时机完全跟着灯证指数走
    if (sMissing || db.tick === (Number(idx.rebalanceTick) || -1)
      || !sidx.weights || !(Number(sidx.nextRebalanceTick) > 0)) {
      const total = byCap.reduce(
        (a, x) => a + x.price * (Number(x.shares) || 0) * (Number(x.freeFloat) || 0.45), 0);
      if (total > 0) {
        sidx.weights = {};
        sidx.basePrices = {};
        for (const x of byCap) {
          const cap = x.price * (Number(x.shares) || 0) * (Number(x.freeFloat) || 0.45);
          sidx.weights[x.code] = cap / total;
          sidx.basePrices[x.code] = Math.max(0.01, Number(x.price) || 0.01);
        }
        sidx.scale = Number(sidx.value) > 0 ? Number(sidx.value) : INDEX_BASE;
        sidx.rebalanceTick = db.tick;
        sidx.nextRebalanceTick = Number(idx.nextRebalanceTick) || (db.tick + period);
      }
    }

    let sSum = 0;
    for (const x of byCap) {
      const w = Number(sidx.weights?.[x.code]) || 0;
      const b = Number(sidx.basePrices?.[x.code]) || 0;
      if (w > 0 && b > 0) sSum += w * (x.price / b);
    }
    if (sSum > 0) {
      sidx.value = Number(((Number(sidx.scale) || INDEX_BASE) * sSum).toFixed(2));
    }
    const sidxStock = db.stocks[SMALL_INDEX_STOCK.code];
    if (sidxStock) {
      sidxStock.price = sidx.value;
      if (!Array.isArray(sidxStock.series)) sidxStock.series = [];
      sidxStock.series.push(sidx.value);
      if (sidxStock.series.length > 3600) {
        sidxStock.series.splice(0, sidxStock.series.length - 3600);
      }
    }
    sidx.series.push(sidx.value);
    if (sidx.series.length > 3600) sidx.series.splice(0, sidx.series.length - 3600);

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

  // 6. 财报：到点就发一期
  runReports(db);

  db.tick += 1;

  // 记下这一轮的真实时间（休市不算），K 线坐标就用它，不再靠 tick 推算
  if (!Array.isArray(db.tickTimes)) {
    db.tickTimes = [];
    db.tickTimesStart = db.tick;
  }
  db.tickTimes.push(db._simNow ?? Date.now());
  const timeCap = Math.max(600, Number(cfg.historyTicks ?? 3600) + 600);
  if (db.tickTimes.length > timeCap) {
    const drop = db.tickTimes.length - timeCap;
    db.tickTimes.splice(0, drop);
    db.tickTimesStart = (db.tickTimesStart || 0) + drop;
  }
  return brokerDrift;
}

/** 从 tick 序列聚合出 K 线（按绝对 tick 编号分桶，保证前后端一致） */
/**
 * 某个绝对 tick 对应的真实毫秒。
 * 有记录就用记录，老存档没记录时退回「起始时间 + tick × 间隔」。
 */
export function timeOfTick(db, absTick) {
  const times = db.tickTimes;
  const start = db.tickTimesStart || 0;
  if (Array.isArray(times) && times.length) {
    const idx = absTick - start;
    if (idx >= 0 && idx < times.length) return times[idx];
  }
  return (db.startedAt || 0) + absTick * (db.config.tickMs || 5000);
}

export function candlesFromSeries(series, group, tickMs, tickStart, maxCandles = 400, baseMs = 0, timeOf = null) {
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
      const ms = timeOf ? timeOf(absTick) : (baseMs + bucket * group * tickMs);
      cur = {
        time: Math.floor(ms / 1000),
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
  const stepMs = db.config.tickMs || 5000;
  const baseMs = Date.now() - ticks * stepMs;
  db.config.eventChance = 0;          // 历史里不生成新闻
  for (let i = 0; i < ticks; i++) {
    db._simNow = baseMs + i * stepMs;  // 铺历史用合成时间，保证坐标均匀
    stepMarket(db);
    db.events = [];
  }
  delete db._simNow;
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

/** 每家公司错开发财报：间隔 reportIntervalTicks 轮 */
export function runReports(db) {
  const cfg = db.config;
  const interval = Math.max(60, Number(cfg.reportIntervalTicks ?? 720));
  const list = Object.values(db.stocks).filter((s) => !s.isIndex);
  if (!list.length) return;

  const gap = Math.max(1, Math.floor(interval / list.length));
  for (let i = 0; i < list.length; i++) {
    const st = list[i];
    if (st.status === 'delisted') continue;
    if (!st.nextReportTick) {
      // 错开：第 i 家在 i*gap 轮后先发
      st.nextReportTick = db.tick + gap * (i + 1);
      continue;
    }
    // 金融板块：提前 20 轮把下一期财报算好，给「金融大鳄」主题偷看
    const isFinance = st.trait?.id === 'broker' || st.trait?.id === 'fx'
      || String(st.industry || '').includes('金融');
    const lead = 20;
    if (isFinance && !st.pendingReport && db.tick >= st.nextReportTick - lead) {
      const fxNowP = Number(db.fx?.rate) || 0;
      const fxBaseP = Number(db.fx?.reportBase) || fxNowP;
      const ctxP = {
        volumeFactor: (Number(db.volumeAvg) || 0) / 2,
        fxFactor: (Number(db.fxVolAvg) || 0) / 0.004,
        fxReturn: fxBaseP > 0 ? fxNowP / fxBaseP - 1 : 0
      };
      st.pendingReport = genNextReport(st, ctxP);
    }

    if (db.tick < st.nextReportTick) continue;

    const before = Number(st.fair) || 0;
    const volumeFactor = (Number(db.volumeAvg) || 0) / 2;          // 2 笔/轮算正常
    const fxFactor = (Number(db.fxVolAvg) || 0) / 0.004;           // 0.4% 波动算正常
    // 本期汇率涨跌：以上一期财报时的汇率为基准
    const fxNow = Number(db.fx?.rate) || 0;
    const fxBase = Number(db.fx?.reportBase) || fxNow;
    const fxReturn = fxBase > 0 ? fxNow / fxBase - 1 : 0;
    st.fundamentals = st.pendingReport || genNextReport(st, {
      volumeFactor, fxFactor, fxReturn, weather: st.weather?.score || 0
    });
    // 这一期结束后，汇率基准往前推
    if (db.fx) db.fx.reportBase = fxNow;
    st.pendingReport = null;

    // 合理价：新财报算出来的值 70% + 上期 30%，避免一次财报把线拉到天上
    const computed = fairFromReport(st);
    const smoothed = before > 0 ? computed * 0.7 + before * 0.3 : computed;
    st.fair = Number(smoothed.toFixed(4));

    // 超预期 = 实际增速 − 市场预期（这家公司按规模应有的增速）
    const expectRaw = Number(st.fundamentals.expectedGrowth);
    const expected = Number.isFinite(expectRaw) ? expectRaw : industryMidGrowth(st);
    const diff = Number(st.fundamentals.growth) - expected;
    st.lastSurprise = Math.max(-0.3, Math.min(0.3, diff));
    st.expectedGrowth = expected;

    // 财报历史（给前端的折线图用）
    // 同一片天下的农业股，财报同时发布
    // 注意：必须用「发报后的下一期」，不能拿 st.nextReportTick（此刻还是旧的到期值），
    // 否则兄弟股会一直到期，两只票轮流每 tick 发一次财报
    if (st.trait?.id === 'weather') {
      for (const sib of Object.values(db.stocks)) {
        if (sib === st || sib.isIndex || sib.trait?.id !== 'weather') continue;
        // 还没轮到的兄弟股：直接把到期时间拉到现在，本轮跟着一起发报
        // （已经发过的不能碰，否则会被重置成「立刻到期」，下一轮又发一次）
        if (list.indexOf(sib) > list.indexOf(st)) sib.nextReportTick = db.tick;
      }
    }

    if (!Array.isArray(st.reportHistory)) st.reportHistory = [];
    // 种业：天气是全局的，所有农业股共用同一片天
    if (st.trait?.id === 'weather') {
      if (!db.weather || !Number.isFinite(Number(db.weather.score))) {
        const sc = Math.max(-1, Math.min(1, gauss() * 0.55));
        const lb = sc > 0.45 ? '大丰收' : sc > 0.12 ? '风调雨顺'
          : sc > -0.12 ? '平平无奇' : sc > -0.45 ? '略有减产' : '灾害歉收';
        db.weather = { score: sc, label: lb };
      }
      st.weather = db.weather;
      const swing = Math.max(0.1, Number(st.trait?.swing) || 0.5);
      st.weatherTarget = Math.max(0.5, Number(st.fair) * (1 + db.weather.score * swing));
    }

    st.reportHistory.push({
      period: Number(st.fundamentals.period) || 0,
      revenue: Number(st.fundamentals.revenue) || 0,
      netProfit: Number(st.fundamentals.netProfit) || 0,
      eps: Number(st.fundamentals.eps) || 0,
      growth: Number(st.fundamentals.growth) || 0,
      margin: Number(st.fundamentals.margin) || 0
    });
    if (st.reportHistory.length > 24) {
      st.reportHistory.splice(0, st.reportHistory.length - 24);
    }
    st.nextReportTick = db.tick + interval;

    // 财报当期的价格冲击：超预期就上冲/下杀
    const surprise = st.lastSurprise;
    const shock = Math.max(-0.06, Math.min(0.06, surprise * 0.8));
    if (Number.isFinite(shock) && Math.abs(shock) > 0.0005) {
      st.price = Number((st.price * (1 + shock)).toFixed(4));
    }

    // 挂一条新闻，让所有人知道
    const f = st.fundamentals;
    const verdict = surprise > 0.02 ? '超预期' : surprise < -0.02 ? '不及预期' : '符合预期';
    const good = surprise > 0.02;
    db.events.push({
      id: 'ev_' + Math.random().toString(36).slice(2, 10),
      kind: 'after',
      text: `${st.name}发${f.period}季报：营收${fmtYi(f.revenue)}，净利${fmtYi(f.netProfit)}，`
        + `同比${(f.growth * 100).toFixed(1)}%，市场预期${(expected * 100).toFixed(1)}%，${verdict}`,
      companies: [st.code],
      dir: good ? 1 : -1,
      trend: 0,
      duration: 40,
      remaining: 40,
      createdAt: Date.now(),
      createdTick: db.tick,
      announced: true,
      isReport: true
    });
    if (db.events.length > 40) db.events.shift();
  }
}

function fmtYi(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(2) + '万';
  return n.toFixed(0);
}


/**
 * 指数季度调仓：按流通市值定权重，记下期初价和期初点位，期内权重冻结。
 */
export function rebalanceIndex(db, live, period) {
  const idx = db.index;
  const caps = {};
  let total = 0;
  for (const s of live) {
    const sh = Number(s.shares) || 0;
    const ff = Number(s.freeFloat) || 0.45;
    const cap = s.price * sh * ff;
    if (cap > 0) { caps[s.code] = cap; total += cap; }
  }
  if (!(total > 0)) return;
  const weights = {};
  for (const code of Object.keys(caps)) weights[code] = caps[code] / total;
  const basePrices = {};
  for (const s of live) basePrices[s.code] = Math.max(0.01, Number(s.price) || 0.01);
  idx.weights = weights;
  idx.basePrices = basePrices;
  idx.scale = Number(idx.value) > 0 ? Number(idx.value) : 1000;
  idx.rebalanceTick = db.tick;
  idx.nextRebalanceTick = db.tick + period;
}
