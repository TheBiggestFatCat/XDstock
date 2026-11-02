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

需要装 **Android Studio**（或 Android SDK + Gradle）。本机目前没装 SDK，所以只能提供源码工程。

### 方法一：Android Studio（最简单）

1. 打开 Android Studio → `Open` → 选择这个 `android` 目录
2. 等它自动同步（第一次会下载 Gradle 和依赖，约 5~10 分钟）
3. 菜单 `Build` → `Build Bundle(s) / APK(s)` → `Build APK(s)`
4. 生成的 APK 在：
   ```
   app/build/outputs/apk/debug/app-debug.apk
   ```
5. 传到手机安装（需要允许「安装未知来源应用」）

### 方法二：命令行

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

### 方法三：发版 APK（体积更小、可签名）

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
