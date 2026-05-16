import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";
import { classifyQuiz } from "@/lib/classifier";

export const runtime = "nodejs";

/**
 * POST /api/quizzes/[id]/classify
 *
 * Classifies a quiz into a canonical (subject, topic_family). Called from the
 * teacher's quiz composer after a quiz is created, so progress can be grouped
 * across similar quizzes regardless of who made them.
 *
 * Auth: requires the quiz owner.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const { id: quizId } = await params;

    // Fetch the quiz (RLS makes sure it's the owner's)
    const { data: quiz, error: qErr } = await sb
      .from("quizzes")
      .select("id, owner_id, name, subject")
      .eq("id", quizId)
      .single();
    if (qErr || !quiz) return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
    if (quiz.owner_id !== user.id) return NextResponse.json({ error: "Not yours" }, { status: 403 });

    // Pull a small sample of questions (3) to give the classifier real content
    const { data: qq } = await sb
      .from("quiz_questions")
      .select("question_id, question:question_bank(stem)")
      .eq("quiz_id", quizId)
      .order("position", { ascending: true })
      .limit(3);
    type Row = { question_id: string; question: { stem: string } | null };
    const sampleStems = ((qq as unknown as Row[]) || [])
      .map((r) => r.question?.stem || "")
      .filter(Boolean);

    // Ground with this user's existing families for consistency
    const { data: existingFams } = await sb
      .from("quizzes")
      .select("topic_family")
      .eq("owner_id", user.id)
      .not("topic_family", "is", null)
      .neq("id", quizId)
      .limit(50);
    const existingFamilies = Array.from(new Set(
      ((existingFams || []) as Array<{ topic_family: string }>).map((e) => e.topic_family).filter(Boolean)
    ));

    const cls = await classifyQuiz(quiz.subject || quiz.name || "", sampleStems, existingFamilies);

    // Persist whatever we got back; preserve user-set subject if classifier didn't return one
    const update: Record<string, unknown> = { topic_family: cls.topic_family };
    if (cls.subject && !quiz.subject) update.subject = cls.subject;

    const { error: uErr } = await sb.from("quizzes").update(update).eq("id", quizId);
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, ...cls });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Classify failed" }, { status: 500 });
  }
}
