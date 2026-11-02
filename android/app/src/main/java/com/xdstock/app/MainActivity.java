package com.xdstock.app;

import android.annotation.SuppressLint;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
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

    @SuppressLint("SetJavaScriptEnabled")
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

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                errorBox.setVisibility(View.GONE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                swipe.setRefreshing(false);
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
