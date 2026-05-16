// lib/qgenPipeline.ts
// F101 + F113 note (QA): two of the seven generator routes still copy
// the conceptual pipeline instead of calling here:
//   - /api/teacher/generate/route.ts (F101)
//   - /api/student/quick-test/route.ts (F113)
// Migration plan per route: build context → call processGenerationPipeline
// → write to question_bank. Each migration is ~1 day, including tests.
// Until then, fixes to dedup / leak detection / verifyAnswerKeys must
// be mirrored to all three places — that's the cost of the duplication.
// F101 + F113 note (QA): two of the seven generator routes still copy
// the conceptual pipeline instead of calling here:
//   - /api/teacher/generate/route.ts (F101)
//   - /api/student/quick-test/route.ts (F113)
// Migration plan per route: build context → call processGenerationPipeline
// → write to question_bank. Each migration is ~1 day, including tests.
// Until then, fixes to dedup / leak detection / verifyAnswerKeys must
// be mirrored to all three places — that's the cost of the duplication.
// =============================================================================
// Shared question-generation pipeline (P0.1).
// -----------------------------------------------------------------------------
// Why
// ---
// Today seven generator routes (student/generate, teacher/generate, speed,
// flashcards, teach-back, papers/generate, adaptive-practice) each copy the
// same conceptual pipeline:
//   1. Resolve learner / audience / exam-goal context
//   2. Pull recent stems for cross-test dedup
//   3. Mine misconception distractors
//   4. Splice prompt fragments
//   5. Call Groq
//   6. Validate structural shape
// F91 note (QA): dedup currently sees question_bank stems (saved) and
// recent embeddings (saved), but NOT stems that were shown to a student
// and abandoned mid-attempt. quiz_attempts has the raw shown stems; a
// future dedup pass could JOIN on it to suppress just-saw-it-yesterday
// repeats. Requires schema verification of attempts.shown_stems[].
//   7. Run leak detection + Jaccard dedup
//   8. Embed surviving stems (for migration-80 column)
//   9. Run verifyAnswerKeys
//   10. Insert into question_bank with category + embedding
//
// Each route drifts independently — flashcards forgot to embed for 3 weeks,
// Speed Trainer never called verifyAnswerKeys, papers/generate caught up to
// the misconception-seed feature 2 weeks late. The fix is one place that
// owns the WHOLE pipeline; routes provide:
//   - The prompt strings (their generation intent varies)
//   - The persistence target (Speed keeps questions in-memory; quizzes
//     persist; flashcards persist in a different shape)
//   - Any per-route knobs (concurrency, batch size, etc.)
//
// Design
// ------
// Three composable surfaces, each callable on its own:
//
//   prepareGenerationContext(input)
//       Read-only: assembles distractor seeds, exclusion stems +
//       embeddings, prompt fragments. No AI call. Pure preparation.
//
//   postProcessCandidates(candidates, ctx)
//       Takes raw LLM output, runs the full quality pipeline:
//       leak → jaccard → cosine-in-batch → cosine-history → answer-key
//       verifier → optional bloom verifier. Returns kept rows with
//       per-row generation_meta ready for insert.
//
//   generateQuestions(input)
//       Convenience: prepare → caller-supplied LLM call → post-process.
//       Most routes will use this one.
//
// Backwards compatibility
// -----------------------
// This module is ADDITIVE. Existing routes continue to work unmodified
// until they're individually migrated. The new generation_meta column
// (migration 91) defaults to {} when the pipeline isn't used, so reviews
// just don't render the new badges for legacy rows.
//
// Author: 2026-05-16 (per the senior-architect review pass)
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BloomLevel } from "@/lib/bloom";
import {
  findMisconceptionDistractors,
  formatDistractorSeedsForPrompt,
  type DistractorSeed,
  filterQuestionBatch,
  type LeakCheckable,
  verifyAnswerKeys,
  type VerifyResult,
} from "@/lib/qgen";
import {
  embedTexts,
  cosineDedupInBatch,
  cosineDedupAgainstHistory,
} from "@/lib/embeddings";
import {
  getRecentStemsForExclusion,
  fetchRecentEmbeddingsForOwner,
  type ExclusionPayload,
} from "@/lib/recentStemsExclusion";
import { sanitizeUserText } from "@/lib/promptSafety";
import { verifyBloomBatch, type BloomVerifierResult } from "@/lib/bloomVerifier";
import { resolveAudienceLevel, type AudienceLevel } from "@/lib/audienceLevel";

