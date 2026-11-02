package com.xdstock.app;

import android.annotation.SuppressLint;
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

import androidx.appcompat.app.AppCompatActivity;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

/**
 * 小灯证券 · 安卓外壳
 *
 * 就是一个全屏 WebView，加载线上网页。
 * 网页更新后 App 不用重新发版，改完服务器就生效。
 */
public class MainActivity extends AppCompatActivity {

    /** 线上地址：换域名或换服务器只改这一行 */
    private static final String HOME_URL = "http://47.103.83.218/";

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

        // 网页把自己的滚动位置报上来，下拉刷新靠它判断「是不是已经在顶部」
        webView.addJavascriptInterface(new ScrollReporter(), "XDShell");

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
    }

    /** 把网页的滚动位置持续报给原生层 */
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

    private class ScrollReporter {
        @JavascriptInterface
        public void reportScroll(int y) {
            pageScrollY = y;
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
