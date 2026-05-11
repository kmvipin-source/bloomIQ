import { NextResponse } from "next/server";
import { groqJSON } from "@/lib/groq";
import { BLOOM_LEVELS, type BloomLevel } from "@/lib/bloom";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 30;

// =============================================================================
// POST /api/rank/predict
// -----------------------------------------------------------------------------
// Body: { attempt_id?: string, exam_type?: 'JEE_MAIN'|'NEET'|'CAT'|'CUSTOM',
//         raw_score?: number, max_score?: number, target_air?: number }
//
// Estimates an All-India Rank from a raw score. Uses a simple Bayesian
// shortcut: the cohort score distribution is approximated as Normal with
// per-exam-tuned mean/stddev, the student's score is converted to a
// percentile, and percentile × cohort size = AIR estimate. Then asks Groq for
// 3 high-leverage recommendations based on the student's weakest Bloom level
// + topic.
// =============================================================================

type ExamType = "JEE_MAIN" | "NEET" | "CAT" | "CUSTOM";

const EXAM_BASELINES: Record<ExamType, { totalCandidates: number; meanPct: number; stdDevPct: number; label: string }> = {
  // Numbers are rough order-of-magnitude figures used purely for calibration.
  // Mean and stdDev are *percent of max score* (so they compose well with any
  // mock paper length). These are not official statistics — the predictor's
  // job is to be directionally useful, not exact.
  JEE_MAIN: { totalCandidates: 1_100_000, meanPct: 32, stdDevPct: 18, label: "JEE Main" },
  NEET:     { totalCandidates: 2_300_000, meanPct: 38, stdDevPct: 17, label: "NEET" },
  CAT:      { totalCandidates:   330_000, meanPct: 35, stdDevPct: 15, label: "CAT" },
  CUSTOM:   { totalCandidates:   100_000, meanPct: 40, stdDevPct: 18, label: "Custom mock" },
};

// Standard normal CDF approximation (Abramowitz & Stegun 26.2.17). Returns
// the probability that a standard-normal RV is <= z.
function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  let p = d * t * (
    0.319381530 +
    t * (-0.356563782 +
      t * (1.781477937 +
        t * (-1.821255978 + t * 1.330274429))));
  if (z >= 0) p = 1 - p;
  return p;
}

function pctToAir(scorePct: number, exam: ExamType): { percentile: number; air: number; total: number } {
  const b = EXAM_BASELINES[exam];
  const z = (scorePct - b.meanPct) / b.stdDevPct;
  const cdf = normCdf(z);                  // proportion of candidates BELOW this score
  const percentile = Math.max(0.01, Math.min(99.99, cdf * 100));
  // AIR is roughly (1 - percentile/100) × total. Add 1 so the very best is rank 1, not 0.
  const air = Math.max(1, Math.round((1 - cdf) * b.totalCandidates) + 1);
  return { percentile, air, total: b.totalCandidates };
}

// Confidence band on the AIR. Two sources of uncertainty are baked in:
//
//   1. Score-sampling error. A 10-question mock has much wider noise on the
//      true ability estimate than a 200-question paper. We use the binomial
//      standard error of the score percentage:
//         se = sqrt(p(1-p) / n)  where p = scorePct/100, n = max_score
//      Multiplied by 2 ≈ ~95% band on the percentage.
//
//   2. Cohort-distribution model error. Our normal-distribution baselines
//      are rough — even with infinite test length, the predicted percentile
//      could be off by a few points. We add a flat ±2 pp margin in score
//      space to absorb that.
//
// The two are combined in quadrature, then projected back to AIR by running
// pctToAir at scorePct ± margin. Wider band = more honest with the student.
function airBand(
  scorePct: number,
  maxScore: number,
  exam: ExamType
): { airLow: number; airHigh: number; marginPct: number } {
  const p = Math.max(0, Math.min(100, scorePct)) / 100;
  const n = Math.max(1, maxScore);
  const samplingSE_pct = 100 * Math.sqrt((p * (1 - p)) / n); // pp on score
  const modelMargin_pct = 2;                                  // pp baseline drift
  const margin_pct = 2 * Math.sqrt(samplingSE_pct ** 2 + modelMargin_pct ** 2); // ~95% band
  const lowScore  = Math.max(0,   scorePct - margin_pct);
  const highScore = Math.min(100, scorePct + margin_pct);
  // Higher score → BETTER (lower) AIR. So airLow comes from highScore.
  const airLow  = pctToAir(highScore, exam).air;
  const airHigh = pctToAir(lowScore,  exam).air;
  return { airLow, airHigh, marginPct: margin_pct };
}

const SYSTEM = `You are a competitive-exam coach producing 3 short, high-leverage study actions for a student based on their mock-test breakdown.

You will be given:
- exam type (e.g. JEE Main, NEET, CAT)
- their raw score / max score
- their predicted percentile
- a per-Bloom-level breakdown { bloom_level, correct, total }

Write exactly 3 directives (one sentence each, imperative). Each focused on the highest-yield deficit. Concrete: name a Bloom level + topic-style guidance.

Respond with VALID JSON only:
{ "recommendations": ["...", "...", "..."] }`;

