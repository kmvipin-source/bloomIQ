import { NextResponse } from "next/server";
import { getBearer, supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

// =============================================================================
// POST /api/student/daily-drill/submit
// -----------------------------------------------------------------------------
// Body: { answers: [{ question_id: string, selected_index: number | null }] }
// Returns: { score, total, per_question: [{ question_id, is_correct,
//          correct_index, explanation, stem }] }
//
// Logs the attempt into daily_drill_attempts (migration 20) for analytics.
// =============================================================================

type IncomingAnswer = { question_id: string; selected_index: number | null };
type QRow = {
  id: string;
  stem: string;
  options: unknown;
  correct_index: number;
  explanation: string | null;
  bloom_level: string;
  topic: string | null;
};

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: prof } = await sb.from("profiles").select("role").eq("id", user.id).single();
    if (prof?.role !== "student") {
      return NextResponse.json({ error: "Students only." }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const rawAns: unknown = body?.answers;
    if (!Array.isArray(rawAns) || rawAns.length === 0) {
      return NextResponse.json({ error: "No answers submitted." }, { status: 400 });
    }
    const answers: IncomingAnswer[] = [];
    for (const a of rawAns as Array<Record<string, unknown>>) {
      const qid = typeof a.question_id === "string" ? a.question_id : null;
      if (!qid) continue;
      const si = typeof a.selected_index === "number" && a.selected_index >= 0 && a.selected_index <= 3
        ? a.selected_index : null;
      answers.push({ question_id: qid, selected_index: si });
    }
    if (answers.length === 0) {
      return NextResponse.json({ error: "Invalid answers payload." }, { status: 400 });
    }

    const qids = Array.from(new Set(answers.map((a) => a.question_id)));
    const { data: qs, error: qErr } = await sb
      .from("question_bank")
      .select("id, stem, options, correct_index, explanation, bloom_level, topic")
      .in("id", qids);
    if (qErr) return NextResponse.json({ error: qErr.message }, { status: 500 });
    const byId = new Map<string, QRow>();
    for (const q of (qs as QRow[]) || []) byId.set(q.id, q);

    type PerQ = {
      question_id: string;
      stem: string;
      is_correct: boolean;
      selected_index: number | null;
      correct_index: number | null;
      explanation: string | null;
    };
    const per: PerQ[] = [];
    let score = 0;
    for (const a of answers) {
      const q = byId.get(a.question_id);
      if (!q) {
        per.push({ question_id: a.question_id, stem: "", is_correct: false, selected_index: a.selected_index, correct_index: null, explanation: null });
        continue;
      }
      const is_correct = a.selected_index !== null && a.selected_index === q.correct_index;
      if (is_correct) score++;
      per.push({
        question_id: q.id,
        stem: q.stem,
        is_correct,
        selected_index: a.selected_index,
        correct_index: q.correct_index,
        explanation: q.explanation,
      });
    }

    // Best-effort log into daily_drill_attempts (migration 20). If table not
    // applied yet, we silently skip — UI flow doesn't depend on it.
    try {
      await sb.from("daily_drill_attempts").insert({
        student_id: user.id,
        score,
        total: answers.length,
        items: per,
      });
    } catch {
      // migration 20 not applied — silent skip
    }

    return NextResponse.json({ score, total: answers.length, per_question: per });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Submit failed" }, { status: 500 });
  }
}
