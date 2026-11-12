# AGENTS.md · XDstock 维护须知

> 完整文档见 [`docs/开发者文档.md`](docs/开发者文档.md)。本文件是速查版，**动手前至少读完「铁律」一节**。
> 2026-11 已按当前实现同步（聊天未读红点 / 赛区 1 秒循环 + 止盈止损 / 海洋之泪 HYZL 物价驱动财报 / 66 套 2596 条测试）。

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

# 改到哪块跑哪套：完整清单（66 套 / 2596 条断言，含每套条数）见 docs/开发者文档.md §13
node tests/imports.mjs               # 跨模块「用了但没 import」（17 条，改 server/api 必跑）
node tests/payload-wire.mjs          # 前端数据包白名单（125 条，加字段/改 payload 必跑）
node tests/admin-panel.mjs           # 参数面板一致性（18 条，改设置面板必跑）
node tests/order-audit.mjs           # 下单/撮合/押金（80 条，改下单必跑）
node tests/tpsl.mjs                  # 止盈止损全流程（75 条，改平仓/委托必跑）
node tests/order-conflict.mjs        # 同票开平冲突（21 条）
node tests/order-simple.mjs          # 简单模式市价单（53 条）
node tests/market-money.mjs          # 虚假成交推动股价 / 游资 / 市场资金（112 条）
node tests/gold-stock.mjs            # 金价驱动 + 退市清理（82 条）
node tests/chat.mjs                  # 聊天大厅 / 拼手气 / 未读红点（64 条，改聊天必跑）
node tests/dfitem-stock.mjs          # 海洋之泪 HYZL：物价驱动财报 / 平衡价锚定（65 条，改 HYZL 必跑）
node tests/tour.mjs                  # 锦标赛全套（193 条，改 src/tour.js 必跑）
node tests/market-schedule.mjs       # 定时休市 / 循环作息（48 条）
node tests/sim-market-flow.mjs       # 仿真：市场资金推动力/方差占比（看表格，不算一套）
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

