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
    // Negotiated-price override (post-migration-62). All optional —
    // a self-serve flow leaves them null and the formula applies.
    const overridePriceRupees: number | null =
      typeof body.override_price_rupees === "number" && body.override_price_rupees > 0
        ? Math.round(body.override_price_rupees)
        : null;
    const overrideReason: string | null =
      typeof body.override_reason === "string" && body.override_reason.trim()
        ? body.override_reason.trim().slice(0, 500)
        : null;
    const invoiceNumber: string | null =
      typeof body.invoice_number === "string" && body.invoice_number.trim()
        ? body.invoice_number.trim().slice(0, 60)
        : null;
    const paymentMethod: string | null =
      ["razorpay", "neft", "cheque", "manual"].includes(body.payment_method)
        ? body.payment_method
        : null;
    // Contracted students — the seat count the school agreed to in
    // the contract (separate from how many have actually signed in).
    // null = "use actual student count when computing list price".
    const contractedStudents: number | null =
      typeof body.contracted_students === "number" && body.contracted_students > 0
        ? Math.round(body.contracted_students)
        : null;

    // ─────────── Modern-app expiry controls (post-migration-65) ───────────
    // Three knobs the platform admin gets to set when binding/renewing:
    //
    //   • startedAtIso (body.started_at)
    //       Explicit activation date as ISO string. Use case: school
    //       signs B2B contract in March but academic year starts 1 June
    //       → admin sets started_at=2026-06-01, expires_at is computed
    //       as 2026-06-01 + period_days. If omitted, defaults to now()
    //       (or preserves existing expiry — see "mid-cycle" logic below).
    //
    //   • activationPending (body.activation_pending)
    //       When true, started_at + expires_at are written as placeholders
    //       (now / now+period) and a flag is set so the FIRST sign-in by
    //       the school's super_teacher bumps started_at to the actual
    //       sign-in moment. Solves: school onboarded 1 Aug, admin first
    //       signs in 5 Aug → without this they'd lose 4 days.
    //
    //   • gracePeriodDays (body.grace_period_days)
    //       How many days past expires_at the school still has full
    //       feature access (renew banner turns red but features keep
    //       working). Default 14, can be 0 for hard cutoff.
    const startedAtIso: string | null =
      typeof body.started_at === "string" && !Number.isNaN(Date.parse(body.started_at))
        ? new Date(body.started_at).toISOString()
        : null;
    const activationPending: boolean = body.activation_pending === true;
    const gracePeriodDays: number | null =
      typeof body.grace_period_days === "number" && body.grace_period_days >= 0
        ? Math.round(body.grace_period_days)
        : null;

    // D11 — School-issued purchase-order reference for this cycle.
    // Free-text, capped at 120 chars so somebody can't paste a novel.
    const poNumber: string | null =
      typeof body.po_number === "string" && body.po_number.trim()
        ? body.po_number.trim().slice(0, 120)
        : null;

    // D15 — Multi-year contract tracking. 1..10 keeps obviously-bad inputs
    // out; the DB also has a CHECK constraint with the same bounds.
    const contractYears: number | null =
      typeof body.contract_years === "number" && body.contract_years >= 1 && body.contract_years <= 10
        ? Math.round(body.contract_years)
        : null;

    // D18 — Structured override reason category. The free-text reason
    // continues to live in override_reason; this column lets finance group
    // deals consistently across schools.
    const ALLOWED_OVERRIDE_REASON_TYPES = [
      "multi_year_deal",
      "volume_discount",
      "partner_discount",
      "pilot_program",
      "goodwill",
      "corrective",
      "other",
    ] as const;
    const overrideReasonType: string | null =
      typeof body.override_reason_type === "string"
        && (ALLOWED_OVERRIDE_REASON_TYPES as readonly string[]).includes(body.override_reason_type)
        ? body.override_reason_type
        : null;

    // D12 — Schools row updates (state + GSTIN). These live on schools,
    // not subscriptions, so they get a separate write below. Accept null
    // explicitly so admin can clear a wrong value.
    const schoolStateProvided = Object.prototype.hasOwnProperty.call(body, "school_state");
    const schoolState: string | null =
      schoolStateProvided
        ? (typeof body.school_state === "string" && body.school_state.trim()
            ? body.school_state.trim().slice(0, 80)
            : null)
        : null;
    const schoolGstinProvided = Object.prototype.hasOwnProperty.call(body, "school_gstin");
    const schoolGstin: string | null =
      schoolGstinProvided
        ? (typeof body.school_gstin === "string" && body.school_gstin.trim()
            // Uppercase + strip whitespace — GSTINs are uppercase by spec.
            ? body.school_gstin.trim().toUpperCase().slice(0, 15)
            : null)
        : null;

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
    // legacy `tier` text the rest of the app understands. Post-migration-30
    // there's no status column — every plan in the table is sellable.
    let plan: { id: string; tier: string; period_days: number; grace_period_days: number | null } | null = null;
    if (planId) {
      const { data: p, error: pErr } = await admin
        .from("plans")
        .select("id, tier, period_days, grace_period_days")
        .eq("id", planId)
        .maybeSingle();
      if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 });
      if (!p) return NextResponse.json({ error: "Plan not found" }, { status: 404 });
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

    // Find existing school subscription FIRST (needed below to decide
    // whether this is a brand-new bind, a mid-cycle plan change, or an
    // explicit renewal). Cast through unknown because the auto-generated
    // Supabase types don't yet know about the new columns until the user
    // applies migrations 62/63/64/65.
    type ExistingSubRow = {
      id: string;
      plan_id: string | null;
      invoice_number: string | null;
      contracted_students: number | null;
      override_price_paise: number | null;
      override_reason: string | null;
      payment_method: string | null;
      payment_received_at: string | null;
      started_at: string | null;
      expires_at: string | null;
    };
    const { data: existingRaw } = await admin
      .from("subscriptions")
      .select(
        "id, plan_id, invoice_number, contracted_students, override_price_paise, override_reason, " +
        "payment_method, payment_received_at, started_at, expires_at"
      )
      .eq("school_id", schoolId)
      .maybeSingle();
    const existing = (existingRaw as unknown as ExistingSubRow | null) ?? null;

    // ─────────── started_at / expires_at decision tree ───────────
    // The right answer depends on intent. We support four distinct cases,
    // not just "set both to now+period". Each case is described in a
    // comment so the next person reading this doesn't have to reverse-
    // engineer it from the math:
    //
    //   (A) start_renewal: true
    //       The previous cycle was archived above. This is a fresh year.
    //       started_at = now (or body.started_at if given, e.g. for a
    //       deferred academic-year start), expires_at = started_at + period.
    //
    //   (B) Brand-new bind (no existing row OR existing row had no plan)
    //       started_at = now (or body.started_at), expires_at = started_at
    //       + period. This is the "school just paid for the first time"
    //       path. activation_pending=true means use placeholders that
    //       first-sign-in will overwrite.
    //
    //   (C) Mid-cycle plan change (existing row has plan + expires_at,
    //       and caller did NOT pass start_renewal). They're upgrading
    //       Pilot → Plus or correcting a tier mistake. PRESERVE
    //       existing.started_at + existing.expires_at — they paid for a
    //       year and shouldn't lose 9 months of it just because the plan
    //       picker changed.
    //
    //   (D) Plan removed (planId is null). Free the row of dates.
    let writeStartedAt: string | null = null;
    let writeExpiresAt: string | null = null;
    if (!plan) {
      // Case D — no plan now. Null out dates so /school sees "Not subscribed".
      writeStartedAt = null;
      writeExpiresAt = null;
    } else {
      const isRenewal     = body.start_renewal === true;
      const isMidCycle    =
        !isRenewal &&
        existing?.expires_at &&
        existing?.plan_id; // had a plan, has an expiry, just changing the plan_id
      if (isMidCycle && !startedAtIso) {
        // Case C — preserve cycle anchors.
        writeStartedAt = existing!.started_at ?? new Date().toISOString();
        writeExpiresAt = existing!.expires_at!;
      } else if (isRenewal && existing?.expires_at && !startedAtIso) {
        // Case A — renewal cycle. Vipin asked for early-renewal to NOT
        // throw away the school's unused days from the closing cycle.
        // Math: new term anchors on max(today, old expires_at), then adds
        // a full period_days. So a school whose old cycle still has 60
        // days left, paying for a renewal today, gets:
        //
        //   anchor = today + 60        (old expires_at, since it's future)
        //   new_expires_at = anchor + 365 = today + 425
        //
        // Effectively those 60 days are appended to the end of the new
        // cycle. The new started_at is "today" — that's the date the
        // renewal action happened (used for invoicing, audit, and
        // distinguishes "year N" from "year N+1" on the dashboard).
        const oldExpiresMs = Date.parse(existing.expires_at);
        const nowMs = Date.now();
        const anchorMs = Number.isFinite(oldExpiresMs) && oldExpiresMs > nowMs
          ? oldExpiresMs
          : nowMs;
        writeStartedAt = new Date(nowMs).toISOString();
        writeExpiresAt = new Date(anchorMs + plan.period_days * 24 * 60 * 60 * 1000).toISOString();
      } else {
        // Cases A (no prior expiry) + B — fresh period. Honour explicit
        // started_at when given, otherwise anchor to now().
        // activation_pending uses now() as a placeholder; first sign-in
        // will overwrite it.
        const anchor = startedAtIso ? Date.parse(startedAtIso) : Date.now();
        writeStartedAt = new Date(anchor).toISOString();
        writeExpiresAt = new Date(anchor + plan.period_days * 24 * 60 * 60 * 1000).toISOString();
      }
    }
    // Legacy alias for the response field below.
    const expiresAt = writeExpiresAt;

    // Build the override block. Only set the audit fields when the
    // override is actually being changed in this request — bumping the
    // plan should not reset the override timestamps.
    const overrideUpdate: Record<string, unknown> = {};
    if (overridePriceRupees != null) {
      overrideUpdate.override_price_paise = overridePriceRupees * 100;
      overrideUpdate.override_reason      = overrideReason;
      overrideUpdate.override_set_by      = user.id;
      overrideUpdate.override_set_at      = new Date().toISOString();
    } else if (body.clear_override === true) {
      // Explicit clear (admin removing a previously-negotiated price).
      overrideUpdate.override_price_paise = null;
      overrideUpdate.override_reason      = null;
      overrideUpdate.override_set_by      = null;
      overrideUpdate.override_set_at      = null;
    }
    if (invoiceNumber != null) overrideUpdate.invoice_number = invoiceNumber;
    if (paymentMethod != null) overrideUpdate.payment_method = paymentMethod;
    if (contractedStudents != null) overrideUpdate.contracted_students = contractedStudents;
    if (body.clear_contracted_students === true) overrideUpdate.contracted_students = null;
    // Modern-expiry knobs flow through the same overrideUpdate so they
    // get written atomically with the plan change.
    // D10: per-call > per-plan > global default (14). The DB column has a
    // default of 14; we set it explicitly when caller passes a value OR when
    // the bound plan declares one. This means changing a plan's default
    // propagates to NEW subscriptions on that plan, but doesn't retroactively
    // override existing rows that were explicitly set.
    if (gracePeriodDays != null) {
      overrideUpdate.grace_period_days = gracePeriodDays;
    } else if (plan && typeof plan.grace_period_days === "number") {
      overrideUpdate.grace_period_days = plan.grace_period_days;
    }
    overrideUpdate.activation_pending = activationPending;

    // D11/D15/D18 — write the new finance fields only when the caller
    // actually supplied them, so a routine plan-change doesn't blank out
    // the PO number / contract length / reason category.
    if (poNumber !== null) overrideUpdate.po_number = poNumber;
    if (body.clear_po_number === true) overrideUpdate.po_number = null;
    if (contractYears !== null) overrideUpdate.contract_years = contractYears;
    if (body.clear_contract_years === true) overrideUpdate.contract_years = null;
    if (overrideReasonType !== null) overrideUpdate.override_reason_type = overrideReasonType;
    if (body.clear_override === true) overrideUpdate.override_reason_type = null;

    // ── Renewal: archive the closing cycle, then clear cycle fields. ──
    // Triggered by `start_renewal: true` from the per-school admin page.
    // Archive snapshot captures the cycle just ending (invoice number,
    // contracted seats, override price, payment record, expiry). Then we
    // null invoice_number + payment_received_at on the live row so the
    // next invoice generation creates a fresh BLM/YYYY/NNNN number and
    // the mark-paid button reads "Mark payment received" again instead
    // of "Re-record". Required for GST-compliant year-on-year billing.
    if (body.start_renewal === true && existing?.id) {
      const { error: archiveErr } = await admin
        .from("subscription_invoice_archive")
        .insert({
          subscription_id: existing.id,
          school_id: schoolId,
          plan_id: existing.plan_id,
          invoice_number: existing.invoice_number,
          contracted_students: existing.contracted_students,
          override_price_paise: existing.override_price_paise,
          override_reason: existing.override_reason,
          payment_method: existing.payment_method,
          payment_received_at: existing.payment_received_at,
          cycle_started_at: existing.started_at,
          cycle_expires_at: existing.expires_at,
          archived_by: user.id,
        });
      if (archiveErr) {
        return NextResponse.json(
          { error: `Could not archive previous cycle: ${archiveErr.message}` },
          { status: 500 }
        );
      }
      overrideUpdate.invoice_number      = null;
      overrideUpdate.payment_received_at = null;
    }

    let subscriptionId: string;
    if (existing?.id) {
      subscriptionId = existing.id;
      const { error: updErr } = await admin
        .from("subscriptions")
        .update({
          plan_id: plan?.id ?? null,
          tier: legacyTier,
          status: "active",
          started_at: writeStartedAt,
          expires_at: writeExpiresAt,
          user_id: null,
          ...overrideUpdate,
        })
        .eq("id", existing.id);
      if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    } else {
      const { data: inserted, error: insErr } = await admin
        .from("subscriptions")
        .insert({
          school_id: schoolId,
          user_id: null,
          plan_id: plan?.id ?? null,
          tier: legacyTier,
          status: "active",
          started_at: writeStartedAt,
          expires_at: writeExpiresAt,
          ...overrideUpdate,
        })
        .select("id")
        .single();
      if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
      subscriptionId = (inserted as { id: string }).id;
    }

    // D12 — Schools row update (state + GSTIN). Done as a separate write
    // so a malformed GSTIN doesn't block the subscription save (the check
    // constraint on schools.gstin will reject it). We only touch fields the
    // caller explicitly included, so a routine plan-change doesn't blank
    // out the school's tax registration.
    if (schoolStateProvided || schoolGstinProvided) {
      const schoolUpdate: Record<string, unknown> = {};
      if (schoolStateProvided) schoolUpdate.state = schoolState;
      if (schoolGstinProvided) schoolUpdate.gstin = schoolGstin;
      const { error: schoolErr } = await admin
        .from("schools")
        .update(schoolUpdate)
        .eq("id", schoolId);
      if (schoolErr) {
        // GSTIN format check is the most likely failure here — return a
        // legible error so the admin can fix the typo.
        return NextResponse.json(
          { error: `Subscription saved, but school details rejected: ${schoolErr.message}` },
          { status: 400 }
        );
      }
    }

    // Echo subscription_id + override snapshot in the response so callers
    // can chain immediately into invoice generation / mark-paid without
    // a follow-up query.
    const { data: written } = await admin
      .from("subscriptions")
      .select("override_price_paise, override_reason, invoice_number, payment_method, payment_received_at, contracted_students")
      .eq("id", subscriptionId)
      .maybeSingle();

    return NextResponse.json({
      ok: true,
      school_id: schoolId,
      subscription_id: subscriptionId,
      plan_id: plan?.id ?? null,
      tier: legacyTier,
      expires_at: expiresAt,
      override: written ?? null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Set plan failed" },
      { status: 500 }
    );
  }
}
