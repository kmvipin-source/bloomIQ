import { NextResponse } from "next/server";
import { getBearer, supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 30;

// =============================================================================
// POST /api/live/start
// -----------------------------------------------------------------------------
// Body: { quiz_id: string, seconds_per_question?: number }
// Teacher only. Verifies they own the quiz, generates a unique 6-char code,
// and inserts a live_sessions row in lobby state.
// =============================================================================

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // skip O/0/I/1 confusables
function genCode(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: prof } = await sb.from("profiles").select("role").eq("id", user.id).single();
    if (prof?.role !== "teacher" && prof?.role !== "super_teacher") {
      return NextResponse.json({ error: "Teachers only." }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const quizId = typeof body?.quiz_id === "string" ? body.quiz_id : "";
    const seconds = Number(body?.seconds_per_question) > 0
      ? Math.min(180, Math.max(5, Math.round(Number(body.seconds_per_question))))
      : 30;
    if (!quizId) return NextResponse.json({ error: "quiz_id is required." }, { status: 400 });

    const { data: quiz, error: qErr } = await sb
      .from("quizzes")
      .select("id, owner_id, name")
      .eq("id", quizId)
      .maybeSingle();
    if (qErr || !quiz) return NextResponse.json({ error: "Quiz not found." }, { status: 404 });
    if ((quiz as { owner_id: string }).owner_id !== user.id) {
      return NextResponse.json({ error: "You don't own this quiz." }, { status: 403 });
    }

    // Find a free code. Up to 8 tries — collision space is huge.
    let code = "";
    for (let i = 0; i < 8; i++) {
      const cand = genCode();
      const { data: clash } = await sb.from("live_sessions").select("id").eq("code", cand).maybeSingle();
      if (!clash) { code = cand; break; }
    }
    if (!code) return NextResponse.json({ error: "Could not allocate a code." }, { status: 500 });

    const { data: ins, error: insErr } = await sb
      .from("live_sessions")
      .insert({
        host_teacher_id: user.id,
        quiz_id: quizId,
        code,
        status: "lobby",
        seconds_per_question: seconds,
      })
      .select("id, code")
      .single();
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

    return NextResponse.json({ code: (ins as { code: string }).code, session_id: (ins as { id: string }).id });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Start failed" }, { status: 500 });
  }
}
