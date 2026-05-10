// Sentry SDK init for the BROWSER bundle.
//
// Loaded by every client component. Catches uncaught errors, unhandled
// promise rejections, and (when enabled) records session replays for the
// before-error window. Heavy features (replay, performance traces) are
// rate-limited to keep us inside the free 5K-events/mo Sentry tier.
//
// All knobs are env-var driven — production tunes via Vercel env vars,
// dev silently no-ops when SENTRY_DSN is unset.

import * as Sentry from "@sentry/nextjs";

// Required by @sentry/nextjs to instrument App Router client navigations.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN || "";
const ENV = process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV || "development";

if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment: ENV,
    // Sample 10% of regular transactions in production, 100% in preview/dev.
    // Keeps the free-tier event budget safe while still surfacing Web Vitals
    // in production.
    tracesSampleRate: ENV === "production" ? 0.1 : 1.0,
    // Replays are heavy — record only when an error fires (replaysOnErrorSampleRate).
    // The "always" sampler is intentionally low so a runaway replay flood
    // can't burn the quota.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: ENV === "production" ? 0.5 : 1.0,
    // Drop noisy events — browser extensions inject errors into pages they
    // didn't write. Adding the most common offenders here trims the SDK's
    // default ignore list.
    ignoreErrors: [
      "ResizeObserver loop limit exceeded",
      "ResizeObserver loop completed with undelivered notifications",
      // Razorpay SDK occasionally surfaces "user closed modal" as an error;
      // it's expected UX, not a fault.
      /Razorpay.*dismissed/i,
    ],
    integrations: [
      Sentry.replayIntegration({
        // Mask all text + media by default. We will not record the actual
        // content of student answers / teacher questions / school PII into
        // the replay.
        maskAllText: true,
        blockAllMedia: true,
      }),
    ],
  });
}
