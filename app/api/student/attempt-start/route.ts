import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

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
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

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

    // Finding #73 fix: server-side gate against expired Free-trial subs.
    // The /student layout already redirects expired users to /student/expired,
    // but that's a client-side check — a stale tab, a scripted call, or a
    // racing client can still hit this endpoint. Block at the server with
    // a 410 Gone so the user-facing message stays consistent.
    {
      const { data: sub } = await admin
        .from("subscriptions")
        .select("tier, is_trial, status, expires_at")
        .eq("user_id", user.id)
        .maybeSingle();
      if (sub) {
        const row = sub as { tier?: string; is_trial?: boolean; status?: string; expires_at?: string | null };
        const adminBlocked = row.status === "suspended" || row.status === "cancelled";
        const timeExpired = row.expires_at ? new Date(row.expires_at).getTime() < Date.now() : false;
        if (row.tier === "free" && row.is_trial === true && (adminBlocked || timeExpired)) {
          return NextResponse.json(
            { error: "Your free trial has ended. Upgrade to keep practicing.", code: "free_expired" },
            { status: 410 }
          );
        }
      }
    }

    // Refuse to start an attempt against a quiz whose only enclosing
    // class is soft-deleted (migration 78). Inactive classes are
    // preserved for audit but should not generate new attempts. We
    // resolve the quiz's assigned classes through quiz_assignments;
    // if every class is inactive the attempt is blocked. Quizzes with
    // no class assignment (personal practice) are allowed through.
    const { data: assignments } = await admin
      .from("quiz_assignments")
      .select("class_id")
      .eq("quiz_id", quizId);
    const classIds = ((assignments as Array<{ class_id: string | null }> | null) || [])
      .map((a) => a.class_id)
      .filter((c): c is string => !!c);
    if (classIds.length > 0) {
      const { data: activeClasses } = await admin
        .from("classes")
        .select("id")
        .in("id", classIds)
        .eq("status", "active");
      if (!activeClasses || activeClasses.length === 0) {
        return NextResponse.json(
          { error: "This test belongs to a class that has been deactivated.", code: "class_inactive" },
          { status: 410 }
        );
      }
    }

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
