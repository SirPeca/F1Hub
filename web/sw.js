// =========================================
// F1 Hub — sw.js
// Cachea únicamente el "shell" estático (HTML/CSS/JS/íconos) para que la
// app abra instantáneo y funcione (sin datos) offline. Nunca cachea /api/*:
// los datos de F1 siempre se piden frescos a la red.
// =========================================

const SHELL_CACHE = 'f1hub-shell-v1';
const SHELL_FILES = [
  '/', '/index.html', '/styles.css', '/app.js', '/manifest.json',
  '/icon-192.png', '/icon-512.png',
];

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

  // Datos dinámicos: siempre red, nunca cache del SW (la cache de edge ya
  // la maneja Cloudflare en las funciones /api/*).
  if (url.pathname.startsWith('/api/')) return;

  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).catch(() => caches.match('/index.html'));
    })
  );
});
