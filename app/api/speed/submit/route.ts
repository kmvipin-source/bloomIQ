import { NextResponse } from "next/server";
import { isBloomLevel, type BloomLevel } from "@/lib/bloom";
import { getBearer, supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

// =============================================================================
// POST /api/speed/submit
// -----------------------------------------------------------------------------
// Body: {
//   topic: string,
//   questions: Array<{
//     stem, options[4], correct_index, bloom_level, target_ms,
//     time_ms, picked, explanation?
//   }>
// }
//
// Computes the speed-accuracy quadrant counts and persists the session. The
// client could compute these locally, but we recompute server-side so the row
// is the source of truth (no way to fake a leaderboard / streak by editing
// the request).
// =============================================================================

type SubmitQ = {
  stem: string;
  options: string[];
  correct_index: number;
  bloom_level: string;
  target_ms: number;
  time_ms: number;
  picked: number;
  explanation?: string;
};

type Quadrant = {
  fast_right: number;
  slow_right: number;
  fast_wrong: number;
  slow_wrong: number;
};

function computeQuadrant(qs: SubmitQ[]): Quadrant {
  let fast_right = 0, slow_right = 0, fast_wrong = 0, slow_wrong = 0;
  for (const q of qs) {
    const right = q.picked === q.correct_index;
    const fast = q.time_ms <= q.target_ms;
    if (right && fast) fast_right++;
    else if (right && !fast) slow_right++;
    else if (!right && fast) fast_wrong++;
    else slow_wrong++;
  }
  return { fast_right, slow_right, fast_wrong, slow_wrong };
}

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const topic: string = String(body.topic || "").slice(0, 200);
    const qsRaw = Array.isArray(body.questions) ? (body.questions as unknown[]) : [];

    const questions: SubmitQ[] = qsRaw
      .map((q) => {
        const o = (q || {}) as Record<string, unknown>;
        const stem = String(o.stem || "").trim();
        const options = Array.isArray(o.options) ? (o.options as unknown[]).map(String) : [];
        const ci = Number(o.correct_index);
        const bl = String(o.bloom_level || "");
        const target_ms = Math.max(5_000, Math.min(300_000, Number(o.target_ms) || 60_000));
        const time_ms = Math.max(0, Math.min(600_000, Number(o.time_ms) || 0));
        const picked = Number(o.picked);
        if (!stem || options.length !== 4 || !Number.isInteger(ci) || ci < 0 || ci > 3) return null;
        if (!isBloomLevel(bl)) return null;
        if (!Number.isInteger(picked) || picked < 0 || picked > 3) {
          // Skipped/timeout: still record but mark wrong with a sentinel pick.
          return {
            stem, options, correct_index: ci, bloom_level: bl, target_ms, time_ms,
            picked: -1, explanation: typeof o.explanation === "string" ? o.explanation : undefined,
          } satisfies SubmitQ;
        }
        return {
          stem, options, correct_index: ci, bloom_level: bl, target_ms, time_ms, picked,
          explanation: typeof o.explanation === "string" ? o.explanation : undefined,
        } satisfies SubmitQ;
      })
      .filter((q): q is SubmitQ => q !== null);

    if (questions.length === 0) {
      return NextResponse.json({ error: "No valid questions in submission" }, { status: 400 });
    }

    const correct_count = questions.reduce((acc, q) => acc + (q.picked === q.correct_index ? 1 : 0), 0);
    const total_time_ms = questions.reduce((acc, q) => acc + q.time_ms, 0);
    const quad = computeQuadrant(questions);

    // Persist. We store the questions as jsonb so we don't need a separate
    // table for per-question rows.
    const { data: row, error: insErr } = await sb
      .from("speed_sessions")
      .insert({
        user_id: user.id,
        topic: topic || null,
        total_questions: questions.length,
        correct_count,
        fast_right_count: quad.fast_right,
        slow_right_count: quad.slow_right,
        fast_wrong_count: quad.fast_wrong,
        slow_wrong_count: quad.slow_wrong,
        total_time_ms,
        questions: questions.map((q) => ({
          stem: q.stem,
          options: q.options,
          correct_index: q.correct_index,
          bloom_level: q.bloom_level,
          target_ms: q.target_ms,
          time_ms: q.time_ms,
          picked: q.picked,
          was_right: q.picked === q.correct_index,
          explanation: q.explanation || null,
        })),
      })
      .select("id, created_at")
      .single();
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

    // Build the human-readable verdict the page renders into the celebratory card.
    const total = questions.length;
    const verdict = buildVerdict(quad, total);

    return NextResponse.json({
      ok: true,
      id: row.id,
      created_at: row.created_at,
      total_questions: total,
      correct_count,
      total_time_ms,
      quadrant: quad,
      verdict,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Submit failed" },
      { status: 500 }
    );
  }
}

function buildVerdict(q: Quadrant, total: number): { title: string; coaching: string } {
  const fastRightPct = total > 0 ? q.fast_right / total : 0;
  const slowRightPct = total > 0 ? q.slow_right / total : 0;
  const fastWrongPct = total > 0 ? q.fast_wrong / total : 0;
  if (fastRightPct >= 0.7) {
    return {
      title: "Sharpshooter",
      coaching: "You're fast and accurate — keep this pace and you'll finish exam papers with time to spare.",
    };
  }
  if (slowRightPct >= 0.4) {
    return {
      title: "Knower, not racer",
      coaching: "You're getting questions right but burning the clock. In the real exam each slow-but-right minute costs you a question you don't reach. Drill speed on the easier Bloom levels first.",
    };
  }
  if (fastWrongPct >= 0.3) {
    return {
      title: "Too quick on the trigger",
      coaching: "You're answering before you've fully read the question. Slow down on the first sentence — the trap is usually in the wording.",
    };
  }
  return {
    title: "Building exam stamina",
    coaching: "Mix of slow and wrong — you don't have firm hold of the material yet. Skip the timer in your next study round, master the topic, then come back to this trainer.",
  };
}
