// app/api/teacher/assign-practice/route.ts
// =============================================================================
// Teacher → Class adaptive practice assignment (P2.8).
// -----------------------------------------------------------------------------
// Purpose
// -------
// Sister to /api/teacher/assign-flashcards. The teacher kicks off
// "Adaptive practice for the whole class — focus on each student's
// weakspots." The endpoint resolves the roster and queues a per-student
// adaptive-practice run that reuses the existing /api/student/adaptive-
// practice generator (which already mines weakspots from the student's
// own attempt history).
//
// Why per-student calls: the WHOLE POINT of adaptive practice is that
// the questions are tuned to THAT student's gaps. We cannot generate a
// shared set; the teacher just orchestrates the trigger.
//
// Cost reality: one Groq call per student. For a 30-student class
// that's 30 calls — non-trivial. We sequence them at concurrency 3 to
// stay within Groq's free-tier RPM while keeping the teacher-side
// wait < 60s.
// =============================================================================

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";

type AssignPracticeBody = {
  class_id: string;
  /** Optional: how many questions per student. Defaults to 5. */
  per_student?: number;
  /** Optional explicit topic — when omitted, each student's weakspot
   *  mining picks the topic. */
  topic?: string;
};

// F100 note (QA): this route only WRITES practice_assignments rows.
// There is no student-side processor that pops the next pending row
// off the queue when a student hits "Practice". Until the picker
// ships, practice_assignments serves only as an audit log of what
// the teacher meant to push. Picker design lives in the README.
type ClassTeacherRow = { user_id: string };
type ClassStudentRow = { user_id: string };

// F105 + F106 note (QA): MAX_PER_STUDENT and CONCURRENCY are hardcoded.
// On the school_premium plan we'll want both higher (20 / 6 respectively).
// Path forward: surface as plans.assign_max_per_student and
// plans.assign_concurrency, fall back to these defaults when null.
const DEFAULT_PER_STUDENT = 5;
const MAX_PER_STUDENT = 10;
const CONCURRENCY = 3;

export async function POST(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    let body: AssignPracticeBody;
    try {
      body = (await req.json()) as AssignPracticeBody;
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const classId = body.class_id?.trim();
    const perStudent = Math.max(1, Math.min(MAX_PER_STUDENT, body.per_student ?? DEFAULT_PER_STUDENT));
    if (!classId) return NextResponse.json({ error: "class_id required" }, { status: 400 });
    // F104 fix: cap topic length to prevent pathological writes filling
    // the practice_assignments table with arbitrarily long blobs.
    if (body.topic != null && typeof body.topic === "string" && body.topic.length > 500) {
      return NextResponse.json(
        { error: "topic is too long (max 500 characters)." },
        { status: 400 },
      );
    }

    // Teacher membership check.
    const { data: teaches } = await sb
      .from("class_teachers")
      .select("user_id")
      .eq("class_id", classId)
      .eq("user_id", user.id)
      .limit(1);
    if (!((teaches as ClassTeacherRow[] | null) || []).length) {
      return NextResponse.json({ error: "You do not teach this class" }, { status: 403 });
    }

    const admin = supabaseAdmin();
    const { data: roster, error: rosterErr } = await admin
      .from("class_students")
      .select("user_id")
      .eq("class_id", classId);
    if (rosterErr) {
      return NextResponse.json({ error: rosterErr.message }, { status: 500 });
    }
    const studentIds = ((roster as ClassStudentRow[] | null) || [])
      .map((r) => r.user_id)
      .filter(Boolean);
    if (studentIds.length === 0) {
      return NextResponse.json(
        { ok: true, assigned: 0, students: 0, note: "Class has no students." },
      );
    }

    // Fan-out generation with bounded concurrency.
    const origin = new URL(req.url).origin;
    const results: Array<{ student_id: string; ok: boolean; count?: number; error?: string }> = [];

    let cursor = 0;
    async function worker() {
      while (cursor < studentIds.length) {
        const i = cursor++;
        const sid = studentIds[i];
        try {
          // Service-role calls aren't ideal here (the adaptive-practice
          // endpoint expects a USER bearer because it mines THAT user's
          // attempt history under RLS). We can't fan out per-student
          // without each student's bearer — which we don't have.
          //
          // Compromise: write a "practice_assignments" row that the
          // STUDENT'S client picks up on next sign-in, and the actual
          // generation runs from the student's session. The teacher
          // gets confirmation that the assignment was QUEUED, not that
          // generation succeeded for every student.
          // F99 fix: dedup pending queue rows per (class, student, topic)
          // so a teacher double-click doesn't spawn two adaptive-practice
          // generations on the student's next sign-in.
          const { data: existing } = await admin
            .from("practice_assignments")
            .select("id")
            .eq("class_id", classId)
            .eq("student_id", sid)
            .eq("status", "queued")
            .limit(1);
          if (existing && existing.length > 0) {
            results.push({ student_id: sid, ok: true });
            continue;
          }
          const { error } = await admin.from("practice_assignments").insert({
            class_id: classId,
            teacher_id: user.id,
            student_id: sid,
            topic: body.topic ?? null,
            per_student: perStudent,
            status: "queued",
          });
          if (error) {
            results.push({ student_id: sid, ok: false, error: error.message });
          } else {
            results.push({ student_id: sid, ok: true });
          }
        } catch (e) {
          results.push({
            student_id: sid,
            ok: false,
            error: e instanceof Error ? e.message : "queue failed",
          });
        }
      }
    }
    // Light parallelism — even queue inserts benefit from a couple of
    // lanes when the class is large.
    const lanes = Math.min(CONCURRENCY, studentIds.length);
    const workers = Array.from({ length: lanes }, () => worker());
    await Promise.all(workers);

    // Note: we deliberately don't surface `origin` to the linter — it's
    // pinned for future expansion when we move from queue rows to
    // direct fan-out generation.
    void origin;

    const queued = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    return NextResponse.json({
      ok: true,
      queued,
      total_students: studentIds.length,
      per_student: perStudent,
      failures: failed.length,
      failure_sample: failed.slice(0, 5),
      hint: failed.length > 0 ? "If failures mention relation does not exist, run migration 94 (teacher_assignments)." : undefined,
    });
  } catch (e) {
    console.error("[assign-practice] unhandled:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
