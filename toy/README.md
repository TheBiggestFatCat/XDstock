# XDstock Toy 静态试玩版

这是把主站的**前端 + 真实游戏逻辑**（`src/` 里的 `stepMarket` / 财报 / K 线 / 撮合 / 商城等）
打包成的**纯前端单机版**，用于发布到 B 站 Toy 平台。

和线上版的关系：

- 线上版是 Node 后端 + 前端；Toy 只能放静态资源，所以这里用浏览器 shim 跑同一套逻辑
- `db.json` 存在浏览器 `localStorage`（`toy-shims/fs.js` 虚拟文件系统），试玩记录只在本机
- `/api/*` 由 `src/api.js#handleApi` 在浏览器内直接处理；`/api/stream` 用本地定时器 + EventSource 替身推送
- 每 5 秒一个 tick；试玩版关闭自动休市、开户送 $200,000、每 10 分钟一期财报
- 排行榜里的其他玩家是预设 bot，不是真人；没有聊天服务器/锦标赛

## 构建

```bash
node toy/build-toy.mjs
```

产物在 `toy/dist`（约 2.4 MB，图片会自动瘦身到 `dist/` 内，不动 `public/` 原图）。
**不要直接发布 `public/`**：里面有站点根绝对路径（`/app.js` 等）且依赖后端接口，在 Toy 子路径下会白屏。

## 发布（需要 B 站创作者账号）

```bash
# 首次
$LOCALAPPDATA\Programs\toy\toy.exe login
$LOCALAPPDATA\Programs\toy\toy.exe create toy\dist --title "小灯证券 · 模拟炒股" `
  --slug xdstock-demo --category GAME --visibility public `
  --poster toy\poster.png --icon toy\dist\assets\icons\icon-192.png --theme dark --json
# 预览链接确认后，同参数加 --yes 提交审核

# 更新（slug 不变）
$LOCALAPPDATA\Programs\toy\toy.exe update <id> toy\dist --json
```

## 文件

- `build-toy.mjs`：复制/打补丁/生成 dist
- `toy-src/glue.js`：浏览器端入口（DB 初始化、fetch mock、SSE 替身、tick 循环、tickPayload）
- `toy-src/fs.js`、`path.js`、`url.js`、`zlib.js`、`crypto.js`：Node API 的浏览器 shim
- `optimize-assets.py`：Toy 包内图片瘦身（需要 Pillow）
- `poster.png`：Toy 封面（4:3）
