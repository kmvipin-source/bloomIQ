import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";

/**
 * GET /api/student/quiz-by-code?code=ABCDEF
 *
 * Server-side join-by-code lookup. Replaces the direct `from("quizzes")...
 * .eq("code", code)` reads that previously happened on `/student/join` and
 * `/student/quiz/[code]`. Those direct reads required `quizzes read by code`
 * and `qq read auth` RLS policies to be open to every authenticated user,
 * which let any logged-in user enumerate every quiz + every quiz→question
 * pairing across schools (RLS_AUDIT.md HIGH finding).
 *
 * This endpoint:
 *   - requires a valid auth bearer (anonymous callers get 401)
 *   - looks up the quiz with the service-role admin client (bypasses RLS)
 *   - rejects inactive quizzes
 *   - returns ONLY the fields the student-facing pages need
 *   - fetches quiz_questions + question_bank in one shot via admin client
 *
 * The `code` itself is the cap-secret here — same model as before.
 */
export async function GET(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const url = new URL(req.url);
    const code = String(url.searchParams.get("code") || "").trim().toUpperCase();
    if (!code || code.length < 4 || code.length > 16) {
      return NextResponse.json({ error: "Invalid quiz code" }, { status: 400 });
    }

    const admin = supabaseAdmin();

    // Quiz row — minimal fields exposed to the client. Includes
    // marking_scheme (migration 76) so the student-side scoring engine
    // can compute weighted marks at submit time and so the test-cover
    // screen can show "Marks: +4 correct, −1 wrong".
    const { data: q } = await admin
      .from("quizzes")
      .select("id, name, code, time_limit_minutes, active, owner_id, marking_scheme")
      .eq("code", code)
      .maybeSingle();

    if (!q) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (!q.active) {
      return NextResponse.json({ error: "closed", message: "This quiz is closed." }, { status: 410 });
    }

    // Pull the question bank rows joined via quiz_questions, ordered by
    // position. Field set is the minimum the take-quiz UI needs.
    const { data: qq } = await admin
      .from("quiz_questions")
      .select(
        "position, question_bank!inner(id, stem, options, correct_index, bloom_level, topic, explanation)"
      )
      .eq("quiz_id", q.id)
      .order("position", { ascending: true });

    type Row = {
      position: number;
      question_bank: {
        id: string;
        stem: string;
        options: string[];
        correct_index: number;
        bloom_level: string;
        topic: string | null;
        explanation: string | null;
      };
    };
    const questions = ((qq as unknown as Row[]) || []).map((r) => r.question_bank);

    return NextResponse.json({
      ok: true,
      quiz: {
        id: q.id,
        name: q.name,
        code: q.code,
        time_limit_minutes: q.time_limit_minutes,
        active: q.active,
        // Pass marking_scheme through. NULL is the safe default — the
        // student-side scoring engine resolves NULL to legacy +1/0/0.
        marking_scheme: (q as { marking_scheme?: unknown }).marking_scheme ?? null,
      },
      questions,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Lookup failed" },
      { status: 500 }
    );
  }
}
