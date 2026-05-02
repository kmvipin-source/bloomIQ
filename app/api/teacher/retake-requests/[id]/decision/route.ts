import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const EXTEND_DAYS_ON_APPROVE = 7;

/**
 * POST /api/teacher/retake-requests/[id]/decision
 *
 * Body: { decision: 'approve' | 'deny', note?: string }
 *
 * Approval extends the assignment's due_at by EXTEND_DAYS_ON_APPROVE so
 * the student can sit the quiz now. Denial just closes the request.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const decision = String(body.decision || "");
    const note = String(body.note || "").trim().slice(0, 500);
    if (decision !== "approve" && decision !== "deny") {
      return NextResponse.json({ error: "decision must be 'approve' or 'deny'" }, { status: 400 });
    }

    // RLS-scoped read so teachers only see their own requests.
    const { data: r, error: rErr } = await sb
      .from("quiz_retake_requests")
      .select("id, assignment_id, status")
      .eq("id", id)
      .maybeSingle();
    if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 });
    if (!r) return NextResponse.json({ error: "Request not found" }, { status: 404 });
    if (r.status !== "pending") return NextResponse.json({ error: "Request already decided." }, { status: 409 });

    const newStatus = decision === "approve" ? "approved" : "denied";
    const { error: upErr } = await sb
      .from("quiz_retake_requests")
      .update({
        status: newStatus,
        decision_note: note || null,
        decided_at: new Date().toISOString(),
        decided_by: user.id,
      })
      .eq("id", id);
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

    if (decision === "approve") {
      // The teacher can pass a specific new_due_at (ISO datetime) on
      // approval — typically picked from a date+time input in the UI.
      // If they don't (legacy callers, simple "approve" path), fall
      // back to "+7 days from now" so behaviour stays the same as
      // before this change.
      const reqDue = typeof body?.new_due_at === "string" ? body.new_due_at : "";
      let newDue: string;
      if (reqDue) {
        const t = Date.parse(reqDue);
        if (Number.isNaN(t) || t <= Date.now()) {
          return NextResponse.json(
            { error: "new_due_at must be a future date/time." },
            { status: 400 },
          );
        }
        newDue = new Date(t).toISOString();
      } else {
        newDue = new Date(Date.now() + EXTEND_DAYS_ON_APPROVE * 86400000).toISOString();
      }

      // Extend the assignment's due_at via admin so we don't depend on
      // the teacher having direct UPDATE rights through RLS on
      // quiz_assignments.
      const admin = supabaseAdmin();
      await admin.from("quiz_assignments").update({ due_at: newDue }).eq("id", r.assignment_id);
    }

    return NextResponse.json({ ok: true, status: newStatus });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
