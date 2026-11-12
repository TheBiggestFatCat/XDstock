// 灏忕伅璇佸埜 路 Service Worker
// 闈欐€佽祫婧愶細缃戠粶浼樺厛锛屽け璐ユ椂鐢ㄧ紦瀛橈紙绂荤嚎涔熻兘鎵撳紑锛?// 鎺ュ彛璇锋眰锛氱洿鎺ヨ蛋缃戠粶锛岀粷涓嶇紦瀛橈紙琛屾儏蹇呴』瀹炴椂锛?
const CACHE = 'xdstock-v161';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/vendor/lightweight-charts.js',
  '/assets/logo.png',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 鎺ュ彛涓嶇紦瀛?  if (url.pathname.startsWith('/api/') || url.pathname === '/stream') return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html')))
  );
});
