import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { predictRankAndColleges } from "@/lib/bloomiqScore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/student/score
 *
 * Returns the caller's most recent BloomIQ Score with the day-over-day
 * delta and the latest calibration's Future You context (so the score
 * badge can show "↑ 12 from yesterday" without a second round-trip).
 *
 * Response shape:
 *   {
 *     ok: true,
 *     has_calibration: boolean,
 *     score: number | null,
 *     percentile: number | null,
 *     predicted_rank: number | null,
 *     rank_label: string | null,
 *     trend: { delta: number, since: "yesterday" | "first_calibration" | null },
 *     bloom_breakdown: Record<BloomLevel, number>,
 *     calibration: { ...latest calibration row ... } | null
 *   }
 *
 * When the user has no calibration yet, returns has_calibration:false and
 * the badge renders the "Get your BloomIQ →" CTA.
 */
export async function GET(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user }, error: userErr } = await sb.auth.getUser();
    if (userErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const admin = supabaseAdmin();

    // Latest calibration snapshot (drives the Future You context).
    const { data: calRaw } = await admin
      .from("calibrations")
      .select(
        "exam_goal, initial_score, initial_percentile, initial_predicted_rank, " +
        "bloom_breakdown, best_you_score, best_you_predicted_rank, " +
        "weakest_bloom_levels, completed_at, algo_version"
      )
      .eq("user_id", user.id)
      .maybeSingle();

    type CalRow = {
      exam_goal: string | null;
      initial_score: number;
      initial_percentile: number | null;
      initial_predicted_rank: number | null;
      bloom_breakdown: Record<string, number>;
      best_you_score: number | null;
      best_you_predicted_rank: number | null;
      weakest_bloom_levels: string[];
      completed_at: string;
      algo_version: string;
    };
    const cal = calRaw as unknown as CalRow | null;

    // Fetch the user's current exam_goal from profiles. If this disagrees
    // with cal.exam_goal, the calibration is stale and the UI should
    // prompt a re-calibration banner.
    const { data: profRow } = await admin
      .from("profiles")
      .select("exam_goal")
      .eq("id", user.id)
      .maybeSingle();
    const currentExamGoal = (profRow as { exam_goal?: string | null } | null)?.exam_goal ?? null;

    if (!cal) {
      return NextResponse.json({
        ok: true,
        has_calibration: false,
        score: null,
        percentile: null,
        predicted_rank: null,
        rank_label: null,
        current_exam_goal: currentExamGoal,
        is_stale: false,
        trend: { delta: 0, since: null },
        bloom_breakdown: {},
        calibration: null,
      });
    }

    // Latest two scores in the time-series — newest first. The second
    // row (if present) drives the day-over-day delta on the badge.
    const { data: scores } = await admin
      .from("bloomiq_scores")
      .select("score, percentile, predicted_rank, bloom_breakdown, calculated_at, trigger_event")
      .eq("user_id", user.id)
      .order("calculated_at", { ascending: false })
      .limit(2);

    const latest = scores && scores.length > 0 ? scores[0] : null;
    const previous = scores && scores.length > 1 ? scores[1] : null;

    const score = latest?.score ?? cal.initial_score;
    const percentile = latest?.percentile ?? cal.initial_percentile ?? null;
    const predicted_rank = latest?.predicted_rank ?? cal.initial_predicted_rank ?? null;
    const breakdown = (latest?.bloom_breakdown ?? cal.bloom_breakdown) as Record<string, number>;

    const prediction = predictRankAndColleges(score, cal.exam_goal);

    const trend = previous
      ? { delta: score - previous.score, since: "yesterday" as const }
      : { delta: 0, since: "first_calibration" as const };

    return NextResponse.json({
      ok: true,
      has_calibration: true,
      score,
      percentile,
      predicted_rank,
      rank_label: prediction.rank_label,
      colleges: prediction.colleges,
      trend,
      bloom_breakdown: breakdown,
      calibration: {
        exam_goal: cal.exam_goal,
        initial_score: cal.initial_score,
        best_you_score: cal.best_you_score,
        best_you_predicted_rank: cal.best_you_predicted_rank,
        weakest_bloom_levels: cal.weakest_bloom_levels,
        completed_at: cal.completed_at,
      },
      current_exam_goal: currentExamGoal,
      is_stale: !!(currentExamGoal && cal.exam_goal && currentExamGoal !== cal.exam_goal),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}
