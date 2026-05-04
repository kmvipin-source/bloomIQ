import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/student/attempt-start
 *
 * Body: { quiz_id: string, total: number, track_question_time?: boolean }
 *
 * Why this exists: the direct supabase-js insert into public.quiz_attempts
 * from the browser intermittently failed with
 *   "new row violates row-level security policy for table 'quiz_attempts'"
 * even though the RLS policy is `auth.uid() = student_id` and the client
 * IS sending the bearer. The pattern matches every other RLS race we have
 * fixed in this app — the user-token client occasionally evaluates RLS
 * with a stale/empty auth context on the edge. Routing the insert through
 * a server endpoint that re-verifies identity with sb.auth.getUser() and
 * inserts via the service role removes the race entirely.
 *
 * The free-tier daily-cap trigger (check_attempt_quota in migration 10)
 * still fires on this insert because the trigger runs regardless of
 * which client opened the connection. Quota errors surface as P0001 and
 * are forwarded with a friendly message.
 */
export async function POST(req: Request) {
  try {
    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user }, error: userErr } = await sb.auth.getUser();
    if (userErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const quizId: string = String(body?.quiz_id || "").trim();
    const total = Number(body?.total);
    const trackQuestionTime: boolean | null =
      typeof body?.track_question_time === "boolean" ? body.track_question_time : null;
    if (!quizId) return NextResponse.json({ error: "quiz_id is required" }, { status: 400 });
    if (!Number.isFinite(total) || total <= 0) {
      return NextResponse.json({ error: "total must be a positive number" }, { status: 400 });
    }

    const admin = supabaseAdmin();

    // Best-effort: persist the per-student "track question time" preference
    // for next time. Failure is not fatal — the attempt still proceeds.
    if (trackQuestionTime !== null) {
      await admin
        .from("profiles")
        .update({ track_question_time: trackQuestionTime })
        .eq("id", user.id);
    }

    const { data: created, error } = await admin
      .from("quiz_attempts")
      .insert({ quiz_id: quizId, student_id: user.id, total })
      .select("id, started_at")
      .single();
    if (error || !created) {
      // P0001 = check_attempt_quota raised the daily-cap exception.
      const isQuota = error?.code === "P0001"
        || /Daily free-attempt limit/i.test(error?.message || "");
      const status = isQuota ? 429 : 500;
      return NextResponse.json(
        { error: error?.message || "Could not start attempt" },
        { status }
      );
    }
    return NextResponse.json({ ok: true, attempt: created });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}
