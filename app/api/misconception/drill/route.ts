import { NextResponse } from "next/server";
import { groqJSON } from "@/lib/groq";
import { getBearer, supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 45;

// =============================================================================
// POST /api/misconception/drill
// -----------------------------------------------------------------------------
// Body: { misconception_id: string }
//
// Generates 3 ultra-targeted MCQs that specifically attack the misconception's
// "shape" (e.g. if the misconception is "confused photosynthesis with
// respiration", every drill question forces a clean discrimination between
// the two). The questions are inserted into question_bank, a new quiz row is
// created, and the quiz code is returned so the student can take it
// immediately via the existing /student/quiz/[code] flow.
// =============================================================================

const SYSTEM = `You are an expert curriculum designer building a 3-question micro-quiz that surgically attacks one specific misconception.

You will be given:
- the misconception label and detail (e.g. "You confused photosynthesis with respiration")
- the topic
- the bloom level

Generate exactly 3 MCQs that force the student to discriminate the confused concepts. Each MCQ:
- has a clear stem
- has 4 options (one correct, three plausible distractors)
- has correct_index 0..3
- has a 1-sentence explanation that directly references why the misconception was wrong

Respond with VALID JSON only:
{
  "questions": [
    { "stem": "...", "options": ["a","b","c","d"], "correct_index": 0, "explanation": "..." }
  ]
}`;

type GenQ = { stem: string; options: string[]; correct_index: number; explanation: string };

function quizCode(): string {
  // 6 chars, omit lookalikes (0/O, 1/I).
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const misconception_id: string = String(body.misconception_id || "");
    if (!misconception_id) return NextResponse.json({ error: "misconception_id required" }, { status: 400 });

    const { data: misc, error: mErr } = await sb
      .from("misconceptions")
      .select("id, user_id, topic, bloom_level, label, detail")
      .eq("id", misconception_id)
      .single();
    if (mErr || !misc) return NextResponse.json({ error: "Misconception not found" }, { status: 404 });
    if (misc.user_id !== user.id) return NextResponse.json({ error: "Not yours" }, { status: 403 });

    const userPrompt = `Misconception label: ${misc.label}
Misconception detail: ${misc.detail}
Topic: ${misc.topic || "general"}
Bloom level: ${misc.bloom_level || "apply"}

Generate the 3-question micro-drill JSON now.`;
    const raw = await groqJSON(SYSTEM, userPrompt);
    const arr = (raw as { questions?: unknown }).questions;
    if (!Array.isArray(arr)) {
      return NextResponse.json({ error: "AI did not return drill questions; please retry." }, { status: 502 });
    }
    const valid: GenQ[] = (arr as unknown[])
      .map((q) => {
        const obj = (q || {}) as Record<string, unknown>;
        const stem = String(obj.stem || "").trim();
        const options = Array.isArray(obj.options) ? (obj.options as unknown[]).map(String) : [];
        const ci = Number(obj.correct_index);
        const expl = String(obj.explanation || "").trim();
        if (!stem || options.length !== 4 || !Number.isInteger(ci) || ci < 0 || ci > 3) return null;
        return { stem, options, correct_index: ci, explanation: expl };
      })
      .filter((q): q is GenQ => q !== null)
      .slice(0, 3);

    if (valid.length === 0) {
      return NextResponse.json({ error: "No usable drill questions came back." }, { status: 502 });
    }

    // Insert into question_bank.
    const rows = valid.map((q) => ({
      owner_id: user.id,
      topic: misc.topic || null,
      bloom_level: misc.bloom_level || "apply",
      stem: q.stem,
      options: q.options,
      correct_index: q.correct_index,
      explanation: q.explanation || null,
      status: "approved" as const,
    }));
    const { data: insertedQs, error: qInsErr } = await sb
      .from("question_bank")
      .insert(rows)
      .select("id");
    if (qInsErr) return NextResponse.json({ error: qInsErr.message }, { status: 500 });

    // Create a quiz row + link the questions.
    const code = quizCode();
    const { data: quiz, error: quizErr } = await sb
      .from("quizzes")
      .insert({
        owner_id: user.id,
        name: `Drill: ${misc.label}`,
        subject: null,
        topic_family: misc.topic || null,
        code,
        time_limit_minutes: 5,
        bloom_filter: misc.bloom_level ? [misc.bloom_level] : null,
        active: true,
      })
      .select()
      .single();
    if (quizErr) return NextResponse.json({ error: quizErr.message }, { status: 500 });

    const linkRows = (insertedQs || []).map((q, i) => ({ quiz_id: quiz.id, question_id: q.id, position: i }));
    await sb.from("quiz_questions").insert(linkRows);

    return NextResponse.json({ ok: true, quizCode: code, total: valid.length });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Drill generation failed" },
      { status: 500 }
    );
  }
}
