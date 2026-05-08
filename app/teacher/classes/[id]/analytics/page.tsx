"use client";

// /teacher/classes/[id]/analytics
//
// Class-wide cross-test dashboard. The existing /teacher/analytics page is
// scoped to ONE quiz at a time. /teacher/classes/[id] is a roster manager.
// Neither answers "how is this class doing OVERALL across all tests they've
// taken?" — which is exactly the question a teacher with a class for a
// term wants to ask before a parent meeting or report card. This page does.
//
// Inputs (resolved client-side via supabaseBrowser, so RLS naturally gates
// non-members of the class):
//   - The class itself (name, school).
//   - All members of the class.
//   - All quiz_assignments for this class — gives us the set of quizzes
//     the class has been assigned (regardless of which teacher created
//     them — Mr. Raj as co-teacher should see Ms. Priya's quizzes too).
//   - All submitted quiz_attempts where student_id is a class member AND
//     quiz_id is one of the assigned quizzes.
//   - All attempt_answers for those attempts (for Bloom rollup).
//
// Outputs:
//   - Header KPI cards: tests assigned, total submitted attempts, class
//     average %, count of students currently flagged at risk (<50% latest).
//   - Bloom mastery panel — horizontal bars showing % correct per Bloom
//     level across ALL attempts on this class.
//   - Per-student trajectory table — name, attempts taken, average %,
//     latest attempt %, pp change since first attempt. Sorted lowest-avg
//     first so struggling students surface naturally.
//   - Per-quiz summary table — quiz name, attempts received, class avg
//     for that quiz, last activity date.

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  ArrowLeft, ListChecks, Send, AlertTriangle, TrendingUp, TrendingDown, Minus,
  Users as UsersIcon, BarChart3,
} from "lucide-react";
import { BLOOM_LEVELS, BLOOM_META, type BloomLevel } from "@/lib/bloom";

type ClassRow = { id: string; name: string; grade: string | null; school_id: string | null };
type MemberRow = { id: string; full_name: string | null; username: string | null };
type QuizRow = { id: string; name: string; code: string; subject: string | null; topic_family: string | null; assignedByName: string | null; assignedByMe: boolean };
type AttemptRow = {
  id: string; quiz_id: string; student_id: string;
  score: number; total: number; submitted_at: string | null; started_at: string;
};
type AnswerRow = { attempt_id: string; question_id: string; bloom_level: string | null; is_correct: boolean | null };

type StudentSummary = {
  studentId: string;
  name: string;
  attempts: number;
  avgPct: number | null;     // average across all submitted attempts
  latestPct: number | null;  // most-recent submitted attempt
  firstPct: number | null;
  ppChange: number | null;   // latestPct - firstPct (only when ≥2 attempts)
};

type QuizSummary = {
  quizId: string;
  name: string;
  code: string;
  subject: string | null;
  attempts: number;
  avgPct: number | null;
  lastSubmittedAt: string | null;
  assignedByName: string | null; // null when we couldn't resolve a profile
  assignedByMe: boolean;
};

function pctOrNull(num: number, den: number): number | null {
  if (!den) return null;
  return Math.round((num / den) * 100);
}

