import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";
import { BLOOM_LEVELS, type BloomLevel, isBloomLevel } from "@/lib/bloom";
import { checkDailyQuota, recordDailyUse } from "@/lib/freeQuota";

export const runtime = "nodejs";
export const maxDuration = 60;

// =============================================================================
// /api/student/daily-drill
// -----------------------------------------------------------------------------
// Builds a personalised 5-question Practice set for the calling student. We
// blend two pools:
//   - "yesterday's misses": questions the student got wrong yesterday (UTC day)
//   - "weakest Bloom levels": questions in the student's two lowest-accuracy
//     Bloom levels over the last 14 days, drawn from teachers in the student's
//     school.
//
// The endpoint never returns correct_index — just stems + options + metadata —
// so the client can't cheat by inspecting the network response.
// =============================================================================

type AttemptRow = {
  id: string;
  student_id: string;
  submitted_at: string | null;
  started_at: string;
};
type AnswerRow = {
  question_id: string;
  is_correct: boolean | null;
  bloom_level: string | null;
  attempt_id: string;
};
type QuestionRow = {
  id: string;
  stem: string;
  options: unknown;
  bloom_level: string;
  topic: string | null;
  owner_id: string;
};

type DrillItem = {
  id: string;
  stem: string;
  options: string[];
  bloom_level: BloomLevel;
  topic: string | null;
};

