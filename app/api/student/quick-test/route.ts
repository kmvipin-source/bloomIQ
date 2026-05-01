import { NextResponse } from "next/server";
import { groqJSON, groqJSONVision } from "@/lib/groq";
import {
  BLOOM_LEVELS,
  BLOOM_META,
  type BloomLevel,
  isBloomLevel,
  blankBloomCounts,
} from "@/lib/bloom";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { generateQuizCode } from "@/lib/utils";
import { classifyQuiz } from "@/lib/classifier";
import {
  findMisconceptionDistractors,
  formatDistractorSeedsForPrompt,
  verifyAnswerKeys,
  type VerifiableQuestion,
} from "@/lib/qgen";

export const runtime = "nodejs";
export const maxDuration = 60;

type GenQ = { stem: string; options: string[]; correct_index: number; explanation: string };
type Source = "notes" | "image" | "topic_syllabus" | "topic_only" | "past_paper";

const SYSTEM = `You are an expert curriculum designer who writes high-quality multiple-choice questions
mapped precisely to Bloom's Taxonomy levels. Each question must:
- have exactly 4 options labelled by index 0..3
- have ONE clearly correct answer (correct_index 0..3)
- include a brief explanation of why it's correct
- match the requested Bloom level's cognitive demand
- be unambiguous, grammatically correct, and free of trick wording
Return STRICT JSON only.`;

function jsonShape() {
  return `Output JSON of the form:
{ "questions": [ { "stem": "...", "options": ["A","B","C","D"], "correct_index": 0, "explanation": "..." } ] }`;
}

function numericalHint(pct: number, n: number) {
  if (pct <= 0) return "";
  const target = Math.max(1, Math.round((pct / 100) * n));
  return `\n\nNumerical-content target: about ${pct}% (~${target} of ${n}) of these questions should involve numerical reasoning — calculation, formulas, equations, units, or quantitative analysis — BUT ONLY IF the topic naturally supports it (math, physics, chemistry, finance, statistics, economics, etc.). If the topic is purely conceptual, ignore this and write conceptual questions instead.`;
}

function notesPrompt(content: string, topic: string, level: BloomLevel, n: number, numPct: number, seedBlock: string) {
  return `Topic: ${topic || "(infer from content)"}
Bloom Level: ${level} — ${BLOOM_META[level].description}
Verb hint: ${BLOOM_META[level].verb}

Generate ${n} multiple-choice questions strictly at the "${level}" level of Bloom's Taxonomy from the content below.

Content:
"""${content.slice(0, 8000)}"""
${numericalHint(numPct, n)}${seedBlock}

${jsonShape()}`;
}

function imagePrompt(topic: string, level: BloomLevel, n: number, numPct: number, seedBlock: string) {
  return `Topic: ${topic || "(infer from the image)"}
Bloom Level: ${level} — ${BLOOM_META[level].description}
Verb hint: ${BLOOM_META[level].verb}

Read the attached image carefully (it may be a textbook page, worksheet, last year's question paper, diagram, or whiteboard).
Generate ${n} multiple-choice questions strictly at the "${level}" level of Bloom's Taxonomy based on the content shown.
${numericalHint(numPct, n)}${seedBlock}

${jsonShape()}`;
}

function syllabusPrompt(topic: string, className: string, syllabus: string, level: BloomLevel, n: number, numPct: number, seedBlock: string) {
  return `Topic: ${topic}
Class / grade: ${className}
Syllabus / board: ${syllabus || "(unspecified)"}
Bloom Level: ${level} — ${BLOOM_META[level].description}
Verb hint: ${BLOOM_META[level].verb}

Generate ${n} multiple-choice questions strictly at the "${level}" level of Bloom's Taxonomy on the topic above.
Tailor difficulty, vocabulary and examples to be appropriate for the specified class and aligned to the specified syllabus or curriculum.
${numericalHint(numPct, n)}${seedBlock}

${jsonShape()}`;
}

