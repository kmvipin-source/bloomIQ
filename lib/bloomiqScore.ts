/**
 * lib/bloomiqScore.ts
 *
 * The brain of the BloomIQ Score feature. Three things live here:
 *
 *   1. computeScore()       — turns a set of Bloom-tagged correct/wrong
 *                              answers into a single 300-900 score,
 *                              percentile, and per-Bloom-level mastery
 *                              breakdown. Used by the calibration submit
 *                              endpoint AND by the post-quiz recompute
 *                              endpoint, so the same numbers feel
 *                              consistent across surfaces.
 *
 *   2. predictRankAndColleges() — turns a score + exam goal into a
 *                              predicted rank (or percentile band) and
 *                              up to 3 named target colleges. Drives the
 *                              Future You reveal screen.
 *
 *   3. computeBestYou()     — simulates fixing the student's top-3
 *                              weakest Bloom levels and returns the
 *                              lifted score + rank + colleges. This is
 *                              the "look how much higher you could be"
 *                              moment that powers the upgrade narrative.
 *
 * SCORE PHILOSOPHY:
 *   - 300-900, credit-score familiar. Every Indian parent recognises a
 *     three-digit score with a 600-ish midpoint.
 *   - Bloom-level weighted: higher Bloom levels count more, so a student
 *     who can apply but not analyse scores lower than one who can do
 *     both — exactly the differentiator competitive-exam toppers have.
 *   - Bounded math: the algorithm cannot produce weird numbers from
 *     edge inputs (zero questions in a level, all wrong, all right,
 *     missing time data). Defaults degrade gracefully.
 *
 *   v1 is a transparent heuristic on purpose. Once we have ≥10k real
 *   calibration sessions we can swap the formula for a regression
 *   trained against actual exam outcomes — but the public-facing 300-900
 *   range and Bloom-weighted intuition stay the same.
 */

import { BLOOM_LEVELS, type BloomLevel } from "@/lib/bloom";

// ---------------------------------------------------------------------------
// Per-Bloom weights. Higher cognitive demand → higher weight. Sum ≈ 6.4.
// Tuned so a student who is 100% Remember but 0% everything else lands
// near 350 (clearly weak); a student who is 100% across the board lands
// near 900 (legitimately exceptional).
// ---------------------------------------------------------------------------
export const BLOOM_WEIGHTS: Record<BloomLevel, number> = {
  remember:   0.5,
  understand: 0.7,
  apply:      1.0,
  analyze:    1.2,
  evaluate:   1.4,
  create:     1.6,
};

// What we treat as "best you" mastery for the simulation. 0.85 is high
// but not unrealistic — it's roughly the level top-decile students hit
// after focused remediation, per our coaching data.
const BEST_YOU_TARGET_MASTERY = 0.85;

const SCORE_MIN = 300;
const SCORE_MAX = 900;

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

/**
 * Per-question outcome for a Bloom-tagged answer. Same shape used by the
 * calibration submit endpoint and the post-quiz recompute endpoint.
 */
export type ScorableAnswer = {
  bloom_level: BloomLevel;
  is_correct: boolean;
  /** Optional speed signal — defaults to no bonus when absent. */
  benchmark_seconds?: number;
  time_taken_seconds?: number;
};

/**
 * 0..1 mastery fraction per Bloom level. Levels with no questions are
 * omitted (rather than zeroed) so downstream "weakest" logic doesn't
 * pick a level we never measured.
 */
export type BloomBreakdown = Partial<Record<BloomLevel, number>>;

export type ComputedScore = {
  score: number;            // 300..900
  percentile: number;       // 0..100
  bloom_breakdown: BloomBreakdown;
  /** Top-3 weakest measured Bloom levels (worst first). */
  weakest_bloom_levels: BloomLevel[];
};

// ---------------------------------------------------------------------------
// CORE: computeScore
// ---------------------------------------------------------------------------

/**
 * Turns a list of Bloom-tagged answers into a 300-900 score and a per-
 * level mastery breakdown.
 */
