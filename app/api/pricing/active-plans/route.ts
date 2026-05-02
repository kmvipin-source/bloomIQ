import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/pricing/active-plans
 *
 * Public endpoint — no auth required. Returns every plan in the
 * catalogue, sorted by tier rank then price. Used by /pricing to render
 * the cards dynamically so any platform-admin price change shows up
 * immediately without a code redeploy.
 *
 * Post-migration-30 the plans table is a flat catalogue (one row per
 * SKU, no status workflow). The RLS policy "plans read public" exposes
 * every row publicly via the anon key. No service-role bypass needed.
 *
 * The endpoint name still says "active-plans" for backward compat with
 * already-deployed consumers; "active" now just means "in the catalogue".
 */

const TIER_ORDER: Record<string, number> = {
  free: 0,
  premium: 1,
  premium_plus: 2,
  school_pilot: 10,
  school_standard: 11,
  school_plus: 12,
};

export async function GET() {
  try {
    // Anon Supabase client — public RLS policy exposes every row.
    const sb = supabaseServer();
    const { data: plans, error } = await sb
      .from("plans")
      .select("id, slug, tier, label, blurb, feature_summary, price_paise, currency, period_days, features, pricing_model, per_student_price_paise, min_students, max_students");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const sorted = (plans || []).slice().sort((a, b) => {
      const ta = TIER_ORDER[a.tier] ?? 99;
      const tb = TIER_ORDER[b.tier] ?? 99;
      if (ta !== tb) return ta - tb;
      // Within a tier: monthly (period_days <= 31) before annual.
      return a.period_days - b.period_days;
    });

    return NextResponse.json(
      { ok: true, plans: sorted },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}

