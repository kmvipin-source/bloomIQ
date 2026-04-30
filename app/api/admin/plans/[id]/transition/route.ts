import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/admin/plans/[id]/transition
 *
 * Move a plan through the review workflow.
 * Body: { action: 'submit' | 'approve' | 'reject', reason?: string }.
 *
 * Transitions:
 *   draft           --submit--> pending_review
 *   pending_review  --approve-> active
 *                                  AND archive any prior 'active' row
 *                                  with the same slug (so /pricing only
 *                                  ever shows one active version per slug).
 *   pending_review  --reject--> archived
 *
 * Two-eyes on approve: the approver must NOT be the same person as
 * created_by. This is also enforced by a DB check constraint
 * (plans_two_eyes), but we surface a friendly error before the DB blows
 * up. submit and reject have no such restriction.
 */

async function requireAdmin(req: Request) {
  const token = getBearer(req);
  if (!token) return { err: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const sb = supabaseServer(token);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { err: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { data: me } = await sb
    .from("profiles")
    .select("platform_admin")
    .eq("id", user.id)
    .single();
  if (!me?.platform_admin) {
    return { err: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user };
}

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: RouteContext) {
  try {
    const auth = await requireAdmin(req);
    if ("err" in auth) return auth.err;
    const { id } = await ctx.params;

    const body = await req.json().catch(() => ({}));
    const action: string = String(body.action || "");
    const reason: string = String(body.reason || "");
    if (!["submit", "approve", "reject"].includes(action)) {
      return NextResponse.json({ error: "action must be submit / approve / reject" }, { status: 400 });
    }

    const admin = supabaseAdmin();
    const { data: plan } = await admin
      .from("plans")
      .select("id, slug, status, created_by")
      .eq("id", id)
      .maybeSingle();
    if (!plan) return NextResponse.json({ error: "Plan not found" }, { status: 404 });

    const now = new Date().toISOString();

    // ---------- submit: draft -> pending_review ----------
    if (action === "submit") {
      if (plan.status !== "draft") {
        return NextResponse.json(
          { error: `Only draft plans can be submitted (this one is ${plan.status}).` },
          { status: 409 }
        );
      }
      const { error } = await admin
        .from("plans")
        .update({ status: "pending_review", updated_at: now })
        .eq("id", id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      await admin.from("plan_audit").insert({
        plan_id: id,
        actor_id: auth.user.id,
        action: "submitted",
        payload: { reason },
      });
      return NextResponse.json({ ok: true, status: "pending_review" });
    }

    // ---------- reject: pending_review -> archived ----------
    if (action === "reject") {
      if (plan.status !== "pending_review") {
        return NextResponse.json(
          { error: `Only pending_review plans can be rejected (this one is ${plan.status}).` },
          { status: 409 }
        );
      }
      const { error } = await admin
        .from("plans")
        .update({ status: "archived", updated_at: now })
        .eq("id", id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      await admin.from("plan_audit").insert({
        plan_id: id,
        actor_id: auth.user.id,
        action: "rejected",
        payload: { reason },
      });
      return NextResponse.json({ ok: true, status: "archived" });
    }

    // ---------- approve: pending_review -> active ----------
    if (plan.status !== "pending_review") {
      return NextResponse.json(
        { error: `Only pending_review plans can be approved (this one is ${plan.status}).` },
        { status: 409 }
      );
    }
    if (plan.created_by === auth.user.id) {
      return NextResponse.json(
        { error: "Two-eyes principle: a different platform admin must approve a plan you submitted." },
        { status: 403 }
      );
    }

    // Archive the previous active version of the same slug so the
    // partial-unique index plans_one_active_per_slug doesn't reject the
    // new active row.
    const { error: archErr } = await admin
      .from("plans")
      .update({ status: "archived", effective_to: now, updated_at: now })
      .eq("slug", plan.slug)
      .eq("status", "active");
    if (archErr) return NextResponse.json({ error: `Could not archive prior version: ${archErr.message}` }, { status: 500 });

    const { error: actErr } = await admin
      .from("plans")
      .update({
        status: "active",
        approved_by: auth.user.id,
        approved_at: now,
        effective_from: now,
        updated_at: now,
      })
      .eq("id", id);
    if (actErr) return NextResponse.json({ error: actErr.message }, { status: 500 });

    await admin.from("plan_audit").insert({
      plan_id: id,
      actor_id: auth.user.id,
      action: "approved",
      payload: { reason },
    });
    return NextResponse.json({ ok: true, status: "active" });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Transition failed" },
      { status: 500 }
    );
  }
}
