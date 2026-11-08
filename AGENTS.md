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
node tests/order-audit.mjs           # 下单/撮合/押金回归（改下单必跑，64 条断言）
node tests/order-conflict.mjs        # 同票开平冲突（改挂单必跑，21 条断言）
node tests/theme-split.mjs           # 主题=外观+技能（改商城必跑，28 条断言）
node tests/shop-gate.mjs             # 商城等级门槛（改商城必跑，30 条断言）
node tests/theme-evolution.mjs       # 主题成就 + 主题进化（改成就/技能必跑，72 条断言）
node tests/theme-achv-own.mjs        # 主题成就只看「拥有」不看装备（改成就判定必跑，36 条）
node tests/fair-history.mjs          # 价值线=最近 8 期 EPS 趋势拟合（改估值/财报必跑，32 条）
node tests/imports.mjs               # 静态体检：跨模块「用了但没 import」（改 server/api 必跑，17 条）
node tests/global-achievements.mjs   # 全局成就 价值投资/短线擒龙（改成就必跑，53 条）
node tests/gold-stock.mjs            # 矿工银行 MB 金价驱动 + 退市清理（改新股必跑，58 条）
node tests/kfc-stock.mjs             # 肯德基 反向跟随 + 疯狂星期四（改新股必跑，48 条）
node tests/tpsl.mjs                  # 止盈止损全流程（改平仓/委托必跑，75 条）
node tests/market-money.mjs          # 虚假成交推动股价 + 游资轮动（改行情/流水必跑，73 条）
node tests/payload-wire.mjs          # 前端数据包白名单（加字段/改 payload 必跑，120 条）
node tests/shop-perks.mjs            # 咸鱼代下单（免手续费）/ 游资情报（改商城必跑，57 条）
node tests/index-suspension.mjs      # 成分股停牌不影响指数（改指数/停牌必跑，23 条）
node tests/tycoon-broker.mjs         # 券商营收/大鳄预览（改财报/券商必跑，26 条）
node tests/report-trend-expectation.mjs  # 市场预期=最近5期走势拟合（改财报预期必跑，25 条）
node tests/skill-text.mjs            # 主题技能文案跟着配置走（改技能/文案必跑，47 条）
node tests/admin-panel.mjs           # 参数面板一致性：幽灵键/重复键/漏白名单（改设置面板必跑，18 条）
node tests/sim-market-flow.mjs       # 仿真：市场资金推动力/方差占比/天花板（不是断言套，看表格）
```

## 铁律

1. **中文内容写入文件**：用 `write` 工具，或 Python 以 `newline='\n'` 写。
   **不要在 PowerShell 里内联 Python 传中文/引号**——会解析失败。先写临时 `.py`，跑完删掉。

2. **不要用花括号配对删代码**。按行号定位 → 删目标区间 → grep 确认关键函数仍在 → `node --check`。
   （历史事故：误删 `placeLimit` 导致整页白屏）

3. **新增字段要同时改两处 payload**：`src/api.js#marketPayload`（首屏）**和** `server.js#tickPayload`（每轮推送）。
   只改一处 = 「刷新才有 / 平时不更新」。
   → **个股/配置字段一律走 `src/wire.js` 的白名单**，两处共用，别各写一份。
   **引擎内部状态（volMult/漂移/抽奖概率/情绪真值/金价系数/fair/资金压力）绝不下发**，
   加字段前先在 `public/app.js` 确认有读取，然后跑 `node tests/payload-wire.mjs`。

4. **改 `public/` 下任何文件后，必须把 `public/sw.js` 的 `CACHE` 版本号 +1**，否则用户看不到更新。

5. **改 `data/db.json` 前必须备份**：
   `cp /opt/xdstock/data/db.json /opt/xdstock/data/backups/db-$(date +%Y%m%d-%H%M%S)-说明.json`

6. **发布流程**：改代码 → `node --check` → 本地跑通 → SFTP 上传 → 改线上数据（先备份）→
   `systemctl restart xdstock` → curl 验证 → `git commit` → `git push`（需代理 `127.0.0.1:4780`）。

## 最容易踩的 19 个坑