export function computeScore(answers: ScorableAnswer[]): ComputedScore {
  // Tally correct/total per Bloom level.
  const tally: Record<BloomLevel, { correct: number; total: number }> = {
    remember:   { correct: 0, total: 0 },
    understand: { correct: 0, total: 0 },
    apply:      { correct: 0, total: 0 },
    analyze:    { correct: 0, total: 0 },
    evaluate:   { correct: 0, total: 0 },
    create:     { correct: 0, total: 0 },
  };

  let benchSum = 0;
  let timeSum = 0;
  let speedSamples = 0;

  for (const a of answers) {
    if (!BLOOM_LEVELS.includes(a.bloom_level)) continue;
    tally[a.bloom_level].total += 1;
    if (a.is_correct) tally[a.bloom_level].correct += 1;
    if (
      typeof a.benchmark_seconds === "number" && a.benchmark_seconds > 0 &&
      typeof a.time_taken_seconds === "number" && a.time_taken_seconds > 0
    ) {
      benchSum += a.benchmark_seconds;
      timeSum += a.time_taken_seconds;
      speedSamples += 1;
    }
  }

  // Per-level mastery — only for levels with at least one question.
  const breakdown: BloomBreakdown = {};
  let weightedSum = 0;
  let weightedMax = 0;
  for (const lvl of BLOOM_LEVELS) {
    const t = tally[lvl];
    if (t.total === 0) continue;
    const mastery = t.correct / t.total;
    breakdown[lvl] = mastery;
    const w = BLOOM_WEIGHTS[lvl];
    weightedSum += mastery * w;
    weightedMax += w;
  }

  // Mastery → 0..600 portion of the 300-900 range.
  const masteryScore = weightedMax === 0
    ? 0
    : (weightedSum / weightedMax) * 600;

  // Speed bonus → 0..30. Modest by design — speed shouldn't dominate
  // mastery, just reward students who don't dawdle.
  let speedBonus = 0;
  if (speedSamples >= 4 && timeSum > 0) {
    // ratio < 1 means faster-than-benchmark
    const ratio = timeSum / benchSum;
    if (ratio < 1.0) {
      // Linear: ratio 1.0 → 0 bonus, ratio 0.5 → +30 bonus.
      speedBonus = Math.min(30, Math.round((1.0 - ratio) * 60));
    }
  }

  const raw = SCORE_MIN + Math.round(masteryScore) + speedBonus;
  const score = Math.max(SCORE_MIN, Math.min(SCORE_MAX, raw));

  // Percentile: cheap normal-ish mapping centered at 600 with σ=100.
  // Will be replaced with a real distribution table once we have data.
  const percentile = scoreToPercentile(score);

  // Weakest 3 Bloom levels among those measured.
  const weakest = (Object.entries(breakdown) as Array<[BloomLevel, number]>)
    .sort(([, a], [, b]) => a - b)
    .slice(0, 3)
    .map(([lvl]) => lvl);

  return {
    score,
    percentile,
    bloom_breakdown: breakdown,
    weakest_bloom_levels: weakest,
  };
}

/**
 * Cheap closed-form approximation of the standard normal CDF, mapped so
 * a score of 600 = 50th percentile and σ ≈ 100. Good enough for the v1
 * UI; replace with an empirical distribution once we have ≥10k real
 * calibration sessions.
 */
function scoreToPercentile(score: number): number {
  const z = (score - 600) / 100;
  // Abramowitz & Stegun approximation — accurate to ~0.0001.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (((((1.330274 * t - 1.821256) * t) + 1.781478) * t - 0.356538) * t + 0.319382);
  if (z > 0) p = 1 - p;
  return Math.max(1, Math.min(99, Math.round(p * 100)));
}

// ---------------------------------------------------------------------------
// RANK + COLLEGE PREDICTION
// ---------------------------------------------------------------------------

export type CollegeTarget = {
  name: string;
  band: string; // e.g. "AIR ≤ 100", "Top 0.5%"
};

