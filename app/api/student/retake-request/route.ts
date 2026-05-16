import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";

/**
 * POST /api/student/retake-request
 *
 * Body: { assignment_id: string, note?: string }
 *
 * Creates a pending request to take a missed quiz late. Routes to whoever
 * created the assignment (primary teacher OR co-teacher), via
 * quiz_assignments.assigned_by — so the right person sees the request.
 */
export async function POST(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const body = await req.json().catch(() => ({}));
    const assignmentId = String(body.assignment_id || "");
    const note = String(body.note || "").trim().slice(0, 500);
    if (!assignmentId) return NextResponse.json({ error: "assignment_id required" }, { status: 400 });

    // Read the assignment via admin to bypass any read-policy gaps; we
    // re-check authorization below.
    const admin = supabaseAdmin();
    const { data: a } = await admin
      .from("quiz_assignments")
      .select("id, quiz_id, class_id, student_id, assigned_by, due_at")
      .eq("id", assignmentId)
      .maybeSingle();
    if (!a) return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
    if (!a.assigned_by) return NextResponse.json({ error: "Assignment has no creator on file." }, { status: 400 });

    // Caller must be the assignee (direct) or a member of the assignment's
    // class. Otherwise they can't request a retake of someone else's quiz.
    let isMember = a.student_id === user.id;
    if (!isMember && a.class_id) {
      const { data: m } = await admin
        .from("class_members")
        .select("student_id")
        .eq("class_id", a.class_id)
        .eq("student_id", user.id)
        .maybeSingle();
      isMember = !!m;
    }
    if (!isMember) return NextResponse.json({ error: "Not your assignment." }, { status: 403 });

    // Insert through the user-scoped client so RLS gets exercised and the
    // student_id check fires.
    const { data: created, error: insErr } = await sb
      .from("quiz_retake_requests")
      .insert({
        assignment_id: a.id,
        quiz_id: a.quiz_id,
        student_id: user.id,
        teacher_id: a.assigned_by,
        note,
      })
      .select("id, status, created_at")
      .single();
    if (insErr) {
      // Unique-violation → existing pending request.
      if ((insErr as { code?: string }).code === "23505") {
        return NextResponse.json({ error: "You already have a pending request for this quiz." }, { status: 409 });
      }
      return NextResponse.json({ error: insErr.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, request: created });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