| 坑 | 症状 | 正解 |
|---|---|---|
| `hidden` 被 `display:grid` 覆盖 | 切显隐没反应 | 用 `el.style.display='none'/''` 兜底 |
| DOM 嵌套错误 | 父级隐藏→子级跟着消失（页面空白） | 数 `<div>`/`</div>` 配平；必要时运行时重挂父节点 |
| 指数标的 series 不累积 | 指数涨跌幅恒为 0 | 指数计算处手动 `series.push()` |
| 调仓判定用 `>=` | 每轮都调仓，指数锁死 | 用 `db.tick === idx.rebalanceTick` |
| 兄弟股发报用旧 tick | 每 tick 都发报 | 赋 `db.tick` |
| 参数误判作用域 | 以为是全服限制，其实是每人 | 读实现：`maxOrdersPerTick` 是**每人每轮操作次数** |
| 止盈止损走限价撮合 | 跳空时止损永远不成交（挂单在上方等反弹） | auto 单必须强制成交，不能按限价判断 |
| 给限价单「加语义」 | 开仓大面积不成交（2026-11 踩过两次） | 限价单就是「成交价 = 市价」，任何价位都能挂；要改先问 |
| 押金漏算冲击成本 | 全仓挂单成交那一刻报「现金不足」并自动撤单 | `estimateReserve()` 里加 `impactCost` |
| 跨模块函数忘了 import | `node --check` 只查语法 → 上线后每个 tick 抛 ReferenceError、systemd 重启循环 | 跑 `node tests/imports.mjs`；新写的分支本地一定要**真的走一遍**（2026-11 踩过：`isNightWindow`） |
| 两套资金冲击混用 | 游资砸钱占满玩家上限 / 玩家单子推不动 | 玩家走 `st.flow`、虚假成交与游资走 `st.mflow`，公式各自一份、互不抢上限 |
| 价值线只用最后一期财报算 | 一期财报抽到 ±6%，整条价值线被拽走 6%，均值回归再把价格拖过去，玩家说「价值线跟着单期财报乱跳」 | 用 `fairFromHistory()`（最近 `fairLookback` 期 EPS 对数回归，默认 8）；**5 期端点权重 60%、几乎没降噪**，别为了「五期」这个数字改回去 |
| 面板上的设置项没进 api 白名单 | 管理面板能改、点保存没报错，但值根本没存进 db（静默丢弃） | 面板字段必须同时在 `src/api.js#/api/admin/config` 的 allowed 数组里；跑 `tests/admin-panel.mjs` |
| 成就判定写成「必须装备技能」 | 玩家买了主题、换用别的技能，成就再也不涨 | 判定用 `achievements.js#ownsTheme()`；技能效果（返现/冲击/隐身/冷却）仍然只看 `player.skill` |
| 技能描述写死在 HTML 里 | 后台把「大鳄提前 20 轮」改成 12，商城还写 20，玩家按错误信息做决策 | 文案只在 `src/skillText.js` 生成（读 config），前端经 /api/skill-text 取；跑 `tests/skill-text.mjs` |
| 市场预期写死成 0 | 玩家看不到「预期」，超预期/不及预期成了内部参数的游戏 | 用 `expectedGrowthFromHistory()`（最近 5 期营收回归外推），不够 3 期才回退模型口径 |
| 券商活跃度用绝对口径 | 线上成交笔数少 → 营收被 25% 地板夹死 → 每期财报 0%、大鳄预览永远是「符合预期 0%」 | 用 `volumeFactorOf()`（volumeAvg / 慢速 volumeRef），migrate 会给贴地板的券商重置基准营收 |
| 指数只算「在交易」的成分股 | 一停牌指数就闪崩（麦当劳停牌时 DENG −32%），复牌还回不来 | 遍历 status !== 'delisted'，停牌按最后价计；只有退市才剔除并强制调仓 |
| payload 把引擎参数抖出去 | F12 里能看到 `trait.lotteryChance` / `volMult` / `fair` / `sentimentStrength`，等于把价格模型交给玩家 | 所有下发字段必须过 `src/wire.js` 白名单；跑 `node tests/payload-wire.mjs` |

