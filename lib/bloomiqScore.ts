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
 *   2. predictRankAndColleges() — turns a score + exam goal into an
 *                              indicative rank band (or percentile band)
 *                              and up to 3 tier descriptors of college
 *                              outcomes typical of that band. Drives the
 *                              indicative-band reveal screen.
 *
 *   3. computeBestYou()     — simulates fixing the student's top-3
 *                              weakest Bloom levels and returns the
 *                              lifted score + band + tier descriptors.
 *                              Powers the stretch-target view.
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
 *
 * IMPORTANT (legal posture):
 *   This module produces an INDICATIVE self-assessment band. It is NOT
 *   a prediction of exam rank, admission, or outcome at any specific
 *   institution. Tier descriptors below are deliberately generic — no
 *   institution is named anywhere in this file. Cutoff numbers used to
 *   pick which tier band to show are drawn from publicly reported
 *   approximate ranges and serve only as anchors for self-direction.
 *   Any UI consuming these outputs must surface the indicative-only
 *   framing prominently to the student (see app/student/future/page.tsx).
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
  /** Generic tier descriptor — e.g. "Top-tier government medical college".
   *  Deliberately never an institution name. See module-level note. */
  name: string;
  /** Approximate cutoff band the tier sits in — e.g. "AIR 5,000–15,000 band". */
  band: string;
};

export type RankPrediction = {
  /** Indicative band rank (lower = better). Used internally to pick the
   *  tier list and the band label. null when only a percentile band can
   *  be given. The UI MUST NOT present this as a precise prediction. */
  predicted_rank: number | null;
  /** Human-readable indicative band like "NEET AIR 10,000–15,000 band"
   *  or "Top 12% indicative band" — never an exact predicted number. */
  rank_label: string;
  /** Up to 3 tier descriptors (no institution names) the band typically
   *  corresponds to per publicly reported approximate cutoffs. Empty when
   *  we don't have a cutoff table for the exam. */
  colleges: CollegeTarget[];
};

/**
 * Maps a score (300-900) and an exam goal to an indicative rank BAND
 * and 3 tier descriptors. The cutoff numbers below are public, approximate,
 * and updated annually — they anchor self-direction, NOT admission
 * outcomes. No institution is ever named in the output (legal posture);
 * UIs that surface this data are responsible for the "indicative only"
 * framing.
 */
export function predictRankAndColleges(
  score: number,
  examGoal: string | null
): RankPrediction {
  const goal = normalizeExamGoal(examGoal);

  // Score → indicative-band rank scaling per exam. Higher score = lower
  // rank. Curve: rank = base × exp(-k × (score - 300)/600). The exact
  // number is never shown — it's rounded into a band by neetRankBandLabel
  // / jeeRankBandLabel before display.

  if (goal === "neet") {
    const rank = Math.max(1, Math.round(180000 * Math.exp(-5.5 * (score - 300) / 600)));
    return {
      predicted_rank: rank,
      rank_label: `NEET indicative band: ${neetRankBandLabel(rank)}`,
      colleges: collegesForNeet(rank),
    };
  }

  if (goal === "jee") {
    const rank = Math.max(1, Math.round(120000 * Math.exp(-5.5 * (score - 300) / 600)));
    return {
      predicted_rank: rank,
      rank_label: `JEE Main indicative band: ${jeeRankBandLabel(rank)}`,
      colleges: collegesForJee(rank),
    };
  }

  if (goal === "boards") {
    // Boards: indicative percentage band instead of a specific number.
    const pct = Math.round(50 + ((score - 300) / 600) * 45); // 50..95%
    return {
      predicted_rank: null,
      rank_label: `Boards indicative band: ${boardsPctBandLabel(pct)}`,
      colleges: collegesForBoards(pct),
    };
  }

  if (goal === "primary_middle") {
    // For Class 5–9 students we don't show ranks or colleges — those are
    // years away and risk anxiety. Instead we surface three grade-
    // appropriate indicative anchors:
    //   1. Grade-level position ("ahead of 75% of Class 7 peers").
    //   2. Olympiad / Talent-search readiness band.
    //   3. Forward-projection to Class 10 boards readiness.
    const gradePct = scoreToPercentile(score);
    return {
      predicted_rank: null,
      rank_label: `Indicative band: ahead of ~${peerBandLabel(gradePct)} of grade-level peers`,
      colleges: collegesForPrimaryMiddle(score, gradePct),
    };
  }

    if (goal === "cat") {
    // CAT is itself a percentile-based exam. We map the BloomIQ score to
    // an indicative CAT percentile band — never a precise number.
    const catPct = Math.max(1, Math.min(99.9,
      30 + Math.pow((score - 300) / 600, 1.4) * 70
    ));
    return {
      predicted_rank: null,
      rank_label: `CAT indicative band: ${catPctBandLabel(catPct)}`,
      colleges: collegesForCat(catPct),
    };
  }

  // Unknown exam — percentile band only.
  const percentile = scoreToPercentile(score);
  return {
    predicted_rank: null,
    rank_label: `Indicative band: top ${peerBandLabel(percentile)} nationally`,
    colleges: [],
  };
}

