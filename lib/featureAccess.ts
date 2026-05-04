/**
 * lib/featureAccess.ts
 *
 * Feature gating: who can use what, based on their active subscription's
 * plan and the feature keys that plan includes.
 *
 * Two surfaces:
 *   - `useFeatureAccess()` — a React hook for client components. Loads
 *     the current user's plan and exposes `allowed`, `planTier`, etc.
 *     The dashboard tiles use this to decide which to lock.
 *   - `requireFeature(userId, featureKey)` — a server helper meant to be
 *     called inside API routes that gate functionality. Throws / returns
 *     forbidden when the user's plan doesn't include the feature.
 *
 * KEY UX RULE (from 2026-04-30 strategy session):
 *   Free users SEE Premium + Premium Plus features but cannot USE them.
 *   Premium users SEE Premium Plus features but cannot USE them.
 *   Locked features render dimmed with a tier badge; clicking opens a
 *   paywall modal instead of navigating. This is value-disclosure: it
 *   makes upgrades feel like *unlocking* rather than *discovering*.
 */

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { PlanTier } from "@/lib/types";

export type FeatureAccessState = {
  // User's current plan tier. "anon" if not signed in, "free" if no
  // subscription row exists.
  planTier: PlanTier | "anon";
  planLabel: string;
  // Set of feature keys the current plan grants. Use as
  // `allowed.has(FEATURE_KEY)` for O(1) checks.
  allowed: Set<string>;
  isLoading: boolean;
  // Source of the plan binding — drives downstream UX (school students
  // can't self-upgrade, so paywall click messaging differs).
  source: "personal" | "school" | "none";
  // Subscription expiry — exposed so the RenewBanner can prompt the user
  // to renew before/after expiry. ISO timestamp. null when free / anon /
  // no expiry set.
  expiresAt: string | null;
  // Slug of the bound plan, used by RenewBanner to call /api/checkout
  // with the right plan_slug for the renewal payment.
  planSlug: string | null;
  // True when expires_at has passed. The hook treats expired
  // subscriptions as Free (empty allowed set), so locked tiles render
  // and the renew banner becomes the only path back to features.
  isExpired: boolean;
};

const EMPTY: FeatureAccessState = {
  planTier: "anon",
  planLabel: "Anonymous",
  allowed: new Set(),
  isLoading: true,
  source: "none",
  expiresAt: null,
  planSlug: null,
  isExpired: false,
};

/**
 * Resolves the tier hierarchy: free < premium < premium_plus.
 * Used to decide which tier UNLOCKS a feature, given that the feature
 * is in some plan's features array. The "minimum tier that has this
 * key" is the one we show on the lock badge.
 */
const TIER_RANK: Record<PlanTier, number> = {
  free: 0,
  premium: 1,
  premium_plus: 2,
  // School plans are orthogonal to individual upgrades; we treat them as
  // a separate axis. For the lock-badge logic on /student, we only care
  // about the individual ladder.
  school_pilot: 1,
  school_standard: 1,
  school_plus: 2,
};

export function tierRank(t: PlanTier): number {
  return TIER_RANK[t] ?? 0;
}

/** Pretty label for a tier — used in lock badges and the paywall modal. */
export function tierLabel(t: PlanTier | "anon"): string {
  switch (t) {
    case "anon":             return "Sign in";
    case "free":             return "Free";
    case "premium":          return "Premium";
    case "premium_plus":     return "Premium Plus";
    case "school_pilot":     return "School Pilot";
    case "school_standard":  return "School Standard";
    case "school_plus":      return "School Plus";
  }
}

/**
 * React hook for the dashboard. Loads on mount, returns once. Components
 * should treat `isLoading` as "render nothing locked yet" so the lock
 * badges don't flash on for a moment for paying users.
 */
