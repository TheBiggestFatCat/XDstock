# AGENTS.md · XDstock 维护须知

> 完整文档见 [`docs/开发者文档.md`](docs/开发者文档.md)。本文件是速查版，**动手前至少读完「铁律」一节**。

## 项目是什么

QQ 群风格的模拟炒股网页游戏。Node.js 零依赖、单文件 `data/db.json`、原生前端无构建。

- 线上：<http://47.103.83.218/>（`/opt/xdstock`，systemd 服务 `xdstock`）
- 仓库：<https://github.com/TheBiggestFatCat/XDstock>
- 本地：`node server.js` → <http://localhost:8971>，管理员口令 `135791`

## 常用命令

```bash
node server.js                       # 本地起服务
node --check src/api.js              # 语法检查（改完必跑）
node --check public/app.js
node tests/order-audit.mjs           # 下单/撮合/押金回归（改下单必跑，62 条断言）
node tests/shop-gate.mjs             # 商城等级门槛（改商城必跑，30 条断言）
```

## 铁律

1. **中文内容写入文件**：用 `write` 工具，或 Python 以 `newline='\n'` 写。
   **不要在 PowerShell 里内联 Python 传中文/引号**——会解析失败。先写临时 `.py`，跑完删掉。

2. **不要用花括号配对删代码**。按行号定位 → 删目标区间 → grep 确认关键函数仍在 → `node --check`。
   （历史事故：误删 `placeLimit` 导致整页白屏）

3. **新增字段要同时改两处 payload**：`src/api.js#marketPayload`（首屏）**和** `server.js#tickPayload`（每轮推送）。
   只改一处 = 「刷新才有 / 平时不更新」。

4. **改 `public/` 下任何文件后，必须把 `public/sw.js` 的 `CACHE` 版本号 +1**，否则用户看不到更新。

5. **改 `data/db.json` 前必须备份**：
   `cp /opt/xdstock/data/db.json /opt/xdstock/data/backups/db-$(date +%Y%m%d-%H%M%S)-说明.json`

6. **发布流程**：改代码 → `node --check` → 本地跑通 → SFTP 上传 → 改线上数据（先备份）→
   `systemctl restart xdstock` → curl 验证 → `git commit` → `git push`（需代理 `127.0.0.1:4780`）。

## 最容易踩的 8 个坑

| 坑 | 症状 | 正解 |
|---|---|---|
| `hidden` 被 `display:grid` 覆盖 | 切显隐没反应 | 用 `el.style.display='none'/''` 兜底 |
| DOM 嵌套错误 | 父级隐藏→子级跟着消失（页面空白） | 数 `<div>`/`</div>` 配平；必要时运行时重挂父节点 |
| 指数标的 series 不累积 | 指数涨跌幅恒为 0 | 指数计算处手动 `series.push()` |
| 调仓判定用 `>=` | 每轮都调仓，指数锁死 | 用 `db.tick === idx.rebalanceTick` |
| 兄弟股发报用旧 tick | 每 tick 都发报 | 赋 `db.tick` |
| 参数误判作用域 | 以为是全服限制，其实是每人 | 读实现：`maxOrdersPerTick` 是**每人每轮操作次数** |
| 止盈止损走限价撮合 | 跳空时止损永远不成交（挂单在上方等反弹） | auto 单必须强制成交，不能按限价判断 |
| 押金漏算冲击成本 | 全仓挂单成交那一刻报「现金不足」并自动撤单 | `estimateReserve()` 里加 `impactCost` |

## 新增配置参数（四处都要改）

1. `src/config.js` — 默认值
2. `src/api.js` — 管理员白名单数组加 key
3. `src/api.js` — `marketPayload` 的 `config` 里下发
4. `public/app.js` — 管理面板参数分组加 `['key', '中文标签']`

## 新增个股参数

1. `public/app.js` 的 `TRAIT_LABELS` 加 `key: ['中文名', '提示']`（白名单决定面板是否渲染）
2. `src/store.js#migrate` 给每只票补默认值（否则老票没字段，面板不显示）

## 代码地图

```
server.js          HTTP 入口、静态文件、SSE、tickPayload
src/engine.js      stepMarket 主循环（顺序敏感：噪声→新闻→漂移→特质→回归→情绪→冲击）
src/trading.js     开平仓、保证金、爆仓、资金冲击、止盈止损触发
src/orders.js      限价单、撮合队列（风控单优先 → 价格优先；每玩家每票每方向限额）
src/api.js         全部 REST + payload 组装 + 管理接口
src/fundamentals.js 财报生成、估值 fair、预览
src/store.js       db 加载/保存/migrate
public/app.js      前端全部逻辑（~3500 行单文件）
public/index.html  单页结构（视图 div）
public/styles.css  全部样式（主题变量 + 移动端媒体查询）
```

## 已验证的关键数值（线上）

- `tickMs = 5000`，1 轮 5 秒
- `playerImpactRef = 1000000`、`impactRefFreeCap = 100亿`
- `levelBaseAsset = 1000万`、`levelGrowth = 2`、`levelUpRatio = 0.6`
- `marketTradesRate = 3`、`sentimentRollTicks = 720`
- 指数：DENG ≈ 3000（9 成分，XJ 约 49% / MAMA 约 23%）、DENGS ≈ 1090（7 成分）

## 提交信息

写清「改了什么 + 为什么」。一个功能通常要动 4~6 个文件，别只写「修复 bug」。
