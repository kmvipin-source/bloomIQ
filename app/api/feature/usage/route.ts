import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";

// =============================================================================
// GET /api/feature/usage
// -----------------------------------------------------------------------------
// Returns the caller's current Free-tier usage state:
//   {
//     ok: true,
//     tier: 'free' | 'premium' | 'premium_plus' | ...,
//     limits: { ...subscription_limits row... },
//     daily: { tutor_chat: { cap, used, remaining }, ... },
//     lifetime: { xray: { cap, used, exhausted }, ... }
//   }
//
// Used by the dashboard tile grid + each feature page to render
// "you have N uses left today" and "you've used your one free X".
// Paid users see all caps as null = uncapped.
// =============================================================================

import {
  DAILY_SURFACES,
  LIFETIME_FEATURES,
  dailySurfaceColumn,
  lifetimeFeatureColumn,
} from "@/lib/freeQuota";

function dayKeyForTimezone(tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

export async function GET(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const admin = supabaseAdmin();

    // Resolve tier.
    const { data: sub } = await admin
      .from("subscriptions")
      .select("tier, status, expires_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    let tier = (sub?.tier as string | null) || "free";
    if (sub?.status && sub.status !== "active") tier = "free";
    if (sub?.expires_at && new Date(sub.expires_at as string) < new Date()) tier = "free";

    // Read limits.
    const { data: limits } = await admin
      .from("subscription_limits")
      .select("*")
      .eq("id", 1)
      .single();

    const limitsRow = (limits as Record<string, unknown>) || {};
    const tz = String(limitsRow.daily_reset_timezone ?? "Asia/Kolkata");

    // Daily usage rows for today.
    const day = dayKeyForTimezone(tz);
    const { data: dailyRows } = await admin
      .from("daily_ai_usage")
      .select("surface, count")
      .eq("user_id", user.id)
      .eq("day_key", day);
    const dailyMap = new Map<string, number>(
      ((dailyRows || []) as Array<{ surface: string; count: number }>)
        .map((r) => [r.surface, Number(r.count) || 0])
    );

    // Lifetime usage rows.
    const { data: lifeRows } = await admin
      .from("lifetime_feature_usage")
      .select("feature_key, count")
      .eq("user_id", user.id);
    const lifeMap = new Map<string, number>(
      ((lifeRows || []) as Array<{ feature_key: string; count: number }>)
        .map((r) => [r.feature_key, Number(r.count) || 0])
    );

    const isFree = tier === "free";

    const daily: Record<string, { cap: number | null; used: number; remaining: number | null }> = {};
    for (const surface of DAILY_SURFACES) {
      const cap = isFree ? Number(limitsRow[dailySurfaceColumn(surface)] ?? 0) : null;
      const used = dailyMap.get(surface) || 0;
      daily[surface] = {
        cap,
        used,
        remaining: cap === null ? null : Math.max(0, cap - used),
      };
    }

    const lifetime: Record<string, { cap: number | null; used: number; exhausted: boolean }> = {};
    for (const feature of LIFETIME_FEATURES) {
      const cap = isFree ? Number(limitsRow[lifetimeFeatureColumn(feature)] ?? 0) : null;
      const used = lifeMap.get(feature) || 0;
      lifetime[feature] = {
        cap,
        used,
        exhausted: cap !== null && used >= cap,
      };
    }

    return NextResponse.json({
      ok: true,
      tier,
      reset_timezone: tz,
      daily,
      lifetime,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to load usage" },
      { status: 500 }
    );
  }
}
