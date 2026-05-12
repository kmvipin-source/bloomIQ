/**
 * lib/scoring.ts
 *
 * THE single source of truth for "how many points did this attempt earn,
 * and what percentage does that translate to?" — across every consumer:
 * student result page, teacher reports, PDF report, leaderboards, school
 * analytics, principal coach digests.
 *
 * Critical invariants this file enforces:
 *
 *  1. EXACT BACKWARD COMPATIBILITY. When marking_scheme is NULL (every
 *     legacy quiz), computeAttemptScore() produces the same raw_score /
 *     max_score / percentage that the old hardcoded `if (correct) score++`
 *     loop produced. Tests verify this byte-for-byte.
 *
 *  2. NEGATIVE-SAFE PERCENTAGE. raw_score can be negative when a scheme
 *     has wrong < 0. percentageOf() clamps the final percentage at 0
 *     so dashboards / charts / thresholds don't see negative values.
 *     The raw_score itself is preserved unclamped so result pages can
 *     show "−6 / 40 (clamped to 0%)" with a coaching tip.
 *
 *  3. BLOOM MASTERY UNTOUCHED. This file deliberately does NOT compute
 *     Bloom mastery. That logic lives in lib/bloomiqScore.ts and reads
 *     attempt_answers.is_correct (which is scheme-independent). Two
 *     parallel scoring axes — points (here) and mastery (there) — and
 *     they must never be conflated.
 */

import {
  SCORING_PRESETS,
  DEFAULT_PRESET,
  type MarkingRule,
  type ScoringPresetKey,
} from "./scoringPresets";

/**
 * The JSONB shape persisted on quizzes.marking_scheme and
 * quiz_attempts.marking_scheme_snapshot. See migration 76.
 */
export type MarkingScheme = {
  preset: ScoringPresetKey;
  negative_marks_enabled: boolean;
  rules: {
    default: MarkingRule;
  };
};

/**
 * The implicit scheme applied when a quiz has NULL marking_scheme.
 * Exactly equivalent to the legacy +1/0/0 behaviour — every pre-migration
 * quiz behaves as if it had this scheme. Frozen at module load.
 */
export const LEGACY_DEFAULT_SCHEME: MarkingScheme = {
  preset: DEFAULT_PRESET,
  negative_marks_enabled: false,
  rules: {
    default: { ...SCORING_PRESETS[DEFAULT_PRESET].rule },
  },
};

/**
 * Resolve any input (NULL, partial, or full scheme) into a fully-populated
 * MarkingScheme with sensible defaults. NULL or malformed input → legacy
 * default. This is the SINGLE place that decides "what scheme applies."
 */
export function resolveScheme(input: unknown): MarkingScheme {
  if (input == null || typeof input !== "object") return LEGACY_DEFAULT_SCHEME;
  const obj = input as Record<string, unknown>;
  const presetRaw = typeof obj.preset === "string" ? obj.preset : DEFAULT_PRESET;
  const preset: ScoringPresetKey =
    presetRaw in SCORING_PRESETS ? (presetRaw as ScoringPresetKey) : DEFAULT_PRESET;
  const negative_marks_enabled =
    typeof obj.negative_marks_enabled === "boolean"
      ? obj.negative_marks_enabled
      : SCORING_PRESETS[preset].negative_default;
  // Pull the "default" rule from input if present and valid, else from
  // the preset, else from the legacy default. Each field validated as a
  // finite number; anything else gets the preset / legacy fallback.
  const rulesObj = (obj.rules && typeof obj.rules === "object")
    ? (obj.rules as Record<string, unknown>)
    : {};
  const defaultRuleRaw = (rulesObj.default && typeof rulesObj.default === "object")
    ? (rulesObj.default as Record<string, unknown>)
    : {};
  const presetRule = SCORING_PRESETS[preset].rule;
  const correct = numberOr(defaultRuleRaw.correct, presetRule.correct);
  const wrong = negative_marks_enabled
    ? numberOr(defaultRuleRaw.wrong, presetRule.wrong)
    : 0; // Hard zero when toggle is off — defensive against legacy data.
  const unattempted = numberOr(defaultRuleRaw.unattempted, presetRule.unattempted);
  return {
    preset,
    negative_marks_enabled,
    rules: {
      default: { correct, wrong, unattempted },
    },
  };
}

function numberOr(x: unknown, fallback: number): number {
  return typeof x === "number" && Number.isFinite(x) ? x : fallback;
}

/**
 * The per-attempt scoring inputs the engine needs. Kept minimal — only
 * what's needed to compute marks. Callers (submission handlers, result
 * pages) build this from quiz_attempts + attempt_answers.
 */
export type AttemptAnswerInput = {
  /** True if selected_index === correct_index. False if wrong. */
  is_correct: boolean;
  /** Null if the student skipped the question; integer otherwise. */
  selected_index: number | null;
};

