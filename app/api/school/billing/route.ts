import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";

/**
 * GET /api/school/billing  (D7 — school-side billing visibility)
 *
 * Returns the school's own subscription details so the super_teacher can
 * see what plan they're on, when it expires, what PO number we filed, and
 * the full archive of past invoices — without having to ping the platform
 * admin team for a status update.
 *
 * Auth: caller must be a super_teacher with a school_id set. We then read
 * via service role (subscriptions RLS doesn't grant super_teacher cross-
 * school read; the role check above is the gate).
 *
 * Read-only on purpose. Changing the plan / clearing an invoice / marking
 * paid all stay platform-admin operations — schools see the truth but
 * can't mutate it themselves.
 */
export async function GET(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const { data: prof } = await sb
      .from("profiles")
      .select("role, school_id")
      .eq("id", user.id)
      .maybeSingle();
    if (!prof || prof.role !== "super_teacher") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (!prof.school_id) {
      return NextResponse.json({ error: "No school linked to this account." }, { status: 404 });
    }
    const schoolId = prof.school_id as string;

    const admin = supabaseAdmin();

    const { data: school } = await admin
      .from("schools")
      .select("id, name, join_code, state, gstin")
      .eq("id", schoolId)
      .maybeSingle();
    if (!school) return NextResponse.json({ error: "School not found" }, { status: 404 });

    // Subscription — full read EXCEPT override_set_by/at and payment_recorded_by
    // (admin user uuids — leak nothing about which ZCORIQ staffer touched
    // the row). override_reason / override_reason_type are surfaced because
    // those are commercial information the school is entitled to see.
    type SubRow = {
      id: string;
      plan_id: string | null;
      tier: string | null;
      status: string | null;
      started_at: string | null;
      expires_at: string | null;
      override_price_paise: number | null;
      override_reason: string | null;
      override_reason_type: string | null;
      invoice_number: string | null;
      payment_method: string | null;
      payment_received_at: string | null;
      po_number: string | null;
      contracted_students: number | null;
      contract_years: number | null;
      activation_pending: boolean | null;
      grace_period_days: number | null;
      suspended_at: string | null;
      suspended_reason: string | null;
    };
    const { data: subRaw } = await admin
      .from("subscriptions")
      .select(
        "id, plan_id, tier, status, started_at, expires_at, " +
        "override_price_paise, override_reason, override_reason_type, " +
        "invoice_number, payment_method, payment_received_at, po_number, " +
        "contracted_students, contract_years, activation_pending, grace_period_days, " +
        "suspended_at, suspended_reason"
      )
      .eq("school_id", schoolId)
      .maybeSingle();
    const subscription = (subRaw as unknown as SubRow | null) ?? null;

    let plan: { id: string; slug: string | null; label: string | null; per_student_price_paise: number | null; period_days: number | null } | null = null;
    if (subscription?.plan_id) {
      const { data: p } = await admin
        .from("plans")
        .select("id, slug, label, per_student_price_paise, period_days")
        .eq("id", subscription.plan_id)
        .maybeSingle();
      plan = (p as typeof plan) ?? null;
    }

    // Past billing cycles. Same query the platform-admin per-school page
    // runs — we share the data for consistency.
    const { data: pastInvoices } = await admin
      .from("subscription_invoice_archive")
      .select(
        "id, invoice_number, contracted_students, override_price_paise, " +
        "payment_method, payment_received_at, cycle_started_at, cycle_expires_at, archived_at"
      )
      .eq("school_id", schoolId)
      .order("archived_at", { ascending: false })
      .limit(20);

    return NextResponse.json({
      ok: true,
      school,
      subscription,
      plan,
      past_invoices: pastInvoices ?? [],
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