## 最容易踩的坑（持续追加）

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
| 成交量只记在指数自己头上 | 指数 K 线有量、点进成分股全是空的 | 指数单按权重拆给成分股（`trading.js#addVolume`），指数成交量 = 成分股之和（`indexTickVolume`），别各算一份 |
| v5 之后 B/S 标记消失 | 图上没有 B/S，也不报错（老守卫 `typeof setMarkers !== 'function'` 直接 return） | v5 用 `LightweightCharts.createSeriesMarkers(series, markers)`，见 `markerApi()` |
| 升级图表库忘了改 API | v5 没有 `addCandlestickSeries`，调了直接抛，整页白屏 | v5 一律 `chart.addSeries(LightweightCharts.XxxSeries, opts)`；窗格用 `addPane()` + `setStretchFactor()`，别和 `setHeight()` 混用 |
| 夜行者/偷钱数值写死在前端 | 后台改了时间窗或冷却，商城卡片还写旧的 20:00~04:00 / 3 轮 | 文案一律 `skillText.js` 从 config 生成；面板标签不要写死数字，改了配置要 `PATCH /api/admin/config`（老存档不会自动用新默认值） |
| 交易记录只靠全局 `db.trades` | 全局日志里 95% 是虚假成交，4000 条几十分钟就把玩家的单挤掉，「我的」里看不到几小时前的成交 | 每个玩家单独存 `player.tradeLog`（48 小时 / 300 条，`logTrade` 写入、`migrate` 回填），`/api/trades` 从那里取 |
| 指数没有虚假成交 | 指数没有 shares → `marketTradeWeight` 算出来 1e-8，永远抽不到，指数页成交记录/量能全是空的 | 指数单独算权重：`indexTradeWeight()` = 成分股流通市值之和 × `indexTradeScale`（默认 0.08）；下单后 `addMarketFlow` / `addVolume` 会按权重拆给成分股，所以能间接推动股价 |
| payload 把引擎参数抖出去 | F12 里能看到 `trait.lotteryChance` / `volMult` / `fair` / `sentimentStrength`，等于把价格模型交给玩家 | 所有下发字段必须过 `src/wire.js` 白名单；跑 `node tests/payload-wire.mjs` |
| 聊天未读游标没给老玩家补基线 | 一上线所有老号全是红点（`chatReadSeq` 缺失按 0 算） | `store.js#migrate` 补基线 = 启动时 `db.chat.seq`；新号在 `/api/login` 建号处用 `chatSeqOf(db)` 初始化；跑 `tests/chat.mjs` |
| 赛区跟着主站 tick 走 | 主站休市时赛区也停，1 秒面板刷新是白刷 | 赛区独立 1 秒循环 `startTourLoop` + 汇率 1 秒抓（`TOUR_TICK_MS`）；改赛区跑 `tests/tour.mjs` |

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
server.js          HTTP 入口、静态文件、SSE、tickPayload、主 tick / 赛区 1 秒 / 汇率 / 历史 K 线四个定时循环
src/config.js      全部可调参数默认值 + K 线周期定义（TIMEFRAMES）
src/store.js       db 加载/保存/migrate/自动备份
src/stocks.js      股票种子（11 只 + DENG / DENGS）
src/engine.js      stepMarket 主循环（顺序敏感：噪声→新闻→漂移→特质→回归→情绪→冲击）+ 指数/新闻/财报调度
src/trading.js     开平仓、保证金、爆仓、冲击、成交量、止盈止损触发
src/orders.js      限价/简单模式挂单、撮合队列（风控单优先 → 价格优先；每玩家每票每方向限额）
src/api.js         全部 REST + payload 组装 + 管理接口
src/wire.js        前端数据包白名单（什么能发给浏览器只在这里定义；防作弊）+ positionWire
src/fundamentals.js 财报生成、估值 fair（8 期回归）、市场预期、预告、HYZL 物价驱动分支
src/dfItem.js      三角洲「海洋之泪」物品价格：AMS 请求/解析 + EPS·fair 映射（HYZL 驱动源）
src/news.js        普通新闻池 + 重大利好/利空池
src/marketTrades.js 虚假成交（三档金额，**会推动股价**：写 st.mflow）
src/hotmoney.js    游资（板块轮动，成交记录混在虚假成交里、看不出区别）
src/gold.js        金价（MB 的财报驱动源）
src/kfc.js         肯德基：反向跟随麦当劳 + 疯狂星期四
src/fx.js          实时 AUD/JPY 抓取 + 东财历史 K 线（锦标赛用）
src/theme.js       夜行者时间窗 / 偷钱冷却（技能判定一律读 player.skill）
src/mind.js        情绪读心的真假读数（按玩家稳定哈希）
src/achievements.js 主题成就 16 条 + 全局成就 2 条 + 结晶/进化（阈值全走 config）
src/skillText.js   主题技能文案（按 config 生成一级/二级描述，前端不写死）
src/chat.js        聊天大厅（消息 / 红包 / 未读已读游标 chatReadSeq）
src/bank.js        丰川银行（升级存款 / 取钱救急）
src/autoDca.js     自动定投（系统单，离线生效）
src/perks.js       道具规则：咸鱼代下单（免手续费）/ 游资情报（读 hotMoney.nextIndustry）
src/schedule.js    定时休市 / 循环作息（marketPhase 唯一入口）
src/version.js     版本公告
src/bars15.js      中长周期 K 线单独打包：5 分钟 300 根(25h) / 15 分钟 192 根(48h)
src/emoji.js       表情互动（按等级解锁、每轮只留最后一个、按票隔离）
src/delist.js      ST / 退市判定
src/tour.js        锦标赛赛区（独立账本 / LMFX 价格 / 止盈止损 / 打工 / 夺冠冻结）
src/build.js       构建号（前端靠它检测版本更新）
public/app.js      主站前端全部逻辑（~7800 行单文件）
public/index.html  主站单页结构（7 个导航标签 + 视图 div）
public/styles.css  主站全部样式（主题变量 + 移动端媒体查询）
public/tournament.html / tour.js / tour.css  赛区独立页面（不注入主站 app.js）
public/vendor/     lightweight-charts v5（本地化）
```

## 已验证的关键数值（线上）

- 夜行者：夜里（**22:00~05:00**）偷钱冷却 `nightStealCooldown = 50` 轮，进化后 `20` 轮；白天用 `stealCooldownTicks`；偷钱金额 = 随机[stealMin,stealMax] 再被「对方现金 × stealCapRatio」封顶
- `tickMs = 5000`，1 轮 5 秒；**开市 5 分钟 / 休市 2 分钟循环**（`marketCycleOpenMin/CloseMin`，5 分 K 线 = 一个交易日）；顶栏指数右侧有「距休市 / 距开市」倒计时，每秒本地刷新
- `playerImpactRef = 1000000`、`impactRefFreeCap = 100亿`
- `levelBaseAsset = 1000万`、`levelGrowth = 2`、`levelUpRatio = 0.6`
- 挂单：每人同时挂单上限 `maxPendingOrders = 10`（2026-11 从 5 提升；止盈止损单 / 自动定投单不占名额，
  老存档缺字段时 `orders.js` 也按 10 兜底）；挂单有效期 `orderTtlTicks = 2000` 轮
- 股价上限：**已移除**（2026-11）。原「价格 ≤ `fair × maxPremium`（2.5 倍）」的硬顶和作用它的
  `maxPremium` 配置键一起删掉（默认值 / 管理白名单 / 面板 / `migrate` 全清），价格可以长期站在价值线上方，
  只靠均值回归慢慢拉回。`capCeiling`（单票市值上限）作为可选机制保留，但目前没有票在用
- `marketTradesRate = 6`（每轮 6~12 笔虚假成交；笔数按流通市值分配 + 散户情绪定方向/放量）、`marketTradesWindow = 12`（追涨杀跌看 1 分钟动量）、`sentimentRollTicks = 720`
- 市场资金（虚假成交 + 游资，2026-11）：虚假成交三档 1万~10万 / 10万~100万 / 100万~1000万（权重 70/24/6）；
  游资每笔 1000万~3000万、每 20~300 轮换一次板块；推动力 = 压力 × 0.002 × impactFactor，单轮封顶 0.8%
  → 实测一笔 1000 万 ≈ +0.3%~1%，一笔 3000 万 ≈ +1%~3%（大盘股取低值）
- 指数：DENG（11 成分）、DENGS（市值最小的 7 只）
- 聊天（2026-11）：已读游标存服务端 `player.chatReadSeq`，未读 = `db.chat.seq > chatReadSeq`；
  payload 只下发布尔值 `me.chatUnread`（`publicPlayer` + `tickPayload` 两处）；进聊天页/拉到新消息会
  `POST /api/chat/read`。手机端底部标签栏与桌面同一套 DOM（`.tab-dot`）
- 锦标赛（2026-11）：赛区**独立 1 秒循环**（`TOUR_TICK_MS = 1000`，主站休市照跑），汇率 1 秒抓
  （`fxBusy` 防重入，实际约 1.2~1.5 秒一报价）；杠杆 **20~1000**（10 的倍数）、零手续费、
  保证金剩 5% 强平、每笔持仓最多 8 条止盈止损、夺冠线 2000 万、打工 <30 万才补到 30 万
- 金价：基准 2400，每轮波动 0.12%；MB 财报 = 目标增速 + 金价涨跌 ×2.2 ±3%
- MB 市值：1000 亿起步（10 亿股 × 100），目标是 3000 亿（capTargetRate 0.08/期）
- KFC 市值：800 亿起步（8 亿股 × 100），目标是 1000 亿；每轮反向跟随 MCD 上一轮涨跌幅；周四 11~13 点随机一轮 +50%
- **海洋之泪 HYZL（2026-11 上线）**：财报**完全**由三角洲物品「海洋之泪」的官方 `avgPrice` 决定，无随机项。
  上线价 100、平衡价锚定 **200**；`EPS = (200/18) × (avgPrice/dfRefPrice)^1`；`fair = 200 × (avgPrice/dfRefPrice)^1`；
  `dfRefPrice = 31974562`；trait `volMult 0.5 / revMult 1.8 / sentStrength 0.001`；股本 **20 亿股**（上市价 100 → 初始市值 2000 亿，自由流通市值仍列前七小、留在 DENGS）。
  数据源：官方 AMS `dfm/object.list`（免费无登录，约每小时刷新），`server.js` 每 10 分钟抓一次 → `db.dfItem`。
  模拟结论：财报单期 std ≈ 7.25%；价格中位 9 期收敛到 200±10%，30 期中位 ≈ 199，最大回撤中位 15.7%。
  改它必跑 `node tests/dfitem-stock.mjs`
- 财报基线：零期望随机偏移（对数空间零均值），σ = 5% × √(1000亿 / 市值)，夹在 1%~10%

## 提交信息

写清「改了什么 + 为什么」。一个功能通常要动 4~6 个文件，别只写「修复 bug」。