// lib/qgen.ts
//
// Server-only helpers that upgrade BloomIQ's Groq-based MCQ generation with:
//
//   1. Misconception-aware distractors  (findMisconceptionDistractors)
//      Mines past `attempt_answers` joined to `question_bank` for the same
//      teacher / topic / Bloom level. Surfaces the wrong answers students
//      actually picked >=20% of the time as "distractor seeds" — the LLM
//      can then design new wrong options that diagnose those same kinds
//      of thinking errors instead of inventing generic distractors.
//
//   2. Self-verifying answer keys      (verifyAnswerKey)
//      After each MCQ is generated, makes a SECOND, fresh Groq call asking
//      the model to re-solve the question from scratch. If its answer
//      disagrees with the stored correct_index, the caller can regenerate
//      or flag the question for review.
//
//   3. Prompt formatting helper        (formatDistractorSeedsForPrompt)
//      Converts the seed list into a chunk of natural-language guidance
//      that callers can splice into their existing prompts.
//
// Backwards-compatible by design: zero historical wrong answers => zero
// seeds => standard generation, no behavioural change.

import { groqJSON } from "@/lib/groq";
import { supabaseServer } from "@/lib/supabase/server";
import type { BloomLevel } from "@/lib/bloom";

// --- public types ---------------------------------------------------------

export type DistractorSeedOpts = {
  /** Teacher whose question_bank/attempts we mine. */
  ownerId: string;
  /** null = any topic */
  topic: string | null;
  /** null = any Bloom level */
  bloomLevel: BloomLevel | null;
  /** Default 5. */
  limit?: number;
  /** Optional bearer token to scope Supabase to this user (RLS-safe). */
  accessToken?: string;
};

export type DistractorSeed = {
  example_stem: string;
  wrong_text: string;
  pct_chose: number; // 0-100
  correct_text: string;
};

export type VerifiableQuestion = {
  stem: string;
  options: [string, string, string, string];
  correct_index: 0 | 1 | 2 | 3;
};

export type VerifyResult = {
  ok: boolean;
  correctIndex?: number;
  reasoning?: string;
};

// --- internal helpers -----------------------------------------------------

type QuestionRow = {
  id: string;
  stem: string;
  options: unknown; // jsonb (string[]) but Supabase types it loosely
  correct_index: number;
};

type AnswerRow = {
  question_id: string;
  selected_index: number | null;
  is_correct: boolean | null;
};

function asStringArray(x: unknown): string[] | null {
  if (!Array.isArray(x)) return null;
  if (x.length !== 4) return null;
  if (!x.every((v) => typeof v === "string")) return null;
  return x as string[];
}

function letterToIndex(letter: string): number | null {
  const c = letter.trim().toUpperCase();
  if (c === "A") return 0;
  if (c === "B") return 1;
  if (c === "C") return 2;
  if (c === "D") return 3;
  // Some models reply with the option text or "0".."3"
  if (/^[0-3]$/.test(c)) return Number(c);
  return null;
}

// --- A. mine misconception distractor seeds -------------------------------

/**
 * Mine the teacher's historical question_bank + attempt_answers to find the
 * wrong-answer patterns at least 20% of students fell for (with >=3 attempts
 * per question). Returns up to `limit` patterns, sorted by pct_chose desc.
 *
 * If anything is missing — no historical data, RLS denies us, schema mismatch —
 * we return [] and let the caller fall back to standard generation.
 */
