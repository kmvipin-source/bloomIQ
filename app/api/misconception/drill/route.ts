import { NextResponse } from "next/server";
import { groqJSON } from "@/lib/groq";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";
import { checkRateLimit } from "@/lib/rateLimit";
import {
  loadLearningContext,
  prependLearningContext,
  buildExamAwareTopic,
} from "@/lib/learningContext";
import { buildSkillFewShotBlock } from "@/lib/skillFewShot";

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

5. GENERIC DOMAIN AWARENESS (applies to ANY topic — no local lookup):
   If the topic is a specialized professional / technical / niche domain
   (payment switches like Postilion or Base24, mainframe stack like JCL /
   COBOL / CICS / DB2, networking protocols like BGP / MPLS, cloud platforms,
   legal codes, medical specialties, regulatory frameworks, ERP modules,
   industrial control systems, etc.) — USE the precise real-world terminology
   of that domain. Real product names, real parameter names, real syntax,
   real field numbers, real API verbs, real configuration keys. NEVER invent
   identifiers, opcodes, field bits, function names, or product features
   that don\'t exist. If you don\'t have confident knowledge of a specific
   aspect, write a question that AVOIDS that aspect rather than fabricating.
6. ALWAYS produce EXACTLY the requested number of questions. If you run
   short of obvious angles, vary the sub-area, scenario, difficulty, or
   level of abstraction — but hit the requested count. Returning fewer
   than requested wastes the student\'s quota and time.

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
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;
    const rate = checkRateLimit(user.id, "misconception.drill", { capacity: 10, refillPerHour: 20 });
    if (!rate.allowed) return NextResponse.json({ error: "Too many requests.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } });

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

    // Learning-context inheritance — drill MCQs must pitch at the student's
    // exam difficulty. A CAT student's misconception drill should be at
    // CAT discrimination level, not Class-10. See lib/learningContext.ts.
    const admin = supabaseAdmin();
    const ctx = await loadLearningContext(admin, user.id);
    const contextAwareTopic = buildExamAwareTopic(misc.topic || "general", ctx);
    const contextAwareSystem = prependLearningContext(SYSTEM, ctx) + buildSkillFewShotBlock(misc.topic || "");

    const userPrompt = `Misconception label: ${misc.label}
Misconception detail: ${misc.detail}
Topic: ${contextAwareTopic}
Bloom level: ${misc.bloom_level || "apply"}

Generate the 3-question micro-drill JSON now.`;
    const raw = await groqJSON(contextAwareSystem, userPrompt);
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
    const { error: linkErr } = await sb.from("quiz_questions").insert(linkRows);
    if (linkErr) {
      // Without this guard the quiz row exists with zero linked
      // questions and the client redirects into a broken quiz code.
      await sb.from("quizzes").delete().eq("id", quiz.id);
      return NextResponse.json({ error: `Could not link drill questions: ${linkErr.message}` }, { status: 500 });
    }

    return NextResponse.json({ ok: true, quizCode: code, total: valid.length });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Drill generation failed" },
      { status: 500 }
    );
  }
}
