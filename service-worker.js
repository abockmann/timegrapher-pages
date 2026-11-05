// Pass-through service worker: keeps the app installable as a PWA, but caches nothing.
// Every request goes to the network, and the browser's HTTP cache is bypassed, so a
// normal reload always picks up newly deployed files.  (Offline use is NOT supported.)

// Activate: delete every cache left behind by earlier versions of this worker.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Optional: cross-origin isolation headers (only needed if you use SharedArrayBuffer;
// the current worklet transfers buffers instead, so you can delete this function and
// return the plain response below).
function addIsolationHeaders(response) {
  if (response.status === 0 || response.type === 'opaque') return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy',   'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// A fetch handler must exist for some browsers to treat the site as installable.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;           // let the browser handle everything else
  event.respondWith(
    fetch(event.request, { cache: 'no-store' }).then(addIsolationHeaders)
  );
});