// =============================================================================
// Public types
// =============================================================================

/** Route identifiers that flow into generation_meta.route for provenance.
 *  Add a new value here when wiring a new route through the pipeline. */
export type GenerationRoute =
  | "student.generate"
  | "student.adaptive-practice"
  | "student.flashcards"
  | "student.teach-back"
  | "speed"
  | "teacher.generate"
  | "teacher.papers"
  | "teacher.flashcards"
  | "teacher.practice";

/** Bumped manually when the underlying prompt templates change. Persisted
 *  in generation_meta.prompt_version so we can bisect quality regressions
 *  to a specific prompt edit. */
export const PROMPT_VERSION = "qgen.v3.2026-05-16";

export type GenerationInput = {
  /** Free-text topic the user typed. Will be sanitized + capped. */
  topic: string;
  /** Bloom levels in this batch — used for exclusion filtering and the
   *  Bloom verifier. Pass [] when the batch is mixed and you don't want
   *  Bloom-level scoping. */
  levels: BloomLevel[];
  /** Total expected count for telemetry; caller controls the actual
   *  per-level distribution via perLevelCounts. */
  perLevel?: number;
  perLevelCounts?: Partial<Record<BloomLevel, number>>;
  /** Slug like 'jee_main' or 'class_10_boards' — written to
   *  question_bank.category by routes that persist. */
  category?: string | null;
  examGoal?: string | null;
  learnerProfile?: string | null;
  audienceLevel?: string | null;
  /** Free-text refinement field (the "Anything else?" box). Sanitized. */
  additionalFocus?: string | null;
  /** Optional source material (e.g. uploaded PDF text). Sanitized. */
  content?: string | null;
  /** Surface label for prompt copy + telemetry ("student.generate" etc). */
  route: GenerationRoute;
  /** Owner of the generated question_bank rows (teacher OR student). */
  ownerId: string;
};

export type GenerationContext = {
  /** Sanitized & capped values, safe to splice into prompts. */
  sanitized: {
    topic: string;
    additionalFocus: string;
    learnerProfile: string;
    content: string;
    /** True when at least one sanitizer hit fired — write to telemetry. */
    anyModified: boolean;
  };
  /** Misconception seeds (≤ 5) ready to splice. */
  distractorSeeds: DistractorSeed[];
  distractorSeedsBlock: string;
  /** Exclusion payload (recent stems + concepts + ready prompt block). */
  exclusion: ExclusionPayload;
  /** Historical embeddings for cross-session cosine dedup (P0.3). */
  historyEmbeddings: number[][];
  /** Resolved audience level + its prompt fragment. */
  audience: { level: AudienceLevel | null; promptFragment: string };
};

export type CandidateQuestion = {
  stem: string;
  options: string[];
  correct_index: number;
  /** What level the LLM was asked to produce. Required so the Bloom
   *  verifier can compute the dispute gap per item. */
  bloom_level: BloomLevel;
  /** Anything else the route wants to round-trip through the pipeline
   *  (e.g. explanation, source span). Untouched by post-processing. */
  extra?: Record<string, unknown>;
};

export type ProcessedQuestion = CandidateQuestion & {
  /** Computed 768-dim Gemini embedding — null when the embedding API
   *  failed for this stem (caller should still persist; the column is
   *  nullable, and Jaccard dedup will protect future batches). */
  stem_embedding: number[] | null;
  /** Provenance blob the caller writes verbatim into question_bank.generation_meta. */
  generation_meta: GenerationMeta;
};

export type GenerationMeta = {
  route: GenerationRoute;
  intent: string;
  requested_bloom: BloomLevel;
  prompt_version: string;
  verifier: {
    status: "agreed" | "disputed" | "skipped";
    reason?: string;
    model: string;
    llm_correct?: string;
    verifier_correct?: string;
  };
  embedding_present: boolean;
  dedup: {
    jaccard_filtered: number;
    cosine_in_batch_filtered: number;
    cosine_history_filtered: number;
  };
  retry_count: number;
  generated_at: string;
  bloom_disputed?: boolean;
  bloom_actual?: BloomLevel | null;
  bloom_rationale?: string;
  sanitizer_fired?: boolean;
};

