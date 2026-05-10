// Sentry SDK init for the SERVER bundle (Node runtime API routes,
// route handlers, server actions). Catches unhandled exceptions,
// rejected promises, and database errors that bubble up.
//
// SENTRY_DSN is the SAME DSN as the client — Sentry routes by SDK
// origin, not by token. The variable is server-side only here so it
// doesn't get inlined into the browser bundle.

import * as Sentry from "@sentry/nextjs";

const DSN = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || "";
const ENV = process.env.VERCEL_ENV || process.env.NODE_ENV || "development";

if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment: ENV,
    // 10% production sampling; 100% in preview/dev so issue triage is
    // immediate. Trace payloads are bigger than error payloads — be
    // careful not to bump this without watching the quota.
    tracesSampleRate: ENV === "production" ? 0.1 : 1.0,
    // The /api/healthz endpoint is hit every 5 minutes by UptimeRobot.
    // We don't want every healthy ping to consume a Sentry transaction
    // — drop them in beforeSendTransaction.
    beforeSendTransaction(event) {
      const op = event.transaction;
      if (op && /\/api\/healthz/.test(op)) return null;
      return event;
    },
  });
}
