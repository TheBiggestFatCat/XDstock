import io
import sys

sys.stdout.reconfigure(encoding='utf-8')

P = 'D:/WebProjects/XDstock/public/app.js'
s = io.open(P, encoding='utf-8').read().replace('\r\n', '\n')

# 注册 Service Worker（PWA：可以「添加到主屏幕」当 App 用）
if 'serviceWorker' not in s:
    s = s.replace(
        "boot();",
        """// PWA：注册 Service Worker，安装到桌面后可离线打开
if ('serviceWorker' in navigator && location.protocol === 'https:' ||
    ('serviceWorker' in navigator && location.hostname !== 'localhost' && location.protocol === 'http:')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

boot();""", 1)
    io.open(P, 'w', encoding='utf-8', newline='\n').write(s)
    print('Service Worker 注册已加')
else:
    print('已存在')