function isExamType(s: string): s is ExamType {
  return s === "JEE_MAIN" || s === "NEET" || s === "CAT" || s === "CUSTOM";
}

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const rate = checkRateLimit(user.id, "rank.predict", { capacity: 10, refillPerHour: 20 });
    if (!rate.allowed) return NextResponse.json({ error: "Too many requests.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } });

    const body = await req.json().catch(() => ({}));
    const examTypeRaw = String(body.exam_type || "JEE_MAIN");
    const exam_type: ExamType = isExamType(examTypeRaw) ? examTypeRaw : "JEE_MAIN";
    const target_air: number | null = Number.isFinite(Number(body.target_air)) ? Number(body.target_air) : null;

    let raw_score: number;
    let max_score: number;
    let attempt_id: string | null = null;
    let bloomBreakdown: Array<{ bloom_level: BloomLevel; correct: number; total: number }> = [];

    if (body.attempt_id) {
      attempt_id = String(body.attempt_id);
      const { data: att, error: attErr } = await sb
        .from("quiz_attempts")
        .select("id, student_id, score, total")
        .eq("id", attempt_id)
        .single();
      if (attErr || !att) return NextResponse.json({ error: "Attempt not found" }, { status: 404 });
      if (att.student_id !== user.id) return NextResponse.json({ error: "Not yours" }, { status: 403 });
      raw_score = att.score || 0;
      max_score = att.total || 0;

      // Bloom breakdown for the recommendations call.
      const { data: ans } = await sb
        .from("attempt_answers")
        .select("bloom_level, is_correct")
        .eq("attempt_id", attempt_id);
      const counts: Record<string, { correct: number; total: number }> = {};
      ((ans || []) as Array<{ bloom_level: string; is_correct: boolean | null }>).forEach((a) => {
        if (!counts[a.bloom_level]) counts[a.bloom_level] = { correct: 0, total: 0 };
        counts[a.bloom_level].total += 1;
        if (a.is_correct) counts[a.bloom_level].correct += 1;
      });
      bloomBreakdown = BLOOM_LEVELS
        .filter((l) => counts[l] && counts[l].total > 0)
        .map((l) => ({ bloom_level: l, correct: counts[l].correct, total: counts[l].total }));
    } else {
      raw_score = Number(body.raw_score);
      max_score = Number(body.max_score);
      if (!Number.isFinite(raw_score) || !Number.isFinite(max_score) || max_score <= 0) {
        return NextResponse.json({ error: "Provide attempt_id or raw_score+max_score." }, { status: 400 });
      }
    }

    if (max_score <= 0) {
      return NextResponse.json({ error: "Cannot predict rank with zero questions." }, { status: 400 });
    }
    const scorePct = Math.max(0, Math.min(100, (raw_score / max_score) * 100));
    const { percentile, air, total } = pctToAir(scorePct, exam_type);
    const { airLow, airHigh, marginPct } = airBand(scorePct, max_score, exam_type);

    // Best-effort: ask AI for 3 directives. If it fails we still return the rank.
    let recommendations: string[] = [];
    let weakest_areas: string[] = [];
    try {
      if (bloomBreakdown.length > 0) {
        const sortedByPct = [...bloomBreakdown].sort((a, b) => (a.correct / a.total) - (b.correct / b.total));
        weakest_areas = sortedByPct.slice(0, 2).map((b) => b.bloom_level);
        const userPrompt = `Exam: ${EXAM_BASELINES[exam_type].label}
Raw score: ${raw_score}/${max_score} (${scorePct.toFixed(1)}%)
Predicted percentile: ${percentile.toFixed(1)}
Bloom breakdown:
${bloomBreakdown.map((b) => `- ${b.bloom_level}: ${b.correct}/${b.total}`).join("\n")}

Return the 3-recommendation JSON.`;
        const raw = await groqJSON(SYSTEM, userPrompt);
        const arr = (raw as { recommendations?: unknown }).recommendations;
        if (Array.isArray(arr)) {
          recommendations = (arr as unknown[]).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 3);
        }
      }
    } catch { /* keep recommendations empty */ }

    // Persist.
    const { data: row, error: insErr } = await sb
      .from("mock_rank_predictions")
      .insert({
        user_id: user.id,
        attempt_id,
        exam_type,
        raw_score,
        max_score,
        percentile,
        predicted_air: air,
        total_candidates: total,
        target_air,
        gap_marks_needed: null,  // future: solve the inverse problem if target_air is set
        weakest_areas,
        recommendations,
      })
      .select("id, created_at")
      .single();
    if (insErr) {
      // Don't 500 if persistence fails — still return the prediction so the user sees something.
      return NextResponse.json({
        ok: true,
        exam_type,
        raw_score,
        max_score,
        percentile,
        predicted_air: air,
        air_low: airLow,
        air_high: airHigh,
        score_margin_pp: Number(marginPct.toFixed(2)),
        total_candidates: total,
        recommendations,
        warning: insErr.message,
      });
    }

    return NextResponse.json({
      ok: true,
      id: row.id,
      created_at: row.created_at,
      exam_type,
      raw_score,
      max_score,
      percentile,
      predicted_air: air,
      air_low: airLow,
      air_high: airHigh,
      score_margin_pp: Number(marginPct.toFixed(2)),
      total_candidates: total,
      recommendations,
      weakest_areas,
      // Surface the model name + assumptions so the UI can display them
      // honestly rather than presenting AIR as if it were precise.
      model: {
        name: "Normal-CDF cohort approximation",
        version: "1",
        assumptions: [
          `Cohort score distribution approximated as Normal(mean=${EXAM_BASELINES[exam_type].meanPct}%, stddev=${EXAM_BASELINES[exam_type].stdDevPct}%).`,
          `Cohort size used: ${EXAM_BASELINES[exam_type].totalCandidates.toLocaleString()} candidates.`,
          "AIR derived as (1 − percentile) × cohort size; floor of 1.",
          "95% band combines binomial sampling error of the test score with a ±2pp baseline-drift allowance.",
          "Real outcomes also depend on paper difficulty calibration, section-wise normalization, and tie-breaking — none modelled here.",
        ],
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Rank prediction failed" },
      { status: 500 }
    );
  }
}