export async function findMisconceptionDistractors(
  opts: DistractorSeedOpts
): Promise<DistractorSeed[]> {
  const limit = Math.max(1, Math.min(20, opts.limit ?? 5));
  const sb = supabaseServer(opts.accessToken);

  // Step 1: find the teacher's questions matching topic + bloom level.
  let qQuery = sb
    .from("question_bank")
    .select("id, stem, options, correct_index")
    .eq("owner_id", opts.ownerId)
    .limit(500);

  if (opts.bloomLevel) qQuery = qQuery.eq("bloom_level", opts.bloomLevel);
  if (opts.topic && opts.topic.trim().length > 0) {
    // Case-insensitive partial match on the text column. ILIKE pattern is
    // safe here — Supabase's REST layer parameterises it.
    qQuery = qQuery.ilike("topic", `%${opts.topic.trim()}%`);
  }

  const { data: qs, error: qErr } = await qQuery;
  if (qErr || !qs || qs.length === 0) {
    if (qErr) {
      // eslint-disable-next-line no-console
      console.warn("[qgen] distractor mine: question_bank query failed:", qErr.message);
    }
    return [];
  }

  // Build id->question lookup. Skip malformed option arrays.
  const byId = new Map<string, { stem: string; options: string[]; correct_index: number }>();
  for (const r of qs as QuestionRow[]) {
    const opts4 = asStringArray(r.options);
    if (!opts4) continue;
    if (!Number.isInteger(r.correct_index) || r.correct_index < 0 || r.correct_index > 3) continue;
    byId.set(r.id, { stem: r.stem, options: opts4, correct_index: r.correct_index });
  }
  if (byId.size === 0) return [];

  // Step 2: pull all attempt_answers for those questions.
  const ids = Array.from(byId.keys()).slice(0, 500);
  const { data: ans, error: aErr } = await sb
    .from("attempt_answers")
    .select("question_id, selected_index, is_correct")
    .in("question_id", ids);
  if (aErr || !ans || ans.length === 0) {
    if (aErr) {
      // eslint-disable-next-line no-console
      console.warn("[qgen] distractor mine: attempt_answers query failed:", aErr.message);
    }
    return [];
  }

  // Step 3: tally totals + per-(question, wrong-index) counts.
  const total = new Map<string, number>(); // question_id -> total attempts
  const wrong = new Map<string, number>(); // `${qid}|${idx}` -> count
  for (const a of ans as AnswerRow[]) {
    if (a.selected_index === null || a.selected_index === undefined) continue;
    if (a.selected_index < 0 || a.selected_index > 3) continue;
    total.set(a.question_id, (total.get(a.question_id) || 0) + 1);
    if (a.is_correct === false) {
      const key = `${a.question_id}|${a.selected_index}`;
      wrong.set(key, (wrong.get(key) || 0) + 1);
    }
  }

  // Step 4: build candidate seeds, filter, sort, slice.
  const seeds: DistractorSeed[] = [];
  for (const [key, cnt] of wrong.entries()) {
    const [qid, idxStr] = key.split("|");
    const idx = Number(idxStr);
    const tot = total.get(qid) || 0;
    if (tot < 3) continue;
    const pct = (cnt / tot) * 100;
    if (pct < 20) continue;
    const q = byId.get(qid);
    if (!q) continue;
    const wrongText = q.options[idx];
    if (!wrongText) continue;
    seeds.push({
      example_stem: q.stem,
      wrong_text: wrongText,
      pct_chose: Math.round(pct),
      correct_text: q.options[q.correct_index] || "",
    });
  }

  seeds.sort((a, b) => b.pct_chose - a.pct_chose);
  return seeds.slice(0, limit);
}

// --- B. format seeds for prompt splicing ----------------------------------

/**
 * Returns a string the caller splices into its existing prompt. Empty string
 * if there are no seeds — caller can blindly concatenate without a guard.
 */
export function formatDistractorSeedsForPrompt(seeds: DistractorSeed[]): string {
  if (!seeds || seeds.length === 0) return "";

  const lines = seeds.map((s, i) => {
    const stem = s.example_stem.length > 220 ? s.example_stem.slice(0, 217) + "..." : s.example_stem;
    return `${i + 1}. (${s.pct_chose}% chose) "${s.wrong_text}" — actually the correct answer was "${s.correct_text}". Past stem: "${stem}"`;
  });

  return `

Common misconceptions students show on similar past questions (for inspiration; you don't have to use these literally — produce distractors that diagnose the same kinds of thinking errors):

${lines.join("\n")}

When designing your distractors:
- Anchor at least one wrong option in a real misconception above when applicable.
- Keep all 4 options the same approximate length and grammatical form.
- Avoid trivially-wrong distractors like "none of the above" or "42".
`;
}

// --- C. self-verifying answer key -----------------------------------------

const VERIFY_SYSTEM = "You are a careful subject-matter expert. Solve the MCQ precisely.";

function buildVerifyPrompt(q: VerifiableQuestion): string {
  return `You are re-solving a multiple-choice question to verify the answer key. Read the stem and the four options. Pick the option you believe is the single most correct answer, and explain in one sentence why.

Question: ${q.stem}
A) ${q.options[0]}
B) ${q.options[1]}
C) ${q.options[2]}
D) ${q.options[3]}

Respond with valid JSON only:
{ "answer": "A"|"B"|"C"|"D", "reasoning": "..." }`;
}

/**
 * Re-solve `question` from scratch using Groq and confirm whether the model
 * agrees with `question.correct_index`.
 *
 * - On agreement: { ok: true, correctIndex, reasoning }.
 * - On disagreement: { ok: false, correctIndex: <model's pick>, reasoning }.
 * - On parse failure or transport error: { ok: true } (treat as inconclusive
 *   — we don't want noise to kill every question). A warning is logged.
 */