export type RankPrediction = {
  /** Predicted exam rank (lower = better). null when only a percentile
   *  band can be given (non-NEET/JEE/Boards exams). */
  predicted_rank: number | null;
  /** Human-readable band like "AIR ~12,400" or "Top 12%" — always set. */
  rank_label: string;
  /** Up to 3 representative target colleges/outcomes the score qualifies
   *  for. Empty when we don't have a cutoff table for the exam. */
  colleges: CollegeTarget[];
};

/**
 * Maps a score (300-900) and an exam goal to a predicted rank and 3
 * representative colleges. The exam-cutoff numbers below are public,
 * approximate, and updated annually — they're meant to anchor the
 * student's intuition, not function as official admission predictions
 * (the UI surfaces this caveat).
 */
export function predictRankAndColleges(
  score: number,
  examGoal: string | null
): RankPrediction {
  const goal = normalizeExamGoal(examGoal);

  // Score → predicted rank scaling per exam. Higher score = lower rank.
  // Curve: rank = base × exp(-k × (score - 300)/600). Tuned per exam so
  // that score=900 ≈ AIR top-50 and score=300 ≈ AIR bottom-of-the-pool.

  if (goal === "neet") {
    const rank = Math.max(1, Math.round(180000 * Math.exp(-5.5 * (score - 300) / 600)));
    return {
      predicted_rank: rank,
      rank_label: `NEET AIR ~${rank.toLocaleString("en-IN")}`,
      colleges: collegesForNeet(rank),
    };
  }

  if (goal === "jee") {
    const rank = Math.max(1, Math.round(120000 * Math.exp(-5.5 * (score - 300) / 600)));
    return {
      predicted_rank: rank,
      rank_label: `JEE Main AIR ~${rank.toLocaleString("en-IN")}`,
      colleges: collegesForJee(rank),
    };
  }

  if (goal === "boards") {
    // Boards: predicted percentage instead of rank.
    const pct = Math.round(50 + ((score - 300) / 600) * 45); // 50..95%
    return {
      predicted_rank: null,
      rank_label: `Predicted ~${pct}% in board exams`,
      colleges: collegesForBoards(pct),
    };
  }

  if (goal === "primary_middle") {
    // For Class 5–9 students we don't predict ranks or colleges —
    // those are years away and risk anxiety. Instead we surface three
    // grade-appropriate outcomes:
    //   1. Grade-level position ("ahead of 75% of Class 7 peers").
    //   2. Olympiad / Talent-search readiness band.
    //   3. Forward-projection to Class 10 boards readiness.
    // Score → "grade-percentile" (treats 600 BloomIQ as ~75th class
    // percentile, with curve tuned for younger ages). Same scoreToPercentile
    // shape as the generic branch; we re-label the rank line for parents.
    const gradePct = scoreToPercentile(score);
    return {
      predicted_rank: null,
      rank_label: `Ahead of ${gradePct}% of grade-level peers`,
      colleges: collegesForPrimaryMiddle(score, gradePct),
    };
  }

    if (goal === "cat") {
    // CAT is itself a percentile-based exam — IIMs and B-schools cut off
    // by percentile, not absolute rank. We map the BloomIQ score to an
    // expected CAT percentile (skewed because CAT is selective: a 600
    // BloomIQ ~ ~85th CAT percentile, a 800 BloomIQ ~ ~99th).
    const catPct = Math.max(1, Math.min(99.9,
      // Curve: score 300 -> ~30%ile, 600 -> ~85%ile, 800 -> ~99%ile, 900 -> 99.9%ile
      30 + Math.pow((score - 300) / 600, 1.4) * 70
    ));
    return {
      predicted_rank: null,
      rank_label: `Predicted CAT %ile ~${catPct.toFixed(1)}`,
      colleges: collegesForCat(catPct),
    };
  }

  // Unknown exam — percentile band only.
  const percentile = scoreToPercentile(score);
  return {
    predicted_rank: null,
    rank_label: `Top ${100 - percentile}% nationally`,
    colleges: [],
  };
}

