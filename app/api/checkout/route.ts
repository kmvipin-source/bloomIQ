import { NextResponse } from "next/server";
import { getBearer, supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Plan catalog. Prices are in INR paise (₹1 = 100 paise) per Razorpay convention.
// Easy to tune later without a redeploy by moving these to a settings table.
const PLANS: Record<string, { tier: "individual" | "premium"; period_days: number; amount_paise: number; label: string }> = {
  individual_monthly: { tier: "individual", period_days: 30,  amount_paise:  9900, label: "Individual \u00b7 Monthly"  },
  individual_yearly:  { tier: "premium",    period_days: 365, amount_paise: 99900, label: "Individual \u00b7 Annual"   },
};

/**
 * POST /api/checkout
 *
 * Body: { plan: keyof PLANS }
 *
 * Creates a Razorpay Order on the server and returns the order id + amount +
 * the public key id, which the page hands to Razorpay\u2019s browser SDK to
 * open the in-page checkout modal.
 *
 * Auth required (the caller must be a logged-in independent student).
 * No DB writes happen here \u2014 the subscription is only flipped after
 * /api/checkout/verify confirms the payment signature.
 */
export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const planId = String(body.plan || "");
    const plan = PLANS[planId];
    if (!plan) return NextResponse.json({ error: "Unknown plan." }, { status: 400 });

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      return NextResponse.json(
        { error: "Razorpay keys not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env.local." },
        { status: 503 }
      );
    }

    // Create order via Razorpay REST API (no SDK install needed).
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const r = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        amount: plan.amount_paise,
        currency: "INR",
        receipt: `bloomiq_${user.id.slice(0, 8)}_${Date.now()}`,
        notes: { user_id: user.id, plan: planId, tier: plan.tier },
      }),
    });
    if (!r.ok) {
      const errText = await r.text();
      return NextResponse.json({ error: `Razorpay order failed: ${errText.slice(0, 200)}` }, { status: 500 });
    }
    const order = (await r.json()) as { id: string; amount: number; currency: string };

    // Public key id is sent to the browser SDK; secret stays server-side.
    return NextResponse.json({
      ok: true,
      key_id: keyId,
      order_id: order.id,
      amount_paise: order.amount,
      currency: order.currency,
      plan: { id: planId, tier: plan.tier, label: plan.label, period_days: plan.period_days },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Checkout failed" },
      { status: 500 }
    );
  }
}
