"use client";

// Boots the PostHog browser SDK once, then identifies the signed-in user
// (if any) by hitting the same /api/auth/me endpoint that all dashboards
// use. Lives at the root so every client page sees an initialised SDK.
//
// Identification details:
//   - distinct_id is the Supabase auth user id, so anonymous + signed-in
//     funnels are stitched together.
//   - is_test_account is set as a person property AND a super-property,
//     so PostHog dashboards can filter the 40-tester cohort out of the
//     real metrics. Mirrors the way our /admin dashboards already do it.
//
// If NEXT_PUBLIC_POSTHOG_KEY is missing we no-op completely — the rest
// of the app's track() calls already short-circuit when the SDK isn't
// initialised (see lib/posthog.ts).

import { useEffect } from "react";
import posthog from "posthog-js";

type AuthMe = {
  id?: string;
  email?: string | null;
  role?: string | null;
  is_test_account?: boolean | null;
};

export default function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) return;
    if (posthog.__loaded) return;

    posthog.init(key, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
      // capture_pageview/_leave handled by Next App Router via the
      // pageviewmode 'history_change' default — nothing to do here.
      capture_pageview: "history_change",
      capture_pageleave: true,
      // Replays are off by default to keep the free tier intact and
      // avoid PII review until we explicitly opt in.
      disable_session_recording: true,
      // Suppress autocapture in non-prod so dev clicks don't pollute
      // funnels.
      autocapture: process.env.NEXT_PUBLIC_VERCEL_ENV === "production",
      person_profiles: "identified_only",
      loaded: () => identifyFromMe(),
    });
  }, []);

  return <>{children}</>;
}

async function identifyFromMe() {
  try {
    const r = await fetch("/api/auth/me", { cache: "no-store" });
    if (!r.ok) return;
    const me: AuthMe = await r.json();
    if (!me?.id) return;
    posthog.identify(me.id, {
      email: me.email ?? undefined,
      role: me.role ?? undefined,
      is_test_account: !!me.is_test_account,
    });
    // Super-property: tagged onto every event from this distinct_id.
    // Use it as the cohort filter when building dashboards.
    posthog.register({ is_test_account: !!me.is_test_account });
  } catch {
    // Anonymous user, or /api/auth/me unreachable. Skip identify.
  }
}
