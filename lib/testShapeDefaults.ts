// lib/testShapeDefaults.ts
// =============================================================================
// "What does a TYPICAL practice test look like for THIS learner?"
// -----------------------------------------------------------------------------
// Single source of truth for the recommended test shape — total question
// count, minutes, Bloom-level coverage, and per-level allocation weights —
// that every test-creation surface should derive defaults from.
//
// Why this exists
// ---------------
// Before 2026-05-14 each surface (student/generate, teacher/generate,
// Speed Trainer, Sprint, Daily Drill, Adaptive Practice) hardcoded its own
// "default of 2 questions per level over 15 minutes". A JEE student saw
// the SAME boilerplate as a Class-9 student, even though JEE practice
// papers are typically much longer and Bloom-skewed toward Apply/Analyze.
//
// This module returns a per-learner recommendation. The recommendation
// is shown to the user as a one-line "Typical for your context: …" hint
// and (in the generate page) used to seed smart defaults on first load.
// Users are never forced into the recommendation — every dial remains
// editable. This is "informed defaults," not "rigid templates."
//
// What's covered
// --------------
// - Competitive-exam goals: jee_main, jee_prep, jee_advanced, neet_prep,
//   neet, cat_prep, cat, upsc_prep, upsc, bank_exams, bank_prep,
//   gmat, gmat_prep, gre, gre_prep, gate, gate_prep
// - K-12 / boards: class_10_boards, class_12_boards, class_9, class5_8
// - Corporate / professional training: corporate
// - Exploring / unknown goal: exploring (sensible neutral default)
//
// Adding a new learner profile → add a row to GOAL_SHAPES + (optionally)
// a row to BLOOM_WEIGHTS if the Bloom mix differs from the bucket default.
// =============================================================================

import { BLOOM_LEVELS, type BloomLevel } from "@/lib/bloom";

export type TestShape = {
  /** Recommended TOTAL number of questions across all Bloom levels. */
  totalQuestions: number;
  /** Recommended total time budget in minutes (already includes a small
   *  review buffer; surfaces can subtract back if they want pure-solve time). */
  minutes: number;
  /** Bloom levels we recommend covering. Subset of the 6 canonical levels. */
  bloomLevels: BloomLevel[];
  /** Per-level relative weight (sums to 1.0 across `bloomLevels`). Used by
   *  callers to derive a non-uniform per-level question count: e.g. JEE
   *  spends 40% of questions on Apply, 30% on Analyze, etc. */
  bloomWeights: Partial<Record<BloomLevel, number>>;
  /** Friendly label used in the UI rationale, e.g. "JEE Main practice". */
  label: string;
  /** One-line "why this shape" caption, surfaced to the user. */
  rationale: string;
};

// ─── Per-goal weights (sum to 1 across the chosen bloomLevels) ─────────────
//
// Hand-tuned from public information about each exam's question
// distribution (where available) + the audit-doc EXAM_DETECTORS allowlist.
// Numbers don't need to be exact — they bias the per-level count picker
// but the user can always override.

const W_JEE: Partial<Record<BloomLevel, number>> = {
  understand: 0.20, apply: 0.40, analyze: 0.25, evaluate: 0.15,
};
const W_NEET: Partial<Record<BloomLevel, number>> = {
  remember: 0.25, understand: 0.30, apply: 0.30, analyze: 0.15,
};
const W_CAT: Partial<Record<BloomLevel, number>> = {
  apply: 0.40, analyze: 0.35, evaluate: 0.25,
};
const W_UPSC: Partial<Record<BloomLevel, number>> = {
  remember: 0.30, understand: 0.30, apply: 0.25, analyze: 0.15,
};
const W_BANK: Partial<Record<BloomLevel, number>> = {
  understand: 0.20, apply: 0.45, analyze: 0.35,
};
const W_GMAT: Partial<Record<BloomLevel, number>> = {
  apply: 0.40, analyze: 0.35, evaluate: 0.25,
};
const W_GRE: Partial<Record<BloomLevel, number>> = {
  understand: 0.20, apply: 0.40, analyze: 0.25, evaluate: 0.15,
};
const W_GATE: Partial<Record<BloomLevel, number>> = {
  apply: 0.50, analyze: 0.30, evaluate: 0.20,
};
const W_BOARDS_10: Partial<Record<BloomLevel, number>> = {
  remember: 0.25, understand: 0.40, apply: 0.25, analyze: 0.10,
};
const W_BOARDS_12: Partial<Record<BloomLevel, number>> = {
  understand: 0.30, apply: 0.40, analyze: 0.20, evaluate: 0.10,
};
const W_CLASS_9: Partial<Record<BloomLevel, number>> = {
  remember: 0.30, understand: 0.45, apply: 0.20, analyze: 0.05,
};
const W_CLASS_5_8: Partial<Record<BloomLevel, number>> = {
  remember: 0.40, understand: 0.45, apply: 0.15,
};
const W_CORPORATE: Partial<Record<BloomLevel, number>> = {
  apply: 0.45, analyze: 0.35, evaluate: 0.20,
};
const W_BALANCED: Partial<Record<BloomLevel, number>> = {
  remember: 0.15, understand: 0.25, apply: 0.30, analyze: 0.20, evaluate: 0.10,
};

