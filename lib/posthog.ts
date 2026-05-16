// Thin facade over posthog-js. Two reasons to wrap it:
//   1. The SDK is initialised inside <PostHogProvider /> (client-only).
//      Pages / server components that import the client directly can
//      crash builds. This module is safe to import from any client file.
//   2. When NEXT_PUBLIC_POSTHOG_KEY is absent (local dev, preview without
//      analytics, or before launch), every track() call becomes a no-op
//      so we don't litter `if (posthog) ...` checks at every event site.
//
// All tracked events MUST be one of EventName below — that gives us a
// single grep target if we ever need to rename a funnel step.

import posthog from "posthog-js";

export type EventName =
  | "signup_completed"
  | "quiz_started"
  | "quiz_submitted"
  | "subscription_paid";

export type EventProps = Record<string, string | number | boolean | null | undefined>;

function isEnabled(): boolean {
  if (typeof window === "undefined") return false;
  // posthog.__loaded is the SDK's own "ready" sentinel; if init() never
  // ran (no key configured) we silently bail.
  return !!process.env.NEXT_PUBLIC_POSTHOG_KEY && !!posthog.__loaded;
}

export function track(event: EventName, props?: EventProps): void {
  if (!isEnabled()) return;
  try {
    posthog.capture(event, props);
  } catch {
    // Never let analytics break the user-facing flow.
  }
}

// F118 note (QA): identify() is called from a handful of auth-success
// surfaces but NOT consistently — login/school + login/student + claim-
// session + signup-autostart should all call it. Without it, every
// pre-identify event lands on an anon distinct_id and the funnel
// dashboards under-report by ~20-30%. Audit the call sites when the
// PostHog dashboards become a key business artifact.
export function identify(userId: string, traits?: EventProps): void {
  if (!isEnabled()) return;
  try {
    posthog.identify(userId, traits);
  } catch { /* swallow */ }
}

export function resetIdentity(): void {
  if (!isEnabled()) return;
  try {
    posthog.reset();
  } catch { /* swallow */ }
}
