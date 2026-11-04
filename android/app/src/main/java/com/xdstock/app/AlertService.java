package com.xdstock.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * 盯盘服务：替网页盯着「止盈止损」。
 *
 * 网页那边每轮 tick 会把通知写进 /api/market 的 me.notices，
 * 这里每 20 秒拉一次，发现新的就发一条系统通知 ——
 * 所以 App 切后台、锁屏、网页被回收了，止盈止损照样能收到提醒。
 *
 * 用前台服务是为了不被系统杀掉，代价是状态栏常驻一条「正在盯盘」。
 */
public class AlertService extends Service {

    public static final String CHANNEL_WATCH = "xd_watch";   // 前台常驻
    public static final String CHANNEL_ALERT = "xd_alert";   // 止盈止损提醒

    private static final int FG_ID = 1001;
    private static final long POLL_MS = 20_000L;
    private static final int MAX_PER_POLL = 5;

    private Thread worker;
    private volatile boolean running = false;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && intent.getBooleanExtra("stop", false)) {
            running = false;
            stopSelf();
            return START_NOT_STICKY;
        }
        startForegroundCompat();
        if (worker == null || !worker.isAlive()) {
            running = true;
            worker = new Thread(this::loop, "xd-alert-poll");
            worker.setDaemon(true);
            worker.start();
        }
        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (worker != null) {
            worker.interrupt();
            worker = null;
        }
        super.onDestroy();
    }

    // ---------------------------------------------------------------- 通道

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;

        NotificationChannel watch = new NotificationChannel(
                CHANNEL_WATCH, "盯盘服务", NotificationManager.IMPORTANCE_MIN);
        watch.setDescription("保持 App 在后台跑，用来接收止盈止损提醒");
        watch.setShowBadge(false);
        nm.createNotificationChannel(watch);

        NotificationChannel alert = new NotificationChannel(
                CHANNEL_ALERT, "止盈止损提醒", NotificationManager.IMPORTANCE_HIGH);
        alert.setDescription("止盈 / 止损触发和成交时提醒你");
        alert.enableVibration(true);
        nm.createNotificationChannel(alert);
    }

    private PendingIntent openApp() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, 0, open, flags);
    }

    private void startForegroundCompat() {
        Notification n = new NotificationCompat.Builder(this, CHANNEL_WATCH)
                .setContentTitle("小灯证券正在盯盘")
                .setContentText("止盈止损触发和成交都会通知你")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setContentIntent(openApp())
                .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(FG_ID, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(FG_ID, n);
        }
    }

    // ---------------------------------------------------------------- 轮询

    private void loop() {
        while (running) {
            try {
                pollOnce();
            } catch (Exception ignored) {
                // 网络抖动 / 服务器重启，下一轮再试
            }
            if (!running) break;
            try {
                Thread.sleep(POLL_MS);
            } catch (InterruptedException e) {
                break;
            }
        }
    }

    private SharedPreferences prefs() {
        return getSharedPreferences("xd_shell", MODE_PRIVATE);
    }

    /** 一次拉取的结果：distinguish「登录失效」和「网络挂了」 */
    private static class Fetched {
        JSONObject me;      // 成功时非 null
        boolean authFail;   // 401 / 403：token 废了，该停
    }

    private void pollOnce() {
        SharedPreferences sp = prefs();
        String token = sp.getString("token", "");
        String base = sp.getString("base", "");
        if (token.isEmpty() || base.isEmpty()) {
            stopSelf();
            return;
        }

        Fetched f = fetchMe(base, token);
        if (f.authFail) {
            // 登录态失效：停掉，等网页重新登录再拉起
            sp.edit().putBoolean("alerts_on", false).apply();
            stopSelf();
            return;
        }
        JSONArray notices = f.me == null ? null : f.me.optJSONArray("notices");
        if (notices == null || notices.length() == 0) return;

        JSONObject first = notices.optJSONObject(0);
        String newest = first == null ? "" : first.optString("id", "");
        if (newest.isEmpty()) return;

        String lastId = sp.getString("last_notice_id", "");
        if (lastId.isEmpty()) {
            // 第一次跑：只记住当前最新的，不倒灌历史通知
            sp.edit().putString("last_notice_id", newest).apply();
            return;
        }
        if (newest.equals(lastId)) return;

        List<String> fresh = new ArrayList<>();
        for (int i = 0; i < notices.length() && fresh.size() < MAX_PER_POLL; i++) {
            JSONObject n = notices.optJSONObject(i);
            if (n == null) continue;
            String id = n.optString("id", "");
            if (id.equals(lastId)) break;
            String kind = n.optString("kind", "");
            if (!("tpsl".equals(kind) || "tpslFill".equals(kind) || "close".equals(kind))) continue;
            String text = n.optString("text", "");
            if (!text.isEmpty()) fresh.add(text);
        }
        sp.edit().putString("last_notice_id", newest).apply();

        // 旧的先发、新的后发（后发的在最上面）
        for (int i = fresh.size() - 1; i >= 0; i--) {
            postAlert(fresh.get(i));
        }
    }

    private Fetched fetchMe(String base, String token) {
        Fetched out = new Fetched();
        HttpURLConnection conn = null;
        try {
            URL url = new URL(base + "/api/market");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(12000);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Accept", "application/json");

            int code = conn.getResponseCode();
            if (code == 401 || code == 403) {
                out.authFail = true;
                return out;
            }
            if (code != 200) return out;

            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(
                    new InputStreamReader(conn.getInputStream(), "UTF-8"))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            JSONObject all = new JSONObject(sb.toString());
            out.me = all.optJSONObject("me");
            return out;
        } catch (Exception e) {
            return out;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void postAlert(String text) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(this);
        if (!nm.areNotificationsEnabled()) return;

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ALERT)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("小灯证券 · 止盈止损")
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(openApp());

        try {
            nm.notify(text.hashCode() & 0x7fffffff, b.build());
        } catch (SecurityException ignored) {
            // 没给通知权限，静默跳过
        }
    }
}
