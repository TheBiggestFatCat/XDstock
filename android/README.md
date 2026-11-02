# 小灯证券 · 安卓 App（WebView 外壳）

这是一个**网页驱动的安卓 App**：整个 App 就是一个全屏 WebView，加载线上网页。
网页更新后 App 不需要重新发版 —— 服务器上改完，手机上刷新就是新的。

## 一、界面

- 全屏显示网页，无地址栏
- 下拉刷新
- 返回键：先在网页里后退，退不动再退出 App
- 断网时显示「重试」页
- 开启 DOM Storage（保存登录状态）、允许 HTTP 明文访问

## 二、改服务器地址

只改一个地方：

```java
// app/src/main/java/com/xdstock/app/MainActivity.java
private static final String HOME_URL = "http://47.103.83.218/";
```

## 三、怎么打包成 APK

三种方式，**推荐用 GitHub 云打包**：不用装任何东西，浏览器里点两下就出 APK。

### 方式一：GitHub Actions 云打包（推荐，免费）

仓库里已经放好了工作流：`.github/workflows/android-apk.yml`

**步骤：**

1. 把代码推到 GitHub（新建一个仓库，public / private 都行）
   ```bash
   cd D:\WebProjects\XDstock
   git remote add origin https://github.com/<你的用户名>/<仓库名>.git
   git push -u origin master
   ```

2. 打开仓库页 → 顶部 **Actions** 标签
   - 第一次会提示启用，点 **I understand my workflows, go ahead and enable them**

3. 左侧选 **打包安卓 APK** → 右边 **Run workflow** → 绿色按钮

4. 等 3~5 分钟，任务变成绿色 ✅

5. 点进这次运行 → 页面底部 **Artifacts** → 下载 **xdstock-apk**
   - 下载下来是个 zip，解压里面有 `app-debug.apk`
   - 传到手机安装即可（需要允许「安装未知来源应用」）

**免费额度：** 公开仓库完全免费；私有仓库每月 2000 分钟，一次构建约 4 分钟，够用 400 次。

**说明：** 用的是 `app-debug.apk`，已签名（debug 签名），可以直接安装，
但不是正式发布签名，不能上架应用商店。

#### 只建一个「安卓专用」仓库（更干净）

不想把整个游戏源码推上去的话，可以只推 `android` 目录：

```bash
cd D:\WebProjects\XDstock\android
copy ..\.github\workflows\android-apk.yml .github\workflows\   # 手动建好目录
git init
git add .
git commit -m "init"
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin master
```

工作流会自动判断项目在 `android/` 子目录还是仓库根目录，两种结构都能编译。

### 方式二：Android Studio（本地）

需要装 **Android Studio**（或 Android SDK + Gradle）。本机目前没装 SDK，所以只能提供源码工程。

### 2.1 Android Studio（最简单）

1. 打开 Android Studio → `Open` → 选择这个 `android` 目录
2. 等它自动同步（第一次会下载 Gradle 和依赖，约 5~10 分钟）
3. 菜单 `Build` → `Build Bundle(s) / APK(s)` → `Build APK(s)`
4. 生成的 APK 在：
   ```
   app/build/outputs/apk/debug/app-debug.apk
   ```
5. 传到手机安装（需要允许「安装未知来源应用」）

### 2.2 命令行

```bash
# 1. 装命令行工具（Windows）
#    https://developer.android.com/studio#command-tools
#    解压到 C:\Android\cmdline-tools\latest

# 2. 装 SDK 组件
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
sdkmanager --licenses

# 3. 编译
cd android
gradle wrapper          # 第一次生成 gradle wrapper
./gradlew assembleDebug

# 4. 装到手机
adb install app/build/outputs/apk/debug/app-debug.apk
```

### 2.3 发版 APK（体积更小、可签名）

```bash
./gradlew assembleRelease
```

未签名版本在 `app/build/outputs/apk/release/`，需要自己的 keystore 签名后才能安装。

## 四、目录结构

```
android/
├── build.gradle                 根构建脚本
├── settings.gradle
├── gradle.properties
└── app/
    ├── build.gradle             模块配置（compileSdk 34，minSdk 23）
    ├── proguard-rules.pro
    └── src/main/
        ├── AndroidManifest.xml  权限、主题、Activity 声明
        ├── java/com/xdstock/app/MainActivity.java   全部逻辑在这
        └── res/
            ├── layout/activity_main.xml   WebView + 下拉刷新 + 错误页
            ├── values/strings.xml         应用名
            ├── values/themes.xml          主题色
            └── mipmap-*/                  启动图标（由 logo 生成）
```

## 五、常见问题

**Q：为什么用 WebView 而不是原生重写？**
A：你现在所有功能都在网页里，重写一遍等于做两个产品。WebView 方案上线即生效，改 UI 不用发版。

**Q：App 会不会很卡？**
A：不会。页面本身是纯 HTML/CSS/Canvas，安卓 WebView（Chrome 内核）跑这个负载很轻松。

**Q：能上架应用商店吗？**
A：技术上可以，但各大商店对「纯 WebView 壳」审核较严，通常要求有原生能力（推送、离线等）。
自用分发（发 APK 给朋友）完全没问题。

**Q：安全吗？**
A：页面走 HTTP 明文，理论上可被中间人篡改。
如果只是朋友之间玩无所谓；要认真运营建议加 HTTPS（需要备案域名 + 证书）。
