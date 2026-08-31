// sw.js — service worker, app-shell precache.
//
// See /root/.claude/plans/your-job-is-to-iterative-trinket.md §4 ("PWA shell") and
// README.md's "How to release a new version". Registered from index.html (feature-
// guarded, never blocking the app — see the inline script at the end of <body>).
//
// Rules (hard requirements):
//   1. Precache the app shell (index.html, the 4 JS files, manifest, icons) under
//      CACHE_VERSION.
//   2. Network-first with cache fallback for the shell, so a new deploy is picked
//      up on next load without a hard refresh; cache-first for icons, since icon
//      bytes never change without a CACHE_VERSION bump anyway.
//   3. sheets.googleapis.com and accounts.google.com are NEVER intercepted — the
//      fetch handler bails out before touching the cache for those, and for any
//      other cross-origin request, so the browser handles auth redirects and live
//      Sheets calls natively. QA greps for these two hostnames in this file.
//   4. skipWaiting() + clients.claim() so a new version takes over immediately;
//      old caches whose name doesn't match the current CACHE_VERSION are deleted
//      on activate.
//
// CACHE_VERSION here is a plain literal, deliberately NOT shared via a script
// import with config.js — a service worker has its own global scope and no DOM,
// and importScripts('config.js') would run config.js's `window`-detection branch
// against the SW global instead. Keep this value equal to config.js's
// CACHE_VERSION by hand; README.md's release steps say so explicitly ("bump
// CACHE_VERSION in both config.js and sw.js").
var CACHE_VERSION = 'entr-v5';
var CACHE_NAME = 'entr-shell-' + CACHE_VERSION;

// Precached app shell: index.html, the four JS files, the manifest. Network-first
// with cache fallback (see the fetch handler below).
var SHELL_PATHS = [
  './',
  './index.html',
  './config.js',
  './auth.js',
  './sheets.js',
  './app.js',
  './manifest.webmanifest'
];

// Precached icons. Cache-first (see the fetch handler below) — icon bytes only
// ever change alongside a CACHE_VERSION bump, which gets a fresh cache name
// anyway, so there is no staleness risk in serving these from cache forever.
var ICON_PATHS = [
  './icons/tab-treino.png',
  './icons/tab-futuros.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

// Resolve every path against the service worker's own location (not
// self.registration.scope, which is a Response-shaped promise-less string but
// behaves the same here) so this works whether the app is served from a domain
// root or a GitHub Pages project sub-path like /entrainement/.
function toAbsolute(relativePath) {
  return new URL(relativePath, self.location.href).href;
}

var SHELL_URLS = SHELL_PATHS.map(toAbsolute);
var ICON_URLS = ICON_PATHS.map(toAbsolute);
var ICON_URL_SET = {};
ICON_URLS.forEach(function (u) {
  ICON_URL_SET[u] = true;
});

// ---------------------------------------------------------------------------
// install — precache the shell + icons, then activate immediately.
// ---------------------------------------------------------------------------
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(SHELL_URLS.concat(ICON_URLS));
    }).then(function () {
      // Take over from any waiting/previous SW as soon as this one finishes
      // installing, per plan §4 ("skipWaiting() + clients.claim()").
      return self.skipWaiting();
    })
  );
});

// ---------------------------------------------------------------------------
// activate — drop any cache whose name doesn't match the current
// CACHE_VERSION, then start controlling all open clients right away.
// ---------------------------------------------------------------------------
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) {
            return key !== CACHE_NAME;
          })
          .map(function (key) {
            return caches.delete(key);
          })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// ---------------------------------------------------------------------------
// fetch — network-first + cache fallback for the shell, cache-first for
// icons. sheets.googleapis.com / accounts.google.com / any other cross-origin
// request are NEVER intercepted: return without calling event.respondWith so
// the browser's own network stack handles them (auth redirects, live Sheets
// reads/writes must never go through this cache).
// ---------------------------------------------------------------------------
self.addEventListener('fetch', function (event) {
  var request = event.request;

  // Only ever intercept simple GETs for our own static files. Sheets writes
  // are PUT/POST and must reach the network untouched regardless of origin.
  if (request.method !== 'GET') {
    return;
  }

  var url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }

  // Hard requirement (plan §4): never intercept the Google APIs this app
  // talks to directly. Let the browser handle these natively.
  if (url.hostname === 'sheets.googleapis.com' || url.hostname === 'accounts.google.com') {
    return;
  }

  // Bail out on any other cross-origin request too — this service worker only
  // ever serves same-origin app-shell files, nothing else.
  if (url.origin !== self.location.origin) {
    return;
  }

  if (ICON_URL_SET[request.url]) {
    // Cache-first for icons.
    event.respondWith(
      caches.match(request).then(function (cached) {
        if (cached) {
          return cached;
        }
        return fetch(request).then(function (response) {
          return cacheClonedResponse(request, response);
        });
      })
    );
    return;
  }

  // Network-first with cache fallback for the shell, so a fresh deploy lands
  // on next load without users needing a hard refresh.
  event.respondWith(
    fetch(request)
      .then(function (response) {
        return cacheClonedResponse(request, response);
      })
      .catch(function () {
        return caches.match(request).then(function (cached) {
          if (cached) {
            return cached;
          }
          // No network, no cache entry (e.g. a shell file added after this
          // SW installed) — let the failure surface rather than hang.
          return Promise.reject(new Error('sw.js: no network and no cache for ' + request.url));
        });
      })
  );
});

// Cache a same-origin, successful (200, basic) response and return the
// original response to the page. Never caches opaque/error responses.
function cacheClonedResponse(request, response) {
  if (response && response.ok && response.type === 'basic') {
    var clone = response.clone();
    caches.open(CACHE_NAME).then(function (cache) {
      cache.put(request, clone);
    });
  }
  return response;
}
