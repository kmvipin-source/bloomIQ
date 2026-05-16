import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";

/**
 * GET /api/teacher/class-fit?class_id=...&question_ids=id1,id2,...
 *
 * Composer-side helper: when a teacher is building a test, they often want
 * to know how a candidate question set is likely to land with a specific
 * class — based purely on what that class has actually seen + how they did.
 *
 * Returns:
 *   {
 *     ok: true,
 *     class_id: string,
 *     total: number,            // # of question_ids passed in
 *     matched: number,          // # of those questions that have any
 *                               //   prior attempt by a student in this class
 *     attempts: number,         // total per-question attempts counted
 *     avg_score_pct: number|null  // mean correctness across those attempts,
 *                                 //   null if attempts === 0
 *   }
 *
 * No write side effects. Read-only. Uses supabaseAdmin() to bypass the
 * student-scoped RLS on quiz_attempts (which would otherwise prevent the
 * teacher from seeing rows for quizzes they don't own — practice mode,
 * cross-teacher use, etc).
 *
 * Authorization model:
 *   1. Caller must be authenticated.
 *   2. Caller must be a teacher of the requested class — verified via
 *      class_teachers (any role: primary / acting / co).
 * If those checks pass, the read is scoped to (a) students in this class
 * and (b) the explicit question_ids list. The teacher cannot fish for
 * data outside that scope.
 */
export async function GET(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const url = new URL(req.url);
    const classId = url.searchParams.get("class_id");
    const idsRaw = url.searchParams.get("question_ids") || "";
    const questionIds = idsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!classId) {
      return NextResponse.json({ error: "class_id is required" }, { status: 400 });
    }
    if (questionIds.length === 0) {
      return NextResponse.json({
        ok: true,
        class_id: classId,
        total: 0,
        matched: 0,
        attempts: 0,
        avg_score_pct: null,
      });
    }
    // Cap at 500 to keep the IN-list bounded — composer rarely exceeds 50.
    if (questionIds.length > 500) {
      return NextResponse.json(
        { error: "Too many question_ids (max 500)" },
        { status: 400 },
      );
    }

    const admin = supabaseAdmin();

    // -- 1. Teacher must be assigned to this class. We accept any role
    //    (primary / acting / co) since "fit for my class" is a planning
    //    affordance, not an admin action.
    const { data: ct, error: ctErr } = await admin
      .from("class_teachers")
      .select("class_id, role")
      .eq("class_id", classId)
      .eq("teacher_id", user.id)
      .maybeSingle();
    if (ctErr) {
      return NextResponse.json({ error: ctErr.message }, { status: 500 });
    }
    if (!ct) {
      return NextResponse.json(
        { error: "You are not assigned to this class." },
        { status: 403 },
      );
    }

    // -- 2. Pull student_ids in this class.
    const { data: members, error: memErr } = await admin
      .from("class_members")
      .select("student_id")
      .eq("class_id", classId);
    if (memErr) {
      return NextResponse.json({ error: memErr.message }, { status: 500 });
    }
    const studentIds = ((members as { student_id: string }[]) || []).map(
      (m) => m.student_id,
    );
    if (studentIds.length === 0) {
      return NextResponse.json({
        ok: true,
        class_id: classId,
        total: questionIds.length,
        matched: 0,
        attempts: 0,
        avg_score_pct: null,
      });
    }

    // -- 3. Pull attempt_answers for (these questions) joined with
    //    (these students). One round-trip; the join is supabase-side via
    //    the embedded relationship on quiz_attempts.
    type Row = {
      question_id: string;
      is_correct: boolean | null;
      quiz_attempts: { student_id: string } | null;
    };
    const { data: ans, error: aErr } = await admin
      .from("attempt_answers")
      .select("question_id, is_correct, quiz_attempts!inner(student_id)")
      .in("question_id", questionIds)
      .in("quiz_attempts.student_id", studentIds);
    if (aErr) {
      return NextResponse.json({ error: aErr.message }, { status: 500 });
    }

    const rows = (ans as unknown as Row[]) || [];

    const matchedSet = new Set<string>();
    let attempts = 0;
    let correct = 0;
    for (const r of rows) {
      // Defensive: the !inner join should already filter, but skip if the
      // embedded row is absent (shouldn't happen, but supabase-js can do
      // surprising things on schema drift).
      if (!r.quiz_attempts) continue;
      matchedSet.add(r.question_id);
      attempts += 1;
      if (r.is_correct) correct += 1;
    }

    const avg_score_pct =
      attempts === 0 ? null : Math.round((correct / attempts) * 1000) / 10; // 1 decimal

    return NextResponse.json({
      ok: true,
      class_id: classId,
      total: questionIds.length,
      matched: matchedSet.size,
      attempts,
      avg_score_pct,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to compute class fit" },
      { status: 500 },
    );
  }
}
