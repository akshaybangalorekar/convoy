/* Convoy service worker
 * ------------------------------------------------------------------
 * Makes the app installable to the home screen and usable offline.
 *
 * Strategy
 *   - App shell (same origin) : network-first, so updates land; cache
 *     is the fallback when there's no signal.
 *   - Versioned CDN assets    : cache-first (the URLs are immutable).
 *   - OpenStreetMap tiles     : cache-first with a bounded cache, so a
 *     drive through a dead spot keeps the map you already looked at.
 *
 * Bump VERSION when the shell changes; old caches are deleted on activate.
 */
'use strict';

const VERSION = 'convoy-v81';
const TILE_CACHE = 'convoy-tiles-v1';
const MAX_TILES = 400;          // ~6 MB, roughly one afternoon of driving

const SHELL = [
  './',
  './index.html',
  './app.js',
  './config.js',
  './net.js',
  './route.js',
  './install.js',
  './styles.css',
  './manifest.webmanifest',
  './icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

const CDN = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet-rotate@0.2.8/dist/leaflet-rotate.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    // Best-effort: opaque cross-origin responses are fine to store here.
    await Promise.all(CDN.map((url) =>
      cache.add(new Request(url, { mode: 'no-cors' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== VERSION && k !== TILE_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isTile = (url) => /(^|\.)tile\.openstreetmap\.org$/.test(url.hostname);

async function trimTiles(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_TILES) return;
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

/* Web Push. This is the one thing that reaches the phone when the app is not open — which
   is the whole point of moving the durable state to a server. It works on Android Chrome
   and, from 16.4, on an installed iOS app; Safari will not deliver it to a browser tab. */
self.addEventListener('push', (event) => {
  let data = { title: 'Convoy', body: '' };
  try { data = event.data ? event.data.json() : data; } catch (e) { /* plain text */ }
  const title = data.title || 'Convoy';
  const body = data.body || '';
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag: data.tag || 'convoy',
    renotify: !!data.tag,
    data: { url: data.url || './' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { try { await c.focus(); return; } catch (e) { /* ignore */ } }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // --- map tiles: cache-first, bounded
  if (isTile(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) {
          await cache.put(req, res.clone());
          await trimTiles(cache);
        }
        return res;
      } catch (e) {
        return hit || Response.error();
      }
    })());
    return;
  }

  // --- app shell: network-first, cached fallback
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      try {
        // no-store, or "network-first" is a lie: GitHub Pages sets a ten-minute HTTP
        // cache, and going through it is how a phone ends up running last week's code
        // while a fresh laptop runs today's.
        const res = await fetch(req, { cache: 'no-store' });
        if (res && res.ok) await cache.put(req, res.clone());
        return res;
      } catch (e) {
        const hit = (await cache.match(req)) || (await cache.match('./index.html'));
        return hit || Response.error();
      }
    })());
    return;
  }

  // --- versioned CDN assets: cache-first
  if (url.hostname === 'unpkg.com') {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res) await cache.put(req, res.clone());
        return res;
      } catch (e) {
        return hit || Response.error();
      }
    })());
  }
});
