const CACHE_NAME = 'watch-timer-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/style.css',
  '/ui.js',
  '/custom_elements.js',
  '/manifest.json',
  '/webaudio.js',
  '/visualization.js',
  '/timegrapher.js',
  '/timegrapher.wasm',
  '/icon.png',
  '/recorder.worklet.js',
  '/service-worker.js',
  '/beatbuffer.js'
  // Add any other files your app needs
];

// Install event - cache all files
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
  // Force the service worker to activate immediately
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  // Take control of all pages immediately
  return self.clients.claim();
});

// Fetch event - serve from cache, fallback to network, always inject COOP/COEP headers.
//
// Cross-Origin-Opener-Policy + Cross-Origin-Embedder-Policy are required for
// SharedArrayBuffer (used by zero-copy ring buffers) and for the browser to consider
// the page "cross-origin isolated".  Without these headers SharedArrayBuffer is
// disabled in all modern browsers as a Spectre mitigation.
function addIsolationHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy',   'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return new Response(response.body, {
    status:     response.status,
    statusText: response.statusText,
    headers,
  });
}

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return addIsolationHeaders(response);
        }
        const fetchRequest = event.request.clone();
        
        return fetch(fetchRequest).then(response => {
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }
          
          const responseToCache = response.clone();
          
          caches.open(CACHE_NAME)
            .then(cache => {
              cache.put(event.request, responseToCache);
            });
          
          return addIsolationHeaders(response);
        });
      })
  );
});