/**
 * 三角洲行动「海洋之泪」物品价格接入（`HYZL` 海洋之泪的财报驱动源）
 *
 * 数据源：腾讯官方 AMS 接口（免费、无需登录）：
 *   POST https://comm.ams.game.qq.com/ide/
 *     ?iChartId=352143&iSubChartId=352143&sIdeToken=YWRywA
 *     &method=dfm/object.list&source=2&param={"primary":"props","second":"collection","objectID":""}
 *
 * 2026-11 实测结论（开发者文档 §6.18.4）：
 * - 官方 `avgPrice` 约 **每小时**批量刷新一次（不是逐秒行情），整点后 ~24 分附近更新；
 *   刷新后约 1 分钟内可能读到新旧混合快照 —— 服务端 10 分钟拉一次 + 只在发报时用价格，天然规避
 * - 返回字段：objectID / objectName / avgPrice / priceChangeRate / length / width / grade ...
 * - 只取 avgPrice；抓不到时沿用上一次价格（`db.dfItem.stale = true`），财报按旧价算，绝不自己编
 *
 * 数据口径：`avgPrice` 是官方统计均价，不是交易行最低挂单价；
 * 参考价 `dfRefPrice` 固定在股票种子里，平衡价 `dfAnchorFair = 200`。
 */

export const DF_ITEM_OBJECT_ID = 15080050142;   // 海洋之泪（1×1 收集品）
export const DF_ITEM_NAME = '海洋之泪';
export const DF_AMS_TOKEN = 'YWRywA';            // 公开静态 token（社区逆向发现，非账号凭据）

const AMS_URL = 'https://comm.ams.game.qq.com/ide/';

/** 拼请求 URL（纯函数，方便测试/替换） */
export function dfItemRequestUrl(objectID = DF_ITEM_OBJECT_ID) {
  const q = new URLSearchParams({
    iChartId: '352143',
    iSubChartId: '352143',
    sIdeToken: DF_AMS_TOKEN,
    method: 'dfm/object.list',
    source: '2',
    param: JSON.stringify({ primary: 'props', second: 'collection', objectID: '' })
  });
  return AMS_URL + '?' + q.toString();
}

/**
 * 从 AMS 响应里取目标物品的 avgPrice。
 * @returns {{found:boolean, price:number, chg:number, name:string}}
 */
export function parseDfItemPrice(json, objectID = DF_ITEM_OBJECT_ID) {
  const list = json && json.jData && json.jData.data && json.jData.data.data
    && json.jData.data.data.list;
  if (!Array.isArray(list)) return { found: false, price: 0, chg: 0, name: '' };
  const item = list.find((x) => Number(x && x.objectID) === Number(objectID));
  const price = Number(item && item.avgPrice) || 0;
  if (!(price > 0)) return { found: false, price: 0, chg: 0, name: '' };
  return {
    found: true,
    price,
    chg: Number(item.priceChangeRate) || 0,
    name: String(item.objectName || '')
  };
}

/** 老存档 / 新库都补齐 db.dfItem 结构 */
export function ensureDfItem(db) {
  if (!db || typeof db !== 'object') return null;
  if (!db.dfItem || typeof db.dfItem !== 'object') db.dfItem = {};
  const d = db.dfItem;
  if (!(Number(d.price) > 0)) d.price = 0;
  if (!Number.isFinite(Number(d.chg))) d.chg = 0;
  if (!Number.isFinite(Number(d.at))) d.at = 0;
  if (typeof d.stale !== 'boolean') d.stale = true;
  return d;
}

/**
 * 由物品价格算 EPS：
 *   参考价 P_ref 对应平衡价 anchorFair（= 200），EPS_ref = anchorFair / PE；
 *   物价每涨 1%，EPS 按 `power` 弹性放大（power=1 → 1:1）。
 */
export function dfItemEps({ price, refPrice, power = 1, anchorFair = 200, pe = 18 } = {}) {
  const ref = Number(refPrice) > 0 ? Number(refPrice) : 0;
  const anchor = Math.max(1, Number(anchorFair) || 200);
  const epsRef = anchor / Math.max(1, Number(pe) || 18);
  const p = Number(price) > 0 ? Number(price) : ref;
  if (!(ref > 0) || !(p > 0)) return epsRef;
  const pw = Math.max(0, Math.min(4, Number(power) || 0));
  return epsRef * Math.pow(p / ref, pw);
}

/**
 * 平衡价（均值回归锚）：anchorFair × (物价/参考价)^power。
 * 2026-11 已移除全局股价上限，fair 只作为回归锚，价格可以短期偏离它。
 */
export function dfItemFair({ price, refPrice, power = 1, anchorFair = 200 } = {}) {
  const anchor = Math.max(1, Number(anchorFair) || 200);
  const ref = Number(refPrice) > 0 ? Number(refPrice) : 0;
  const p = Number(price) > 0 ? Number(price) : ref;
  if (!(ref > 0) || !(p > 0)) return anchor;
  const pw = Math.max(0, Math.min(4, Number(power) || 0));
  return anchor * Math.pow(p / ref, pw);
}
