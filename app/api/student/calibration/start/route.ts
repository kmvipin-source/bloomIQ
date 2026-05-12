import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { generateCalibration } from "@/lib/calibrationGenerator";
import { checkLifetimeUse, recordLifetimeUse } from "@/lib/freeQuota";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/student/calibration/start
 *
 * Generates a fresh 12-question Bloom-tagged calibration quiz tailored
 * to the caller's exam goal (read from profiles.exam_goal). Returns the
 * session_id and the questions WITH correct_index intact — we trust
 * the client because the user only hurts themselves by tampering, and
 * the simpler stateless flow avoids a DB round-trip per question.
 *
 * KNOWN GAP — calibration cheat resistance:
 *   Because correct_index is returned to the client, a tampered submit
 *   body could declare all answers correct and inflate bloomiq_scores
 *   up to 900. The BloomIQ Score is a self-narrative metric — it drives
 *   the badge, /student/future copy, and Premium upsell narratives, but
 *   nothing monetary. The honest-actor flow is unaffected. The proper
 *   fix is a server-side calibration_sessions table that stores the
 *   issued questions keyed by session_id so /submit can re-score against
 *   server-trusted correct_indexes — tracked for a follow-up PR.
 *
 * The client renders the quiz, then POSTs to /submit with the answers.
 * No DB rows are written here — calibrations + calibration_responses
 * land on submit, which is the right semantic boundary (an abandoned
 * quiz shouldn't leave a half-row).
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

    const gate = await checkLifetimeUse(user.id, "bloom_score");
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

    await recordLifetimeUse(user.id, "bloom_score");

    return NextResponse.json({
      ok: true,
      session_id: randomUUID(),
      exam_goal: examGoal,
      groq_model,
      questions,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 502 }
    );
  }
}
