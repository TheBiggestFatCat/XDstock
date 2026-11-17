/**
 * Toy 静态试玩版生成脚本
 *   node build-toy.mjs
 * 产物：toy/dist（可直接 toy create/update）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(HERE, 'dist');
const TOY_SRC = path.join(HERE, 'toy-src');

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

rmrf(OUT);
fs.mkdirSync(OUT, { recursive: true });

// ---------- 1. 复制前端资源 ----------
const PUBLIC = path.join(ROOT, 'public');
const SKIP_PUBLIC = new Set(['sw.js', 'tournament.html', 'tour.js', 'tour.css']);
for (const ent of fs.readdirSync(PUBLIC, { withFileTypes: true })) {
  if (SKIP_PUBLIC.has(ent.name)) continue;
  const s = path.join(PUBLIC, ent.name);
  const d = path.join(OUT, ent.name);
  if (ent.isDirectory()) copyDir(s, d);
  else fs.copyFileSync(s, d);
}

// ---------- 2. 复制后端逻辑（浏览器可跑的部分） ----------
copyDir(path.join(ROOT, 'src'), path.join(OUT, 'src'));
// 后端模块里的个股图标等资源是站点根绝对路径（/assets/...），Toy 跑在 /toy/<slug>/ 下必须改相对
for (const f of fs.readdirSync(path.join(OUT, 'src'))) {
  if (!f.endsWith('.js')) continue;
  const fp = path.join(OUT, 'src', f);
  const s = fs.readFileSync(fp, 'utf8');
  if (s.includes('/assets/')) fs.writeFileSync(fp, s.replaceAll('/assets/', './assets/'));
}
// build.js 读文件算构建号，浏览器里换成固定值
fs.writeFileSync(path.join(OUT, 'src', 'build.js'),
  "export function getBuild() { return 'toy-demo'; }\nexport default getBuild;\n");

// ---------- 3. shim ----------
copyDir(TOY_SRC, path.join(OUT, 'toy-shims'));
fs.renameSync(path.join(OUT, 'toy-shims', 'glue.js'), path.join(OUT, 'toy-demo.js'));

// ---------- 4. 补丁：index.html ----------
const MAP = JSON.stringify({
  imports: {
    'node:fs': './toy-shims/fs.js',
    'node:path': './toy-shims/path.js',
    'node:url': './toy-shims/url.js',
    'node:zlib': './toy-shims/zlib.js',
    'node:crypto': './toy-shims/crypto.js',
    'node:http': './toy-shims/empty.js'
  }
});
let html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
html = html.replace(/href="\//g, 'href="./').replace(/src="\//g, 'src="./');
// 单机版：去掉聊天入口（排行榜是唯一保留的联机功能）
const CHAT_TAB = '<button class="tab" data-view="chat">聊天<span class="tab-dot" id="chatDot" aria-hidden="true"></span></button>';
if (!html.includes(CHAT_TAB)) throw new Error('index.html 里没找到聊天标签');
html = html.replace(CHAT_TAB, '');
// Toy JS SDK（排行榜）：由 Toy 容器注入 window.toy
html = html.replace(/<script type="module" src="\.\/app\.js"><\/script>/,
  `<script src="//s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js"></script>\n  <script type="importmap">${MAP}</script>\n  <script type="module" src="./toy-demo.js"></script>`);
if (!html.includes('toy-demo.js')) throw new Error('index.html 注入入口失败');
// 排行榜数据源说明（Toy 全服榜 / 本地兜底）
html = html.replace('<div id="rankTable" class="table-wrap"></div>',
  '<div id="rankTable" class="table-wrap"></div>\n    <div id="toyRankNote" class="field-hint" style="padding:8px 14px 2px">Toy 排行榜</div>');
// 单机版标题 + 登录页说明
html = html.replace('<title>小灯证券 · 模拟炒股</title>', '<title>小灯证券 · 模拟炒股（单机版）</title>');
html = html.replace('<p class="login-hint">',
  '<p class="login-hint">单机试玩版：存档只保存在本机浏览器，排行榜为 Toy 全服榜</p>\n        <p class="login-hint">');
fs.writeFileSync(path.join(OUT, 'index.html'), html);

// 试玩版开户资金和 glue.js#DEMO_CFG.startingCash 保持一致
html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
html = html.replace(
  '<b id="startingCashHint">$100,000</b>',
  '<b id="startingCashHint">$200,000</b>'
);
fs.writeFileSync(path.join(OUT, 'index.html'), html);

// ---------- 5. 补丁：styles.css / manifest ----------
let css = fs.readFileSync(path.join(OUT, 'styles.css'), 'utf8');
css = css.replace(/url\(\s*['"]?\//g, 'url(./').replace(/url\(\s*['"]?\.\/\//g, 'url(./');
// 纯单机版 UI：聊天 / 偷钱 / 调查 / 假新闻 / 保镖 / 表情互动全部隐藏
css += `
/* ===== Toy 单机版：联机功能只保留排行榜 ===== */
#view-chat, #emoBtn { display: none !important; }
.shop-card[data-shop-item="fakeNews"],
.shop-card[data-shop-item="bodyguard"],
.theme-card[data-theme-code="probe"] { display: none !important; }
.steal-btn, .spy-btn { display: none !important; }
#rankTable th:last-child, #rankTable td:last-child { display: none !important; }
#rankTable th:nth-last-child(2), #rankTable td:nth-last-child(2) { display: none !important; }
#toyRankNote { color: var(--ink-3); font-size: 12px; }
`;
fs.writeFileSync(path.join(OUT, 'styles.css'), css);

let manifest = fs.readFileSync(path.join(OUT, 'manifest.webmanifest'), 'utf8');
manifest = manifest.replace(/"\/assets\//g, '"./assets/').replace(/"\/app\.js"/g, '"./app.js"');
fs.writeFileSync(path.join(OUT, 'manifest.webmanifest'), manifest);

// ---------- 6. 补丁：app.js ----------
let app = fs.readFileSync(path.join(OUT, 'app.js'), 'utf8');
// 静态资源绝对路径 -> 相对
app = app.replace(/'\/assets\//g, "'./assets/").replace(/"\/assets\//g, '"./assets/');
app = app.replace(/`\/assets\//g, '`./assets/');
// Toy 里没有单文件 service worker，删掉注册（否则 /sw.js 404 / scope 报错）
const SW_BLOCK = `if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}`;
if (!app.includes(SW_BLOCK)) throw new Error('app.js 里没找到 Service Worker 注册块');
app = app.replace(SW_BLOCK, '// Toy 试玩版不注册 Service Worker');
fs.writeFileSync(path.join(OUT, 'app.js'), app);

// ---------- 7. 图片瘦身（只在 dist 里做，不动 public 原图） ----------
try {
  execFileSync('python', [path.join(HERE, 'optimize-assets.py'), OUT], { stdio: 'inherit' });
} catch (e) {
  console.warn('图片瘦身失败（不影响发布）:', e.message);
}

// ---------- 8. 体积报告 ----------
function du(p) {
  let n = 0;
  for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, ent.name);
    n += ent.isDirectory() ? du(f) : fs.statSync(f).size;
  }
  return n;
}
const total = du(OUT);
console.log('Toy 产物:', OUT);
console.log('包大小:', (total / 1048576).toFixed(2), 'MB');
console.log('index.html:', (fs.statSync(path.join(OUT, 'index.html')).size / 1024).toFixed(1), 'KB');
