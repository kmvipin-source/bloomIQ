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

    const { data: quizzes } = await sb.from("quizzes").select("id").eq("owner_id", user.id);
    const quizIds = (quizzes || []).map((q: { id: string }) => q.id);
    if (!quizIds.length) return NextResponse.json({ ok: true, created: 0 });

    const { data: atts } = await sb
      .from("quiz_attempts")
      .select("id, quiz_id, student_id, score, total, submitted_at")
      .in("quiz_id", quizIds)
      .not("submitted_at", "is", null)
      .order("submitted_at", { ascending: false });

    type A = { id: string; quiz_id: string; student_id: string; score: number; total: number; submitted_at: string };
    const byStudent = new Map<string, A[]>();
    (atts as A[] | null)?.forEach((a) => {
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
