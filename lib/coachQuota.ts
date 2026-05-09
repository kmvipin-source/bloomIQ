// Shared Coach quota gate. Both /api/teacher/coach and /api/school/coach
// call this helper before invoking the LLM. Centralising it keeps the
// tier mapping in one place and the surfaces in lockstep — bumping the
// Standard limit later means changing one number in this file.
//
// Usage:
//   import { checkCoachQuota } from "@/lib/coachQuota";
//   const gate = await checkCoachQuota(userId, "school"); // or "teacher"
//   if (!gate.allowed) {
//     return NextResponse.json(
//       { error: gate.reason, code: "coach_quota_exceeded", planSlug: gate.planSlug, used: gate.used, limit: gate.limit },
//       { status: 402 }
//     );
//   }
//   // ...invoke the LLM, then on success:
//   await logCoachCall(userId, "school");

import { supabaseAdmin } from "@/lib/supabase/server";

// Limits per plan slug. Numeric values are "questions per rolling 30 days".
// Infinity = unlimited; 0 = feature unavailable. The fallback (`*`) is the
// "we don't recognise this plan slug" case — treat as 0 to fail closed.
//
// School plans are the only ones with Coach access. Personal/independent
// plans (premium / premium_plus / free) currently have no Coach surface,
// so they don't appear here.
export const COACH_QUOTA_PER_MONTH: Record<string, number> = {
  school_pilot:    0,
  school_standard: 50,
  school_plus:     Infinity,
};

export type CoachSurface = "teacher" | "school";

export type QuotaResult =
  | { allowed: true;  planSlug: string | null; used: number; limit: number }
  | { allowed: false; reason: string; planSlug: string | null; used: number; limit: number };

/**
 * Resolve the user's plan and check whether they're under the monthly
 * Coach quota. Does NOT log the call — caller must invoke `logCoachCall`
 * after the LLM responds successfully (so failed LLM calls don't burn
 * the user's quota).
 *
 * Plan resolution logic mirrors lib/featureAccess.* — school members
 * inherit the school's active subscription; everything else falls back
 * to the user's personal subscription (which currently has no Coach
 * access, so falls through to the unknown-slug branch and is denied).
 */
export async function checkCoachQuota(
  userId: string,
  _surface: CoachSurface
): Promise<QuotaResult> {
  const sb = supabaseAdmin();

  // Step 1 — find the user's plan slug.
  const { data: prof } = await sb
    .from("profiles")
    .select("school_id, role")
    .eq("id", userId)
    .maybeSingle();

  let planSlug: string | null = null;

  // School members (any role: teacher, super_teacher, school student) →
  // inherit the school's active subscription.
  if (prof?.school_id) {
    const { data: schoolSub } = await sb
      .from("subscriptions")
      .select("plan_id, status, expires_at")
      .eq("school_id", prof.school_id)
      .eq("status", "active")
      .maybeSingle();
    if (schoolSub?.plan_id) {
      // Treat past-expiry as unsubscribed.
      const expiresAt = (schoolSub as { expires_at?: string | null }).expires_at;
      const expired = expiresAt && Date.parse(expiresAt) < Date.now();
      if (!expired) {
        const { data: plan } = await sb
          .from("plans")
          .select("slug")
          .eq("id", schoolSub.plan_id)
          .maybeSingle();
        planSlug = (plan as { slug: string | null } | null)?.slug ?? null;
      }
    }
  }

  // Step 2 — derive the limit from the plan.
  const limit = planSlug != null && planSlug in COACH_QUOTA_PER_MONTH
    ? COACH_QUOTA_PER_MONTH[planSlug]
    : 0;

  if (limit === 0) {
    return {
      allowed: false,
      reason: planSlug
        ? `Coach is not included in your school's ${planSlug.replace("_", " ")} plan. Ask your Admin Head to upgrade to School Standard or School Plus.`
        : "Coach requires an active school subscription. Ask your Admin Head to set one up.",
      planSlug,
      used: 0,
      limit: 0,
    };
  }

  // Step 3 — count usage in the last 30 days. Unlimited tiers skip
  // the count to save a DB hit.
  if (!Number.isFinite(limit)) {
    return { allowed: true, planSlug, used: 0, limit };
  }

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { count } = await sb
    .from("coach_usage")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("called_at", since);
  const used = count ?? 0;

  if (used >= limit) {
    return {
      allowed: false,
      reason: `You've used your ${limit} Coach questions for this month. Resets in 30 days, or ask your Admin Head about upgrading to School Plus for unlimited Coach.`,
      planSlug,
      used,
      limit,
    };
  }

  return { allowed: true, planSlug, used, limit };
}

/**
 * Log one Coach call. Called AFTER a successful LLM round-trip so
 * the user's quota isn't burned by transient failures. Best-effort —
 * if the insert fails (rare) we still let the user continue rather
 * than blocking on a logging error.
 */
export async function logCoachCall(userId: string, surface: CoachSurface): Promise<void> {
  try {
    const sb = supabaseAdmin();
    await sb.from("coach_usage").insert({ user_id: userId, surface });
  } catch {
    // Swallow: logging failure shouldn't break the user's session.
  }
}
