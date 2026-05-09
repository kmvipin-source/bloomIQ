/**
 * lib/bloomiqInsights.ts
 *
 * Pure helpers that turn a BloomIQ Score reveal payload into human-
 * readable insights for the Future You screen. No side-effects, no DB
 * calls — every function takes inputs and returns strings/objects the
 * UI can render directly.
 *
 * The reason this is its own module: the Future You reveal screen used
 * to be raw numbers. Numbers without interpretation feel like a lab
 * report, not a moment. These insights bridge the gap — they tell the
 * student what their numbers MEAN, what's working, what's costing them
 * marks, and exactly why the Premium upgrade narrative is calibrated
 * to their specific weaknesses.
 *
 * Everything here is deterministic given the same inputs (no randomness,
 * no LLM calls), so the same student sees consistent insights across
 * page reloads — which is critical for trust.
 */

import type { BloomLevel } from "@/lib/bloom";
import { BLOOM_LABEL } from "@/lib/bloomiqScore";

// ---------------------------------------------------------------------------
// BLOOM SIGNATURE — a short personality-style label that captures the shape
// of the student's Bloom mastery profile in one phrase.
// ---------------------------------------------------------------------------
//
// Why this matters: students LOVE being labeled. Personality-style
// labels create identity ("I'm a Fast Recogniser"), shareability, and
// give the rest of the reveal a frame of reference.

export type BloomSignature = {
  /** Short label, e.g. "Fast Recogniser, Slow Applier". 4-7 words. */
  label: string;
  /** One-line interpretation of what this signature means for exam day. */
  tagline: string;
};

/**
 * Derives a Bloom signature from the breakdown. We bucket the student
 * into one of ~8 archetypes based on the relative strength of their
 * lower-Bloom (Remember + Understand) vs higher-Bloom (Analyze +
 * Evaluate + Create) mastery.
 */
export function computeSignature(
  breakdown: Record<string, number>
): BloomSignature {
  const r = breakdown.remember ?? 0;
  const u = breakdown.understand ?? 0;
  const ap = breakdown.apply ?? 0;
  const an = breakdown.analyze ?? 0;
  const ev = breakdown.evaluate ?? 0;
  const cr = breakdown.create ?? 0;

  const lower = (r + u) / 2;     // recall + comprehension
  const middle = (ap + an) / 2;   // application + analysis
  const upper = (ev + cr) / 2;    // evaluation + creation

  // Edge cases first: blanket-strong / blanket-weak.
  const overall = (r + u + ap + an + ev + cr) / 6;
  if (overall >= 0.85) return {
    label: "Topper Profile",
    tagline: "Strong across the board. The headroom now is exam-day execution under time pressure — speed and precision, not new content.",
  };
  if (overall <= 0.20) return {
    label: "Building Your Foundation",
    tagline: "The basics are the highest-leverage place to invest right now. A few targeted Remember + Understand drills will lift every level above them — most students never bother to fix this and it shows on exam day.",
  };

  // Three-way archetype based on which tier dominates.
  if (lower > middle + 0.15 && lower > upper + 0.15) {
    return {
      label: "Fast Recogniser, Slow Applier",
      tagline: "You recall and explain content well, but stumble when questions ask you to USE it. Classic for students who ace school exams but underperform in mocks. Fix: targeted Apply-level drills.",
    };
  }
  if (middle > lower + 0.10 && middle > upper + 0.10) {
    return {
      label: "Mid-Bloom Workhorse",
      tagline: "Solid on Apply and Analyze — the bread-and-butter of competitive exams. Lifting Evaluate and Create unlocks the top-percentile tier where toppers separate from the pack.",
    };
  }
  if (upper > middle + 0.10 && upper > lower + 0.10) {
    return {
      label: "Strong Reasoning, Building Base",
      tagline: "You reason at high levels — that\'s the rare part. The catch is the basic recall keeps tripping you up on easy questions. Patch those gaps and your reasoning lands cleaner across the board.",
    };
  }

  // Imbalance patterns.
  if (Math.abs(r - u) > 0.30) {
    return r > u
      ? { label: "Strong Recall, Building Comprehension",
          tagline: "You remember terms and formulas but don't yet explain them in your own words. Understand-level practice is the missing bridge to Apply." }
      : { label: "Intuitive Understander",
          tagline: "You grasp concepts well but struggle to recall specific facts. Spaced-repetition practice will close the gap fast." };
  }

  // Default: balanced-but-mid.
  return {
    label: "Balanced Mid-Tier Profile",
    tagline: "Steady across all six Bloom levels but not yet topping any of them. Pick one weak level and grind it for two weeks — the score moves visibly.",
  };
}