export type PipelineResult = {
  /** Surviving questions, each with stem_embedding + generation_meta
   *  ready for question_bank insert. Caller may choose NOT to insert
   *  (e.g. Speed Trainer keeps in-memory). */
  rows: ProcessedQuestion[];
  /** Batch-level summary for telemetry. */
  summary: {
    total_in: number;
    total_out: number;
    droppedLeak: number;
    droppedJaccard: number;
    droppedCosineInBatch: number;
    droppedCosineHistory: number;
    disputedAnswerKeys: number;
    bloomDisputed: number;
    embeddingFailureRate: number;   // 0..1
  };
  /** Per-item verifier verdicts in original order. */
  verification: VerifyResult[];
  /** When P1.5 Bloom verifier ran, the full result; otherwise skipped. */
  bloomVerifier: BloomVerifierResult;
  /** Number of retries the caller already did (passed through). The
   *  pipeline itself does NOT retry — that's the route's responsibility
   *  because retry-shape (whole batch vs. failed slots) varies. */
  retries: number;
};

// =============================================================================
// Stage 1 — prepareGenerationContext
// =============================================================================

/**
 * Read-only context assembly. Does NOT call the LLM.
 * Safe to run during topic-validation pre-checks.
 *
 * @param sb  supabase client (use the SAME auth posture each caller uses
 *            today — teacher routes pass a user-token client, server-job
 *            routes pass supabaseAdmin).
 */
export async function prepareGenerationContext(
  sb: SupabaseClient,
  input: GenerationInput,
): Promise<GenerationContext> {
  const topicS = sanitizeUserText(input.topic);
  const focusS = sanitizeUserText(input.additionalFocus);
  const profS = sanitizeUserText(input.learnerProfile);
  const contentS = sanitizeUserText(input.content);

  const anyModified =
    topicS.modified || focusS.modified || profS.modified || contentS.modified;

  // Distractor seeds (best-effort; pipeline tolerates empty).
  // Bloom-scope to the FIRST level in the batch — multi-level batches
  // accept seeds from any of their levels rather than over-narrowing.
  const seedBloom = input.levels[0] ?? null;
  let distractorSeeds: DistractorSeed[] = [];
  try {
    distractorSeeds = await findMisconceptionDistractors({
      ownerId: input.ownerId,
      topic: topicS.text || null,
      bloomLevel: seedBloom,
      limit: 5,
    });
  } catch {
    distractorSeeds = [];
  }
  const distractorSeedsBlock = formatDistractorSeedsForPrompt(distractorSeeds);

  // Recent stems for exclusion (Layers 1 + 2 of the dedup stack).
  let exclusion: ExclusionPayload = { stems: [], conceptsAlreadyCovered: [], promptBlock: "" };
  try {
    exclusion = await getRecentStemsForExclusion(
      sb,
      input.ownerId,
      topicS.text,
      seedBloom,
    );
  } catch {
    /* fall through with empty exclusion */
  }

  // History embeddings (Layer 4 — P0.3, the first time the embedding
  // column is actually queried).
  let historyEmbeddings: number[][] = [];
  try {
    historyEmbeddings = await fetchRecentEmbeddingsForOwner(
      sb,
      input.ownerId,
      input.category ?? null,
    );
  } catch {
    historyEmbeddings = [];
  }

  const aud = resolveAudienceLevel(input.audienceLevel);

  return {
    sanitized: {
      topic: topicS.text,
      additionalFocus: focusS.text,
      learnerProfile: profS.text,
      content: contentS.text,
      anyModified,
    },
    distractorSeeds,
    distractorSeedsBlock,
    exclusion,
    historyEmbeddings,
    audience: { level: aud.level, promptFragment: aud.promptFragment },
  };
}

// =============================================================================
// Stage 2 — postProcessCandidates
// =============================================================================

/** Options passed alongside the raw LLM output. */
export type PostProcessOptions = {
  input: GenerationInput;
  context: GenerationContext;
  /** Per-level target counts the LLM was asked to hit. Used as a
   *  maxCount slice ceiling after dedup. */
  perLevelCounts: Partial<Record<BloomLevel, number>>;
  /** Cap the answer-key verifier concurrency — defaults to 5. Set lower
   *  on free-tier routes if Groq rate-limits bite. */
  verifyConcurrency?: number;
  /** Whether to run the P1.5 Bloom-level second-pass verifier. Defaults
   *  to false; turn on per-route after measuring latency. */
  runBloomVerifier?: boolean;
  /** Caller's intent label — written to generation_meta.intent. */
  intent: string;
  /** Number of retries the caller has already performed; written to
   *  generation_meta.retry_count. */
  retries?: number;
};

