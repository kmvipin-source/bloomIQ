// =============================================================================
// app/api/student/adaptive-practice/route.ts
// -----------------------------------------------------------------------------
// Adaptive Personalised Practice — Phase 2C.
//
// POST { topic: string }
//   1. Auth + role-check (must be a student).
//   2. Build the student's last-30-day mastery snapshot via buildStudentContext.
//   3. Pick the WEAKEST Bloom level among those with ≥3 attempts (lowest pct).
//      If no level has ≥3 attempts yet, default to "understand" (a friendly
//      mid-level start that matches a typical learner's comfort zone).
//   4. Mine misconception distractor seeds (best-effort — empty list is fine
//      for an independent student with no prior bank).
//   5. Generate 5 MCQs at the targeted Bloom level via Groq.
//   6. Self-verify the answer keys (verifyAnswerKeys); flag-but-keep on dispute.
//   7. Persist scaffolding so the existing /student/quiz/{code} flow can run:
//      a row in `quizzes` (owned by the student), 5 rows in `question_bank`
//      (owned by the student, status='approved'), and 5 `quiz_questions` links.
//   8. Return { ok, quizId, quizCode, targetedLevel, total, summary, verification }
//      so the front-end can redirect into the existing quiz-taking UI.
// =============================================================================
import { NextResponse } from "next/server";
import { groqJSON } from "@/lib/groq";
import {
  BLOOM_LEVELS,
  BLOOM_META,
  type BloomLevel,
  isBloomLevel,
} from "@/lib/bloom";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import { generateQuizCode, pct as pctFn } from "@/lib/utils";
import { buildStudentContext } from "@/lib/studentContext";
import {
  findMisconceptionDistractors,
  formatDistractorSeedsForPrompt,
  verifyAnswerKeys,
  type VerifiableQuestion,
} from "@/lib/qgen";

export const runtime = "nodejs";
export const maxDuration = 90;

const QUESTION_COUNT = 5;
const MIN_ATTEMPTS_FOR_SIGNAL = 3;
const DEFAULT_LEVEL: BloomLevel = "understand";

type GenQ = {
  stem: string;
  options: string[];
  correct_index: number;
  explanation?: string;
  bloom_level?: string;
};

const SYSTEM = `You are an expert curriculum designer who writes high-quality multiple-choice
questions calibrated precisely to a single Bloom's Taxonomy level. Each question must:
- have exactly 4 options labelled by index 0..3
- have ONE clearly correct answer (correct_index 0..3)
- include a brief explanation of why it's correct
- match the requested Bloom level's cognitive demand (don't drift up or down)
- be unambiguous, grammatically correct, and free of trick wording
Return STRICT JSON only.`;

function buildPrompt(
  topic: string,
  level: BloomLevel,
  n: number,
  seedBlock: string
): string {
  return `Topic: ${topic}
Bloom Level: ${level} — ${BLOOM_META[level].description}
Verb hint: ${BLOOM_META[level].verb}

Generate ${n} multiple-choice questions strictly at the "${level}" level of Bloom's Taxonomy on the topic above. The student is practising adaptively at this level because it's their current weakest area, so calibrate difficulty to be challenging but fair — don't make them trivially easy and don't drift into a higher level.
${seedBlock}

Output JSON of the form:
{ "questions": [ { "stem": "...", "options": ["A","B","C","D"], "correct_index": 0, "explanation": "..." } ] }`;
}

/**
 * Pick the Bloom level the student should drill next.
 * Lowest pct_correct wins, tie-broken by ascending Bloom order (recall first).
 * Levels with fewer than MIN_ATTEMPTS_FOR_SIGNAL attempts are ignored — too
 * little signal to call them "weak". If no level has enough attempts yet,
 * fall back to DEFAULT_LEVEL.
 */
