"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { loadClassQuizIdsForClasses } from "@/lib/studentScope";
import {
  BarChart3, Download, Copy, ArrowLeft, Users, BookOpen, AlertTriangle,
  Sparkles, CheckCircle2, TrendingUp, AlertCircle, TrendingDown,
  Layers, UserX, Radio,
} from "lucide-react";
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip,
  BarChart, Bar, XAxis, YAxis, Legend, CartesianGrid,
} from "recharts";
import {
  BLOOM_LEVELS, BLOOM_COLORS, normaliseBloom, type BloomLevel,
} from "@/lib/bloomReports";
import AtRiskWatchlist from "@/components/AtRiskWatchlist";
import ClassComparisonHeatmap from "@/components/ClassComparisonHeatmap";
import EngagementTrends from "@/components/EngagementTrends";

// === Tabs ===========================================================
// The tab is sourced from the `tab` URL search param so it's bookmarkable
// and the browser back button restores the previous view. Default is
// "overview" — that renders the existing report exactly as before.
const TABS = [
  { id: "overview",   label: "Overview" },
  { id: "at-risk",    label: "At-risk" },
  { id: "compare",    label: "Compare" },
  { id: "engagement", label: "Engagement" },
] as const;
type TabId = (typeof TABS)[number]["id"];
function isTabId(x: string | null): x is TabId {
  return !!x && TABS.some((t) => t.id === x);
}

// === Date-range presets =============================================
const RANGE_PRESETS = [
  { id: "7",   label: "Last 7 days",  days: 7 },
  { id: "30",  label: "Last 30 days", days: 30 },
  { id: "90",  label: "Last 90 days", days: 90 },
  { id: "all", label: "All time",     days: null as number | null },
];

type Att = { id: string; student_id: string; quiz_id: string; score: number; total: number; submitted_at: string | null };
type Ans = { attempt_id: string; question_id: string; bloom_level: string | null; is_correct: boolean | null };
type Profile = { id: string; full_name: string | null; role: string };
type Cls = { id: string; name: string; grade: string | null; owner_id: string | null };
type Member = { class_id: string; student_id: string };

// Extra rows fetched only for the "More insights" section. Kept compact
// and read once per range change. We accept the extra round-trip cost
// (5–6 small queries) in exchange for the principal getting decision-
// ready insights without any heavy backend work.
type AsgRow = { quiz_id: string; class_id: string | null; student_id: string | null };
type QzRow  = { id: string; name: string; subject: string | null; owner_id: string | null; created_at: string | null };
type QbRow  = { id: string; topic_family: string | null; bloom_level: string | null; owner_id: string | null };

export default function SchoolReportsPage() {
  // Suspense wrapper is required because useSearchParams (used in Inner)
  // suspends during the very first render under the App Router.
  return (
    <Suspense fallback={<div className="grid place-items-center py-20"><div className="spinner" /></div>}>
      <SchoolReportsInner />
    </Suspense>
  );
}

