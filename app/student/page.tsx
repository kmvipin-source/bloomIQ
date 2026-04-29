"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { QuizAttempt } from "@/lib/types";
import { pct } from "@/lib/utils";
import Empty from "@/components/Empty";
import { ClipboardList, Clock, Play, Sparkles, TrendingUp, NotebookPen, AlertCircle, CalendarDays, ListChecks, GraduationCap, Search, ScanSearch, Timer, Crosshair, Trophy, Bot, Film, Brain, Gauge, Users, Mic, Network, MessageCircle, Target, Zap } from "lucide-react";
import { BLOOM_LEVELS, BLOOM_META, blankBloomCounts } from "@/lib/bloom";

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
};

type BloomBreakdown = Record<string, { correct: number; total: number }>;

export default function StudentHome() {
  const [name, setName] = useState("");
  const [isSchool, setIsSchool] = useState<boolean | null>(null);
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [assigned, setAssigned] = useState<AssignedRow[]>([]);
  const [bloomMastery, setBloomMastery] = useState<BloomBreakdown>({});
  const [loading, setLoading] = useState(true);

  // Free-tier daily attempt tracking (independent students only).
  // freeRemaining = null means "not capped" (school student or paid tier).
  const [freeRemaining, setFreeRemaining] = useState<number | null>(null);
  const [freeCap, setFreeCap] = useState<number | null>(null);

  // Exam Sprint countdown — null when not configured.
  const [sprint, setSprint] = useState<{ exam_name: string; exam_date: string; days_remaining: number } | null>(null);

  // Number of SRS reviews due today. 0 (or null on RPC failure) hides the card.
  const [srsDueCount, setSrsDueCount] = useState<number>(0);

  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;

      const { data: prof } = await sb
        .from("profiles")
        .select("full_name, is_school_student")
        .eq("id", user.id)
        .single();
      setName(prof?.full_name || "");
      setIsSchool(!!prof?.is_school_student);

      if (prof && !prof.is_school_student) {
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
            const todayMs = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").getTime();
            const examMs = new Date(row.exam_date + "T00:00:00Z").getTime();
            const days = Math.round((examMs - todayMs) / 86400000);
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
      const rows = (data as unknown as AttemptRow[]) || [];
      setAttempts(rows);

      if (prof?.is_school_student) {
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

        setAssigned(open.map((a) => ({
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
        })));
      } else {
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

  if (loading || isSchool === null) {
    return <div className="grid place-items-center py-20"><div className="spinner" /></div>;
  }

  const completed = attempts.filter((a) => a.submitted_at);
  const avg = completed.length ? Math.round(completed.reduce((s, a) => s + pct(a.score, a.total), 0) / completed.length) : 0;

  // ============ INDEPENDENT STUDENT HOME ============
  if (!isSchool) {
    return (
      <div className="max-w-5xl mx-auto fade-in">
        <h1 className="h1">Hi{name ? `, ${name.split(" ")[0]}` : ""} 👋</h1>
        <p className="muted mt-1">Generate a practice test, take it, watch your scores climb.</p>

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

        <div className="mt-8">
          <div className="flex items-center gap-2 mb-3">
            <h2 className="h2">Boost your learning</h2>
            <span className="text-[10px] uppercase tracking-wide font-bold text-emerald-700 bg-emerald-100 rounded-full px-2 py-0.5">New</span>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <Link href="/student/teach-back" className="card card-hover flex items-start gap-3">
              <div className="rounded-lg bg-emerald-100 text-emerald-700 p-2 shrink-0"><GraduationCap size={18} /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">Teach-Back</div>
                <div className="text-xs muted mt-1">Explain a topic in your own words. We grade you on Bloom&apos;s rubric and ask one sharp follow-up.</div>
              </div>
            </Link>

            <Link href="/student/misconceptions" className="card card-hover flex items-start gap-3">
              <div className="rounded-lg bg-amber-100 text-amber-700 p-2 shrink-0"><Search size={18} /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">Misconception Detective</div>
                <div className="text-xs muted mt-1">Find the *specific* mental error behind each wrong answer, then drill it away.</div>
              </div>
            </Link>

            <Link href="/student/xray" className="card card-hover flex items-start gap-3">
              <div className="rounded-lg bg-sky-100 text-sky-700 p-2 shrink-0"><ScanSearch size={18} /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">Past-Paper X-Ray</div>
                <div className="text-xs muted mt-1">Upload last year&apos;s paper. We tag every question by Bloom level + topic and give you 5 study targets.</div>
              </div>
            </Link>
          </div>
        </div>

        <div className="mt-8">
          <div className="flex items-center gap-2 mb-3">
            <h2 className="h2">Ace competitive exams</h2>
            <span className="text-[10px] uppercase tracking-wide font-bold text-amber-700 bg-amber-100 rounded-full px-2 py-0.5">New</span>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <Link href="/student/sprint" className="card card-hover flex items-start gap-3 sm:col-span-2 border-emerald-200 bg-emerald-50/30">
              <div className="rounded-lg bg-emerald-100 text-emerald-700 p-2 shrink-0"><CalendarDays size={18} /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">Exam Sprint Mode</div>
                <div className="text-xs muted mt-1">Set your exam date. Get a daily 3-task mission tuned to how far out it is — foundation now, sprint as it nears, revision-only in the final week.</div>
              </div>
            </Link>

            <Link href="/student/speed" className="card card-hover flex items-start gap-3">
              <div className="rounded-lg bg-orange-100 text-orange-700 p-2 shrink-0"><Timer size={18} /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">Speed-Accuracy Trainer</div>
                <div className="text-xs muted mt-1">Each question gets a target time based on its Bloom level. Fast+right is exam-ready; slow+right means you need pace work.</div>
              </div>
            </Link>

            <Link href="/student/traps" className="card card-hover flex items-start gap-3">
              <div className="rounded-lg bg-rose-100 text-rose-700 p-2 shrink-0"><Crosshair size={18} /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">Distractor Trap Detector</div>
                <div className="text-xs muted mt-1">Find which examiner-trap patterns you fall for most — unit confusion, sign errors, NOT-misreads, off-by-one, and more.</div>
              </div>
            </Link>

            <Link href="/student/rank" className="card card-hover flex items-start gap-3">
              <div className="rounded-lg bg-amber-100 text-amber-700 p-2 shrink-0"><Trophy size={18} /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">Mock Rank Predictor</div>
                <div className="text-xs muted mt-1">Convert any score into an AIR estimate against JEE/NEET/CAT-sized cohorts. See exactly where to gain marks.</div>
              </div>
            </Link>

            <Link href="/student/tutor" className="card card-hover flex items-start gap-3">
              <div className="rounded-lg bg-indigo-100 text-indigo-700 p-2 shrink-0"><Bot size={18} /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">Doubt-Clearing AI Tutor</div>
                <div className="text-xs muted mt-1">A 24/7 Socratic tutor. Type your doubt, get walked through it step by step — no answer dumps.</div>
              </div>
            </Link>
          </div>
        </div>

        <div className="mt-8">
          <div className="flex items-center gap-2 mb-3">
            <h2 className="h2">Learn deeper, retain longer</h2>
            <span className="text-[10px] uppercase tracking-wide font-bold text-fuchsia-700 bg-fuchsia-100 rounded-full px-2 py-0.5">New</span>
          </div>
          <div className="grid sm:grid-cols-3 gap-3">
            <Link href="/student/visualizer" className="card card-hover flex items-start gap-3">
              <div className="rounded-lg bg-fuchsia-100 text-fuchsia-700 p-2 shrink-0"><Film size={18} /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">Concept Visualizer</div>
                <div className="text-xs muted mt-1">Type any concept — get an animated, narrated explainer. Best for the things that don&apos;t click from words.</div>
              </div>
            </Link>

            <Link href="/student/memory" className="card card-hover flex items-start gap-3">
              <div className="rounded-lg bg-cyan-100 text-cyan-700 p-2 shrink-0"><Brain size={18} /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">Memory Tune-Up</div>
                <div className="text-xs muted mt-1">Spaced repetition for your wrong answers. 5 minutes a day, the forgetting curve never wins.</div>
              </div>
            </Link>

            <Link href="/student/calibration" className="card card-hover flex items-start gap-3">
              <div className="rounded-lg bg-teal-100 text-teal-700 p-2 shrink-0"><Gauge size={18} /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">Confidence Calibration</div>
                <div className="text-xs muted mt-1">When you say &ldquo;Sure&rdquo;, are you actually right? Train the metacognitive skill that beats negative marking.</div>
              </div>
            </Link>

            <Link href="/student/voice-teacher" className="card card-hover flex items-start gap-3">
              <div className="rounded-lg bg-violet-100 text-violet-700 p-2 shrink-0"><Mic size={18} /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">Voice AI Teacher</div>
                <div className="text-xs muted mt-1">Speak your doubt, hear the answer back, optionally see the animation. Hands-free study.</div>
              </div>
            </Link>

            <Link href="/student/graph" className="card card-hover flex items-start gap-3">
              <div className="rounded-lg bg-blue-100 text-blue-700 p-2 shrink-0"><Network size={18} /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">Knowledge Graph</div>
                <div className="text-xs muted mt-1">A visual map of every topic you&apos;ve practiced, with prerequisite arrows. Find the foundation gap.</div>
              </div>
            </Link>

            <Link href="/student/parent" className="card card-hover flex items-start gap-3">
              <div className="rounded-lg bg-pink-100 text-pink-700 p-2 shrink-0"><Users size={18} /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">Share with a parent</div>
                <div className="text-xs muted mt-1">Generate a link to share via WhatsApp. Parents see your progress read-only — no signup needed.</div>
              </div>
            </Link>
          </div>
        </div>

        <div className="grid sm:grid-cols-3 gap-4 mt-6">
          <div className="card">
            <div className="text-xs muted uppercase font-semibold">Tests taken</div>
            <div className="text-3xl font-bold">{completed.length}</div>
          </div>
          <div className="card">
            <div className="text-xs muted uppercase font-semibold">Average score</div>
            <div className="text-3xl font-bold">{completed.length ? `${avg}%` : ""}</div>
          </div>
          <div className="card">
            <div className="text-xs muted uppercase font-semibold">Best level so far</div>
            <div className="text-2xl font-bold">{bestLevel(bloomMastery) || ""}</div>
          </div>
        </div>

        {Object.keys(bloomMastery).length > 0 && (
          <div className="card mt-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold flex items-center gap-2"><TrendingUp size={18} /> Your thinking-level breakdown</h3>
              <Link href="/student/progress" className="text-sm text-emerald-700 font-semibold">Full progress </Link>
            </div>
            <div className="space-y-2">
              {BLOOM_LEVELS.map((l) => {
                const data = bloomMastery[l];
                if (!data || !data.total) return null;
                const p = Math.round((data.correct / data.total) * 100);
                return (
                  <div key={l}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="font-medium">{BLOOM_META[l].label}</span>
                      <span className="muted">{data.correct}/{data.total} {p}%</span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full" style={{ width: `${p}%`, backgroundColor: BLOOM_META[l].color }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

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
      <h1 className="h1">Hi{name ? `, ${name.split(" ")[0]}` : ""} 👋</h1>
      <p className="muted mt-1">Ready to test your thinking?</p>

      <div className="grid sm:grid-cols-3 gap-4 mt-6">
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Quizzes taken</div>
          <div className="text-3xl font-bold">{completed.length}</div>
        </div>
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Average score</div>
          <div className="text-3xl font-bold">{completed.length ? `${avg}%` : ""}</div>
        </div>
        <div className="card flex flex-col items-start">
          <div className="text-xs muted uppercase font-semibold">Got a code?</div>
          <Link href="/student/join" className="btn btn-primary mt-2">Join a quiz</Link>
        </div>
      </div>

      <div className="mt-6">
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

      <div className="mt-6">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="h2">Boost your test-taking</h2>
          <span className="text-[10px] uppercase tracking-wide font-bold text-emerald-700 bg-emerald-100 rounded-full px-2 py-0.5">New</span>
        </div>
        <div className="grid sm:grid-cols-3 gap-3">
          <Link href="/student/speed" className="card card-hover flex items-start gap-3">
            <div className="rounded-lg bg-orange-100 text-orange-700 p-2 shrink-0"><Timer size={18} /></div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold">Speed-Accuracy</div>
              <div className="text-xs muted mt-1">Train your exam pace — Bloom-level timers per question.</div>
            </div>
          </Link>
          <Link href="/student/traps" className="card card-hover flex items-start gap-3">
            <div className="rounded-lg bg-rose-100 text-rose-700 p-2 shrink-0"><Crosshair size={18} /></div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold">Trap Detector</div>
              <div className="text-xs muted mt-1">Find which examiner-trap patterns trip you up most.</div>
            </div>
          </Link>
          <Link href="/student/tutor" className="card card-hover flex items-start gap-3">
            <div className="rounded-lg bg-indigo-100 text-indigo-700 p-2 shrink-0"><Bot size={18} /></div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold">AI Tutor</div>
              <div className="text-xs muted mt-1">Stuck? Chat through any concept — Socratic, not answer-dump.</div>
            </div>
          </Link>
        </div>
      </div>

      <h2 className="h2 mt-8 mb-3 flex items-center gap-2">
        <ClipboardList size={20} /> Assigned to you
        {assigned.length > 0 && <span className="text-sm font-normal muted">({assigned.length})</span>}
      </h2>
      {assigned.length === 0 ? (
        <div className="card text-center py-8 muted text-sm">
          Nothing assigned right now. Check back later, or join a quiz with a code.
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
                  <div className="text-[11px] muted mt-1">
                    Assigned {new Date(a.assigned_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
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

      <h2 className="h2 mt-8 mb-3">Your attempts</h2>
      {attempts.length === 0 ? (
        <Empty
          icon="🚀"
          title="No attempts yet"
          body="Ask your teacher for a 6-character quiz code and start your first test."
          action={<Link href="/student/join" className="btn btn-primary">Enter quiz code</Link>}
        />
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase muted">
              <tr>
                <th className="px-4 py-3 text-left">Quiz</th>
                <th className="px-4 py-3 text-left">Code</th>
                <th className="px-4 py-3 text-left">Score</th>
                <th className="px-4 py-3 text-left">Date</th>
                <th className="px-4 py-3 text-right">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {attempts.map((a) => (
                <tr key={a.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium">{a.quiz?.name || "Quiz"}</td>
                  <td className="px-4 py-3"><code className="text-xs px-2 py-0.5 bg-slate-100 rounded">{a.quiz?.code}</code></td>
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
