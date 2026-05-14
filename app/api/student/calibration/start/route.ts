import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { generateCalibration } from "@/lib/calibrationGenerator";
import { consumeLifetimeUse } from "@/lib/freeQuota";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/student/calibration/start
 *
 * Generates a fresh 12-question Bloom-tagged calibration quiz tailored
 * to the caller's exam goal (read from profiles.exam_goal). Persists the
 * issued questions (incl. correct_index) into `calibration_sessions`
 * keyed by session_id + user_id, then returns the questions to the
 * client WITHOUT correct_index — /submit re-reads the server-trusted
 * answers from that table to score, ignoring whatever the client sends.
 *
 * Migration 82 added the calibration_sessions table specifically to
 * close the previous self-score forge (a tampered submit could declare
 * all answers correct and inflate bloomiq_scores up to 900).
 *
 * Auth: bearer token required.
 */
export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user }, error: userErr } = await sb.auth.getUser();
    if (userErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const gate = await consumeLifetimeUse(user.id, "bloom_score");
    if (!gate.allowed) {
      return NextResponse.json(
        { error: gate.reason, code: "free_lifetime_used" },
        { status: 402 }
      );
    }

    // Read exam goal from profiles via service-role to avoid the RLS race
    // we hit in /api/auth/me (same fix, same reason).
    const admin = supabaseAdmin();
    const { data: prof } = await admin
      .from("profiles")
      .select("exam_goal")
      .eq("id", user.id)
      .maybeSingle();
    const examGoal = (prof as { exam_goal?: string | null } | null)?.exam_goal ?? null;

    const { questions, groq_model } = await generateCalibration(examGoal);

    // Persist the issued questions (incl. correct_index) so /submit can
    // score against server-trusted answers. The client gets the same
    // questions back MINUS correct_index — they're useless to the
    // calibration scorer because /submit reads from this table.
    const sessionId = randomUUID();
    const { error: persistErr } = await admin
      .from("calibration_sessions")
      .insert({
        session_id: sessionId,
        user_id: user.id,
        exam_goal: examGoal,
        groq_model,
        questions,
      });
    if (persistErr) {
      return NextResponse.json(
        { error: `Could not persist calibration session: ${persistErr.message}` },
        { status: 500 },
      );
    }

    // Strip correct_index from the client-bound payload. Client renders
    // the quiz from stem + options + bloom_level only.
    const clientQuestions = questions.map((q) => ({
      stem: q.stem,
      options: q.options,
      bloom_level: q.bloom_level,
      topic: q.topic,
      benchmark_seconds: q.benchmark_seconds,
    }));

    return NextResponse.json({
      ok: true,
      session_id: sessionId,
      exam_goal: examGoal,
      groq_model,
      questions: clientQuestions,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 502 }
    );
  }
}
