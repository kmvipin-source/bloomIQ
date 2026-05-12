import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

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
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { data: me } = await sb
      .from("profiles")
      .select("platform_admin")
      .eq("id", user.id)
      .maybeSingle();
    if (!me?.platform_admin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id: subscriptionId } = await ctx.params;
    if (!subscriptionId) {
      return NextResponse.json({ error: "subscription id is required" }, { status: 400 });
    }

    const admin = supabaseAdmin();
    const { data: sub } = await admin
      .from("subscriptions")
      .select("id")
      .eq("id", subscriptionId)
      .maybeSingle();
    if (!sub) return NextResponse.json({ error: "Subscription not found" }, { status: 404 });

    const { error: updErr } = await admin
      .from("subscriptions")
      .update({
        status: "active",
        suspended_at: null,
        suspended_by: null,
        suspended_reason: null,
      })
      .eq("id", subscriptionId);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    return NextResponse.json({
      ok: true,
      subscription_id: subscriptionId,
      status: "active",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Reactivate failed" },
      { status: 500 },
    );
  }
}
