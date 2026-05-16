import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";
export const maxDuration = 30;

// =============================================================================
// GET /api/live/[code]/state
// -----------------------------------------------------------------------------
// Returns the current session state for any authenticated caller.
// Includes the current question (stem + options, NO correct_index) when:
//   - status='running', AND
//   - caller is the host OR a player in this session
// =============================================================================

type SessionRow = {
  id: string;
  host_teacher_id: string;
  quiz_id: string;
  status: "lobby" | "running" | "ended";
  current_question_idx: number;
  seconds_per_question: number;
  question_started_at: string | null;
  ended_at: string | null;
};

type QQRow = { question_id: string; position: number };
type QRow = {
  id: string; stem: string; options: unknown;
  bloom_level: string; topic: string | null;
};

type RouteCtx = { params: Promise<{ code: string }> };

function asOptions(x: unknown): string[] | null {
  if (!Array.isArray(x)) return null;
  if (x.length !== 4) return null;
  if (!x.every((v) => typeof v === "string")) return null;
  return x as string[];
}

export async function GET(req: Request, ctx: RouteCtx) {
  try {
    const { code } = await ctx.params;
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const { data: ses } = await sb
      .from("live_sessions")
      .select("id, host_teacher_id, quiz_id, status, current_question_idx, seconds_per_question, question_started_at, ended_at")
      .eq("code", code)
      .maybeSingle();
    if (!ses) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    const session = ses as SessionRow;

    const isHost = session.host_teacher_id === user.id;
    let isPlayer = false;
    if (!isHost) {
      const { data: pl } = await sb
        .from("live_session_players")
        .select("session_id")
        .eq("session_id", session.id)
        .eq("student_id", user.id)
        .maybeSingle();
      isPlayer = !!pl;
    }

    const { count: playersCount } = await sb
      .from("live_session_players")
      .select("session_id", { count: "exact", head: true })
      .eq("session_id", session.id);

    let total_questions = 0;
    const { count: qCount } = await sb
      .from("quiz_questions")
      .select("question_id", { count: "exact", head: true })
      .eq("quiz_id", session.quiz_id);
    total_questions = qCount || 0;

    type CurrentQuestion = {
      id: string; stem: string; options: string[];
      bloom_level: string; topic: string | null; idx: number;
    } | null;
    let current_question: CurrentQuestion = null;
    if (session.status === "running" && (isHost || isPlayer)) {
      const { data: qq } = await sb
        .from("quiz_questions")
        .select("question_id, position")
        .eq("quiz_id", session.quiz_id)
        .order("position", { ascending: true });
      const rows = (qq as QQRow[]) || [];
      const target = rows[session.current_question_idx];
      if (target) {
        const { data: q } = await sb
          .from("question_bank")
          .select("id, stem, options, bloom_level, topic")
          .eq("id", target.question_id)
          .maybeSingle();
        if (q) {
          const opts = asOptions((q as QRow).options);
          if (opts) {
            current_question = {
              id: (q as QRow).id,
              stem: (q as QRow).stem,
              options: opts,
              bloom_level: (q as QRow).bloom_level,
              topic: (q as QRow).topic,
              idx: session.current_question_idx,
            };
          }
        }
      }
    }

    // Touch player's last_seen_at so the host UI can spot disconnects.
    if (isPlayer) {
      await sb
        .from("live_session_players")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("session_id", session.id)
        .eq("student_id", user.id);
    }

    return NextResponse.json({
      session: {
        id: session.id,
        status: session.status,
        current_question_idx: session.current_question_idx,
        question_started_at: session.question_started_at,
        seconds_per_question: session.seconds_per_question,
        ended_at: session.ended_at,
        total_questions,
      },
      role: isHost ? "host" : isPlayer ? "player" : "viewer",
      players_count: playersCount || 0,
      current_question,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "State failed" }, { status: 500 });
  }
}
