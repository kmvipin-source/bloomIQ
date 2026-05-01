import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * /api/admin/plans
 *
 * GET  — list every SKU in the catalogue + active subscriber counts.
 * POST — create a new SKU (rare; only for adding e.g. a new pricing tier).
 *
 * Per migration 30, the plans table is now a flat catalogue of stable
 * SKUs (Free, Premium Monthly/Annual, Premium Plus Monthly/Annual,
 * School Pilot/Standard/Plus). Edits happen IN PLACE via PUT — there is
 * no draft/submit/approve workflow, no version snapshots, no audit log.
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
        "id, slug, tier, label, blurb, feature_summary, price_paise, currency, period_days, features, created_at, updated_at, pricing_model, per_student_price_paise, min_students, max_students"
      )
      .order("tier", { ascending: true })
      .order("price_paise", { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Per-SKU active subscriber counts. Useful for the catalogue card so
    // the admin sees how much blast radius an edit has before they save.
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
 * POST — create a new SKU. Use sparingly: in the new model the catalogue
 * is meant to stay stable (the seeded 8 are all you usually need). This
 * endpoint exists for legitimately new product tiers (e.g., introducing
 * a Quarterly billing period later). Edits to existing SKUs go through
 * PUT, not a new POST.
 *
 * Body: { slug, tier, label, blurb?, feature_summary?, price_paise?,
 *   currency?, period_days?, features?, pricing_model?,
 *   per_student_price_paise?, min_students?, max_students? }
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ("err" in auth) return auth.err;
    void auth;
    const body = await req.json().catch(() => ({}));

    const admin = supabaseAdmin();

    const slug = String(body.slug ?? "").trim();
    const tier = String(body.tier ?? "").trim();
    if (!slug) return NextResponse.json({ error: "slug is required" }, { status: 400 });
    if (!tier) return NextResponse.json({ error: "tier is required" }, { status: 400 });

    const label = String(body.label ?? "").trim() || slug;
    const blurb = body.blurb ?? null;
    const feature_summary = Array.isArray(body.feature_summary) ? body.feature_summary : [];
    const price_paise = typeof body.price_paise === "number" ? body.price_paise : 0;
    const currency = String(body.currency ?? "INR").toUpperCase();
    const period_days = typeof body.period_days === "number" ? body.period_days : 30;
    const features = Array.isArray(body.features) ? body.features : [];

    // School plans default to per_student mode unless caller explicitly
    // sets otherwise. The DB constraint plans_per_student_price_required
    // forbids per_student with a 0 price, so we seed a ₹1 placeholder
    // for the admin to replace in the editor.
    let pricing_model: string =
      body.pricing_model === "fixed" || body.pricing_model === "per_student"
        ? body.pricing_model
        : (tier.startsWith("school_") ? "per_student" : "fixed");
    let per_student_price_paise =
      typeof body.per_student_price_paise === "number" ? body.per_student_price_paise : 0;
    if (pricing_model === "per_student" && per_student_price_paise <= 0) {
      per_student_price_paise = 100;
    }
    const min_students = typeof body.min_students === "number" ? body.min_students : 0;
    const max_students =
      typeof body.max_students === "number" ? body.max_students
      : (body.max_students === null ? null : null);

    const { data: inserted, error } = await admin
      .from("plans")
      .insert({
        slug, tier, label, blurb, feature_summary,
        price_paise, currency, period_days, features,
        pricing_model, per_student_price_paise, min_students, max_students,
      })
      .select()
      .single();
    if (error) {
      // Friendly error for the most common failure mode: duplicate slug.
      const msg = error.message.toLowerCase().includes("unique")
        ? `A plan with slug "${slug}" already exists. Edit it instead.`
        : error.message;
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    return NextResponse.json({ ok: true, plan: inserted });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Create failed" },
      { status: 500 }
    );
  }
}
