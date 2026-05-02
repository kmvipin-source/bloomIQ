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
 * POST — DEPRECATED in migration 43.
 *
 * Direct plan creation no longer happens here. Every new SKU is born as
 * a kind='create' proposal at /api/admin/plan-proposals; on approval the
 * proposal is flattened into an INSERT here by the approve route's
 * service-role client.
 *
 * Returns 410 Gone so any straggler client surfaces the change loudly.
 */
export async function POST() {
  return NextResponse.json(
    {
      error:
        "Direct plan creation was removed in migration 43. Submit a proposal at POST /api/admin/plan-proposals with kind='create' instead. The /admin/plans/new UI handles this for you.",
    },
    { status: 410 }
  );
}