export default function ClassAnalyticsPage() {
  const { id: classId } = useParams<{ id: string }>();

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [klass, setKlass] = useState<ClassRow | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [quizzes, setQuizzes] = useState<QuizRow[]>([]);
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [answers, setAnswers] = useState<AnswerRow[]>([]);

  useEffect(() => {
    if (!classId) return;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const sb = supabaseBrowser();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) throw new Error("Sign in required.");

        // 1) Class. RLS will block non-members so a 0-row response = forbidden.
        const { data: classData } = await sb
          .from("classes")
          .select("id, name, grade, school_id")
          .eq("id", classId)
          .maybeSingle();
        if (!classData) throw new Error("Class not found or you don't have access.");
        setKlass(classData as ClassRow);

        // 2) Members.
        const { data: memberLinks } = await sb
          .from("class_members")
          .select("student_id")
          .eq("class_id", classId);
        const memberIds = (memberLinks || []).map((r) => (r as { student_id: string }).student_id);
        let memberProfs: MemberRow[] = [];
        if (memberIds.length > 0) {
          const { data: profs } = await sb
            .from("profiles")
            .select("id, full_name, username")
            .in("id", memberIds);
          memberProfs = (profs as MemberRow[]) || [];
        }
        setMembers(memberProfs);

        // 3) Quizzes assigned to this class.
        //
        // Visibility: a primary teacher of this class sees all
        // assignments here; a co-teacher only sees the ones they
        // personally pushed. We compute my role on this class first.
        const { data: myCt } = await sb
          .from("class_teachers")
          .select("role")
          .eq("class_id", classId)
          .eq("teacher_id", user.id)
          .maybeSingle();
        const myRole = (myCt as { role: string } | null)?.role || null;
        const isPrimary = myRole === "primary" || myRole === "acting";

        type AsgClassRow = {
          quiz_id: string;
          assigned_by: string | null;
          assigner: { full_name: string | null } | null;
        };
        const { data: asgs } = await sb
          .from("quiz_assignments")
          .select("quiz_id, assigned_by, assigner:profiles!quiz_assignments_assigned_by_fkey(full_name)")
          .eq("class_id", classId);
        const asgRows = (((asgs as unknown) as AsgClassRow[]) || [])
          .filter((r) => isPrimary || r.assigned_by === user.id);

        // quizId → first assigner we see (prefer me=true).
        const assignerByQuiz = new Map<string, { name: string; isMe: boolean }>();
        for (const r of asgRows) {
          const isMe = r.assigned_by === user.id;
          const name = r.assigner?.full_name || "Unknown";
          const cur = assignerByQuiz.get(r.quiz_id);
          if (!cur || (isMe && !cur.isMe)) assignerByQuiz.set(r.quiz_id, { name, isMe });
        }
        const quizIds = Array.from(new Set(asgRows.map((r) => r.quiz_id)));
        let quizRows: QuizRow[] = [];
        if (quizIds.length > 0) {
          const { data: qs } = await sb
            .from("quizzes")
            .select("id, name, code, subject, topic_family")
            .in("id", quizIds);
          quizRows = (((qs as unknown) as Array<{ id: string; name: string; code: string; subject: string | null; topic_family: string | null }>) || [])
            .map((q) => {
              const a = assignerByQuiz.get(q.id);
              return {
                ...q,
                assignedByName: a?.name ?? null,
                assignedByMe: !!a?.isMe,
              };
            });
        }
        setQuizzes(quizRows);

        // 4) Submitted attempts by class members on those quizzes.
        let attemptRows: AttemptRow[] = [];
        if (quizIds.length > 0 && memberIds.length > 0) {
          const { data: atts } = await sb
            .from("quiz_attempts")
            .select("id, quiz_id, student_id, score, total, submitted_at, started_at")
            .in("quiz_id", quizIds)
            .in("student_id", memberIds)
            .not("submitted_at", "is", null);
          attemptRows = (atts as AttemptRow[]) || [];
        }
        setAttempts(attemptRows);

        // 5) attempt_answers for Bloom rollup. Chunk if many attempts.
        let answerRows: AnswerRow[] = [];
        if (attemptRows.length > 0) {
          const ids = attemptRows.map((a) => a.id);
          const chunk = 500;
          for (let i = 0; i < ids.length; i += chunk) {
            const slice = ids.slice(i, i + chunk);
            const { data: ans } = await sb
              .from("attempt_answers")
              .select("attempt_id, question_id, bloom_level, is_correct")
              .in("attempt_id", slice);
            if (ans) answerRows = answerRows.concat(ans as AnswerRow[]);
          }
        }
        setAnswers(answerRows);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not load class analytics.");
      } finally {
        setLoading(false);
      }
    })();
  }, [classId]);

  // ────────────────────────────────────────────────────────────────────
  // Derived data
  // ────────────────────────────────────────────────────────────────────

  const memberById = useMemo(() => {
    const m = new Map<string, MemberRow>();
    for (const r of members) m.set(r.id, r);
    return m;
  }, [members]);

  const quizById = useMemo(() => {
    const m = new Map<string, QuizRow>();
    for (const q of quizzes) m.set(q.id, q);
    return m;
  }, [quizzes]);

  // Per-student trajectory.
  const studentSummaries: StudentSummary[] = useMemo(() => {
    const byStudent = new Map<string, AttemptRow[]>();
    for (const a of attempts) {
      const arr = byStudent.get(a.student_id) || [];
      arr.push(a);
      byStudent.set(a.student_id, arr);
    }
    const out: StudentSummary[] = [];
    for (const m of members) {
      const atts = (byStudent.get(m.id) || []).slice().sort((a, b) => {
        const ta = a.submitted_at ? Date.parse(a.submitted_at) : 0;
        const tb = b.submitted_at ? Date.parse(b.submitted_at) : 0;
        return ta - tb; // oldest first
      });
      const pcts = atts.map((a) => (a.total > 0 ? (a.score / a.total) * 100 : null)).filter((x): x is number => x !== null);
      const avgPct = pcts.length > 0 ? Math.round(pcts.reduce((s, x) => s + x, 0) / pcts.length) : null;
      const firstPct = pcts.length > 0 ? Math.round(pcts[0]) : null;
      const latestPct = pcts.length > 0 ? Math.round(pcts[pcts.length - 1]) : null;
      const ppChange = pcts.length >= 2 && firstPct !== null && latestPct !== null ? latestPct - firstPct : null;
      out.push({
        studentId: m.id,
        name: m.full_name || m.username || "(unnamed)",
        attempts: atts.length,
        avgPct,
        latestPct,
        firstPct,
        ppChange,
      });
    }
    // Sort: students who have attempts AND lowest avg first (surface
    // struggling kids), then no-attempts at the bottom.
    out.sort((a, b) => {
      const aAttempted = (a.attempts > 0 ? 0 : 1);
      const bAttempted = (b.attempts > 0 ? 0 : 1);
      if (aAttempted !== bAttempted) return aAttempted - bAttempted;
      const aAvg = a.avgPct ?? 0;
      const bAvg = b.avgPct ?? 0;
      return aAvg - bAvg;
    });
    return out;
  }, [members, attempts]);

  // Per-quiz summary.
  const quizSummaries: QuizSummary[] = useMemo(() => {
    const byQuiz = new Map<string, AttemptRow[]>();
    for (const a of attempts) {
      const arr = byQuiz.get(a.quiz_id) || [];
      arr.push(a);
      byQuiz.set(a.quiz_id, arr);
    }
    const out: QuizSummary[] = [];
    for (const q of quizzes) {
      const atts = byQuiz.get(q.id) || [];
      const pcts = atts.map((a) => (a.total > 0 ? (a.score / a.total) * 100 : null)).filter((x): x is number => x !== null);
      const avgPct = pcts.length > 0 ? Math.round(pcts.reduce((s, x) => s + x, 0) / pcts.length) : null;
      const lastSubmittedAt = atts.length > 0
        ? atts.map((a) => a.submitted_at).filter(Boolean).sort().slice(-1)[0] || null
        : null;
      out.push({
        quizId: q.id,
        name: q.name,
        code: q.code,
        subject: q.subject,
        attempts: atts.length,
        avgPct,
        lastSubmittedAt,
        assignedByName: q.assignedByName,
        assignedByMe: q.assignedByMe,
      });
    }
    // Most-recent activity first.
    out.sort((a, b) => {
      const ta = a.lastSubmittedAt ? Date.parse(a.lastSubmittedAt) : 0;
      const tb = b.lastSubmittedAt ? Date.parse(b.lastSubmittedAt) : 0;
      return tb - ta;
    });
    return out;
  }, [quizzes, attempts]);

  // Class-level KPIs.
  const totalAttempts = attempts.length;
  const classAvg = useMemo(() => {
    const pcts = attempts.map((a) => (a.total > 0 ? (a.score / a.total) * 100 : null)).filter((x): x is number => x !== null);
    return pcts.length > 0 ? Math.round(pcts.reduce((s, x) => s + x, 0) / pcts.length) : null;
  }, [attempts]);
  const atRiskCount = studentSummaries.filter((s) => s.latestPct !== null && s.latestPct < 50).length;

  // Bloom mastery rollup across all answers.
  const bloomStats = useMemo(() => {
    const out: { level: BloomLevel; correct: number; total: number; pct: number | null }[] = BLOOM_LEVELS.map((lvl) => ({
      level: lvl, correct: 0, total: 0, pct: null,
    }));
    for (const ans of answers) {
      const lvl = ans.bloom_level as BloomLevel | null;
      if (!lvl || !(BLOOM_LEVELS as readonly string[]).includes(lvl)) continue;
      const row = out.find((r) => r.level === lvl);
      if (!row) continue;
      row.total += 1;
      if (ans.is_correct) row.correct += 1;
    }
    for (const r of out) r.pct = pctOrNull(r.correct, r.total);
    return out;
  }, [answers]);

  // Top performer (across attempts) — single card on the right.
  const topPerformer = useMemo(() => {
    const ranked = studentSummaries
      .filter((s) => s.avgPct !== null && s.attempts > 0)
      .sort((a, b) => (b.avgPct ?? 0) - (a.avgPct ?? 0));
    return ranked[0] || null;
  }, [studentSummaries]);

  // ────────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto fade-in py-16 grid place-items-center">
        <div className="spinner" />
      </div>
    );
  }
  if (err) {
    return (
      <div className="max-w-3xl mx-auto fade-in mt-6">
        <Link href="/teacher/classes" className="text-sm text-emerald-700 font-semibold inline-flex items-center gap-1">
          <ArrowLeft size={14} /> All classes
        </Link>
        <div className="card mt-4 border-red-200 bg-red-50/50 text-red-800">{err}</div>
      </div>
    );
  }
  if (!klass) return null;

  return (
    <div className="max-w-6xl mx-auto fade-in">
      <Link href={`/teacher/classes/${klass.id}`} className="text-sm text-emerald-700 font-semibold inline-flex items-center gap-1">
        <ArrowLeft size={14} /> {klass.name}
      </Link>
      <h1 className="h1 mt-2 flex items-center gap-2">
        <BarChart3 size={24} /> Class analytics
      </h1>
      <p className="muted mt-1">
        Cross-test view of <strong>{klass.name}</strong>. Aggregates every quiz the class has taken.
      </p>

      {/* ============ KPI cards ============ */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-6">
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Tests assigned</div>
          <div className="text-3xl font-bold mt-1 flex items-center gap-2">
            <ListChecks size={22} className="text-emerald-700" /> {quizzes.length}
          </div>
          <div className="text-xs muted mt-1">
            {quizzes.length === 0 ? "Nothing assigned yet." : "Across this class's term"}
          </div>
        </div>
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Submitted attempts</div>
          <div className="text-3xl font-bold mt-1 flex items-center gap-2">
            <Send size={22} className="text-sky-700" /> {totalAttempts}
          </div>
          <div className="text-xs muted mt-1">
            from {members.length} student{members.length === 1 ? "" : "s"} on the roster
          </div>
        </div>
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Class average</div>
          <div className="text-3xl font-bold mt-1">
            {classAvg !== null ? `${classAvg}%` : "—"}
          </div>
          <div className="text-xs muted mt-1">
            {topPerformer && topPerformer.avgPct !== null
              ? <>top: <strong>{topPerformer.name}</strong> ({topPerformer.avgPct}%)</>
              : "no attempts yet"}
          </div>
        </div>
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">At risk (latest &lt; 50%)</div>
          <div className={`text-3xl font-bold mt-1 flex items-center gap-2 ${atRiskCount > 0 ? "text-red-700" : ""}`}>
            <AlertTriangle size={22} className={atRiskCount > 0 ? "text-red-700" : "text-slate-400"} /> {atRiskCount}
          </div>
          <div className="text-xs muted mt-1">
            students whose most-recent score is below half
          </div>
        </div>
      </div>

      {/* ============ Bloom mastery rollup ============ */}
      <section className="mt-8">
        <h2 className="h2 mb-1">Bloom mastery — class-wide</h2>
        <p className="muted text-xs mb-3">
          % correct per Bloom level across <strong>every attempt by every student</strong> on every quiz this class has taken.
        </p>
        <div className="card">
          {bloomStats.every((b) => b.total === 0) ? (
            <div className="muted text-sm py-4 text-center">No graded answers yet.</div>
          ) : (
            <div className="space-y-2">
              {bloomStats.map((b) => {
                const meta = BLOOM_META[b.level];
                const pct = b.pct ?? 0;
                return (
                  <div key={b.level} className="flex items-center gap-3">
                    <div className="w-24 text-sm font-semibold flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: meta.color }} />
                      {meta.label}
                    </div>
                    <div className="flex-1 h-3 rounded-full bg-slate-100 overflow-hidden">
                      <div className="h-full transition-all" style={{ width: `${pct}%`, background: meta.color }} />
                    </div>
                    <div className="w-32 text-right text-xs muted">
                      {b.total === 0 ? "no data" : <>{b.pct}% &nbsp;<span className="text-slate-400">({b.correct}/{b.total})</span></>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* ============ Per-student trajectory table ============ */}
      <section className="mt-8">
        <h2 className="h2 mb-1 flex items-center gap-2">
          <UsersIcon size={20} /> Students ({members.length})
        </h2>
        <p className="muted text-xs mb-3">
          Sorted lowest-average first so kids needing attention surface naturally. Trend = pp change between first and latest attempt.
        </p>
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-slate-500 border-b border-slate-100">
                <th className="text-left px-4 py-3 font-semibold">Student</th>
                <th className="text-right px-4 py-3 font-semibold">Attempts</th>
                <th className="text-right px-4 py-3 font-semibold">Average</th>
                <th className="text-right px-4 py-3 font-semibold">Latest</th>
                <th className="text-right px-4 py-3 font-semibold">Trend</th>
              </tr>
            </thead>
            <tbody>
              {studentSummaries.map((s) => {
                const flagged = s.latestPct !== null && s.latestPct < 50;
                let trendIcon = <Minus size={14} className="text-slate-400 inline" />;
                let trendColor = "text-slate-500";
                let trendText = "—";
                if (s.ppChange !== null) {
                  if (s.ppChange > 5) {
                    trendIcon = <TrendingUp size={14} className="text-emerald-700 inline" />;
                    trendColor = "text-emerald-700";
                    trendText = `+${s.ppChange} pp`;
                  } else if (s.ppChange < -5) {
                    trendIcon = <TrendingDown size={14} className="text-red-700 inline" />;
                    trendColor = "text-red-700";
                    trendText = `${s.ppChange} pp`;
                  } else {
                    trendIcon = <Minus size={14} className="text-slate-400 inline" />;
                    trendColor = "text-slate-500";
                    trendText = `${s.ppChange >= 0 ? "+" : ""}${s.ppChange} pp`;
                  }
                }
                return (
                  <tr key={s.studentId} className="border-b border-slate-50 last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-semibold flex items-center gap-2">
                        {s.name}
                        {flagged && (
                          <span className="text-[10px] uppercase tracking-wide font-bold text-red-800 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">
                            at risk
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">{s.attempts}</td>
                    <td className="px-4 py-3 text-right font-semibold">
                      {s.avgPct === null ? <span className="muted">—</span> : `${s.avgPct}%`}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {s.latestPct === null ? <span className="muted">—</span> : `${s.latestPct}%`}
                    </td>
                    <td className={`px-4 py-3 text-right ${trendColor}`}>
                      {trendIcon} <span className="ml-1">{trendText}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ============ Per-quiz summary ============ */}
      <section className="mt-8 mb-8">
        <h2 className="h2 mb-1 flex items-center gap-2">
          <ListChecks size={20} /> Tests in this class
        </h2>
        <p className="muted text-xs mb-3">
          Every quiz assigned to this class, with the class's performance on each.
        </p>
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-slate-500 border-b border-slate-100">
                <th className="text-left px-4 py-3 font-semibold">Test</th>
                <th className="text-left px-4 py-3 font-semibold">Subject</th>
                <th className="text-left px-4 py-3 font-semibold">Assigned by</th>
                <th className="text-right px-4 py-3 font-semibold">Attempts</th>
                <th className="text-right px-4 py-3 font-semibold">Class avg</th>
                <th className="text-right px-4 py-3 font-semibold">Last activity</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {quizSummaries.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center muted text-sm">
                    No quizzes assigned to this class yet.
                  </td>
                </tr>
              ) : (
                quizSummaries.map((q) => (
                  <tr key={q.quizId} className="border-b border-slate-50 last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-semibold">{q.name}</div>
                      <div className="text-xs muted font-mono">{q.code}</div>
                    </td>
                    <td className="px-4 py-3">{q.subject || <span className="muted">—</span>}</td>
                    <td className="px-4 py-3 text-sm">
                      {q.assignedByName
                        ? (q.assignedByMe ? <span className="font-semibold text-emerald-700">you</span> : q.assignedByName)
                        : <span className="muted">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right">{q.attempts}</td>
                    <td className="px-4 py-3 text-right font-semibold">
                      {q.avgPct === null ? <span className="muted">—</span> : `${q.avgPct}%`}
                    </td>
                    <td className="px-4 py-3 text-right text-xs muted">
                      {q.lastSubmittedAt
                        ? new Date(q.lastSubmittedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link href={`/teacher/quizzes/${q.quizId}`} className="text-emerald-700 text-sm font-semibold">
                        Open →
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
