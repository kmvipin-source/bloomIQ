import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import {
  computeScore,
  computeBestYou,
  predictRankAndColleges,
  type ScorableAnswer,
} from "@/lib/bloomiqScore";
import { BLOOM_LEVELS, type BloomLevel } from "@/lib/bloom";
import { type CalibrationQuestion } from "@/lib/calibrationGenerator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/student/calibration/submit
 *
 * Receives the answered calibration session, scores it, persists the
 * result (calibrations + calibration_responses + bloomiq_scores), and
 * returns the Future You payload the reveal screen consumes.
 *
 * Body shape:
 *   {
 *     session_id: string,
 *     exam_goal: string | null,
 *     groq_model: string,
 *     responses: Array<{
 *       question: CalibrationQuestion,
 *       selected_index: number | null,
 *       time_taken_seconds: number
 *     }>
 *   }
 *
 * Why we accept the question objects in the body: the /start endpoint
 * is stateless (no DB row written); the client returns the questions it
 * was shown so we can score and log them. The only trust risk is a user
 * faking their own score — they only fool themselves.
 */

type SubmitBody = {
  session_id?: string;
  exam_goal?: string | null;
  groq_model?: string;
  total_seconds?: number;
  responses?: Array<{
    question?: Partial<CalibrationQuestion>;
    selected_index?: number | null;
    time_taken_seconds?: number;
  }>;
};

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user }, error: userErr } = await sb.auth.getUser();
    if (userErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as SubmitBody;
    if (!body.session_id || !Array.isArray(body.responses) || body.responses.length === 0) {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }

    // Normalise + validate the responses. We tolerate a missing answer
    // (counts as wrong) but require valid Bloom levels and indices.
    const scorable: ScorableAnswer[] = [];
    const responseRows: Array<{
      user_id: string;
      session_id: string;
      question_index: number;
      question_stem: string;
      options: string[];
      correct_index: number;
      selected_index: number | null;
      is_correct: boolean | null;
      bloom_level: BloomLevel;
      topic: string | null;
      benchmark_seconds: number | null;
      time_taken_seconds: number | null;
    }> = [];

    body.responses.forEach((r) => {
      const q = r.question;
      if (!q || typeof q.stem !== "string" || !Array.isArray(q.options) || q.options.length !== 4) return;
      if (typeof q.correct_index !== "number" || q.correct_index < 0 || q.correct_index > 3) return;
      if (!q.bloom_level || !BLOOM_LEVELS.includes(q.bloom_level as BloomLevel)) return;

      const sel = typeof r.selected_index === "number" && r.selected_index >= 0 && r.selected_index <= 3
        ? r.selected_index
        : null;
      const correct = sel !== null ? sel === q.correct_index : false;
      const bench = typeof q.benchmark_seconds === "number" ? q.benchmark_seconds : 60;
      const taken = typeof r.time_taken_seconds === "number" && r.time_taken_seconds > 0
        ? Math.round(r.time_taken_seconds)
        : null;

      scorable.push({
        bloom_level: q.bloom_level as BloomLevel,
        is_correct: correct,
        benchmark_seconds: bench,
        time_taken_seconds: taken ?? undefined,
      });

      // Use the running length of accepted rows as the question_index.
      // Using the loop index of body.responses instead would leave gaps
      // when an entry fails validation above, which breaks any analytics
      // keyed on (session_id, question_index) needing a dense sequence.
      responseRows.push({
        user_id: user.id,
        session_id: body.session_id!,
        question_index: responseRows.length,
        question_stem: q.stem,
        options: q.options as string[],
        correct_index: q.correct_index,
        selected_index: sel,
        is_correct: sel !== null ? correct : null,
        bloom_level: q.bloom_level as BloomLevel,
        topic: typeof q.topic === "string" ? q.topic : null,
        benchmark_seconds: bench,
        time_taken_seconds: taken,
      });
    });

    if (scorable.length === 0) {
      return NextResponse.json({ error: "No valid responses" }, { status: 400 });
    }

    // Score it.
    const computed = computeScore(scorable);
    const examGoal = body.exam_goal ?? null;
    const prediction = predictRankAndColleges(computed.score, examGoal);
    const bestYou = computeBestYou(computed, examGoal);

    // Persist. Service-role client because we're writing across three
    // tables and want a single trust boundary; RLS would force us to
    // serialise round-trips through the user-token client.
    const admin = supabaseAdmin();

    // Upsert the calibration snapshot (latest result per user).
    const { error: calErr } = await admin
      .from("calibrations")
      .upsert({
        user_id: user.id,
        exam_goal: examGoal,
        initial_score: computed.score,
        initial_percentile: computed.percentile,
        initial_predicted_rank: prediction.predicted_rank,
        bloom_breakdown: computed.bloom_breakdown,
        best_you_score: bestYou.score,
        best_you_predicted_rank: bestYou.prediction.predicted_rank,
        weakest_bloom_levels: computed.weakest_bloom_levels,
        total_seconds: typeof body.total_seconds === "number" ? Math.round(body.total_seconds) : null,
        completed_at: new Date().toISOString(),
        algo_version: "v1.0",
        groq_model: body.groq_model ?? null,
      }, { onConflict: "user_id" });
    if (calErr) {
      return NextResponse.json({ error: `calibration save failed: ${calErr.message}` }, { status: 500 });
    }

    // Per-question log (append-only).
    if (responseRows.length > 0) {
      const { error: respErr } = await admin
        .from("calibration_responses")
        .insert(responseRows);
      if (respErr) {
        // Non-fatal: the calibration row is the source of truth. Log
        // and continue so the user gets their reveal.
        console.warn("calibration_responses insert failed:", respErr.message);
      }
    }

    // First entry in the time-series.
    const { error: scoreErr } = await admin
      .from("bloomiq_scores")
      .insert({
        user_id: user.id,
        score: computed.score,
        percentile: computed.percentile,
        predicted_rank: prediction.predicted_rank,
        bloom_breakdown: computed.bloom_breakdown,
        trigger_event: "calibration",
      });
    if (scoreErr) {
      return NextResponse.json({ error: `score save failed: ${scoreErr.message}` }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      score: computed.score,
      percentile: computed.percentile,
      bloom_breakdown: computed.bloom_breakdown,
      weakest_bloom_levels: computed.weakest_bloom_levels,
      prediction,
      best_you: bestYou,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}
