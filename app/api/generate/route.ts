import { NextResponse } from "next/server";
import { groqJSON, groqJSONVision } from "@/lib/groq";
import { BLOOM_LEVELS, BLOOM_META, type BloomLevel, isBloomLevel, blankBloomCounts } from "@/lib/bloom";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import {
  findMisconceptionDistractors,
  formatDistractorSeedsForPrompt,
  verifyAnswerKeys,
  type VerifiableQuestion,
} from "@/lib/qgen";

export const runtime = "nodejs";
export const maxDuration = 60;

type GenQ = { stem: string; options: string[]; correct_index: number; explanation: string };
type Source = "notes" | "image" | "topic_syllabus" | "topic_only";

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
  return `\n\nNumerical-content target: about ${pct}% (~${target} of ${n}) of these questions should involve numerical reasoning — calculation, formulas, equations, units, or quantitative analysis — BUT ONLY IF the topic naturally supports it (math, physics, chemistry, finance, statistics, economics, etc.). If the topic is purely conceptual (history, literature, geography, philosophy, civics), ignore this and write conceptual questions instead. Don't shoehorn fake numbers into a non-numerical topic.`;
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

Read the attached image carefully (it may be a textbook page, worksheet, diagram, photograph, or whiteboard).
Generate ${n} multiple-choice questions strictly at the "${level}" level of Bloom's Taxonomy based on the content shown in the image.
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

    const body = await req.json();
    const source: Source = (body.source as Source) || "notes";
    const content: string = body.content || "";
    const topic: string = body.topic || "";
    const className: string = body.className || "";
    const syllabus: string = body.syllabus || "";
    const imageDataUrl: string = body.imageDataUrl || "";
    const perLevel: number = Math.max(1, Math.min(10, Number(body.perLevel) || 2));
    const numericalPercent: number = Math.max(0, Math.min(100, Number(body.numericalPercent) || 0));
    const requested: string[] = Array.isArray(body.levels) ? body.levels : BLOOM_LEVELS;
    const levels: BloomLevel[] = requested.filter(isBloomLevel);

    // Per-source validation
    if (source === "notes" && content.length < 20) {
      return NextResponse.json({ error: "Content too short" }, { status: 400 });
    }
    if (source === "image" && !imageDataUrl.startsWith("data:image/")) {
      return NextResponse.json({ error: "Missing or invalid image" }, { status: 400 });
    }
    if (source === "topic_syllabus" && (!topic.trim() || !className.trim())) {
      return NextResponse.json({ error: "Topic and class/grade are required" }, { status: 400 });
    }
    if (source === "topic_only" && !topic.trim()) {
      return NextResponse.json({ error: "Topic is required" }, { status: 400 });
    }
    if (levels.length === 0) {
      return NextResponse.json({ error: "No Bloom levels selected" }, { status: 400 });
    }

    const summary = blankBloomCounts();
    type RowWithQuality = {
      owner_id: string; topic: string | null; bloom_level: BloomLevel;
      stem: string; options: string[]; correct_index: number;
      explanation: string | null; status: "pending";
      quality: { verified: boolean; reason?: string; reviewer_index?: number };
    };
    const allRows: RowWithQuality[] = [];

    // Build a generator per level — different prompt + model depending on source
    const genFor = async (lvl: BloomLevel) => {
      // Mine misconception seeds for this teacher + topic + level. Empty array
      // on no-data / error => standard generation, no behaviour change.
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
          console.log(`[generate] level=${lvl}: spliced ${seeds.length} misconception seed(s) into prompt`);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[generate] level=${lvl}: seed mining failed (non-fatal):`, e instanceof Error ? e.message : e);
      }

      let json: Record<string, unknown>;
      try {
        switch (source) {
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
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[generate] Groq call failed for level=${lvl}:`, e instanceof Error ? e.message : e);
        throw e;
      }
      const arr: GenQ[] = Array.isArray((json as { questions?: GenQ[] })?.questions)
        ? (json as { questions: GenQ[] }).questions
        : [];
      // eslint-disable-next-line no-console
      console.log(`[generate] level=${lvl}: model returned ${arr.length} raw question(s)`);
      const passed = arr
        .filter((q) => q && q.stem && Array.isArray(q.options) && q.options.length === 4
                      && Number.isInteger(q.correct_index) && q.correct_index >= 0 && q.correct_index <= 3);
      if (passed.length < arr.length) {
        // eslint-disable-next-line no-console
        console.warn(`[generate] level=${lvl}: ${arr.length - passed.length} question(s) rejected by validation`);
      }

      // Self-verifying answer keys: re-solve every passed question; if the
      // re-solve disagrees, try ONE refinement; if that still disagrees,
      // mark verified=false and let it through with metadata.
      const baseRows = passed.map((q) => ({
        owner_id: user.id,
        topic: topic || null,
        bloom_level: lvl,
        stem: String(q.stem).trim(),
        options: q.options.map((o) => String(o).trim()),
        correct_index: q.correct_index,
        explanation: q.explanation ? String(q.explanation).trim() : null,
        status: "pending" as const,
      }));

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
        // Disputed — try one refinement.
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
              console.warn(`[generate] level=${lvl}: refinement also disputed; keeping with verified:false`);
              finalRows.push({
                ...newRow,
                quality: { verified: false, reason: "answer_disputed", reviewer_index: v2.correctIndex },
              });
            }
          } else {
            // Refinement returned junk — keep original, mark unverified.
            // eslint-disable-next-line no-console
            console.warn(`[generate] level=${lvl}: refinement returned no usable question; keeping original`);
            finalRows.push({
              ...row,
              quality: { verified: false, reason: "answer_disputed", reviewer_index: v.correctIndex },
            });
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[generate] level=${lvl}: refinement call failed:`, e instanceof Error ? e.message : e);
          finalRows.push({
            ...row,
            quality: { verified: false, reason: "answer_disputed", reviewer_index: v.correctIndex },
          });
        }
      }

      return finalRows;
    };

    // Image generation calls run sequentially to keep the multipart payload sane;
    // text-only calls fan out in parallel for speed.
    let results: PromiseSettledResult<Awaited<ReturnType<typeof genFor>>>[];
    if (source === "image") {
      results = [];
      for (const lvl of levels) {
        try {
          const v = await genFor(lvl);
          results.push({ status: "fulfilled", value: v });
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
      // Surface the per-level reasons so the client (and the dev server log) can see what went wrong
      const reasons = results
        .map((r, i) => r.status === "rejected" ? `${levels[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason).slice(0, 120)}` : `${levels[i]}: 0 valid questions`)
        .join(" | ");
      // eslint-disable-next-line no-console
      console.error(`[generate] No questions produced. Per-level: ${reasons}`);
      return NextResponse.json({
        error: `AI returned no usable questions. ${reasons.slice(0, 300)}`,
      }, { status: 502 });
    }

    // Strip the in-memory `quality` field before persisting — question_bank
    // has no such column. We expose the aggregate verification stats on the
    // API response only, so existing consumers stay unaffected.
    const insertRows = allRows.map((r) => {
      const { quality, ...rest } = r;
      void quality;
      return rest;
    });
    const { error } = await sb.from("question_bank").insert(insertRows);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const verifiedCount = allRows.filter((r) => r.quality.verified).length;
    const disputedCount = allRows.length - verifiedCount;

    return NextResponse.json({
      ok: true,
      summary,
      total: allRows.length,
      verification: {
        verified: verifiedCount,
        disputed: disputedCount,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Generation failed" }, { status: 500 });
  }
}
