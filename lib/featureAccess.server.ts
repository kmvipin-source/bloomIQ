// Server-side feature gate. Mirror of useFeatureAccess() but for API
// routes — uses the service-role client to resolve a user's plan, then
// checks whether a feature key is included.
//
// Usage:
//   import { requireFeature } from "@/lib/featureAccess.server";
//   const gate = await requireFeature(userId, "cohort_benchmarks");
//   if (!gate.allowed) {
//     return NextResponse.json(
//       { error: gate.reason, code: "feature_locked", required_tier: gate.requiredTier },
//       { status: 403 }
//     );
//   }

import { supabaseAdmin } from "@/lib/supabase/server";

export type FeatureGateResult =
  | { allowed: true; tier: string; planSlug: string | null }
  | { allowed: false; reason: string; requiredTier: string | null };

/**
 * Resolve the active plan for `userId` (school plan if school-student,
 * personal otherwise), then check whether `featureKey` is in its
 * features[] list. Expired subscriptions are treated as Free (allowed=false
 * unless the requested feature is in the Free plan, which it normally
 * isn't for paid features).
 *
 * Returns a structured result the caller can serialize to a 403 body.
 * NEVER throws — feature checks should never become a 500.
 */
export async function requireFeature(
  userId: string,
  featureKey: string
): Promise<FeatureGateResult> {
  try {
    const sb = supabaseAdmin();

    // Step 1 — resolve the user's plan-binding scope.
    const { data: prof } = await sb
      .from("profiles")
      .select("is_school_student, school_id")
      .eq("id", userId)
      .maybeSingle();

    type Plan = { slug: string | null; tier: string | null; features: unknown; label: string | null };
    let plan: Plan | null = null;
    let expiresAt: string | null = null;

    // Track grace_period_days alongside expires_at so the server gate
    // matches the client useFeatureAccess hook — without this a school
    // in its grace window saw unlocked tiles client-side but got 403s
    // on every API call. The client + server now agree.
    let gracePeriodDays = 14;

    // School student → school's plan.
    if (prof?.is_school_student && prof.school_id) {
      const { data: schoolSub } = await sb
        .from("subscriptions")
        .select("plan_id, expires_at, status, grace_period_days")
        .eq("school_id", prof.school_id)
        .eq("status", "active")
        .maybeSingle();
      if (schoolSub?.plan_id) {
        const { data: p } = await sb
          .from("plans")
          .select("slug, tier, features, label")
          .eq("id", schoolSub.plan_id)
          .maybeSingle();
        if (p) {
          plan = p as Plan;
          expiresAt = (schoolSub as { expires_at?: string | null }).expires_at || null;
          const g = (schoolSub as { grace_period_days?: number | null }).grace_period_days;
          if (typeof g === "number" && g >= 0) gracePeriodDays = g;
        }
      }
    }

    // Otherwise (and as fallback for school students without an active
    // school plan) → personal subscription.
    if (!plan) {
      const { data: sub } = await sb
        .from("subscriptions")
        .select("plan_id, expires_at, status, grace_period_days")
        .eq("user_id", userId)
        .maybeSingle();
      if (sub?.plan_id) {
        const { data: p } = await sb
          .from("plans")
          .select("slug, tier, features, label")
          .eq("id", sub.plan_id)
          .maybeSingle();
        if (p) {
          plan = p as Plan;
          expiresAt = (sub as { expires_at?: string | null }).expires_at || null;
          const g = (sub as { grace_period_days?: number | null }).grace_period_days;
          if (typeof g === "number" && g >= 0) gracePeriodDays = g;
        }
      }
    }

    // Step 2 — is the subscription still in date, accounting for grace?
    if (expiresAt) {
      const expiresMs = Date.parse(expiresAt);
      const hardCutoffMs = expiresMs + gracePeriodDays * 24 * 60 * 60 * 1000;
      if (Number.isFinite(hardCutoffMs) && Date.now() > hardCutoffMs) {
        const required = await findCheapestUnlockingTier(featureKey);
        return {
          allowed: false,
          reason: "Your subscription has expired. Renew to access this feature.",
          requiredTier: required,
        };
      }
    }

    // Step 3 — feature membership.
    const features: string[] = Array.isArray(plan?.features) ? (plan!.features as string[]) : [];
    if (!plan || !features.includes(featureKey)) {
      const required = await findCheapestUnlockingTier(featureKey);
      return {
        allowed: false,
        reason: required
          ? `This feature requires ${required}.`
          : "This feature is not available on any current plan.",
        requiredTier: required,
      };
    }

    return {
      allowed: true,
      tier: plan.tier || "free",
      planSlug: plan.slug,
    };
  } catch (e) {
    // Fail closed: a broken gate must NOT silently leak the feature.
    return {
      allowed: false,
      reason: e instanceof Error ? e.message : "Feature gate unavailable",
      requiredTier: null,
    };
  }
}

/**
 * Helper: look across all plans for the cheapest one that includes
 * `featureKey`, return a friendly tier label ("Premium Plus", etc).
 * Used in the 403 response so the UI can show an upgrade CTA.
 */
async function findCheapestUnlockingTier(featureKey: string): Promise<string | null> {
  const sb = supabaseAdmin();
  const { data: plans } = await sb.from("plans").select("tier, label, features, price_paise");
  type Row = { tier: string; label: string; features: unknown; price_paise: number };
  const rows = (plans as Row[] | null) || [];
  let best: Row | null = null;
  for (const r of rows) {
    const arr = Array.isArray(r.features) ? (r.features as string[]) : [];
    if (!arr.includes(featureKey)) continue;
    if (best === null || r.price_paise < best.price_paise) best = r;
  }
  return best?.label || null;
}
