// lib/bloomVerifier.ts
// =============================================================================
// Bloom-level second-pass verifier — catches the "all my Apply questions are
// actually Remember" failure mode.
//
// Why
// ---
// Today every generator route asks the LLM to produce questions at a target
// Bloom level (remember | understand | apply | analyze | evaluate | create).
// The LLM happily labels its output with the requested level — but post-hoc
// auditing finds many "Apply" questions are textbook "Remember" recall
// questions in disguise. We trust the label and ship it.
//
// This module runs a SECOND, fresh Groq call that re-classifies the actually-
// generated batch and returns the verifier's per-question label. The caller
// compares to the requested level and decides what to do (demote to pending,
// flag generation_meta.bloom_disputed, etc.).
//
// Cost
// ----
// One Groq call PER BATCH (not per question). The verifier sees the whole
// batch in one prompt and returns a JSON array. ~600ms total per generation
// at p50 latency on llama-3.3-70b. Feature-flag the call until we've measured
// real-world cost.
//
// Posture
// -------
// Fail-open. On any error (parse, transport, model timeout) we return
// `{ verdicts: [], skipped: true }` and the caller keeps the original
// labels. A flaky verifier should NEVER block question delivery.
// =============================================================================

import { groqJSON } from "@/lib/groq";
import type { BloomLevel } from "@/lib/bloom";

const VERIFIER_MODEL_TAG = "groq:bloom-verifier.v1";

const BLOOM_LEVELS: readonly BloomLevel[] = [
  "remember",
  "understand",
  "apply",
  "analyze",
  "evaluate",
  "create",
] as const;

const LEVEL_ORDER: Record<BloomLevel, number> = {
  remember: 0,
  understand: 1,
  apply: 2,
  analyze: 3,
  evaluate: 4,
  create: 5,
};

/** Mismatch by THIS MANY levels or more = dispute.
 *  F81 fix (QA): lowered from 2 → 1. Adjacent-level drift (e.g.
 *  requested apply, got understand) IS pedagogically meaningful — the
 *  whole point of teaching by Bloom level. A threshold of 2 silently
 *  ignored the most common drift mode. */
export const BLOOM_DISPUTE_THRESHOLD = 1;

export type BloomCandidate = {
  /** Stable index inside the batch — verifier returns this in its response
   *  so callers can stitch verdicts back to questions even if the LLM
   *  re-orders or skips items. */
  index: number;
  stem: string;
  options: string[]; // length 4 for MCQs; verifier tolerates other lengths
  requestedLevel: BloomLevel;
};

export type BloomVerdict = {
  index: number;
  /** Verifier's chosen level. null on parse failure for this item. */
  actualLevel: BloomLevel | null;
  rationale: string;
  /** Convenience: true when |LEVEL_ORDER[actual] - LEVEL_ORDER[requested]|
   *  >= BLOOM_DISPUTE_THRESHOLD. False when actualLevel is null. */
  disputed: boolean;
};

export type BloomVerifierResult = {
  verdicts: BloomVerdict[];
  /** True when the verifier was skipped (feature flag off, transport
   *  failure, parse failure). Callers should treat all verdicts as
   *  inconclusive in this case. */
  skipped: boolean;
  /** For provenance — what verifier model produced this. */
  model: string;
};

const VERIFIER_SYSTEM =
  "You are a careful Bloom's-taxonomy classifier. Given an MCQ, you identify the COGNITIVE LEVEL the question actually tests, not the level the question claims to test.";

function buildVerifierPrompt(candidates: BloomCandidate[]): string {
  const numbered = candidates
    .map((c, i) => {
      const opts = (c.options || [])
        .slice(0, 4)
        .map((o, j) => `   ${String.fromCharCode(65 + j)}) ${o}`)
        .join("\n");
      return `[${i}] (requested: ${c.requestedLevel})\nStem: ${c.stem}\n${opts}`;
    })
    .join("\n\n");

  return `For each MCQ below, determine the SINGLE Bloom's taxonomy level (one of: remember, understand, apply, analyze, evaluate, create) that the question actually tests. Use the verbs and demanded reasoning to decide — DO NOT rely on the question's claimed level.

Guidance:
- remember: recall a fact, definition, name
- understand: paraphrase, summarise, classify, compare similar concepts
- apply: use a formula/rule/algorithm in a new situation
- analyze: decompose, distinguish parts, infer relationships
- evaluate: judge, critique, defend a position with criteria
- create: produce a novel structure or solution

${numbered}

Respond with valid JSON only, in this exact shape:
{
  "verdicts": [
    { "index": 0, "actual_level": "apply", "rationale": "..." },
    ...
  ]
}

Use the same index numbers I gave you. If you cannot classify an item, set actual_level to null and explain in rationale.`;
}

function parseLevel(x: unknown): BloomLevel | null {
  if (typeof x !== "string") return null;
  const k = x.trim().toLowerCase() as BloomLevel;
  return BLOOM_LEVELS.includes(k) ? k : null;
}

/**
 * Run the Bloom verifier across a batch. Single Groq call.
 *
 * Caller responsibility: only call this when the feature flag is on
 * (see `process.env.BLOOM_VERIFIER_ENABLED` or your own runtime flag).
 * This module makes no flag check itself so it stays trivially testable.
 *
 * On any failure the result has `skipped: true` and `verdicts: []` — the
 * caller should treat the batch as un-verified (NOT as agreed).
 */
export async function verifyBloomBatch(
  candidates: BloomCandidate[],
): Promise<BloomVerifierResult> {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { verdicts: [], skipped: true, model: VERIFIER_MODEL_TAG };
  }

  // Hard cap to avoid pathological prompts; split the call upstream if needed.
  if (candidates.length > 30) {
    return { verdicts: [], skipped: true, model: VERIFIER_MODEL_TAG };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = await groqJSON(VERIFIER_SYSTEM, buildVerifierPrompt(candidates));
  } catch (e) {
    // F92 fix: structured log so ops can grep skip rate per cause.
    // Without this the verifier appeared to be "always running" while
    // silently no-op'ing on every transport blip.
    // eslint-disable-next-line no-console
    console.warn(
      "[bloomVerifier:skipped] cause=transport batch=" + candidates.length + " msg=" +
        (e instanceof Error ? e.message : String(e)),
    );
    return { verdicts: [], skipped: true, model: VERIFIER_MODEL_TAG };
  }

  const raw = (parsed as { verdicts?: unknown })?.verdicts;
  if (!Array.isArray(raw)) {
    // eslint-disable-next-line no-console
    console.warn("[bloomVerifier] missing verdicts array — skipping");
    return { verdicts: [], skipped: true, model: VERIFIER_MODEL_TAG };
  }

  const byIndex = new Map<number, BloomLevel>();
  for (const c of candidates) byIndex.set(c.index, c.requestedLevel);

  const verdicts: BloomVerdict[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const idx = typeof o.index === "number" ? o.index : Number(o.index);
    if (!Number.isInteger(idx)) continue;

    const actual = parseLevel(o.actual_level);
    const rationale = typeof o.rationale === "string" ? o.rationale : "";
    const requested = byIndex.get(idx);
    let disputed = false;
    if (actual && requested) {
      const gap = Math.abs(LEVEL_ORDER[actual] - LEVEL_ORDER[requested]);
      disputed = gap >= BLOOM_DISPUTE_THRESHOLD;
    }

    verdicts.push({ index: idx, actualLevel: actual, rationale, disputed });
  }

  return { verdicts, skipped: false, model: VERIFIER_MODEL_TAG };
}