export async function postProcessCandidates(
  candidates: CandidateQuestion[],
  opts: PostProcessOptions,
): Promise<PipelineResult> {
  const { input, context, perLevelCounts } = opts;
  const concurrency = Math.max(1, Math.min(10, opts.verifyConcurrency ?? 5));
  const totalIn = candidates.length;

  // Stage A — structural leak + within-batch jaccard + history-jaccard.
  // We process ALL levels together (a duplicate across levels is still a
  // duplicate). Per-level slicing happens at the very end so we can give
  // the user the requested distribution.
  const historyStems = context.exclusion.stems;
  const { kept: stageA, droppedLeak, droppedDup, droppedHistory } = filterQuestionBatch(
    candidates as LeakCheckable[],
    {
      maxCount: Infinity, // no slicing yet — slice per-level later
      similarityThreshold: 0.7,
      historyStems,
    },
  );
  const survivorsA = stageA as CandidateQuestion[];

  // Stage B — embed survivors, then cosine-in-batch + cosine-history dedup.
  const embeddings: (number[] | null)[] = (
    await embedTexts(survivorsA.map((q) => q.stem))
  ) ?? survivorsA.map(() => null);

  const embCandidates = survivorsA.map((_, i) => ({ embedding: embeddings[i] }));
  const { keptIndices: keepBatch, droppedIndices: dropBatch } =
    cosineDedupInBatch(embCandidates, 0.85);
  const stageB: { q: CandidateQuestion; emb: number[] | null }[] = keepBatch.map((i) => ({
    q: survivorsA[i],
    emb: embeddings[i],
  }));

  const { keptIndices: keepHist, droppedIndices: dropHist } =
    cosineDedupAgainstHistory(
      stageB.map((s) => ({ embedding: s.emb })),
      context.historyEmbeddings,
      0.85,
    );
  // F90 note (QA): stageC is verifyAnswerKeys' input. If the upstream
  // generator returned more candidates than perLevelCounts asks for
  // (over-generation buffer), we pay Groq cost on the surplus before
  // sliceToPerLevelCounts drops them downstream. Move the slice to
  // BEFORE this line when generator over-pull becomes meaningful (~3x
  // the requested count). Until then, the current order is fine.
  const stageC = keepHist.map((i) => stageB[i]);

  // Stage C — verify answer keys (concurrent).
  const verifyInputs = stageC.map((s) => ({
    stem: s.q.stem,
    options: s.q.options.slice(0, 4) as [string, string, string, string],
    correct_index: s.q.correct_index as 0 | 1 | 2 | 3,
  }));
  const verification = await verifyAnswerKeys(verifyInputs, concurrency);

  // Stage D — optional bloom verifier (P1.5).
  let bloomVerifier: BloomVerifierResult = {
    verdicts: [],
    skipped: true,
    model: "skipped",
  };
  if (opts.runBloomVerifier === true && stageC.length > 0) {
    bloomVerifier = await verifyBloomBatch(
      stageC.map((s, i) => ({
        index: i,
        stem: s.q.stem,
        options: s.q.options,
        requestedLevel: s.q.bloom_level,
      })),
    );
  }
  const verdictByIndex = new Map<number, (typeof bloomVerifier)["verdicts"][number]>();
  for (const v of bloomVerifier.verdicts) verdictByIndex.set(v.index, v);

  // Stage E — assemble ProcessedQuestion rows + per-row generation_meta.
  const generated_at = new Date().toISOString();
  const verifierModel = "groq:llama-3.3-70b";
  const rowsAll: ProcessedQuestion[] = stageC.map((s, i) => {
    const verify = verification[i];
    const llmCorrect = s.q.options[s.q.correct_index];
    const verifierCorrect =
      verify && verify.correctIndex != null ? s.q.options[verify.correctIndex] : undefined;

    // F83 fix: verifyAnswerKey returns { ok: true } as a "treat as
    // inconclusive" signal on transport / parse failure (no correctIndex,
    // no reasoning). Marking those as "agreed" gave false confidence in
    // generation_meta. Distinguish "agreed by verifier" from "verifier
    // failed silently — treat as unverified".
    const verifierStatus: "agreed" | "disputed" | "skipped" =
      verify == null
        ? "skipped"
        : verify.ok && verify.correctIndex == null && !verify.reasoning
        ? "skipped"
        : verify.ok
        ? "agreed"
        : "disputed";

    const bv = verdictByIndex.get(i);
    const meta: GenerationMeta = {
      route: input.route,
      intent: opts.intent,
      requested_bloom: s.q.bloom_level,
      prompt_version: PROMPT_VERSION,
      verifier: {
        status: verifierStatus,
        reason: verify?.reasoning,
        model: verifierModel,
        llm_correct: llmCorrect,
        verifier_correct: verifierCorrect,
      },
      embedding_present: !!s.emb,
      dedup: {
        jaccard_filtered: droppedDup.length + droppedHistory.length, // batch-level — coarse
        cosine_in_batch_filtered: dropBatch.length,
        cosine_history_filtered: dropHist.length,
      },
      retry_count: opts.retries ?? 0,
      generated_at,
      sanitizer_fired: context.sanitized.anyModified || undefined,
    };
    if (bv) {
      // F82 fix: when actualLevel is null (verifier couldn't classify),
      // mark disputed=true so downstream UI shows it as needing review
      // rather than silently accepting it as agreed.
      meta.bloom_disputed = bv.actualLevel == null ? true : bv.disputed;
      meta.bloom_actual = bv.actualLevel;
      meta.bloom_rationale = bv.rationale;
    }
    return {
      ...s.q,
      stem_embedding: s.emb,
      generation_meta: meta,
    };
  });

  // Stage F — per-level slice to perLevelCounts (the LLM often over-
  // produces or under-produces; this rebalances toward the requested
  // distribution, falling back to "take whatever survived" when the
  // caller didn't specify counts).
  const rows = sliceByLevel(rowsAll, perLevelCounts);

  // Stage G — summary stats.
  const embeddingFailures = rowsAll.filter((r) => !r.stem_embedding).length;
  const disputedAnswerKeys = rows.filter(
    (r) => r.generation_meta.verifier.status === "disputed",
  ).length;
  const bloomDisputed = rows.filter((r) => r.generation_meta.bloom_disputed === true).length;

  return {
    rows,
    summary: {
      total_in: totalIn,
      total_out: rows.length,
      droppedLeak: droppedLeak.length,
      droppedJaccard: droppedDup.length + droppedHistory.length,
      droppedCosineInBatch: dropBatch.length,
      droppedCosineHistory: dropHist.length,
      disputedAnswerKeys,
      bloomDisputed,
      embeddingFailureRate:
        rowsAll.length === 0 ? 0 : embeddingFailures / rowsAll.length,
    },
    verification,
    bloomVerifier,
    retries: opts.retries ?? 0,
  };
}

