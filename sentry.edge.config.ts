// Sentry SDK init for the EDGE runtime (Vercel Edge Functions, Routing
// Middleware). Tiny config — same DSN, no replay (replay is browser-only),
// reduced sample rate.

import * as Sentry from "@sentry/nextjs";

const DSN = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || "";
const ENV = process.env.VERCEL_ENV || process.env.NODE_ENV || "development";

if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment: ENV,
    tracesSampleRate: ENV === "production" ? 0.1 : 1.0,
  });
}
