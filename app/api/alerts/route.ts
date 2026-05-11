import { NextResponse } from "next/server";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import { pct } from "@/lib/utils";

export const runtime = "nodejs";

/**
 * Computes early-warning alerts for the teacher's recent quizzes.
 * Trigger rules:
 *  - student's most recent attempt < 50%
 *  - or two consecutive sub-60% attempts in the same quiz series
 */
export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Visibility-aligned alert scope (matches RLS migration 58):
    //   owned quizzes ∪ quizzes assigned to a class I'm primary on
    //   ∪ quizzes I personally assigned. RLS already returns ONLY
    //   the rows I should see, so a single SELECT after the visibility
    //   helpers resolve gives the right scope.
    const { data: ownedQ } = await sb.from("quizzes").select("id").eq("owner_id", user.id);
    const ownedIds = new Set(((ownedQ as Array<{ id: string }>) || []).map((q) => q.id));

    // Pull every visible assignment (RLS scopes it for us). Take all
    // quiz_ids referenced — these are the visible-by-assignment quizzes.
    const { data: visAsg } = await sb
      .from("quiz_assignments")
      .select("quiz_id");
    for (const r of ((visAsg as Array<{ quiz_id: string }>) || [])) {
      if (r.quiz_id) ownedIds.add(r.quiz_id);
    }
    const quizIds = Array.from(ownedIds);
    if (!quizIds.length) return NextResponse.json({ ok: true, created: 0 });

    const { data: atts } = await sb
      .from("quiz_attempts")
      .select("id, quiz_id, student_id, score, total, submitted_at")
      .in("quiz_id", quizIds)
      .not("submitted_at", "is", null)
      .order("submitted_at", { ascending: false });

    // Compute the teacher's authorized student set: students enrolled
    // in any class this teacher teaches. Defense in depth — even if
    // RLS over quiz_attempts surfaced a row from outside the teacher's
    // scope, we won't write an alert referencing that student.
    const { data: myClasses } = await sb
      .from("class_teachers")
      .select("class_id")
      .eq("teacher_id", user.id);
    const myClassIds = ((myClasses as Array<{ class_id: string }>) || []).map((c) => c.class_id);
    const authorisedStudents = new Set<string>();
    if (myClassIds.length > 0) {
      const { data: members } = await sb
        .from("class_members")
        .select("student_id")
        .in("class_id", myClassIds);
      for (const m of ((members as Array<{ student_id: string }>) || [])) {
        authorisedStudents.add(m.student_id);
      }
    }

    type A = { id: string; quiz_id: string; student_id: string; score: number; total: number; submitted_at: string };
    const byStudent = new Map<string, A[]>();
    (atts as A[] | null)?.forEach((a) => {
      if (!authorisedStudents.has(a.student_id)) return;
      const arr = byStudent.get(a.student_id) || [];
      arr.push(a); byStudent.set(a.student_id, arr);
    });

    const newAlerts: { student_id: string; quiz_id: string | null; kind: string; message: string }[] = [];
    for (const [sid, arr] of byStudent) {
      const last = arr[0];
      if (last && pct(last.score, last.total) < 50) {
        newAlerts.push({
          student_id: sid,
          quiz_id: last.quiz_id,
          kind: "low_score",
          message: `Scored ${pct(last.score, last.total)}% on most recent quiz.`,
        });
      }
      if (arr.length >= 2) {
        const [a, b] = arr;
        if (pct(a.score, a.total) < 60 && pct(b.score, b.total) < 60) {
          newAlerts.push({
            student_id: sid,
            quiz_id: a.quiz_id,
            kind: "declining",
            message: `Two consecutive attempts under 60%.`,
          });
        }
      }
    }

    if (!newAlerts.length) return NextResponse.json({ ok: true, created: 0, alerts: [] });
    const { error } = await sb.from("alerts").insert(newAlerts);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, created: newAlerts.length, alerts: newAlerts });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
