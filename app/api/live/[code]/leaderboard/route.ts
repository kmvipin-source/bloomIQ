import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

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
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

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
