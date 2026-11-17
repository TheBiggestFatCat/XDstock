# XDstock Toy 单机版

把主站前端 + 真实游戏逻辑（`src/` 里的 `stepMarket` / 财报 / K 线 / 撮合 / 商城 / 成就等）
打包成 **纯前端单机版**，发布到 B 站 Toy。

## 形态

- **纯单机**：行情、财报、K 线、下单、持仓、打工、银行、商城、成就全部在浏览器内运行；
  `db.json` 存在 `localStorage`（`toy-shims/fs.js` 虚拟文件系统），不连任何线上服务器
- **Toy 容器内 B站自动登录**：通过 Toy JS SDK `toy.getUserProfile()` 拿 B站昵称/头像/`toyOpenId`，
  在本地存档里自动建号并登录（按 `toyOpenId` 记住账号）；非 Toy 容器 / 未登录时回退手动昵称+PIN 登录
- **唯一保留的联机功能是排行榜**：通过 Toy JS SDK（`window.toy`）读写 Toy 全服排行榜
  - 榜位 `board = 1`、周期 `all`（总榜）
  - 打开排行榜时 / 每约 60 秒 / 页面隐藏时，把「总资产」取整后 `submitScore`
  - 读取用 `getRankList({ board: 1, period: 'all', limit: 50 })`
  - 预览页 `/toy/preview/` 禁止写操作，`submitScore` 会被 SDK 拒绝；代码静默跳过
  - 不在 Toy 容器 / 未登录 / 排行榜为空时，退回本地排行榜（只有当前玩家）
- **已移除的联机/社交功能**：聊天大厅、偷钱、暗中调查、假新闻、保镖、表情互动；
  对应接口在本地 fetch 层返回 403，入口在构建时隐藏

## 构建

```bash
node toy/build-toy.mjs
```

产物在 `toy/dist`（约 2.4 MB，图片自动瘦身；不动 `public/` 原图）。
`index.html` 会注入：
- `//s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js`（Toy 平台 JS SDK）
- import map + `toy-demo.js` 入口
- 单机版 UI 补丁（隐藏聊天/偷钱等入口）

**不要直接发布 `public/`**：它是站点根绝对路径 + 依赖 Node 后端，在 Toy 子路径下会白屏。

## 发布（需要 B 站创作者账号）

```bash
$LOCALAPPDATA\Programs\toy\toy.exe login

# 首次预览（不加 --yes 只生成 preview_url，不提交审核）
$LOCALAPPDATA\Programs\toy\toy.exe create toy\dist --title "小灯证券 · 模拟炒股（单机版）" `
  --slug xdstock-demo --category GAME --visibility public `
  --poster toy\poster.png --icon toy\dist\assets\icons\icon-192.png --theme dark --json

# 预览确认后提交审核：同参数 + --yes
# 更新已有 Toy（slug 不变）：
$LOCALAPPDATA\Programs\toy\toy.exe update <id> toy\dist --json
```

## 文件

- `build-toy.mjs`：复制/打补丁/生成 dist
- `toy-src/glue.js`：浏览器端入口（DB 初始化、fetch mock、SSE 替身、tick 循环、tickPayload、Toy 排行榜）
- `toy-src/fs.js`、`path.js`、`url.js`、`zlib.js`、`crypto.js`：Node API 的浏览器 shim
- `optimize-assets.py`：Toy 包内图片瘦身（需要 Pillow）
- `poster.png`：Toy 封面（4:3）

## 注意

- 单机数据在浏览器本地，清站点数据即重置；排行榜成绩可被本地修改（平台有 UP 主侧榜单管理可清理异常成绩）
- Toy 排行榜板位 1~5 由 Toy 平台定义；本版本固定用板位 1
