import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/razorpay/webhook
 *
 * Razorpay-side fallback for the /api/checkout/verify browser path.
 * The browser-driven verify only runs if the user keeps the tab open
 * through the Razorpay modal — if they close it after the charge but
 * before the verify request lands, money is captured and the
 * subscription never activates. This webhook gives us a server-side
 * path that doesn't depend on the user's session.
 *
 * Idempotency: keyed on subscriptions.razorpay_payment_id (unique
 * partial index from migration 68). A retry from Razorpay OR a race
 * with the browser verify ends in a no-op when a row already exists.
 *
 * Configure in Razorpay Dashboard → Settings → Webhooks:
 *   URL:      https://<domain>/api/razorpay/webhook
 *   Secret:   set RAZORPAY_WEBHOOK_SECRET to match
 *   Events:   payment.captured, order.paid
 */

type RazorpayWebhookBody = {
  event?: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        amount?: number;
        status?: string;
        notes?: Record<string, string>;
      };
    };
    order?: {
      entity?: {
        id?: string;
        amount?: number;
        notes?: Record<string, string>;
      };
    };
  };
};

const LEGACY_SLUG_MAP: Record<string, string> = {
  individual_monthly: "premium_monthly",
  individual_yearly: "premium_annual",
};

function legacyTierOf(tier: string, periodDays: number): string {
  if (tier === "premium") return periodDays >= 360 ? "premium" : "individual";
  if (tier === "premium_plus") return "premium_plus";
  if (tier === "school_plus") return "premium_plus";
  if (tier.startsWith("school_")) return "premium";
  return tier;
}

export async function POST(req: Request) {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      return NextResponse.json({ error: "Webhook secret not configured" }, { status: 503 });
    }
    const rawBody = await req.text();
    const sig = req.headers.get("x-razorpay-signature") || "";
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    if (
      sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))
    ) {
      return NextResponse.json({ error: "Signature mismatch" }, { status: 400 });
    }

    let body: RazorpayWebhookBody;
    try { body = JSON.parse(rawBody) as RazorpayWebhookBody; }
    catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

    // We only act on payment.captured and order.paid — both signal a
    // confirmed successful charge. Ignore everything else (failed,
    // authorized, refund — refund handling is a separate flow).
    const event = String(body.event || "");
    if (event !== "payment.captured" && event !== "order.paid") {
      return NextResponse.json({ ok: true, ignored: event });
    }

    const payment = body.payload?.payment?.entity;
    const order = body.payload?.order?.entity;
    const paymentId = payment?.id || null;
    const orderId = payment?.order_id || order?.id || null;
    const amountPaise = payment?.amount ?? order?.amount ?? null;
    const notes = payment?.notes || order?.notes || {};
    if (!paymentId || !orderId) {
      return NextResponse.json({ ok: true, ignored: "missing payment/order id" });
    }

    const admin = supabaseAdmin();

    // Short-circuit if we've already recorded this payment via the
    // browser verify path.
    const { data: alreadyApplied } = await admin
      .from("subscriptions")
      .select("id")
      .eq("razorpay_payment_id", paymentId)
      .maybeSingle();
    if (alreadyApplied) {
      return NextResponse.json({ ok: true, already_applied: true });
    }

    const userId = String(notes.user_id || "");
    if (!userId) {
      // No user link on the order — likely an admin/manual order, not
      // something the user-facing flow created. Don't try to bind.
      return NextResponse.json({ ok: true, ignored: "no user_id in notes" });
    }

    // Resolve plan from notes — same precedence as /api/checkout/verify
    // (plan_id → plan_slug → legacy plan key).
    let planRow: {
      id: string;
      slug: string;
      tier: string;
      period_days: number;
      price_paise: number;
    } | null = null;
    if (notes.plan_id) {
      const { data } = await admin
        .from("plans")
        .select("id, slug, tier, period_days, price_paise")
        .eq("id", notes.plan_id)
        .maybeSingle();
      if (data) planRow = data;
    }
    if (!planRow) {
      const slug = notes.plan_slug
        || (notes.plan ? (LEGACY_SLUG_MAP[notes.plan] ?? notes.plan) : "");
      if (slug) {
        const { data } = await admin
          .from("plans")
          .select("id, slug, tier, period_days, price_paise")
          .eq("slug", slug)
          .maybeSingle();
        if (data) planRow = data;
      }
    }
    if (!planRow) {
      return NextResponse.json({ ok: true, ignored: "plan not found" });
    }

    // Price assertion: refuse to apply if the captured amount doesn't
    // match the plan's price.
    if (
      typeof amountPaise === "number" &&
      amountPaise > 0 &&
      planRow.price_paise > 0 &&
      amountPaise !== planRow.price_paise
    ) {
      return NextResponse.json(
        { ok: false, error: "amount mismatch", expected: planRow.price_paise, got: amountPaise },
        { status: 409 }
      );
    }

    const legacyTier = legacyTierOf(planRow.tier, planRow.period_days);

    const { data: existing } = await admin
      .from("subscriptions")
      .select("id, expires_at, plan_id, started_at")
      .eq("user_id", userId)
      .maybeSingle();
    const oldExpiresMs = (existing as { expires_at?: string | null } | null)?.expires_at
      ? new Date((existing as { expires_at: string }).expires_at).getTime()
      : 0;
    const anchorMs = Math.max(Date.now(), oldExpiresMs);
    const expiresAt = new Date(anchorMs + planRow.period_days * 24 * 60 * 60 * 1000).toISOString();
    const pricePaidPaise = typeof amountPaise === "number" && amountPaise > 0
      ? amountPaise
      : planRow.price_paise;

    if (existing?.id) {
      // Finding #23 fix (R1 from today's Razorpay audit doc): on
      // SAME-plan renewals, preserve started_at so the cohort math
      // (expires_at - started_at = one paid cycle) stays accurate.
      // Bump it ONLY when the plan actually changed (upgrade/downgrade
      // is a logically new term).
      const existingRow = existing as { id: string; plan_id?: string | null; started_at?: string | null };
      const planChanged = (existingRow.plan_id ?? null) !== planRow.id;
      const updatePayload: Record<string, unknown> = {
        tier: legacyTier,
        plan_id: planRow.id,
        price_paid_paise: pricePaidPaise,
        status: "active",
        expires_at: expiresAt,
        razorpay_payment_id: paymentId,
        school_id: null,
      };
      if (planChanged || !existingRow.started_at) {
        updatePayload.started_at = new Date().toISOString();
      }
      const { error: updErr } = await admin
        .from("subscriptions")
        .update(updatePayload)
        .eq("id", existing.id);
      if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    } else {
      const { error: insErr } = await admin
        .from("subscriptions")
        .insert({
          user_id: userId,
          school_id: null,
          tier: legacyTier,
          plan_id: planRow.id,
          price_paid_paise: pricePaidPaise,
          status: "active",
          started_at: new Date().toISOString(),
          expires_at: expiresAt,
          razorpay_payment_id: paymentId,
        });
      // Ignore unique-violation: the browser verify path landed first.
      if (insErr && (insErr as { code?: string }).code !== "23505") {
        return NextResponse.json({ error: insErr.message }, { status: 500 });
      }
    }

    return NextResponse.json({ ok: true, applied: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Webhook handler failed" },
      { status: 500 }
    );
  }
}