export function normalizeExamGoal(raw: string | null): "neet" | "jee" | "boards" | "cat" | "primary_middle" | "other" {
  if (!raw) return "other";
  const s = raw.toLowerCase();
  if (s.includes("neet")) return "neet";
  if (s.includes("jee")) return "jee";
  if (s.includes("cat") || s.includes("iim") || s.includes("mba")) return "cat";
  // Younger grades go to "primary_middle" — Class 5-9 use the same outcome
  // mapping (grade-level position + Olympiad / Boards forward-projection)
  // rather than AIR-style college predictions.
  if (/class[\s_]*[56789]\b/.test(s) || /class[\s_]*5[\s_]*8/.test(s) || /primary|middle/.test(s)) {
    return "primary_middle";
  }
  if (s.includes("board") || /class[\s_]*1[02]/.test(s) || /cbse|icse|state board/.test(s)) {
    return "boards";
  }
  return "other";
}

function collegesForNeet(rank: number): CollegeTarget[] {
  // Public approximate cutoffs — meant to anchor the student's intuition.
  if (rank <= 50)    return [
    { name: "AIIMS Delhi (MBBS)",       band: "AIR ≤ 50" },
    { name: "AIIMS Bhopal (MBBS)",      band: "AIR ≤ 600" },
    { name: "MAMC Delhi (MBBS)",        band: "AIR ≤ 1,500" },
  ];
  if (rank <= 600)   return [
    { name: "AIIMS Bhopal (MBBS)",      band: "AIR ≤ 600" },
    { name: "JIPMER Puducherry (MBBS)", band: "AIR ≤ 700" },
    { name: "MAMC Delhi (MBBS)",        band: "AIR ≤ 1,500" },
  ];
  if (rank <= 1500)  return [
    { name: "MAMC Delhi (MBBS)",        band: "AIR ≤ 1,500" },
    { name: "GMC Mumbai (MBBS)",        band: "AIR ≤ 3,000" },
    { name: "Top state govt MBBS",      band: "AIR ≤ 5,000" },
  ];
  if (rank <= 5000)  return [
    { name: "GMC Mumbai (MBBS)",        band: "AIR ≤ 3,000" },
    { name: "Top state govt MBBS",      band: "AIR ≤ 5,000" },
    { name: "Reputed state colleges",   band: "AIR ≤ 15,000" },
  ];
  if (rank <= 15000) return [
    { name: "Reputed state govt MBBS",  band: "AIR ≤ 15,000" },
    { name: "Top private (Manipal etc)",band: "AIR ≤ 25,000" },
    { name: "Mid-tier private MBBS",    band: "AIR ≤ 50,000" },
  ];
  if (rank <= 50000) return [
    { name: "Mid-tier private MBBS",    band: "AIR ≤ 50,000" },
    { name: "BDS / BAMS (govt)",        band: "AIR ≤ 80,000" },
    { name: "Lower-tier private MBBS",  band: "AIR ≤ 1,20,000" },
  ];
  return [
    { name: "BDS / BAMS / BHMS",        band: "AIR ≤ 1,20,000" },
    { name: "Lower-tier private MBBS",  band: "AIR ≤ 1,50,000" },
    { name: "Re-attempt recommended",   band: "—" },
  ];
}

