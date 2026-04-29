import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Mirrors the catalog in /api/checkout/route.ts. We re-derive tier + period
// from the Razorpay order rather than trusting the client.
const PLANS: Record<string, { tier: "individual" | "premium"; period_days: number }> = {
  individual_monthly: { tier: "individual", period_days: 30 },
  individual_yearly:  { tier: "premium",    period_days: 365 },
};

/**
 * POST /api/checkout/verify
 *
 * Body: {
 *   razorpay_order_id: string,
 *   razorpay_payment_id: string,
 *   razorpay_signature: string,
 * }
 *
 * Razorpay\u2019s checkout modal posts these three values back to the page on
 * success. We verify the HMAC-SHA256 signature server-side using
 * RAZORPAY_KEY_SECRET, then flip the user\u2019s subscription row to the
 * paid tier. This is the authoritative server-side check; the webhook
 * endpoint can do the same job out-of-band for resilience.
 */
export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const orderId = String(body.razorpay_order_id || "");
    const paymentId = String(body.razorpay_payment_id || "");
    const signature = String(body.razorpay_signature || "");
    if (!orderId || !paymentId || !signature) {
      return NextResponse.json({ error: "Missing payment fields." }, { status: 400 });
    }

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      return NextResponse.json({ error: "Razorpay keys not configured." }, { status: 503 });
    }

    // 1) HMAC verification.
    const expected = crypto
      .createHmac("sha256", keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");
    if (expected !== signature) {
      return NextResponse.json({ error: "Signature mismatch \u2014 payment not verified." }, { status: 400 });
    }

    // 2) Pull the order back from Razorpay so we can read the notes (which
    //    carry the plan id) authoritatively, not from the client.
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const ord = await fetch(`https://api.razorpay.com/v1/orders/${orderId}`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!ord.ok) {
      const t = await ord.text();
      return NextResponse.json({ error: `Could not fetch order: ${t.slice(0, 200)}` }, { status: 500 });
    }
    const order = (await ord.json()) as { notes?: { user_id?: string; plan?: string } };
    const notedUser = order.notes?.user_id;
    const planId = order.notes?.plan || "";

    // The order must have been created by THIS user. (Defence-in-depth; the
    // signature check already implies trust, but never hurts to double up.)
    if (notedUser && notedUser !== user.id) {
      return NextResponse.json({ error: "Order does not belong to this user." }, { status: 403 });
    }

    const plan = PLANS[planId];
    if (!plan) return NextResponse.json({ error: "Unknown plan in order notes." }, { status: 400 });

    // 3) Update-or-insert the subscription row.
    //
    // We deliberately avoid `.upsert({ onConflict: "user_id" })` here because
    // PostgREST translates that into `ON CONFLICT (user_id) DO UPDATE`, and
    // the unique index on subscriptions.user_id is PARTIAL (where user_id is
    // not null) — Postgres can't match a partial index from a bare ON CONFLICT
    // clause, and the whole transaction aborts with "no unique or exclusion
    // constraint matching the ON CONFLICT specification". The simple two-step
    // SELECT → UPDATE/INSERT below side-steps the issue cleanly.
    const expiresAt = new Date(Date.now() + plan.period_days * 24 * 60 * 60 * 1000).toISOString();
    const admin = supabaseAdmin();

    const { data: existing, error: selErr } = await admin
      .from("subscriptions")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (selErr) return NextResponse.json({ error: selErr.message }, { status: 500 });

    if (existing?.id) {
      const { error: updErr } = await admin
        .from("subscriptions")
        .update({
          tier: plan.tier,
          status: "active",
          started_at: new Date().toISOString(),
          expires_at: expiresAt,
          school_id: null,
        })
        .eq("id", existing.id);
      if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    } else {
      const { error: insErr } = await admin
        .from("subscriptions")
        .insert({
          user_id: user.id,
          school_id: null,
          tier: plan.tier,
          status: "active",
          started_at: new Date().toISOString(),
          expires_at: expiresAt,
        });
      if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, tier: plan.tier, expires_at: expiresAt });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Verify failed" },
      { status: 500 }
    );
  }
}
