"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { QuizAttempt } from "@/lib/types";
import { pct } from "@/lib/utils";
import Empty from "@/components/Empty";
import { ClipboardList, Clock, Play, Sparkles, TrendingUp, NotebookPen, AlertCircle, CalendarDays, ListChecks, GraduationCap, Search, ScanSearch, Timer, Crosshair, Trophy, Bot, Film, Brain, Gauge, Users, Mic, Network, MessageCircle, Target, Zap } from "lucide-react";
import { BLOOM_LEVELS, BLOOM_META, blankBloomCounts } from "@/lib/bloom";
import StudentGoalPicker, { STUDENT_GOALS } from "@/components/StudentGoalPicker";
import StudentFeatureTile from "@/components/StudentFeatureTile";
import MissedAssignments from "@/components/MissedAssignments";
import ExtensionRequestButton, { type ExtensionRequest } from "@/components/ExtensionRequestButton";
import CurrentPlanBadge from "@/components/CurrentPlanBadge";
import { TILE_META, tileLayoutForGoal, tilesByCategoryForGoal, CATEGORY_META } from "@/lib/studentGoalTiles";
import BloomHero from "@/components/BloomHero";
import PaywallModal from "@/components/PaywallModal";
import RenewBanner from "@/components/RenewBanner";
import { useFeatureAccess, findUnlockingTier, tierLabel } from "@/lib/featureAccess";
import { loadClassQuizIds } from "@/lib/studentScope";
import type { PlanTier } from "@/lib/types";

type AttemptRow = QuizAttempt & { quiz: { name: string; code: string } | null };

type AssignedRow = {
  id: string;
  due_at: string | null;
  assigned_at: string;
  via: "class" | "direct";
  via_label: string;
  quiz: {
    id: string;
    name: string;
    code: string;
    subject: string | null;
    time_limit_minutes: number;
    question_count: number;
  } | null;
  /** Latest non-denied retake/extension request for this assignment, if any.
   *  Drives the inline button state on each card (request vs. pending vs.
   *  approved vs. denied). Same data as MissedAssignments uses below the
   *  fold for past-due items — just fetched here for the upcoming list. */
  request: ExtensionRequest;
};

type BloomBreakdown = Record<string, { correct: number; total: number }>;

