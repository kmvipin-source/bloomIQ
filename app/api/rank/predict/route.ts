import { NextResponse } from "next/server";
import { groqJSON } from "@/lib/groq";
import { BLOOM_LEVELS, type BloomLevel } from "@/lib/bloom";
import { getBearer, supabaseServer } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";
import { consumeLifetimeUse } from "@/lib/freeQuota";
import {
  classifyQuizForRankPrediction,
  validateExamType,
  validateScorePair,
  type RankExamType,
} from "@/lib/rankPredictorEligibility";

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
//
// Foolproofing (2026-05-13)
// -------------------------
// Until today, a student could take a Java quiz, hit "Predict my rank → CAT"
// and BloomIQ would return a CAT All-India Rank. That's nonsense. The route
// now:
//   1. Strictly validates exam_type instead of silently coercing unknown
//      values to JEE_MAIN.
//   2. Strictly validates the score pair (no NaN/Infinity/negative/over-max).
//   3. When attempt_id is supplied, joins the quiz's topic/name/topic_family
//      and runs lib/rankPredictorEligibility.classifyQuizForRankPrediction.
//      If the quiz is clearly a corporate / programming skill (Java, AWS,
//      Kubernetes, etc.) → refuse with HTTP 422 and a clear message.
//   4. If the topic strongly suggests a different rank-baseline exam than
//      what the caller asked for (e.g. quiz topic = "JEE Physics" but
//      exam_type = "CAT") → snap exam_type to the topic-matched value and
//      surface exam_type_override so the UI can explain.
// =============================================================================

