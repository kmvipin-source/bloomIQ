// app/api/teacher/assign-flashcards/route.ts
// =============================================================================
// Teacher → Class flashcards assignment (P2.8).
// -----------------------------------------------------------------------------
// Purpose
// -------
// Teachers can already generate a class-test (/teacher/quizzes/new) but
// flashcards have been student-only. This endpoint closes the second
// half of the parity gap: a teacher picks a topic + class, and every
// student in that class gets a flashcard deck queued for their next
// "Practice" tile.
//
// Why a new endpoint instead of reusing /api/flashcards
// -----------------------------------------------------
// /api/flashcards generates ONE deck owned by the calling user. The
// teacher use case fans out: ONE generation, MANY student-owned decks
// (so each student's spaced-repetition scheduler tracks them
// independently). The endpoint orchestrates the fan-out and re-uses the
// underlying generator.
//
// Auth
// ----
// Teacher must teach the target class (class_teachers join). All writes
// use supabaseAdmin() to bypass per-student RLS — the teacher is
// LEGITIMATELY writing into other rows on their behalf, and a per-write
// owner_id is set to that student so subsequent reads still RLS to the
// student correctly.
//
// Cost
// ----
// One Groq generation call (deck content is identical per student);
// the fan-out is N rows, not N AI calls.
// =============================================================================

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";

type AssignBody = {
  class_id: string;
  topic: string;
  count?: number;        // total flashcards (default 10, max 20)
  additional_focus?: string;
};

type ClassTeacherRow = { user_id: string };
type ClassStudentRow = { user_id: string };

const DEFAULT_COUNT = 10;
const MAX_COUNT = 20;

export async function POST(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session iat
    // enforcement now applied to this mutating route. Old tokens from
    // a previous device are rejected with session_superseded 401.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb, token } = auth;

    let body: AssignBody;
    try {
      body = (await req.json()) as AssignBody;
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const classId = body.class_id?.trim();
    // F103 fix (QA): cap topic length so a pathological input doesn't
    // pollute the table or get spliced into the LLM prompt unbounded.
    const topic = (body.topic || "").trim().slice(0, 500);
    const count = Math.max(1, Math.min(MAX_COUNT, body.count ?? DEFAULT_COUNT));
    if (!classId) return NextResponse.json({ error: "class_id required" }, { status: 400 });
    if (!topic) return NextResponse.json({ error: "topic required" }, { status: 400 });

    // F102 fix: re-check the user is still role='teacher' (or super_teacher).
    // A teacher who was demoted mid-session keeps a class_teachers row
    // until cleanup runs; without this check they could keep fan-out
    // privileges they no longer have.
    {
      const adminEarly = supabaseAdmin();
      const { data: meRole } = await adminEarly
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      const r = meRole?.role;
      if (r !== "teacher" && r !== "super_teacher") {
        return NextResponse.json(
          { error: "Only teachers can assign flashcards to a class." },
          { status: 403 }
        );
      }
    }
    // Verify teacher teaches this class.
    const { data: teaches } = await sb
      .from("class_teachers")
      .select("user_id")
      .eq("class_id", classId)
      .eq("user_id", user.id)
      .limit(1);
    if (!((teaches as ClassTeacherRow[] | null) || []).length) {
      return NextResponse.json({ error: "You do not teach this class" }, { status: 403 });
    }

    // Resolve the class roster.
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

    // Build one deck via the existing /api/flashcards endpoint internally.
    // We call it as an internal HTTP request to preserve all the
    // sanitization / verification / dedup logic already baked into that
    // route — duplicating would drift. The teacher's bearer is used.
    const origin = new URL(req.url).origin;
    const fcRes = await fetch(`${origin}/api/flashcards`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        topic,
        count,
        additional_focus: body.additional_focus ?? "",
        // Teacher generates "on behalf of" the class — owner_id is the
        // teacher here; we fan out copies below.
      }),
    });
    if (!fcRes.ok) {
      const j = await fcRes.json().catch(() => ({}));
      return NextResponse.json(
        { error: `Flashcard generation failed: ${j?.error || fcRes.status}` },
        { status: 502 },
      );
    }
    const deck = (await fcRes.json()) as {
      cards?: Array<{ front: string; back: string; bloom_level?: string }>;
    };
    const cards = deck.cards ?? [];
    if (cards.length === 0) {
      return NextResponse.json(
        { error: "Generator returned no cards — please try again with a different topic." },
        { status: 502 },
      );
    }

    // Fan-out — insert one assignment row per student.
    // Schema assumption: `flashcard_assignments` table with
    //   (id uuid pk, class_id, teacher_id, student_id, topic, cards jsonb,
    //    created_at, completed_at, source). If the table doesn't exist
    //    yet, this endpoint returns a 500 with a clear hint so the next
    //    migration can be focused on creating it. We deliberately do NOT
    //    add the migration in P2.8 — the data model is reviewable on its
    //    own.
    // F98 fix (QA): per-student insert instead of bulk all-or-nothing.
    // Previously a single bad row (e.g. a transient FK race) failed the
    // entire fan-out and the teacher saw nothing assigned. Now we
    // collect per-student failures and report a summary so most of
    // the class still gets their deck.
    const rows = studentIds.map((sid) => ({
      class_id: classId,
      teacher_id: user.id,
      student_id: sid,
      topic,
      cards,
      source: "teacher_assigned",
    }));
    let assigned = 0;
    const failures: Array<{ student_id: string; reason: string }> = [];
    let missingTableHint = false;
    for (const row of rows) {
      const { error: rowErr } = await admin.from("flashcard_assignments").insert([row]);
      if (rowErr) {
        const msg = rowErr.message || "insert failed";
        if (/relation .* does not exist/i.test(msg)) missingTableHint = true;
        failures.push({ student_id: row.student_id, reason: msg });
      } else {
        assigned += 1;
      }
    }
    if (assigned === 0 && failures.length > 0) {
      return NextResponse.json(
        {
          error: failures[0].reason,
          failures,
          hint: missingTableHint
            ? "Relation flashcard_assignments does not exist — create migration 94 (see route docstring)."
            : "All inserts failed; check RLS or schema drift.",
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      assigned,
      students: studentIds.length,
      card_count: cards.length,
      topic,
      failures: failures.length > 0 ? failures : undefined,
    });
  } catch (e) {
    console.error("[assign-flashcards] unhandled:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
