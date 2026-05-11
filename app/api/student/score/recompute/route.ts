import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import {
  computeScore,
  predictRankAndColleges,
  type ScorableAnswer,
} from "@/lib/bloomiqScore";
import { BLOOM_LEVELS, type BloomLevel } from "@/lib/bloom";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/student/score/recompute
 *
 * Recomputes the caller's BloomIQ Score using:
 *   - their original calibration responses (anchor)
 *   - PLUS recent quiz attempt_answers (recency-weighted)
 *
 * Writes a new row to bloomiq_scores with trigger_event='quiz' (or
 * 'recompute' when called directly without a source quiz). The score
 * badge picks it up on next page load.
 *
 * Body shape (all optional):
 *   {
 *     trigger_event?: "quiz" | "drill" | "manual" | "recompute",
 *     source_id?: string  // e.g. quiz_attempts.id
 *   }
 *
 * Algorithm v1: combines all calibration_responses + the most recent 100
 * attempt_answers (where bloom_level is set), weighting recent answers
 * 1.5x. Designed to move the score visibly when a student actually
 * studies, but anchored enough that one bad quiz can't tank it.
 */

type RecomputeBody = {
  trigger_event?: "quiz" | "drill" | "manual" | "recompute";
  source_id?: string;
};

const RECENT_ANSWER_LIMIT = 100;
const RECENT_WEIGHT = 1.5; // recent attempt answers count 1.5x in scoring

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user }, error: userErr } = await sb.auth.getUser();
    if (userErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as RecomputeBody;
    const triggerEvent = body.trigger_event || "recompute";
    const sourceId = body.source_id || null;

    const admin = supabaseAdmin();

    // Need a calibration to anchor. Without one, recompute is a no-op
    // — the user has to do calibration first.
    const { data: cal } = await admin
      .from("calibrations")
      .select("exam_goal")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!cal) {
      return NextResponse.json(
        { error: "No calibration found — student must complete calibration first." },
        { status: 409 }
      );
    }

    // Pull calibration responses (the anchor signal).
    const { data: calResp } = await admin
      .from("calibration_responses")
      .select("bloom_level, is_correct, benchmark_seconds, time_taken_seconds")
      .eq("user_id", user.id);

    const calibrationAnswers: ScorableAnswer[] = (calResp || [])
      .filter((r) => r.is_correct !== null && BLOOM_LEVELS.includes(r.bloom_level as BloomLevel))
      .map((r) => ({
        bloom_level: r.bloom_level as BloomLevel,
        is_correct: !!r.is_correct,
        benchmark_seconds: r.benchmark_seconds ?? undefined,
        time_taken_seconds: r.time_taken_seconds ?? undefined,
      }));

    // Pull recent attempt answers — these capture how the student is
    // doing on real quizzes since calibration.
    const { data: recent } = await admin
      .from("attempt_answers")
      .select("is_correct, bloom_level")
      .eq("student_id", user.id)
      .not("bloom_level", "is", null)
      .order("id", { ascending: false })
      .limit(RECENT_ANSWER_LIMIT);

    const recentAnswers: ScorableAnswer[] = (recent || [])
      .filter((r) => BLOOM_LEVELS.includes((r as { bloom_level?: string }).bloom_level as BloomLevel))
      .map((r) => ({
        bloom_level: (r as { bloom_level: string }).bloom_level as BloomLevel,
        is_correct: !!(r as { is_correct?: boolean }).is_correct,
      }));

    // Apply recency weighting by duplicating recent rows. Crude but
    // transparent — easy to reason about and easy to tune later.
    //
    // Handles fractional weights properly: a RECENT_WEIGHT of 1.5
    // pushes one full copy of the recent set plus the first half of
    // it again, yielding a true 1.5x weighting rather than rounding
    // up to 2x (the previous Math.round had silently turned this into
    // a 2x weight, which didn't match the constant's documentation).
    const weightedRecent: ScorableAnswer[] = [];
    const intPart = Math.max(1, Math.floor(RECENT_WEIGHT));
    for (let i = 0; i < intPart; i += 1) weightedRecent.push(...recentAnswers);
    const fracPart = Math.max(0, RECENT_WEIGHT - intPart);
    const fracTake = Math.round(fracPart * recentAnswers.length);
    if (fracTake > 0) weightedRecent.push(...recentAnswers.slice(0, fracTake));

    const combined = [...calibrationAnswers, ...weightedRecent];
    if (combined.length === 0) {
      return NextResponse.json(
        { error: "No answers to score from." },
        { status: 409 }
      );
    }

    const computed = computeScore(combined);
    const prediction = predictRankAndColleges(computed.score, cal.exam_goal);

    const { error: insErr } = await admin
      .from("bloomiq_scores")
      .insert({
        user_id: user.id,
        score: computed.score,
        percentile: computed.percentile,
        predicted_rank: prediction.predicted_rank,
        bloom_breakdown: computed.bloom_breakdown,
        trigger_event: triggerEvent,
        source_id: sourceId,
      });
    if (insErr) {
      return NextResponse.json({ error: insErr.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      score: computed.score,
      percentile: computed.percentile,
      predicted_rank: prediction.predicted_rank,
      rank_label: prediction.rank_label,
      bloom_breakdown: computed.bloom_breakdown,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}
