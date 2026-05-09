import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { requireFeature } from "@/lib/featureAccess.server";

export const runtime = "nodejs";

// =============================================================================
// GET /api/student/question-benchmarks?attempt_id=<uuid>
// -----------------------------------------------------------------------------
// Returns, for each question in the student's attempt:
//   - their own time_taken_ms
//   - is_correct + bloom_level (so the UI can render badges without a 2nd query)
//   - the cohort median time_taken_ms across ALL students who have ever
//     answered this question (filtered to plausible values 1..600,000 ms)
//   - n_samples backing the median
//   - speed_label: 'fast' | 'on_pace' | 'slow' relative to median, or 'no_benchmark'
//     when n_samples is too low to be meaningful
//
// Why server-side: the cohort median needs to scan attempt_answers across
// users, which RLS rightly forbids for the student's own session. The route
// authenticates the caller, validates that they own the attempt, then uses
// the service-role client to compute the cross-user aggregate. The student
// only ever sees aggregated numbers — no other student's identity leaks.
// =============================================================================

const MIN_SAMPLES_FOR_BENCHMARK = 5; // below this, percentiles are noise
const SLOW_THRESHOLD = 1.5;           // > median × 1.5  → "slow"
const FAST_THRESHOLD = 0.5;           // < median × 0.5  → "fast"
const OUTLIER_FLOOR_MS = 1_000;       // <1s likely a misclick / fast nav
const OUTLIER_CEILING_MS = 600_000;   // >10min likely a paused tab

type SpeedLabel = "fast" | "on_pace" | "slow" | "no_benchmark" | "no_data";

type BenchmarkRow = {
  question_id: string;
  position: number;
  is_correct: boolean | null;
  bloom_level: string | null;
  your_ms: number | null;
  median_ms: number | null;
  n_samples: number;
  speed_label: SpeedLabel;
};

function classify(yourMs: number | null, medianMs: number | null, n: number): SpeedLabel {
  if (yourMs === null) return "no_data";
  if (medianMs === null || n < MIN_SAMPLES_FOR_BENCHMARK) return "no_benchmark";
  if (yourMs >= medianMs * SLOW_THRESHOLD) return "slow";
  if (yourMs <= medianMs * FAST_THRESHOLD) return "fast";
  return "on_pace";
}

