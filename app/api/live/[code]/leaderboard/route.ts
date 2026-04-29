import { NextResponse } from "next/server";
import { getBearer, supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 30;

// =============================================================================
// GET /api/live/[code]/leaderboard
// -----------------------------------------------------------------------------
// Returns the top-10 players by score for any authenticated caller.
// =============================================================================

type RouteCtx = { params: Promise<{ code: string }> };
type PlayerRow = { student_id: string; display_name: string | null; score: number };

export async function GET(req: Request, ctx: RouteCtx) {
  try {
    const { code } = await ctx.params;
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: ses } = await sb
      .from("live_sessions")
      .select("id")
      .eq("code", code)
      .maybeSingle();
    if (!ses) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    const sessionId = (ses as { id: string }).id;

    const { data: rows } = await sb
      .from("live_session_players")
      .select("student_id, display_name, score")
      .eq("session_id", sessionId)
      .order("score", { ascending: false })
      .limit(10);
    const list = (rows as PlayerRow[]) || [];

    return NextResponse.json({
      rows: list.map((r) => ({
        student_id: r.student_id,
        display_name: r.display_name,
        score: r.score,
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Leaderboard failed" }, { status: 500 });
  }
}
