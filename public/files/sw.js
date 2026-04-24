const CACHE = 'jarvis-v1';
const ASSETS = ['/', '/index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('/ws') || e.request.url.includes('/ask') || e.request.url.includes('/auth')) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