export function useFeatureAccess(): FeatureAccessState {
  const [state, setState] = useState<FeatureAccessState>(EMPTY);

  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { setState({ ...EMPTY, isLoading: false }); return; }

      // Identity (is_school_student, school_id) via service-role
      // /api/auth/me — direct profiles reads raced RLS and made school
      // students show as "Free / Upgrade" in the sidebar even though
      // they were on the school's plan.
      const meRes = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      if (!meRes.ok) { setState({ ...EMPTY, isLoading: false }); return; }
      const me = await meRes.json() as {
        uid: string; is_school_student: boolean; school_id: string | null;
      };
      const user = { id: me.uid };
      const prof = { is_school_student: me.is_school_student, school_id: me.school_id };

      let planRow: { tier: string | null; label: string | null; features: unknown; slug: string | null } | null = null;
      let expiresAtRaw: string | null = null;
      let source: "personal" | "school" | "none" = "none";

      if (prof?.is_school_student && prof.school_id) {
        // School student — read the school's active subscription.
        const { data: schoolSub } = await sb
          .from("subscriptions")
          .select("plan_id, status, expires_at")
          .eq("school_id", prof.school_id)
          .eq("status", "active")
          .maybeSingle();
        if (schoolSub?.plan_id) {
          const { data: plan } = await sb
            .from("plans")
            .select("slug, tier, label, features")
            .eq("id", schoolSub.plan_id)
            .maybeSingle();
          if (plan) {
            planRow = plan;
            source = "school";
            expiresAtRaw = (schoolSub as { expires_at?: string | null }).expires_at || null;
          }
        }
      }

      // Fall through if no school plan resolved (independent students,
      // teachers, super_teachers, platform admins, OR school students
      // whose school doesn't have an active subscription yet).
      if (!planRow) {
        const { data: sub } = await sb
          .from("subscriptions")
          .select("plan_id, status, expires_at")
          .eq("user_id", user.id)
          .maybeSingle();
        if (sub?.plan_id) {
          const { data: plan } = await sb
            .from("plans")
            .select("slug, tier, label, features")
            .eq("id", sub.plan_id)
            .maybeSingle();
          if (plan) {
            planRow = plan;
            source = "personal";
            expiresAtRaw = (sub as { expires_at?: string | null }).expires_at || null;
          }
        }
      }

      if (!planRow) {
        // No subscription anywhere → treat as Free.
        setState({
          planTier: "free",
          planLabel: "Free",
          allowed: new Set(),
          isLoading: false,
          source: "none",
          expiresAt: null,
          planSlug: null,
          isExpired: false,
        });
        return;
      }

      // ---------- Expiry enforcement ----------
      // The DB stores expires_at on every paid subscription. If it's in
      // the past, treat the user as Free regardless of plan tier — locked
      // tiles render and the renew banner becomes the only path back to
      // their features. This is the single most important fix for the
      // "buy-once stay-forever" hole that existed before Path A.
      const now = Date.now();
      const expiresAtMs = expiresAtRaw ? Date.parse(expiresAtRaw) : null;
      const isExpired = expiresAtMs !== null && expiresAtMs < now;

      const tier = (planRow.tier as PlanTier | undefined) || "free";
      const features: string[] = Array.isArray(planRow.features)
        ? (planRow.features as string[])
        : [];

      setState({
        planTier: isExpired ? "free" : tier,
        planLabel: isExpired ? "Free (expired)" : (planRow.label || tierLabel(tier)),
        allowed: isExpired ? new Set() : new Set(features),
        isLoading: false,
        source,
        expiresAt: expiresAtRaw,
        planSlug: planRow.slug || null,
        isExpired,
      });
    })();
  }, []);

  return state;
}

/**
 * Look across all known active plans to find the cheapest one that
 * includes a given feature key. Returns the tier label suitable for a
 * lock badge ("Premium", "Premium Plus", etc) plus the slug for the
 * upgrade CTA. Returns null if no active plan includes the key.
 *
 * This is async because we read from the plans table, but the data is
 * tiny and stable — caller should cache the result for the session.
 */
export async function findUnlockingTier(
  featureKey: string,
  ladder?: "personal" | "school",
): Promise<
  { tier: PlanTier; label: string; rank: number } | null
> {
  const sb = supabaseBrowser();
  // Post-migration-30 the plans table is a flat catalogue (one row per
  // SKU, no status workflow). Read all rows.
  const { data: plans } = await sb
    .from("plans")
    .select("tier, label, features");
  type Row = { tier: PlanTier; label: string; features: unknown };
  const rows = (plans as Row[] | null) || [];
  let best: { tier: PlanTier; label: string; rank: number } | null = null;
  for (const r of rows) {
    // Ladder filter: an independent student should never see "School
    // Pilot" on a lock badge because it's irrelevant to them — they
    // can only upgrade through the personal ladder (Free / Premium /
    // Premium Plus). Same in reverse for a school user — surfacing
    // "Premium" would be confusing because their plan is set by the
    // school admin against the school ladder. Both ladders share
    // rank values (school_pilot and premium are both rank 1), so
    // without this filter whichever row came back from PostgREST
    // first won, which was non-deterministic.
    const isSchoolTier = r.tier.startsWith("school_");
    if (ladder === "personal" && isSchoolTier) continue;
    if (ladder === "school" && !isSchoolTier) continue;
    const arr = Array.isArray(r.features) ? (r.features as string[]) : [];
    if (!arr.includes(featureKey)) continue;
    const rank = tierRank(r.tier);
    if (best === null || rank < best.rank) {
      best = { tier: r.tier, label: tierLabel(r.tier), rank };
    }
  }
  return best;
}
