import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAdmin, validatePayload } from "../route";
import type { PlanChangeProposal, PlanProposalPayload } from "@/lib/types";

export const runtime = "nodejs";

/**
 * /api/admin/plan-proposals/[id]
 *
 * GET   — single proposal hydrated with target + parent plan snapshots so
 *         the UI can render the side-by-side diff without a second hop.
 * PATCH — update an OPEN proposal's `proposed` payload. Used in two
 *         scenarios:
 *           a) creator iterating on their own draft before anyone reviews
 *           b) approver editing the payload as part of "edit-and-approve"
 *              (in that case the approver calls /approve, not PATCH —
 *              approver-edit-during-approve is handled by /approve so we
 *              snapshot the original submission atomically)
 *         PATCH is therefore creator-only and refuses if status !== 'open'.
 *
 * Auth: caller must be platform_admin.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: RouteContext) {
  try {
    const auth = await requireAdmin(req);
    if ("error" in auth) return auth.error;
    const { id } = await ctx.params;

    const admin = supabaseAdmin();
    const { data: proposal, error } = await admin
      .from("plan_change_proposals")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

    const p = proposal as PlanChangeProposal;

    // Hydrate target + parent plans for the diff view. Target is the
    // "left side" baseline for kind='edit'; for kind='create' there's no
    // target so the diff renders proposed vs. an empty/default Plan shape.
    const planIdsToFetch: string[] = [];
    if (p.target_plan_id) planIdsToFetch.push(p.target_plan_id);
    if (p.parent_plan_id) planIdsToFetch.push(p.parent_plan_id);

    let target = null;
    let parent = null;
    if (planIdsToFetch.length > 0) {
      const { data: plans } = await admin
        .from("plans")
        .select("*")
        .in("id", planIdsToFetch);
      const byId = new Map((plans || []).map((row) => [row.id, row]));
      if (p.target_plan_id) target = byId.get(p.target_plan_id) || null;
      if (p.parent_plan_id) parent = byId.get(p.parent_plan_id) || null;
    }

    // Hydrate creator + approver names for the queue UI / detail header.
    const userIds = new Set<string>();
    userIds.add(p.created_by);
    if (p.approved_by) userIds.add(p.approved_by);
    if (p.rejected_by) userIds.add(p.rejected_by);
    const profSummaries = new Map<string, string | null>();
    if (userIds.size > 0) {
      const { data: profs } = await admin
        .from("profiles")
        .select("id, full_name")
        .in("id", Array.from(userIds));
      for (const pr of (profs as Array<{ id: string; full_name: string | null }>) || []) {
        profSummaries.set(pr.id, pr.full_name);
      }
    }

    // Bootstrap-mode visibility: tell the client whether the current user
    // is allowed to self-approve (single-admin org). The UI uses this to
    // enable the "Approve" button on a draft the same admin created.
    const { count: adminCount } = await admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("platform_admin", true);
    const bootstrap_mode = (adminCount ?? 0) <= 1;

    return NextResponse.json({
      ok: true,
      proposal: {
        ...p,
        target_plan: target,
        parent_plan: parent,
        created_by_name: profSummaries.get(p.created_by) || null,
        approved_by_name: p.approved_by ? profSummaries.get(p.approved_by) || null : null,
        rejected_by_name: p.rejected_by ? profSummaries.get(p.rejected_by) || null : null,
      },
      bootstrap_mode,
      current_user_id: auth.user.id,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Fetch failed" },
      { status: 500 },
    );
  }
}

/**
 * Body: { proposed: PlanProposalPayload }
 *
 * Only the original creator can PATCH their own draft. Approvers update
 * the payload via /approve (which atomically snapshots the original
 * submission to `proposed_at_submit` and stamps `approved_with_edits`).
 */
export async function PATCH(req: Request, ctx: RouteContext) {
  try {
    const auth = await requireAdmin(req);
    if ("error" in auth) return auth.error;
    const { id } = await ctx.params;

    const admin = supabaseAdmin();
    const { data: proposal } = await admin
      .from("plan_change_proposals")
      .select("id, kind, status, created_by")
      .eq("id", id)
      .maybeSingle();
    if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

    if (proposal.status !== "open") {
      return NextResponse.json(
        { error: `Proposal is ${proposal.status}; only 'open' proposals can be edited.` },
        { status: 409 },
      );
    }
    if (proposal.created_by !== auth.user.id) {
      return NextResponse.json(
        { error: "Only the creator can edit their own draft. Approvers should use the Approve action with edits." },
        { status: 403 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const proposedRaw =
      typeof body.proposed === "object" && body.proposed !== null
        ? (body.proposed as Record<string, unknown>)
        : {};
    const v = validatePayload(proposedRaw, proposal.kind as "edit" | "create");
    if (!v.ok) return NextResponse.json({ error: (v as unknown as { error: string }).error }, { status: 400 });

    const { data: updated, error: updErr } = await admin
      .from("plan_change_proposals")
      .update({ proposed: v.payload as PlanProposalPayload })
      .eq("id", id)
      .select()
      .single();
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, proposal: updated });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Update failed" },
      { status: 500 },
    );
  }
}