// ─── Band-label helpers ────────────────────────────────────────────
// Convert a precise computed number into an indicative range. We never
// show the raw number to the student — it implies a precision the v1
// heuristic does not have, and reads as a promise.

function neetRankBandLabel(rank: number): string {
  if (rank <= 100)    return "AIR top-100 tier";
  if (rank <= 500)    return "AIR top-500 tier";
  if (rank <= 1500)   return "AIR 500–1,500 band";
  if (rank <= 5000)   return "AIR 1,500–5,000 band";
  if (rank <= 15000)  return "AIR 5,000–15,000 band";
  if (rank <= 50000)  return "AIR 15,000–50,000 band";
  if (rank <= 120000) return "AIR 50,000–1,20,000 band";
  return "Foundation tier — strengthening recommended";
}

function jeeRankBandLabel(rank: number): string {
  if (rank <= 100)    return "AIR top-100 tier";
  if (rank <= 500)    return "AIR top-500 tier";
  if (rank <= 3000)   return "AIR 500–3,000 band";
  if (rank <= 10000)  return "AIR 3,000–10,000 band";
  if (rank <= 30000)  return "AIR 10,000–30,000 band";
  if (rank <= 100000) return "AIR 30,000–1,00,000 band";
  return "Foundation tier — strengthening recommended";
}

function boardsPctBandLabel(pct: number): string {
  if (pct >= 90) return "90%+ band";
  if (pct >= 80) return "80–90% band";
  if (pct >= 70) return "70–80% band";
  if (pct >= 60) return "60–70% band";
  return "Foundation band — strengthening recommended";
}

function catPctBandLabel(pct: number): string {
  if (pct >= 99) return "99+ %ile band";
  if (pct >= 95) return "95–99 %ile band";
  if (pct >= 90) return "90–95 %ile band";
  if (pct >= 80) return "80–90 %ile band";
  if (pct >= 60) return "60–80 %ile band";
  return "Foundation %ile band — strengthening recommended";
}

