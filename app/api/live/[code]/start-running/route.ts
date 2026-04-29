import { NextResponse } from "next/server";
import { getBearer, supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 30;

// =============================================================================
// POST /api/live/[code]/start-running
// -----------------------------------------------------------------------------
// Host only. Transitions a lobby session to running on question 0.
// =============================================================================

type RouteCtx = { params: Promise<{ code: string }> };

export async function POST(req: Request, ctx: RouteCtx) {
  try {
    const { code } = await ctx.params;
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: ses } = await sb
      .from("live_sessions")
      .select("id, host_teacher_id, status")
      .eq("code", code)
      .maybeSingle();
    if (!ses) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    const session = ses as { id: string; host_teacher_id: string; status: string };
    if (session.host_teacher_id !== user.id) {
      return NextResponse.json({ error: "Host only." }, { status: 403 });
    }
    if (session.status === "ended") {
      return NextResponse.json({ error: "Session already ended." }, { status: 400 });
    }

    const { error: updErr } = await sb
      .from("live_sessions")
      .update({
        status: "running",
        current_question_idx: 0,
        question_started_at: new Date().toISOString(),
      })
      .eq("id", session.id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    return NextResponse.json({ status: "running", current_question_idx: 0 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Start failed" }, { status: 500 });
  }
}