## 新增配置参数（四处都要改）

1. `src/config.js` — 默认值
2. `src/api.js` — 管理员白名单数组加 key
3. `src/wire.js` — `CONFIG_KEYS` 里加 key（**只有前端真的要读的才加**；管理面板读的是 `/api/admin/state`，不需要放这里）
4. `public/app.js` — 面板字段：`CFG_CATS`（参数页，全局）或 `STOCK_CFG_GROUPS`（个股页，个股相关）
   元组写法 `['key', '中文标签', '一句说明']`，说明会显示在输入框下面

> 有个股的设置**一律放「个股」页**（财报/估值/各票专属机制/ST/汇率），别塞进参数页。
> 同一个 key 不能出现两次；改完跑 `node tests/admin-panel.mjs`（会查幽灵键、重复键、漏白名单的键）。

## 新增个股参数

1. `public/app.js` 的 `TRAIT_LABELS` 加 `key: ['中文名', '提示']`（白名单决定面板是否渲染）
2. `src/store.js#migrate` 给每只票补默认值（否则老票没字段，面板不显示）

## 代码地图

```
server.js          HTTP 入口、静态文件、SSE、tickPayload
src/engine.js      stepMarket 主循环（顺序敏感：噪声→新闻→漂移→特质→回归→情绪→冲击）
src/trading.js     开平仓、保证金、爆仓、资金冲击、止盈止损触发
src/orders.js      限价单、撮合队列（风控单优先 → 价格优先；每玩家每票每方向限额）
src/theme.js       夜行者时间窗 / 偷钱冷却（技能判定一律读 player.skill）
src/achievements.js 主题成就 16 条 + 全局成就 2 条 + 结晶/进化（阈值全走 config）
src/emoji.js       表情互动（按等级解锁、每轮只留最后一个、按票隔离）
src/bars15.js      15 分钟 K 线单独打包（48 小时）
src/notify.js      站内通知（止盈止损/强平/被偷）
src/steal.js       偷钱金额（上限按对方现金）
src/api.js         全部 REST + payload 组装 + 管理接口
src/wire.js        前端数据包白名单（什么能发给浏览器只在这里定义；防作弊）+ positionWire
src/fundamentals.js 财报生成、估值 fair、预览
src/gold.js        金价（MB 的财报驱动源）
src/kfc.js         肯德基：反向跟随麦当劳 + 疯狂星期四
src/marketTrades.js 虚假成交（三档金额，**会推动股价**：写 st.mflow）
src/hotmoney.js    游资（板块轮动，成交记录混在虚假成交里、看不出区别）
src/perks.js       道具规则：咸鱼代下单（免手续费）/ 游资情报（读 hotMoney.nextIndustry）
src/skillText.js   主题技能文案（按 config 生成一级/二级描述，前端不写死）
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
- 市场资金（虚假成交 + 游资，2026-11）：虚假成交三档 1万~10万 / 10万~100万 / 100万~1000万（权重 70/24/6）；
  游资每笔 1000万~3000万、每 20~300 轮换一次板块；推动力 = 压力 × 0.002 × impactFactor，单轮封顶 0.8%
  → 实测一笔 1000 万 ≈ +0.3%~1%，一笔 3000 万 ≈ +1%~3%（大盘股取低值）
- 指数：DENG（9 成分）、DENGS（市值最小的 7 只）
- 金价：基准 2400，每轮波动 0.12%；MB 财报 = 目标增速 + 金价涨跌 ×2.2 ±3%
- MB 市值：1000 亿起步（10 亿股 × 100），目标是 3000 亿（capTargetRate 0.08/期）
- KFC 市值：800 亿起步（8 亿股 × 100），目标是 1000 亿；每轮反向跟随 MCD 上一轮涨跌幅；周四 11~13 点随机一轮 +50%
- 财报基线：零期望随机偏移（对数空间零均值），σ = 5% × √(1000亿 / 市值)，夹在 1%~10%

## 提交信息

写清「改了什么 + 为什么」。一个功能通常要动 4~6 个文件，别只写「修复 bug」。
