package com.xdstock.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

/**
 * 小灯证券 · 安卓外壳
 *
 * 就是一个全屏 WebView，加载线上网页。
 * 网页更新后 App 不用重新发版，改完服务器就生效。
 *
 * 另外多干一件事：网页登录后会把 token 交给原生层（XDShell.enableAlerts），
 * 由 AlertService 在后台盯「止盈止损」，触发时发系统通知。
 */
public class MainActivity extends AppCompatActivity {

    /** 线上地址：换域名或换服务器只改这一行 */
    private static final String HOME_URL = "http://47.103.83.218/";
    private static final int REQ_NOTIFY = 0x51;

    private WebView webView;
    private SwipeRefreshLayout swipe;
    private View errorBox;

    /** 网页当前的滚动位置，由 JS 通过 XDShell 回报 */
    private volatile int pageScrollY = 0;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        swipe = findViewById(R.id.swipe);
        errorBox = findViewById(R.id.errorBox);
        TextView errorText = findViewById(R.id.errorText);
        Button retry = findViewById(R.id.retryBtn);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        webView.setBackgroundColor(0xFFF4FAF8);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        // 网页把自己的滚动位置报上来，下拉刷新靠它判断「是不是已经在顶部」；
        // 顺手把登录态交给原生层，用来在后台盯止盈止损
        webView.addJavascriptInterface(new ShellBridge(), "XDShell");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                errorBox.setVisibility(View.GONE);
                pageScrollY = 0;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                swipe.setRefreshing(false);
                installScrollReporter(view);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // 只有主文档失败才显示错误页
                if (request != null && request.isForMainFrame()) {
                    swipe.setRefreshing(false);
                    errorBox.setVisibility(View.VISIBLE);
                    errorText.setText("连不上服务器\n" + HOME_URL);
                }
            }
        });

        swipe.setColorSchemeColors(0xFF14B8A6);

        // 关键：只有页面已经在最顶部，下拉才算「刷新」。
        // 否则手指往下滑想要的是滚动页面，不该触发刷新。
        swipe.setOnChildScrollUpCallback((parent, child) -> {
            if (pageScrollY > 2) return true;              // 网页没到顶
            return webView.getScrollY() > 2
                    || webView.canScrollVertically(-1);     // 原生滚动条兜底
        });

        swipe.setOnRefreshListener(() -> {
            errorBox.setVisibility(View.GONE);
            webView.reload();
        });

        retry.setOnClickListener(v -> {
            errorBox.setVisibility(View.GONE);
            webView.loadUrl(HOME_URL);
        });

        if (savedInstanceState == null) {
            webView.loadUrl(HOME_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }

        // 通知权限（Android 13+）和「上次开着盯盘」的续启动
        ensureNotifyPermission(false);
        maybeRestartAlerts();
    }

    // ------------------------------------------------------------ 通知 / 盯盘

    /** Android 13+ 要动态申请通知权限；用户点了「允许」才真正能看到提醒 */
    private void ensureNotifyPermission(boolean ask) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        boolean granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        if (granted || !ask) return;
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
    }

    private boolean canNotify() {
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED;
        }
        return true;
    }

    /** 上次登录过、且开着盯盘，就接着盯 */
    private void maybeRestartAlerts() {
        SharedPreferences sp = getSharedPreferences("xd_shell", MODE_PRIVATE);
        if (!sp.getBoolean("alerts_on", false)) return;
        if (sp.getString("token", "").isEmpty()) return;
        if (!canNotify()) return;
        startAlertService();
    }

    private void startAlertService() {
        try {
            Intent i = new Intent(this, AlertService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(i);
            } else {
                startService(i);
            }
        } catch (Exception ignored) {
            // 后台启动被系统拦了，下次进前台再试
        }
    }

    private void stopAlertService() {
        try {
            Intent i = new Intent(this, AlertService.class);
            i.putExtra("stop", true);
            startService(i);
            stopService(new Intent(this, AlertService.class));
        } catch (Exception ignored) { /* ignore */ }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQ_NOTIFY) return;
        boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        Toast.makeText(this, ok ? "已开启止盈止损通知" : "没给通知权限，触发提醒会看不到", Toast.LENGTH_SHORT).show();
        if (ok) startAlertService();
    }

    // ------------------------------------------------------------ JS 桥

    /** 网页的滚动位置持续报给原生层 */
    private void installScrollReporter(WebView view) {
        String js = "(function(){"
                + "if(window.__xdShellOn)return;window.__xdShellOn=1;"
                + "function rep(){try{"
                + "var y=Math.max(window.pageYOffset||0,"
                + "document.documentElement?document.documentElement.scrollTop:0,"
                + "document.body?document.body.scrollTop:0);"
                + "XDShell.reportScroll(Math.round(y));}catch(e){}}"
                + "window.addEventListener('scroll',rep,{passive:true});"
                + "document.addEventListener('scroll',rep,{passive:true,capture:true});"
                + "document.addEventListener('touchmove',function(){setTimeout(rep,30);},{passive:true,capture:true});"
                + "document.addEventListener('touchend',rep,{passive:true,capture:true});"
                + "setInterval(rep,400);rep();"
                + "})();";
        view.evaluateJavascript(js, null);
    }

    private class ShellBridge {

        @JavascriptInterface
        public void reportScroll(int y) {
            pageScrollY = y;
        }

        /**
         * 网页登录后调这个：把 token 和服务器地址交过来，原生层开始盯止盈止损。
         * 同一个 token 重复调用是幂等的。
         */
        @JavascriptInterface
        public void enableAlerts(String token, String base) {
            if (token == null || token.isEmpty()) return;
            String b = (base == null || base.isEmpty()) ? HOME_URL : base;
            if (b.endsWith("/")) b = b.substring(0, b.length() - 1);

            getSharedPreferences("xd_shell", MODE_PRIVATE).edit()
                    .putString("token", token)
                    .putString("base", b)
                    .putBoolean("alerts_on", true)
                    .apply();

            runOnUiThread(() -> {
                ensureNotifyPermission(true);
                if (canNotify()) startAlertService();
            });
        }

        /** 退出登录时调：停掉盯盘 */
        @JavascriptInterface
        public void disableAlerts() {
            getSharedPreferences("xd_shell", MODE_PRIVATE).edit()
                    .putBoolean("alerts_on", false)
                    .putString("token", "")
                    .apply();
            runOnUiThread(MainActivity.this::stopAlertService);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    /** 返回键：先退网页历史，退不动再退出 App */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
