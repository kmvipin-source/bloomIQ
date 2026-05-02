import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/student/missed-assignments
 *
 * Returns assignments the student should have done but didn't:
 *   - due_at is in the past
 *   - the student has no submitted quiz_attempts row
 * Each row also includes any active retake request status so the UI can
 * disable the "Request" button when one is already pending or decided.
 */
export async function GET(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const admin = supabaseAdmin();

    // 1) classes the student belongs to.
    const { data: cm } = await admin
      .from("class_members")
      .select("class_id")
      .eq("student_id", user.id);
    const classIds = (cm || []).map((r) => r.class_id);

    // 2) assignments — direct (student_id) OR class-wide (class_id IN classIds).
    const direct = await admin
      .from("quiz_assignments")
      .select("id, quiz_id, class_id, student_id, assigned_by, due_at")
      .eq("student_id", user.id)
      .lt("due_at", new Date().toISOString());
    const klass = classIds.length
      ? await admin
          .from("quiz_assignments")
          .select("id, quiz_id, class_id, student_id, assigned_by, due_at")
          .in("class_id", classIds)
          .lt("due_at", new Date().toISOString())
      : { data: [] as { id: string; quiz_id: string; class_id: string | null; student_id: string | null; assigned_by: string; due_at: string }[] };
    const all = [...(direct.data || []), ...(klass.data || [])];

    // De-dupe by id.
    const byId = new Map(all.map((a) => [a.id, a]));
    const assignments = Array.from(byId.values());

    if (!assignments.length) return NextResponse.json({ ok: true, items: [] });

    // 3) attempts for those quizzes by this student — anything submitted
    //    is no longer "missed".
    const quizIds = Array.from(new Set(assignments.map((a) => a.quiz_id)));
    const { data: attempts } = await admin
      .from("quiz_attempts")
      .select("quiz_id, submitted_at")
      .eq("student_id", user.id)
      .in("quiz_id", quizIds)
      .not("submitted_at", "is", null);
    const submittedQuiz = new Set((attempts || []).map((a) => a.quiz_id));

    // 4) any existing retake requests for these assignments.
    const { data: requests } = await admin
      .from("quiz_retake_requests")
      .select("id, assignment_id, status, decision_note, created_at")
      .eq("student_id", user.id)
      .in("assignment_id", assignments.map((a) => a.id));
    const reqByAssignment = new Map((requests || []).map((r) => [r.assignment_id as string, r]));

    // 5) quiz metadata.
    const { data: quizzes } = await admin
      .from("quizzes")
      .select("id, name, code, time_limit_minutes")
      .in("id", quizIds);
    const qMap = new Map((quizzes || []).map((q) => [q.id as string, q]));

    // 6) teacher (assigned_by) name for context.
    const teacherIds = Array.from(new Set(assignments.map((a) => a.assigned_by).filter(Boolean)));
    const { data: tProfiles } = teacherIds.length
      ? await admin.from("profiles").select("id, full_name").in("id", teacherIds)
      : { data: [] as { id: string; full_name: string | null }[] };
    const tMap = new Map((tProfiles || []).map((p) => [p.id as string, p.full_name as string | null]));

    const items = assignments
      .filter((a) => !submittedQuiz.has(a.quiz_id))
      .map((a) => ({
        assignment_id: a.id,
        quiz: qMap.get(a.quiz_id) || { id: a.quiz_id, name: "—", code: "—" },
        due_at: a.due_at,
        teacher_name: (a.assigned_by && tMap.get(a.assigned_by)) || "Teacher",
        request: reqByAssignment.get(a.id)
          ? {
              id: (reqByAssignment.get(a.id) as { id: string }).id,
              status: (reqByAssignment.get(a.id) as { status: string }).status,
              decision_note: (reqByAssignment.get(a.id) as { decision_note: string | null }).decision_note,
            }
          : null,
      }))
      .sort((a, b) => (a.due_at < b.due_at ? 1 : -1));

    return NextResponse.json({ ok: true, items });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