// ─── Per-goal full shapes ──────────────────────────────────────────────────

const GOAL_SHAPES: Record<string, TestShape> = {
  // ── Competitive exams ──
  jee_main: {
    totalQuestions: 12, minutes: 25,
    bloomLevels: ["understand", "apply", "analyze", "evaluate"],
    bloomWeights: W_JEE,
    label: "JEE Main practice",
    rationale: "JEE Main rewards quick application of NCERT concepts — Apply / Analyze dominate the real paper.",
  },
  jee_prep: {
    totalQuestions: 12, minutes: 25,
    bloomLevels: ["understand", "apply", "analyze", "evaluate"],
    bloomWeights: W_JEE,
    label: "JEE practice",
    rationale: "JEE leans heavily on Apply / Analyze — formula-application and multi-step reasoning.",
  },
  jee_advanced: {
    totalQuestions: 10, minutes: 30,
    bloomLevels: ["apply", "analyze", "evaluate"],
    bloomWeights: { apply: 0.30, analyze: 0.40, evaluate: 0.30 },
    label: "JEE Advanced practice",
    rationale: "JEE Advanced is harder per question — fewer items at higher Bloom levels.",
  },
  neet_prep: {
    totalQuestions: 15, minutes: 20,
    bloomLevels: ["remember", "understand", "apply", "analyze"],
    bloomWeights: W_NEET,
    label: "NEET practice",
    rationale: "NEET tests Biology recall + Physics/Chemistry application — Remember / Understand are still very much in play.",
  },
  neet: {
    totalQuestions: 15, minutes: 20,
    bloomLevels: ["remember", "understand", "apply", "analyze"],
    bloomWeights: W_NEET,
    label: "NEET practice",
    rationale: "NEET tests Biology recall + Physics/Chemistry application.",
  },
  cat_prep: {
    totalQuestions: 10, minutes: 20,
    bloomLevels: ["apply", "analyze", "evaluate"],
    bloomWeights: W_CAT,
    label: "CAT practice",
    rationale: "CAT is pure thinking — Apply / Analyze / Evaluate. No rote-recall section exists on the paper.",
  },
  cat: {
    totalQuestions: 10, minutes: 20,
    bloomLevels: ["apply", "analyze", "evaluate"],
    bloomWeights: W_CAT,
    label: "CAT practice",
    rationale: "CAT is pure thinking — Apply / Analyze / Evaluate dominate.",
  },
  upsc_prep: {
    totalQuestions: 15, minutes: 25,
    bloomLevels: ["remember", "understand", "apply", "analyze"],
    bloomWeights: W_UPSC,
    label: "UPSC Prelims practice",
    rationale: "UPSC Prelims is breadth-heavy: a lot of Remember / Understand, with some elimination-style Analyze.",
  },
  upsc: {
    totalQuestions: 15, minutes: 25,
    bloomLevels: ["remember", "understand", "apply", "analyze"],
    bloomWeights: W_UPSC,
    label: "UPSC practice",
    rationale: "UPSC is breadth-heavy: a lot of Remember / Understand.",
  },
  bank_exams: {
    totalQuestions: 15, minutes: 18,
    bloomLevels: ["understand", "apply", "analyze"],
    bloomWeights: W_BANK,
    label: "Bank exam practice",
    rationale: "IBPS / SBI / RBI papers are speed-focused — moderate-difficulty Apply / Analyze, fast pace.",
  },
  bank_prep: {
    totalQuestions: 15, minutes: 18,
    bloomLevels: ["understand", "apply", "analyze"],
    bloomWeights: W_BANK,
    label: "Bank exam practice",
    rationale: "Bank exams are speed-focused — moderate Apply / Analyze.",
  },
  gmat: {
    totalQuestions: 10, minutes: 20,
    bloomLevels: ["apply", "analyze", "evaluate"],
    bloomWeights: W_GMAT,
    label: "GMAT practice",
    rationale: "GMAT Quant / Verbal / Data Insights are all Apply / Analyze / Evaluate — there's no recall section.",
  },
  gmat_prep: {
    totalQuestions: 10, minutes: 20,
    bloomLevels: ["apply", "analyze", "evaluate"],
    bloomWeights: W_GMAT,
    label: "GMAT practice",
    rationale: "GMAT is pure Apply / Analyze / Evaluate.",
  },
  gre: {
    totalQuestions: 12, minutes: 22,
    bloomLevels: ["understand", "apply", "analyze", "evaluate"],
    bloomWeights: W_GRE,
    label: "GRE practice",
    rationale: "GRE balances vocabulary-driven Understand with quantitative Apply / Analyze.",
  },
  gre_prep: {
    totalQuestions: 12, minutes: 22,
    bloomLevels: ["understand", "apply", "analyze", "evaluate"],
    bloomWeights: W_GRE,
    label: "GRE practice",
    rationale: "GRE balances vocabulary with quantitative reasoning.",
  },
  gate: {
    totalQuestions: 10, minutes: 25,
    bloomLevels: ["apply", "analyze", "evaluate"],
    bloomWeights: W_GATE,
    label: "GATE practice",
    rationale: "GATE is engineering-aptitude heavy — Apply dominates, with formal Analyze / Evaluate.",
  },
  gate_prep: {
    totalQuestions: 10, minutes: 25,
    bloomLevels: ["apply", "analyze", "evaluate"],
    bloomWeights: W_GATE,
    label: "GATE practice",
    rationale: "GATE is engineering aptitude — Apply dominates.",
  },

  // ── K-12 / boards ──
  class_10_boards: {
    totalQuestions: 15, minutes: 30,
    bloomLevels: ["remember", "understand", "apply", "analyze"],
    bloomWeights: W_BOARDS_10,
    label: "Class 10 board practice",
    rationale: "Class 10 boards mix concept recall (Remember / Understand) with direct application — not entrance-exam complexity.",
  },
  class10_boards: {
    totalQuestions: 15, minutes: 30,
    bloomLevels: ["remember", "understand", "apply", "analyze"],
    bloomWeights: W_BOARDS_10,
    label: "Class 10 board practice",
    rationale: "Class 10 boards mix recall and application.",
  },
  class_12_boards: {
    totalQuestions: 15, minutes: 35,
    bloomLevels: ["understand", "apply", "analyze", "evaluate"],
    bloomWeights: W_BOARDS_12,
    label: "Class 12 board practice",
    rationale: "Class 12 boards lean conceptual + application — Understand and Apply lead, with some Analyze.",
  },
  class12_boards: {
    totalQuestions: 15, minutes: 35,
    bloomLevels: ["understand", "apply", "analyze", "evaluate"],
    bloomWeights: W_BOARDS_12,
    label: "Class 12 board practice",
    rationale: "Class 12 boards lean conceptual + application.",
  },
  class_9: {
    totalQuestions: 12, minutes: 25,
    bloomLevels: ["remember", "understand", "apply"],
    bloomWeights: W_CLASS_9,
    label: "Class 9 practice",
    rationale: "Class 9 is foundation-building — Understand leads, with strong Remember support.",
  },
  class9: {
    totalQuestions: 12, minutes: 25,
    bloomLevels: ["remember", "understand", "apply"],
    bloomWeights: W_CLASS_9,
    label: "Class 9 practice",
    rationale: "Class 9 is foundation-building — Understand leads.",
  },
  class5_8: {
    totalQuestions: 10, minutes: 20,
    bloomLevels: ["remember", "understand", "apply"],
    bloomWeights: W_CLASS_5_8,
    label: "Class 5–8 practice",
    rationale: "Primary / middle-school practice — short, friendly tests with mostly Remember / Understand.",
  },
  class_5_8: {
    totalQuestions: 10, minutes: 20,
    bloomLevels: ["remember", "understand", "apply"],
    bloomWeights: W_CLASS_5_8,
    label: "Class 5–8 practice",
    rationale: "Primary / middle-school practice.",
  },

  // ── Corporate / professional ──
  corporate: {
    totalQuestions: 10, minutes: 15,
    bloomLevels: ["understand", "apply", "analyze", "evaluate"],
    bloomWeights: W_CORPORATE,
    label: "Professional training check",
    rationale: "Industry training quizzes are short and scenario-shaped — mostly Apply / Analyze, sometimes Evaluate.",
  },

  // ── Exploring / unknown ──
  exploring: {
    totalQuestions: 8, minutes: 12,
    bloomLevels: ["understand", "apply"],
    bloomWeights: { understand: 0.5, apply: 0.5 },
    label: "Quick practice",
    rationale: "Short, low-stakes practice — pick Bloom levels and we'll write balanced questions.",
  },
};

