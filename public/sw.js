const CACHE_NAME = 'lumio-v100-FINAL';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(['/', '/index.html', '/app.js', '/manifest.json']);
    }).then(() => self.skipWaiting()) // Принудительно активирует новый SW
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(keyList.map((key) => {
        if (key !== CACHE_NAME) {
          return caches.delete(key); // УДАЛЯЕТ все старые версии (v1, v3 и т.д.)
        }
      }));
    }).then(() => self.clients.claim()) // Принудительно берет контроль над всеми вкладками
  );
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((response) => {
      return response || fetch(e.request);
    })
  );
});