function peerBandLabel(pct: number): string {
  if (pct >= 95) return "top 5%";
  if (pct >= 90) return "top 10%";
  if (pct >= 75) return "top 25%";
  if (pct >= 50) return "top 50%";
  if (pct >= 25) return "top 75%";
  return "foundation band";
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
  // Generic medical-college tier descriptors only — no named institutions.
  // Cutoff bands are public approximate ranges, used as self-direction
  // anchors for the student's expected tier. Not predictions.
  if (rank <= 100)   return [
    { name: "Top-tier national government medical (MBBS)", band: "approx AIR top-100 cutoff" },
    { name: "Top-tier government medical (MBBS)",          band: "approx AIR top-500 cutoff" },
    { name: "National-tier government medical (MBBS)",     band: "approx AIR top-1,500 cutoff" },
  ];
  if (rank <= 600)   return [
    { name: "Top-tier government medical (MBBS)",          band: "approx AIR top-500 cutoff" },
    { name: "National-tier government medical (MBBS)",     band: "approx AIR top-1,500 cutoff" },
    { name: "State-tier government medical (MBBS)",        band: "approx AIR top-5,000 cutoff" },
  ];
  if (rank <= 1500)  return [
    { name: "National-tier government medical (MBBS)",     band: "approx AIR top-1,500 cutoff" },
    { name: "State-tier government medical (MBBS)",        band: "approx AIR top-5,000 cutoff" },
    { name: "Reputed government medical (MBBS)",           band: "approx AIR top-15,000 cutoff" },
  ];
  if (rank <= 5000)  return [
    { name: "State-tier government medical (MBBS)",        band: "approx AIR top-5,000 cutoff" },
    { name: "Reputed government medical (MBBS)",           band: "approx AIR top-15,000 cutoff" },
    { name: "Reputed private medical college (MBBS)",      band: "approx AIR top-25,000 cutoff" },
  ];
  if (rank <= 15000) return [
    { name: "Reputed government medical (MBBS)",           band: "approx AIR top-15,000 cutoff" },
    { name: "Reputed private medical college (MBBS)",      band: "approx AIR top-25,000 cutoff" },
    { name: "Mid-tier private medical college (MBBS)",     band: "approx AIR top-50,000 cutoff" },
  ];
  if (rank <= 50000) return [
    { name: "Mid-tier private medical college (MBBS)",     band: "approx AIR top-50,000 cutoff" },
    { name: "Government dental / AYUSH (BDS / BAMS)",      band: "approx AIR top-80,000 cutoff" },
    { name: "Lower-tier private medical (MBBS)",           band: "approx AIR top-1,20,000 cutoff" },
  ];
  return [
    { name: "Private dental / AYUSH (BDS / BAMS / BHMS)",  band: "approx AIR top-1,20,000 cutoff" },
    { name: "Lower-tier private medical (MBBS)",           band: "approx AIR top-1,50,000 cutoff" },
    { name: "Foundation tier — strengthen and re-attempt", band: "—" },
  ];
}

