/* `__MOAPP_PRECACHE__` is replaced by the Vite build plugin with current hashed assets. */
const CACHE = 'moapp-shell-v3'
const PRECACHE = self.__MOAPP_PRECACHE__ || ['/', '/manifest.webmanifest', '/icon.svg', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((key) => key !== CACHE && (key === 'moapp-shell-v1' || key === 'moapp-shell-v2' || key.startsWith('moapp-shell-')))
    .map((key) => caches.delete(key)))).then(() => self.clients.claim()))
})

// Kept for the pre-cutover client. The UI decides when activation is safe.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting())
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  if (event.request.mode === 'navigate') {
    // Never cache individual navigation URLs: they can carry arbitrary query
    // state. Offline navigation has one safe fallback, the app shell at '/'.
    event.respondWith(fetch(event.request).catch(() => caches.match('/')))
    return
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)))
})