function SchoolReportsInner() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();

  // Active tab — sourced from the URL so it survives reloads + sharing.
  const tabParam = search.get("tab");
  const activeTab: TabId = isTabId(tabParam) ? tabParam : "overview";
  function setTab(next: TabId) {
    const sp = new URLSearchParams(Array.from(search.entries()));
    if (next === "overview") sp.delete("tab");
    else sp.set("tab", next);
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  const [loading, setLoading] = useState(true);
  const [rangeId, setRangeId] = useState("30");
  const [schoolName, setSchoolName] = useState<string>("");
  // Lifted so the new tab components (At-risk / Compare / Engagement)
  // can fetch their own data scoped to the same school.
  const [schoolId, setSchoolId] = useState<string>("");

  const [classes, setClasses] = useState<Cls[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [teachers, setTeachers] = useState<Profile[]>([]);
  const [students, setStudents] = useState<Profile[]>([]);
  const [attempts, setAttempts] = useState<Att[]>([]);
  const [answers, setAnswers] = useState<Ans[]>([]);

  // Extras for the "More insights" section. Fetched in a second wave
  // after the core data so the page renders quickly and the bonus
  // panels fill in.
  const [assignments, setAssignments] = useState<AsgRow[]>([]);
  const [quizzesMeta, setQuizzesMeta] = useState<QzRow[]>([]);
  const [questionsMeta, setQuestionsMeta] = useState<QbRow[]>([]);
  const [liveSessionByTeacher, setLiveSessionByTeacher] = useState<Map<string, number>>(new Map());

  const reportRef = useRef<HTMLDivElement>(null);
  const [busyExport, setBusyExport] = useState<"pdf" | "xlsx" | "copy" | null>(null);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;

    const { data: prof } = await sb
      .from("profiles")
      .select("school_id")
      .eq("id", user.id)
      .single();
    if (!prof?.school_id) { setLoading(false); return; }
    setSchoolId(prof.school_id);

    const { data: school } = await sb.from("schools").select("name").eq("id", prof.school_id).single();
    setSchoolName((school as { name: string } | null)?.name || "Your school");

    // Date cutoff
    const preset = RANGE_PRESETS.find((r) => r.id === rangeId);
    const since = preset?.days
      ? new Date(Date.now() - preset.days * 24 * 60 * 60 * 1000).toISOString()
      : null;

    // Pull profiles in this school (split into students + teachers).
    const { data: profiles } = await sb
      .from("profiles")
      .select("id, full_name, role")
      .eq("school_id", prof.school_id);
    const profList = (profiles as Profile[]) || [];
    const teacherList = profList.filter((p) => p.role === "teacher");
    const studentList = profList.filter((p) => p.role === "student");
    setTeachers(teacherList);
    setStudents(studentList);

    // Classes in this school
    const { data: cs } = await sb
      .from("classes")
      .select("id, name, grade, owner_id")
      .eq("school_id", prof.school_id);
    const classList = (cs as Cls[]) || [];
    setClasses(classList);

    const classIds = classList.map((c) => c.id);
    if (classIds.length === 0) {
      setMembers([]); setAttempts([]); setAnswers([]);
      setLoading(false);
      return;
    }

    // Memberships (so we know which student belongs to which class)
    const { data: ms } = await sb
      .from("class_members")
      .select("class_id, student_id")
      .in("class_id", classIds);
    setMembers((ms as Member[]) || []);

    const studentIds = studentList.map((s) => s.id);
    if (studentIds.length === 0) {
      setAttempts([]); setAnswers([]);
      setLoading(false);
      return;
    }

    // Class-scoped quiz_ids for the school's classes. School reports
    // are official records — they MUST exclude personal practice the
    // student did on their own. We only count attempts on quizzes
    // that were formally assigned to the school's classes.
    const classQuizIds = await loadClassQuizIdsForClasses(sb, classIds);
    const classQuizIdArr = Array.from(classQuizIds);
    if (classQuizIdArr.length === 0) {
      setAttempts([]); setAnswers([]);
      setLoading(false);
      return;
    }

    // Attempts in window — scoped to class quizzes only.
    let attemptsQ = sb
      .from("quiz_attempts")
      .select("id, student_id, quiz_id, score, total, submitted_at")
      .in("student_id", studentIds)
      .in("quiz_id", classQuizIdArr)
      .not("submitted_at", "is", null);
    if (since) attemptsQ = attemptsQ.gte("submitted_at", since);
    const { data: atts } = await attemptsQ;
    const attList = (atts as Att[]) || [];
    setAttempts(attList);

    // Answers for those attempts
    if (attList.length === 0) {
      setAnswers([]);
      setLoading(false);
      return;
    }
    const attemptIds = attList.map((a) => a.id);
    const { data: ans } = await sb
      .from("attempt_answers")
      .select("attempt_id, question_id, bloom_level, is_correct")
      .in("attempt_id", attemptIds);
    setAnswers((ans as Ans[]) || []);

    // ── More-insights extras (parallel fetch). All five run together;
    // the page is already painted from the data above so this is a
    // background fill that updates the new section when it arrives.
    const [asgRes, quizRes, qbRes, liveRes] = await Promise.all([
      sb.from("quiz_assignments").select("quiz_id, class_id, student_id").in("class_id", classIds),
      sb.from("quizzes").select("id, name, subject, owner_id, created_at").in("id", classQuizIdArr),
      // Question bank rows for every question_id touched by the answers.
      // Used by question-quality flags + class-struggle topics + teacher
      // bloom contribution. Owners come from question_bank; quizzes
      // table also has owner but the question-bank owner is what counts
      // for "who wrote this question" attribution.
      (async () => {
        const qids = Array.from(new Set(((ans as Ans[]) || []).map((a) => a.question_id).filter(Boolean)));
        if (qids.length === 0) return { data: [] as QbRow[] };
        return sb.from("question_bank").select("id, topic_family, bloom_level, owner_id").in("id", qids);
      })(),
      // Count of live sessions per host teacher for adoption metric.
      sb.from("live_sessions").select("host_teacher_id").in("host_teacher_id", teacherList.map((t) => t.id).concat(["00000000-0000-0000-0000-000000000000"])),
    ]);
    setAssignments(((asgRes.data as unknown) as AsgRow[]) || []);
    setQuizzesMeta(((quizRes.data as unknown) as QzRow[]) || []);
    setQuestionsMeta(((qbRes.data as unknown) as QbRow[]) || []);
    const liveCounts = new Map<string, number>();
    for (const r of (((liveRes.data as unknown) as Array<{ host_teacher_id: string }>) || [])) {
      liveCounts.set(r.host_teacher_id, (liveCounts.get(r.host_teacher_id) || 0) + 1);
    }
    setLiveSessionByTeacher(liveCounts);

    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [rangeId]);

  // ============ Aggregations =====================================

  // 1) School-wide Bloom mix (count of answers at each level).
  const bloomMix = useMemo(() => {
    const counts: Record<BloomLevel, number> = {
      Remember: 0, Understand: 0, Apply: 0, Analyze: 0, Evaluate: 0, Create: 0,
    };
    for (const a of answers) {
      const lvl = normaliseBloom(a.bloom_level);
      if (lvl) counts[lvl]++;
    }
    const total = Object.values(counts).reduce((s, x) => s + x, 0);
    return BLOOM_LEVELS.map((lvl) => ({
      name: lvl,
      value: counts[lvl],
      pct: total > 0 ? Math.round((counts[lvl] / total) * 100) : 0,
    }));
  }, [answers]);

  // 2) Per-grade Bloom mix (stacked).
  const studentToClass = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) map.set(m.student_id, m.class_id);
    return map;
  }, [members]);
  const classById = useMemo(() => {
    const map = new Map<string, Cls>();
    for (const c of classes) map.set(c.id, c);
    return map;
  }, [classes]);
  const attemptToGrade = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of attempts) {
      const cid = studentToClass.get(a.student_id);
      if (!cid) continue;
      const grade = classById.get(cid)?.grade || "—";
      map.set(a.id, grade);
    }
    return map;
  }, [attempts, studentToClass, classById]);
  const gradeBloomMix = useMemo(() => {
    type Row = { grade: string } & Record<BloomLevel, number>;
    const grades = new Map<string, Row>();
    for (const ans of answers) {
      const grade = attemptToGrade.get(ans.attempt_id) || "—";
      const lvl = normaliseBloom(ans.bloom_level);
      if (!lvl) continue;
      let row = grades.get(grade);
      if (!row) {
        row = { grade, Remember: 0, Understand: 0, Apply: 0, Analyze: 0, Evaluate: 0, Create: 0 };
        grades.set(grade, row);
      }
      row[lvl]++;
    }
    return Array.from(grades.values()).sort((a, b) => {
      const an = Number(a.grade), bn = Number(b.grade);
      if (!isNaN(an) && !isNaN(bn)) return an - bn;
      if (!isNaN(an)) return -1;
      if (!isNaN(bn)) return 1;
      return a.grade.localeCompare(b.grade);
    });
  }, [answers, attemptToGrade]);

  // 3) Per-teacher activity.
  const teacherActivity = useMemo(() => {
    // We treat a class's owner_id (= primary teacher) as the teacher who
    // "runs" that class for activity-table purposes.
    const teacherOfClass = new Map<string, string>(); // class_id → teacher_id
    for (const c of classes) if (c.owner_id) teacherOfClass.set(c.id, c.owner_id);

    type Row = { id: string; name: string; classCount: number; studentCount: number; attemptCount: number; avgScore: number | null; bloomHigherPct: number };
    const rows = new Map<string, Row>();
    for (const t of teachers) {
      rows.set(t.id, { id: t.id, name: t.full_name || "(unnamed)", classCount: 0, studentCount: 0, attemptCount: 0, avgScore: null, bloomHigherPct: 0 });
    }
    for (const c of classes) {
      if (!c.owner_id) continue;
      const r = rows.get(c.owner_id);
      if (r) r.classCount++;
    }
    for (const m of members) {
      const t = teacherOfClass.get(m.class_id);
      if (!t) continue;
      const r = rows.get(t);
      if (r) r.studentCount++;
    }
    // Aggregate attempts and Bloom mix by teacher.
    const ratiosByTeacher = new Map<string, number[]>();
    const higherByTeacher = new Map<string, { total: number; higher: number }>();
    for (const a of attempts) {
      const cid = studentToClass.get(a.student_id);
      if (!cid) continue;
      const tid = teacherOfClass.get(cid);
      if (!tid) continue;
      const r = rows.get(tid);
      if (!r) continue;
      r.attemptCount++;
      if (a.total > 0) {
        const arr = ratiosByTeacher.get(tid) || [];
        arr.push((a.score / a.total) * 100);
        ratiosByTeacher.set(tid, arr);
      }
    }
    for (const ans of answers) {
      const cid = studentToClass.get(
        attempts.find((a) => a.id === ans.attempt_id)?.student_id || ""
      );
      if (!cid) continue;
      const tid = teacherOfClass.get(cid);
      if (!tid) continue;
      const lvl = normaliseBloom(ans.bloom_level);
      if (!lvl) continue;
      const cur = higherByTeacher.get(tid) || { total: 0, higher: 0 };
      cur.total++;
      if (["Analyze", "Evaluate", "Create"].includes(lvl)) cur.higher++;
      higherByTeacher.set(tid, cur);
    }
    rows.forEach((r) => {
      const ratios = ratiosByTeacher.get(r.id) || [];
      r.avgScore = ratios.length ? Math.round(ratios.reduce((s, x) => s + x, 0) / ratios.length) : null;
      const h = higherByTeacher.get(r.id);
      r.bloomHigherPct = h && h.total > 0 ? Math.round((h.higher / h.total) * 100) : 0;
    });
    return Array.from(rows.values()).sort((a, b) => (b.avgScore ?? -1) - (a.avgScore ?? -1));
  }, [teachers, classes, members, attempts, answers, studentToClass]);

  // 4) Class leaderboard — avg score per class.
  const classLeaderboard = useMemo(() => {
    type Row = { id: string; name: string; grade: string | null; students: number; attempts: number; avgScore: number | null };
    const rows = new Map<string, Row>();
    for (const c of classes) {
      rows.set(c.id, { id: c.id, name: c.name, grade: c.grade, students: 0, attempts: 0, avgScore: null });
    }
    for (const m of members) {
      const r = rows.get(m.class_id);
      if (r) r.students++;
    }
    const ratiosByClass = new Map<string, number[]>();
    for (const a of attempts) {
      const cid = studentToClass.get(a.student_id);
      if (!cid) continue;
      const r = rows.get(cid);
      if (!r) continue;
      r.attempts++;
      if (a.total > 0) {
        const arr = ratiosByClass.get(cid) || [];
        arr.push((a.score / a.total) * 100);
        ratiosByClass.set(cid, arr);
      }
    }
    rows.forEach((r) => {
      const ratios = ratiosByClass.get(r.id) || [];
      r.avgScore = ratios.length ? Math.round(ratios.reduce((s, x) => s + x, 0) / ratios.length) : null;
    });
    return Array.from(rows.values()).sort((a, b) => (b.avgScore ?? -1) - (a.avgScore ?? -1));
  }, [classes, members, attempts, studentToClass]);

  // 5) At-risk students: avg < 50% across 3+ attempts in window.
  // Includes the student's class name so a principal scanning the
  // list can immediately tell which teacher to talk to about Aanya
  // vs Dev — without it, the list is just names floating in space.
  const atRisk = useMemo(() => {
    type Row = { id: string; name: string; className: string | null; grade: string | null; attempts: number; avgScore: number };
    const studentRatios = new Map<string, number[]>();
    for (const a of attempts) {
      if (a.total <= 0) continue;
      const arr = studentRatios.get(a.student_id) || [];
      arr.push((a.score / a.total) * 100);
      studentRatios.set(a.student_id, arr);
    }
    const rows: Row[] = [];
    students.forEach((s) => {
      const ratios = studentRatios.get(s.id) || [];
      if (ratios.length < 3) return;
      const avg = Math.round(ratios.reduce((sum, x) => sum + x, 0) / ratios.length);
      if (avg >= 50) return;
      const cid = studentToClass.get(s.id);
      const cls = cid ? classById.get(cid) : null;
      rows.push({
        id: s.id,
        name: s.full_name || "(unnamed)",
        className: cls?.name ?? null,
        grade: cls?.grade ?? null,
        attempts: ratios.length,
        avgScore: avg,
      });
    });
    return rows.sort((a, b) => a.avgScore - b.avgScore).slice(0, 20);
  }, [attempts, students, studentToClass, classById]);

  // ============ Headline numbers (one-liners) =====================
  const totalAttempts = attempts.length;
  const overallAvg = useMemo(() => {
    const ratios = attempts.filter((a) => a.total > 0).map((a) => (a.score / a.total) * 100);
    return ratios.length ? Math.round(ratios.reduce((s, x) => s + x, 0) / ratios.length) : null;
  }, [attempts]);
  const totalAnswers = answers.length;
  const higherOrderPct = useMemo(() => {
    if (totalAnswers === 0) return 0;
    const higher = answers.filter((a) => {
      const lvl = normaliseBloom(a.bloom_level);
      return lvl === "Analyze" || lvl === "Evaluate" || lvl === "Create";
    }).length;
    return Math.round((higher / totalAnswers) * 100);
  }, [answers, totalAnswers]);

  // ============ More insights — decision-driving stats ===============
  // Each block computes a small, focused signal a principal can act on.
  // Cheap to recompute (memos over already-fetched data) and rendered
  // compactly under a single "More insights" header below.

  // ─── Insight #2: Submission rate ───────────────────────────────
  // Of all assignments × eligible students, how many submitted? This
  // catches engagement collapse early — a 35% submission rate hides
  // behind a 65% average and the principal would never know.
  const submissionRate = useMemo(() => {
    type ClassRow = { id: string; name: string; expected: number; submitted: number; pct: number };
    const memberCount = new Map<string, number>();
    for (const m of members) memberCount.set(m.class_id, (memberCount.get(m.class_id) || 0) + 1);
    const expectedByClass = new Map<string, number>();
    for (const a of assignments) {
      if (!a.class_id) continue;
      const expected = a.student_id ? 1 : (memberCount.get(a.class_id) || 0);
      expectedByClass.set(a.class_id, (expectedByClass.get(a.class_id) || 0) + expected);
    }
    const submittedByClass = new Map<string, Set<string>>();
    for (const att of attempts) {
      const cid = studentToClass.get(att.student_id);
      if (!cid) continue;
      const key = `${cid}|${att.quiz_id}|${att.student_id}`;
      const set = submittedByClass.get(cid) || new Set<string>();
      set.add(key);
      submittedByClass.set(cid, set);
    }
    const rows: ClassRow[] = classes.map((c) => {
      const expected = expectedByClass.get(c.id) || 0;
      const submitted = submittedByClass.get(c.id)?.size || 0;
      const pct = expected > 0 ? Math.round((submitted / expected) * 100) : 0;
      return { id: c.id, name: c.name, expected, submitted, pct };
    }).filter((r) => r.expected > 0);
    const totalExpected = rows.reduce((s, r) => s + r.expected, 0);
    const totalSubmitted = rows.reduce((s, r) => s + r.submitted, 0);
    const overallPct = totalExpected > 0 ? Math.round((totalSubmitted / totalExpected) * 100) : 0;
    return {
      overallPct,
      totalExpected,
      totalSubmitted,
      classes: rows.sort((a, b) => a.pct - b.pct), // lowest first — that's where attention goes
    };
  }, [assignments, attempts, members, classes, studentToClass]);

  // ─── Insight #3: Week-over-week trend (last 8 weeks) ───────────
  // Single most useful trend signal: are we improving or sliding?
  const weeklyTrend = useMemo(() => {
    type Week = { weekStart: string; attempts: number; avg: number | null };
    // Bucket by ISO week. Use Sunday as the boundary so school-week
    // boundaries align with how teachers think about weeks.
    const buckets = new Map<string, number[]>(); // weekKey -> ratio[]
    for (const a of attempts) {
      if (!a.submitted_at || a.total <= 0) continue;
      const d = new Date(a.submitted_at);
      const day = d.getDay();
      d.setDate(d.getDate() - day);
      d.setHours(0, 0, 0, 0);
      const key = d.toISOString().slice(0, 10);
      const arr = buckets.get(key) || [];
      arr.push((a.score / a.total) * 100);
      buckets.set(key, arr);
    }
    // Build a contiguous trailing-8-week strip even if some weeks are empty.
    const out: Week[] = [];
    const today = new Date();
    today.setDate(today.getDate() - today.getDay());
    today.setHours(0, 0, 0, 0);
    for (let i = 7; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i * 7);
      const key = d.toISOString().slice(0, 10);
      const ratios = buckets.get(key) || [];
      out.push({
        weekStart: key,
        attempts: ratios.length,
        avg: ratios.length ? Math.round(ratios.reduce((s, x) => s + x, 0) / ratios.length) : null,
      });
    }
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    const eight = out[0];
    const deltaAvg = last?.avg != null && prev?.avg != null ? last.avg - prev.avg : null;
    const deltaAvg8 = last?.avg != null && eight?.avg != null ? last.avg - eight.avg : null;
    const deltaAtt = last && prev ? last.attempts - prev.attempts : 0;
    return { weeks: out, deltaAvg, deltaAvg8, deltaAtt };
  }, [attempts]);

  // ─── Insight #4: Question quality flags ─────────────────────────
  // Surface curriculum hygiene: too-easy (>=95% correct), too-hard
  // (<=25% correct), and unused questions (in answers' source bank
  // but never asked). Good talking-point for faculty meetings.
  const qualityFlags = useMemo(() => {
    const stats = new Map<string, { correct: number; total: number }>();
    for (const a of answers) {
      if (!a.question_id) continue;
      const s = stats.get(a.question_id) || { correct: 0, total: 0 };
      s.total++;
      if (a.is_correct) s.correct++;
      stats.set(a.question_id, s);
    }
    const tooEasy: number[] = [];
    const tooHard: number[] = [];
    stats.forEach((s) => {
      if (s.total < 3) return; // not enough signal yet
      const pct = (s.correct / s.total) * 100;
      if (pct >= 95) tooEasy.push(pct);
      else if (pct <= 25) tooHard.push(pct);
    });
    const askedIds = new Set(stats.keys());
    const unusedCount = questionsMeta.filter((q) => !askedIds.has(q.id)).length;
    return { tooEasy: tooEasy.length, tooHard: tooHard.length, unused: unusedCount, totalChecked: stats.size };
  }, [answers, questionsMeta]);

  // ─── Insight #5: Class struggle topics ──────────────────────────
  // For each class, find the topic_family where they scored
  // significantly worse than school-wide average. Driver of "what
  // should the teacher re-teach next week" decisions.
  const classStruggle = useMemo(() => {
    type Row = { className: string; topic: string; classPct: number; schoolPct: number; delta: number };
    const qbById = new Map<string, QbRow>();
    for (const q of questionsMeta) qbById.set(q.id, q);

    // Collect per-(class, topic) stats and per-topic school stats.
    const classTopic = new Map<string, { correct: number; total: number }>();
    const schoolTopic = new Map<string, { correct: number; total: number }>();
    for (const ans of answers) {
      const att = attempts.find((x) => x.id === ans.attempt_id);
      if (!att) continue;
      const cid = studentToClass.get(att.student_id);
      if (!cid) continue;
      const qb = qbById.get(ans.question_id);
      const topic = qb?.topic_family;
      if (!topic) continue;
      const ctKey = `${cid}|${topic}`;
      const ct = classTopic.get(ctKey) || { correct: 0, total: 0 };
      ct.total++; if (ans.is_correct) ct.correct++;
      classTopic.set(ctKey, ct);
      const st = schoolTopic.get(topic) || { correct: 0, total: 0 };
      st.total++; if (ans.is_correct) st.correct++;
      schoolTopic.set(topic, st);
    }
    const rows: Row[] = [];
    classTopic.forEach((s, key) => {
      const [cid, topic] = key.split("|");
      if (s.total < 5) return;
      const cls = classById.get(cid);
      const school = schoolTopic.get(topic);
      if (!cls || !school || school.total < 10) return;
      const classPct = Math.round((s.correct / s.total) * 100);
      const schoolPct = Math.round((school.correct / school.total) * 100);
      const delta = classPct - schoolPct;
      if (delta > -10) return; // not a meaningful gap
      rows.push({ className: cls.name, topic, classPct, schoolPct, delta });
    });
    return rows.sort((a, b) => a.delta - b.delta).slice(0, 8);
  }, [answers, attempts, questionsMeta, classById, studentToClass]);

  // ─── Insight #6: Teacher Bloom contribution ─────────────────────
  // Per-teacher distribution of the Bloom levels in the questions
  // they OWN. Surfaces which teachers write higher-order tests vs
  // which need PD on writing them. Drives concrete training decisions.
  const teacherBloom = useMemo(() => {
    type Row = { teacher: Profile; counts: Record<string, number>; total: number; higherPct: number };
    const byOwner = new Map<string, Map<string, number>>();
    for (const q of questionsMeta) {
      if (!q.owner_id || !q.bloom_level) continue;
      const lvl = normaliseBloom(q.bloom_level) || q.bloom_level;
      const m = byOwner.get(q.owner_id) || new Map<string, number>();
      m.set(lvl, (m.get(lvl) || 0) + 1);
      byOwner.set(q.owner_id, m);
    }
    const rows: Row[] = [];
    for (const t of teachers) {
      const m = byOwner.get(t.id);
      if (!m) continue;
      const counts: Record<string, number> = {};
      let total = 0;
      m.forEach((v, k) => { counts[k] = v; total += v; });
      if (total === 0) continue;
      const higher = (counts["Analyze"] || 0) + (counts["Evaluate"] || 0) + (counts["Create"] || 0);
      rows.push({ teacher: t, counts, total, higherPct: Math.round((higher / total) * 100) });
    }
    return rows.sort((a, b) => b.higherPct - a.higherPct);
  }, [questionsMeta, teachers]);

  // ─── Insight #7: Inactive students ─────────────────────────────
  // Students with school accounts who haven't taken a test in 14+ days.
  // Different from at-risk — these are kids the platform isn't
  // touching, often because their teacher hasn't assigned anything.
  const inactiveStudents = useMemo(() => {
    type Row = { id: string; name: string; className: string | null; daysInactive: number };
    const lastByStudent = new Map<string, number>();
    for (const a of attempts) {
      if (!a.submitted_at) continue;
      const t = Date.parse(a.submitted_at);
      const cur = lastByStudent.get(a.student_id);
      if (cur == null || t > cur) lastByStudent.set(a.student_id, t);
    }
    const now = Date.now();
    const rows: Row[] = [];
    for (const s of students) {
      const last = lastByStudent.get(s.id);
      const daysInactive = last ? Math.floor((now - last) / (24 * 3600 * 1000)) : 9999;
      if (daysInactive < 14) continue;
      const cid = studentToClass.get(s.id);
      const cls = cid ? classById.get(cid) : null;
      rows.push({
        id: s.id,
        name: s.full_name || "(unnamed)",
        className: cls?.name ?? null,
        daysInactive: daysInactive >= 9999 ? -1 : daysInactive,
      });
    }
    return rows.sort((a, b) => b.daysInactive - a.daysInactive).slice(0, 15);
  }, [attempts, students, studentToClass, classById]);

  // ─── Insight #8: Subject coverage gaps ──────────────────────────
  // Subjects that haven't seen a NEW test in 30+ days. Tells the
  // principal "we've assessed Math twice this month but Hindi has
  // had no new tests in 6 weeks — is that intentional?"
  const subjectCoverage = useMemo(() => {
    type Row = { subject: string; lastCreated: string | null; daysSince: number; testCount: number };
    const bySubject = new Map<string, { lastTs: number; count: number }>();
    for (const q of quizzesMeta) {
      const subj = (q.subject || "Other").trim() || "Other";
      const ts = q.created_at ? Date.parse(q.created_at) : 0;
      const cur = bySubject.get(subj) || { lastTs: 0, count: 0 };
      cur.count++;
      if (ts > cur.lastTs) cur.lastTs = ts;
      bySubject.set(subj, cur);
    }
    const now = Date.now();
    const rows: Row[] = [];
    bySubject.forEach((v, subject) => {
      const daysSince = v.lastTs ? Math.floor((now - v.lastTs) / (24 * 3600 * 1000)) : 9999;
      rows.push({
        subject,
        lastCreated: v.lastTs ? new Date(v.lastTs).toISOString().slice(0, 10) : null,
        daysSince: daysSince >= 9999 ? -1 : daysSince,
        testCount: v.count,
      });
    });
    return rows.sort((a, b) => b.daysSince - a.daysSince);
  }, [quizzesMeta]);

  // ─── Insight #10: Live class quiz adoption ──────────────────────
  // How many teachers in the school have hosted at least one live
  // session? Signal for whether the engagement-only feature is
  // being used or sitting idle.
  const liveAdoption = useMemo(() => {
    let adopters = 0;
    let totalSessions = 0;
    liveSessionByTeacher.forEach((c) => {
      if (c > 0) adopters++;
      totalSessions += c;
    });
    const totalTeachers = teachers.length;
    return {
      adopters,
      totalTeachers,
      totalSessions,
      adoptionPct: totalTeachers > 0 ? Math.round((adopters / totalTeachers) * 100) : 0,
    };
  }, [liveSessionByTeacher, teachers]);

  // ============ Exports ===========================================

  async function downloadPDF() {
    if (!reportRef.current) return;
    setBusyExport("pdf");
    setExportMsg(null);
    try {
      const html2canvas = (await import("html2canvas")).default;
      const { jsPDF } = await import("jspdf");
      const canvas = await html2canvas(reportRef.current, {
        scale: 2,
        backgroundColor: "#ffffff",
        useCORS: true,
      });
      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF({ unit: "pt", format: "a4", orientation: "portrait" });
      const pdfW = pdf.internal.pageSize.getWidth();
      const pdfH = pdf.internal.pageSize.getHeight();
      const imgW = pdfW - 32;
      const imgH = (canvas.height * imgW) / canvas.width;
      let y = 16;
      // Multi-page if the snapshot is taller than one page.
      if (imgH < pdfH - 32) {
        pdf.addImage(imgData, "PNG", 16, y, imgW, imgH);
      } else {
        // Slice into pages.
        const pageImgH = pdfH - 32;
        const sliceCanvas = document.createElement("canvas");
        sliceCanvas.width = canvas.width;
        const ctx = sliceCanvas.getContext("2d")!;
        const sliceHeightPx = (canvas.width * pageImgH) / imgW;
        let renderedY = 0;
        let first = true;
        while (renderedY < canvas.height) {
          const h = Math.min(sliceHeightPx, canvas.height - renderedY);
          sliceCanvas.height = h;
          ctx.clearRect(0, 0, sliceCanvas.width, sliceCanvas.height);
          ctx.drawImage(canvas, 0, renderedY, canvas.width, h, 0, 0, canvas.width, h);
          const sliceData = sliceCanvas.toDataURL("image/png");
          if (!first) pdf.addPage();
          pdf.addImage(sliceData, "PNG", 16, 16, imgW, (h * imgW) / canvas.width);
          renderedY += h;
          first = false;
        }
      }
      pdf.save(`${schoolName.replace(/\s+/g, "_")}_BloomPulse_${rangeId}.pdf`);
    } catch (e) {
      setExportMsg(`PDF export failed: ${e instanceof Error ? e.message : "unknown error"}`);
    } finally {
      setBusyExport(null);
    }
  }

  async function downloadXlsx() {
    setBusyExport("xlsx");
    setExportMsg(null);
    try {
      const { addSheet, downloadWorkbook, newWorkbook } = await import("@/lib/excelReport");
      const wb = newWorkbook();
      const stamp = `Generated ${new Date().toLocaleString()}`;
      const range = RANGE_PRESETS.find((r) => r.id === rangeId)?.label || rangeId;

      addSheet(wb, {
        name: "Summary",
        title: `Bloom Pulse — ${schoolName}`,
        subtitle: `${range} · ${stamp}`,
        headers: ["Metric", "Value"],
        rows: [
          ["Date range", range],
          ["Generated", new Date().toLocaleString()],
          ["Total attempts", totalAttempts],
          ["Overall average score (%)", overallAvg ?? "—"],
          ["Higher-order question share (%)", higherOrderPct],
        ],
      });

      addSheet(wb, {
        name: "Bloom mix",
        title: "Bloom-level mix",
        subtitle: stamp,
        headers: ["Bloom level", "Answers", "% of all answers"],
        rows: bloomMix.map((r) => [r.name, r.value, r.pct]),
      });

      addSheet(wb, {
        name: "Bloom by grade",
        title: "Bloom mix per grade",
        subtitle: stamp,
        headers: ["Grade", ...BLOOM_LEVELS, "Total"],
        rows: gradeBloomMix.map((row) => {
          const counts = BLOOM_LEVELS.map((l) => row[l]);
          const total = counts.reduce((s, x) => s + x, 0);
          return [row.grade, ...counts, total];
        }),
      });

      addSheet(wb, {
        name: "Teachers",
        title: "Teacher activity",
        subtitle: stamp,
        headers: ["Teacher", "Classes", "Students", "Attempts", "Avg score (%)", "Higher-order (%)"],
        rows: teacherActivity.map((t) => [t.name, t.classCount, t.studentCount, t.attemptCount, t.avgScore ?? "—", t.bloomHigherPct]),
      });

      addSheet(wb, {
        name: "Classes",
        title: "Class leaderboard",
        subtitle: stamp,
        headers: ["Class", "Grade", "Students", "Attempts", "Avg score (%)"],
        rows: classLeaderboard.map((c) => [c.name, c.grade ?? "—", c.students, c.attempts, c.avgScore ?? "—"]),
      });

      addSheet(wb, {
        name: "At-risk students",
        title: "At-risk students",
        subtitle: stamp,
        headers: ["Student", "Class", "Grade", "Attempts (window)", "Avg score (%)"],
        rows: atRisk.map((s) => [s.name, s.className ?? "—", s.grade ?? "—", s.attempts, s.avgScore]),
      });

      await downloadWorkbook(wb, `${schoolName.replace(/\s+/g, "_")}_BloomPulse_${rangeId}.xlsx`);
    } catch (e) {
      setExportMsg(`Excel export failed: ${e instanceof Error ? e.message : "unknown error"}`);
    } finally {
      setBusyExport(null);
    }
  }

  function copySummary() {
    setBusyExport("copy");
    const lines: string[] = [];
    lines.push(`Bloom Pulse — ${schoolName}`);
    lines.push(`Range: ${RANGE_PRESETS.find((r) => r.id === rangeId)?.label || rangeId}`);
    lines.push("");
    lines.push(`• ${totalAttempts} attempts, overall avg ${overallAvg ?? "—"}%`);
    lines.push(`• Higher-order share (Analyze/Evaluate/Create): ${higherOrderPct}%`);
    lines.push("");
    lines.push("Bloom mix:");
    for (const r of bloomMix) lines.push(`  - ${r.name}: ${r.pct}% (${r.value})`);
    lines.push("");
    lines.push("Top classes:");
    for (const c of classLeaderboard.slice(0, 5)) lines.push(`  - ${c.name}: ${c.avgScore ?? "—"}%`);
    if (atRisk.length > 0) {
      lines.push("");
      lines.push(`At-risk: ${atRisk.length} student${atRisk.length === 1 ? "" : "s"} below 50% across 3+ attempts:`);
      // Include the class against each name so the principal pasting
      // this summary into a teachers' WhatsApp / email immediately
      // knows which teacher owns each kid — without it the recipient
      // has to look up the roster manually.
      for (const s of atRisk) {
        lines.push(`  - ${s.name}${s.className ? ` (${s.className})` : ""} — ${s.avgScore}% over ${s.attempts} attempts`);
      }
    }
    const txt = lines.join("\n");
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(txt).catch(() => {});
    }
    setExportMsg("Summary copied to clipboard.");
    setTimeout(() => setExportMsg(null), 2500);
    setBusyExport(null);
  }

  // The parent's `loading` only covers the Overview-specific data. The
  // other tabs render their own components which manage their own load
  // state; we don't want to block the whole page on Overview's data when
  // an admin lands on /school/reports?tab=at-risk.
  const showOverviewLoading = loading && activeTab === "overview";

  return (
    <div className="max-w-6xl mx-auto fade-in">
      <Link href="/school" className="text-sm text-emerald-700 font-semibold inline-flex items-center gap-1"><ArrowLeft size={14} /> School home</Link>

      {/* Header */}
      <div className="mt-2 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="h1 flex items-center gap-2"><BarChart3 size={28} /> Bloom Pulse</h1>
          <p className="muted mt-1">{schoolName || "Your school"} · How your school is teaching across Bloom&rsquo;s taxonomy.</p>
          {/* Scope note. School-wide aggregations differ from a teacher's
              filtered view — every test, every class, every attempt in
              the school is rolled up here, regardless of which teacher
              created or assigned it. */}
          <p className="text-xs muted mt-1 max-w-3xl">
            <strong className="text-slate-700">Scope:</strong> Every test made by any teacher in this school and every submitted class attempt across all classes — filtered by the date range above. Live class engagement is excluded (it&apos;s tracked separately and doesn&apos;t affect the class record). Admin Head and Deputies share this view.
          </p>
        </div>
        {activeTab === "overview" && (
          <div className="flex items-center gap-2 flex-wrap">
            <select className="select max-w-[160px]" value={rangeId} onChange={(e) => setRangeId(e.target.value)}>
              {RANGE_PRESETS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
            <button type="button" className="btn btn-secondary" onClick={downloadPDF} disabled={busyExport !== null}>
              <Download size={14} /> {busyExport === "pdf" ? "Building…" : "PDF"}
            </button>
            <button type="button" className="btn btn-secondary" onClick={downloadXlsx} disabled={busyExport !== null}>
              <Download size={14} /> {busyExport === "xlsx" ? "Building…" : "Excel"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={copySummary} disabled={busyExport !== null}>
              <Copy size={14} /> Copy summary
            </button>
          </div>
        )}
      </div>

      {/* Tab bar — pill buttons styled like RANGE_PRESETS chips. Sits
          between the header and the Overview's date-range selector. */}
      <div className="mt-4 flex items-center gap-2 flex-wrap" role="tablist" aria-label="Reports">
        {TABS.map((t) => {
          const active = t.id === activeTab;
          return (
            <button type="button"
              key={t.id}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.id)}
              className={
                "px-3 py-1.5 rounded-full text-sm font-medium border transition " +
                (active
                  ? "bg-emerald-600 text-white border-emerald-600 shadow-sm"
                  : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50")
              }
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {exportMsg && activeTab === "overview" && (
        <div className="mt-3 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded-lg">
          {exportMsg}
        </div>
      )}

      {/* === Non-overview tabs ====================================== */}
      {activeTab === "at-risk" && (
        <div className="mt-6">
          {schoolId ? <AtRiskWatchlist schoolId={schoolId} schoolName={schoolName} /> : (
            <div className="grid place-items-center py-20"><div className="spinner" /></div>
          )}
        </div>
      )}
      {activeTab === "compare" && (
        <div className="mt-6">
          {schoolId ? <ClassComparisonHeatmap schoolId={schoolId} schoolName={schoolName} /> : (
            <div className="grid place-items-center py-20"><div className="spinner" /></div>
          )}
        </div>
      )}
      {activeTab === "engagement" && (
        <div className="mt-6">
          {schoolId ? <EngagementTrends schoolId={schoolId} schoolName={schoolName} /> : (
            <div className="grid place-items-center py-20"><div className="spinner" /></div>
          )}
        </div>
      )}

      {/* === Overview tab — preserved exactly as before ============= */}
      {activeTab === "overview" && showOverviewLoading && (
        <div className="grid place-items-center py-20"><div className="spinner" /></div>
      )}
      {activeTab === "overview" && !showOverviewLoading && (
      <div ref={reportRef} className="mt-6 space-y-6">
        {/* Headline numbers */}
        <div className="grid sm:grid-cols-3 gap-3">
          <div className="card">
            <div className="text-xs muted uppercase font-semibold">Attempts</div>
            <div className="text-3xl font-bold mt-1">{totalAttempts}</div>
            <div className="text-xs muted mt-0.5">submitted in the selected range</div>
          </div>
          <div className="card">
            <div className="text-xs muted uppercase font-semibold">Overall average</div>
            <div className="text-3xl font-bold mt-1">{overallAvg !== null ? `${overallAvg}%` : "—"}</div>
            <div className="text-xs muted mt-0.5">across all submitted attempts</div>
          </div>
          <div className="card">
            <div className="text-xs muted uppercase font-semibold">Higher-order share</div>
            <div className="text-3xl font-bold mt-1">{higherOrderPct}%</div>
            <div className="text-xs muted mt-0.5">questions at Analyze, Evaluate, or Create</div>
          </div>
        </div>

        {/* Bloom mix donut */}
        <div className="card">
          <h3 className="font-semibold mb-3 flex items-center gap-2"><BookOpen size={16} /> Bloom mix across the school</h3>
          {totalAnswers === 0 ? (
            <p className="muted text-sm">No graded answers in this window yet.</p>
          ) : (
            <div className="grid sm:grid-cols-[280px_1fr] gap-4 items-center">
              <div style={{ width: "100%", height: 240 }}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={bloomMix} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={90} paddingAngle={2}>
                      {bloomMix.map((d) => <Cell key={d.name} fill={BLOOM_COLORS[d.name as BloomLevel]} />)}
                    </Pie>
                    <Tooltip formatter={(v: number, name: string, p: { payload?: { pct?: number } }) => [`${v} (${p.payload?.pct}%)`, name]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="text-sm">
                <table className="w-full">
                  {/* Header row added — without it the two right-hand
                      numbers (raw count vs share-of-total) are
                      indistinguishable to a principal scanning the
                      table for the first time. */}
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide muted border-b border-slate-200">
                      <th className="py-1.5 pr-2 text-left font-semibold">Bloom level</th>
                      <th className="py-1.5 text-right font-semibold" title="Raw count of answers tagged at this Bloom level in the selected window">Answers</th>
                      <th className="py-1.5 text-right font-semibold w-12" title="This level's share of all answers in the selected window">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bloomMix.map((r) => (
                      <tr key={r.name} className="border-b border-slate-100 last:border-b-0">
                        <td className="py-1.5 pr-2 flex items-center gap-2"><span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: BLOOM_COLORS[r.name as BloomLevel] }} /> {r.name}</td>
                        <td className="py-1.5 text-right tabular-nums">{r.value}</td>
                        <td className="py-1.5 text-right font-semibold tabular-nums w-12">{r.pct}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-xs muted mt-3">
                  A healthy school usually has at least <strong>30–40%</strong> of questions at the higher-order tiers (Analyze, Evaluate, Create) by the senior grades.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Per-grade Bloom mix */}
        <div className="card">
          <h3 className="font-semibold mb-3">Bloom mix by grade</h3>
          {gradeBloomMix.length === 0 ? (
            <p className="muted text-sm">No grade-level data yet.</p>
          ) : (
            <div style={{ width: "100%", height: 280 }}>
              <ResponsiveContainer>
                <BarChart data={gradeBloomMix}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="grade" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  {BLOOM_LEVELS.map((lvl) => (
                    <Bar key={lvl} dataKey={lvl} stackId="a" fill={BLOOM_COLORS[lvl]} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Per-teacher activity */}
        <div className="card">
          <h3 className="font-semibold mb-3 flex items-center gap-2"><Users size={16} /> Teacher activity</h3>
          {teacherActivity.length === 0 ? (
            <p className="muted text-sm">No teachers yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase muted">
                  <tr>
                    <th className="px-3 py-2 text-left">Teacher</th>
                    <th className="px-3 py-2 text-right">Classes</th>
                    <th className="px-3 py-2 text-right">Students</th>
                    <th className="px-3 py-2 text-right">Attempts</th>
                    <th className="px-3 py-2 text-right">Avg score</th>
                    <th className="px-3 py-2 text-right">Higher-order %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {teacherActivity.map((t) => (
                    <tr key={t.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2 font-medium">{t.name}</td>
                      <td className="px-3 py-2 text-right">{t.classCount}</td>
                      <td className="px-3 py-2 text-right">{t.studentCount}</td>
                      <td className="px-3 py-2 text-right">{t.attemptCount}</td>
                      <td className="px-3 py-2 text-right font-semibold">{t.avgScore !== null ? `${t.avgScore}%` : "—"}</td>
                      <td className="px-3 py-2 text-right">{t.bloomHigherPct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Class leaderboard */}
        <div className="card">
          <h3 className="font-semibold mb-3">Class leaderboard</h3>
          {classLeaderboard.length === 0 ? (
            <p className="muted text-sm">No classes yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase muted">
                  <tr>
                    <th className="px-3 py-2 text-left">Class</th>
                    <th className="px-3 py-2 text-right">Grade</th>
                    <th className="px-3 py-2 text-right">Students</th>
                    <th className="px-3 py-2 text-right">Attempts</th>
                    <th className="px-3 py-2 text-right">Avg score</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {classLeaderboard.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2 font-medium">{c.name}</td>
                      <td className="px-3 py-2 text-right">{c.grade ?? "—"}</td>
                      <td className="px-3 py-2 text-right">{c.students}</td>
                      <td className="px-3 py-2 text-right">{c.attempts}</td>
                      <td className={`px-3 py-2 text-right font-semibold ${
                        c.avgScore === null ? "text-slate-400" :
                        c.avgScore >= 70 ? "text-emerald-700" :
                        c.avgScore >= 50 ? "text-amber-700" : "text-red-700"
                      }`}>
                        {c.avgScore !== null ? `${c.avgScore}%` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ───────────────────────────────────────────────────────
            More insights — decision-driving stats. Each card answers
            one question: "what should I do this week?" rather than
            describing the past.
            ─────────────────────────────────────────────────────── */}
        <h2 className="h2 mt-8 mb-3 flex items-center gap-2"><Sparkles size={20} /> More insights</h2>
        <div className="grid lg:grid-cols-2 gap-4">

          {/* Submission rate */}
          <div className="card">
            <h3 className="font-semibold mb-1 flex items-center gap-2"><CheckCircle2 size={16} /> Submission rate</h3>
            <p className="text-xs muted mb-3">Of all assignments × eligible students. A class with low submission rate hides behind a healthy avg score — that&apos;s where engagement really lives.</p>
            <div className="flex items-baseline gap-2 mb-3">
              <span className={`text-3xl font-bold ${submissionRate.overallPct >= 80 ? "text-emerald-700" : submissionRate.overallPct >= 60 ? "text-amber-700" : "text-red-700"}`}>{submissionRate.overallPct}%</span>
              <span className="text-xs muted">{submissionRate.totalSubmitted} of {submissionRate.totalExpected} expected</span>
            </div>
            {submissionRate.classes.length > 0 && (
              <table className="w-full text-xs">
                <tbody className="divide-y divide-slate-100">
                  {submissionRate.classes.slice(0, 5).map((c) => (
                    <tr key={c.id}>
                      <td className="py-1 truncate pr-2">{c.name}</td>
                      <td className="py-1 text-right tabular-nums muted">{c.submitted}/{c.expected}</td>
                      <td className={`py-1 text-right font-semibold tabular-nums w-12 ${c.pct >= 80 ? "text-emerald-700" : c.pct >= 60 ? "text-amber-700" : "text-red-700"}`}>{c.pct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* WoW trend */}
          <div className="card">
            <h3 className="font-semibold mb-1 flex items-center gap-2"><TrendingUp size={16} /> 8-week trend</h3>
            <p className="text-xs muted mb-3">Avg score per ISO week. Direction matters more than the absolute number — a slow climb beats a flat 70%.</p>
            <div className="flex gap-3 text-xs mb-3">
              <span>WoW avg: <strong className={(weeklyTrend.deltaAvg ?? 0) >= 0 ? "text-emerald-700" : "text-red-700"}>{weeklyTrend.deltaAvg == null ? "—" : `${weeklyTrend.deltaAvg >= 0 ? "+" : ""}${weeklyTrend.deltaAvg}pp`}</strong></span>
              <span>vs 8 weeks ago: <strong className={(weeklyTrend.deltaAvg8 ?? 0) >= 0 ? "text-emerald-700" : "text-red-700"}>{weeklyTrend.deltaAvg8 == null ? "—" : `${weeklyTrend.deltaAvg8 >= 0 ? "+" : ""}${weeklyTrend.deltaAvg8}pp`}</strong></span>
              <span>WoW attempts: <strong className={weeklyTrend.deltaAtt >= 0 ? "text-emerald-700" : "text-red-700"}>{weeklyTrend.deltaAtt >= 0 ? "+" : ""}{weeklyTrend.deltaAtt}</strong></span>
            </div>
            <div className="flex items-end gap-1 h-16">
              {weeklyTrend.weeks.map((w) => {
                const h = w.avg == null ? 0 : Math.max(2, Math.round((w.avg / 100) * 64));
                return (
                  <div key={w.weekStart} className="flex-1 flex flex-col items-center" title={`Week of ${w.weekStart}: ${w.avg ?? "—"}% (${w.attempts} attempts)`}>
                    <div className={`w-full rounded-t ${w.avg == null ? "bg-slate-100" : w.avg >= 70 ? "bg-emerald-500" : w.avg >= 50 ? "bg-amber-500" : "bg-red-500"}`} style={{ height: `${h}px` }} />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-[10px] muted mt-1">
              <span>{weeklyTrend.weeks[0]?.weekStart.slice(5)}</span>
              <span>{weeklyTrend.weeks[weeklyTrend.weeks.length - 1]?.weekStart.slice(5)}</span>
            </div>
          </div>

          {/* Question quality flags */}
          <div className="card">
            <h3 className="font-semibold mb-1 flex items-center gap-2"><AlertCircle size={16} /> Question quality flags</h3>
            <p className="text-xs muted mb-3">Curriculum-hygiene signals. Use these as faculty-meeting talking points.</p>
            <ul className="space-y-1.5 text-sm">
              <li className="flex items-baseline justify-between"><span>Too easy (≥95% correct)</span><strong className={qualityFlags.tooEasy > 0 ? "text-amber-700" : "text-slate-500"}>{qualityFlags.tooEasy}</strong></li>
              <li className="flex items-baseline justify-between"><span>Too hard (≤25% correct)</span><strong className={qualityFlags.tooHard > 0 ? "text-red-700" : "text-slate-500"}>{qualityFlags.tooHard}</strong></li>
              <li className="flex items-baseline justify-between"><span>In the bank but never asked</span><strong className={qualityFlags.unused > 0 ? "text-slate-700" : "text-slate-500"}>{qualityFlags.unused}</strong></li>
            </ul>
            <p className="text-[10px] muted mt-2">Of {qualityFlags.totalChecked} questions with at least 3 attempts. Easy questions are likely memorised or duplicates; hard questions are often mis-keyed.</p>
          </div>

          {/* Class struggle topics */}
          <div className="card">
            <h3 className="font-semibold mb-1 flex items-center gap-2"><TrendingDown size={16} /> Class struggle topics</h3>
            <p className="text-xs muted mb-3">Topics where a specific class is scoring 10+ points below the school average. Tells the teacher exactly what to re-teach.</p>
            {classStruggle.length === 0 ? (
              <p className="muted text-sm">No significant per-class topic gaps yet — either too little data or every class is at school average.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase tracking-wide muted border-b border-slate-200">
                  <tr><th className="py-1 text-left">Class</th><th className="py-1 text-left">Topic</th><th className="py-1 text-right">Class</th><th className="py-1 text-right">School</th><th className="py-1 text-right">Δ</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {classStruggle.map((r, i) => (
                    <tr key={i}>
                      <td className="py-1 truncate pr-2 max-w-[120px]">{r.className}</td>
                      <td className="py-1 truncate pr-2 max-w-[120px]">{r.topic}</td>
                      <td className="py-1 text-right tabular-nums text-red-700">{r.classPct}%</td>
                      <td className="py-1 text-right tabular-nums muted">{r.schoolPct}%</td>
                      <td className="py-1 text-right tabular-nums font-semibold text-red-700">{r.delta}pp</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Teacher Bloom contribution */}
          <div className="card">
            <h3 className="font-semibold mb-1 flex items-center gap-2"><Layers size={16} /> Teacher Bloom contribution</h3>
            <p className="text-xs muted mb-3">Of each teacher&apos;s questions, what share is higher-order (Analyze / Evaluate / Create)? Drives PD decisions.</p>
            {teacherBloom.length === 0 ? (
              <p className="muted text-sm">No question-bank data attributable to teachers yet.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase tracking-wide muted border-b border-slate-200">
                  <tr><th className="py-1 text-left">Teacher</th><th className="py-1 text-right">Questions</th><th className="py-1 text-right">Higher-order</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {teacherBloom.map((r) => (
                    <tr key={r.teacher.id}>
                      <td className="py-1 truncate pr-2">{r.teacher.full_name || "(unnamed)"}</td>
                      <td className="py-1 text-right tabular-nums muted">{r.total}</td>
                      <td className={`py-1 text-right tabular-nums font-semibold ${r.higherPct >= 35 ? "text-emerald-700" : r.higherPct >= 20 ? "text-amber-700" : "text-red-700"}`}>{r.higherPct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Inactive students */}
          <div className="card">
            <h3 className="font-semibold mb-1 flex items-center gap-2"><UserX size={16} /> Inactive students (14+ days)</h3>
            <p className="text-xs muted mb-3">Students with no submitted attempt in two weeks. Different from at-risk: these are kids the platform isn&apos;t touching at all.</p>
            {inactiveStudents.length === 0 ? (
              <p className="muted text-sm">Everyone has been active in the last 14 days. 🎉</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase tracking-wide muted border-b border-slate-200">
                  <tr><th className="py-1 text-left">Student</th><th className="py-1 text-left">Class</th><th className="py-1 text-right">Days inactive</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {inactiveStudents.map((s) => (
                    <tr key={s.id}>
                      <td className="py-1 truncate pr-2">{s.name}</td>
                      <td className="py-1 truncate pr-2 muted">{s.className ?? "—"}</td>
                      <td className="py-1 text-right tabular-nums font-semibold text-amber-700">{s.daysInactive < 0 ? "never" : `${s.daysInactive}d`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Subject coverage gaps */}
          <div className="card">
            <h3 className="font-semibold mb-1 flex items-center gap-2"><BookOpen size={16} /> Subject coverage</h3>
            <p className="text-xs muted mb-3">Days since a new test was created in each subject. Highlights forgotten subjects in the assessment plan.</p>
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wide muted border-b border-slate-200">
                <tr><th className="py-1 text-left">Subject</th><th className="py-1 text-right">Tests</th><th className="py-1 text-right">Last new</th><th className="py-1 text-right">Days</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {subjectCoverage.length === 0 ? (
                  <tr><td colSpan={4} className="py-2 muted text-center">No tests created yet.</td></tr>
                ) : subjectCoverage.map((r) => (
                  <tr key={r.subject}>
                    <td className="py-1 truncate pr-2">{r.subject}</td>
                    <td className="py-1 text-right tabular-nums muted">{r.testCount}</td>
                    <td className="py-1 text-right tabular-nums muted">{r.lastCreated ?? "—"}</td>
                    <td className={`py-1 text-right tabular-nums font-semibold ${r.daysSince >= 30 ? "text-amber-700" : "text-slate-700"}`}>{r.daysSince < 0 ? "—" : `${r.daysSince}d`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Live class quiz adoption */}
          <div className="card">
            <h3 className="font-semibold mb-1 flex items-center gap-2"><Radio size={16} /> Live class quiz adoption</h3>
            <p className="text-xs muted mb-3">Engagement-only feature. Tells you whether the live-quiz tool is being used or sitting idle.</p>
            <div className="flex items-baseline gap-2 mb-2">
              <span className={`text-3xl font-bold ${liveAdoption.adoptionPct >= 50 ? "text-emerald-700" : liveAdoption.adoptionPct >= 25 ? "text-amber-700" : "text-slate-500"}`}>
                {liveAdoption.adoptionPct}%
              </span>
              <span className="text-xs muted">of teachers have hosted at least one</span>
            </div>
            <p className="text-xs muted">{liveAdoption.adopters} of {liveAdoption.totalTeachers} teachers · {liveAdoption.totalSessions} total sessions hosted</p>
          </div>
        </div>

        {/* At-risk students */}
        <div className="card mt-4">
          <h3 className="font-semibold mb-3 flex items-center gap-2 text-red-800"><AlertTriangle size={16} /> At-risk students</h3>
          {atRisk.length === 0 ? (
            <p className="muted text-sm">Nobody is currently below 50% across 3+ attempts. 🎉</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase muted">
                  <tr>
                    <th className="px-3 py-2 text-left">Student</th>
                    <th className="px-3 py-2 text-left">Class</th>
                    <th className="px-3 py-2 text-right">Attempts</th>
                    <th className="px-3 py-2 text-right">Avg score</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {atRisk.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2 font-medium">{s.name}</td>
                      <td className="px-3 py-2 text-slate-700">{s.className ?? <span className="muted">—</span>}</td>
                      <td className="px-3 py-2 text-right">{s.attempts}</td>
                      <td className="px-3 py-2 text-right font-semibold text-red-700">{s.avgScore}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs muted mt-3">
                Showing up to 20 students. The list is anyone whose average is under 50% across 3 or more attempts in the selected window.
              </p>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
