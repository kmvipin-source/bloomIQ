import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/admin/schools/[id]
 *
 * Returns school + active subscription details for the negotiated-price
 * admin UI. Goes through service role since `subscriptions` RLS doesn't
 * grant a platform_admin exception (intentional — service-role-only is
 * the canonical pattern for cross-school reads).
 */
export async function GET(req: Request, ctx: Ctx) {
  try {
    // F171 fix (QA): inline platform_admin check → shared helper.
    // F22 single-session iat enforcement comes along for free.
    const auth = await requirePlatformAdmin(req);
    if ("error" in auth) return auth.error;

    const { id } = await ctx.params;
    const admin = supabaseAdmin();

    const { data: school } = await admin
      .from("schools")
      // D12: also select state + gstin so the bill-to block and the
      // CGST/SGST-vs-IGST decision have the data they need without an
      // extra round-trip.
      .select("id, name, super_teacher_id, join_code, state, gstin")
      .eq("id", id)
      .maybeSingle();
    if (!school) return NextResponse.json({ error: "School not found" }, { status: 404 });

    type SubRow = {
      id: string;
      plan_id: string | null;
      tier: string | null;
      status: string | null;
      started_at: string | null;
      expires_at: string | null;
      override_price_paise: number | null;
      override_reason: string | null;
      override_reason_type: string | null;  // D18
      override_set_by: string | null;
      override_set_at: string | null;
      invoice_number: string | null;
      payment_method: string | null;
      payment_received_at: string | null;
      payment_recorded_at: string | null;   // D3
      payment_recorded_by: string | null;   // D3
      po_number: string | null;             // D11
      contracted_students: number | null;
      contract_years: number | null;        // D15
      activation_pending: boolean | null;
      grace_period_days: number | null;
      suspended_at: string | null;          // Migration 75
      suspended_by: string | null;
      suspended_reason: string | null;
    };
    const { data: subRaw } = await admin
      .from("subscriptions")
      .select(
        "id, plan_id, tier, status, started_at, expires_at, " +
        "override_price_paise, override_reason, override_reason_type, " +
        "override_set_by, override_set_at, " +
        "invoice_number, payment_method, payment_received_at, " +
        "payment_recorded_at, payment_recorded_by, po_number, " +
        "contracted_students, contract_years, " +
        "activation_pending, grace_period_days, " +
        "suspended_at, suspended_by, suspended_reason"
      )
      .eq("school_id", id)
      .maybeSingle();
    const subscription = (subRaw as unknown as SubRow | null) ?? null;

    let plan: { id: string; slug: string | null; label: string | null; per_student_price_paise: number | null; period_days: number | null } | null = null;
    if (subscription?.plan_id) {
      const { data: p } = await admin
        .from("plans")
        // period_days surfaces so the mark-paid preview dialog can
        // show the right "extends by N days" message instead of
        // hard-coding 365.
        .select("id, slug, label, per_student_price_paise, period_days")
        .eq("id", subscription.plan_id)
        .maybeSingle();
      plan = (p as typeof plan) ?? null;
    }

    const { count: studentCount } = await admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("school_id", id)
      .eq("role", "student");

    const { data: schoolPlans } = await admin
      .from("plans")
      .select("id, slug, label, per_student_price_paise")
      .like("slug", "school_%");

    // Past billing cycles (closed via "Start renewal cycle"). Most-recent
    // first. Fed straight into the per-school admin page so finance can
    // see every prior invoice number + payment record at a glance.
    const { data: pastInvoices } = await admin
      .from("subscription_invoice_archive")
      .select(
        "id, invoice_number, contracted_students, override_price_paise, " +
        "payment_method, payment_received_at, cycle_started_at, cycle_expires_at, archived_at"
      )
      .eq("school_id", id)
      .order("archived_at", { ascending: false })
      .limit(20);

    return NextResponse.json({
      ok: true,
      school,
      subscription,
      plan,
      student_count: studentCount ?? 0,
      school_plans: schoolPlans ?? [],
      past_invoices: pastInvoices ?? [],
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/schools/[id]
 *
 * Hard-deletes a school. FK cascade behaviour (set in schema):
 *   - profiles.school_id → SET NULL  (members keep their accounts; just unlinked)
 *   - classes.school_id  → CASCADE   (classes + class_members + class_teachers gone)
 *   - subscriptions.school_id → CASCADE (school sub row gone)
 *
 * Auth: platform_admin only.
 */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const { data: prof } = await sb
      .from("profiles")
      .select("platform_admin")
      .eq("id", user.id)
      .maybeSingle();
    if (!prof?.platform_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { id } = await ctx.params;
    if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

    const admin = supabaseAdmin();

    // Find the school's super_teacher(s) BEFORE the school row goes away
    // (FK on profiles.school_id is SET NULL, so after the cascade we'd
    // have no way to identify them). We delete those auth users too so
    // the platform admin can re-onboard the same email later — otherwise
    // /api/admin/onboard-school's "email already exists" guard rejects.
    const { data: heads } = await admin
      .from("profiles")
      .select("id, role, school_id")
      .eq("school_id", id)
      .eq("role", "super_teacher");

    const { error } = await admin.from("schools").delete().eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Delete the super_teacher auth users (their profile row was already
    // unlinked via SET NULL cascade; we now drop the auth account itself).
    // Best-effort: any failure here is logged but doesn't fail the school
    // delete, which already succeeded.
    for (const h of heads || []) {
      try {
        await admin.auth.admin.deleteUser(h.id);
      } catch (e) {
        console.error("[delete school] failed to remove super_teacher auth user", h.id, e);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