const FALLBACK_SHAPE: TestShape = {
  totalQuestions: 10,
  minutes: 15,
  bloomLevels: ["understand", "apply"],
  bloomWeights: W_BALANCED,
  label: "Practice test",
  rationale: "A balanced default — Understand + Apply, 10 questions in 15 minutes.",
};

/**
 * The single function every UI surface should call.
 *
 * Resolution order:
 *   1. examGoal slug → GOAL_SHAPES exact match
 *   2. learnerProfile = "corporate" → corporate shape
 *   3. learnerProfile = "k12" → class 9-ish shape (most common K-12 default)
 *   4. learnerProfile = "competitive_exam" without specific exam → balanced
 *   5. fallback (Understand + Apply, 10 questions / 15 min)
 *
 * Returns a fresh TestShape every call so callers can safely mutate the
 * arrays. (Defensive — none currently do, but cheap insurance.)
 */
export function typicalTestShape(opts: {
  examGoal?: string | null;
  learnerProfile?: string | null;
}): TestShape {
  const goal = (opts.examGoal || "").toLowerCase().trim();
  if (goal && GOAL_SHAPES[goal]) {
    const s = GOAL_SHAPES[goal];
    return { ...s, bloomLevels: s.bloomLevels.slice(), bloomWeights: { ...s.bloomWeights } };
  }
  const profile = (opts.learnerProfile || "").toLowerCase().trim();
  if (profile === "corporate") {
    const s = GOAL_SHAPES.corporate;
    return { ...s, bloomLevels: s.bloomLevels.slice(), bloomWeights: { ...s.bloomWeights } };
  }
  if (profile === "k12") {
    const s = GOAL_SHAPES.class_9;
    return { ...s, bloomLevels: s.bloomLevels.slice(), bloomWeights: { ...s.bloomWeights } };
  }
  if (profile === "competitive_exam") {
    return { ...FALLBACK_SHAPE, label: "Competitive-exam practice" };
  }
  return { ...FALLBACK_SHAPE, bloomLevels: FALLBACK_SHAPE.bloomLevels.slice(), bloomWeights: { ...FALLBACK_SHAPE.bloomWeights } };
}