function asOptions(x: unknown): string[] | null {
  if (!Array.isArray(x)) return null;
  if (x.length !== 4) return null;
  if (!x.every((v) => typeof v === "string")) return null;
  return x as string[];
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function buildDrill(req: Request) {
  // F22 fix (QA): shared requireAuthenticated — single-session enforcement applied.
  const auth = await requireAuthenticated(req);
  if ("error" in auth) return auth.error;
  const { user, sb } = auth;

  const { data: prof } = await sb
    .from("profiles")
    .select("role, school_id")
    .eq("id", user.id)
    .single();
  if (prof?.role !== "student") {
    return NextResponse.json({ error: "Students only." }, { status: 403 });
  }

  // Free-tier daily cap. School students bypass (B2B subs).
  if (!prof.school_id) {
    const gate = await checkDailyQuota(user.id, "daily_drill");
    if (!gate.allowed) {
      return NextResponse.json(
        { error: gate.reason, code: "free_daily_cap", cap: gate.cap, used: gate.used },
        { status: 402 }
      );
    }
  }

  const now = new Date();
  const todayStart = startOfUtcDay(now);
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 3600_000);
  const fourteenStart = new Date(todayStart.getTime() - 14 * 24 * 3600_000);
  // Was 7d; widened to 14d so students don't see the same question on a
  // ~8-day rinse cycle. Matches the broader attempt window above so the
  // exclusion has data for the full lookback.
  const sevenStart = new Date(todayStart.getTime() - 14 * 24 * 3600_000);

  // Fetch the last 14 days of attempts for this student.
  const { data: attempts } = await sb
    .from("quiz_attempts")
    .select("id, student_id, submitted_at, started_at")
    .eq("student_id", user.id)
    .gte("started_at", fourteenStart.toISOString());
  const attemptList = (attempts as AttemptRow[]) || [];
  const attemptIds = attemptList.map((a) => a.id);

  if (attemptIds.length === 0) {
    return NextResponse.json({ items: [], reason: "no_data_yet", generated_at: now.toISOString() });
  }

  const { data: answers } = await sb
    .from("attempt_answers")
    .select("question_id, is_correct, bloom_level, attempt_id")
    .in("attempt_id", attemptIds);
  const answerList = (answers as AnswerRow[]) || [];

  // Map attempt -> submitted_at to bucket answers by day.
  const attemptDay = new Map<string, number>();
  for (const a of attemptList) {
    const ts = a.submitted_at || a.started_at;
    if (!ts) continue;
    attemptDay.set(a.id, new Date(ts).getTime());
  }

  // Pool 1: yesterday's misses — distinct question_ids.
  const missQids = new Set<string>();
  // Pool exclusion: questions the student got correct in last 7 days.
  const recentlyCorrectQids = new Set<string>();
  // Per-Bloom tallies for last 14 days.
  const perLevel: Record<string, { correct: number; total: number }> = {};

  for (const ans of answerList) {
    const t = attemptDay.get(ans.attempt_id);
    if (!t) continue;
    if (ans.is_correct === null || ans.is_correct === undefined) continue;
    if (ans.bloom_level && isBloomLevel(ans.bloom_level)) {
      if (!perLevel[ans.bloom_level]) perLevel[ans.bloom_level] = { correct: 0, total: 0 };
      perLevel[ans.bloom_level].total++;
      if (ans.is_correct) perLevel[ans.bloom_level].correct++;
    }
    if (t >= yesterdayStart.getTime() && t < todayStart.getTime() && ans.is_correct === false) {
      missQids.add(ans.question_id);
    }
    if (t >= sevenStart.getTime() && ans.is_correct === true) {
      recentlyCorrectQids.add(ans.question_id);
    }
  }

  // Identify two weakest Bloom levels with at least 5 attempts. Sort by pct asc.
  const weakLevels: BloomLevel[] = (Object.entries(perLevel) as Array<[string, { correct: number; total: number }]>)
    .filter(([lvl, v]) => v.total >= 5 && isBloomLevel(lvl))
    .map(([lvl, v]) => ({ lvl: lvl as BloomLevel, pct: v.correct / v.total }))
    .sort((a, b) => a.pct - b.pct)
    .slice(0, 2)
    .map((x) => x.lvl);

  // Pull yesterday's miss questions from question_bank.
  let missQuestions: QuestionRow[] = [];
  if (missQids.size > 0) {
    const { data: qs } = await sb
      .from("question_bank")
      .select("id, stem, options, bloom_level, topic, owner_id")
      .in("id", Array.from(missQids))
      .eq("status", "approved")
      .limit(50);
    missQuestions = (qs as QuestionRow[]) || [];
  }

  // Pull weak-level questions from teachers in student's school. If no school,
  // fall back to anyone (rare for school students). status='approved' only.
  let weakQuestions: QuestionRow[] = [];
  if (weakLevels.length > 0) {
    let teacherIds: string[] | null = null;
    if (prof?.school_id) {
      const { data: teachers } = await sb
        .from("profiles")
        .select("id")
        .eq("school_id", prof.school_id)
        .in("role", ["teacher", "super_teacher"]);
      teacherIds = ((teachers as Array<{ id: string }>) || []).map((t) => t.id);
    }
    // Cross-owner read of approved questions in the student's school. After
    // tightening RLS on question_bank to require quiz_questions reachability,
    // the user-token client can no longer see questions that aren't already
    // linked to one of their assigned quizzes. This drill is allowed to mine
    // the broader teacher pool (it's the whole point), so use the admin
    // client. The school filter below still scopes to teachers in the
    // student's school; cross-school exposure is not introduced here.
    const adminQ = supabaseAdmin();
    let q = adminQ
      .from("question_bank")
      .select("id, stem, options, bloom_level, topic, owner_id")
      .eq("status", "approved")
      .in("bloom_level", weakLevels)
      .limit(80);
    if (teacherIds && teacherIds.length > 0) {
      q = q.in("owner_id", teacherIds);
    }
    const { data: qs } = await q;
    const all = (qs as QuestionRow[]) || [];
    weakQuestions = all.filter((qq) => !recentlyCorrectQids.has(qq.id));
    // Shuffle for variety.
    for (let i = weakQuestions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [weakQuestions[i], weakQuestions[j]] = [weakQuestions[j], weakQuestions[i]];
    }
  }

  // Mix: aim for 5 total — up to 3 from misses, the rest from weak. If misses
  // empty, fill 5 from weak. If both empty, surface no_data_yet.
  const items: DrillItem[] = [];
  const seen = new Set<string>();
  function pushIf(q: QuestionRow) {
    if (seen.has(q.id)) return;
    if (!isBloomLevel(q.bloom_level)) return;
    const opts = asOptions(q.options);
    if (!opts) return;
    items.push({ id: q.id, stem: q.stem, options: opts, bloom_level: q.bloom_level, topic: q.topic });
    seen.add(q.id);
  }

  const missLimit = missQuestions.length > 0 ? Math.min(3, missQuestions.length) : 0;
  for (let i = 0; i < missLimit && items.length < 5; i++) pushIf(missQuestions[i]);
  for (let i = 0; i < weakQuestions.length && items.length < 5; i++) pushIf(weakQuestions[i]);

  if (items.length === 0) {
    return NextResponse.json({ items: [], reason: "no_data_yet", generated_at: now.toISOString() });
  }

  // Strip owner_id from items in response — clients don't need it.
  const safe = items.slice(0, 5).map((it) => ({
    id: it.id, stem: it.stem, options: it.options, bloom_level: it.bloom_level, topic: it.topic,
  }));
  void BLOOM_LEVELS; // (kept import; preserves typing intent)

  if (!prof.school_id && safe.length > 0) {
    await recordDailyUse(user.id, "daily_drill");
  }

  return NextResponse.json({ items: safe, generated_at: now.toISOString() });
}

export async function GET(req: Request) { return buildDrill(req); }
export async function POST(req: Request) { return buildDrill(req); }
