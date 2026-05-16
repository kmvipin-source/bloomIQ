import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";
export const maxDuration = 30;

// =============================================================================
// POST /api/live/[code]/next
// -----------------------------------------------------------------------------
// Host only. Advances current_question_idx by 1, OR sets status='ended' if
// already past the last question. Resets question_started_at to now() on
// successful advance.
// =============================================================================

type RouteCtx = { params: Promise<{ code: string }> };
type SessionRow = {
  id: string; host_teacher_id: string; quiz_id: string;
  status: string; current_question_idx: number;
};

export async function POST(req: Request, ctx: RouteCtx) {
  try {
    const { code } = await ctx.params;
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const { data: ses } = await sb
      .from("live_sessions")
      .select("id, host_teacher_id, quiz_id, status, current_question_idx")
      .eq("code", code)
      .maybeSingle();
    if (!ses) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    const session = ses as SessionRow;
    if (session.host_teacher_id !== user.id) {
      return NextResponse.json({ error: "Host only." }, { status: 403 });
    }
    if (session.status !== "running") {
      return NextResponse.json({ error: "Session is not running." }, { status: 400 });
    }

    const { count: total } = await sb
      .from("quiz_questions")
      .select("question_id", { count: "exact", head: true })
      .eq("quiz_id", session.quiz_id);
    const totalQ = total || 0;
    const nextIdx = session.current_question_idx + 1;

    if (nextIdx >= totalQ) {
      const { error: updErr } = await sb
        .from("live_sessions")
        .update({ status: "ended", ended_at: new Date().toISOString() })
        .eq("id", session.id);
      if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
      return NextResponse.json({ status: "ended", current_question_idx: session.current_question_idx });
    }

    const { error: updErr } = await sb
      .from("live_sessions")
      .update({
        current_question_idx: nextIdx,
        question_started_at: new Date().toISOString(),
      })
      .eq("id", session.id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    return NextResponse.json({ status: "running", current_question_idx: nextIdx });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Next failed" }, { status: 500 });
  }
}