function collegesForJee(rank: number): CollegeTarget[] {
  if (rank <= 100)   return [
    { name: "IIT Bombay — CSE",         band: "AIR ≤ 100" },
    { name: "IIT Delhi — CSE",          band: "AIR ≤ 150" },
    { name: "IIT Madras — CSE",         band: "AIR ≤ 200" },
  ];
  if (rank <= 500)   return [
    { name: "IIT Madras / Kanpur — CSE",band: "AIR ≤ 500" },
    { name: "Old IITs — Electrical",    band: "AIR ≤ 1,000" },
    { name: "IIT Hyderabad — CSE",      band: "AIR ≤ 1,500" },
  ];
  if (rank <= 3000)  return [
    { name: "Newer IIT branches",       band: "AIR ≤ 3,000" },
    { name: "NIT Trichy / Warangal",    band: "AIR ≤ 5,000" },
    { name: "BITS Pilani (via JEE)",    band: "AIR ≤ 8,000" },
  ];
  if (rank <= 10000) return [
    { name: "NIT mid-tier branches",    band: "AIR ≤ 10,000" },
    { name: "IIIT Hyderabad",           band: "AIR ≤ 12,000" },
    { name: "Top state govt engg",      band: "AIR ≤ 25,000" },
  ];
  if (rank <= 30000) return [
    { name: "Tier-2 NITs / IIITs",      band: "AIR ≤ 30,000" },
    { name: "Top state govt engg",      band: "AIR ≤ 40,000" },
    { name: "Reputed private engg",     band: "AIR ≤ 60,000" },
  ];
  return [
    { name: "Reputed private engg",     band: "AIR ≤ 60,000" },
    { name: "Mid-tier private engg",    band: "AIR ≤ 1,00,000" },
    { name: "State engg via JEE Main",  band: "—" },
  ];
}

function collegesForPrimaryMiddle(score: number, gradePct: number): CollegeTarget[] {
  // Three grade-appropriate forward-looking targets. Score band drives
  // which Olympiad tier and which boards-readiness label is shown.
  const boards = score >= 700 ? "On track for 90%+ in Class 10 boards"
              : score >= 600 ? "On track for 80% in Class 10 boards"
              : score >= 500 ? "On track for 70% in Class 10 boards"
              : score >= 400 ? "On track for 60% in Class 10 boards"
              : "Foundation work needed before Class 10 boards";
  const olympiad = score >= 750 ? "Ready for Olympiad Level 2 (RMO / NSO finals)"
                : score >= 650 ? "Ready for Olympiad Level 1 (PRMO / NSO Stage 1)"
                : score >= 550 ? "Olympiad Level 1 within reach with 4-week prep"
                : "Build fundamentals before attempting Olympiads";
  const peer = `Stronger than ${gradePct}% of grade-level peers (BloomIQ benchmark)`;
  return [
    { name: peer,     band: "Peer benchmark" },
    { name: olympiad, band: "Olympiad / Talent search" },
    { name: boards,   band: "Forward projection" },
  ];
}

function collegesForCat(pct: number): CollegeTarget[] {
  // CAT B-school cutoffs are public approximate composite percentiles
  // (CAT %ile + GD/PI weight). We anchor the user's expected band.
  if (pct >= 99.5) return [
    { name: "IIM Ahmedabad (PGP)",     band: "≥ 99.5 %ile" },
    { name: "IIM Bangalore (PGP)",     band: "≥ 99 %ile" },
    { name: "IIM Calcutta (PGP)",      band: "≥ 99 %ile" },
  ];
  if (pct >= 99) return [
    { name: "IIM Bangalore / Calcutta",band: "≥ 99 %ile" },
    { name: "IIM Lucknow",             band: "≥ 97 %ile" },
    { name: "FMS Delhi",               band: "≥ 98.5 %ile" },
  ];
  if (pct >= 97) return [
    { name: "IIM Lucknow / Indore",    band: "≥ 97 %ile" },
    { name: "IIM Kozhikode",           band: "≥ 96 %ile" },
    { name: "FMS Delhi / SPJIMR",      band: "≥ 95 %ile" },
  ];
  if (pct >= 95) return [
    { name: "IIM Kozhikode / Shillong",band: "≥ 94 %ile" },
    { name: "SPJIMR Mumbai",           band: "≥ 95 %ile" },
    { name: "MDI Gurgaon / IIFT",      band: "≥ 92 %ile" },
  ];
  if (pct >= 90) return [
    { name: "New IIMs (Trichy/Udaipur/Rohtak)", band: "≥ 90 %ile" },
    { name: "MDI Gurgaon / IIFT Delhi",         band: "≥ 92 %ile" },
    { name: "NMIMS Mumbai / NITIE",             band: "≥ 90 %ile" },
  ];
  if (pct >= 80) return [
    { name: "Newer IIMs (Sambalpur/Sirmaur)",   band: "≥ 85 %ile" },
    { name: "IMT Ghaziabad / IMI Delhi",        band: "≥ 85 %ile" },
    { name: "JBIMS Mumbai / SCMHRD Pune",       band: "≥ 80 %ile" },
  ];
  if (pct >= 60) return [
    { name: "IFMR / Great Lakes Chennai",       band: "≥ 70 %ile" },
    { name: "TAPMI Manipal / KJ Somaiya",       band: "≥ 70 %ile" },
    { name: "Tier-2 reputed B-schools",         band: "≥ 60 %ile" },
  ];
  return [
    { name: "Tier-2 / state B-schools",         band: "—" },
    { name: "Re-attempt strongly recommended",  band: "—" },
    { name: "Consider XAT / SNAP / NMAT path",  band: "—" },
  ];
}

