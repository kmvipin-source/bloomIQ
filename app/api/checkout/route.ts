import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/checkout
 *
 * Body: { plan_slug?: string, plan?: string }
 *   - `plan_slug` is the new authoritative key (e.g. "premium_monthly").
 *   - `plan` is the legacy field still sent by older /pricing code that
 *     hasn't been re-deployed yet. Mapped to slug below.
 *
 * Creates a Razorpay Order on the server using price + period read live
 * from the active plan row. Returns the order id + amount + the public
 * key id, which the page hands to Razorpay's browser SDK.
 *
 * The plan row's `id` is stuffed into Razorpay order notes so the verify
 * endpoint can bind the resulting subscription to a specific plan version
 * (this is what makes grandfathering work).
 */

// Backward-compat map for the legacy /pricing payloads.
const LEGACY_SLUG_MAP: Record<string, string> = {
  individual_monthly: "premium_monthly",
  individual_yearly: "premium_annual",
};

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const rawSlug: string = String(body.plan_slug || body.plan || "");
    const slug = LEGACY_SLUG_MAP[rawSlug] ?? rawSlug;
    if (!slug) {
      return NextResponse.json({ error: "plan_slug is required." }, { status: 400 });
    }

    // Read the live active plan via the service role so we don't depend on
    // RLS visibility from the browser session (this also future-proofs the
    // case where we restrict pricing reads later).
    const admin = supabaseAdmin();
    const { data: plan, error: planErr } = await admin
      .from("plans")
      .select("id, slug, tier, label, price_paise, currency, period_days")
      .eq("slug", slug)
      .eq("status", "active")
      .maybeSingle();
    if (planErr) return NextResponse.json({ error: planErr.message }, { status: 500 });
    if (!plan) {
      return NextResponse.json(
        { error: `No active plan found for slug "${slug}". The plan may have been archived; refresh /pricing.` },
        { status: 404 }
      );
    }
    if (plan.price_paise <= 0) {
      return NextResponse.json(
        { error: "This is a free plan — nothing to charge." },
        { status: 400 }
      );
    }

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      return NextResponse.json(
        { error: "Razorpay keys not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env.local." },
        { status: 503 }
      );
    }

    // Create Razorpay order. We stash plan_id + slug + tier in `notes` so
    // the verify endpoint can bind the subscription to the right plan
    // version even if the active plan changes between order creation and
    // verification (which is exactly the grandfathering case).
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const r = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        amount: plan.price_paise,
        currency: plan.currency || "INR",
        receipt: `bloomiq_${user.id.slice(0, 8)}_${Date.now()}`,
        notes: {
          user_id: user.id,
          plan_id: plan.id,
          plan_slug: plan.slug,
          tier: plan.tier,
          period_days: String(plan.period_days),
        },
      }),
    });
    if (!r.ok) {
      const errText = await r.text();
      return NextResponse.json({ error: `Razorpay order failed: ${errText.slice(0, 200)}` }, { status: 500 });
    }
    const order = (await r.json()) as { id: string; amount: number; currency: string };

    return NextResponse.json({
      ok: true,
      key_id: keyId,
      order_id: order.id,
      amount_paise: order.amount,
      currency: order.currency,
      plan: {
        id: plan.id,
        slug: plan.slug,
        tier: plan.tier,
        label: plan.label,
        period_days: plan.period_days,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Checkout failed" },
      { status: 500 }
    );
  }
}
