import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";
export const maxDuration = 30;

// =============================================================================
// POST /api/live/[code]/join
// -----------------------------------------------------------------------------
// Body: { display_name?: string }. Student only. Inserts a player row if not
// already there. Returns { joined: true, session_id }.
// =============================================================================

type RouteCtx = { params: Promise<{ code: string }> };

export async function POST(req: Request, ctx: RouteCtx) {
  try {
    const { code } = await ctx.params;
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const { data: prof } = await sb
      .from("profiles")
      .select("role, full_name")
      .eq("id", user.id)
      .single();
    if (prof?.role !== "student") {
      return NextResponse.json({ error: "Students only." }, { status: 403 });
    }

    const { data: ses } = await sb
      .from("live_sessions")
      .select("id, status")
      .eq("code", code)
      .maybeSingle();
    if (!ses) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    const session = ses as { id: string; status: string };
    if (session.status === "ended") {
      return NextResponse.json({ error: "Session has ended." }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const desired = typeof body?.display_name === "string" ? body.display_name.trim().slice(0, 40) : "";
    const fallback = (prof as { full_name: string | null } | null)?.full_name?.trim() || "Player";
    const display_name = desired || fallback;

    // Already joined?
    const { data: existing } = await sb
      .from("live_session_players")
      .select("session_id")
      .eq("session_id", session.id)
      .eq("student_id", user.id)
      .maybeSingle();
    if (existing) {
      // Optionally update display name.
      if (display_name) {
        await sb
          .from("live_session_players")
          .update({ display_name, last_seen_at: new Date().toISOString() })
          .eq("session_id", session.id)
          .eq("student_id", user.id);
      }
      return NextResponse.json({ joined: true, session_id: session.id, already: true });
    }

    const { error: insErr } = await sb
      .from("live_session_players")
      .insert({
        session_id: session.id,
        student_id: user.id,
        display_name,
      });
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

    return NextResponse.json({ joined: true, session_id: session.id });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Join failed" }, { status: 500 });
  }
}
