import { NextResponse } from "next/server";
import { getBearer, supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 30;

// =============================================================================
// POST /api/live/[code]/answer
// -----------------------------------------------------------------------------
// Body: { selected_index: number, time_taken_ms: number }
// Student only. Validates session is running and the caller is a player.
// Looks up the current question, scores Kahoot-style:
//   awarded = round(1000 * (1 - time_taken_ms / (seconds_per_question * 1000)))
// clamped to 0..1000. Wrong answer = 0. Upserts on (session, student, q_idx).
// =============================================================================

type RouteCtx = { params: Promise<{ code: string }> };
type SessionRow = {
  id: string; quiz_id: string; status: string;
  current_question_idx: number; seconds_per_question: number;
};
type QQRow = { question_id: string; position: number };
type QRow = { id: string; correct_index: number };

export async function POST(req: Request, ctx: RouteCtx) {
  try {
    const { code } = await ctx.params;
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: prof } = await sb.from("profiles").select("role").eq("id", user.id).single();
    if (prof?.role !== "student") {
      return NextResponse.json({ error: "Students only." }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const selected_index = Number(body?.selected_index);
    const time_taken_ms = Math.max(0, Math.round(Number(body?.time_taken_ms) || 0));
    if (!Number.isInteger(selected_index) || selected_index < 0 || selected_index > 3) {
      return NextResponse.json({ error: "selected_index must be 0..3" }, { status: 400 });
    }

    const { data: ses } = await sb
      .from("live_sessions")
      .select("id, quiz_id, status, current_question_idx, seconds_per_question")
      .eq("code", code)
      .maybeSingle();
    if (!ses) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    const session = ses as SessionRow;
    if (session.status !== "running") {
      return NextResponse.json({ error: "Session is not running." }, { status: 400 });
    }

    // Caller must be a player.
    const { data: player } = await sb
      .from("live_session_players")
      .select("session_id, score")
      .eq("session_id", session.id)
      .eq("student_id", user.id)
      .maybeSingle();
    if (!player) return NextResponse.json({ error: "Join the session first." }, { status: 403 });
    const playerRow = player as { session_id: string; score: number };

    // Resolve current question via quiz_questions ordered by position.
    const { data: qq } = await sb
      .from("quiz_questions")
      .select("question_id, position")
      .eq("quiz_id", session.quiz_id)
      .order("position", { ascending: true });
    const rows = (qq as QQRow[]) || [];
    const target = rows[session.current_question_idx];
    if (!target) return NextResponse.json({ error: "No active question." }, { status: 400 });

    const { data: q } = await sb
      .from("question_bank")
      .select("id, correct_index")
      .eq("id", target.question_id)
      .maybeSingle();
    if (!q) return NextResponse.json({ error: "Question not found." }, { status: 404 });
    const qRow = q as QRow;

    const is_correct = qRow.correct_index === selected_index;
    let awarded = 0;
    if (is_correct) {
      const window = Math.max(1000, session.seconds_per_question * 1000);
      const ratio = Math.max(0, Math.min(1, time_taken_ms / window));
      awarded = Math.round(1000 * (1 - ratio));
      if (awarded < 0) awarded = 0;
      if (awarded > 1000) awarded = 1000;
    }

    // Upsert answer keyed by (session, student, question_idx).
    const { error: upErr } = await sb
      .from("live_session_answers")
      .upsert({
        session_id: session.id,
        student_id: user.id,
        question_id: qRow.id,
        question_idx: session.current_question_idx,
        selected_index,
        is_correct,
        time_taken_ms,
        awarded_points: awarded,
      }, { onConflict: "session_id,student_id,question_idx" });
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

    // Update player's score: recompute from answers to handle re-answers safely.
    const { data: ans } = await sb
      .from("live_session_answers")
      .select("awarded_points")
      .eq("session_id", session.id)
      .eq("student_id", user.id);
    const newScore = ((ans as Array<{ awarded_points: number }>) || [])
      .reduce((s, r) => s + (r.awarded_points || 0), 0);
    await sb
      .from("live_session_players")
      .update({ score: newScore, last_seen_at: new Date().toISOString() })
      .eq("session_id", session.id)
      .eq("student_id", user.id);

    return NextResponse.json({ is_correct, awarded_points: awarded, score: newScore });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Answer failed" }, { status: 500 });
  }
}
