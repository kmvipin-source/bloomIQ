import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";
import { BLOOM_LEVELS, BLOOM_META, type BloomLevel } from "@/lib/bloom";

// Rate limit by token to deter brute-force enumeration. Use the shared
// token-bucket helper so the cap is consistent with the rest of the API
// (in-process per-instance — same trade-off as every other route. A
// distributed limiter is a known follow-up).
function shouldThrottle(token: string): { throttled: boolean; retryAfterSec: number } {
  const r = checkRateLimit(token, "parent.data", { capacity: 10, refillPerHour: 60 });
  if (r.allowed) return { throttled: false, retryAfterSec: 0 };
  return { throttled: true, retryAfterSec: r.retryAfterSec };
}

export const runtime = "nodejs";

// =============================================================================
// GET /api/parent/data?token=...
// -----------------------------------------------------------------------------
// Token-authed read-only endpoint. Validates the token against parent_invites,
// bumps the view counter, then returns a curated parent-facing dashboard for
// the linked student:
//   - student name + grade
//   - this-week activity counts
//   - Bloom mastery breakdown (last 30 days)
//   - top topics studied
//   - exam sprint countdown if configured
//   - last 10 quiz attempts with score + date
//
// Uses the SUPABASE_SERVICE_ROLE_KEY to bypass RLS — necessary because the
// parent has no auth.uid(), only a token. We're careful to filter EVERY query
// by the student_id we resolved from the token, so a parent can never see
// anyone else's data.
// =============================================================================

