import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";

export const runtime = "nodejs";

// =============================================================================
// GET /api/sprint/today
// -----------------------------------------------------------------------------
// Returns the user's exam sprint state:
//   - settings (exam type, date, target AIR) — null if not configured
//   - days_remaining (>= 0 if exam is today/future, negative if past)
//   - phase: 'foundation' | 'practice' | 'sprint' | 'final_week' | 'past'
//   - mission: 3 deep-link tasks tuned to the phase, with a `done` flag
//     computed from real activity in the existing feature tables.
//   - days_done_this_week: how many days in the last 7 had ANY mission-relevant
//     activity. Drives the small adherence pill on the page.
//
// All data is per-user. RLS-aware Supabase client; no other authorization
// needed beyond auth.uid().
// =============================================================================

type ExamType = "JEE_MAIN" | "NEET" | "CAT" | "CUSTOM";
type Phase = "foundation" | "practice" | "sprint" | "final_week" | "past";

const EXAM_LABEL: Record<ExamType, string> = {
  JEE_MAIN: "JEE Main",
  NEET: "NEET",
  CAT: "CAT",
  CUSTOM: "Custom",
};

type MissionTask = {
  kind: string;       // 'teach_back' | 'climber' | 'speed' | 'misconceptions' | 'traps' | 'rank' | 'xray' | 'tutor'
  title: string;
  href: string;
  done: boolean;      // computed from "did the user already do this kind of thing today?"
};

type Mission = {
  phase: Phase;
  phase_label: string;
  blurb: string;
  tasks: MissionTask[];
};

function todayUTC(): string { return new Date().toISOString().slice(0, 10); }
function startOfTodayUTC(): string { return new Date().toISOString().slice(0, 10) + "T00:00:00Z"; }
function startOfNDaysAgoUTC(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10) + "T00:00:00Z";
}

function dayDiff(target: string, today: string): number {
  // Whole-day diff between two YYYY-MM-DD strings (UTC).
  const a = new Date(today + "T00:00:00Z").getTime();
  const b = new Date(target + "T00:00:00Z").getTime();
  return Math.round((b - a) / (24 * 3600 * 1000));
}

function pickPhase(daysRemaining: number): Phase {
  if (daysRemaining < 0) return "past";
  if (daysRemaining < 7) return "final_week";
  if (daysRemaining < 30) return "sprint";
  if (daysRemaining < 60) return "practice";
  return "foundation";
}

function phaseLabel(p: Phase): string {
  switch (p) {
    case "foundation":  return "Foundation phase";
    case "practice":    return "Practice phase";
    case "sprint":      return "Sprint phase";
    case "final_week":  return "Final week";
    case "past":        return "Exam day passed";
  }
}

function phaseBlurb(p: Phase, examName: string): string {
  switch (p) {
    case "foundation":  return `You have time. Build deep understanding now — that's what carries you when ${examName} hits.`;
    case "practice":    return `Halfway window. Mix understanding with timed practice — start measuring speed and trap-rates.`;
    case "sprint":      return `Sprint mode. Mock-style practice every day. Don't introduce new topics — sharpen what you know.`;
    case "final_week":  return `Last week. Revision only — no new topics. Trust the work you've put in.`;
    case "past":        return `Your ${examName} window has passed. Update the date if you have another attempt coming up.`;
  }
}

// Mission templates per phase. Three tasks each. Deep links into existing
// pages so the student is one tap away from the work.
function buildMission(phase: Phase): MissionTask[] {
  switch (phase) {
    case "foundation":
      return [
        { kind: "teach_back",   title: "Teach-Back: explain a topic in your own words",       href: "/student/teach-back",     done: false },
        { kind: "climber",      title: "Bloom Climb: today's rung on a topic you've started", href: "/student/climber",        done: false },
        { kind: "xray",         title: "Past-Paper X-Ray: tag last year's paper for direction",href: "/student/xray",           done: false },
      ];
    case "practice":
      return [
        { kind: "speed",        title: "Speed-Accuracy: 8-question timed batch",              href: "/student/speed",          done: false },
        { kind: "rank",         title: "Mock Rank Predictor: see where today's score lands",  href: "/student/rank",           done: false },
        { kind: "misconceptions", title: "Drill 1 active misconception",                       href: "/student/misconceptions", done: false },
      ];
    case "sprint":
      return [
        { kind: "speed",        title: "Speed-Accuracy: 12-question intense run",             href: "/student/speed",          done: false },
        { kind: "traps",        title: "Trap Detector: review your top trap pattern",         href: "/student/traps",          done: false },
        { kind: "climber",      title: "Climb 1 rung — keep that streak alive",               href: "/student/climber",        done: false },
      ];
    case "final_week":
      return [
        { kind: "misconceptions", title: "Resolve any active misconceptions",                  href: "/student/misconceptions", done: false },
        { kind: "traps",        title: "Final trap-profile review",                            href: "/student/traps",          done: false },
        { kind: "tutor",        title: "Doubt Tutor: clear any nagging concept",               href: "/student/tutor",          done: false },
      ];
    case "past":
      return [];
  }
}

