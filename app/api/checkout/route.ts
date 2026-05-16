import { NextResponse } from "next/server";
import { supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

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

// F151 fix: legacy slug normalization moved to lib/planLegacy.ts —
// shared between /api/checkout and /api/checkout/verify so adding a
// new legacy slug lights up both endpoints in one place.
import { LEGACY_SLUG_MAP } from "@/lib/planLegacy";

export async function POST(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — payment-creation
    // route now rejects stale tokens from previous devices. Important
    // here specifically: a stolen access token issued before a later
    // sign-in elsewhere can no longer create a Razorpay order on the
    // legitimate user's behalf.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const body = await req.json().catch(() => ({}));
    const rawSlug: string = String(body.plan_slug || body.plan || "");
    const slug = LEGACY_SLUG_MAP[rawSlug] ?? rawSlug;
    if (!slug) {
      return NextResponse.json({ error: "plan_slug is required." }, { status: 400 });
    }

    // Read the live plan via the service role so we don't depend on RLS
    // visibility from the browser session. Post-migration-30, slug is
    // unique, so this is a single-row lookup with no status filter.
    const admin = supabaseAdmin();
    const { data: plan, error: planErr } = await admin
      .from("plans")
      .select("id, slug, tier, label, price_paise, currency, period_days")
      .eq("slug", slug)
      .maybeSingle();
    if (planErr) return NextResponse.json({ error: planErr.message }, { status: 500 });
    if (!plan) {
      return NextResponse.json(
        { error: `No plan found for slug "${slug}". Refresh /pricing.` },
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

    // F152 fix (QA): if a user double-clicks the buy button or the network
    // hiccups and the page re-submits, we'd previously create two Razorpay
    // orders for the same plan_id. Verify path is idempotent (F162), but a
    // second pending order in Razorpay is noise. Best-effort guard: refuse
    // if an unverified order for this user+plan exists in the last 5 min.
    // The check is intentionally soft — if the row lookup fails for any
    // reason, fall through and create. We never block a real purchase.
    try {
      const adminSb = supabaseAdmin();
      const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      const { data: recent } = await adminSb
        .from("razorpay_orders")
        .select("razorpay_order_id, created_at, verified_at")
        .eq("user_id", user.id)
        .eq("plan_id", plan.id)
        .is("verified_at", null)
        .gte("created_at", fiveMinAgo)
        .limit(1);
      if (recent && recent.length > 0 && recent[0].razorpay_order_id) {
        console.warn("[checkout] in-flight order reused", { user_id: user.id, plan_id: plan.id, razorpay_order_id: recent[0].razorpay_order_id });
        return NextResponse.json({
          ok: true,
          order_id: recent[0].razorpay_order_id,
          reused: true,
          plan_id: plan.id,
          amount: plan.price_paise,
          currency: plan.currency || "INR",
        });
      }
    } catch (e) {
      console.warn("[checkout] in-flight check threw — falling through to create", e);
    }

    // F152 fix (QA): if a user double-clicks the buy button or the network
    // hiccups and the page re-submits, we'd previously create two Razorpay
    // orders for the same plan_id. Verify path is idempotent (F162), but a
    // second pending order in Razorpay is noise. Best-effort guard: refuse
    // if an unverified order for this user+plan exists in the last 5 min.
    // The check is intentionally soft — if the row lookup fails for any
    // reason, fall through and create. We never block a real purchase.
    try {
      const adminSb = supabaseAdmin();
      const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      const { data: recent } = await adminSb
        .from("razorpay_orders")
        .select("razorpay_order_id, created_at, verified_at")
        .eq("user_id", user.id)
        .eq("plan_id", plan.id)
        .is("verified_at", null)
        .gte("created_at", fiveMinAgo)
        .limit(1);
      if (recent && recent.length > 0 && recent[0].razorpay_order_id) {
        console.warn("[checkout] in-flight order reused", { user_id: user.id, plan_id: plan.id, razorpay_order_id: recent[0].razorpay_order_id });
        return NextResponse.json({
          ok: true,
          order_id: recent[0].razorpay_order_id,
          reused: true,
          plan_id: plan.id,
          amount: plan.price_paise,
          currency: plan.currency || "INR",
        });
      }
    } catch (e) {
      console.warn("[checkout] in-flight check threw — falling through to create", e);
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
        // F161 fix: brand drift — zcoriq_ prefix matches the rebrand.
        receipt: `zcoriq_${user.id.slice(0, 8)}_${Date.now()}`,
        notes: {
          user_id: user.id,
          plan_id: plan.id,
          plan_slug: plan.slug,
          tier: plan.tier,
          period_days: String(plan.period_days),
          // F163 fix: include user email (best-effort) so Razorpay's
          // customer view + support tooling can identify the buyer at
          // a glance. Razorpay note values must be strings.
          user_email: user.email || "",
        },
      }),
    });
    if (!r.ok) {
      const errText = await r.text();
      // eslint-disable-next-line no-console
      console.error("[checkout] Razorpay order create failed:", errText.slice(0, 200));
      return NextResponse.json({ error: "Could not start checkout. Please try again." }, { status: 502 });
    }
    const order = (await r.json()) as { id: string; amount: number; currency: string };

    // F165 fix: log IP + UA on every order create for chargeback defense.
    // Stays at server logs (no DB column yet) — a follow-up migration can
    // capture them on the subscription row for richer fraud telemetry.
    const ip = (req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "").split(",")[0]?.trim() || "";
    const ua = (req.headers.get("user-agent") || "").slice(0, 200);
    // eslint-disable-next-line no-console
    console.info(`[checkout] order ${order.id} for user ${user.id.slice(0, 8)} ip=${ip} ua="${ua}"`);

    return NextResponse.json({
      ok: true,
      key_id: keyId,
      order_id: order.id,
      amount_paise: order.amount,
      currency: order.currency,
      plan: { id: plan.id, slug: plan.slug, tier: plan.tier, label: plan.label, period_days: plan.period_days },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Checkout failed" }, { status: 500 });
  }
}
