import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dynamic /sw.js — the cache name is stamped with VERCEL_DEPLOYMENT_ID
 * (or a static build ID locally) so every Vercel deployment gets a
 * fresh cache. The previous static public/sw.js used CACHE = "bloomiq-v1"
 * forever, so users carried stale HTML/assets across deploys.
 *
 * Strategy:
 *   - HTML: network-first, cache fallback only on offline.
 *   - Static assets (Next emits content-hashed files under /_next/static):
 *     cache-first, but the cache version is per-deploy so old entries
 *     get cleaned out by the activate handler below.
 *   - /api/*: never intercepted.
 */
export function GET() {
  const buildId = process.env.VERCEL_DEPLOYMENT_ID
    || process.env.VERCEL_GIT_COMMIT_SHA
    || `dev-${Date.now()}`;

  const body = `// ZCORIQ service worker — auto-generated, version ${buildId}
const CACHE = "bloomiq-${buildId}";

// Precache the offline shell + key public assets. We deliberately do
// NOT precache "/" because it would be served as the offline fallback
// for ANY route — a signed-in user navigating offline would land on
// the public landing page instead of a more honest "/offline" shell.
const PRECACHE = ["/offline", "/manifest.webmanifest", "/icon-192.svg", "/icon-512.svg"];
const SELF_ORIGIN = self.location.origin;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // Only ever touch same-origin requests. The previous handler cached
  // any res.type === "cors" response, which let any third-party CDN
  // poison the cache once a single response went through. Lock the
  // SW to our own origin and never store anything cross-origin.
  const url = new URL(req.url);
  if (url.origin !== SELF_ORIGIN) return;
  if (url.pathname.startsWith("/api/")) return;

  const isHTML = req.headers.get("accept")?.includes("text/html");

  if (isHTML) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match(req).then((m) => m || caches.match("/offline"))
        )
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((res) => {
        // Same-origin only — checked by url.origin guard above. Skip
        // opaque / non-OK responses defensively.
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit)
    )
  );
});
`;

  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Service-Worker-Allowed": "/",
    },
  });
}