/**
 * Take only `perLevelCounts[bloom]` rows for each level. If the level
 * isn't requested, keep up to a generous fallback (8) — we don't want to
 * silently DROP questions for a level the caller forgot to specify;
 * better to over-deliver than under-deliver.
 */
function sliceByLevel(
  rows: ProcessedQuestion[],
  perLevelCounts: Partial<Record<BloomLevel, number>>,
): ProcessedQuestion[] {
  const taken: Record<string, number> = {};
  const out: ProcessedQuestion[] = [];
  for (const r of rows) {
    const lvl = r.bloom_level;
    const cap = perLevelCounts[lvl] ?? 8;
    const c = taken[lvl] ?? 0;
    if (c >= cap) continue;
    taken[lvl] = c + 1;
    out.push(r);
  }
  return out;
}

// =============================================================================
// Optional convenience — generateQuestions(input, llmCall)
// -----------------------------------------------------------------------------
// Routes that follow the "build prompt → call Groq once → post-process"
// pattern can use this thin wrapper. Routes with bespoke shape (Speed
// Trainer; teach-back's two-turn flow) call prepareGenerationContext +
// postProcessCandidates separately.
// =============================================================================

export type LLMCall = (ctx: GenerationContext) => Promise<CandidateQuestion[]>;

export async function generateQuestions(
  sb: SupabaseClient,
  input: GenerationInput,
  llmCall: LLMCall,
  postOpts: Omit<PostProcessOptions, "input" | "context">,
): Promise<PipelineResult> {
  const ctx = await prepareGenerationContext(sb, input);
  const candidates = await llmCall(ctx);
  return postProcessCandidates(candidates, {
    ...postOpts,
    input,
    context: ctx,
  });
}
