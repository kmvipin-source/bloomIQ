import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/checkout/verify
 *
 * Body: {
 *   razorpay_order_id: string,
 *   razorpay_payment_id: string,
 *   razorpay_signature: string,
 * }
 *
 * Razorpay's checkout modal posts these three values back to the page on
 * success. We:
 *   1) verify the HMAC-SHA256 signature server-side using RAZORPAY_KEY_SECRET
 *   2) re-fetch the order from Razorpay so we can read the notes (plan_id,
 *      slug, tier, period_days) authoritatively, not from the client
 *   3) bind the user's subscription to the SPECIFIC plan_id from the order
 *      notes — this is what implements grandfathering. If the platform
 *      admin later approves a new active version of the same slug with
 *      different features or price, this user stays on the version they
 *      paid for.
 *
 * Backward-compat: orders created with the legacy `plan` field in notes
 * (from before the plan-admin module shipped) are still honoured by
 * looking up the plan by legacy slug.
 */

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

    // 1) HMAC verification. Constant-time compare so the secret can't
    // be leaked through timing analysis.
    const expected = crypto
      .createHmac("sha256", keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");
    if (
      expected.length !== signature.length ||
      !crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))
    ) {
      return NextResponse.json({ error: "Signature mismatch — payment not verified." }, { status: 400 });
    }

    // 2) Pull the order back from Razorpay so we can read the notes.
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const ord = await fetch(`https://api.razorpay.com/v1/orders/${orderId}`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!ord.ok) {
      const t = await ord.text();
      return NextResponse.json({ error: `Could not fetch order: ${t.slice(0, 200)}` }, { status: 500 });
    }
    const order = (await ord.json()) as {
      // The actual amount Razorpay charged the customer, in paise. We
      // lock this onto the subscription so the customer's price is fixed
      // for the current term — the only piece of "grandfathering" we keep
      // post-migration-30. On renewal, a new subscription gets the live
      // plan price.
      amount?: number;
      notes?: {
        user_id?: string;
        plan_id?: string;
        plan_slug?: string;
        plan?: string;          // legacy
        tier?: string;
        period_days?: string;
      };
    };
    const notedUser = order.notes?.user_id;
    if (notedUser && notedUser !== user.id) {
      return NextResponse.json({ error: "Order does not belong to this user." }, { status: 403 });
    }

    // 3) Resolve the plan row. Prefer plan_id (new), fall back to plan_slug
    //    or legacy `plan` key. We always re-load from the DB so we use the
    //    correct tier + period_days as enforcement.
    const admin = supabaseAdmin();

    // Idempotency: if this payment_id has already produced a
    // subscriptions row, return success without re-applying. Stops
    // replay / double-click / browser-retry from extending the term
    // twice. The unique partial index on razorpay_payment_id is the
    // database-level enforcement; this check makes the response
    // deterministic instead of bubbling a 23505 to the user.
    const { data: alreadyApplied } = await admin
      .from("subscriptions")
      .select("id, tier, plan_id, expires_at, plan:plans!subscriptions_plan_id_fkey(slug)")
      .eq("razorpay_payment_id", paymentId)
      .maybeSingle();
    if (alreadyApplied) {
      const applied = alreadyApplied as unknown as {
        tier: string;
        plan_id: string | null;
        expires_at: string | null;
        plan: { slug: string | null } | null;
      };
      return NextResponse.json({
        ok: true,
        already_applied: true,
        tier: applied.tier,
        plan_id: applied.plan_id,
        plan_slug: applied.plan?.slug ?? null,
        expires_at: applied.expires_at,
      });
    }

    let planRow: {
      id: string;
      slug: string;
      tier: string;
      period_days: number;
      price_paise: number;
    } | null = null;

    if (order.notes?.plan_id) {
      const { data } = await admin
        .from("plans")
        .select("id, slug, tier, period_days, price_paise")
        .eq("id", order.notes.plan_id)
        .maybeSingle();
      if (data) planRow = data;
    }
    if (!planRow) {
      const slug = order.notes?.plan_slug
        || (order.notes?.plan ? (LEGACY_SLUG_MAP[order.notes.plan] ?? order.notes.plan) : "");
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
      return NextResponse.json({ error: "Could not resolve a plan from the order notes." }, { status: 400 });
    }

    // Price validation: assert Razorpay's order.amount matches the
    // plan's current price_paise. Without this assertion a tampered
    // order (or a stale order from before an admin-side price change)
    // could lock in a wrong price. The plan row is the canonical
    // source of truth post-checkout.
    if (
      typeof order.amount === "number" &&
      order.amount > 0 &&
      planRow.price_paise > 0 &&
      order.amount !== planRow.price_paise
    ) {
      return NextResponse.json(
        { error: "Order amount does not match the plan price. Refresh the page and try again." },
        { status: 409 }
      );
    }

    // Map our plan tier ('premium', 'premium_plus', etc.) to the legacy
    // subscriptions.tier text the rest of the app already understands.
    // Keeps existing tier-checking code working without a sweeping rename.
    const legacyTierMap: Record<string, string> = {
      free: "free",
      premium: planRow.period_days >= 360 ? "premium" : "individual",
      premium_plus: "premium_plus",
      school_pilot: "premium",
      school_standard: "premium",
      school_plus: "premium_plus",
    };
    const legacyTier = legacyTierMap[planRow.tier] || planRow.tier;

    // 4) Update-or-insert the subscription row. Pull expires_at first so
    // we can anchor the new term correctly when this is an UPGRADE on
    // top of an active subscription.
    const { data: existing, error: selErr } = await admin
      .from("subscriptions")
      .select("id, expires_at, school_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (selErr) return NextResponse.json({ error: selErr.message }, { status: 500 });

    // ===== Upgrade-aware expiry (Model B: extension) =====
    // Anchor the new term off whichever is later — now, or the old
    // plan's existing expiry. So if a user upgrades from Premium
    // Monthly with 18 days remaining to Premium Plus Quarterly,
    // their new expires_at is (today + 18 days) + 90 days, not just
    // today + 90 days. The user pays the full new-plan price (not
    // a prorated differential), but they don't forfeit unused time.
    //
    // Edge cases handled by max():
    //   - No prior subscription      → existing is null, anchor = now
    //   - Old sub already expired    → oldExpiresMs <= now, anchor = now
    //   - Old sub still active       → anchor = oldExpiresMs
    //   - Old sub very far in future → anchor = oldExpiresMs (no surprise rollback)
    const oldExpiresMs =
      existing?.expires_at ? new Date(existing.expires_at).getTime() : 0;
    const anchorMs = Math.max(Date.now(), oldExpiresMs);
    const expiresAt = new Date(anchorMs + planRow.period_days * 24 * 60 * 60 * 1000).toISOString();

    // The amount the customer actually paid for THIS term. Locked onto
    // the subscription so a future plan price-change doesn't retroactively
    // re-price them mid-term. On renewal a fresh row is created with the
    // then-current price.
    // Fall back to the plan's price if Razorpay's order didn't return
    // an amount (rare but possible when the order is malformed).
    // Otherwise the row would carry price_paid_paise=0, polluting
    // revenue reporting and GST.
    const pricePaidPaise =
      typeof order.amount === "number" && order.amount > 0
        ? order.amount
        : planRow.price_paise;

    if (existing?.id) {
      // Preserve the existing school_id link — a user paying for a
      // personal upgrade while attached to a school subscription
      // shouldn't lose the school context. The previous code blanked
      // school_id unconditionally.
      const preservedSchoolId = (existing as { school_id?: string | null }).school_id ?? null;
      const { error: updErr } = await admin
        .from("subscriptions")
        .update({
          tier: legacyTier,
          plan_id: planRow.id,
          price_paid_paise: pricePaidPaise,
          status: "active",
          started_at: new Date().toISOString(),
          expires_at: expiresAt,
          school_id: preservedSchoolId,
          razorpay_payment_id: paymentId,
          is_trial: false,  // D6: explicit clear on Free→Paid upgrade so the
                            // expired-Free-trial check in /api/auth/me cannot
                            // ever mis-fire against a paying user.
        })
        .eq("id", existing.id);
      if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    } else {
      const { error: insErr } = await admin
        .from("subscriptions")
        .insert({
          user_id: user.id,
          school_id: null,
          tier: legacyTier,
          plan_id: planRow.id,
          price_paid_paise: pricePaidPaise,
          status: "active",
          started_at: new Date().toISOString(),
          expires_at: expiresAt,
          razorpay_payment_id: paymentId,
          is_trial: false,  // D6: a fresh paid subscription is never a trial.
        });
      if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      tier: legacyTier,
      plan_id: planRow.id,
      plan_slug: planRow.slug,
      expires_at: expiresAt,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Verify failed" },
      { status: 500 }
    );
  }
}
