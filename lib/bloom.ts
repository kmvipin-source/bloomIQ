export const BLOOM_LEVELS = [
  "remember",
  "understand",
  "apply",
  "analyze",
  "evaluate",
  "create",
] as const;

export type BloomLevel = (typeof BLOOM_LEVELS)[number];

export const BLOOM_META: Record<
  BloomLevel,
  { label: string; verb: string; color: string; description: string }
> = {
  remember: {
    label: "Remember",
    verb: "Recall",
    color: "#60a5fa",
    description: "Recall facts, terms, and basic concepts.",
  },
  understand: {
    label: "Understand",
    verb: "Explain",
    color: "#34d399",
    description: "Explain ideas or concepts in own words.",
  },
  apply: {
    label: "Apply",
    verb: "Use",
    color: "#fbbf24",
    description: "Use information in new situations.",
  },
  analyze: {
    label: "Analyze",
    verb: "Compare",
    color: "#fb923c",
    description: "Draw connections; differentiate parts.",
  },
  evaluate: {
    label: "Evaluate",
    verb: "Judge",
    color: "#f472b6",
    description: "Justify a decision or stance with criteria.",
  },
  create: {
    label: "Create",
    verb: "Design",
    color: "#a78bfa",
    description: "Produce new, original work.",
  },
};

export function isBloomLevel(x: string): x is BloomLevel {
  return (BLOOM_LEVELS as readonly string[]).includes(x);
}

export function blankBloomCounts(): Record<BloomLevel, number> {
  return {
    remember: 0,
    understand: 0,
    apply: 0,
    analyze: 0,
    evaluate: 0,
    create: 0,
  };
}

// Per-question time budget (seconds) by Bloom level. Higher levels need more
// thinking time; recall is fast. These figures come from the standard guidance
// for MCQ paper design (e.g., NBME-style 60-90s analysis questions vs. 30s
// recall questions) plus a small reading buffer baked in.
export const BLOOM_SECONDS_PER_QUESTION: Record<BloomLevel, number> = {
  remember: 30,
  understand: 45,
  apply: 60,
  analyze: 75,
  evaluate: 90,
  create: 120,
};

// 15% review buffer: students typically want a moment to flag uncertain ones
// and skim the paper at the end. We round UP to a whole minute and clamp to
// a sensible range so the recommendation is always a reasonable number to
// pre-fill into the time-limit field.
const REVIEW_BUFFER = 0.15;
const MIN_RECOMMENDED_MINUTES = 5;
const MAX_RECOMMENDED_MINUTES = 180;

/**
 * Recommend a total quiz time (in whole minutes) given a Bloom-level
 * distribution. Pass in either an explicit counts object or an array of
 * question-shaped objects with a `bloom_level` field.
 *
 * Returns 0 only when the input is empty - any positive total will produce
 * at least MIN_RECOMMENDED_MINUTES so a 1-question quiz isn't "0 minutes".
 */
export function recommendedQuizMinutes(
  input: Record<BloomLevel, number> | { bloom_level: BloomLevel | string | null }[]
): number {
  let counts: Record<BloomLevel, number>;
  if (Array.isArray(input)) {
    counts = blankBloomCounts();
    for (const q of input) {
      const lvl = q.bloom_level;
      if (lvl && isBloomLevel(lvl)) counts[lvl] += 1;
    }
  } else {
    counts = { ...blankBloomCounts(), ...input };
  }
  let totalQs = 0;
  let totalSec = 0;
  for (const lvl of BLOOM_LEVELS) {
    const n = counts[lvl] || 0;
    totalQs += n;
    totalSec += n * BLOOM_SECONDS_PER_QUESTION[lvl];
  }
  if (totalQs === 0) return 0;
  const buffered = totalSec * (1 + REVIEW_BUFFER);
  const minutes = Math.ceil(buffered / 60);
  return Math.max(MIN_RECOMMENDED_MINUTES, Math.min(MAX_RECOMMENDED_MINUTES, minutes));
}
