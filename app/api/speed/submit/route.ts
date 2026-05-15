import { NextResponse } from "next/server";
import { isBloomLevel, type BloomLevel } from "@/lib/bloom";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

// =============================================================================
// POST /api/speed/submit
// -----------------------------------------------------------------------------
// Body: {
//   session_id: string,             // server-issued; must match speed_sessions_issued row
//   topic: string,
//   answers: Array<{
//     idx: number,                  // index into the original issued question array
//     time_ms: number,
//     picked: number | null
//   }>
// }
//
// Server re-loads the issued questions (incl. stem / options / correct_index /
// bloom_level) from speed_sessions_issued (migration 87) by session_id, then
// scores against THAT — ignores any question object the client returns. This
// blocks the previous fabrication path where a client could send arbitrary
// correct_index values.
// =============================================================================

type IssuedQ = {
  stem: string;
  options: string[];
  correct_index: number;
  bloom_level: BloomLevel;
  explanation?: string | null;
};

type ServerQ = {
  stem: string;
  options: string[];
  correct_index: number;
  bloom_level: BloomLevel;
  target_ms: number;
  time_ms: number;
  picked: number;
  explanation: string | null;
};

type Quadrant = {
  fast_right: number;
  slow_right: number;
  fast_wrong: number;
  slow_wrong: number;
};

// Same target_ms map as /start. MUST stay in sync — the JSON shape
// exchanged between /start and the client carries target_ms (the
// "examiner-pace budget" the on-screen clock runs against) but
// /submit re-derives it server-side from the issued bloom_level so a
// tampered client can't game its own quadrant verdict. If these two
// constants drift, students see a "Slow & wrong" verdict for answers
// they completed within their on-screen clock — exactly the user-
// facing bug the audit caught on 2026-05-15.
//
// Source of truth: app/api/speed/start/route.ts:TARGET_MS.
const TARGET_MS: Record<BloomLevel, number> = {
  remember: 30_000,
  understand: 45_000,
  apply: 75_000,
  analyze: 90_000,
  evaluate: 90_000,
  create: 120_000,
};

function computeQuadrant(qs: ServerQ[]): Quadrant {
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
    const sessionId: string = String(body.session_id || "").trim();
    if (!sessionId) {
      return NextResponse.json({ error: "session_id is required" }, { status: 400 });
    }
    const topic: string = String(body.topic || "").slice(0, 200);
    const ansRaw = Array.isArray(body.answers) ? (body.answers as unknown[]) : [];

    // Re-load server-trusted issued questions. Must belong to the caller
    // and be recent (6h TTL — abandoned sessions can't be revived later
    // with re-mined questions).
    const admin = supabaseAdmin();
    const { data: sessionRow, error: sessionErr } = await admin
      .from("speed_sessions_issued")
      .select("session_id, user_id, questions, created_at")
      .eq("session_id", sessionId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (sessionErr) {
      return NextResponse.json({ error: `Session lookup failed: ${sessionErr.message}` }, { status: 500 });
    }
    if (!sessionRow) {
      return NextResponse.json({ error: "Unknown or foreign speed session" }, { status: 404 });
    }
    const ageMs = Date.now() - new Date((sessionRow as { created_at: string }).created_at).getTime();
    if (ageMs > 6 * 3600 * 1000) {
      return NextResponse.json({ error: "Speed session expired. Please restart." }, { status: 410 });
    }
    const issued = (sessionRow as { questions: IssuedQ[] }).questions;

    // Map answers by idx — client may not return one entry per issued
    // question (skip/timeout case). We rebuild the per-question record
    // from the server's issued list, defaulting picked=-1 / time_ms=target
    // when missing so scoring still counts them as wrong-and-slow.
    const ansByIdx = new Map<number, { picked: number; time_ms: number }>();
    for (const a of ansRaw as Array<Record<string, unknown>>) {
      const idx = Number(a.idx);
      if (!Number.isInteger(idx) || idx < 0 || idx >= issued.length) continue;
      const picked = Number(a.picked);
      const time_ms = Math.max(0, Math.min(600_000, Number(a.time_ms) || 0));
      ansByIdx.set(idx, {
        picked: Number.isInteger(picked) && picked >= 0 && picked <= 3 ? picked : -1,
        time_ms,
      });
    }

    const questions: ServerQ[] = issued.map((q, idx) => {
      // Use the loop index, not Array.indexOf(q) — indexOf returns the
      // first matching object reference, so two duplicate issued
      // questions (rare after dedup, but possible after a JSONB round-
      // trip in tests) would silently mis-align answers to the wrong
      // question. The loop index is the issued ordering by construction.
      const a = ansByIdx.get(idx) ?? { picked: -1, time_ms: 0 };
      const bl = (typeof q.bloom_level === "string" && isBloomLevel(q.bloom_level) ? q.bloom_level : "remember") as BloomLevel;
      return {
        stem: q.stem,
        options: q.options,
        correct_index: q.correct_index,
        bloom_level: bl,
        target_ms: TARGET_MS[bl],
        time_ms: a.time_ms,
        picked: a.picked,
        explanation: q.explanation ?? null,
      };
    });

    if (questions.length === 0) {
      return NextResponse.json({ error: "Issued question set is empty" }, { status: 400 });
    }

    const correct_count = questions.reduce((acc, q) => acc + (q.picked === q.correct_index ? 1 : 0), 0);
    const total_time_ms = questions.reduce((acc, q) => acc + q.time_ms, 0);
    const quad = computeQuadrant(questions);

    // Persist the final scored session.
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

    // One-shot — burn the issued row.
    await admin.from("speed_sessions_issued").delete().eq("session_id", sessionId);

    const total = questions.length;
    const verdict = buildVerdict(quad, total);

    // Include the full per-question reveal in the response so the
    // client can render its post-submit explanation screen WITHOUT
    // ever having had correct_index in its session memory. This is the
    // only place the client receives the correct answers.
    return NextResponse.json({
      ok: true,
      id: row.id,
      created_at: row.created_at,
      total_questions: total,
      correct_count,
      total_time_ms,
      quadrant: quad,
      verdict,
      questions: questions.map((q) => ({
        stem: q.stem,
        options: q.options,
        correct_index: q.correct_index,
        bloom_level: q.bloom_level,
        target_ms: q.target_ms,
        time_ms: q.time_ms,
        picked: q.picked,
        was_right: q.picked === q.correct_index,
        explanation: q.explanation,
      })),
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