// ---------------------------------------------------------------------------
// STRENGTH + CONCERN CALLOUTS
// ---------------------------------------------------------------------------

export type Callout = {
  level: BloomLevel;
  label: string;        // "Understand"
  mastery: number;      // 0..1
  takeaway: string;     // one-sentence interpretation
};

export function computeStrength(breakdown: Record<string, number>): Callout | null {
  const entries = Object.entries(breakdown) as Array<[BloomLevel, number]>;
  if (entries.length === 0) return null;
  const [bestLevel, bestMastery] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
  return {
    level: bestLevel,
    label: BLOOM_LABEL[bestLevel] ?? bestLevel,
    mastery: bestMastery,
    takeaway: strengthCopy(bestLevel, bestMastery),
  };
}

export function computeConcern(breakdown: Record<string, number>): Callout | null {
  const entries = Object.entries(breakdown) as Array<[BloomLevel, number]>;
  if (entries.length === 0) return null;
  const [worstLevel, worstMastery] = entries.reduce((a, b) => (b[1] < a[1] ? b : a));
  return {
    level: worstLevel,
    label: BLOOM_LABEL[worstLevel] ?? worstLevel,
    mastery: worstMastery,
    takeaway: concernCopy(worstLevel, worstMastery),
  };
}

function strengthCopy(level: BloomLevel, mastery: number): string {
  const pct = Math.round(mastery * 100);
  if (mastery >= 0.9) {
    switch (level) {
      case "remember":   return `Your factual recall is exceptional (${pct}%). Use this as the launchpad for higher Bloom levels — most students never reach this base.`;
      case "understand": return `${pct}% on Understand means you can paraphrase, classify, and explain — the rare skill that separates rote-learners from real comprehenders. Build Apply on top.`;
      case "apply":      return `${pct}% on Apply is competitive-exam gold — you can use what you know in new situations. Push into Analyze and Evaluate for top-percentile reach.`;
      case "analyze":    return `${pct}% on Analyze puts you in the top decile — most students never get past Apply. Your reasoning is mature; channel it into Evaluate.`;
      case "evaluate":   return `${pct}% on Evaluate is rare. You judge trade-offs and weigh evidence — the skill toppers use to attack tricky multi-option questions.`;
      case "create":     return `${pct}% on Create is exceptional — only top-percentile students design new solutions. Use this strength when the exam allows open-ended responses.`;
    }
  }
  return `Your strongest Bloom level is ${BLOOM_LABEL[level]} at ${pct}%. Build the rest on top of this foundation.`;
}

function concernCopy(level: BloomLevel, mastery: number): string {
  const pct = Math.round(mastery * 100);
  if (mastery <= 0.4) {
    switch (level) {
      case "remember":   return `Only ${pct}% on Remember is unusual and risky. Without solid factual recall, every higher-level question takes longer and feels harder. This is the single most fixable weakness — flashcards + spaced repetition close it in 2-3 weeks.`;
      case "understand": return `${pct}% on Understand means you're memorising without comprehending. This is why mock scores stagnate. Fix: explain each concept aloud in your own words for 5 minutes a day.`;
      case "apply":      return `${pct}% on Apply is the classic competitive-exam ceiling. You know the content but can't deploy it on novel problems. Apply drills are exactly what move the score most.`;
      case "analyze":    return `${pct}% on Analyze is what's costing you the tricky multi-step questions in mocks. Deliberate practice on past-paper Analyze questions is the unlock.`;
      case "evaluate":   return `${pct}% on Evaluate means you're picking distractor-trap options. Critical-reasoning practice and "why is this option wrong" drills fix this quickly.`;
      case "create":     return `${pct}% on Create is the headroom most students never address. It matters most for design / experimental / open-ended questions. Optional unless your exam tests it explicitly.`;
    }
  }
  return `Your weakest Bloom level is ${BLOOM_LABEL[level]} at ${pct}%. Targeted practice here lifts your score most efficiently.`;
}

