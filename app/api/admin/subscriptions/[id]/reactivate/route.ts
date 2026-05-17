import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";

export const runtime = "nodejs";

/**
 * POST /api/admin/subscriptions/[id]/reactivate
 *
 * Undo a previous suspend. Sets status back to 'active' and clears the
 * suspended_* audit fields. The cycle window (started_at, expires_at) is
 * untouched — re-activation is purely about feature access, not term
 * length.
 *
 * If the school paid in the meantime, call /mark-paid first (which
 * stamps payment_received_at and stays idempotent), and THEN call
 * reactivate; or just call mark-paid which also flips status to active
 * as a side effect.
 *
 * On success:
 *   - subscriptions.status           = 'active'
 *   - subscriptions.suspended_at     = null
 *   - subscriptions.suspended_by     = null
 *   - subscriptions.suspended_reason = null
 *
 * Auth: platform_admin only.
 */
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    // F171 fix (QA): inline platform_admin check → shared helper.
    // F22 single-session iat enforcement comes along for free.
    const auth = await requirePlatformAdmin(req);
    if ("error" in auth) return auth.error;
    // Finding #21 fix: same shape as #19 — destructure user.
    const { user } = auth;

    const { id: subscriptionId } = await ctx.params;
    if (!subscriptionId) {
      return NextResponse.json({ error: "subscription id is required" }, { status: 400 });
    }

    const admin = supabaseAdmin();
    const { data: sub } = await admin
      .from("subscriptions")
      .select("id, suspended_at, expires_at")
      .eq("id", subscriptionId)
      .maybeSingle();
    if (!sub) return NextResponse.json({ error: "Subscription not found" }, { status: 404 });

    // 2026-05-13 evening: when reactivating, roll `expires_at` forward by
    // the suspension duration so a "reactivated" subscription doesn't
    // immediately re-expire because the original cycle elapsed during
    // suspension. Old behaviour left expires_at in the past — admin saw
    // "active" but students still saw locked tiles via featureAccess.ts.
    const subRow = sub as { id: string; suspended_at: string | null; expires_at: string | null };
    let rolledExpiresAt: string | null = subRow.expires_at;
    if (subRow.expires_at && subRow.suspended_at) {
      const expiresMs = new Date(subRow.expires_at).getTime();
      const suspendedMs = new Date(subRow.suspended_at).getTime();
      const nowMs = Date.now();
      // Two cases the previous implementation got wrong:
      //   (a) suspended_at < expires_at (mid-cycle suspend) — original
      //       fix shifts by (now - suspended_at). Still correct.
      //   (b) suspended_at >= expires_at (suspended AFTER expiry — the
      //       common non-payment past-due case). Original skipped this
      //       branch entirely, leaving expires_at in the past so
      //       featureAccess treated the reactivated school as expired
      //       immediately. Now: roll forward to nowMs + (expiresMs
      //       - suspendedMs) which is negative-or-zero, so just snap
      //       to now and grant one extra cycle anchor via
      //       Math.max(now, expiresMs + gap).
      if (Number.isFinite(expiresMs) && Number.isFinite(suspendedMs)) {
        const gapMs = Math.max(0, nowMs - suspendedMs);
        const candidate = expiresMs + gapMs;
        // If the school was suspended AFTER expiry, expiresMs+gap still
        // lands at or before suspended_at; snap to now so the school
        // gets at minimum "reactivated NOW" as the new anchor and
        // doesn't immediately re-expire. Operators expecting a full
        // fresh cycle should call mark-paid (which sets the new term)
        // — reactivate alone restores access, not the contract.
        rolledExpiresAt = new Date(Math.max(candidate, nowMs)).toISOString();
      }
    }

    const { error: updErr } = await admin
      .from("subscriptions")
      .update({
        status: "active",
        suspended_at: null,
        suspended_by: null,
        suspended_reason: null,
        expires_at: rolledExpiresAt,
        // Audit: who unblocked the school and when. Migration 81.
        // Symmetric with suspended_at / suspended_by on the inverse path.
        reactivated_at: new Date().toISOString(),
        reactivated_by: user.id,
      })
      .eq("id", subscriptionId);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    return NextResponse.json({
      ok: true,
      subscription_id: subscriptionId,
      status: "active",
      expires_at: rolledExpiresAt,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Reactivate failed" },
      { status: 500 },
    );
  }
}
