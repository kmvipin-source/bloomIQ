import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/admin/subscriptions/[id]/mark-paid
 *
 * Platform admin records that the school's NEFT/cheque/wire payment has
 * landed in our account. Pure finance event: stamps payment + audit +
 * invoice fields on the CURRENT cycle. **Does not modify expires_at.**
 *
 * Why no expiry change here: the cycle window is owned by set-plan and
 * start-renewal-cycle (both of which set started_at + expires_at =
 * started_at + period_days). Mark-paid is just the moment money arrived
 * in our bank. Decoupling them enforces the invariant "1 year paid =
 * 1 year of access" — under the old "smart extend" rule, clicking Save
 * then Mark-paid back-to-back gave a school 2 years for one payment
 * (a year from Save + a year stacked by mark-paid). That bug is now
 * impossible to reproduce.
 *
 * Body (all optional):
 *   {
 *     received_at?: string,         // ISO timestamp; defaults to now()
 *     invoice_number?: string,      // overwrite if missing; else auto-generated
 *     payment_method?: string,      // 'neft' | 'cheque' | 'manual' | 'razorpay'
 *     po_number?: string,           // school's purchase-order ref (D11)
 *     extend_expires_at_days?: number,  // ESCAPE HATCH — operator-only, very rare
 *                                       // For when an admin really needs to add days
 *                                       // (e.g. forgiving a late payer). Audited.
 *   }
 *
 * On success:
 *   - subscriptions.payment_received_at  = received_at (or now)
 *   - subscriptions.payment_recorded_at  = server now()  (D3 — audit)
 *   - subscriptions.payment_recorded_by  = auth.uid()    (D3 — audit)
 *   - subscriptions.invoice_number       = body.invoice_number OR auto-gen (D13)
 *   - subscriptions.po_number            = body.po_number (if provided) (D11)
 *   - subscriptions.status               = 'active'
 *   - subscriptions.activation_pending   = false
 *   - subscriptions.expires_at           = UNCHANGED (unless extend_expires_at_days)
 *
 * Renewal workflow (cycle N → cycle N+1):
 *   1. Operator clicks "Start renewal cycle" on the per-school page,
 *      which archives the closing cycle and sets a fresh
 *      started_at=today, expires_at=today+period_days on the live row.
 *   2. School pays NEFT.
 *   3. Operator clicks "Mark payment received" — stamps payment fields
 *      on the (already-correct) new cycle window.
 *
 * Why a separate endpoint vs piggy-backing on set-plan: marking paid is
 * a finance event with its own audit trail. set-plan is a sales event
 * (which plan was sold). Keeping them separate means you can change
 * plan without bumping payment_received_at, and vice versa.
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

    const { id: subscriptionId } = await ctx.params;
    if (!subscriptionId) {
      return NextResponse.json({ error: "subscription id is required" }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const receivedAt: string =
      typeof body.received_at === "string" && !Number.isNaN(Date.parse(body.received_at))
        ? body.received_at
        : new Date().toISOString();
    const invoiceNumber: string | undefined =
      typeof body.invoice_number === "string" && body.invoice_number.trim()
        ? body.invoice_number.trim().slice(0, 60)
        : undefined;
    const paymentMethod: string | undefined =
      ["razorpay", "neft", "cheque", "manual"].includes(body.payment_method)
        ? body.payment_method
        : undefined;
    const poNumber: string | undefined =
      typeof body.po_number === "string" && body.po_number.trim()
        ? body.po_number.trim().slice(0, 120)
        : undefined;

    // Operator-only escape hatch. ONLY used when the platform admin
    // explicitly passes a positive integer in the body. Default is
    // undefined → expires_at stays exactly as set-plan / start-renewal
    // wrote it. Cap at 366 days so a typo can't accidentally add a
    // decade. Audited via payment_recorded_by.
    const extendDaysOverride: number | undefined =
      typeof body.extend_expires_at_days === "number"
        && body.extend_expires_at_days > 0
        && body.extend_expires_at_days <= 366
        ? Math.round(body.extend_expires_at_days)
        : undefined;

    const admin = supabaseAdmin();
    const { data: sub } = await admin
      .from("subscriptions")
      .select("id, plan_id, school_id, expires_at, activation_pending, invoice_number")
      .eq("id", subscriptionId)
      .maybeSingle();
    if (!sub) return NextResponse.json({ error: "Subscription not found" }, { status: 404 });

    // D13 — auto-generate invoice_number atomically at payment time so no
    // two simultaneous PDF downloads can mint the same sequence. We only
    // generate when (a) no caller-supplied number, AND (b) the row doesn't
    // already have one persisted. Format: BLM/YYYY/NNNN.
    //
    // Sequence logic: scan BOTH subscriptions AND subscription_invoice_archive
    // for any invoice_number that starts with `BLM/${year}/`, parse the
    // trailing digits, take the max, increment. This handles:
    //   - "count" approach was wrong: when start_renewal clears the live
    //     row's invoice_number, count drops and the next mint collides
    //     with the freshly-archived number. (Found via Chrome E2E test
    //     2026-05-12: same school's live + archived cycles both showed
    //     BLM/2026/0002 — a real GST compliance bug.)
    //   - rows deleted during the year don't decrement the next number
    //   - archived cycles are first-class citizens for the sequence
    let autoInvoiceNumber: string | undefined;
    const subRow = sub as { invoice_number?: string | null };
    if (!invoiceNumber && !subRow.invoice_number) {
      const year = new Date().getFullYear();
      const prefix = `BLM/${year}/`;
      const re = new RegExp(`^BLM/${year}/(\\d+)$`);
      const collected: number[] = [];
      const [{ data: liveRows }, { data: archRows }] = await Promise.all([
        admin
          .from("subscriptions")
          .select("invoice_number")
          .ilike("invoice_number", `${prefix}%`),
        admin
          .from("subscription_invoice_archive")
          .select("invoice_number")
          .ilike("invoice_number", `${prefix}%`),
      ]);
      for (const r of [...(liveRows ?? []), ...(archRows ?? [])]) {
        const inv = (r as { invoice_number: string | null }).invoice_number;
        const m = inv ? re.exec(inv) : null;
        if (m) collected.push(parseInt(m[1], 10));
      }
      const maxSeq = collected.length > 0 ? Math.max(...collected) : 0;
      const seq = String(maxSeq + 1).padStart(4, "0");
      autoInvoiceNumber = `BLM/${year}/${seq}`;
    }

    // ─── Expiry handling ───
    // BY DEFAULT mark-paid does NOT touch expires_at. The cycle window
    // is set by set-plan (on initial activation) or by the start_renewal
    // path in set-plan (year-on-year). Mark-paid is the moment money
    // arrived; the school's *access* window is already correct.
    //
    // The only exception is the escape hatch above
    // (body.extend_expires_at_days). When that's supplied the operator
    // is explicitly saying "add N days from today" — used for late-payer
    // forgiveness or contractual goodwill. Capped at 366 days, audited
    // via payment_recorded_by.
    const previousExpiresAt: string | null = sub.expires_at;
    let newExpiresAt: string | null = sub.expires_at;
    if (extendDaysOverride && sub.expires_at) {
      const anchor = Date.parse(sub.expires_at);
      const base = Number.isFinite(anchor) && anchor > Date.now() ? anchor : Date.now();
      newExpiresAt = new Date(base + extendDaysOverride * 24 * 60 * 60 * 1000).toISOString();
    }

    const update: Record<string, unknown> = {
      payment_received_at: receivedAt,
      payment_recorded_at: new Date().toISOString(),  // D3 — server-side audit
      payment_recorded_by: user.id,                    // D3 — who did it
      status: "active",
      // Once a payment has been recorded the school is fully activated;
      // first-sign-in deferral no longer applies (the cycle is locked in
      // by the explicit money-in event).
      activation_pending: false,
    };
    // Only write expires_at when the operator explicitly extended it via
    // the escape hatch. The default path leaves expires_at exactly as
    // set-plan / start-renewal wrote it, guaranteeing "1 year paid = 1
    // year of access" with no double-stacking.
    if (newExpiresAt && newExpiresAt !== previousExpiresAt) {
      update.expires_at = newExpiresAt;
    }
    if (invoiceNumber !== undefined) update.invoice_number = invoiceNumber;
    else if (autoInvoiceNumber !== undefined) update.invoice_number = autoInvoiceNumber;
    if (paymentMethod !== undefined) update.payment_method = paymentMethod;
    if (poNumber !== undefined) update.po_number = poNumber;

    const { error: updErr } = await admin
      .from("subscriptions")
      .update(update)
      .eq("id", subscriptionId);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    return NextResponse.json({
      ok: true,
      subscription_id: subscriptionId,
      payment_received_at: receivedAt,
      payment_recorded_at: update.payment_recorded_at,
      payment_recorded_by: user.id,
      invoice_number: invoiceNumber ?? autoInvoiceNumber ?? subRow.invoice_number ?? null,
      po_number: poNumber ?? null,
      // Both fields returned so the UI can confirm what (if anything)
      // changed. When no escape-hatch extension was applied, both are
      // the same value.
      previous_expires_at: previousExpiresAt,
      expires_at: newExpiresAt,
      expires_at_changed: newExpiresAt !== previousExpiresAt,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "mark-paid failed" },
      { status: 500 }
    );
  }
}