export type ScoreBreakdown = {
  raw_score: number;
  max_score: number;
  /** 0-100. Always clamped at 0 (never negative). */
  percentage: number;
  /** True when the unclamped raw_score went below zero. Drives UI warnings. */
  raw_negative: boolean;
  counts: {
    correct: number;
    wrong: number;
    unattempted: number;
    total: number;
  };
  /** The scheme actually used to compute this breakdown (post-resolve). */
  scheme: MarkingScheme;
};

/**
 * Compute the score breakdown for an attempt given:
 *   - the attempt's per-question outcomes (correct / wrong / skipped)
 *   - the marking scheme to apply (already snapshotted on the attempt)
 *
 * NULL or undefined scheme → legacy +1/0/0. Identical math to the
 * pre-migration hardcoded loop.
 */
export function computeAttemptScore(
  answers: AttemptAnswerInput[],
  schemeInput: unknown,
): ScoreBreakdown {
  const scheme = resolveScheme(schemeInput);
  const { correct, wrong, unattempted } = scheme.rules.default;
  let correctCount = 0;
  let wrongCount = 0;
  let unattemptedCount = 0;
  for (const a of answers) {
    if (a.selected_index === null || a.selected_index === undefined) {
      unattemptedCount += 1;
    } else if (a.is_correct) {
      correctCount += 1;
    } else {
      wrongCount += 1;
    }
  }
  const total = correctCount + wrongCount + unattemptedCount;
  const raw_score =
    correctCount * correct + wrongCount * wrong + unattemptedCount * unattempted;
  const max_score = total * correct;
  const raw_negative = raw_score < 0;
  const percentage = max_score > 0
    ? Math.max(0, (raw_score / max_score) * 100)
    : 0;
  return {
    raw_score,
    max_score,
    percentage,
    raw_negative,
    counts: {
      correct: correctCount,
      wrong: wrongCount,
      unattempted: unattemptedCount,
      total,
    },
    scheme,
  };
}

/**
 * Compute the per-question marks earned, given the attempt's resolved
 * scheme. Used by the submission handler to populate
 * attempt_answers.marks_earned at insert time.
 */
export function marksEarnedFor(
  answer: AttemptAnswerInput,
  scheme: MarkingScheme,
): number {
  const { correct, wrong, unattempted } = scheme.rules.default;
  if (answer.selected_index === null || answer.selected_index === undefined) {
    return unattempted;
  }
  return answer.is_correct ? correct : wrong;
}

/**
 * Read-side helper for every report / dashboard / leaderboard. Given
 * a row from quiz_attempts (potentially pre-migration), return a clean
 * percentage in [0, 100].
 *
 * Decision tree:
 *   1. New rows (raw_score + max_score populated): use those.
 *   2. Legacy rows (NULL raw_score, populated score + total): treat as
 *      legacy +1/0 — percentage = score / total × 100.
 *   3. Garbage / both NULL: 0.
 *
 * This is the function that lets old reports keep working byte-identically
 * while new reports correctly reflect mixed schemes.
 */
export type AttemptRowMinimal = {
  raw_score?: number | null;
  max_score?: number | null;
  score?: number | null;
  total?: number | null;
};

export function percentageOf(attempt: AttemptRowMinimal): number {
  // Prefer new columns when both are present and max_score > 0.
  if (
    attempt.raw_score != null &&
    attempt.max_score != null &&
    attempt.max_score > 0
  ) {
    return Math.max(0, (attempt.raw_score / attempt.max_score) * 100);
  }
  // Legacy fallback.
  if (attempt.score != null && attempt.total != null && attempt.total > 0) {
    return Math.max(0, (attempt.score / attempt.total) * 100);
  }
  return 0;
}

/**
 * Read-side helper for displaying the raw points label on a result card,
 * e.g., "66 / 120". Returns null when no meaningful score is available
 * (caller should show "—").
 */
export function rawScoreLabel(attempt: AttemptRowMinimal): { raw: number; max: number } | null {
  if (
    attempt.raw_score != null &&
    attempt.max_score != null &&
    attempt.max_score > 0
  ) {
    return { raw: attempt.raw_score, max: attempt.max_score };
  }
  if (attempt.score != null && attempt.total != null && attempt.total > 0) {
    return { raw: attempt.score, max: attempt.total };
  }
  return null;
}

/**
 * Human-readable summary line for the result page, e.g.:
 *   "Score: 66 / 120  (55%)"
 *   "Score: −6 / 40  (0%, clamped from −15%)"   ← raw_negative case
 */
export function summaryLine(breakdown: ScoreBreakdown): string {
  const pct = Math.round(breakdown.percentage * 10) / 10;
  if (breakdown.raw_negative) {
    return `Score: ${breakdown.raw_score} / ${breakdown.max_score} (0%, clamped from negative)`;
  }
  return `Score: ${breakdown.raw_score} / ${breakdown.max_score} (${pct}%)`;
}
