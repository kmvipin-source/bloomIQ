import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Global middleware — attaches security headers to every response and
 * lets the framework keep handling routing as normal. Page-level auth
 * gates still run separately; this middleware is defense-in-depth, not
 * a primary auth check.
 *
 * Headers chosen:
 *   - Strict-Transport-Security: 2-year HSTS, includeSubdomains,
 *     preload. Forces HTTPS on every subsequent visit. Vercel already
 *     redirects http→https; HSTS makes the browser remember.
 *   - Content-Security-Policy: tight allow-list. Sentry was removed in
 *     PR #30 so no `tunnelRoute` to whitelist. Razorpay needs
 *     checkout.razorpay.com (script + frame). Supabase needs *.supabase.co
 *     for the realtime websocket + REST. PostHog needs us.i.posthog.com.
 *   - X-Frame-Options: DENY. We don't host anything that needs framing.
 *   - X-Content-Type-Options: nosniff.
 *   - Referrer-Policy: strict-origin-when-cross-origin (leaks just the
 *     domain on outbound, not the path).
 *   - Permissions-Policy: deny camera/mic/geolocation/payment by
 *     default; Razorpay opens in a popup so it doesn't need the
 *     Permissions-Policy 'payment' grant on our origin.
 *
 * NOTE: CSP is intentionally NOT `report-only` here — if a regression
 * blocks a real load, we want it surfaced in DevTools immediately
 * rather than weeks later. Adjust the policy as needed when adding new
 * third-party integrations.
 */

const SUPABASE_HOST = (process.env.NEXT_PUBLIC_SUPABASE_URL || "")
  .replace(/^https?:\/\//, "")
  .replace(/\/.*$/, "");

const cspParts = [
  "default-src 'self'",
  // 'unsafe-eval' is needed for some Vercel dev/Turbopack tooling; in
  // prod it remains because removing it requires deeper auditing of
  // third-party SDKs (Razorpay).
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://checkout.razorpay.com https://us.i.posthog.com https://*.posthog.com https://va.vercel-scripts.com https://vercel.live`,
  // Inline styles needed by Next.js + Tailwind runtime injection.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  // Supabase websocket realtime + REST + auth. PostHog ingest.
  `connect-src 'self' https://${SUPABASE_HOST} wss://${SUPABASE_HOST} https://api.razorpay.com https://lumberjack.razorpay.com https://us.i.posthog.com https://*.posthog.com https://*.ingest.us.posthog.com https://va.vercel-scripts.com`,
  // Razorpay checkout opens in an iframe within the page.
  "frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS: Array<[string, string]> = [
  ["Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload"],
  ["X-Frame-Options", "DENY"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()"],
  ["Content-Security-Policy", cspParts],
  ["X-DNS-Prefetch-Control", "on"],
];

export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  for (const [name, value] of SECURITY_HEADERS) {
    res.headers.set(name, value);
  }
  return res;
}

export const config = {
  // Skip middleware on static assets + Next internals; everything else
  // (pages, API routes, service worker) gets the headers.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|webmanifest|woff2?)$).*)",
  ],
};
