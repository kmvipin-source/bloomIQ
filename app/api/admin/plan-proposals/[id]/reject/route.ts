import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAdmin } from "../../route";

export const runtime = "nodejs";

/**
 * /api/admin/plan-proposals/[id]/reject
 *
 * Rejects an OPEN proposal. Reason is required (per design); the DB
 * constraint `proposals_rejected_needs_reason` enforces this at row level
 * and we mirror the check at API for a friendlier error.
 *
 * Self-rejection (creator rejects their own draft) is allowed — it's
 * effectively the same as withdrawing, and an admin might prefer the
 * "rejected with reason" trail over a withdrawal. UI typically routes
 * creators to the withdraw button instead.
 *
 * Body: { reason: string }
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: RouteContext) {
  try {
    const auth = await requireAdmin(req);
    if ("err" in auth) return auth.err;
    const { id } = await ctx.params;

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) {
      return NextResponse.json(
        { error: "Rejection reason is required." },
        { status: 400 },
      );
    }
    if (reason.length > 2000) {
      return NextResponse.json(
        { error: "Rejection reason must be ≤ 2000 chars." },
        { status: 400 },
      );
    }

    const admin = supabaseAdmin();
    const { data: proposal } = await admin
      .from("plan_change_proposals")
      .select("id, status")
      .eq("id", id)
      .maybeSingle();
    if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
    if (proposal.status !== "open") {
      return NextResponse.json(
        { error: `Proposal is ${proposal.status}; only 'open' proposals can be rejected.` },
        { status: 409 },
      );
    }

    const now = new Date().toISOString();
    const { data: updated, error: updErr } = await admin
      .from("plan_change_proposals")
      .update({
        status: "rejected",
        rejected_by: auth.user.id,
        rejected_at: now,
        rejection_reason: reason,
      })
      .eq("id", id)
      .select()
      .single();
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, proposal: updated });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Reject failed" },
      { status: 500 },
    );
  }
}
