import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

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
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat ≥ profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    // F109 fix: also count via service role so the UI can distinguish
    // "no requests" from "RLS is hiding requests" (the latter signals
    // a stale class_teachers membership).
    const [{ data: rows, error }, { count: adminCount }] = await Promise.all([
      sb
        .from("quiz_retake_requests")
        .select("id, assignment_id, quiz_id, student_id, note, status, decision_note, created_at, decided_at")
        .eq("teacher_id", user.id)
        .order("created_at", { ascending: false }),
      supabaseAdmin()
        .from("quiz_retake_requests")
        .select("id", { count: "exact", head: true })
        .eq("teacher_id", user.id),
    ]);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    if (!rows?.length) {
      const rlsHidden = (adminCount ?? 0) > 0;
      return NextResponse.json({
        ok: true,
        requests: [],
        rls_hidden: rlsHidden,
        hint: rlsHidden ? "Your retake requests are hidden by RLS — check your class_teachers membership." : undefined,
      });
    }

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