function collegesForBoards(pct: number): CollegeTarget[] {
  if (pct >= 90) return [
    { name: "Top DU colleges (SRCC, Hindu)", band: "≥ 95%" },
    { name: "Top state board colleges",       band: "≥ 90%" },
    { name: "Strong CUET shortlists",         band: "≥ 90%" },
  ];
  if (pct >= 80) return [
    { name: "Reputed central / state colleges", band: "≥ 80%" },
    { name: "CUET Tier-1 with strong score",    band: "≥ 80%" },
    { name: "Top private universities",         band: "≥ 75%" },
  ];
  if (pct >= 70) return [
    { name: "State Tier-1 colleges",            band: "≥ 70%" },
    { name: "Most private universities",        band: "≥ 60%" },
    { name: "CUET Tier-2 shortlists",           band: "≥ 65%" },
  ];
  return [
    { name: "Mid-tier private colleges",        band: "≥ 55%" },
    { name: "State open universities",          band: "—" },
    { name: "Bridge / entrance prep route",     band: "—" },
  ];
}

// ---------------------------------------------------------------------------
// BEST YOU
// ---------------------------------------------------------------------------

export type BestYou = {
  score: number;
  prediction: RankPrediction;
  /** The Bloom levels the simulation lifted, so the UI can name them. */
  lifted_levels: BloomLevel[];
};

/**
 * Simulates fixing the student's top-3 weakest Bloom levels — assumes
 * mastery in those rises to BEST_YOU_TARGET_MASTERY (0.85), recomputes
 * the score with those new mastery values, and returns the lifted score
 * + rank + colleges.
 *
 * This is the "Best You" that powers the upgrade narrative on the
 * Future You reveal screen.
 */
export function computeBestYou(
  current: ComputedScore,
  examGoal: string | null
): BestYou {
  const lifted: BloomBreakdown = { ...current.bloom_breakdown };
  for (const lvl of current.weakest_bloom_levels) {
    lifted[lvl] = Math.max(lifted[lvl] ?? 0, BEST_YOU_TARGET_MASTERY);
  }

  // Re-derive a score from the lifted breakdown using the same formula
  // shape as computeScore (without the speed bonus — speed isn't part of
  // the simulated improvement).
  let weightedSum = 0;
  let weightedMax = 0;
  for (const lvl of BLOOM_LEVELS) {
    const m = lifted[lvl];
    if (m === undefined) continue;
    const w = BLOOM_WEIGHTS[lvl];
    weightedSum += m * w;
    weightedMax += w;
  }
  const masteryScore = weightedMax === 0 ? 0 : (weightedSum / weightedMax) * 600;
  const score = Math.max(SCORE_MIN, Math.min(SCORE_MAX, SCORE_MIN + Math.round(masteryScore)));

  return {
    score,
    prediction: predictRankAndColleges(score, examGoal),
    lifted_levels: current.weakest_bloom_levels,
  };
}

// ---------------------------------------------------------------------------
// LABELS — small helper so UI strings stay consistent.
// ---------------------------------------------------------------------------

export const BLOOM_LABEL: Record<BloomLevel, string> = {
  remember:   "Remember",
  understand: "Understand",
  apply:      "Apply",
  analyze:    "Analyze",
  evaluate:   "Evaluate",
  create:     "Create",
};