export async function verifyAnswerKey(question: VerifiableQuestion): Promise<VerifyResult> {
  // Defensive validation — never crash the caller.
  if (
    !question ||
    typeof question.stem !== "string" ||
    !Array.isArray(question.options) ||
    question.options.length !== 4 ||
    !question.options.every((o) => typeof o === "string") ||
    !Number.isInteger(question.correct_index) ||
    question.correct_index < 0 ||
    question.correct_index > 3
  ) {
    // eslint-disable-next-line no-console
    console.warn("[qgen.verifyAnswerKey] malformed question, skipping verify");
    return { ok: true };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = await groqJSON(VERIFY_SYSTEM, buildVerifyPrompt(question));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      "[qgen.verifyAnswerKey] groqJSON failed, treating as inconclusive:",
      e instanceof Error ? e.message : e
    );
    return { ok: true };
  }

  const rawAnswer = parsed?.answer;
  const reasoning = typeof parsed?.reasoning === "string" ? (parsed.reasoning as string) : undefined;

  if (typeof rawAnswer !== "string") {
    // eslint-disable-next-line no-console
    console.warn("[qgen.verifyAnswerKey] missing/non-string 'answer' in response");
    return { ok: true, reasoning };
  }

  const idx = letterToIndex(rawAnswer);
  if (idx === null) {
    // eslint-disable-next-line no-console
    console.warn(`[qgen.verifyAnswerKey] could not parse answer letter: "${rawAnswer}"`);
    return { ok: true, reasoning };
  }

  if (idx === question.correct_index) {
    return { ok: true, correctIndex: question.correct_index, reasoning };
  }
  return { ok: false, correctIndex: idx, reasoning };
}

// --- D. concurrency-limited verify (used by routes that gen many Qs) ------

/**
 * Run verifyAnswerKey across a list of questions with at most `concurrency`
 * in-flight Groq calls. Maintains input order in the output array.
 */
