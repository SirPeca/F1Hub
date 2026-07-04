// =========================================
// F1 Hub — sw.js
// Cachea únicamente el "shell" estático (HTML/CSS/JS/íconos) para que la
// app abra instantáneo y funcione (sin datos) offline. Nunca cachea /api/*:
// los datos de F1 siempre se piden frescos a la red.
// =========================================

// =========================================
// F1 Hub — sw.js  v2 (network-first)
//
// v1 usaba "cache-first" para el shell (HTML/CSS/JS), lo cual causaba
// que un navegador que ya había visitado el sitio siguiera viendo
// código viejo después de cada deploy nuevo, indefinidamente, hasta
// que alguien borrara manualmente los datos del sitio. Ese fue un bug
// real que rompió la percepción de "nada nuevo funciona" en la v2.
//
// v2 invierte la estrategia: **network-first**. Con conexión (el caso
// normal), siempre se pide la versión más nueva a la red y se
// actualiza la caché con ella. La caché solo se usa como respaldo si
// la red falla (modo offline real). Bumpear el nombre de la caché acá
// abajo fuerza además una limpieza total de lo que haya quedado de v1.
// =========================================

const SHELL_CACHE = 'f1hub-shell-v2';
const SHELL_FILES = [
  '/', '/index.html', '/styles.css', '/app.js', '/manifest.json',
  '/icon-192.png', '/icon-512.png',
];
const NETWORK_TIMEOUT_MS = 4000; // si la red tarda más que esto, usamos caché mientras responde

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Datos dinámicos: nunca los toca el SW (la caché de edge de
  // Cloudflare ya se encarga en las funciones /api/*).
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(networkFirst(event.request));
});

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const networkResponse = await fetchWithTimeout(request, NETWORK_TIMEOUT_MS);
    if (networkResponse && networkResponse.ok) cache.put(request, networkResponse.clone());
    return networkResponse;
  } catch {
    const cached = await cache.match(request);
    return cached || cache.match('/index.html');
  }
}

function fetchWithTimeout(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    fetch(request).then((res) => { clearTimeout(timer); resolve(res); }, (err) => { clearTimeout(timer); reject(err); });
  });
}

// =========================================
// PUSH NOTIFICATIONS
// El payload lo arma cron-worker/src/index.js: { title, body, url }
// =========================================
self.addEventListener('push', (event) => {
  let payload = { title: '🏁 F1 Hub', body: 'Hay novedades.', url: '/' };
  try { payload = { ...payload, ...event.data.json() }; } catch { /* payload no-JSON, usamos default */ }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: payload.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(clients.openWindow(url));
});