/**
 * Given a TestShape + a target total question count, allocate questions
 * across the shape's Bloom levels using the shape's weights. Guarantees
 * the sum equals `total` and every selected level gets at least 1.
 *
 * Used to seed per-level counts when the user expands the "Customise per
 * level" panel — the smart starting point.
 */
export function allocatePerLevelCounts(
  shape: TestShape,
  total: number,
): Record<BloomLevel, number> {
  const out: Record<BloomLevel, number> = {
    remember: 0, understand: 0, apply: 0, analyze: 0, evaluate: 0, create: 0,
  };
  const levels = shape.bloomLevels;
  if (levels.length === 0 || total <= 0) return out;
  // Floor pass, then distribute remainder by largest fractional.
  const fracs: Array<[BloomLevel, number]> = levels.map((l) => {
    const w = shape.bloomWeights[l] ?? 0;
    return [l, total * w];
  });
  // When total < levels.length we CAN'T give every level a minimum of 1
  // and still hit `total`. Two-pass strategy: floor-with-minimum-1, then
  // if over budget, zero out the lowest-weighted levels until the sum
  // matches. This preserves the sum=total invariant the caller relies on
  // (without it, the UI's "Customise per level" panel pre-fills with
  // a sum that doesn't match the user's chosen total — confusing).
  fracs.forEach(([l, n]) => { out[l] = Math.max(1, Math.floor(n)); });
  let assigned = levels.reduce((s, l) => s + out[l], 0);
  if (assigned > total) {
    // First: drop low-weight levels to 0 in ascending-weight order.
    const sortedAsc = [...fracs].sort((a, b) => a[1] - b[1]);
    for (const [l] of sortedAsc) {
      while (assigned > total && out[l] > 0) {
        out[l] -= 1;
        assigned -= 1;
      }
      if (assigned <= total) break;
    }
  }
  // If we're short, distribute remainder by largest fractional.
  if (assigned < total) {
    const sortedDesc = [...fracs]
      .map(([l, n]) => [l, n - Math.floor(n)] as [BloomLevel, number])
      .sort((a, b) => b[1] - a[1]);
    for (const [l] of sortedDesc) {
      if (assigned >= total) break;
      out[l] += 1;
      assigned += 1;
    }
  }
  return out;
}

/**
 * Convenience: return only the BLOOM_LEVELS subset relevant to a shape.
 * Mirrors what callers usually want when rendering Bloom chips.
 */
export function bloomLevelsForShape(shape: TestShape): BloomLevel[] {
  return BLOOM_LEVELS.filter((l) => shape.bloomLevels.includes(l));
}
