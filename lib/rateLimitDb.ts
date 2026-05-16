// lib/rateLimitDb.ts
// =============================================================================
// Distributed rate limiter — DB-backed counters (P2.10).
// -----------------------------------------------------------------------------
// Why
// ---
// lib/rateLimit.ts uses an in-process Map. That works for a single Node
// process but Vercel runs each request in an isolated lambda — so a user
// who hammers /api/generate gets a fresh empty counter on every cold
// start, trivially bypassing the limit. The existing code's docstring
// admits this is N×-bypassable; we just hadn't paid the cost yet.
//
// This module is the replacement: a single RPC call per protected
// request hits the rpc_rate_limit_increment() function (migration 93),
// gets back the new count, and compares against per-route limits.
//
// Posture
// -------
// - Fail-open. If the RPC throws (DB down, network blip), we LET THE
//   REQUEST THROUGH. A failing rate limiter must NEVER block paying
//   customers; the worst-case is a brief abuse window we'll catch on
//   the next call.
// - Only enforce on the 4–5 high-cost routes per the plan. Cheap routes
//   (topic-validate, list, dashboard reads) skip this entirely.
// - The limits below are hourly. Daily limits live in lib/freeQuota.ts
//   (a separate, billing-aware concern).
// =============================================================================

import { supabaseAdmin } from "@/lib/supabase/server";

/** Routes that should call enforceRateLimit(). Keep this list short —
 *  every entry costs one DB round-trip per request. */
export type LimitedRoute =
  | "ai.generate"
  | "ai.speed.start"
  | "ai.flashcards"
  | "ai.teach-back.grade"
  | "ai.papers.generate"
  | "ai.adaptive-practice"
  // F49 fix: school join needs a distributed limit so the per-lambda
  // in-memory throttle can't be cycled-around.
  | "school.join";

/** Hourly request caps per route. Conservative defaults; tune per
 *  observed traffic. Free-tier users hit these long before they hit
 *  the daily quota; paid tiers should generally not see these. */
const HOURLY_LIMITS: Record<LimitedRoute, number> = {
  "ai.generate":           30,
  "ai.speed.start":        20,
  "ai.flashcards":         15,
  "ai.teach-back.grade":   60,
  "ai.papers.generate":    8,
  "ai.adaptive-practice":  30,
  // F49 fix: brute-force-resistant ceiling for school join_code guesses.
  // Tuned roughly 6×/hour — a legitimate teacher only needs one or two
  // attempts in a session; an attacker doing brute force gets 429'd fast.
  "school.join":           6,
};

export type RateLimitVerdict = {
  /** True when the request is within the limit and should proceed. */
  allowed: boolean;
  /** Current count INCLUDING this request. */
  count: number;
  /** The configured limit for this route. */
  limit: number;
  /** Seconds until the current bucket rolls over. */
  retryAfterSeconds: number;
  /** True when the limiter failed open (DB error). Useful for telemetry. */
  failedOpen: boolean;
};

/** UTC hour bucket the request belongs to. Same routine on every node
 *  so concurrent lambdas hash to the same bucket. */
function currentBucketIso(): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

function secondsUntilNextHour(): number {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(now.getUTCHours() + 1, 0, 0, 0);
  return Math.max(1, Math.floor((next.getTime() - now.getTime()) / 1000));
}

/**
 * Increment the user's hourly counter for `route` and return a verdict.
 *
 * Callers should:
 *   const v = await enforceRateLimit(userId, "ai.generate");
 *   if (!v.allowed) return new NextResponse(
 *     JSON.stringify({ error: "Rate limit exceeded", retry_after_seconds: v.retryAfterSeconds }),
 *     { status: 429, headers: { "Retry-After": String(v.retryAfterSeconds) } },
 *   );
 *
 * @param userId  auth.uid() of the caller
 * @param route   one of the LimitedRoute values
 */
export async function enforceRateLimit(
  userId: string,
  route: LimitedRoute,
): Promise<RateLimitVerdict> {
  const limit = HOURLY_LIMITS[route];
  const retryAfterSeconds = secondsUntilNextHour();
  if (!userId) {
    // No user → can't track. Fail open; downstream auth will 401.
    return { allowed: true, count: 0, limit, retryAfterSeconds, failedOpen: true };
  }

  const bucket = currentBucketIso();
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.rpc("rpc_rate_limit_increment", {
      p_user_id: userId,
      p_route: route,
      p_bucket: bucket,
    });
    if (error) {
      // eslint-disable-next-line no-console
      console.warn("[rateLimitDb] RPC error, failing open:", error.message);
      return { allowed: true, count: 0, limit, retryAfterSeconds, failedOpen: true };
    }
    const count = typeof data === "number" ? data : Number(data) || 0;
    return {
      allowed: count <= limit,
      count,
      limit,
      retryAfterSeconds,
      failedOpen: false,
    };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      "[rateLimitDb] threw, failing open:",
      e instanceof Error ? e.message : e,
    );
    return { allowed: true, count: 0, limit, retryAfterSeconds, failedOpen: true };
  }
}

/**
 * Helper: read-only "how much quota do I have left this hour?" for a
 * future user-facing display. Does NOT increment.
 */
export async function peekRateLimit(
  userId: string,
  route: LimitedRoute,
): Promise<{ used: number; limit: number; retryAfterSeconds: number }> {
  const limit = HOURLY_LIMITS[route];
  const retryAfterSeconds = secondsUntilNextHour();
  if (!userId) return { used: 0, limit, retryAfterSeconds };
  try {
    const sb = supabaseAdmin();
    const { data } = await sb
      .from("rate_limit_counters")
      .select("count")
      .eq("user_id", userId)
      .eq("route", route)
      .eq("bucket_start", currentBucketIso())
      .maybeSingle();
    const used = (data as { count?: number } | null)?.count ?? 0;
    return { used, limit, retryAfterSeconds };
  } catch {
    return { used: 0, limit, retryAfterSeconds };
  }
}