// ---------------------------------------------------------------------------
// TIME-TO-BEST-YOU — rough estimate of how long focused practice takes
// to lift the student from current → Best You.
// ---------------------------------------------------------------------------
//
// Heuristic: each 10-point score gain at the higher Bloom levels needs
// ~2 hours of focused targeted practice. Lower Bloom levels are faster
// (~1 hour per 10 points). Real number depends on student, but anchoring
// is more useful than vagueness.

export type TimeEstimate = {
  weeksMin: number;
  weeksMax: number;
  dailyMinutes: number;
  totalHours: number;
};

export function computeTimeToBestYou(
  currentScore: number,
  bestYouScore: number,
  weakestLevels: string[]
): TimeEstimate {
  const delta = Math.max(0, bestYouScore - currentScore);
  // Lower Bloom levels = ~1h/10pts; higher Bloom levels = ~2h/10pts.
  // Average the weight of the levels being lifted.
  const higherCount = weakestLevels.filter((l) =>
    ["analyze", "evaluate", "create"].includes(l)
  ).length;
  const ratio = weakestLevels.length === 0 ? 0.5 : higherCount / weakestLevels.length;
  const hoursPerTenPoints = 1 + ratio; // 1h..2h
  const totalHours = Math.max(8, Math.round((delta / 10) * hoursPerTenPoints));

  // Two scenarios: optimistic (45 min/day) and realistic (25 min/day).
  const weeksMin = Math.max(2, Math.round(totalHours / (0.75 * 7))); // 45min × 7 days
  const weeksMax = Math.max(weeksMin + 2, Math.round(totalHours / (0.4 * 7))); // 24min × 7 days
  const dailyMinutes = 30;

  return { weeksMin, weeksMax, dailyMinutes, totalHours };
}

// ---------------------------------------------------------------------------
// PREMIUM UPGRADE NARRATIVE — personalised, score-anchored, three-action.
// ---------------------------------------------------------------------------

export type UpgradeAction = {
  /** Which Bloom level this action targets — used to colour the row. */
  level: BloomLevel;
  /** Verb-led action ("Drill 25 Apply questions per week"). */
  action: string;
  /** Estimated weekly time. */
  weeklyTime: string;
  /** Approximate score lift this single action delivers. */
  scoreLift: string;
};

export type UpgradeNarrative = {
  headline: string;        // "Move your score from 633 → 803."
  subhead: string;         // "Three targeted weekly habits make it real."
  actions: UpgradeAction[]; // exactly 3 — one per weakest Bloom level
  monthlyPriceInr: number;
  weeklyTimeTotal: string;
  cta: string;
  guarantee: string;
};

const ACTION_LIBRARY: Record<BloomLevel, { verb: string; what: string; weeklyTime: string }> = {
  remember:   { verb: "Drill",     what: "spaced-repetition flashcards on weak topics", weeklyTime: "60 min/week" },
  understand: { verb: "Practice",  what: "concept-explanation prompts (in your own words)", weeklyTime: "75 min/week" },
  apply:      { verb: "Solve",     what: "20 Apply-level past-paper problems", weeklyTime: "90 min/week" },
  analyze:    { verb: "Work",      what: "10 multi-step Analyze problems with full reasoning", weeklyTime: "100 min/week" },
  evaluate:   { verb: "Tackle",    what: "15 trap-detector and critical-reasoning questions", weeklyTime: "75 min/week" },
  create:     { verb: "Build",     what: "3 design / open-ended exercises", weeklyTime: "60 min/week" },
};

