import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * /api/admin/plans/[id]
 *
 * Per migration 30, plans are edited IN PLACE. There is no draft/active
 * status, no review workflow, no version history. Saving immediately
 * affects:
 *   - new signups: see the new price + features at /pricing and /checkout
 *   - existing subscribers: see the new features (pulled live by
 *     useFeatureAccess); their PRICE stays locked at what they paid
 *     (subscriptions.price_paid_paise) until their term renews
 *
 * GET    — fetch one SKU by id.
 * PUT    — edit in place.
 * DELETE — remove an unused SKU. Refused if any subscription points at it.
 */

async function requireAdmin(req: Request) {
  const token = getBearer(req);
  if (!token) return { err: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const sb = supabaseServer(token);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { err: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  // Service-role read avoids the RLS race that 403'd legit platform
  // admins on the Vercel edge.
  const adminCli = supabaseAdmin();
  const { data: me } = await adminCli
    .from("profiles")
    .select("platform_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!me?.platform_admin) {
    return { err: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user };
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: RouteContext) {
  try {
    const auth = await requireAdmin(req);
    if ("err" in auth) return auth.err;
    void auth;
    const { id } = await ctx.params;

    const admin = supabaseAdmin();
    const { data: plan, error } = await admin
      .from("plans")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!plan) return NextResponse.json({ error: "Plan not found" }, { status: 404 });

    return NextResponse.json({ ok: true, plan });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Fetch failed" },
      { status: 500 }
    );
  }
}

/**
 * PUT — DEPRECATED in migration 43.
 *
 * Direct in-place edits no longer happen here. Every plan change is born
 * as a kind='edit' proposal at /api/admin/plan-proposals; on approval the
 * proposal is flattened into an UPDATE here by the approve route's
 * service-role client.
 *
 * Returns 410 Gone so any straggler client surfaces the change loudly.
 */
export async function PUT() {
  return NextResponse.json(
    {
      error:
        "Direct plan edits were removed in migration 43. Submit a proposal at POST /api/admin/plan-proposals with kind='edit' instead. The /admin/plans/[id]/edit UI handles this for you.",
    },
    { status: 410 }
  );
}

export async function DELETE(req: Request, ctx: RouteContext) {
  try {
    const auth = await requireAdmin(req);
    if ("err" in auth) return auth.err;
    void auth;
    const { id } = await ctx.params;

    const admin = supabaseAdmin();
    const { data: existing } = await admin
      .from("plans")
      .select("id, slug, label")
      .eq("id", id)
      .maybeSingle();
    if (!existing) return NextResponse.json({ error: "Plan not found" }, { status: 404 });

    // Refuse to delete a SKU that has live subscribers — would orphan
    // their plan_id and break feature lookups. Admin should retire the
    // SKU another way (e.g., raise the price absurdly so no one buys it,
    // or hide it from /pricing) until existing subs expire.
    const { count } = await admin
      .from("subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("plan_id", id);
    if ((count || 0) > 0) {
      return NextResponse.json(
        {
          error:
            `Cannot delete "${existing.label}" — ${count} active subscription(s) point at it. ` +
            `Hide it from /pricing or wait for those subs to expire first.`,
        },
        { status: 409 }
      );
    }

    const { error } = await admin.from("plans").delete().eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Delete failed" },
      { status: 500 }
    );
  }
}
