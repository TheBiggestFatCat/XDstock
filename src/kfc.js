// 肯德基（KFC）的两条专属规则
//
// 1) 反向跟随：每轮读一次麦当劳（MCD）的涨跌幅，在基础股价公式上**叠加一个反向的加成**
//    —— MCD 这一轮涨多少，KFC 就按系数往反方向走多少。
//    所以「MCD 大涨 → KFC 走弱，MCD 大跌 → KFC 走强」是它的性格。
//
// 2) 疯狂星期四：每个星期四 11:00~13:00 之间**随机挑一轮**，那一轮固定 +50%。
//    每周只来一次；随机的具体时刻在进入窗口时抽好、存进 st，重启也不会重复触发
//    （st.kfcWeek 记住是哪一周）。
//
// 这两个函数都是纯逻辑，方便单测：不碰 db，也不读全局时钟。

const WEEK_MS = 7 * 24 * 3600 * 1000;

/** 周四中午窗口的标识：同一周内稳定、隔一周就变 */
export function weekKeyOf(ms) {
  // 用「周四所属那周的周一 0 点」当 key
  const d = new Date(ms);
  const day = d.getDay();                 // 0=周日
  const diff = (day + 6) % 7;             // 距离本周一几天
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff, 0, 0, 0, 0);
  return String(monday.getTime());
}

/**
 * 现在是不是「疯狂星期四」的时间窗？
 * @returns {{weekKey:string, start:number, end:number}|null}
 */
export function rallyWindow(ms, { weekday = 4, from = 11, to = 13 } = {}) {
  const d = new Date(ms);
  if (d.getDay() !== weekday) return null;
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), from, 0, 0, 0).getTime();
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), to, 0, 0, 0).getTime();
  if (ms < start || ms >= end) return null;
  return { weekKey: weekKeyOf(ms), start, end };
}

/**
 * 走一轮「疯狂星期四」判定。
 *
 * @param {object} st    股票对象（会读写 st.kfcWeek / st.kfcRallyAt / st.kfcFired）
 * @param {number} nowMs 当前时间
 * @param {number} tickMs 一轮多少毫秒
 * @param {object} opts  { weekday, from, to, boost, rand }
 * @returns {{fire:boolean, at?:number, boost?:number, reason?:string}}
 */
export function kfcRallyStep(st, nowMs, tickMs, opts = {}) {
  if (!st) return { fire: false, reason: 'no-stock' };
  const { weekday = 4, from = 11, to = 13, boost = 0.5, rand = Math.random } = opts;
  const win = rallyWindow(nowMs, { weekday, from, to });
  if (!win) {
    // 窗口外：新的一周开始时把「本周已触发」清掉，下次窗口重新抽
    if (st.kfcWeek && st.kfcWeek !== weekKeyOf(nowMs)) st.kfcFired = false;
    return { fire: false, reason: 'not-window' };
  }
  if (st.kfcWeek !== win.weekKey) {
    // 第一次进窗口：在窗口剩余时间里随机挑一轮
    const span = Math.max(1, Math.floor((win.end - win.start) / Math.max(1000, tickMs)));
    const idx = Math.floor(rand() * span) % span;
    st.kfcWeek = win.weekKey;
    st.kfcRallyAt = Math.min(win.end - tickMs, win.start + idx * tickMs);
    st.kfcFired = false;
  }
  if (st.kfcFired) return { fire: false, reason: 'done', at: st.kfcRallyAt };
  if (nowMs < Number(st.kfcRallyAt || 0)) {
    return { fire: false, reason: 'waiting', at: st.kfcRallyAt };
  }
  st.kfcFired = true;
  return { fire: true, at: st.kfcRallyAt, boost };
}

/** 给前端/调试看：这一周抽到的时刻 */
export function kfcRallyInfo(st, nowMs, tickMs, opts = {}) {
  const win = rallyWindow(nowMs, opts);
  return {
    inWindow: !!win,
    weekKey: win ? win.weekKey : null,
    at: Number(st?.kfcRallyAt) || 0,
    fired: !!st?.kfcFired,
    // 距离这一轮还有多少轮
    left: (win && Number(st?.kfcRallyAt) > nowMs && !st?.kfcFired)
      ? Math.max(0, Math.round((Number(st.kfcRallyAt) - nowMs) / Math.max(1000, tickMs)))
      : 0,
    weekMs: WEEK_MS
  };
}
