import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/admin/subscriptions/[id]/mark-paid
 *
 * Platform admin records that the school's NEFT/cheque/wire payment has
 * landed in our account. Sets payment_received_at to now (or to a
 * specified date), marks the subscription active, and renews
 * expires_at one period from today.
 *
 * Body (all optional):
 *   {
 *     received_at?: string,    // ISO timestamp; defaults to now()
 *     invoice_number?: string, // overwrite if missing
 *     payment_method?: string  // 'neft' | 'cheque' | 'manual' | 'razorpay'
 *   }
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

    const admin = supabaseAdmin();
    const { data: sub } = await admin
      .from("subscriptions")
      .select("id, plan_id, school_id, expires_at, activation_pending")
      .eq("id", subscriptionId)
      .maybeSingle();
    if (!sub) return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
    // Refuse to mark an independent-student row paid through the B2B
    // surface. This endpoint is the school-finance workflow (NEFT,
    // cheque, manual override against an invoice). Student rows reach
    // 'active' through /api/checkout/verify after Razorpay; routing
    // them through mark-paid would skip Razorpay signature verification.
    if (!sub.school_id) {
      return NextResponse.json(
        { error: "This subscription is not school-bound. Use the checkout flow instead." },
        { status: 400 }
      );
    }

    // ─── extends_to logic ───
    // Three cases. Caller can override anchor with body.extend_from:
    //   "smart"   (default) — early payment → preserve unused remainder
    //                         (anchor on existing.expires_at);
    //                         late / first payment → anchor on received_at.
    //   "previous_expiry"   — always anchor on existing.expires_at (clean
    //                         year-on-year cycles, useful for B2B contracts
    //                         tied to academic years; school doesn't get
    //                         penalised for paying late but cycle dates
    //                         stay aligned).
    //   "received_at"       — always anchor on received_at (penalty-style
    //                         cycle reset; rarely wanted).
    // Returns previousExpiresAt and newExpiresAt so the UI can show a
    // "extends X → Y" preview before clicking.
    const extendFrom: "smart" | "previous_expiry" | "received_at" =
      body.extend_from === "previous_expiry" ? "previous_expiry"
      : body.extend_from === "received_at" ? "received_at"
      : "smart";
    const previousExpiresAt: string | null = sub.expires_at;
    let newExpiresAt: string | null = sub.expires_at;
    if (sub.plan_id) {
      const { data: plan } = await admin
        .from("plans")
        .select("period_days")
        .eq("id", sub.plan_id)
        .maybeSingle();
      const periodDays = (plan as { period_days?: number } | null)?.period_days || 365;
      let baseTime: number;
      if (extendFrom === "previous_expiry" && sub.expires_at) {
        baseTime = Date.parse(sub.expires_at);
      } else if (extendFrom === "received_at") {
        baseTime = Date.parse(receivedAt);
      } else {
        // "smart" — preserve remainder when paying early.
        baseTime = sub.expires_at && Date.parse(sub.expires_at) > Date.parse(receivedAt)
          ? Date.parse(sub.expires_at)
          : Date.parse(receivedAt);
      }
      newExpiresAt = new Date(baseTime + periodDays * 24 * 60 * 60 * 1000).toISOString();
    }

    const update: Record<string, unknown> = {
      payment_received_at: receivedAt,
      status: "active",
      expires_at: newExpiresAt,
      // Once a payment has been recorded the school is fully activated;
      // first-sign-in deferral no longer applies (the cycle is locked in
      // by the explicit money-in event).
      activation_pending: false,
    };
    if (invoiceNumber !== undefined) update.invoice_number = invoiceNumber;
    if (paymentMethod !== undefined) update.payment_method = paymentMethod;

    const { error: updErr } = await admin
      .from("subscriptions")
      .update(update)
      .eq("id", subscriptionId);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    return NextResponse.json({
      ok: true,
      subscription_id: subscriptionId,
      payment_received_at: receivedAt,
      // Preview-friendly: show admin both anchors so the UI can render
      // "extends from X to Y".
      previous_expires_at: previousExpiresAt,
      expires_at: newExpiresAt,
      extend_from: extendFrom,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "mark-paid failed" },
      { status: 500 }
    );
  }
}
