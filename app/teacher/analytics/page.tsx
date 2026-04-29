"use client";

import { Fragment, Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { BLOOM_LEVELS, BLOOM_META, blankBloomCounts, type BloomLevel } from "@/lib/bloom";
import { BloomRadar } from "@/components/BloomChart";
import type { Quiz } from "@/lib/types";
import { pct, formatSeconds } from "@/lib/utils";
import Empty from "@/components/Empty";
import { Sparkles, Copy, Users, Clock, AlertTriangle, Trophy, ChevronDown, ChevronRight, ListChecks, Mail, Brain, TrendingDown, CheckCircle2 } from "lucide-react";

type AttemptRow = {
  attempt_id: string;
  student_id: string;
  student_name: string;
  score: number;
  total: number;
  time_taken_seconds: number | null;
  per_level: Record<BloomLevel, { c: number; t: number }>;
  per_question: Record<string, { selected: number | null; correct: boolean | null }>;
};

type QuestionStat = {
  id: string;
  stem: string;
  options: string[];
  correct_index: number;
  explanation: string | null;
  level: BloomLevel;
  correct: number;
  total: number;
  optionCounts: number[]; // counts per option (length 4)
};

type AssignmentMeta = {
  classes: { id: string; name: string; memberCount: number }[];
  individualStudents: number; // student-targeted assignments
  totalStudents: number;       // unique students across class+individual targets
};

function AnalyticsInner() {
  const search = useSearchParams();
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [quizId, setQuizId] = useState<string>(search.get("quiz") || "");
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [questionCount, setQuestionCount] = useState(0);
  const [assignment, setAssignment] = useState<AssignmentMeta>({ classes: [], individualStudents: 0, totalStudents: 0 });
  const [rows, setRows] = useState<AttemptRow[]>([]);
  const [questionStats, setQuestionStats] = useState<QuestionStat[]>([]);
  const [expandedStudent, setExpandedStudent] = useState<string | null>(null);
  const [insight, setInsight] = useState<string>("");
  const [loadingInsight, setLoadingInsight] = useState(false);
  const [copied, setCopied] = useState(false);
  // Initial data is being fetched. Prevents the empty-state flash before rows arrive.
  const [loadingQuiz, setLoadingQuiz] = useState(true);
  // Collapsible-section toggles. Defaults: keep noise out of the way; teacher
  // expands on demand.
  const [showAllQuestions, setShowAllQuestions] = useState(false);
  const [showMoreAnalytics, setShowMoreAnalytics] = useState(false);
  const [showFullStudentTable, setShowFullStudentTable] = useState(false);

  // 1) Load the teacher's quizzes (for the dropdown)
  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;
      const { data: qs } = await sb.from("quizzes").select("*").eq("owner_id", user.id).order("created_at", { ascending: false });
      const list = (qs as Quiz[]) || [];
      setQuizzes(list);
      if (!quizId && list.length) setQuizId(list[0].id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2) Load everything for the selected quiz
  useEffect(() => {
    if (!quizId) return;
    setExpandedStudent(null);
    setInsight("");
    setLoadingQuiz(true);
    (async () => {
      const sb = supabaseBrowser();

      // 2a) Quiz row
      const { data: q } = await sb.from("quizzes").select("*").eq("id", quizId).single();
      setQuiz(q as Quiz);

      // 2b) Question count
      const { count: qCount } = await sb.from("quiz_questions").select("question_id", { count: "exact", head: true }).eq("quiz_id", quizId);
      setQuestionCount(qCount || 0);

      // 2c) Assignments — which classes (with member counts), how many individual students
      const { data: asg } = await sb
        .from("quiz_assignments")
        .select("class_id, student_id, class:classes(id, name)")
        .eq("quiz_id", quizId);
      type AsgRow = { class_id: string | null; student_id: string | null; class: { id: string; name: string } | null };
      const asgRows = ((asg as unknown) as AsgRow[]) || [];
      const classRows = asgRows.filter((r) => r.class_id && r.class).map((r) => r.class!) as { id: string; name: string }[];
      const uniqueClasses = Array.from(new Map(classRows.map((c) => [c.id, c])).values());
      const individualStudentIds = new Set(asgRows.filter((r) => r.student_id).map((r) => r.student_id!));

      const classesWithCounts = await Promise.all(
        uniqueClasses.map(async (c) => {
          const { count } = await sb.from("class_members").select("student_id", { count: "exact", head: true }).eq("class_id", c.id);
          return { id: c.id, name: c.name, memberCount: count || 0 };
        })
      );

      // Total students across all assignment targets (class members + individuals, deduped)
      const allTargetIds = new Set<string>(individualStudentIds);
      for (const c of classesWithCounts) {
        const { data: members } = await sb.from("class_members").select("student_id").eq("class_id", c.id);
        ((members as Array<{ student_id: string }>) || []).forEach((m) => allTargetIds.add(m.student_id));
      }

      setAssignment({
        classes: classesWithCounts,
        individualStudents: individualStudentIds.size,
        totalStudents: allTargetIds.size,
      });

      // 2d) Submitted attempts + student names + time taken
      const { data: atts } = await sb
        .from("quiz_attempts")
        .select("id, student_id, score, total, time_taken_seconds, profile:profiles!quiz_attempts_student_id_fkey(full_name)")
        .eq("quiz_id", quizId)
        .not("submitted_at", "is", null);
      type Att = { id: string; student_id: string; score: number; total: number; time_taken_seconds: number | null; profile: { full_name: string | null } | null };
      const attemptRows = ((atts as unknown) as Att[]) || [];
      const attemptIds = attemptRows.map((a) => a.id);

      // 2e) Batch-fetch ALL answers for these attempts (one query, no N+1)
      let allAnswers: Array<{ attempt_id: string; question_id: string; selected_index: number | null; is_correct: boolean | null; bloom_level: BloomLevel }> = [];
      if (attemptIds.length > 0) {
        const { data: ans } = await sb
          .from("attempt_answers")
          .select("attempt_id, question_id, selected_index, is_correct, bloom_level")
          .in("attempt_id", attemptIds);
        allAnswers = (ans as typeof allAnswers) || [];
      }

      // Group answers by attempt for the per-student rows
      const out: AttemptRow[] = attemptRows.map((a) => {
        const per_level: Record<BloomLevel, { c: number; t: number }> = {
          remember: { c: 0, t: 0 }, understand: { c: 0, t: 0 }, apply: { c: 0, t: 0 },
          analyze:  { c: 0, t: 0 }, evaluate:   { c: 0, t: 0 }, create: { c: 0, t: 0 },
        };
        const per_question: Record<string, { selected: number | null; correct: boolean | null }> = {};
        allAnswers.filter((x) => x.attempt_id === a.id).forEach((x) => {
          per_level[x.bloom_level].t += 1;
          if (x.is_correct) per_level[x.bloom_level].c += 1;
          per_question[x.question_id] = { selected: x.selected_index, correct: x.is_correct };
        });
        return {
          attempt_id: a.id, student_id: a.student_id,
          student_name: a.profile?.full_name || "Unknown",
          score: a.score, total: a.total, time_taken_seconds: a.time_taken_seconds,
          per_level, per_question,
        };
      });
      setRows(out);

      // 2f) Question difficulty + misconception (option distribution)
      const { data: qq } = await sb
        .from("quiz_questions")
        .select("question_id, position, question_bank!inner(stem, options, correct_index, explanation, bloom_level)")
        .eq("quiz_id", quizId)
        .order("position", { ascending: true });
      type QqRow = {
        question_id: string;
        position: number;
        question_bank: { stem: string; options: string[]; correct_index: number; explanation: string | null; bloom_level: BloomLevel } | null;
      };
      const stats: QuestionStat[] = ((qq as unknown) as QqRow[]).filter((r) => r.question_bank).map((r) => {
        const ansForQ = allAnswers.filter((x) => x.question_id === r.question_id);
        const optionCounts = [0, 0, 0, 0];
        let correct = 0;
        ansForQ.forEach((x) => {
          if (typeof x.selected_index === "number" && x.selected_index >= 0 && x.selected_index < 4) {
            optionCounts[x.selected_index]++;
          }
          if (x.is_correct) correct++;
        });
        return {
          id: r.question_id,
          stem: r.question_bank!.stem,
          options: r.question_bank!.options,
          correct_index: r.question_bank!.correct_index,
          explanation: r.question_bank!.explanation,
          level: r.question_bank!.bloom_level,
          correct,
          total: ansForQ.length,
          optionCounts,
        };
      });
      setQuestionStats(stats);
      setLoadingQuiz(false);
    })();
  }, [quizId]);

  // ============ Computed analytics ============

  const classLevels = useMemo(() => {
    const counts = blankBloomCounts();
    const totals = blankBloomCounts();
    rows.forEach((r) => BLOOM_LEVELS.forEach((l) => {
      counts[l] += r.per_level[l].c;
      totals[l] += r.per_level[l].t;
    }));
    return BLOOM_LEVELS.map((l) => ({ level: l, correct: counts[l], total: totals[l] }));
  }, [rows]);

  const classAvg = useMemo(() => {
    if (!rows.length) return 0;
    return Math.round(rows.reduce((s, r) => s + pct(r.score, r.total), 0) / rows.length);
  }, [rows]);

  const sortedByScore = useMemo(
    () => rows.slice().sort((a, b) => pct(b.score, b.total) - pct(a.score, a.total)),
    [rows]
  );
  const atRisk = useMemo(() => sortedByScore.filter((r) => pct(r.score, r.total) < 50), [sortedByScore]);
  const topPerformers = useMemo(() => sortedByScore.slice(0, 3), [sortedByScore]);

  const submissionRate = useMemo(() => {
    if (assignment.totalStudents === 0) return null;
    return Math.round((rows.length / assignment.totalStudents) * 100);
  }, [rows.length, assignment.totalStudents]);

  const scoreDistribution = useMemo(() => {
    const buckets = [0, 0, 0, 0, 0]; // 0-20, 20-40, 40-60, 60-80, 80-100
    rows.forEach((r) => {
      const p = pct(r.score, r.total);
      const i = Math.min(4, Math.floor(p / 20));
      buckets[i]++;
    });
    return buckets;
  }, [rows]);

  const timeStats = useMemo(() => {
    const times = rows.map((r) => r.time_taken_seconds).filter((t): t is number => typeof t === "number" && t > 0);
    if (times.length === 0) return null;
    const avg = Math.round(times.reduce((s, t) => s + t, 0) / times.length);
    const min = Math.min(...times);
    const max = Math.max(...times);
    const fastest = rows.find((r) => r.time_taken_seconds === min);
    const slowest = rows.find((r) => r.time_taken_seconds === max);
    return { avg, min, max, fastest, slowest, limit: (quiz?.time_limit_minutes || 0) * 60 };
  }, [rows, quiz]);

  const bloomBest = useMemo(() => classLevels.filter((l) => l.total > 0).slice().sort((a, b) => (b.correct / b.total) - (a.correct / a.total))[0], [classLevels]);
  const bloomWorst = useMemo(() => classLevels.filter((l) => l.total > 0).slice().sort((a, b) => (a.correct / a.total) - (b.correct / b.total))[0], [classLevels]);

  // ============ ACTION ITEMS — what should the teacher actually do? ============
  type ActionItem = {
    severity: "high" | "medium" | "low";
    icon: React.ReactNode;
    title: string;
    detail: string;
  };

  const actionItems: ActionItem[] = useMemo(() => {
    const items: ActionItem[] = [];

    // 1) Submission gap (only if assigned to a class/students)
    if (assignment.totalStudents > 0 && rows.length < assignment.totalStudents) {
      const missing = assignment.totalStudents - rows.length;
      const missingPct = missing / assignment.totalStudents;
      items.push({
        severity: missingPct >= 0.3 ? "high" : "medium",
        icon: <Mail size={16} />,
        title: `${missing} of ${assignment.totalStudents} students haven't submitted`,
        detail: missingPct >= 0.5
          ? "More than half are still pending — worth a chase."
          : "Follow up before the next class so you don't lose momentum.",
      });
    }

    // 2) At-risk students
    if (atRisk.length > 0) {
      const names = atRisk.slice(0, 3).map((s) => s.student_name).join(", ");
      const more = atRisk.length > 3 ? `, +${atRisk.length - 3} more` : "";
      items.push({
        severity: rows.length > 0 && atRisk.length / rows.length >= 0.3 ? "high" : "medium",
        icon: <AlertTriangle size={16} />,
        title: `${atRisk.length} student${atRisk.length === 1 ? "" : "s"} scored below 50%`,
        detail: `${names}${more}. Consider a remediation drill on the weakest topics.`,
      });
    }

    // 3) Misconceptions — questions where >40% of class picked the same WRONG option
    type MisconceptionRow = { q: QuestionStat; topWrongIdx: number; topWrongPct: number; correctPct: number };
    const misconceptions: MisconceptionRow[] = questionStats
      .filter((q) => q.total > 0)
      .map((q) => {
        const wrong = q.optionCounts.map((c, i) => ({ i, c })).filter((x) => x.i !== q.correct_index);
        const top = wrong.sort((a, b) => b.c - a.c)[0];
        const correctPct = q.correct / q.total;
        const topWrongPct = q.total ? top.c / q.total : 0;
        return { q, topWrongIdx: top.i, topWrongPct, correctPct };
      })
      .filter((x) => x.correctPct < 0.5 && x.topWrongPct >= 0.4)
      .sort((a, b) => a.correctPct - b.correctPct)
      .slice(0, 2);

    misconceptions.forEach((m) => {
      const optTxt = (m.q.options[m.topWrongIdx] || "").slice(0, 70);
      items.push({
        severity: "medium",
        icon: <Brain size={16} />,
        title: `Misconception: ${BLOOM_META[m.q.level].label} question`,
        detail: `${Math.round(m.topWrongPct * 100)}% picked option ${String.fromCharCode(65 + m.topWrongIdx)} ("${optTxt}${optTxt.length === 70 ? "…" : ""}"). Re-teach this point explicitly.`,
      });
    });

    // 4) Bloom-level gap
    const weakLvl = classLevels
      .filter((l) => l.total > 0)
      .map((l) => ({ ...l, p: l.correct / l.total }))
      .sort((a, b) => a.p - b.p)[0];
    if (weakLvl && weakLvl.p < 0.5) {
      items.push({
        severity: weakLvl.p < 0.3 ? "high" : "medium",
        icon: <TrendingDown size={16} />,
        title: `Class is weak on ${BLOOM_META[weakLvl.level].label} (${Math.round(weakLvl.p * 100)}%)`,
        detail: `Generate a focused drill on ${BLOOM_META[weakLvl.level].verb.toLowerCase()}-level skills before moving on.`,
      });
    }

    // 5) Quiz quality flags — questions everyone got right (too easy / redundant)
    const tooEasy = questionStats.filter((q) => q.total >= 3 && q.correct === q.total).length;
    if (tooEasy >= 2) {
      items.push({
        severity: "low",
        icon: <CheckCircle2 size={16} />,
        title: `${tooEasy} questions had 100% correct`,
        detail: "Likely too easy or redundant. Consider replacing with harder Bloom-level questions next time.",
      });
    }

    const order = { high: 0, medium: 1, low: 2 } as const;
    return items.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 5);
  }, [rows.length, assignment.totalStudents, atRisk, questionStats, classLevels]);

  async function getInsight() {
    if (!rows.length) return;
    setLoadingInsight(true);
    const sb = supabaseBrowser();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;
    const res = await fetch("/api/commentary", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ kind: "class_summary", levels: classLevels, classAvg, atRisk: atRisk.map((s) => s.student_name) }),
    });
    const json = await res.json();
    setInsight(json.text || "");
    setLoadingInsight(false);
  }

  function copyCode() {
    if (!quiz) return;
    navigator.clipboard.writeText(quiz.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (quizzes.length === 0) {
    return <Empty icon="📊" title="No quizzes yet" body="Create a quiz first, then come back here for analytics." />;
  }

  return (
    <div className="max-w-6xl mx-auto fade-in">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="h1">Class analytics</h1>
        <select className="select max-w-md" value={quizId} onChange={(e) => setQuizId(e.target.value)}>
          {quizzes.map((q) => (
            <option key={q.id} value={q.id}>
              {q.name}{q.subject ? ` — ${q.subject}` : ""}
            </option>
          ))}
        </select>
      </div>

      {/* ============ QUIZ CONTEXT ============ */}
      {quiz && (
        <div className="card mt-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="text-xs muted uppercase tracking-wide font-semibold">Quiz</div>
              <h2 className="text-xl font-bold mt-0.5">{quiz.name}</h2>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {quiz.subject && <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-semibold">{quiz.subject}</span>}
                {quiz.topic_family && <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 font-semibold">{quiz.topic_family}</span>}
                <span className="text-xs muted">{questionCount} questions · {quiz.time_limit_minutes} min</span>
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-xs muted uppercase tracking-wide font-semibold">Code</div>
              <div className="flex items-center gap-2 mt-1">
                <code className="text-lg font-mono font-bold">{quiz.code}</code>
                <button className="btn btn-ghost p-1" onClick={copyCode} title="Copy">
                  <Copy size={14} />
                </button>
                {copied && <span className="text-xs text-emerald-700">Copied</span>}
              </div>
            </div>
          </div>

          {/* Assignment summary */}
          <div className="mt-3 pt-3 border-t border-slate-100 text-sm">
            {assignment.classes.length === 0 && assignment.individualStudents === 0 ? (
              <span className="muted">
                <Users size={14} className="inline mr-1" />
                Open access — anyone with the code can take this quiz.
              </span>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                <Users size={14} className="text-emerald-700" />
                <span className="font-medium">Assigned to:</span>
                {assignment.classes.map((c) => (
                  <Link key={c.id} href={`/teacher/classes/${c.id}`} className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 font-semibold hover:bg-emerald-100">
                    {c.name} ({c.memberCount})
                  </Link>
                ))}
                {assignment.individualStudents > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-sky-50 text-sky-800 font-semibold">
                    + {assignment.individualStudents} individual student{assignment.individualStudents === 1 ? "" : "s"}
                  </span>
                )}
                <span className="text-xs muted">· {assignment.totalStudents} expected</span>
              </div>
            )}
          </div>
        </div>
      )}

      {loadingQuiz ? (
        <div className="grid place-items-center py-20"><div className="spinner" /></div>
      ) : rows.length === 0 ? (
        <Empty icon="⏳" title="No completed attempts yet" body="Once students submit, you'll see thinking-level breakdowns here." />
      ) : (
        <>
          {/* ============ TOP STATS ============ */}
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-6">
            <div className="card">
              <div className="text-xs muted uppercase font-semibold">Submitted</div>
              <div className="text-3xl font-bold">{rows.length}{submissionRate !== null && <span className="text-base font-normal muted"> / {assignment.totalStudents}</span>}</div>
              {submissionRate !== null && (
                <div className="text-xs muted mt-1">{submissionRate}% submission rate</div>
              )}
            </div>
            <div className="card">
              <div className="text-xs muted uppercase font-semibold">Class average</div>
              <div className="text-3xl font-bold">{classAvg}%</div>
            </div>
            <div className="card">
              <div className="text-xs muted uppercase font-semibold">Top score</div>
              <div className="text-3xl font-bold text-emerald-700">{topPerformers[0] ? `${pct(topPerformers[0].score, topPerformers[0].total)}%` : "—"}</div>
              {topPerformers[0] && <div className="text-xs muted truncate">{topPerformers[0].student_name}</div>}
            </div>
            <div className="card">
              <div className="text-xs muted uppercase font-semibold">At risk (&lt;50%)</div>
              <div className="text-3xl font-bold text-red-600">{atRisk.length}</div>
            </div>
          </div>

          {/* ============ ACTION ITEMS — what to do next ============ */}
          <div className="card mt-6 border-l-4 border-emerald-500">
            <h3 className="font-bold flex items-center gap-2 mb-3">
              <ListChecks size={18} className="text-emerald-700" /> What to do next
            </h3>
            {actionItems.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-emerald-800">
                <CheckCircle2 size={16} /> Class is in good shape — nothing urgent.
              </div>
            ) : (
              <ul className="space-y-2.5">
                {actionItems.map((it, i) => {
                  const tone =
                    it.severity === "high"   ? "border-red-200 bg-red-50/60 text-red-900" :
                    it.severity === "medium" ? "border-amber-200 bg-amber-50/60 text-amber-900" :
                                               "border-slate-200 bg-slate-50 text-slate-800";
                  return (
                    <li key={i} className={`flex items-start gap-3 p-3 rounded-lg border ${tone}`}>
                      <span className="mt-0.5 shrink-0">{it.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm">{it.title}</div>
                        <div className="text-xs opacity-90 mt-0.5">{it.detail}</div>
                      </div>
                      <span className={`text-[10px] uppercase tracking-wide font-bold rounded-full px-2 py-0.5 shrink-0 ${
                        it.severity === "high" ? "bg-red-200 text-red-900" :
                        it.severity === "medium" ? "bg-amber-200 text-amber-900" :
                        "bg-slate-200 text-slate-700"
                      }`}>
                        {it.severity}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* ============ TIME ANALYSIS (kept inline — small + sometimes useful) ============ */}
          {timeStats && (
            <div className="card mt-6">
              <h3 className="font-bold mb-3 flex items-center gap-2"><Clock size={16} /> Time taken</h3>
              <div className="grid sm:grid-cols-3 gap-3 text-sm">
                <div>
                  <div className="text-xs muted uppercase">Average</div>
                  <div className="text-xl font-bold">{formatSeconds(timeStats.avg)}</div>
                  <div className="text-xs muted">of {formatSeconds(timeStats.limit)} limit</div>
                </div>
                <div>
                  <div className="text-xs muted uppercase">Fastest</div>
                  <div className="text-xl font-bold">{formatSeconds(timeStats.min)}</div>
                  <div className="text-xs muted truncate">{timeStats.fastest?.student_name}</div>
                </div>
                <div>
                  <div className="text-xs muted uppercase">Slowest</div>
                  <div className="text-xl font-bold">{formatSeconds(timeStats.max)}</div>
                  <div className="text-xs muted truncate">{timeStats.slowest?.student_name}</div>
                </div>
              </div>
            </div>
          )}

          {/* ============ AT RISK + TOP ============ */}
          <div className="grid lg:grid-cols-2 gap-6 mt-6">
            <div className="card">
              <h3 className="font-bold mb-3 flex items-center gap-2 text-red-700"><AlertTriangle size={16} /> Needs attention</h3>
              {atRisk.length === 0 ? (
                <div className="text-sm muted">Nobody scored below 50% — nice.</div>
              ) : (
                <ul className="space-y-1.5">
                  {atRisk.map((s) => (
                    <li key={s.attempt_id} className="flex items-center justify-between text-sm">
                      <span className="font-medium">{s.student_name}</span>
                      <span className="text-red-700 font-semibold">{s.score}/{s.total} ({pct(s.score, s.total)}%)</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="card">
              <h3 className="font-bold mb-3 flex items-center gap-2 text-emerald-700"><Trophy size={16} /> Top performers</h3>
              {topPerformers.length === 0 ? (
                <div className="text-sm muted">No data yet.</div>
              ) : (
                <ul className="space-y-1.5">
                  {topPerformers.map((s, i) => (
                    <li key={s.attempt_id} className="flex items-center justify-between text-sm">
                      <span className="font-medium">{i + 1}. {s.student_name}</span>
                      <span className="text-emerald-700 font-semibold">{s.score}/{s.total} ({pct(s.score, s.total)}%)</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* ============ QUESTION DIFFICULTY + MISCONCEPTIONS ============ */}
          <div className="card mt-6">
            <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
              <h3 className="font-bold">Problem questions</h3>
              <button
                type="button"
                className="text-xs text-emerald-700 font-semibold hover:underline"
                onClick={() => setShowAllQuestions((v) => !v)}
              >
                {showAllQuestions ? "Show problem questions only" : `Show all ${questionStats.length} questions`}
              </button>
            </div>
            <p className="text-xs muted mb-3">
              {showAllQuestions
                ? "Every question in the quiz, hardest first."
                : "Questions where less than 70% of students got it right. The option most students wrongly picked is flagged — usually a teaching opportunity."}
            </p>
            <div className="space-y-3">
              {questionStats
                .map((q) => ({ ...q, p: q.total ? q.correct / q.total : 0 }))
                .sort((a, b) => a.p - b.p)
                .filter((q) => showAllQuestions || q.p < 0.7)
                .map((q) => {
                  // find top wrong option
                  const wrongCounts = q.optionCounts.map((c, i) => ({ i, c })).filter((x) => x.i !== q.correct_index);
                  const topWrong = wrongCounts.sort((a, b) => b.c - a.c)[0];
                  return (
                    <div key={q.id} className="p-3 rounded-lg border border-slate-200">
                      <div className="flex items-center gap-3 mb-2 flex-wrap">
                        <span className={`badge badge-${q.level}`}>{BLOOM_META[q.level].label}</span>
                        <span className={`text-sm font-semibold ml-auto ${q.p < 0.4 ? "text-red-700" : q.p < 0.7 ? "text-amber-700" : "text-emerald-700"}`}>
                          {q.total ? `${Math.round(q.p * 100)}% correct` : "—"}
                        </span>
                      </div>
                      <div className="text-sm font-medium mb-2">{q.stem}</div>
                      <div className="grid sm:grid-cols-2 gap-1.5 text-xs">
                        {q.options.map((opt, i) => {
                          const count = q.optionCounts[i];
                          const optPct = q.total ? Math.round((count / q.total) * 100) : 0;
                          const isCorrect = i === q.correct_index;
                          const isTopWrong = topWrong && i === topWrong.i && topWrong.c > 0;
                          return (
                            <div key={i} className={`px-2 py-1.5 rounded border ${
                              isCorrect ? "border-emerald-300 bg-emerald-50" :
                              isTopWrong ? "border-red-200 bg-red-50" :
                              "border-slate-200"
                            }`}>
                              <span className="font-mono text-slate-500 mr-1">{String.fromCharCode(65 + i)}.</span>
                              <span className={isCorrect ? "text-emerald-800 font-medium" : ""}>{opt}</span>
                              <span className="float-right font-semibold">
                                {count} ({optPct}%)
                                {isCorrect && <span className="ml-1 text-emerald-600">✓</span>}
                                {isTopWrong && <span className="ml-1 text-red-600">⚠</span>}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                      {q.p < 0.5 && topWrong && topWrong.c > 0 && (
                        <div className="mt-2 text-xs text-amber-900 bg-amber-50 border border-amber-200 px-2 py-1.5 rounded">
                          <strong>Misconception alert:</strong> {Math.round((topWrong.c / q.total) * 100)}% picked option{" "}
                          <strong>{String.fromCharCode(65 + topWrong.i)}</strong>. Worth re-teaching this point.
                        </div>
                      )}
                    </div>
                  );
                })}
              {!showAllQuestions && questionStats.filter((q) => q.total > 0 && q.correct / q.total < 0.7).length === 0 && (
                <div className="text-sm muted text-center py-4">
                  ✅ No problem questions — every question got 70%+ correct.
                </div>
              )}
            </div>
          </div>

          {/* ============ AI SUMMARY ============ */}
          <div className="card mt-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold">AI summary</h3>
              <button className="btn btn-primary" onClick={getInsight} disabled={loadingInsight}>
                {loadingInsight ? <><span className="spinner" /> Thinking…</> : <><Sparkles size={16} /> Generate</>}
              </button>
            </div>
            {insight ? <p className="text-slate-700 whitespace-pre-wrap text-sm">{insight}</p> :
              <p className="muted text-sm">Click Generate to get an AI summary of strengths, weaknesses, and what to teach next.</p>}
          </div>

          {/* ============ MORE ANALYTICS (collapsed) ============ */}
          <button
            type="button"
            className="card mt-6 w-full text-left flex items-center justify-between hover:bg-slate-50"
            onClick={() => setShowMoreAnalytics((v) => !v)}
          >
            <span className="font-bold">More analytics</span>
            {showMoreAnalytics ? <ChevronDown size={18} className="text-slate-500" /> : <ChevronRight size={18} className="text-slate-500" />}
          </button>
          {showMoreAnalytics && (
            <div className="grid lg:grid-cols-2 gap-6 mt-4">
              <div className="card">
                <h3 className="font-bold mb-3">Score distribution</h3>
                <ScoreDistribution buckets={scoreDistribution} />
              </div>
              <div className="card">
                <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                  <h3 className="font-bold">Bloom-level performance</h3>
                  <div className="text-xs muted">
                    {bloomBest && <>↑ <strong className="text-emerald-700">{BLOOM_META[bloomBest.level].label}</strong></>}
                    {bloomBest && bloomWorst && bloomBest.level !== bloomWorst.level && <> · </>}
                    {bloomWorst && bloomBest?.level !== bloomWorst.level && <>↓ <strong className="text-red-700">{BLOOM_META[bloomWorst.level].label}</strong></>}
                  </div>
                </div>
                <BloomRadar data={classLevels} />
              </div>
            </div>
          )}

          {/* ============ PER-STUDENT BREAKDOWN (collapsed) ============ */}
          <button
            type="button"
            className="card mt-6 w-full text-left flex items-center justify-between hover:bg-slate-50"
            onClick={() => setShowFullStudentTable((v) => !v)}
          >
            <span className="font-bold">Per-student breakdown <span className="muted font-normal text-sm">({rows.length} student{rows.length === 1 ? "" : "s"})</span></span>
            {showFullStudentTable ? <ChevronDown size={18} className="text-slate-500" /> : <ChevronRight size={18} className="text-slate-500" />}
          </button>
          {showFullStudentTable && (
          <div className="card mt-4">
            <p className="text-xs muted mb-3">Click any row to see that student&apos;s answers question-by-question.</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase muted">
                  <tr>
                    <th className="px-3 py-2 text-left">Student</th>
                    <th className="px-3 py-2 text-right">Score</th>
                    <th className="px-3 py-2 text-right">Time</th>
                    {BLOOM_LEVELS.map((l) => (
                      <th key={l} className="px-3 py-2 text-center" title={BLOOM_META[l].description}>{BLOOM_META[l].label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sortedByScore.map((r) => {
                    const expanded = expandedStudent === r.attempt_id;
                    return (
                      <Fragment key={r.attempt_id}>
                        <tr onClick={() => setExpandedStudent(expanded ? null : r.attempt_id)} className="hover:bg-slate-50 cursor-pointer">
                          <td className="px-3 py-2 font-medium flex items-center gap-1">
                            {expanded ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
                            {r.student_name}
                          </td>
                          <td className="px-3 py-2 text-right">{r.score}/{r.total} <span className="muted">({pct(r.score, r.total)}%)</span></td>
                          <td className="px-3 py-2 text-right muted">{r.time_taken_seconds ? formatSeconds(r.time_taken_seconds) : "—"}</td>
                          {BLOOM_LEVELS.map((l) => {
                            const p = r.per_level[l];
                            const v = p.t ? Math.round((p.c / p.t) * 100) : null;
                            const cls = v == null ? "text-slate-300" : v >= 70 ? "text-emerald-700" : v >= 40 ? "text-amber-700" : "text-red-700";
                            return <td key={l} className={`px-3 py-2 text-center font-semibold ${cls}`}>{v == null ? "—" : `${v}%`}</td>;
                          })}
                        </tr>
                        {expanded && (
                          <tr>
                            <td colSpan={3 + BLOOM_LEVELS.length} className="px-3 py-3 bg-slate-50">
                              <div className="space-y-2">
                                {questionStats.map((q, qi) => {
                                  const ans = r.per_question[q.id];
                                  if (!ans) return null;
                                  const correct = ans.correct;
                                  return (
                                    <div key={q.id} className={`text-xs p-2 rounded border ${correct ? "border-emerald-200 bg-emerald-50/50" : "border-red-200 bg-red-50/50"}`}>
                                      <span className="font-bold mr-1">Q{qi + 1}.</span>
                                      <span>{q.stem}</span>
                                      <div className="mt-1 muted">
                                        Picked: <strong>{ans.selected !== null ? `${String.fromCharCode(65 + ans.selected)} — ${q.options[ans.selected]}` : "—"}</strong>
                                        {!correct && <> · Correct: <strong className="text-emerald-700">{String.fromCharCode(65 + q.correct_index)} — {q.options[q.correct_index]}</strong></>}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          )}
        </>
      )}
    </div>
  );
}

function ScoreDistribution({ buckets }: { buckets: number[] }) {
  const max = Math.max(...buckets, 1);
  const labels = ["0–20%", "20–40%", "40–60%", "60–80%", "80–100%"];
  const colors = ["bg-red-500", "bg-orange-500", "bg-amber-500", "bg-emerald-500", "bg-emerald-600"];
  return (
    <div>
      <div className="flex items-end gap-2 h-32">
        {buckets.map((b, i) => (
          <div key={i} className="flex-1 flex flex-col items-center justify-end">
            <div className="text-xs font-bold mb-1">{b > 0 ? b : ""}</div>
            <div className={`w-full ${colors[i]} rounded-t transition-all`} style={{ height: `${(b / max) * 100}%`, minHeight: b > 0 ? "4px" : "0" }} />
          </div>
        ))}
      </div>
      <div className="flex gap-2 mt-2">
        {labels.map((l) => <div key={l} className="flex-1 text-[10px] text-slate-500 text-center">{l}</div>)}
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<div className="grid place-items-center py-20"><div className="spinner" /></div>}>
      <AnalyticsInner />
    </Suspense>
  );
}
