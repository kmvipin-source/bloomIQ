import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/admin/schools/[id]/set-plan
 *
 * Bind a school's subscription to a specific plan version.
 *
 * Body: { plan_id: string | null }
 *   - plan_id = uuid → upsert subscriptions row { school_id, plan_id, status='active' }
 *   - plan_id = null → set the school's existing subscription's plan_id to null
 *     (or delete the row if it has no plan_id and no other state worth keeping).
 *
 * Auth: caller must be a platform admin.
 *
 * Why a dedicated endpoint instead of letting the platform admin edit the
 * subscriptions row directly: school subscriptions involve grandfathering
 * (the row's plan_id is the bind point that survives future plan-version
 * changes), and the platform_admin should not also have to know the legacy
 * 'tier' text mapping. This endpoint maps tier from the plan and writes
 * both fields atomically.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: RouteContext) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { data: me } = await sb
      .from("profiles")
      .select("platform_admin")
      .eq("id", user.id)
      .single();
    if (!me?.platform_admin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id: schoolId } = await ctx.params;
    if (!schoolId) {
      return NextResponse.json({ error: "school id is required" }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const planId: string | null = body.plan_id ?? null;

    const admin = supabaseAdmin();

    // Verify the school exists; reject 404 cleanly rather than letting the
    // FK constraint surface as a Postgres error.
    const { data: school } = await admin
      .from("schools")
      .select("id, name")
      .eq("id", schoolId)
      .maybeSingle();
    if (!school) return NextResponse.json({ error: "School not found" }, { status: 404 });

    // If a plan was supplied, look it up to derive expires_at and the
    // legacy `tier` text the rest of the app understands.
    let plan: { id: string; tier: string; period_days: number } | null = null;
    if (planId) {
      const { data: p, error: pErr } = await admin
        .from("plans")
        .select("id, tier, period_days, status")
        .eq("id", planId)
        .maybeSingle();
      if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 });
      if (!p) return NextResponse.json({ error: "Plan not found" }, { status: 404 });
      if (p.status !== "active") {
        return NextResponse.json(
          { error: `Plan is ${p.status}; only active plans can be assigned to schools.` },
          { status: 409 }
        );
      }
      plan = p;
    }

    // Map plan tier → legacy subscriptions.tier text. School plans are all
    // treated as "premium" in the legacy column so existing tier-based
    // checks behave reasonably; plan_id is the authoritative source going
    // forward.
    const legacyTier =
      plan == null ? "free"
      : plan.tier === "school_plus" ? "premium_plus"
      : plan.tier.startsWith("school_") ? "premium"
      : plan.tier;

    const expiresAt = plan
      ? new Date(Date.now() + plan.period_days * 24 * 60 * 60 * 1000).toISOString()
      : null;

    // Find existing school subscription (RLS-bypassed via service role).
    const { data: existing } = await admin
      .from("subscriptions")
      .select("id")
      .eq("school_id", schoolId)
      .maybeSingle();

    if (existing?.id) {
      const { error: updErr } = await admin
        .from("subscriptions")
        .update({
          plan_id: plan?.id ?? null,
          tier: legacyTier,
          status: "active",
          started_at: new Date().toISOString(),
          expires_at: expiresAt,
          user_id: null,
        })
        .eq("id", existing.id);
      if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    } else {
      const { error: insErr } = await admin
        .from("subscriptions")
        .insert({
          school_id: schoolId,
          user_id: null,
          plan_id: plan?.id ?? null,
          tier: legacyTier,
          status: "active",
          started_at: new Date().toISOString(),
          expires_at: expiresAt,
        });
      if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      school_id: schoolId,
      plan_id: plan?.id ?? null,
      tier: legacyTier,
      expires_at: expiresAt,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Set plan failed" },
      { status: 500 }
    );
  }
}
