/*
 * PrintFlow service worker.
 *
 * - Never caches the API (/api/*): documents, orders, prices and codes always come
 *   fresh from the server, and nothing personal is stored by the worker.
 * - Build assets (/_next/static, hashed) and icons: cache-first.
 * - Pages: network-first; if offline, the last copy of that page shell, else /offline.
 *   Page shells contain no personal data (it is fetched by the page from /api).
 */
const VERSION = "pf-v1";
const STATIC = `${VERSION}-static`;
const PAGES = `${VERSION}-pages`;
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PAGES)
      .then((c) => c.addAll([OFFLINE_URL]))
      .then(() => caches.open(STATIC))
      .then((c) => c.addAll(["/icons/icon-192.png", "/icons/icon-512.png"])),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

// The page asks a waiting worker to take over after showing "update available".
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // always network, never cached

  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (req.mode === "navigate") {
    event.respondWith(networkFirstPage(req));
  }
});

async function cacheFirst(req) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirstPage(req) {
  const cache = await caches.open(PAGES);
  try {
    const res = await fetch(req);
    // Only keep successful, ordinary HTML pages (no redirects, no errors).
    if (res.ok && res.type === "basic" && (res.headers.get("content-type") || "").includes("text/html")) {
      cache.put(stripSearch(req.url), res.clone());
    }
    return res;
  } catch {
    return (await cache.match(stripSearch(req.url))) || (await cache.match(OFFLINE_URL)) || Response.error();
  }
}

/** Query strings (e.g. one-time tokens in /verify-email?token=…) are never written to the cache key. */
function stripSearch(href) {
  const u = new URL(href);
  u.search = "";
  return u.toString();
}
