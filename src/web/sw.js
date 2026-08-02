/**
 * THE KEEPER — service worker.
 *
 * VERSION is stamped by the server at boot from a hash of the shell assets
 * (see src/web/server.ts), so a deploy that changes the UI necessarily changes
 * this file's bytes — which is the only thing that makes a browser re-install a
 * service worker. Without that, editing app.css would leave every installed
 * client frozen on the old precache.
 *
 * Caching rules, in short:
 *   /events, /send   never touched — routing SSE or a POST through a fetch
 *                    handler is the classic way to break streaming
 *   navigations      network-first, cached shell as the offline fallback
 *   /api/snapshot    network-first, last good response kept so the transcript
 *                    and the mind drawer stay readable offline (flagged stale)
 *   static assets    cache-first
 *
 * It is also what receives Web Push messages — see the bottom of the file. That
 * is the only reason the Keeper can reach him on this surface with the app shut.
 */
const VERSION = '__VERSION__';
const CACHE = `keeper-${VERSION}`;
const SNAPSHOT_URL = '/api/snapshot';

/**
 * scripts/ui-preview.ts stamps a version beginning with "preview". There,
 * assets are fetched network-first so an edit to app.css shows up on reload
 * instead of being served from a precache that only rotates on deploy.
 */
const DEV = VERSION.startsWith('preview');

/** Enough to boot the UI with no network at all. */
const SHELL = [
  '/',
  '/app.css',
  '/app.js',
  '/icons/galaxy-backdrop.png',
  '/icons/galaxy-gargantua.png',
  '/manifest.webmanifest',
  '/fonts/inter-var.woff2',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  // Notifications are drawn while the app is closed and possibly on a bad
  // connection — their artwork has to already be here.
  '/icons/badge-96.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Individually, so one 404 can't fail the whole install the way addAll does.
      Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The page asks for the takeover once the user accepts the update toast, so a
// running conversation is never swapped out from under itself.
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data.type === 'VERSION' && event.ports[0]) event.ports[0].postMessage(VERSION);
});

/** Network-first with a cached fallback, tagging what came from cache as stale. */
async function snapshotStrategy(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    // Only ever store a genuine payload — never a 401 or a 500.
    if (res.ok) {
      const body = await res.clone().arrayBuffer();
      const headers = new Headers(res.headers);
      headers.set('X-Keeper-Cached-At', new Date().toISOString());
      await cache.put(SNAPSHOT_URL, new Response(body, { status: 200, headers }));
    }
    return res;
  } catch {
    const hit = await cache.match(SNAPSHOT_URL);
    if (!hit) throw new Error('offline, no cached snapshot');
    const headers = new Headers(hit.headers);
    headers.set('X-Keeper-Stale', '1');
    return new Response(await hit.arrayBuffer(), { status: 200, headers });
  }
}

async function navigationStrategy(request) {
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(CACHE);
      cache.put('/', res.clone());
    }
    return res;
  } catch {
    const cache = await caches.open(CACHE);
    return (await cache.match('/')) || Response.error();
  }
}

async function assetStrategy(request) {
  const cache = await caches.open(CACHE);
  if (!DEV) {
    const hit = await cache.match(request);
    if (hit) return hit;
  }
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // SSE must stream straight through; /send is a POST and already excluded.
  if (url.pathname === '/events' || url.pathname === '/send') return;

  if (request.mode === 'navigate') {
    event.respondWith(navigationStrategy(request));
    return;
  }
  if (url.pathname === SNAPSHOT_URL) {
    event.respondWith(snapshotStrategy(request));
    return;
  }
  if (/^\/(app\.(css|js)|manifest\.webmanifest)$|^\/(icons|fonts)\//.test(url.pathname)) {
    event.respondWith(assetStrategy(request));
  }
});

/* ── notifications ─────────────────────────────────────────────────────────
   This is the half of the app that runs when the app isn't running. The push
   service wakes this worker with an encrypted payload from src/web/push.ts;
   everything below decides what he actually sees.                           */

async function onPush(event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // A payload that isn't ours (or wasn't JSON) still deserves to surface.
    data = { body: event.data ? event.data.text() : '' };
  }

  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const open = clients.find((c) => c.visibilityState === 'visible');
  if (open) open.postMessage({ type: 'PUSH', data });
  if (open && !data.force) {
    // He's already looking at it, and the message is arriving over SSE anyway —
    // a notification here would be the app interrupting him about the thing on
    // his screen. Chrome waives the must-show-something rule exactly while a
    // window from this origin is visible, which is this branch. (`force` is the
    // test button, where seeing one IS the point.)
    return;
  }

  await self.registration.showNotification(data.title || 'keeper', {
    body: data.body || 'it has something for you',
    icon: '/icons/icon-192.png',
    // Android tints this to a flat silhouette for the status bar; the full
    // colour icon becomes an unreadable grey blob there.
    badge: '/icons/badge-96.png',
    // Distinct per message, so two reach-outs stack instead of the second
    // quietly replacing the first before he's read it.
    tag: data.tag || 'keeper',
    timestamp: data.ts ? Date.parse(data.ts) : Date.now(),
    data: { url: data.url || '/' },
  });
}

self.addEventListener('push', (event) => {
  event.waitUntil(onPush(event));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Focus what's already open rather than stacking a second window — an
      // installed PWA that opens a new instance per notification is a mess.
      for (const c of clients) {
        if (new URL(c.url).origin === self.location.origin) {
          await c.focus();
          return;
        }
      }
      await self.clients.openWindow(target);
    })()
  );
});
