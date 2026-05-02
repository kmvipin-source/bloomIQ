import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/teacher/retake-requests
 *
 * Lists requests routed to the calling teacher. Joins quiz/student names
 * via the admin client so the teacher gets readable rows even when the
 * caller's RLS doesn't independently expose that quiz/student.
 */
export async function GET(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Teacher reads via RLS-respecting client (teacher_id = auth.uid()).
    const { data: rows, error } = await sb
      .from("quiz_retake_requests")
      .select("id, assignment_id, quiz_id, student_id, note, status, decision_note, created_at, decided_at")
      .eq("teacher_id", user.id)
      .order("created_at", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    if (!rows?.length) return NextResponse.json({ ok: true, requests: [] });

    const admin = supabaseAdmin();
    const quizIds = Array.from(new Set(rows.map((r) => r.quiz_id)));
    const studentIds = Array.from(new Set(rows.map((r) => r.student_id)));
    const [{ data: quizzes }, { data: students }] = await Promise.all([
      admin.from("quizzes").select("id, name, code").in("id", quizIds),
      admin.from("profiles").select("id, full_name").in("id", studentIds),
    ]);
    const qMap = new Map((quizzes || []).map((q) => [q.id as string, q]));
    const sMap = new Map((students || []).map((s) => [s.id as string, s.full_name as string | null]));

    const enriched = rows.map((r) => ({
      id: r.id,
      assignment_id: r.assignment_id,
      status: r.status,
      note: r.note,
      decision_note: r.decision_note,
      created_at: r.created_at,
      decided_at: r.decided_at,
      quiz: qMap.get(r.quiz_id) || { id: r.quiz_id, name: "—", code: "—" },
      student_name: sMap.get(r.student_id) || "Student",
    }));
    return NextResponse.json({ ok: true, requests: enriched });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
