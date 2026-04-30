import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * /api/admin/plans
 *
 * GET  — list every plan + active subscriber counts.
 * POST — create a new draft plan (optionally cloning fields from an
 *        existing plan via `clone_from`).
 *
 * Auth: caller must be platform_admin.
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

export async function GET(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ("err" in auth) return auth.err;

    const admin = supabaseAdmin();
    const { data: plans, error } = await admin
      .from("plans")
      .select(
        "id, slug, tier, label, blurb, feature_summary, price_paise, currency, period_days, features, status, effective_from, effective_to, created_by, approved_by, created_at, updated_at, approved_at, pricing_model, per_student_price_paise, min_students, max_students"
      )
      .order("tier", { ascending: true })
      .order("status", { ascending: true })
      .order("effective_from", { ascending: false, nullsFirst: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const planIds = (plans || []).map((p) => p.id);
    const counts = new Map<string, number>();
    if (planIds.length > 0) {
      const { data: subs } = await admin
        .from("subscriptions")
        .select("plan_id")
        .in("plan_id", planIds)
        .eq("status", "active");
      for (const row of (subs as Array<{ plan_id: string | null }> | null) || []) {
        if (!row.plan_id) continue;
        counts.set(row.plan_id, (counts.get(row.plan_id) || 0) + 1);
      }
    }

    const rows = (plans || []).map((p) => ({
      ...p,
      active_subscriber_count: counts.get(p.id) || 0,
    }));

    return NextResponse.json({ ok: true, plans: rows });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "List failed" },
      { status: 500 }
    );
  }
}

/**
 * POST creates a draft. Body: { slug, tier, label, blurb?, price_paise?,
 * period_days?, features?, clone_from? }.
 *
 * If `clone_from` is provided, we copy fields from that plan (typically
 * the current 'active' version of the same slug) so editing pricing or
 * features doesn't require re-typing everything.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ("err" in auth) return auth.err;
    const body = await req.json().catch(() => ({}));

    const admin = supabaseAdmin();

    // Optional clone — used by the "Edit (creates new draft)" button on
    // /admin/plans/[id]. We copy presentational + pricing fields, but the
    // new row is always status='draft' and effective_from null.
    let base: Record<string, unknown> = {};
    if (typeof body.clone_from === "string") {
      const { data: src } = await admin
        .from("plans")
        .select("slug, tier, label, blurb, feature_summary, price_paise, currency, period_days, features, pricing_model, per_student_price_paise, min_students, max_students")
        .eq("id", body.clone_from)
        .maybeSingle();
      if (src) base = { ...src };
    }

    // Override / supply.
    const slug = String(body.slug ?? base.slug ?? "").trim();
    const tier = String(body.tier ?? base.tier ?? "").trim();
    if (!slug) return NextResponse.json({ error: "slug is required" }, { status: 400 });
    if (!tier) return NextResponse.json({ error: "tier is required" }, { status: 400 });

    const label = String(body.label ?? base.label ?? "").trim() || slug;
    const blurb = body.blurb !== undefined ? body.blurb : base.blurb ?? null;
    const feature_summary = Array.isArray(body.feature_summary)
      ? body.feature_summary
      : (Array.isArray(base.feature_summary) ? base.feature_summary : []);
    const price_paise = typeof body.price_paise === "number" ? body.price_paise
      : (typeof base.price_paise === "number" ? base.price_paise : 0);
    const currency = String(body.currency ?? base.currency ?? "INR").toUpperCase();
    const period_days = typeof body.period_days === "number" ? body.period_days
      : (typeof base.period_days === "number" ? base.period_days : 30);
    const features = Array.isArray(body.features) ? body.features
      : (Array.isArray(base.features) ? base.features : []);

    // Per-student pricing fields. Default new drafts to 'fixed' unless
    // we're cloning a per_student plan (then preserve), or unless the
    // tier starts with school_ AND no clone source AND nothing in body
    // (then auto-default to per_student so school plans don't accidentally
    // start in fixed mode).
    let pricing_model: string =
      body.pricing_model === "fixed" || body.pricing_model === "per_student"
        ? body.pricing_model
        : (typeof base.pricing_model === "string" ? base.pricing_model : "fixed");
    if (!body.clone_from && !body.pricing_model && tier.startsWith("school_")) {
      pricing_model = "per_student";
    }
    let per_student_price_paise =
      typeof body.per_student_price_paise === "number" ? body.per_student_price_paise
      : (typeof base.per_student_price_paise === "number" ? base.per_student_price_paise : 0);
    // The DB constraint plans_per_student_price_required forbids
    // pricing_model='per_student' with per_student_price_paise=0.
    // When auto-defaulting a fresh school draft into per_student mode,
    // the user hasn't set a price yet — seed a ₹1 placeholder so the
    // INSERT succeeds. They'll change it in the editor before submitting.
    if (pricing_model === "per_student" && per_student_price_paise <= 0) {
      per_student_price_paise = 100;
    }
    const min_students =
      typeof body.min_students === "number" ? body.min_students
      : (typeof base.min_students === "number" ? base.min_students : 0);
    const max_students =
      typeof body.max_students === "number" ? body.max_students
      : (body.max_students === null ? null
      : (base.max_students === null || typeof base.max_students === "number") ? (base.max_students as number | null)
      : null);

    const { data: inserted, error } = await admin
      .from("plans")
      .insert({
        slug, tier, label, blurb, feature_summary,
        price_paise, currency, period_days, features,
        pricing_model, per_student_price_paise, min_students, max_students,
        status: "draft",
        created_by: auth.user.id,
      })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await admin.from("plan_audit").insert({
      plan_id: inserted.id,
      actor_id: auth.user.id,
      action: "created",
      payload: { cloned_from: body.clone_from || null },
    });

    return NextResponse.json({ ok: true, plan: inserted });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Create failed" },
      { status: 500 }
    );
  }
}
