import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAdmin, validatePayload } from "../../route";
import type { PlanProposalPayload } from "@/lib/types";

export const runtime = "nodejs";

/**
 * /api/admin/plan-proposals/[id]/approve
 *
 * Atomically applies the proposal's payload to the live `plans` table,
 * stamping the proposal as approved.
 *
 * Body (optional): { proposed: PlanProposalPayload }
 *   - If omitted (or matches current payload), this is "approve as-is".
 *   - If present and DIFFERENT, this is "edit-and-approve":
 *       - the original submission is snapshotted to `proposed_at_submit`
 *       - `proposed` is overwritten with the approver's edits
 *       - `approved_with_edits = true`
 *       - this is the only way an approver mutates the payload; PATCH
 *         is creator-only by design (see [id]/route.ts comment).
 *
 * Two-eyes enforcement:
 *   - If 2+ platform admins exist: caller MUST be != proposal.created_by.
 *     Self-approval returns 403.
 *   - If exactly 1 admin (bootstrap): self-approval is allowed,
 *     `bootstrap_self_approve = true` flagged on the proposal,
 *     `plans.approved_by` written as NULL on the live row to satisfy the
 *     `plans_two_eyes` CHECK constraint. The proposal record carries the
 *     real approver identity.
 *
 * Apply semantics:
 *   - kind='edit': UPDATE plans WHERE id = target_plan_id.
 *     Stamps approved_by/approved_at, leaves created_by/effective_from intact.
 *   - kind='create': INSERT INTO plans, status='active'.
 *     Stamps created_by, approved_by, approved_at, effective_from = now().
 *
 * On success returns the updated proposal AND the resulting plan row, so
 * the UI can confirm the live catalogue state.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: RouteContext) {
  try {
    const auth = await requireAdmin(req);
    if ("err" in auth) return auth.err;
    const { id } = await ctx.params;

    const admin = supabaseAdmin();
    const { data: proposal } = await admin
      .from("plan_change_proposals")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
    if (proposal.status !== "open") {
      return NextResponse.json(
        { error: `Proposal is ${proposal.status}; only 'open' proposals can be approved.` },
        { status: 409 },
      );
    }

    // Two-eyes check.
    const { count: adminCount } = await admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("platform_admin", true);
    const bootstrap_mode = (adminCount ?? 0) <= 1;
    const isSelfApproval = proposal.created_by === auth.user.id;

    if (isSelfApproval && !bootstrap_mode) {
      return NextResponse.json(
        {
          error:
            "Self-approval is blocked: another platform admin must approve this proposal. (Two-eyes principle.)",
        },
        { status: 403 },
      );
    }

    // Resolve the final payload — approver may be editing.
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    let approvedPayload: PlanProposalPayload = proposal.proposed;
    let approvedWithEdits = false;
    let proposedAtSubmit: PlanProposalPayload | null = null;

    if (
      body.proposed &&
      typeof body.proposed === "object" &&
      body.proposed !== null
    ) {
      const v = validatePayload(body.proposed as Record<string, unknown>, proposal.kind);
      if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
      // Detect actual change vs. current proposed (deep-equal via JSON).
      if (JSON.stringify(v.payload) !== JSON.stringify(proposal.proposed)) {
        approvedPayload = v.payload;
        approvedWithEdits = true;
        proposedAtSubmit = proposal.proposed;
      }
    }

    // For edits, re-verify target is still active (concurrency safety).
    if (proposal.kind === "edit") {
      const { data: target } = await admin
        .from("plans")
        .select("id, status")
        .eq("id", proposal.target_plan_id)
        .maybeSingle();
      if (!target) {
        return NextResponse.json(
          { error: "Target plan no longer exists. Cannot apply this edit." },
          { status: 410 },
        );
      }
      if (target.status !== "active") {
        return NextResponse.json(
          { error: `Target plan is ${target.status}; cannot apply edit.` },
          { status: 409 },
        );
      }
    }

    // For creates, re-check slug uniqueness right before apply (live plans
    // could've been added since the proposal was opened).
    if (proposal.kind === "create" && approvedPayload.slug) {
      const { data: clash } = await admin
        .from("plans")
        .select("id")
        .eq("slug", approvedPayload.slug)
        .maybeSingle();
      if (clash) {
        return NextResponse.json(
          {
            error: `Slug "${approvedPayload.slug}" is now taken by another plan. Edit this proposal's slug or reject it.`,
          },
          { status: 409 },
        );
      }
    }

    const now = new Date().toISOString();

    // Compute the row written to `plans`. In bootstrap mode we write
    // NULL approved_by to satisfy the existing plans_two_eyes CHECK
    // (constraint forbids approved_by = created_by). The proposal row
    // captures the real approver identity for audit.
    const planApprovedBy = bootstrap_mode && isSelfApproval ? null : auth.user.id;

    let resultingPlanId: string;
    let resultingPlan: Record<string, unknown> | null = null;

    if (proposal.kind === "edit") {
      // Whitelist editable fields — slug + tier are immutable post-creation.
      const updates: Record<string, unknown> = {
        label: approvedPayload.label,
        blurb: approvedPayload.blurb,
        feature_summary: approvedPayload.feature_summary,
        price_paise: approvedPayload.price_paise,
        currency: approvedPayload.currency,
        period_days: approvedPayload.period_days,
        features: approvedPayload.features,
        pricing_model: approvedPayload.pricing_model,
        per_student_price_paise: approvedPayload.per_student_price_paise,
        min_students: approvedPayload.min_students,
        max_students: approvedPayload.max_students,
        razorpay_plan_id: approvedPayload.razorpay_plan_id ?? null,
        approved_by: planApprovedBy,
        approved_at: now,
        updated_at: now,
      };

      const { data: updated, error: updErr } = await admin
        .from("plans")
        .update(updates)
        .eq("id", proposal.target_plan_id)
        .select()
        .single();
      if (updErr) {
        const msg = updErr.message.toLowerCase().includes("plans_two_eyes")
          ? "Two-eyes constraint blocked the apply: approved_by cannot equal created_by. Are you trying to self-approve outside bootstrap mode?"
          : updErr.message;
        return NextResponse.json({ error: msg }, { status: 500 });
      }
      resultingPlanId = updated.id;
      resultingPlan = updated;
    } else {
      // kind='create': INSERT a new active plan row.
      const insertRow: Record<string, unknown> = {
        slug: approvedPayload.slug,
        tier: approvedPayload.tier,
        label: approvedPayload.label,
        blurb: approvedPayload.blurb,
        feature_summary: approvedPayload.feature_summary,
        price_paise: approvedPayload.price_paise,
        currency: approvedPayload.currency,
        period_days: approvedPayload.period_days,
        features: approvedPayload.features,
        pricing_model: approvedPayload.pricing_model,
        per_student_price_paise: approvedPayload.per_student_price_paise,
        min_students: approvedPayload.min_students,
        max_students: approvedPayload.max_students,
        razorpay_plan_id: approvedPayload.razorpay_plan_id ?? null,
        status: "active",
        effective_from: now,
        created_by: proposal.created_by,
        approved_by: planApprovedBy,
        approved_at: now,
      };

      const { data: inserted, error: insErr } = await admin
        .from("plans")
        .insert(insertRow)
        .select()
        .single();
      if (insErr) {
        const msg = insErr.message.toLowerCase().includes("plans_two_eyes")
          ? "Two-eyes constraint blocked the apply (creator and approver are the same outside bootstrap mode)."
          : insErr.message.toLowerCase().includes("unique")
          ? `Slug "${approvedPayload.slug}" is already taken. Edit this proposal or reject it.`
          : insErr.message;
        return NextResponse.json({ error: msg }, { status: 500 });
      }
      resultingPlanId = inserted.id;
      resultingPlan = inserted;
    }

    // Stamp the proposal as approved.
    const proposalUpdate: Record<string, unknown> = {
      status: "approved",
      approved_by: auth.user.id,
      approved_at: now,
      approved_with_edits: approvedWithEdits,
      bootstrap_self_approve: bootstrap_mode && isSelfApproval,
      proposed: approvedPayload,
    };
    if (proposedAtSubmit) proposalUpdate.proposed_at_submit = proposedAtSubmit;

    const { data: stamped, error: stampErr } = await admin
      .from("plan_change_proposals")
      .update(proposalUpdate)
      .eq("id", id)
      .select()
      .single();
    if (stampErr) {
      // Rare: plans was mutated but the proposal stamp failed. Surface it
      // honestly so the admin can either retry-stamp or chase manually.
      return NextResponse.json(
        {
          error: `Plan was applied (id=${resultingPlanId}) but stamping the proposal failed: ${stampErr.message}`,
          partial: true,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, proposal: stamped, plan: resultingPlan });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Approve failed" },
      { status: 500 },
    );
  }
}