export async function GET(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const attemptId = url.searchParams.get("attempt_id");
    if (!attemptId) {
      return NextResponse.json({ error: "attempt_id is required" }, { status: 400 });
    }

    // Feature gate is evaluated below — but we DON'T 403 if locked.
    // Per-question own-data (your time, bloom level, correct/wrong) is
    // always returned so non-paying students still see meaningful info
    // on their results page. Only the cohort-comparison fields are
    // gated.
    const gate = await requireFeature(user.id, "cohort_benchmarks");
    const benchmarkAllowed = gate.allowed;

    // Step 1 — authorize: the requester must own this attempt.
    const { data: attempt, error: attErr } = await sb
      .from("quiz_attempts")
      .select("id, student_id")
      .eq("id", attemptId)
      .single();
    if (attErr || !attempt) {
      return NextResponse.json({ error: "Attempt not found" }, { status: 404 });
    }
    if (attempt.student_id !== user.id) {
      return NextResponse.json({ error: "Not your attempt" }, { status: 403 });
    }

    // Step 2 — pull the student's per-question rows + the question's
    // position within the quiz so the UI can render Q1, Q2, ... in order.
    // Use admin client throughout the rest so we can also aggregate across
    // the cohort below in a single round-trip plan.
    const admin = supabaseAdmin();

    const { data: myRows, error: myErr } = await admin
      .from("attempt_answers")
      .select("question_id, is_correct, bloom_level, time_taken_ms")
      .eq("attempt_id", attemptId);
    if (myErr) {
      return NextResponse.json({ error: myErr.message }, { status: 500 });
    }
    if (!myRows || myRows.length === 0) {
      return NextResponse.json({ questions: [], message: "No answers recorded for this attempt." });
    }

    const questionIds = myRows.map((r) => r.question_id as string);

    // Step 3 — fetch quiz_questions to recover the in-quiz position for
    // each question (so the UI can show "Q3" not just a uuid).
    const { data: quizQs, error: qqErr } = await admin
      .from("quiz_questions")
      .select("question_id, position, quiz_id")
      .in("question_id", questionIds);
    if (qqErr) {
      return NextResponse.json({ error: qqErr.message }, { status: 500 });
    }
    // A question can in theory live in multiple quizzes; pick the position
    // belonging to THIS attempt's quiz.
    const { data: thisAttemptQuiz } = await admin
      .from("quiz_attempts")
      .select("quiz_id")
      .eq("id", attemptId)
      .single();
    const thisQuizId = thisAttemptQuiz?.quiz_id;
    const positionByQid = new Map<string, number>();
    for (const r of quizQs || []) {
      if (r.quiz_id === thisQuizId) positionByQid.set(r.question_id as string, r.position as number);
    }

    // Step 4 — cohort medians. Skipped entirely for non-entitled users
    // so they don't pay the aggregation cost they can't see anyway.
    const cohortByQid = new Map<string, number[]>();
    if (benchmarkAllowed) {
      const { data: cohortRows, error: cohortErr } = await admin
        .from("attempt_answers")
        .select("question_id, time_taken_ms")
        .in("question_id", questionIds)
        .not("time_taken_ms", "is", null)
        .gte("time_taken_ms", OUTLIER_FLOOR_MS)
        .lte("time_taken_ms", OUTLIER_CEILING_MS);
      if (cohortErr) {
        return NextResponse.json({ error: cohortErr.message }, { status: 500 });
      }
      for (const r of cohortRows || []) {
        const arr = cohortByQid.get(r.question_id as string) ?? [];
        arr.push(r.time_taken_ms as number);
        cohortByQid.set(r.question_id as string, arr);
      }
    }

    function medianOf(arr: number[]): number {
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length % 2
        ? sorted[mid]
        : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    }

    const result: BenchmarkRow[] = myRows
      .map((r) => {
        const qid = r.question_id as string;
        const yourMs = (r.time_taken_ms as number | null) ?? null;
        const cohortValues = cohortByQid.get(qid) || [];
        const n = cohortValues.length;
        const medianMs = n > 0 ? medianOf(cohortValues) : null;
        return {
          question_id: qid,
          position: positionByQid.get(qid) ?? 0,
          is_correct: r.is_correct as boolean | null,
          bloom_level: r.bloom_level as string | null,
          your_ms: yourMs,
          median_ms: n >= MIN_SAMPLES_FOR_BENCHMARK ? medianMs : null,
          n_samples: n,
          speed_label: classify(yourMs, medianMs, n),
        };
      })
      .sort((a, b) => a.position - b.position);

    // Roll-up: median across questions where we DO have a benchmark, so the
    // UI can show "you were typically X% slower than the median solver".
    const compared = result.filter((r) => r.your_ms !== null && r.median_ms !== null);
    const yourTotalMs = compared.reduce((s, r) => s + (r.your_ms || 0), 0);
    const medianTotalMs = compared.reduce((s, r) => s + (r.median_ms || 0), 0);
    const overall = compared.length > 0 ? {
      your_total_ms: yourTotalMs,
      median_total_ms: medianTotalMs,
      delta_pct: medianTotalMs > 0
        ? Math.round(((yourTotalMs - medianTotalMs) / medianTotalMs) * 100)
        : null,
      questions_with_benchmark: compared.length,
    } : null;

    return NextResponse.json({
      ok: true,
      questions: result,
      overall,
      benchmark_allowed: benchmarkAllowed,
      // When locked, surface what the student would need to upgrade to.
      // The UI uses this to render an upgrade chip on the cohort column.
      ...(benchmarkAllowed ? {} : {
        required_feature: "cohort_benchmarks",
        required_tier: gate.allowed ? null : (gate as unknown as { requiredTier: string | null }).requiredTier,
      }),
      thresholds: {
        min_samples: MIN_SAMPLES_FOR_BENCHMARK,
        fast_lt_factor: FAST_THRESHOLD,
        slow_gt_factor: SLOW_THRESHOLD,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to compute benchmarks" },
      { status: 500 }
    );
  }
}
