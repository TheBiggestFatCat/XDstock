# 保持 WebView 的 JS 接口（如以后用 @JavascriptInterface）
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