function pickWeakestLevel(
  mastery: Record<BloomLevel, { correct: number; total: number; pct: number | null }>
): BloomLevel {
  type Candidate = { level: BloomLevel; pct: number; order: number };
  const candidates: Candidate[] = [];
  for (let i = 0; i < BLOOM_LEVELS.length; i++) {
    const lvl = BLOOM_LEVELS[i];
    const m = mastery[lvl];
    if (!m || m.total < MIN_ATTEMPTS_FOR_SIGNAL) continue;
    if (m.pct === null) continue;
    candidates.push({ level: lvl, pct: m.pct, order: i });
  }
  if (candidates.length === 0) return DEFAULT_LEVEL;
  candidates.sort((a, b) => (a.pct - b.pct) || (a.order - b.order));
  return candidates[0].level;
}

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Role gate — students only.
    const { data: prof } = await sb
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (prof?.role !== "student") {
      return NextResponse.json(
        { error: "Only students can use adaptive practice." },
        { status: 403 }
      );
    }

    // Body
    const body = (await req.json().catch(() => ({}))) as { topic?: unknown };
    const topic = typeof body.topic === "string" ? body.topic.trim() : "";
    if (topic.length < 2) {
      return NextResponse.json(
        { error: "Tell us what topic you'd like to practise." },
        { status: 400 }
      );
    }
    if (topic.length > 200) {
      return NextResponse.json(
        { error: "Topic is too long — keep it under 200 characters." },
        { status: 400 }
      );
    }

    // 1) Build student context → pick targeted level
    let targetedLevel: BloomLevel = DEFAULT_LEVEL;
    try {
      const ctx = await buildStudentContext(user.id);
      targetedLevel = pickWeakestLevel(ctx.bloom_mastery_30d);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[adaptive-practice] buildStudentContext failed, defaulting to ${DEFAULT_LEVEL}:`,
        e instanceof Error ? e.message : e
      );
    }
    if (!isBloomLevel(targetedLevel)) targetedLevel = DEFAULT_LEVEL;

    // eslint-disable-next-line no-console
    console.log(
      `[adaptive-practice] start userId=${user.id} topic="${topic}" targetedLevel=${targetedLevel}`
    );

    // 2) Misconception seeds — best effort. Independent students typically have
    //    no owned question_bank, so this returns []; that's fine.
    let seedBlock = "";
    try {
      const seeds = await findMisconceptionDistractors({
        ownerId: user.id,
        topic,
        bloomLevel: targetedLevel,
        limit: 5,
        accessToken: token,
      });
      seedBlock = formatDistractorSeedsForPrompt(seeds);
      if (seeds.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[adaptive-practice] spliced ${seeds.length} misconception seed(s)`);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[adaptive-practice] seed mining failed (non-fatal):`,
        e instanceof Error ? e.message : e
      );
    }

    // 3) Generate 5 MCQs at the targeted level
    let raw: Record<string, unknown>;
    try {
      raw = await groqJSON(SYSTEM, buildPrompt(topic, targetedLevel, QUESTION_COUNT, seedBlock));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[adaptive-practice] groqJSON failed:`, e instanceof Error ? e.message : e);
      return NextResponse.json(
        { error: "Couldn't reach the question generator. Try again in a moment." },
        { status: 502 }
      );
    }
    const arr: GenQ[] = Array.isArray((raw as { questions?: GenQ[] })?.questions)
      ? (raw as { questions: GenQ[] }).questions
      : [];

    const valid: GenQ[] = arr.filter(
      (q) =>
        q &&
        typeof q.stem === "string" &&
        q.stem.trim().length > 0 &&
        Array.isArray(q.options) &&
        q.options.length === 4 &&
        q.options.every((o) => typeof o === "string") &&
        Number.isInteger(q.correct_index) &&
        q.correct_index >= 0 &&
        q.correct_index <= 3
    );

    if (valid.length === 0) {
      // eslint-disable-next-line no-console
      console.error(`[adaptive-practice] no valid questions returned by model`);
      return NextResponse.json(
        { error: "AI returned no usable questions. Try a more specific topic." },
        { status: 502 }
      );
    }

    // 4) Self-verify answer keys. We keep disputed ones (flagged) so the student
    //    still gets a full set; verification stats are surfaced on the response.
    const verifiable: VerifiableQuestion[] = valid.map((q) => ({
      stem: String(q.stem).trim(),
      options: [
        String(q.options[0]).trim(),
        String(q.options[1]).trim(),
        String(q.options[2]).trim(),
        String(q.options[3]).trim(),
      ] as [string, string, string, string],
      correct_index: q.correct_index as 0 | 1 | 2 | 3,
    }));
    const verifyResults = await verifyAnswerKeys(verifiable, QUESTION_COUNT);
    const verifiedCount = verifyResults.filter((v) => v.ok).length;
    const disputedCount = verifyResults.length - verifiedCount;

    // 5) Persist: question_bank rows owned by the student
    type QuestionInsertRow = {
      owner_id: string;
      topic: string;
      bloom_level: BloomLevel;
      stem: string;
      options: string[];
      correct_index: number;
      explanation: string | null;
      status: "approved";
    };
    const insertRows: QuestionInsertRow[] = valid.map((q) => ({
      owner_id: user.id,
      topic,
      bloom_level: targetedLevel,
      stem: String(q.stem).trim(),
      options: q.options.map((o) => String(o).trim()),
      correct_index: q.correct_index,
      explanation: q.explanation ? String(q.explanation).trim() : null,
      status: "approved",
    }));

    const { data: insertedQs, error: qErr } = await sb
      .from("question_bank")
      .insert(insertRows)
      .select("id, bloom_level");
    if (qErr || !insertedQs || insertedQs.length === 0) {
      // eslint-disable-next-line no-console
      console.error(`[adaptive-practice] question_bank insert failed:`, qErr?.message);
      return NextResponse.json(
        { error: `Could not save questions: ${qErr?.message || "unknown"}` },
        { status: 500 }
      );
    }

    // 6) Create the quiz with a fresh code. Try the rich insert first
    //    (subject column may exist post-migration 04); fall back gracefully.
    let code = generateQuizCode();
    for (let i = 0; i < 4; i++) {
      const { data: existing } = await sb
        .from("quizzes")
        .select("id")
        .eq("code", code)
        .maybeSingle();
      if (!existing) break;
      code = generateQuizCode();
    }

    const niceName = `Adaptive Practice — ${topic}`;
    type QuizInsert = {
      owner_id: string;
      name: string;
      code: string;
      time_limit_minutes: number;
      bloom_filter: string[];
      subject?: string | null;
    };
    const fullInsert: QuizInsert = {
      owner_id: user.id,
      name: niceName,
      code,
      // 5 questions × per-level seconds + a small buffer, rounded up.
      time_limit_minutes: Math.max(
        5,
        Math.ceil((QUESTION_COUNT * 75) / 60) // ~75s/q baseline; trims tight on remember, generous on analyze
      ),
      bloom_filter: [targetedLevel],
      subject: topic,
    };
    let { data: quiz, error: quizErr } = await sb
      .from("quizzes")
      .insert(fullInsert)
      .select()
      .single();
    if (quizErr && /column .*(subject|topic_family)/i.test(quizErr.message)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[adaptive-practice] schema missing subject column — falling back. Apply migrations 04/05.`
      );
      const fb = await sb
        .from("quizzes")
        .insert({
          owner_id: user.id,
          name: niceName,
          code,
          time_limit_minutes: fullInsert.time_limit_minutes,
          bloom_filter: [targetedLevel],
        } satisfies QuizInsert)
        .select()
        .single();
      quiz = fb.data;
      quizErr = fb.error;
    }
    if (quizErr || !quiz) {
      // eslint-disable-next-line no-console
      console.error(`[adaptive-practice] quiz insert failed:`, quizErr?.message);
      return NextResponse.json(
        { error: `Could not create practice session: ${quizErr?.message || "unknown"}` },
        { status: 500 }
      );
    }

    // 7) Link questions to quiz, preserving generation order
    type InsertedQ = { id: string; bloom_level: BloomLevel };
    const ordered = (insertedQs as InsertedQ[]).slice();
    const linkRows = ordered.map((q, i) => ({
      quiz_id: quiz!.id,
      question_id: q.id,
      position: i,
    }));
    const { error: linkErr } = await sb.from("quiz_questions").insert(linkRows);
    if (linkErr) {
      // eslint-disable-next-line no-console
      console.error(`[adaptive-practice] quiz_questions insert failed:`, linkErr.message);
      return NextResponse.json(
        { error: `Could not link questions to practice session: ${linkErr.message}` },
        { status: 500 }
      );
    }

    // eslint-disable-next-line no-console
    console.log(
      `[adaptive-practice] success: quiz=${quiz!.code} level=${targetedLevel} questions=${linkRows.length} verified=${verifiedCount}/${verifyResults.length}`
    );

    return NextResponse.json({
      ok: true,
      quizId: quiz!.id,
      quizCode: quiz!.code,
      targetedLevel,
      targetedLevelLabel: BLOOM_META[targetedLevel].label,
      total: linkRows.length,
      verification: {
        verified: verifiedCount,
        disputed: disputedCount,
        // Surface the verified rate for any UI that wants to show a quality hint.
        verified_pct: pctFn(verifiedCount, verifyResults.length),
      },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[adaptive-practice] unexpected error:`, e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Adaptive practice failed" },
      { status: 500 }
    );
  }
}
