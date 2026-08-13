import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react(), {
    name: 'moapp-service-worker-precache',
    apply: 'build',
    generateBundle(_options, bundle) {
      const precache = ['/', '/manifest.webmanifest', '/icon.svg', ...Object.keys(bundle)
        .filter((file) => /^assets\/.+\.(?:js|css)$/.test(file))
        .map((file) => `/${file}`)]
      const worker = `const CACHE='moapp-shell-v3';const PRECACHE=${JSON.stringify(precache)};${WORKER_BODY}`
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: worker })
    },
  }],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: { sourcemap: true },
})

// The built worker is emitted as an asset so its precache always names the
// current hashed Vite files. Public sw.js is retained for dev serving.
const WORKER_BODY = `
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(PRECACHE))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE&&(key==='moapp-shell-v1'||key==='moapp-shell-v2'||key.startsWith('moapp-shell-'))).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('message',event=>{if(event.data&&event.data.type==='SKIP_WAITING')event.waitUntil(self.skipWaiting())});
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;if(event.request.mode==='navigate'){event.respondWith(fetch(event.request).catch(()=>caches.match('/')));return}event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request)))});`