type AttemptRow = {
  id: string;
  score: number | null;
  total: number | null;
  submitted_at: string | null;
  started_at: string;
  quiz: { name: string | null; subject: string | null } | null;
};

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const token = (url.searchParams.get("token") || "").trim();
    if (!token || token.length < 16) {
      return NextResponse.json({ error: "Invalid link" }, { status: 400 });
    }

    const rate = shouldThrottle(token);
    if (rate.throttled) {
      return NextResponse.json(
        { error: "Too many requests. Try again in a few minutes." },
        { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } },
      );
    }

    const sb = supabaseAdmin();

    // 1. Resolve token → student_id + check revoked_at + expires_at
    const { data: invite, error: invErr } = await sb
      .from("parent_invites")
      .select("id, student_id, parent_label, revoked_at, view_count, created_at, expires_at")
      .eq("token", token)
      .maybeSingle();
    if (invErr) return NextResponse.json({ error: invErr.message }, { status: 500 });
    if (!invite) return NextResponse.json({ error: "Link not found" }, { status: 404 });
    if (invite.revoked_at) return NextResponse.json({ error: "This link has been revoked." }, { status: 403 });
    // Reject expired tokens. Without this gate a leaked link was good
    // forever until manual revoke; now defaults to 90-day rotation.
    const expiresAt = (invite as { expires_at?: string | null }).expires_at;
    if (expiresAt && Date.parse(expiresAt) < Date.now()) {
      return NextResponse.json({ error: "This link has expired. Ask for a fresh share link." }, { status: 403 });
    }

    const studentId = invite.student_id as string;

    // 2. Bump view counter (best-effort; don't fail if it errors)
    try {
      await sb
        .from("parent_invites")
        .update({
          view_count: (invite.view_count || 0) + 1,
          last_viewed_at: new Date().toISOString(),
        })
        .eq("id", invite.id);
    } catch { /* swallow */ }

    // 3. Pull student profile
    const { data: prof } = await sb
      .from("profiles")
      .select("full_name, grade, school, is_school_student")
      .eq("id", studentId)
      .maybeSingle();

    const studentName = (prof as { full_name?: string } | null)?.full_name || "Your child";
    const grade = (prof as { grade?: string | null } | null)?.grade || null;
    const school = (prof as { school?: string | null } | null)?.school || null;

    // 4. Last 30 days window
    const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const isoThirty = thirtyDaysAgo.toISOString();
    const isoSeven = sevenDaysAgo.toISOString();

    // 5. Quiz attempts (last 30 days, then we slice for table + week count)
    const { data: attemptsData } = await sb
      .from("quiz_attempts")
      .select("id, score, total, submitted_at, started_at, quiz:quizzes(name, subject)")
      .eq("student_id", studentId)
      .gte("started_at", isoThirty)
      .order("started_at", { ascending: false });
    const attempts = (attemptsData as unknown as AttemptRow[]) || [];
    const completed = attempts.filter((a) => a.submitted_at);
    const thisWeekCompleted = completed.filter((a) => a.submitted_at && a.submitted_at >= isoSeven).length;
    const avgScore = completed.length
      ? Math.round((completed.reduce((s, a) => s + ((a.score || 0) / Math.max(a.total || 1, 1)) * 100, 0) / completed.length))
      : 0;

    // 6. Bloom mastery (last 30 days, only completed attempts)
    const submittedIds = completed.map((a) => a.id);
    let bloomBreakdown: Record<string, { correct: number; total: number; pct: number; label: string; color: string }> = {};
    if (submittedIds.length > 0) {
      const { data: ans } = await sb
        .from("attempt_answers")
        .select("bloom_level, is_correct")
        .in("attempt_id", submittedIds);
      const tally: Record<string, { correct: number; total: number }> = {};
      ((ans || []) as Array<{ bloom_level: string; is_correct: boolean | null }>).forEach((a) => {
        if (!tally[a.bloom_level]) tally[a.bloom_level] = { correct: 0, total: 0 };
        tally[a.bloom_level].total += 1;
        if (a.is_correct) tally[a.bloom_level].correct += 1;
      });
      for (const lvl of BLOOM_LEVELS) {
        const t = tally[lvl];
        if (!t) continue;
        const pct = t.total ? Math.round((t.correct / t.total) * 100) : 0;
        bloomBreakdown[lvl] = {
          correct: t.correct,
          total: t.total,
          pct,
          label: BLOOM_META[lvl as BloomLevel].label,
          color: BLOOM_META[lvl as BloomLevel].color,
        };
      }
    }

    // 7. Top topics studied (by quiz subject in last 30 days, fallback to topic_family)
    const topicCounts: Record<string, number> = {};
    for (const a of attempts) {
      const t = a.quiz?.subject || "General";
      if (t) topicCounts[t] = (topicCounts[t] || 0) + 1;
    }
    const topTopics = Object.entries(topicCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([t, n]) => ({ topic: t, count: n }));

    // 8. Exam Sprint countdown (if configured)
    let sprint: { exam_name: string; exam_date: string; days_remaining: number } | null = null;
    try {
      const { data: sprintRow } = await sb
        .from("exam_sprint_settings")
        .select("exam_type, exam_label, exam_date")
        .eq("user_id", studentId)
        .maybeSingle();
      if (sprintRow) {
        const r = sprintRow as { exam_type: string; exam_label: string | null; exam_date: string };
        const todayMs = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").getTime();
        const examMs = new Date(r.exam_date + "T00:00:00Z").getTime();
        const days = Math.round((examMs - todayMs) / 86400000);
        const labelMap: Record<string, string> = { JEE_MAIN: "JEE Main", NEET: "NEET", CAT: "CAT" };
        const exam_name = r.exam_type === "CUSTOM" ? (r.exam_label || "their exam") : (labelMap[r.exam_type] || r.exam_type);
        sprint = { exam_name, exam_date: r.exam_date, days_remaining: days };
      }
    } catch { /* sprint table may not exist if migration 14 not applied */ }

    // 9. Last 10 attempts table (most recent first)
    const recentAttempts = attempts.slice(0, 10).map((a) => {
      const total = a.total || 0;
      const score = a.score || 0;
      return {
        id: a.id,
        quiz_name: a.quiz?.name || "Quiz",
        score,
        total,
        pct: total > 0 ? Math.round((score / total) * 100) : 0,
        submitted_at: a.submitted_at,
      };
    });

    return NextResponse.json({
      ok: true,
      student: { name: studentName, grade, school },
      parent_label: invite.parent_label,
      stats: {
        this_week_completed: thisWeekCompleted,
        last_30_days_completed: completed.length,
        avg_score: avgScore,
      },
      bloom_breakdown: bloomBreakdown,
      top_topics: topTopics,
      sprint,
      recent_attempts: recentAttempts,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Parent data fetch failed" },
      { status: 500 }
    );
  }
}