export async function verifyAnswerKeys(
  questions: VerifiableQuestion[],
  concurrency = 5
): Promise<VerifyResult[]> {
  const out: VerifyResult[] = new Array(questions.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  const lanes = Math.max(1, Math.min(concurrency, questions.length));
  for (let w = 0; w < lanes; w++) {
    workers.push(
      (async () => {
        while (true) {
          const i = next++;
          if (i >= questions.length) return;
          out[i] = await verifyAnswerKey(questions[i]);
        }
      })()
    );
  }
  await Promise.all(workers);
  return out;
}

// =============================================================================
// E. QUALITY FILTERS — answer-leak detection + near-duplicate dedup.
// -----------------------------------------------------------------------------
// Vipin caught two recurring AI failures on 2026-05-12:
//   1. "Some answers are in the question itself" — the AI generates a stem
//      like "What is photosynthesis?" with option "A. Photosynthesis is the
//      process …", giving the answer away by repetition.
//   2. "Questions are repetitive — not literally, but multiple questions
//      mean the same thing" — the AI paraphrases the same concept multiple
//      times in one batch, padding the count without adding learning value.
//
// Both filters run AFTER structural validation and BEFORE the .slice() cap,
// so we drop bad rows first and only THEN trim to the requested count.
// =============================================================================

/** Lowercase + collapse non-word chars to a single space, trim. Used to
 *  normalise both stems and option text before any comparison. */
function normaliseForCompare(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokenise normalised text into a set of meaningful words (>= 4 chars).
 *  Short words ("the", "is", "of") would dominate any overlap score and
 *  collapse it to noise, so we skip them. */
function tokenSet(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of normaliseForCompare(s).split(" ")) {
    if (t.length >= 4) out.add(t);
  }
  return out;
}

/** Jaccard similarity on two token sets, 0..1. 0 = nothing in common,
 *  1 = identical token bags. Cheap and good enough to catch paraphrases
 *  for our scale (≤ 30 questions per call). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export type LeakCheckable = {
  stem: string;
  options: string[];
  correct_index: number;
};

/**
 * Detect "the correct answer is inside the question stem" — the most
 * common AI failure mode that makes a question trivially solvable by
 * pattern-matching alone.
 *
 * Heuristic: if every meaningful word (≥ 4 chars) of the correct option
 * also appears in the stem, the answer is effectively echoed. We don't
 * require literal substring match — "Photosynthesis is the process …"
 * (option) and "What is photosynthesis?" (stem) share the only word
 * that matters.
 *
 * Returns true when the question is OK (no leak), false when it should
 * be discarded.
 */
export function isStemAnswerLeakClean(q: LeakCheckable): boolean {
  if (!q || !q.stem || !Array.isArray(q.options)) return false;
  const ci = q.correct_index;
  if (!Number.isInteger(ci) || ci < 0 || ci >= q.options.length) return false;
  const correct = q.options[ci];
  if (!correct) return false;

  const stemTokens = tokenSet(q.stem);
  const correctTokens = tokenSet(correct);

  // Single-word answers (e.g. "Photosynthesis"): leak if the word is in the stem.
  if (correctTokens.size === 1) {
    const [only] = Array.from(correctTokens);
    return !stemTokens.has(only);
  }

  // Multi-word answers: leak if EVERY meaningful token is also in the stem.
  if (correctTokens.size === 0) return true; // option has no signal — let it through
  for (const t of correctTokens) {
    if (!stemTokens.has(t)) return true; // at least one token is unique to the answer — OK
  }
  return false; // every answer token also in stem → leak
}

/**
 * Drop near-duplicate questions from a batch. Two questions are
 * considered near-duplicates when their stem token sets have Jaccard
 * similarity >= threshold (default 0.7).
 *
 * We keep the FIRST occurrence — usually the AI's strongest attempt.
 * The dropped list is returned alongside for telemetry / logging.
 */
export function dedupeBySimilarity<T extends { stem: string }>(
  items: T[],
  threshold = 0.7,
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  const keptTokens: Set<string>[] = [];
  for (const item of items) {
    const toks = tokenSet(item.stem);
    let dup = false;
    for (const prev of keptTokens) {
      if (jaccard(toks, prev) >= threshold) { dup = true; break; }
    }
    if (dup) {
      dropped.push(item);
    } else {
      kept.push(item);
      keptTokens.push(toks);
    }
  }
  return { kept, dropped };
}

/**
 * Convenience: run leak detection + within-batch similarity dedup +
 * (Layer 2) cross-test similarity dedup against the student's recent
 * history + final hard slice to the requested count.
 *
 * The cross-test layer takes a `historyStems` array — stems the student
 * has already seen on this topic + bloom level within the last 30 days
 * (see lib/recentStemsExclusion.ts → getRecentStemsForExclusion). Any
 * new question whose stem is ≥ similarityThreshold Jaccard-similar to a
 * historyStem is dropped, even if the AI ignored the explicit "don't
 * repeat" rule in the prompt.
 *
 * Routes can call this once and get a clean batch back, plus a stats
 * object for logging / instrumentation.
 */
export function filterQuestionBatch<T extends LeakCheckable>(
  items: T[],
  opts: {
    maxCount: number;
    similarityThreshold?: number;
    /** Stems the student has already seen — used for Layer 2 cross-test
     *  dedup. Pass an empty array (or omit) when there's no history. */
    historyStems?: string[];
  } = { maxCount: Infinity },
): { kept: T[]; droppedLeak: T[]; droppedDup: T[]; droppedHistory: T[]; trimmed: T[] } {
  const threshold = opts.similarityThreshold ?? 0.7;
  const historyStems = opts.historyStems ?? [];
  // Pre-compute token sets for history so we don't tokenise per candidate.
  const historyTokens: Set<string>[] = historyStems.map(tokenSet);

  const droppedLeak: T[] = [];
  const stage1: T[] = [];
  for (const q of items) {
    if (isStemAnswerLeakClean(q)) stage1.push(q);
    else droppedLeak.push(q);
  }

  // Stage 2: dedupe within the batch (peers).
  const { kept: stage2, dropped: droppedDup } = dedupeBySimilarity(stage1, threshold);

  // Stage 3 (Layer 2): dedupe against student's recent history.
  const droppedHistory: T[] = [];
  const stage3: T[] = [];
  if (historyTokens.length === 0) {
    stage3.push(...stage2);
  } else {
    for (const item of stage2) {
      const toks = tokenSet(item.stem);
      let collisions = false;
      for (const prev of historyTokens) {
        if (jaccard(toks, prev) >= threshold) { collisions = true; break; }
      }
      if (collisions) droppedHistory.push(item);
      else stage3.push(item);
    }
  }

  const max = Math.max(0, Math.floor(opts.maxCount));
  const kept = Number.isFinite(max) ? stage3.slice(0, max) : stage3;
  const trimmed = Number.isFinite(max) ? stage3.slice(max) : [];
  return { kept, droppedLeak, droppedDup, droppedHistory, trimmed };
}