export function computeUpgradeNarrative(
  currentScore: number,
  bestYouScore: number,
  weakestLevels: BloomLevel[]
): UpgradeNarrative {
  const delta = Math.max(0, bestYouScore - currentScore);
  // Distribute the delta roughly across the 3 weakest levels.
  const liftPer = Math.max(15, Math.round(delta / Math.max(1, weakestLevels.length)));

  const actions: UpgradeAction[] = weakestLevels.slice(0, 3).map((lvl) => {
    const lib = ACTION_LIBRARY[lvl] ?? ACTION_LIBRARY.apply;
    return {
      level: lvl,
      action: `${lib.verb} ${lib.what}`,
      weeklyTime: lib.weeklyTime,
      scoreLift: `expected ~+${liftPer} pts`,
    };
  });

  // Total weekly time = sum of mins.
  const totalMins = actions.reduce((acc, a) => {
    const m = parseInt(a.weeklyTime, 10);
    return acc + (Number.isFinite(m) ? m : 0);
  }, 0);
  const totalHrs = Math.round(totalMins / 60 * 10) / 10;

  return {
    headline: `Move your score from ${currentScore} → ${bestYouScore}.`,
    subhead: `Three targeted weekly habits, all unlocked with Premium. Tied to YOUR specific weak spots — nobody else's.`,
    actions,
    monthlyPriceInr: 99,
    weeklyTimeTotal: `~${totalHrs} hours/week (~30 min/day)`,
    cta: `Start Premium — ₹99/month`,
    guarantee: `Cancel anytime. Your BloomIQ Score updates after every drill — if it isn't moving, that's signal to change tactics or pause.`,
  };
}


// ---------------------------------------------------------------------------
// TOPIC FOR DEEP-LINKED DRILLS — converts an exam_goal slug into a topic
// string that Groq treats as a real syllabus area, not a meta-question.
// ---------------------------------------------------------------------------
//
// The active-path Start buttons deep-link to /student/practice with a topic
// query param. If we pass something generic like "core syllabus", Groq
// generates questions ABOUT what core syllabus means. If we pass an exam
// goal-anchored string ("NEET Biology, Chemistry, Physics"), Groq generates
// real syllabus questions at the requested Bloom level.

export function topicForGoal(goal: string | null | undefined): string {
  if (!goal) return "Class 11–12 Mathematics (Algebra, Calculus, Coordinate Geometry)";
  const s = goal.toLowerCase();
  if (s.includes("neet")) return "NEET Biology — Class 11/12 NCERT (Cell Biology, Genetics, Plant/Human Physiology)";
  if (s.includes("jee"))  return "JEE Main Mathematics — Class 11/12 NCERT (Calculus, Coordinate Geometry, Algebra)";
  if (s.includes("cat") || s.includes("iim") || s.includes("mba"))
    return "CAT Quantitative Aptitude — Arithmetic, Algebra, Geometry, Number Systems";
  if (s.includes("upsc") || s.includes("ias") || s.includes("ips"))
    return "UPSC Prelims — Indian Polity (Constitution, Articles, Parliament, Judiciary)";
  if (s.includes("bank") || s.includes("ibps") || s.includes("sbi") || s.includes("rbi"))
    return "Bank PO — Quantitative Aptitude (Number Series, Approximation, DI)";
  if (/class[\s_]*5[\s_]*8/.test(s) || /primary|middle/.test(s))
    return "NCERT Class 5–8 Mathematics (Fractions, Decimals, Basic Algebra, Geometry)";
  if (/class[\s_]*9\b/.test(s))
    return "NCERT Class 9 Mathematics (Number Systems, Polynomials, Linear Equations, Triangles)";
  if (/class[\s_]*10|10th|x board/.test(s))
    return "NCERT Class 10 Mathematics (Quadratic Equations, AP, Trigonometry, Statistics)";
  if (/class[\s_]*12|12th|xii board/.test(s))
    return "NCERT Class 12 Physics (Electrostatics, Current Electricity, EMI, Optics, Modern Physics)";
  if (s.includes("board"))
    return "NCERT board Mathematics (Algebra, Geometry, Trigonometry)";
  return "Class 11–12 Mathematics (Algebra, Calculus, Coordinate Geometry)";
}