function collegesForJee(rank: number): CollegeTarget[] {
  // Generic engineering-college tier descriptors only — no named
  // institutions. Cutoffs are public approximate ranges.
  if (rank <= 100)   return [
    { name: "Top-tier national engineering (core branches)",   band: "approx AIR top-100 cutoff" },
    { name: "Top-tier national engineering (other branches)",  band: "approx AIR top-500 cutoff" },
    { name: "National-tier engineering (CSE)",                 band: "approx AIR top-1,500 cutoff" },
  ];
  if (rank <= 500)   return [
    { name: "Top-tier national engineering (other branches)",  band: "approx AIR top-500 cutoff" },
    { name: "National-tier engineering (core branches)",       band: "approx AIR top-1,000 cutoff" },
    { name: "National-tier engineering (CSE)",                 band: "approx AIR top-1,500 cutoff" },
  ];
  if (rank <= 3000)  return [
    { name: "National-tier engineering (newer institutes)",    band: "approx AIR top-3,000 cutoff" },
    { name: "Reputed national engineering (core branches)",    band: "approx AIR top-5,000 cutoff" },
    { name: "Reputed national engineering (other branches)",   band: "approx AIR top-8,000 cutoff" },
  ];
  if (rank <= 10000) return [
    { name: "Reputed national engineering (mid-tier branches)",band: "approx AIR top-10,000 cutoff" },
    { name: "Reputed national engineering (newer institutes)", band: "approx AIR top-12,000 cutoff" },
    { name: "Top-tier state engineering",                      band: "approx AIR top-25,000 cutoff" },
  ];
  if (rank <= 30000) return [
    { name: "Tier-2 national engineering institutes",          band: "approx AIR top-30,000 cutoff" },
    { name: "Top-tier state engineering",                      band: "approx AIR top-40,000 cutoff" },
    { name: "Reputed private engineering",                     band: "approx AIR top-60,000 cutoff" },
  ];
  return [
    { name: "Reputed private engineering",                     band: "approx AIR top-60,000 cutoff" },
    { name: "Mid-tier private engineering",                    band: "approx AIR top-1,00,000 cutoff" },
    { name: "State engineering via JEE Main",                  band: "—" },
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
  // Generic B-school tier descriptors only — no named institutions.
  // Cutoff bands are public approximate composite percentiles.
  if (pct >= 99.5) return [
    { name: "Top-tier national B-school (PGP)",   band: "approx ≥ 99.5 %ile cutoff" },
    { name: "Tier-1 national B-school (PGP)",     band: "approx ≥ 99 %ile cutoff" },
    { name: "National-tier specialised B-school", band: "approx ≥ 98.5 %ile cutoff" },
  ];
  if (pct >= 99) return [
    { name: "Tier-1 national B-school (PGP)",     band: "approx ≥ 99 %ile cutoff" },
    { name: "National-tier specialised B-school", band: "approx ≥ 98.5 %ile cutoff" },
    { name: "Reputed national B-school",          band: "approx ≥ 97 %ile cutoff" },
  ];
  if (pct >= 97) return [
    { name: "Reputed national B-school",          band: "approx ≥ 97 %ile cutoff" },
    { name: "Reputed national B-school (other)",  band: "approx ≥ 96 %ile cutoff" },
    { name: "National-tier specialised B-school", band: "approx ≥ 95 %ile cutoff" },
  ];
  if (pct >= 95) return [
    { name: "Reputed national B-school (other)",  band: "approx ≥ 94 %ile cutoff" },
    { name: "National-tier specialised B-school", band: "approx ≥ 95 %ile cutoff" },
    { name: "Tier-1 reputed B-school",            band: "approx ≥ 92 %ile cutoff" },
  ];
  if (pct >= 90) return [
    { name: "Newer national-tier B-school",       band: "approx ≥ 90 %ile cutoff" },
    { name: "Tier-1 reputed B-school",            band: "approx ≥ 92 %ile cutoff" },
    { name: "Reputed private B-school",           band: "approx ≥ 90 %ile cutoff" },
  ];
  if (pct >= 80) return [
    { name: "Newer national-tier B-school",       band: "approx ≥ 85 %ile cutoff" },
    { name: "Tier-2 reputed B-school",            band: "approx ≥ 85 %ile cutoff" },
    { name: "Reputed private B-school",           band: "approx ≥ 80 %ile cutoff" },
  ];
  if (pct >= 60) return [
    { name: "Tier-2 reputed B-school",            band: "approx ≥ 70 %ile cutoff" },
    { name: "Reputed private B-school",           band: "approx ≥ 70 %ile cutoff" },
    { name: "Mid-tier B-school",                  band: "approx ≥ 60 %ile cutoff" },
  ];
  return [
    { name: "Mid-tier / state B-school",          band: "—" },
    { name: "Foundation tier — strengthen and re-attempt", band: "—" },
    { name: "Consider alternative entrance paths", band: "—" },
  ];
}

function collegesForBoards(pct: number): CollegeTarget[] {
  // Generic college-tier descriptors only — no named institutions.
  if (pct >= 90) return [
    { name: "Top-tier central university",        band: "approx ≥ 95% cutoff" },
    { name: "Top-tier state university",          band: "approx ≥ 90% cutoff" },
    { name: "Strong CUET shortlists",             band: "approx ≥ 90% cutoff" },
  ];
  if (pct >= 80) return [
    { name: "Reputed central / state university", band: "approx ≥ 80% cutoff" },
    { name: "CUET Tier-1 reputed institutes",     band: "approx ≥ 80% cutoff" },
    { name: "Top-tier private university",        band: "approx ≥ 75% cutoff" },
  ];
  if (pct >= 70) return [
    { name: "State Tier-1 university",            band: "approx ≥ 70% cutoff" },
    { name: "Reputed private university",         band: "approx ≥ 60% cutoff" },
    { name: "CUET Tier-2 shortlists",             band: "approx ≥ 65% cutoff" },
  ];
  return [
    { name: "Mid-tier private university",        band: "approx ≥ 55% cutoff" },
    { name: "State open university",              band: "—" },
    { name: "Foundation tier — bridge / re-attempt path", band: "—" },
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
