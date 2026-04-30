import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * /api/admin/plans/[id]
 *
 * GET    — fetch one plan + its audit log.
 * PUT    — update a plan. Only allowed when status='draft'. Active and
 *          pending_review plans are immutable; you create a new draft to
 *          change them, then go through the review workflow.
 * DELETE — delete a draft. Active and archived rows cannot be deleted
 *          (they're history; archive an active by promoting a successor).
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
    const { id } = await ctx.params;

    const admin = supabaseAdmin();
    const { data: plan, error } = await admin
      .from("plans")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!plan) return NextResponse.json({ error: "Plan not found" }, { status: 404 });

    const { data: audit } = await admin
      .from("plan_audit")
      .select("*")
      .eq("plan_id", id)
      .order("created_at", { ascending: false })
      .limit(50);

    return NextResponse.json({ ok: true, plan, audit: audit || [] });
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
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));

    const admin = supabaseAdmin();
    const { data: existing } = await admin
      .from("plans")
      .select("status, created_by")
      .eq("id", id)
      .maybeSingle();
    if (!existing) return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    if (existing.status !== "draft") {
      return NextResponse.json(
        { error: `Only draft plans can be edited (this one is ${existing.status}). Create a new draft instead.` },
        { status: 409 }
      );
    }

    // Whitelist editable fields. Slug/tier/status changes are NOT editable
    // through here on purpose — they're set on creation, and status changes
    // go through the dedicated workflow endpoints (submit/approve/reject).
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof body.label === "string") updates.label = body.label.trim();
    if (typeof body.blurb === "string" || body.blurb === null) updates.blurb = body.blurb;
    if (Array.isArray(body.feature_summary)) updates.feature_summary = body.feature_summary;
    if (typeof body.price_paise === "number" && body.price_paise >= 0) updates.price_paise = body.price_paise;
    if (typeof body.currency === "string") updates.currency = body.currency.toUpperCase();
    if (typeof body.period_days === "number" && body.period_days >= 0) updates.period_days = body.period_days;
    if (Array.isArray(body.features)) updates.features = body.features;
    if (typeof body.effective_from === "string" || body.effective_from === null) updates.effective_from = body.effective_from;
    // Per-student pricing fields (migration 27). The editor only exposes
    // these when tier starts with school_*, but the server accepts them
    // for any tier — the DB constraint enforces consistency.
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

    await admin.from("plan_audit").insert({
      plan_id: id,
      actor_id: auth.user.id,
      action: "edited",
      payload: { fields: Object.keys(updates) },
    });

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
    const { id } = await ctx.params;

    const admin = supabaseAdmin();
    const { data: existing } = await admin
      .from("plans")
      .select("status")
      .eq("id", id)
      .maybeSingle();
    if (!existing) return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    if (existing.status !== "draft") {
      return NextResponse.json(
        { error: `Only draft plans can be deleted (this one is ${existing.status}).` },
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