function pastPaperPrompt(topic: string, examLabel: string, level: BloomLevel, n: number, numPct: number, seedBlock: string) {
  return `Topic: ${topic || "(infer from the past paper)"}
Past paper / exam reference: ${examLabel || "(unspecified)"}
Bloom Level: ${level} — ${BLOOM_META[level].description}
Verb hint: ${BLOOM_META[level].verb}

The attached image is a PREVIOUS question paper. It may contain a MIX of question formats — multiple-choice, short-answer, long-answer / essay, fill-in-the-blanks, true/false, problem-solving, numerical, diagram-based, case-study, anything.

Your job is to read EVERY question carefully — regardless of its original format — and identify:
- The TOPICS and sub-topics being tested
- The CONCEPTS, definitions, principles, or skills the examiner is probing
- The DIFFICULTY level and depth of understanding required
- The marking pattern and what the examiner clearly weights

For open-ended / essay prompts: don't try to copy the format. Instead, pull out the underlying factual or conceptual claim being tested, and convert THAT into a sharp MCQ. A long "Explain…" or "Discuss…" question typically distils into 3–5 testable MCQ angles — pick the one most aligned to the requested Bloom level.

Now generate ${n} NEW multiple-choice questions strictly at the "${level}" level of Bloom's Taxonomy that:
- Cover the SAME topics and concepts as the past paper (even when those came from non-MCQ questions)
- Match the difficulty and conceptual depth the original demanded
- Are plausibly the kind of questions a student would face in a similar future exam
- Do NOT duplicate any past-paper question verbatim

Output is ALWAYS 4-option MCQs with one correct answer, regardless of the original question format.
${numericalHint(numPct, n)}${seedBlock}

${jsonShape()}`;
}

function topicOnlyPrompt(topic: string, level: BloomLevel, n: number, numPct: number, seedBlock: string) {
  return `Topic: ${topic}
Bloom Level: ${level} — ${BLOOM_META[level].description}
Verb hint: ${BLOOM_META[level].verb}

Generate ${n} multiple-choice questions strictly at the "${level}" level of Bloom's Taxonomy on the topic above, drawing on standard subject knowledge.
${numericalHint(numPct, n)}${seedBlock}

${jsonShape()}`;
}

