import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/admin/subscriptions/[id]/suspend
 *
 * Deactivate a school subscription for non-payment (or any other reason).
 * Feature access stops immediately, but ZERO data is touched: classes,
 * students, teachers, tests, attempts, the invoice itself — everything
 * stays exactly as it was. Re-activation via /reactivate or via
 * mark-paid restores access without any data restoration.
 *
 * Body (optional):
 *   {
 *     reason?: string,    // free-text audit note (e.g. "30 days past due")
 *   }
 *
 * On success:
 *   - subscriptions.status            = 'suspended'
 *   - subscriptions.suspended_at      = server now()
 *   - subscriptions.suspended_by      = auth.uid()
 *   - subscriptions.suspended_reason  = body.reason (if given)
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

    const body = await req.json().catch(() => ({}));
    const reason: string | null =
      typeof body.reason === "string" && body.reason.trim()
        ? body.reason.trim().slice(0, 500)
        : null;

    const admin = supabaseAdmin();
    const { data: sub } = await admin
      .from("subscriptions")
      .select("id, status")
      .eq("id", subscriptionId)
      .maybeSingle();
    if (!sub) return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
    if (sub.status === "suspended") {
      return NextResponse.json({ error: "Already suspended" }, { status: 400 });
    }

    // Idempotent under concurrent admin clicks: filter the UPDATE on
    // status != 'suspended' so a second racing call no-ops cleanly and
    // doesn't overwrite the winning admin's suspended_by / reason.
    // .select() lets us detect whether THIS call actually flipped the
    // row vs. lost the race (in which case we re-read and surface the
    // winning state).
    const nowIso = new Date().toISOString();
    const { data: updatedRow, error: updErr } = await admin
      .from("subscriptions")
      .update({
        status: "suspended",
        suspended_at: nowIso,
        suspended_by: user.id,
        suspended_reason: reason,
      })
      .eq("id", subscriptionId)
      .neq("status", "suspended")
      .select("id, status, suspended_at, suspended_by, suspended_reason")
      .maybeSingle();
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    if (!updatedRow) {
      const { data: current } = await admin
        .from("subscriptions")
        .select("status, suspended_at, suspended_by, suspended_reason")
        .eq("id", subscriptionId)
        .maybeSingle();
      return NextResponse.json({
        ok: true,
        subscription_id: subscriptionId,
        already_suspended: true,
        ...(current ?? {}),
      });
    }

    return NextResponse.json({
      ok: true,
      subscription_id: subscriptionId,
      status: "suspended",
      suspended_at: new Date().toISOString(),
      suspended_by: user.id,
      suspended_reason: reason,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Suspend failed" },
      { status: 500 },
    );
  }
}
