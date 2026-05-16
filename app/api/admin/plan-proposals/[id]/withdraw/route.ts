import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAdmin } from "../../route";

export const runtime = "nodejs";

/**
 * /api/admin/plan-proposals/[id]/withdraw
 *
 * Creator pulls back their own OPEN proposal. Distinct from rejection —
 * withdrawal carries no negative connotation in the audit log; it's just
 * "I changed my mind / found a bug in my draft".
 *
 * Only the original creator can withdraw their own proposal. Other admins
 * who want it gone use /reject (with a reason).
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: RouteContext) {
  try {
    const auth = await requireAdmin(req);
    if ("error" in auth) return auth.error;
    const { id } = await ctx.params;

    const admin = supabaseAdmin();
    const { data: proposal } = await admin
      .from("plan_change_proposals")
      .select("id, status, created_by")
      .eq("id", id)
      .maybeSingle();
    if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
    if (proposal.status !== "open") {
      return NextResponse.json(
        { error: `Proposal is ${proposal.status}; only 'open' proposals can be withdrawn.` },
        { status: 409 },
      );
    }
    if (proposal.created_by !== auth.user.id) {
      return NextResponse.json(
        {
          error:
            "Only the creator can withdraw their own proposal. Other admins should reject with a reason.",
        },
        { status: 403 },
      );
    }

    const now = new Date().toISOString();
    const { data: updated, error: updErr } = await admin
      .from("plan_change_proposals")
      .update({ status: "withdrawn", withdrawn_at: now })
      .eq("id", id)
      .select()
      .single();
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, proposal: updated });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Withdraw failed" },
      { status: 500 },
    );
  }
}