// Re-export the type from the shared module so existing code in this file
// keeps reading naturally. Same four values as before.
type ExamType = RankExamType;

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

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // Fetch the student's exam_goal so the classifier can fall back to it
    // when the quiz's topic/name don't reveal an exam. Added 2026-05-14
    // for the "NEET student practising 'blood group'" case. Cheap single-row
    // read; tolerated if missing (we just pass null).
    const { data: profRow } = await sb
      .from("profiles")
      .select("exam_goal")
      .eq("id", user.id)
      .maybeSingle();
    const studentExamGoal: string | null =
      (profRow as { exam_goal?: string | null } | null)?.exam_goal ?? null;
    const rate = checkRateLimit(user.id, "rank.predict", { capacity: 10, refillPerHour: 20 });
    if (!rate.allowed) return NextResponse.json({ error: "Too many requests.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } });
    const ltGate = await consumeLifetimeUse(user.id, "rank");
    if (!ltGate.allowed) return NextResponse.json({ error: ltGate.reason, code: "free_lifetime_used" }, { status: 402 });

    const body = await req.json().catch(() => ({}));

    // ── 1. Strict exam_type validation. Previously: silent fallback to
    //      JEE_MAIN on any unknown value. Now: 400 with a clear message,
    //      so a typo in the client doesn't ship a JEE prediction the
    //      student never asked for. Empty/undefined → CUSTOM (generic
    //      mock cohort) so the user-facing form keeps working without
    //      forcing every caller to pick a value.
    const examVal = validateExamType(body.exam_type);
    if (examVal.ok !== true) {
      return NextResponse.json({ error: examVal.error, code: "bad_exam_type" }, { status: 400 });
    }
    let exam_type: ExamType = examVal.value;
    // Will be set later when we auto-snap to a topic-matched exam.
    let exam_type_override: { from: ExamType; to: ExamType; reason: string } | null = null;
    // Eligibility advisory — surfaced to the UI so curious students can
    // see WHY their pick was accepted, snapped, or refused.
    let eligibility_note: string | null = null;
    const target_air: number | null = Number.isFinite(Number(body.target_air)) ? Number(body.target_air) : null;

    let raw_score: number;
    let max_score: number;
    let attempt_id: string | null = null;
    let bloomBreakdown: Array<{ bloom_level: BloomLevel; correct: number; total: number }> = [];

    if (body.attempt_id) {
      attempt_id = String(body.attempt_id);
      // ── 2. Join quizzes(subject, name, topic_family) so we can run the
      //      eligibility classifier. Older code only loaded score+total
      //      and trusted whatever exam_type the client sent — that's how
      //      "Java quiz → CAT rank" slipped through.
      //
      //      Column note: the quizzes table stores the user-supplied topic
      //      as `subject` (migration 04), not `topic`. (`topic` only lives
      //      on `question_bank` rows.) The classifier tokenises whatever
      //      labels we hand it, so subject + name + topic_family covers
      //      every place an exam-or-skill name could surface.
      const { data: att, error: attErr } = await sb
        .from("quiz_attempts")
        .select("id, student_id, score, total, quiz:quizzes(subject, name, topic_family)")
        .eq("id", attempt_id)
        .single();
      if (attErr || !att) return NextResponse.json({ error: "Attempt not found" }, { status: 404 });
      if (att.student_id !== user.id) return NextResponse.json({ error: "Not yours" }, { status: 403 });
      raw_score = att.score || 0;
      max_score = att.total || 0;

      // ── 3. Classify the quiz. The single source of truth lives in
      //      lib/rankPredictorEligibility — the results page UI uses the
      //      same function to decide whether to even render the button.
      //      Supabase's typed select returns the relation as an array OR
      //      an object depending on inference; normalise to a flat shape.
      const quizRel = (att as { quiz: unknown }).quiz;
      type QuizMeta = { subject: string | null; name: string | null; topic_family: string | null };
      const quizMeta: QuizMeta =
        Array.isArray(quizRel)
          ? (quizRel[0] as QuizMeta) ?? { subject: null, name: null, topic_family: null }
          : (quizRel as QuizMeta | null) ?? { subject: null, name: null, topic_family: null };

      const eligibility = classifyQuizForRankPrediction({
        topic: quizMeta.subject,
        name: quizMeta.name,
        topicFamily: quizMeta.topic_family,
        studentExamGoal,
      });

      // ── Allowlist gate (2026-05-13 evening): only matches_known_exam
      //    (JEE/NEET/CAT) and competitive_exam_other (GMAT/GATE/UPSC/...)
      //    are eligible. corporate_skill AND generic both refuse. This is
      //    the inverted-default design — no token list to maintain. Any
      //    topic that doesn't positively match an exam falls through to
      //    refusal automatically.
      const isExamMock =
        eligibility.verdict === "matches_known_exam" ||
        eligibility.verdict === "competitive_exam_other";
      if (!isExamMock) {
        return NextResponse.json(
          {
            error: `This test doesn't look like a competitive-exam mock, so we can't predict an All-India Rank for it. The Mock Rank Predictor only works for JEE / NEET / CAT / GMAT / GATE / UPSC and similar exam mocks. If you want a rank estimate against an exam cohort, type a score directly on /student/rank.`,
            code: "not_a_competitive_exam_mock",
            quiz: { subject: quizMeta.subject, name: quizMeta.name },
            eligibility,
          },
          { status: 422 }
        );
      }

      if (eligibility.verdict === "matches_known_exam") {
        // The quiz topic itself names a rank-baseline exam (e.g., "CAT mock 1").
        // If the caller picked a *different* exam_type, snap to the topic's
        // exam — the student is much more likely to have meant "predict
        // against the same exam this quiz is for" than to have intentionally
        // crossed wires. Surface the override so the UI can explain.
        if (exam_type !== eligibility.suggestedExamType) {
          exam_type_override = {
            from: exam_type,
            to: eligibility.suggestedExamType,
            reason: `Quiz topic matched "${eligibility.matchedToken}", so the rank was computed against the ${eligibility.suggestedExamType} cohort instead of ${exam_type}.`,
          };
          exam_type = eligibility.suggestedExamType;
        }
        eligibility_note = eligibility.reason;
      } else if (eligibility.verdict === "competitive_exam_other") {
        // GMAT / GATE / etc. — we don't have a rank baseline for these.
        // Force CUSTOM unless the caller explicitly picked one of the
        // four supported exams; CUSTOM's generic cohort is more honest
        // than pretending a GATE score maps to a JEE cohort.
        if (exam_type === "CUSTOM") {
          eligibility_note = eligibility.reason;
        } else {
          eligibility_note = `${eligibility.reason} Used ${exam_type} cohort as requested.`;
        }
      } else {
        // generic / academic-subject / unknown — allow with the user's pick.
        eligibility_note = eligibility.reason;
      }

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
      // Ad-hoc path (/student/rank form). The user is explicitly typing a
      // raw score + max_score against an explicitly-picked exam, so we
      // trust their exam_type choice — but still hard-validate the numbers.
      const scoreVal = validateScorePair(body.raw_score, body.max_score);
      if (scoreVal.ok !== true) {
        return NextResponse.json({ error: scoreVal.error, code: "bad_score_pair" }, { status: 400 });
      }
      raw_score = scoreVal.raw;
      max_score = scoreVal.max;
    }

    // Belt-and-braces clamp. validateScorePair already caught these for
    // the ad-hoc path; for the attempt path we re-check in case a corrupt
    // attempt row slips through.
    if (!Number.isFinite(raw_score) || !Number.isFinite(max_score)) {
      return NextResponse.json({ error: "Attempt has non-numeric score data — cannot predict rank." }, { status: 400 });
    }
    if (max_score <= 0) {
      return NextResponse.json({ error: "Cannot predict rank with zero questions." }, { status: 400 });
    }
    if (raw_score < 0 || raw_score > max_score) {
      return NextResponse.json({ error: `Score (${raw_score}/${max_score}) is out of range.` }, { status: 400 });
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
          // Cap per-item length so the LLM can't pad each bullet with
          // a 5000-char paragraph that pollutes mock_rank_predictions.
          // 280 chars is roughly the actionable-recommendation length.
          recommendations = (arr as unknown[])
            .map(String)
            .map((s) => s.trim().slice(0, 280))
            .filter(Boolean)
            .slice(0, 3);
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
        exam_type_override,
        eligibility_note,
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
      exam_type_override,
      eligibility_note,
      // Surface the model name + assumptions so the UI can display them
      // honestly rather than presenting AIR as if it were precise.
      model: {
        name: "Normal-CDF cohort approximation",
        version: "1",
        assumptions: [
          `Cohort score distribution approximated as Normal(mean=${EXAM_BASELINES[exam_type].meanPct}%, stddev=${EXAM_BASELINES[exam_type].stdDevPct}%).`,
          `Cohort size used: ${EXAM_BASELINES[exam_type].totalCandidates.toLocaleString()} candidates.`