function refinementSuffix(prev: { stem: string; options: string[]; correct_index: number }) {
  return `

The previous attempt produced this question, but a separate re-solve disputed its answer key. Generate a clearer single-question replacement with an unambiguous correct answer (still at the same Bloom level). Old version (for reference only — DO NOT repeat verbatim):
Stem: ${prev.stem}
Options: ${prev.options.map((o, i) => `${"ABCD"[i]}) ${o}`).join(" | ")}
Old correct_index: ${prev.correct_index}

Return JSON of the form { "questions": [ { "stem": "...", "options": ["A","B","C","D"], "correct_index": 0, "explanation": "..." } ] } with EXACTLY one question.`;
}

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Confirm caller is a student (this route is for self-generated tests)
    const { data: prof } = await sb.from("profiles").select("role").eq("id", user.id).single();
    if (prof?.role !== "student") {
      return NextResponse.json({ error: "Only students can use this endpoint" }, { status: 403 });
    }

    const body = await req.json();
    const source: Source = (body.source as Source) || "topic_only";
    const content: string = body.content || "";
    const topic: string = body.topic || "";
    const className: string = body.className || "";
    const syllabus: string = body.syllabus || "";
    const imageDataUrl: string = body.imageDataUrl || "";
    const examLabel: string = body.examLabel || "";
    const perLevel: number = Math.max(1, Math.min(10, Number(body.perLevel) || 2));
    const numericalPercent: number = Math.max(0, Math.min(100, Number(body.numericalPercent) || 0));
    const requested: string[] = Array.isArray(body.levels) ? body.levels : BLOOM_LEVELS;
    const levels: BloomLevel[] = requested.filter(isBloomLevel);
    const timeLimit: number = Math.max(1, Math.min(180, Number(body.timeLimit) || 15));

    // Validation
    if (source === "notes" && content.length < 20) {
      return NextResponse.json({ error: "Paste at least a paragraph of content." }, { status: 400 });
    }
    if (source === "image" && !imageDataUrl.startsWith("data:image/")) {
      return NextResponse.json({ error: "Pick an image to generate from." }, { status: 400 });
    }
    if (source === "past_paper" && !imageDataUrl.startsWith("data:image/")) {
      return NextResponse.json({ error: "Upload a photo of the past question paper." }, { status: 400 });
    }
    if (source === "topic_syllabus" && (!topic.trim() || !className.trim())) {
      return NextResponse.json({ error: "Topic and class/grade are required." }, { status: 400 });
    }
    if (source === "topic_only" && !topic.trim()) {
      return NextResponse.json({ error: "Topic is required." }, { status: 400 });
    }
    if (levels.length === 0) {
      return NextResponse.json({ error: "Pick at least one Bloom level." }, { status: 400 });
    }

    // eslint-disable-next-line no-console
    console.log(`[quick-test] start source=${source} levels=${levels.join(",")} perLevel=${perLevel} topic="${topic}"`);

    // Generate per-level
    const genFor = async (lvl: BloomLevel) => {
      // Mine misconception seeds — empty list on no-data => standard generation.
      let seedBlock = "";
      try {
        const seeds = await findMisconceptionDistractors({
          ownerId: user.id,
          topic: topic || null,
          bloomLevel: lvl,
          limit: 5,
          accessToken: token,
        });
        seedBlock = formatDistractorSeedsForPrompt(seeds);
        if (seeds.length > 0) {
          // eslint-disable-next-line no-console
          console.log(`[quick-test] level=${lvl}: spliced ${seeds.length} misconception seed(s) into prompt`);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[quick-test] level=${lvl}: seed mining failed (non-fatal):`, e instanceof Error ? e.message : e);
      }

      let json: Record<string, unknown>;
      switch (source) {
        case "past_paper":
          json = await groqJSONVision(SYSTEM, pastPaperPrompt(topic, examLabel, lvl, perLevel, numericalPercent, seedBlock), imageDataUrl);
          break;
        case "image":
          json = await groqJSONVision(SYSTEM, imagePrompt(topic, lvl, perLevel, numericalPercent, seedBlock), imageDataUrl);
          break;
        case "topic_syllabus":
          json = await groqJSON(SYSTEM, syllabusPrompt(topic, className, syllabus, lvl, perLevel, numericalPercent, seedBlock));
          break;
        case "topic_only":
          json = await groqJSON(SYSTEM, topicOnlyPrompt(topic, lvl, perLevel, numericalPercent, seedBlock));
          break;
        case "notes":
        default:
          json = await groqJSON(SYSTEM, notesPrompt(content, topic, lvl, perLevel, numericalPercent, seedBlock));
      }
      const arr: GenQ[] = Array.isArray((json as { questions?: GenQ[] })?.questions)
        ? (json as { questions: GenQ[] }).questions
        : [];
      // eslint-disable-next-line no-console
      console.log(`[quick-test] level=${lvl}: model returned ${arr.length} raw question(s)`);
      const passed = arr
        .filter((q) => q && q.stem && Array.isArray(q.options) && q.options.length === 4
                      && Number.isInteger(q.correct_index) && q.correct_index >= 0 && q.correct_index <= 3);

      const baseRows = passed.map((q) => ({
        owner_id: user.id,
        topic: topic || null,
        bloom_level: lvl,
        stem: String(q.stem).trim(),
        options: q.options.map((o) => String(o).trim()),
        correct_index: q.correct_index,
        explanation: q.explanation ? String(q.explanation).trim() : null,
        status: "approved" as const, // ← students self-trust, no review step
      }));

      // Self-verifying answer keys with one regeneration on dispute.
      const verifiable: VerifiableQuestion[] = baseRows.map((r) => ({
        stem: r.stem,
        options: [r.options[0], r.options[1], r.options[2], r.options[3]] as [string, string, string, string],
        correct_index: r.correct_index as 0 | 1 | 2 | 3,
      }));
      const verifyResults = await verifyAnswerKeys(verifiable, 5);

      const finalRows: Array<typeof baseRows[number] & {
        quality: { verified: boolean; reason?: string; reviewer_index?: number };
      }> = [];

      for (let i = 0; i < baseRows.length; i++) {
        const row = baseRows[i];
        const v = verifyResults[i];
        if (v.ok) {
          finalRows.push({ ...row, quality: { verified: true } });
          continue;
        }
        try {
          const refined = await groqJSON(
            SYSTEM,
            refinementSuffix({ stem: row.stem, options: row.options, correct_index: row.correct_index })
          );
          const cand = (refined as { questions?: GenQ[] })?.questions?.[0];
          if (
            cand && cand.stem && Array.isArray(cand.options) && cand.options.length === 4 &&
            Number.isInteger(cand.correct_index) && cand.correct_index >= 0 && cand.correct_index <= 3
          ) {
            const refinedQ: VerifiableQuestion = {
              stem: String(cand.stem).trim(),
              options: cand.options.map((o) => String(o).trim()) as [string, string, string, string],
              correct_index: cand.correct_index as 0 | 1 | 2 | 3,
            };
            const verifyResults2 = await verifyAnswerKeys([refinedQ], 1);
            const v2 = verifyResults2[0];
            const newRow = {
              ...row,
              stem: refinedQ.stem,
              options: [refinedQ.options[0], refinedQ.options[1], refinedQ.options[2], refinedQ.options[3]],
              correct_index: refinedQ.correct_index,
              explanation: cand.explanation ? String(cand.explanation).trim() : row.explanation,
            };
            if (v2.ok) {
              finalRows.push({ ...newRow, quality: { verified: true } });
            } else {
              // eslint-disable-next-line no-console
              console.warn(`[quick-test] level=${lvl}: refinement also disputed; keeping with verified:false`);
              finalRows.push({
                ...newRow,
                quality: { verified: false, reason: "answer_disputed", reviewer_index: v2.correctIndex },
              });
            }
          } else {
            // eslint-disable-next-line no-console
            console.warn(`[quick-test] level=${lvl}: refinement returned no usable question; keeping original`);
            finalRows.push({
              ...row,
              quality: { verified: false, reason: "answer_disputed", reviewer_index: v.correctIndex },
            });
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[quick-test] level=${lvl}: refinement call failed:`, e instanceof Error ? e.message : e);
          finalRows.push({
            ...row,
            quality: { verified: false, reason: "answer_disputed", reviewer_index: v.correctIndex },
          });
        }
      }

      return finalRows;
    };

    const summary = blankBloomCounts();
    const allRows: Awaited<ReturnType<typeof genFor>> = [];

    let results: PromiseSettledResult<Awaited<ReturnType<typeof genFor>>>[];
    const isVisionSource = source === "image" || source === "past_paper";
    if (isVisionSource) {
      results = [];
      for (const lvl of levels) {
        try {
          results.push({ status: "fulfilled", value: await genFor(lvl) });
        } catch (e) {
          results.push({ status: "rejected", reason: e });
        }
      }
    } else {
      results = await Promise.allSettled(levels.map(genFor));
    }

    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        const lvl = levels[i];
        summary[lvl] = r.value.length;
        allRows.push(...r.value);
      }
    });

    if (!allRows.length) {
      // Surface per-level reasons so the dev console + client know why
      const reasons = results
        .map((r, i) => r.status === "rejected" ? `${levels[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason).slice(0, 120)}` : `${levels[i]}: 0 valid questions`)
        .join(" | ");
      // eslint-disable-next-line no-console
      console.error(`[quick-test] no usable questions. Per-level: ${reasons}`);
      return NextResponse.json({
        error: `AI returned no usable questions. ${reasons.slice(0, 300)}`,
      }, { status: 502 });
    }

    // eslint-disable-next-line no-console
    console.log(`[quick-test] valid questions: ${allRows.length} across ${levels.length} levels`);

    // 1) Insert questions, get back the new IDs in order. Strip the in-memory
    //    `quality` field — question_bank has no such column. We surface
    //    aggregate verification stats on the response only.
    const insertRows = allRows.map((r) => {
      const { quality, ...rest } = r;
      void quality;
      return rest;
    });
    const { data: insertedQs, error: qErr } = await sb
      .from("question_bank")
      .insert(insertRows)
      .select("id, bloom_level");
    if (qErr) {
      // eslint-disable-next-line no-console
      console.error(`[quick-test] question_bank insert failed:`, qErr.message);
      return NextResponse.json({ error: `Could not save questions: ${qErr.message}` }, { status: 500 });
    }

    // 2) Classify the quiz — best-effort. If migration 05 isn't applied or the
    //    LLM hiccups, we fall back to no classification rather than blocking.
    let classification: { subject: string | null; topic_family: string | null } = { subject: null, topic_family: null };
    try {
      const { data: existingFams } = await sb
        .from("quizzes")
        .select("topic_family")
        .eq("owner_id", user.id)
        .not("topic_family", "is", null)
        .limit(50);
      const existingFamilies = Array.from(new Set(
        ((existingFams || []) as Array<{ topic_family: string }>).map((e) => e.topic_family).filter(Boolean)
      ));
      const sampleStems = allRows.slice(0, 3).map((r) => r.stem);
      classification = await classifyQuiz(topic, sampleStems, existingFamilies);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[quick-test] classify failed (non-fatal):`, e instanceof Error ? e.message : e);
    }

    // 3) Create a quiz with a fresh code. The collision check needs to see
    // OTHER users' codes too (the unique index spans the whole table), so
    // we use the service-role admin client — RLS would otherwise hide rows
    // that don't belong to the caller.
    const adminCheck = supabaseAdmin();
    let code = generateQuizCode();
    for (let i = 0; i < 4; i++) {
      const { data: existing } = await adminCheck.from("quizzes").select("id").eq("code", code).maybeSingle();
      if (!existing) break;
      code = generateQuizCode();
    }

    const niceName =
      source === "past_paper" ? `Past-paper drill${examLabel ? ` — ${examLabel}` : ""}${topic ? `: ${topic}` : ""}` :
      source === "topic_only" || source === "topic_syllabus" ? `Practice: ${topic}` :
      source === "image" ? `Practice from image${topic ? `: ${topic}` : ""}` :
      `Practice from notes${topic ? `: ${topic}` : ""}`;

    // Try the rich insert first. If the schema doesn't have subject/topic_family
    // yet (migrations 04/05 not applied), gracefully fall back to the basic insert
    // so the test still gets created.
    type QuizInsert = {
      owner_id: string; name: string; code: string;
      time_limit_minutes: number; bloom_filter: string[];
      subject?: string | null; topic_family?: string | null;
    };
    const fullInsert: QuizInsert = {
      owner_id: user.id,
      name: niceName,
      subject: classification.subject || (topic || null),
      topic_family: classification.topic_family,
      code,
      time_limit_minutes: timeLimit,
      bloom_filter: levels,
    };
    let { data: quiz, error: quizErr } = await sb.from("quizzes").insert(fullInsert).select().single();
    if (quizErr && /column .*(topic_family|subject)/i.test(quizErr.message)) {
      // eslint-disable-next-line no-console
      console.warn(`[quick-test] schema missing subject/topic_family — falling back. Apply migrations 04 + 05 + 'notify pgrst, "reload schema";'.`);
      const fallbackInsert: QuizInsert = {
        owner_id: user.id,
        name: niceName,
        code,
        time_limit_minutes: timeLimit,
        bloom_filter: levels,
      };
      const fb = await sb.from("quizzes").insert(fallbackInsert).select().single();
      quiz = fb.data;
      quizErr = fb.error;
    }
    if (quizErr || !quiz) {
      // eslint-disable-next-line no-console
      console.error(`[quick-test] quiz insert failed:`, quizErr?.message);
      return NextResponse.json({ error: `Could not create quiz: ${quizErr?.message || "unknown"}` }, { status: 500 });
    }

    // 3) Attach questions to the quiz, preserving Bloom level order then insertion order
    const ordered = (insertedQs as { id: string; bloom_level: BloomLevel }[]).slice().sort((a, b) => {
      const ai = BLOOM_LEVELS.indexOf(a.bloom_level);
      const bi = BLOOM_LEVELS.indexOf(b.bloom_level);
      return ai - bi;
    });
    const linkRows = ordered.map((q, i) => ({
      quiz_id: quiz!.id,
      question_id: q.id,
      position: i,
    }));
    const { error: linkErr } = await sb.from("quiz_questions").insert(linkRows);
    if (linkErr) {
      // eslint-disable-next-line no-console
      console.error(`[quick-test] quiz_questions insert failed:`, linkErr.message);
      return NextResponse.json({ error: `Could not link questions to quiz: ${linkErr.message}` }, { status: 500 });
    }

    // eslint-disable-next-line no-console
    console.log(`[quick-test] success: quiz=${quiz!.code} questions=${linkRows.length}`);

    const verifiedCount = allRows.filter((r) => r.quality.verified).length;
    const disputedCount = allRows.length - verifiedCount;

    return NextResponse.json({
      ok: true,
      quizId: quiz!.id,
      quizCode: quiz!.code,
      summary,
      total: allRows.length,
      verification: {
        verified: verifiedCount,
        disputed: disputedCount,
      },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[quick-test] unexpected error:`, e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Test creation failed" }, { status: 500 });
  }
}
