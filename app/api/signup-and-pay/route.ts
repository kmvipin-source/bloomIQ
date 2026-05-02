import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/signup-and-pay
 *
 * Body: { email, full_name, password, plan_slug }
 *
 * Logged-out path on /pricing. Creates the Supabase user (email_confirm:true
 * so they can sign in immediately), provisions a profile, signs in to mint
 * a session, then creates a Razorpay order bound to the new user. Returns
 * the session tokens + order so the pricing page can call setSession() and
 * open the Razorpay modal in one continuous flow. The existing
 * /api/checkout/verify endpoint then finishes the subscription bind.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const fullName = String(body.full_name || "").trim();
    const planSlug = String(body.plan_slug || "").trim();

    if (!email || !password || !fullName || !planSlug) {
      return NextResponse.json({ error: "email, full_name, password, plan_slug required." }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
    }
    if (!/.+@.+\..+/.test(email)) {
      return NextResponse.json({ error: "Invalid email." }, { status: 400 });
    }

    const admin = supabaseAdmin();

    const { data: plan, error: planErr } = await admin
      .from("plans")
      .select("id, slug, tier, label, price_paise, currency, period_days")
      .eq("slug", planSlug)
      .maybeSingle();
    if (planErr) return NextResponse.json({ error: planErr.message }, { status: 500 });
    if (!plan) return NextResponse.json({ error: `No plan for slug "${planSlug}".` }, { status: 404 });
    if (plan.price_paise <= 0) return NextResponse.json({ error: "This plan is free — sign up via /signup." }, { status: 400 });

    // Reject if email already in use — push to /login flow instead of paying.
    const { data: existingList } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const exists = existingList?.users.find((u) => (u.email || "").toLowerCase() === email);
    if (exists) {
      return NextResponse.json(
        { error: "An account with this email already exists. Please sign in first.", code: "email_exists" },
        { status: 409 }
      );
    }

    const acceptedAt = new Date().toISOString();
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        role: "student",
        full_name: fullName,
        tos_accepted_at: acceptedAt,
        tos_version: "2026-04-30",
      },
    });
    if (createErr || !created.user) {
      return NextResponse.json({ error: createErr?.message || "User create failed" }, { status: 500 });
    }
    const userId = created.user.id;

    // The on_auth_user_created trigger should mirror raw_user_meta_data to
    // profiles. Upsert defensively in case the trigger isn't installed.
    const { error: profErr } = await admin
      .from("profiles")
      .upsert({ id: userId, role: "student", full_name: fullName });
    if (profErr) {
      // Roll back the auth user so /pricing can ask the visitor to retry
      // without leaving an orphan account behind.
      await admin.auth.admin.deleteUser(userId);
      return NextResponse.json({ error: profErr.message }, { status: 500 });
    }

    // Mint a session for the new user via password grant. We use the anon
    // client (no persist) just to call signInWithPassword; the tokens come
    // back as plain strings.
    const anon = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({ email, password });
    if (signInErr || !signIn.session) {
      return NextResponse.json({ error: signInErr?.message || "Sign-in failed" }, { status: 500 });
    }

    // Razorpay order.
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      return NextResponse.json({ error: "Razorpay keys not configured." }, { status: 503 });
    }
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const r = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify({
        amount: plan.price_paise,
        currency: plan.currency || "INR",
        receipt: `bloomiq_${userId.slice(0, 8)}_${Date.now()}`,
        notes: {
          user_id: userId,
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
      access_token: signIn.session.access_token,
      refresh_token: signIn.session.refresh_token,
      user: { id: userId, email, full_name: fullName },
      key_id: keyId,
      order_id: order.id,
      amount_paise: order.amount,
      currency: order.currency,
      plan: { id: plan.id, slug: plan.slug, tier: plan.tier, label: plan.label, period_days: plan.period_days },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "signup-and-pay failed" },
      { status: 500 }
    );
  }
}
