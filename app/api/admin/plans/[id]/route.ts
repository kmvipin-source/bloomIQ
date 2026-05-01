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
  const { data: me } = await sb
    .from("profiles")
    .select("platform_admin")
    .eq("id", user.id)
    .single();
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

export async function PUT(req: Request, ctx: RouteContext) {
  try {
    const auth = await requireAdmin(req);
    if ("err" in auth) return auth.err;
    void auth;
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));

    const admin = supabaseAdmin();
    const { data: existing } = await admin
      .from("plans")
      .select("id, slug, label")
      .eq("id", id)
      .maybeSingle();
    if (!existing) return NextResponse.json({ error: "Plan not found" }, { status: 404 });

    // Whitelist editable fields. slug + tier are immutable — they're the
    // SKU identity. Everything else is freely editable in place.
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof body.label === "string") updates.label = body.label.trim();
    if (typeof body.blurb === "string" || body.blurb === null) updates.blurb = body.blurb;
    if (Array.isArray(body.feature_summary)) updates.feature_summary = body.feature_summary;
    if (typeof body.price_paise === "number" && body.price_paise >= 0) updates.price_paise = body.price_paise;
    if (typeof body.currency === "string") updates.currency = body.currency.toUpperCase();
    if (typeof body.period_days === "number" && body.period_days >= 0) updates.period_days = body.period_days;
    if (Array.isArray(body.features)) updates.features = body.features;
    if (body.pricing_model === "fixed" || body.pricing_model === "per_student") {
      updates.pricing_model = body.pricing_model;
    }
    if (typeof body.per_student_price_paise === "number" && body.per_student_price_paise >= 0) {
      updates.per_student_price_paise = body.per_student_price_paise;
    }
    if (typeof body.min_students === "number" && body.min_students >= 0) {
      updates.min_students = body.min_students;
    }
    if (typeof body.max_students === "number" && body.max_students > 0) {
      updates.max_students = body.max_students;
    } else if (body.max_students === null) {
      updates.max_students = null;
    }

    const { error: updErr, data: updated } = await admin
      .from("plans")
      .update(updates)
      .eq("id", id)
      .select()
      .single();
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, plan: updated });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Update failed" },
      { status: 500 }
    );
  }
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