// Mark each task `done: true` if the student has done that kind of activity
// since the start of the local day (UTC). Cheap parallel queries; no new tables.
async function annotateDoneFlags(
  sb: ReturnType<typeof supabaseServer>,
  userId: string,
  tasks: MissionTask[]
): Promise<MissionTask[]> {
  const sinceToday = startOfTodayUTC();
  // Map each task kind to the table + column to check. We only run a query
  // for kinds present in the mission, to keep the round-trip cheap.
  const checks: Record<string, () => Promise<boolean>> = {
    teach_back: async () => {
      const { count } = await sb.from("teach_back_sessions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .gte("created_at", sinceToday);
      return (count || 0) > 0;
    },
    climber: async () => {
      const { count } = await sb.from("bloom_climber_state")
        .select("user_id", { count: "exact", head: true })
        .eq("user_id", userId)
        .gte("last_attempt_at", sinceToday);
      return (count || 0) > 0;
    },
    speed: async () => {
      const { count } = await sb.from("speed_sessions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .gte("created_at", sinceToday);
      return (count || 0) > 0;
    },
    misconceptions: async () => {
      // "Did they touch a misconception today?" — interpreted as either a
      // resolution OR a new strike (last_seen_at bumped).
      const { count } = await sb.from("misconceptions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .gte("last_seen_at", sinceToday);
      return (count || 0) > 0;
    },
    traps: async () => {
      const { count } = await sb.from("distractor_traps")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .gte("created_at", sinceToday);
      return (count || 0) > 0;
    },
    rank: async () => {
      const { count } = await sb.from("mock_rank_predictions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .gte("created_at", sinceToday);
      return (count || 0) > 0;
    },
    xray: async () => {
      const { count } = await sb.from("past_paper_xrays")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .gte("created_at", sinceToday);
      return (count || 0) > 0;
    },
    tutor: async () => {
      // Tutor is stateless — no DB table to query. Default to false; a future
      // version with persisted chat sessions can plug in here.
      return false;
    },
  };

  const results = await Promise.all(
    tasks.map(async (t) => {
      const fn = checks[t.kind];
      if (!fn) return t;
      try {
        const done = await fn();
        return { ...t, done };
      } catch {
        return t;
      }
    })
  );
  return results;
}

// "How many of the last 7 days did the student do *anything* mission-relevant?"
// Cheap heuristic: union of created_at on the tracked feature tables.
async function daysActiveLast7(
  sb: ReturnType<typeof supabaseServer>,
  userId: string
): Promise<number> {
  const since = startOfNDaysAgoUTC(6); // includes today => 7-day window
  const queries = await Promise.all([
    sb.from("teach_back_sessions").select("created_at").eq("user_id", userId).gte("created_at", since),
    sb.from("speed_sessions").select("created_at").eq("user_id", userId).gte("created_at", since),
    sb.from("bloom_climber_state").select("last_attempt_at").eq("user_id", userId).gte("last_attempt_at", since),
    sb.from("distractor_traps").select("created_at").eq("user_id", userId).gte("created_at", since),
    sb.from("mock_rank_predictions").select("created_at").eq("user_id", userId).gte("created_at", since),
    sb.from("past_paper_xrays").select("created_at").eq("user_id", userId).gte("created_at", since),
    sb.from("misconceptions").select("last_seen_at").eq("user_id", userId).gte("last_seen_at", since),
  ]);
  const days = new Set<string>();
  for (const q of queries) {
    const rows = (q.data || []) as Array<Record<string, string | null>>;
    for (const r of rows) {
      const ts = r.created_at || r.last_attempt_at || r.last_seen_at;
      if (typeof ts === "string") days.add(ts.slice(0, 10));
    }
  }
  return days.size;
}

export async function GET(req: Request) {
  try {
    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;

    const { data: settings } = await sb
      .from("exam_sprint_settings")
      .select("exam_type, exam_label, exam_date, target_air, created_at")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!settings) {
      return NextResponse.json({
        ok: true,
        configured: false,
        settings: null,
      });
    }

    const days_remaining = dayDiff(settings.exam_date as string, todayUTC());
    const phase = pickPhase(days_remaining);
    const examType = settings.exam_type as ExamType;
    const examName = examType === "CUSTOM"
      ? (settings.exam_label as string | null) || "your exam"
      : EXAM_LABEL[examType];

    const baseTasks = buildMission(phase);
    const tasks = await annotateDoneFlags(sb, user.id, baseTasks);
    const days_done_this_week = await daysActiveLast7(sb, user.id);

    const mission: Mission = {
      phase,
      phase_label: phaseLabel(phase),
      blurb: phaseBlurb(phase, examName),
      tasks,
    };

    return NextResponse.json({
      ok: true,
      configured: true,
      settings: {
        exam_type: examType,
        exam_label: settings.exam_label as string | null,
        exam_date: settings.exam_date as string,
        target_air: settings.target_air as number | null,
        exam_name: examName,
      },
      days_remaining,
      mission,
      days_done_this_week,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Sprint state failed" },
      { status: 500 }
    );
  }
}