export default function StudentHome() {
  const [name, setName] = useState("");
  const [isSchool, setIsSchool] = useState<boolean | null>(null);
  // For independent students: all their attempts (all personal
  // practice by definition). For school students: ONLY the
  // class-scoped attempts (teacher-assigned). Personal practice
  // attempts for school students don't live in this state at all —
  // they live entirely on the /student/tests page.
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [assigned, setAssigned] = useState<AssignedRow[]>([]);
  const [bloomMastery, setBloomMastery] = useState<BloomBreakdown>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Free-tier daily attempt tracking (independent students only).
  // freeRemaining = null means "not capped" (school student or paid tier).
  const [freeRemaining, setFreeRemaining] = useState<number | null>(null);
  const [freeCap, setFreeCap] = useState<number | null>(null);

  // Exam Sprint countdown — null when not configured.
  const [sprint, setSprint] = useState<{ exam_name: string; exam_date: string; days_remaining: number } | null>(null);

  // Number of SRS reviews due today. 0 (or null on RPC failure) hides the card.
  const [srsDueCount, setSrsDueCount] = useState<number>(0);

  // Exam goal (independent students only). When null on first dashboard
  // visit we show the goal-picker onboarding card instead of the
  // tile buffet. Drives downstream tile prioritisation. See migration 24.
  const [examGoal, setExamGoal] = useState<string | null>(null);
  // BloomIQ Score calibration status. null = unknown (still loading),
  // false = user has not calibrated yet (we surface the discovery hero),
  // true = user has calibrated (the BloomIQScoreBadge in the layout
  // already shows their score, so the discovery hero hides).
  const [hasBloomIQ, setHasBloomIQ] = useState<boolean | null>(null);
  // BloomIQ calibration status is read from /api/auth/me below (which
  // already returns has_calibration). Avoiding a duplicate
  // /api/student/score fetch here saves a round-trip per home-page mount
  // and keeps school students out of the BloomIQ funnel by default —
  // they never see the discovery hero.

  // Feature gating. `allowed` is the set of feature keys the user's plan
  // grants. Tiles whose featureKey is missing from this set render in the
  // visible-but-locked state (see lib/featureAccess.ts + StudentFeatureTile).
  const access = useFeatureAccess();
  const [paywall, setPaywall] = useState<{ key: string; tier: PlanTier | null }>({ key: "", tier: null });

  // Pre-resolve "which tier unlocks each feature" so the lock badge label is
  // accurate per-tile. Cached in state so we only fetch once.
  const [unlockMap, setUnlockMap] = useState<Record<string, { tier: PlanTier; label: string }>>({});
  useEffect(() => {
    if (access.isLoading) return;
    (async () => {
      const out: Record<string, { tier: PlanTier; label: string }> = {};
      const keys = Object.values(TILE_META).map((m) => m.featureKey).filter(Boolean) as string[];
      for (const k of keys) {
        if (access.allowed.has(k)) continue;
        const tier = await findUnlockingTier(k, isSchool ? "school" : "personal");
        if (tier) out[k] = { tier: tier.tier, label: tier.label };
      }
      setUnlockMap(out);
    })();
  }, [access.isLoading, access.allowed, isSchool]);

  function openPaywall(key: string | undefined) {
    if (!key) return;
    setPaywall({ key, tier: unlockMap[key]?.tier || null });
  }

  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return;
      // Identity via service-role /api/auth/me. The previous direct
      // profiles read raced RLS, which made the onboarding goal-picker
      // re-appear after every reload because exam_goal came back null
      // even when it was set in the DB.
      const meRes = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      if (!meRes.ok) {
        // Without this guard the page sat on the loading spinner forever
        // if /api/auth/me blipped. Surface an actionable error so the
        // user (or PostHog session replay) can see something happened.
        setLoadError("Could not load your dashboard. Refresh to try again.");
        setLoading(false);
        return;
      }
      const me = await meRes.json() as {
        uid: string;
        full_name: string | null;
        is_school_student: boolean;
        exam_goal: string | null;
        has_calibration?: boolean;
      };
      const user = { id: me.uid };
      setName(me.full_name || "");
      setIsSchool(!!me.is_school_student);
      setExamGoal(me.exam_goal || null);
      // Only individual students see the BloomIQ discovery hero. School
      // students don't go through calibration so leave hasBloomIQ at
      // null (hero stays hidden).
      if (!me.is_school_student) {
        setHasBloomIQ(!!me.has_calibration);
      }

      if (!me.is_school_student) {
        try {
          const [{ data: remaining }, { data: limits }] = await Promise.all([
            sb.rpc("attempts_remaining_today"),
            sb.from("subscription_limits").select("free_daily_attempts").eq("id", 1).maybeSingle(),
          ]);
          if (typeof remaining === "number") {
            setFreeRemaining(remaining);
            setFreeCap((limits as { free_daily_attempts: number } | null)?.free_daily_attempts ?? null);
          }
        } catch { /* RPC missing in old DB versions silent skip */ }

        try {
          const { data: sprintRow } = await sb
            .from("exam_sprint_settings")
            .select("exam_type, exam_label, exam_date")
            .eq("user_id", user.id)
            .maybeSingle();
          if (sprintRow) {
            const row = sprintRow as { exam_type: string; exam_label: string | null; exam_date: string };
            // Compute days-remaining against LOCAL midnight on both ends.
            // The previous code anchored on `T00:00:00Z` for both
            // "today" and "exam date", which in IST (UTC+5:30) drifted
            // half a day and could show "1 day" when the local calendar
            // was already on exam day. Local midnight stays in sync
            // with the user's calendar regardless of timezone.
            const now = new Date();
            const localTodayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const [y, m, d] = row.exam_date.split("-").map((n) => parseInt(n, 10));
            const examLocalMidnight = new Date(y, (m || 1) - 1, d || 1);
            const days = Math.round((examLocalMidnight.getTime() - localTodayMidnight.getTime()) / 86400000);
            const labelMap: Record<string, string> = { JEE_MAIN: "JEE Main", NEET: "NEET", CAT: "CAT" };
            const exam_name = row.exam_type === "CUSTOM" ? (row.exam_label || "your exam") : (labelMap[row.exam_type] || row.exam_type);
            setSprint({ exam_name, exam_date: row.exam_date, days_remaining: days });
          }
        } catch { /* migration 14 not yet applied — silent skip */ }
      }

      const { data } = await sb
        .from("quiz_attempts")
        .select("*, quiz:quizzes(name, code)")
        .eq("student_id", user.id)
        .order("started_at", { ascending: false });
      const rawRows = (data as unknown as AttemptRow[]) || [];

      // School students see ONLY class-assigned quizzes on this
      // dashboard. Personal practice is filtered out completely —
      // it lives on /student/tests ("My Practice") and never mixes
      // into the class-scope numbers, BloomHero, or assigned list
      // here. Independent students have no class scope; their full
      // list IS personal practice by definition.
      let rows: AttemptRow[];
      if (me.is_school_student) {
        const classQuizIds = await loadClassQuizIds(sb);
        rows = rawRows.filter((a) => a.quiz_id && classQuizIds.has(a.quiz_id));
      } else {
        rows = rawRows;
      }
      setAttempts(rows);

      if (me.is_school_student) {
        const { data: asg } = await sb
          .from("quiz_assignments")
          .select(`
            id, due_at, created_at, class_id, student_id,
            quiz:quizzes(id, name, code, subject, time_limit_minutes),
            class:classes(name)
          `)
          .order("due_at", { ascending: true, nullsFirst: false });
        type AsgRow = {
          id: string; due_at: string | null; created_at: string;
          class_id: string | null; student_id: string | null;
          quiz: { id: string; name: string; code: string; subject: string | null; time_limit_minutes: number } | null;
          class: { name: string } | null;
        };
        const list = ((asg as unknown as AsgRow[]) || []).filter((a) => a.quiz);
        const submittedQuizIds = new Set(rows.filter((a) => a.submitted_at).map((a) => a.quiz?.code).filter(Boolean));
        const open = list.filter((a) => a.quiz && !submittedQuizIds.has(a.quiz.code));

        const quizIds = Array.from(new Set(open.map((a) => a.quiz!.id)));
        const counts = new Map<string, number>();
        if (quizIds.length > 0) {
          const { data: qq } = await sb
            .from("quiz_questions")
            .select("quiz_id, question_id")
            .in("quiz_id", quizIds);
          ((qq as Array<{ quiz_id: string; question_id: string }> | null) || []).forEach((r) => {
            counts.set(r.quiz_id, (counts.get(r.quiz_id) || 0) + 1);
          });
        }

        // Pull latest non-denied retake/extension request per assignment.
        // We treat 'pending' and 'approved' as live state; 'denied' resets
        // the row so the student can ask again with a fresh note (and we
        // only render denied state for past-due items via MissedAssignments).
        const assignmentIds = open.map((a) => a.id);
        type ReqRow = { id: string; assignment_id: string; status: "pending" | "approved" | "denied"; decision_note: string | null; created_at: string };
        let requestByAssignment = new Map<string, ReqRow>();
        if (assignmentIds.length > 0) {
          const { data: reqs } = await sb
            .from("quiz_retake_requests")
            .select("id, assignment_id, status, decision_note, created_at")
            .in("assignment_id", assignmentIds)
            .eq("student_id", user.id)
            .order("created_at", { ascending: false });
          // Take the most recent per assignment (already sorted desc).
          ((reqs as ReqRow[]) || []).forEach((r) => {
            if (!requestByAssignment.has(r.assignment_id)) {
              requestByAssignment.set(r.assignment_id, r);
            }
          });
        }

        setAssigned(open.map((a) => {
          const req = requestByAssignment.get(a.id) || null;
          return {
            id: a.id,
            due_at: a.due_at,
            assigned_at: a.created_at,
            via: a.class_id ? "class" : "direct",
            via_label: a.class_id ? (a.class?.name || "Class") : "Assigned to you",
            quiz: a.quiz ? {
              id: a.quiz.id,
              name: a.quiz.name,
              code: a.quiz.code,
              subject: a.quiz.subject,
              time_limit_minutes: a.quiz.time_limit_minutes,
              question_count: counts.get(a.quiz.id) || 0,
            } : null,
            request: req
              ? { id: req.id, status: req.status, decision_note: req.decision_note }
              : null,
          };
        }));
      }

      // Bloom mastery — computed for the active dashboard scope only
      // (class for school students, all-personal-practice for
      // independent ones). `rows` is already scope-filtered above so
      // this naturally shows only the right data without any extra
      // bucketing logic.
      const submittedIds = rows.filter((a) => a.submitted_at).map((a) => a.id);
      if (submittedIds.length > 0) {
        const { data: ans } = await sb
          .from("attempt_answers")
          .select("bloom_level, is_correct")
          .in("attempt_id", submittedIds);
        const breakdown: BloomBreakdown = {};
        ((ans as Array<{ bloom_level: string; is_correct: boolean | null }>) || []).forEach((a) => {
          if (!breakdown[a.bloom_level]) breakdown[a.bloom_level] = { correct: 0, total: 0 };
          breakdown[a.bloom_level].total++;
          if (a.is_correct) breakdown[a.bloom_level].correct++;
        });
        setBloomMastery(breakdown);
      }

      // SRS due count — best-effort. Migration 15 may not be applied;
      // we just hide the card silently if so.
      try {
        const today = new Date();
        const todayStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
        const { count } = await sb
          .from("srs_reviews")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .lte("due_at", todayStr);
        if (typeof count === "number") setSrsDueCount(count);
      } catch { /* migration 15 not applied — silent skip */ }

      setLoading(false);
    })();
  }, []);

  if (loadError) {
    return (
      <div className="max-w-md mx-auto mt-20 card text-center">
        <div className="text-3xl mb-2">⚠️</div>
        <div className="font-semibold mb-1">Couldn&apos;t load your dashboard</div>
        <div className="text-sm muted mb-4">{loadError}</div>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Refresh
        </button>
      </div>
    );
  }
  if (loading || isSchool === null) {
    return <div className="grid place-items-center py-20"><div className="spinner" /></div>;
  }

  const completed = attempts.filter((a) => a.submitted_at);
  const avg = completed.length ? Math.round(completed.reduce((s, a) => s + pct(a.score, a.total), 0) / completed.length) : 0;

  // ============ INDEPENDENT STUDENT HOME ============
  if (!isSchool) {
    // First-time onboarding: capture exam goal before showing the dashboard.
    // School students skip this entirely (their goal is dictated by the class).
    if (!examGoal) {
      return (
        <div className="py-8">
          <StudentGoalPicker onPicked={(g) => setExamGoal(g)} />
        </div>
      );
    }

    // Look up the chosen goal's display label for the chip on the dashboard.
    const goalMeta = STUDENT_GOALS.find((g) => g.id === examGoal);

    return (
      <div className="max-w-5xl mx-auto fade-in">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="h1">Hi{name ? `, ${name.split(" ")[0]}` : ""} 👋</h1>
            <p className="muted mt-1">Generate a practice test, take it, watch your scores climb.</p>
          </div>
          <CurrentPlanBadge />
        </div>

        {/* Goal chip — shows what the student picked at onboarding, with a
            link back to the picker so they can change it. */}
        {goalMeta && (
          <div className="mt-3 inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200">
            <span>{goalMeta.emoji}</span>
            <span className="text-emerald-900">
              <span className="muted">Preparing for:</span>{" "}
              <strong>{goalMeta.label}</strong>
            </span>
            <button
              type="button"
              onClick={() => setExamGoal(null)}
              className="text-emerald-700 hover:underline font-semibold ml-1"
            >
              change
            </button>
          </div>
        )}

        {/* BloomIQ Score discovery hero — first-run only. Shown when we
            know the student has not yet calibrated. Disappears once they
            complete the 7-minute Bloom calibration; from then on, the
            persistent BloomIQScoreBadge in the layout's top-right
            carries the score everywhere. This is the killer first-
            impression real estate — placed above the at-a-glance
            scorecard so it's the dominant element of a fresh dashboard. */}
        {hasBloomIQ === false && (
          <Link
            href="/student/bloom-score"
            className="block mt-4 rounded-2xl p-5 transition-all hover:scale-[1.01]"
            style={{
              background: "linear-gradient(135deg, rgba(16,185,129,0.10) 0%, rgba(99,102,241,0.10) 100%)",
              border: "1px solid rgba(99,102,241,0.3)",
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-wider opacity-60">
                  New &middot; 7 minutes
                </div>
                <div className="text-xl md:text-2xl font-bold mt-0.5">
                  Discover your BloomIQ Score
                </div>
                <p className="text-sm opacity-80 mt-1 max-w-lg">
                  A single 3-digit score (300&ndash;900) plus an indicative
                  readiness band for your exam goal &mdash; based on <em>how</em>
                  you think across all six levels of Bloom&apos;s Taxonomy. Plus a
                  stretch target showing where your score could move if you
                  strengthen your weakest areas.
                </p>
                <p className="text-[10px] opacity-60 mt-1 max-w-lg">
                  Self-assessment heuristic. Not a prediction of exam rank, admission, or
                  outcome at any institution.
                </p>
              </div>
              <div className="hidden md:grid w-20 h-20 place-items-center rounded-xl flex-shrink-0"
                   style={{ background: "linear-gradient(135deg, #10b981 0%, #6366f1 100%)" }}>
                <Sparkles className="text-white" size={28} />
              </div>
            </div>
            <div className="mt-3 inline-flex items-center gap-2 text-sm font-semibold"
                 style={{ color: "#6366f1" }}>
              Start calibration <span aria-hidden>&rarr;</span>
            </div>
          </Link>
        )}

        {/* At-a-glance scorecard — only renders for students with at least
            one submitted attempt. For brand-new students the same numbers
            would be 0 / — / — across the board, which adds noise; the
            BloomHero below has a friendly empty state with a CTA that
            covers their starting case instead. For returning students
            this is the headline answer to "how am I doing?" — placed
            above all secondary surfaces so it's the first thing their
            eye lands on after the greeting. */}
        {completed.length > 0 && (
          <div className="grid sm:grid-cols-3 gap-3 mt-4">
            <div className="card">
              <div className="text-xs muted uppercase font-semibold">Tests taken</div>
              <div className="text-3xl font-bold">{completed.length}</div>
            </div>
            <div className="card">
              <div className="text-xs muted uppercase font-semibold">Average score</div>
              <div className="text-3xl font-bold">{`${avg}%`}</div>
            </div>
            <div className="card">
              <div className="text-xs muted uppercase font-semibold">Best level so far</div>
              <div className="text-2xl font-bold">{bestLevel(bloomMastery) || "—"}</div>
            </div>
          </div>
        )}

        {/* Renewal banner — only renders for paid independent subscriptions
            within 7 days of expiry or already expired. School students
            don't see this (school renews via offline contract). */}
        <RenewBanner
          expiresAt={access.expiresAt}
          isExpired={access.isExpired}
          isInGrace={access.isInGrace}
          graceRemainingDays={access.graceRemainingDays}
          daysLeft={access.daysLeft}
          planSlug={access.planSlug}
          source={access.source}
        />

        {/* No onboarding checklist for independent students either. The
            BloomHero below already shows a friendly empty state with a
            "Generate your first test" CTA when there's no data, which
            covers the new-user case without a separate scaffold; and
            once they have data the checklist would just be visual
            noise. Goal-pick is still enforced upstream via
            StudentGoalPicker. (Originally Phase 1 #1; removed across
            both flows after the school-flow removal proved the
            dashboard reads cleaner without it.) */}

        {/* Bloom heat-map hero — the visual anchor of the dashboard, now
            promoted to first-thing-seen (per Phase 1 Item #5). When the
            student has data, it shows strongest + weakest Bloom levels
            with a "Drill it" CTA — that's the single sentence story we
            want them to land on. Empty state shows "Take your first
            practice test" — also handled by the checklist above. */}
        <BloomHero mastery={bloomMastery} />

        {sprint && sprint.days_remaining >= 0 && (
          <Link
            href="/student/sprint"
            className={`mt-3 inline-flex items-center gap-3 rounded-xl border-2 px-4 py-2.5 transition ${
              sprint.days_remaining < 7
                ? "border-red-300 bg-red-50 hover:bg-red-100 text-red-900"
                : sprint.days_remaining < 30
                ? "border-orange-300 bg-orange-50 hover:bg-orange-100 text-orange-900"
                : "border-emerald-300 bg-emerald-50 hover:bg-emerald-100 text-emerald-900"
            }`}
          >
            <CalendarDays size={18} />
            <span className="text-sm">
              <strong className="text-base">{sprint.days_remaining} days</strong> to {sprint.exam_name}
            </span>
            <span className="text-xs opacity-80">— see today&apos;s mission →</span>
          </Link>
        )}

        {!sprint && (
          <Link
            href="/student/sprint"
            className="mt-3 inline-flex items-center gap-2 text-xs text-slate-600 hover:text-emerald-700 px-2 py-1"
          >
            <CalendarDays size={14} /> Got an exam coming up? Set up Exam Sprint →
          </Link>
        )}

        {freeRemaining !== null && freeCap !== null && (
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <div className={`inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border ${
              freeRemaining === 0
                ? "bg-red-50 border-red-200 text-red-800"
                : freeRemaining <= 1
                ? "bg-amber-50 border-amber-200 text-amber-800"
                : "bg-emerald-50 border-emerald-200 text-emerald-800"
            }`}>
              <strong>{freeRemaining}</strong> of <strong>{freeCap}</strong> free attempts left today
              {freeRemaining === 0 && <span> upgrade or come back tomorrow</span>}
            </div>
            <Link href="/pricing" className="text-xs text-emerald-700 font-semibold underline">
              View plans →
            </Link>
          </div>
        )}

        <div className="mt-6 rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-600 text-white p-6 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="text-xs uppercase tracking-wide opacity-80 font-semibold">Ready to study?</div>
            <div className="text-2xl font-bold mt-1">Generate a practice test</div>
            <div className="text-sm opacity-90 mt-1">From a topic, your class notes, a syllabus or upload last year&apos;s exam paper.</div>
          </div>
          <Link href="/student/generate" className="bg-white text-emerald-700 hover:bg-emerald-50 font-semibold rounded-lg px-5 py-3 flex items-center gap-2 whitespace-nowrap">
            <Sparkles size={18} /> New test
          </Link>
        </div>

        <Link
          href="/student/generate"
          className="mt-3 block rounded-xl border-2 border-amber-300 bg-amber-50 hover:bg-amber-100 transition p-4 flex items-center gap-3"
        >
          <span className="text-2xl">🎯</span>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-amber-900">Cracking an exam soon?</div>
            <div className="text-xs text-amber-900/80">
              Upload last year&apos;s question paper get fresh questions in the same difficulty and style.
            </div>
          </div>
          <span className="text-xs uppercase tracking-wide font-bold text-amber-900 bg-amber-200 rounded-full px-2 py-1 whitespace-nowrap">Past paper</span>
        </Link>

        <div className="mt-8">
          <div className="flex items-center gap-2 mb-3">
            <h2 className="h2">Reflect on your progress</h2>
          </div>
          <div className="grid sm:grid-cols-3 gap-3">
            <Link href="/student/coach" className="card card-hover flex items-start gap-3">
              <div className="rounded-lg bg-emerald-100 text-emerald-700 p-2 shrink-0"><MessageCircle size={18} /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">Performance Coach</div>
                <div className="text-xs muted mt-1">Reflect on your progress.</div>
              </div>
            </Link>
            <Link href="/student/digest" className="card card-hover flex items-start gap-3">
              <div className="rounded-lg bg-sky-100 text-sky-700 p-2 shrink-0"><Sparkles size={18} /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">This Week</div>
                <div className="text-xs muted mt-1">Your weekly briefing.</div>
              </div>
            </Link>
            <Link href="/student/practice" className="card card-hover flex items-start gap-3">
              <div className="rounded-lg bg-rose-100 text-rose-700 p-2 shrink-0"><Target size={18} /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">Adaptive Practice</div>
                <div className="text-xs muted mt-1">5 questions tuned to your weakest level.</div>
              </div>
            </Link>
            <Link href="/student/drill" className="card card-hover flex items-start gap-3">
              <div className="rounded-lg bg-amber-100 text-amber-700 p-2 shrink-0"><Zap size={18} /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">Today&apos;s drill</div>
                <div className="text-xs muted mt-1">5 questions targeted at your weakest spots.</div>
              </div>
            </Link>
            {srsDueCount > 0 && (
              <Link href="/student/memory" className="card card-hover flex items-start gap-3 border-cyan-200 bg-cyan-50/40">
                <div className="rounded-lg bg-cyan-100 text-cyan-700 p-2 shrink-0"><Clock size={18} /></div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold">{srsDueCount} review{srsDueCount === 1 ? "" : "s"} due today</div>
                  <div className="text-xs muted mt-1">Spaced-repetition queue is calling.</div>
                </div>
              </Link>
            )}
          </div>
        </div>

        {/* ============ Verb-categorised feature tiles (Phase 3 #2) ============
            Replaces the previous "Recommended for you / More tools" model
            with a Test / Train / Diagnose / Share grouping driven by
            TileMeta.category. The order WITHIN each category is still
            goal-aware (primary tiles first, then secondary) — so a JEE
            student sees Sprint at the top of Train, while a Class-10
            student sees Teach-Back there.

            "Test" doesn't pull from TILE_META (no tiles are categorised
            as 'test' — practice tests live behind the dedicated /student/
            generate flow). We render a CTA card for it instead. */}
        {(() => {
          const buckets = tilesByCategoryForGoal(examGoal);
          const renderTile = (key: typeof buckets["train"][number]) => {
            const meta = TILE_META[key];
            const fk = meta.featureKey;
            const locked = !access.isLoading && !!fk && !access.allowed.has(fk);
            return (
              <StudentFeatureTile
                key={key}
                meta={meta}
                fullWidth={key === "sprint"}
                locked={locked}
                lockedTierLabel={fk ? unlockMap[fk]?.label : undefined}
                onLockedClick={openPaywall}
              />
            );
          };

          return (
            <>
              {/* Train your skills — the densest category. Primary tiles
                  for the active goal sort to the top; secondary collapse
                  into a "More" expander to keep above-the-fold tight. */}
              {buckets.train.length > 0 && (
                <section className="mt-8">
                  <div className="flex items-center gap-2 mb-1">
                    <h2 className="h2">{CATEGORY_META.train.label}</h2>
                    {goalMeta && (
                      <span className="text-[10px] uppercase tracking-wide font-bold text-emerald-700 bg-emerald-100 rounded-full px-2 py-0.5">
                        Sorted for {goalMeta.label}
                      </span>
                    )}
                  </div>
                  <p className="text-xs muted mb-3 max-w-2xl">{CATEGORY_META.train.intro}</p>
                  <div className="grid sm:grid-cols-2 gap-3">
                    {buckets.train.slice(0, 4).map(renderTile)}
                  </div>
                  {buckets.train.length > 4 && (
                    <details className="mt-3 group">
                      <summary className="cursor-pointer list-none text-sm font-semibold text-emerald-700">
                        Show {buckets.train.length - 4} more →
                      </summary>
                      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
                        {buckets.train.slice(4).map(renderTile)}
                      </div>
                    </details>
                  )}
                </section>
              )}

              {/* Diagnose a weakness — analytical tools. Smaller list, no
                  collapse needed. */}
              {buckets.diagnose.length > 0 && (
                <section className="mt-8">
                  <h2 className="h2">{CATEGORY_META.diagnose.label}</h2>
                  <p className="text-xs muted mb-3 max-w-2xl">{CATEGORY_META.diagnose.intro}</p>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {buckets.diagnose.map(renderTile)}
                  </div>
                </section>
              )}

              {/* Share — currently just the parent-share tile, but
                  reserved as its own section so future share affordances
                  (export PDF, share link) land here naturally. */}
              {buckets.share.length > 0 && (
                <section className="mt-8">
                  <h2 className="h2">{CATEGORY_META.share.label}</h2>
                  <p className="text-xs muted mb-3 max-w-2xl">{CATEGORY_META.share.intro}</p>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {buckets.share.map(renderTile)}
                  </div>
                </section>
              )}
            </>
          );
        })()}

        {/* Note: the "Your thinking-level breakdown" card that used to
            live here was removed — it duplicated the BloomHero pyramid
            above. Full per-level deep-dive (with trends, topic
            breakdowns, etc.) lives at /student/progress. */}

        <h2 className="h2 mt-8 mb-3 flex items-center gap-2"><NotebookPen size={20} /> Recent tests</h2>
        {attempts.length === 0 ? (
          <Empty
            icon="🎯"
            title="No tests yet"
            body="Generate your first practice test to start tracking your progress."
            action={<Link href="/student/generate" className="btn btn-primary">Create a test</Link>}
          />
        ) : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase muted">
                <tr>
                  <th className="px-4 py-3 text-left">Test</th>
                  <th className="px-4 py-3 text-left">Score</th>
                  <th className="px-4 py-3 text-left">Date</th>
                  <th className="px-4 py-3 text-right">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {attempts.slice(0, 10).map((a) => (
                  <tr key={a.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium">{a.quiz?.name || "Test"}</td>
                    <td className="px-4 py-3">
                      {a.submitted_at ? <strong>{a.score}/{a.total} ({pct(a.score, a.total)}%)</strong> : <span className="badge badge-pending">In progress</span>}
                    </td>
                    <td className="px-4 py-3 muted">{a.submitted_at ? new Date(a.submitted_at).toLocaleDateString() : ""}</td>
                    <td className="px-4 py-3 text-right">
                      {a.submitted_at && <Link className="text-emerald-700 font-semibold" href={`/student/results/${a.id}`}>View </Link>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Paywall modal — opens when a free user clicks a Premium-locked
            tile, or a Premium user clicks a Premium Plus-locked tile. */}
        <PaywallModal
          open={!!paywall.key}
          onClose={() => setPaywall({ key: "", tier: null })}
          featureKey={paywall.key || null}
          unlockingTier={paywall.tier}
          currentTier={access.planTier}
        />
      </div>
    );
  }

  // ============ SCHOOL STUDENT HOME ============
  function relativeDue(due: Date): string {
    const ms = due.getTime() - Date.now();
    const abs = Math.abs(ms);
    const mins = Math.floor(abs / 60_000);
    const hours = Math.floor(abs / 3_600_000);
    const days = Math.floor(abs / (24 * 3_600_000));
    if (ms < 0) {
      if (mins < 60) return `${mins} min overdue`;
      if (hours < 24) return `${hours} h overdue`;
      return `${days} day${days === 1 ? "" : "s"} overdue`;
    }
    if (mins < 60) return `in ${mins} min`;
    if (hours < 24) return `in ${hours} h`;
    return `in ${days} day${days === 1 ? "" : "s"}`;
  }

  return (
    <div className="max-w-5xl mx-auto fade-in">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="h1">Hi{name ? `, ${name.split(" ")[0]}` : ""} 👋</h1>
          <p className="muted mt-1">Ready to test your thinking?</p>
        </div>
        <CurrentPlanBadge />
      </div>

      <MissedAssignments />

      {/* ============ CLASS SCOPE ============
          Everything from here down to the "Personal practice" divider
          covers the student's TEACHER-ASSIGNED quizzes. Numbers,
          mastery, and lists below are filtered to class-scope only —
          the official record the teacher and school care about. */}
      <div className="mt-6 mb-2 flex items-center gap-2">
        <h2 className="h2 mb-0">Your assigned work</h2>
        <span className="text-[10px] uppercase tracking-wide font-bold text-emerald-700 bg-emerald-100 rounded-full px-2 py-0.5">
          Class
        </span>
      </div>

      {/* Live class quiz join lives in the sidebar at /student/live —
          one click from anywhere, doesn't crowd the dashboard, and
          (importantly) keeps live engagement physically separate from
          the official class-record surface here. Live scores never
          enter quiz_attempts and so never roll up into the stats /
          BloomHero / progress / admin reports — the table separation
          enforces that, no app-level filter required. */}

      <h2 className="h2 mt-4 mb-3 flex items-center gap-2">
        <ClipboardList size={20} /> Assigned to you
        {assigned.length > 0 && <span className="text-sm font-normal muted">({assigned.length})</span>}
      </h2>
      {assigned.length === 0 ? (
        <div className="card text-center py-8 muted text-sm">
          Nothing assigned right now. Your teacher will push tests here as they&apos;re ready.
        </div>
      ) : (
        <div className="space-y-3">
          {assigned.map((a) => {
            const due = a.due_at ? new Date(a.due_at) : null;
            const overdue = !!due && due.getTime() < Date.now();
            const dueSoon = !!due && !overdue && (due.getTime() - Date.now()) < 24 * 3600_000;
            const accent =
              overdue ? "border-red-300 bg-red-50/40" :
              dueSoon ? "border-amber-300 bg-amber-50/40" :
              "border-slate-200";
            return (
              <div key={a.id} className={`card flex items-start gap-4 flex-wrap border-l-4 ${accent}`}>
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-slate-900 text-base">{a.quiz?.name}</div>
                  <div className="flex items-center gap-2 mt-1 flex-wrap text-xs">
                    {a.quiz?.subject && (
                      <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-semibold">{a.quiz.subject}</span>
                    )}
                    <span className={`px-2 py-0.5 rounded-full font-semibold ${a.via === "class" ? "bg-emerald-50 text-emerald-800" : "bg-sky-50 text-sky-800"}`}>
                      {a.via_label}
                    </span>
                    {a.quiz?.question_count ? (
                      <span className="muted inline-flex items-center gap-1"><ListChecks size={11} /> {a.quiz.question_count} question{a.quiz.question_count === 1 ? "" : "s"}</span>
                    ) : null}
                    {a.quiz && (
                      <span className="muted inline-flex items-center gap-1"><Clock size={11} /> {a.quiz.time_limit_minutes} min</span>
                    )}
                  </div>
                  <div className={`mt-2 inline-flex items-center gap-1.5 text-sm font-semibold ${
                    overdue ? "text-red-700" : dueSoon ? "text-amber-700" : "text-slate-700"
                  }`}>
                    {overdue ? <AlertCircle size={14} /> : <CalendarDays size={14} />}
                    {due ? (
                      <>
                        <span>Due {due.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span>
                        <span className="text-slate-500 font-normal">at {due.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
                        <span className={overdue ? "text-red-700" : dueSoon ? "text-amber-700" : "text-slate-500"}> {relativeDue(due)}</span>
                      </>
                    ) : (
                      <span className="text-slate-500 font-normal">No due date take it whenever</span>
                    )}
                  </div>
                  <div className="text-[11px] muted mt-1 flex items-center gap-3 flex-wrap">
                    <span>
                      Assigned {new Date(a.assigned_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </span>
                    {/* Pre-due-date extension request — student can ask
                        the teacher to push the due date out before they
                        actually miss it. Past-due (overdue) items are
                        instead handled by the MissedAssignments component
                        higher up the page, which renders the same kind
                        of request UI but with "missed" framing. Both
                        write to the same quiz_retake_requests row. */}
                    {!overdue && (
                      <ExtensionRequestButton
                        assignmentId={a.id}
                        existingRequest={a.request}
                      />
                    )}
                  </div>
                </div>
                {a.quiz && (
                  <Link href={`/student/quiz/${a.quiz.code}`} className={`btn ${overdue ? "btn-danger" : dueSoon ? "btn-primary" : "btn-primary"}`}>
                    <Play size={14} /> {overdue ? "Take now" : "Start"}
                  </Link>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* At-a-glance scorecard — labelled "Class quizzes" so the
          scoping is unambiguous. These numbers reflect ONLY teacher-
          assigned quizzes (filtered upstream against class_quiz_ids).
          Personal practice — if the school plan ever exposes it — is
          a separate scope and would have its own stats panel, never
          mixed into these. */}
      <div className="grid sm:grid-cols-2 gap-3 mt-4">
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Class tests taken</div>
          <div className="text-3xl font-bold">{completed.length}</div>
        </div>
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Class average</div>
          <div className="text-3xl font-bold">{completed.length ? `${avg}%` : "—"}</div>
        </div>
      </div>

      {/* No onboarding checklist for school students. The "Assigned to
          you" section above already tells them what to do (literally,
          with a Start button on every card), so a separate "take your
          first quiz" reminder was redundant noise. Their Bloom hero
          below auto-fills after the first attempt — that flow is
          self-explanatory and doesn't need a checklist scaffold. */}

      {/* Bloom mastery hero — promoted to first-thing-seen for school
          students too (Phase 2 #5). Same component as the independent
          flow; renders empty state with a "take a test" CTA when no data,
          strongest/weakest callouts with "Drill it" link when data exists. */}
      <BloomHero mastery={bloomMastery} />

      {/* "Reflect on your progress" tiles used to live here. They've moved
          out of the dashboard — sidebar's "My Progress" link is now the
          dedicated home for Performance Coach / This Week / Adaptive
          Practice / drill / memory. Keeps the dashboard focused on
          "what's pending now" instead of repeating sidebar destinations. */}

      {/* ============ Quick actions ============
          Focused do-this-now strip. The full feature catalogue lives in
          the sidebar's "Practice" group; BloomHero above already surfaces
          which feature to drill based on the weakest Bloom level. So
          home doesn't re-tile every feature anymore — that was the
          "casino dashboard" pattern (every feature shown twice, once on
          home and once in nav, which crowds the page and pushes the
          student to make a decision instead of starting work).

          Two items here, picked because they are the only ones whose
          one-click access materially helps from the dashboard:

            1. Take a practice test — the most common self-initiated
               action a school student takes. Big CTA so it reads as
               the primary do-this-now path that doesn't belong to a
               teacher-assigned cycle.
            2. Share with a parent — kept as a tile because it's the
               only feature that has no sidebar entry (it's lightweight
               and occasional, not navigation-bar material). Always-on,
               no plan gating, no paywall path. */}
      <section className="mt-8">
        <h2 className="h2">Quick actions</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
          <Link
            href="/student/generate"
            className="card flex items-start gap-3 hover:bg-emerald-50/60 transition border-emerald-200 bg-emerald-50/30"
          >
            <div className="rounded-xl bg-emerald-100 text-emerald-700 p-3 shrink-0">
              <Sparkles size={22} />
            </div>
            <div className="flex-1">
              <div className="font-bold">Take a practice test</div>
              <div className="text-xs muted mt-0.5">
                Self-paced. Doesn&apos;t affect your class stats. Generate one on any topic.
              </div>
            </div>
          </Link>
          <StudentFeatureTile
            meta={TILE_META.parent_share}
            locked={false}
            onLockedClick={openPaywall}
          />
        </div>
      </section>

      {/* "Your attempts" table used to render here. Moved to its own
          page at /student/tests, reachable from the sidebar's "My
          Attempts" link. The dashboard now stays focused on what's
          pending; the history is one click away when the student wants
          to look back. */}

      {/* Paywall modal for school students — opens when they click a
          locked tile. Variant routes them to email their Admin Head
          rather than /pricing, since school students can't self-upgrade. */}
      <PaywallModal
        open={!!paywall.key}
        onClose={() => setPaywall({ key: "", tier: null })}
        featureKey={paywall.key || null}
        unlockingTier={paywall.tier}
        currentTier={access.planTier}
        isSchoolStudent
      />
    </div>
  );
}

function bestLevel(b: BloomBreakdown): string {
  let bestPct = -1;
  let best = "";
  for (const [lvl, d] of Object.entries(b)) {
    if (!d.total) continue;
    const p = (d.correct / d.total) * 100;
    if (p > bestPct) { bestPct = p; best = lvl; }
  }
  if (!best) return "";
  return BLOOM_META[best as keyof typeof BLOOM_META]?.label || best;
}
