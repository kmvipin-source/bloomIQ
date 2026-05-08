"use client";

import { useEffect, useMemo, useState } from "react";
import { addSheet, downloadWorkbook, newWorkbook, recordsToTable } from "@/lib/excelReport";
import { supabaseBrowser } from "@/lib/supabase/client";
import { BLOOM_LEVELS, BLOOM_META, blankBloomCounts, type BloomLevel } from "@/lib/bloom";
import type { Quiz } from "@/lib/types";
import { pct } from "@/lib/utils";
import Empty from "@/components/Empty";
import {
  Download, FileSpreadsheet, FileText, Mail, Sparkles,
  TrendingUp, Layers, ListChecks, BookOpenCheck, Users, AlertCircle,
  Calendar, Building2,
} from "lucide-react";

type Period = "7d" | "30d" | "90d" | "term" | "all";
const PERIOD_LABELS: Record<Period, string> = {
  "7d":   "Last 7 days",
  "30d":  "Last 30 days",
  "90d":  "Last 90 days",
  "term": "This term (last 120 days)",
  "all":  "All time",
};
function periodSince(p: Period): string | null {
  const days = { "7d": 7, "30d": 30, "90d": 90, "term": 120 }[p as Exclude<Period, "all">];
  if (!days) return null;
  return new Date(Date.now() - days * 24 * 3600_000).toISOString();
}

type Att = {
  id: string;
  quiz_id: string;
  student_id: string;
  score: number;
  total: number;
  submitted_at: string | null;
  time_taken_seconds: number | null;
  profile: { full_name: string | null; school: string | null; grade: string | null } | null;
};

type Ans = {
  attempt_id: string;
  question_id: string;
  is_correct: boolean | null;
  bloom_level: BloomLevel;
};

export default function ReportsPage() {
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  // Guards the "No quizzes yet" empty-state from flashing during the
  // initial fetch. Without it, every navigation to /teacher/reports
  // briefly renders the empty state because quizzes starts at [] and
  // the length check fires before the union loader resolves. Same
  // pattern Defect 7 used on /teacher/analytics.
  const [quizzesLoaded, setQuizzesLoaded] = useState(false);
  const [quizId, setQuizId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [info, setInfo] = useState("");

  // Filters — apply across all term-wide reports
  const [period, setPeriod] = useState<Period>("30d");
  const [classFilter, setClassFilter] = useState<string>("all");
  const [classes, setClasses] = useState<{ id: string; name: string }[]>([]);

  // All raw data, fetched once. Filtered views are derived in memory.
  const [allAtts, setAllAtts] = useState<Att[]>([]);
  const [allAns, setAllAns] = useState<Ans[]>([]);
  const [classQuizMap, setClassQuizMap] = useState<Map<string, Set<string>>>(new Map()); // classId → Set<quizId>
  // quizId → { name, isMe }. Drives the "Assigned by" label on the
  // dropdown and the Excel export. isMe lets us print "you" instead
  // of "Mr. Raj" when it's the current user.
  const [quizAssigner, setQuizAssigner] = useState<Map<string, { name: string; isMe: boolean }>>(new Map());

  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) { setQuizzesLoaded(true); return; }

      // ─────────────────────────────────────────────────────────────
      // Visibility rule (matches RLS migration 58):
      //   A quiz is in my scope iff
      //     (a) I OWN it, OR
      //     (b) I am PRIMARY on a class it is assigned to, OR
      //     (c) I personally ASSIGNED it (assigned_by = me),
      //   regardless of class role for (c).
      //
      // Why per-role: a subject co-teacher should not see test data
      // from tests they didn't push. Primary owns the class so they
      // see everything pushed to it.
      // ─────────────────────────────────────────────────────────────

      // 1) Classes I teach, with my role (so we can split primary
      //    from co for the visibility filter and for the class
      //    dropdown labels).
      const { data: cts } = await sb
        .from("class_teachers")
        .select("role, class:classes(id, name)")
        .eq("teacher_id", user.id);
      type CtRow = { role: "primary" | "co" | "acting"; class: { id: string; name: string } | null };
      const ctRows = ((cts as unknown as CtRow[]) || []).filter((r) => r.class);
      const taughtClasses = ctRows
        .map((r) => r.class!)
        .sort((a, b) => a.name.localeCompare(b.name));
      setClasses(taughtClasses);
      const primaryClassIds = new Set(
        ctRows.filter((r) => r.role === "primary" || r.role === "acting").map((r) => r.class!.id)
      );

      // 2) Pull all assignments touching me — any class I teach (so I
      //    can later split into primary-class vs co-class) PLUS any
      //    assignment I personally created. We over-fetch slightly and
      //    filter in JS, which is one round-trip cheaper than two
      //    targeted queries.
      const taughtClassIds = taughtClasses.map((c) => c.id);
      type AsgRow = {
        quiz_id: string;
        class_id: string | null;
        assigned_by: string | null;
        assigner: { full_name: string | null } | null;
      };
      let myAsgs: AsgRow[] = [];

      // Assignments where I'm the assigner (anywhere)
      {
        const { data } = await sb
          .from("quiz_assignments")
          .select("quiz_id, class_id, assigned_by, assigner:profiles!quiz_assignments_assigned_by_fkey(full_name)")
          .eq("assigned_by", user.id);
        myAsgs.push(...(((data as unknown) as AsgRow[]) || []));
      }
      // Assignments to any class I teach (we'll narrow to my-primary
      // classes for the visibility test below). RLS already restricts
      // these to what I can see.
      if (taughtClassIds.length > 0) {
        const { data } = await sb
          .from("quiz_assignments")
          .select("quiz_id, class_id, assigned_by, assigner:profiles!quiz_assignments_assigned_by_fkey(full_name)")
          .in("class_id", taughtClassIds);
        myAsgs.push(...(((data as unknown) as AsgRow[]) || []));
      }
      // Dedupe (quiz_id, class_id, assigned_by) — same row may come
      // back twice if both predicates matched (I assigned it AND it's
      // on a class I teach).
      {
        const seen = new Set<string>();
        myAsgs = myAsgs.filter((r) => {
          const k = `${r.quiz_id}|${r.class_id}|${r.assigned_by}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }

      // 3) Apply the visibility rule per assignment row to decide
      //    which (quiz_id, class_id) pairs make it through.
      const visibleAssignedQuizIds = new Set<string>();
      const classQuizMapBuild = new Map<string, Set<string>>();
      // quizId → assigner display info, picked from the *first*
      // visible assignment we encounter for that quiz. If multiple
      // assignment rows exist for the same quiz, prefer one where
      // assigned_by = me so the label reads "you".
      const assignerMap = new Map<string, { name: string; isMe: boolean }>();
      const upgradeAssigner = (qid: string, name: string, isMe: boolean) => {
        const cur = assignerMap.get(qid);
        if (!cur || (isMe && !cur.isMe)) assignerMap.set(qid, { name, isMe });
      };

      for (const r of myAsgs) {
        if (!r.quiz_id) continue;
        const meAssigned = r.assigned_by === user.id;
        const primaryHere = !!(r.class_id && primaryClassIds.has(r.class_id));
        if (!meAssigned && !primaryHere) continue; // visibility gate
        visibleAssignedQuizIds.add(r.quiz_id);
        if (r.class_id) {
          if (!classQuizMapBuild.has(r.class_id)) classQuizMapBuild.set(r.class_id, new Set());
          classQuizMapBuild.get(r.class_id)!.add(r.quiz_id);
        }
        const aname = r.assigner?.full_name || "Unknown";
        upgradeAssigner(r.quiz_id, aname, meAssigned);
      }

      // 4) Quizzes I own (always visible — owner-all path).
      const { data: ownedRaw } = await sb.from("quizzes").select("*").eq("owner_id", user.id).order("created_at", { ascending: false });
      const owned = (ownedRaw as Quiz[]) || [];

      // 5) Quizzes I see via assignment but don't own.
      let extraAssigned: Quiz[] = [];
      if (visibleAssignedQuizIds.size > 0) {
        const ownedIdSet = new Set(owned.map((q) => q.id));
        const missing = Array.from(visibleAssignedQuizIds).filter((id) => !ownedIdSet.has(id));
        if (missing.length > 0) {
          const { data: extra } = await sb.from("quizzes").select("*").in("id", missing);
          extraAssigned = (extra as Quiz[]) || [];
        }
      }

      setQuizAssigner(assignerMap);

      const list = [...owned, ...extraAssigned].sort((a, b) => {
        const ta = a.created_at ? Date.parse(a.created_at) : 0;
        const tb = b.created_at ? Date.parse(b.created_at) : 0;
        return tb - ta;
      });
      setQuizzes(list);
      setQuizzesLoaded(true);
      if (list.length) setQuizId(list[0].id);
      if (list.length === 0) return;

      const quizIds = list.map((q) => q.id);

      // 5) All attempts on those quizzes.
      const { data: atts } = await sb
        .from("quiz_attempts")
        .select("id, quiz_id, student_id, score, total, submitted_at, time_taken_seconds, profile:profiles!quiz_attempts_student_id_fkey(full_name, school, grade)")
        .in("quiz_id", quizIds)
        .not("submitted_at", "is", null);
      const attsList = ((atts as unknown) as Att[]) || [];
      setAllAtts(attsList);

      // 6) All answers.
      const attemptIds = attsList.map((a) => a.id);
      let ansList: Ans[] = [];
      if (attemptIds.length > 0) {
        const { data: a } = await sb
          .from("attempt_answers")
          .select("attempt_id, question_id, is_correct, bloom_level")
          .in("attempt_id", attemptIds);
        ansList = (a as Ans[]) || [];
      }
      setAllAns(ansList);

      // 7) Persist class→quiz map, intersected with the visible quiz pool.
      const visibleSet = new Set(quizIds);
      const finalMap = new Map<string, Set<string>>();
      for (const [cid, qids] of classQuizMapBuild) {
        const filtered = new Set<string>();
        for (const qid of qids) if (visibleSet.has(qid)) filtered.add(qid);
        if (filtered.size > 0) finalMap.set(cid, filtered);
      }
      setClassQuizMap(finalMap);
    })();
  }, []);

  // Derived: filtered attempts + answers based on period + class filter
  const since = useMemo(() => periodSince(period), [period]);

  const filteredQuizIds = useMemo(() => {
    if (classFilter === "all") return new Set(quizzes.map((q) => q.id));
    return classQuizMap.get(classFilter) || new Set<string>();
  }, [classFilter, classQuizMap, quizzes]);

  const atts = useMemo(() => {
    return allAtts.filter((a) => {
      if (since && (!a.submitted_at || a.submitted_at < since)) return false;
      if (!filteredQuizIds.has(a.quiz_id)) return false;
      return true;
    });
  }, [allAtts, since, filteredQuizIds]);

  const ans = useMemo(() => {
    const ids = new Set(atts.map((a) => a.id));
    return allAns.filter((x) => ids.has(x.attempt_id));
  }, [allAns, atts]);

  // Quizzes in scope of current filters (used by reports that iterate quizzes)
  const filteredQuizzes = useMemo(
    () => quizzes.filter((q) => filteredQuizIds.has(q.id)),
    [quizzes, filteredQuizIds]
  );

  // Reverse map quizId → list of class names that this quiz is assigned
  // to. Used to disambiguate test labels in the picker and the per-test
  // exports — by-name alone, a "Cell Quiz" could belong to two classes.
  const classNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of classes) m.set(c.id, c.name);
    return m;
  }, [classes]);
  const quizClassNames = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const [classId, quizIds] of classQuizMap) {
      const cname = classNameById.get(classId);
      if (!cname) continue;
      for (const qid of quizIds) {
        const arr = m.get(qid) || [];
        if (!arr.includes(cname)) arr.push(cname);
        m.set(qid, arr);
      }
    }
    // Sort each array alphabetically for deterministic display.
    for (const [qid, arr] of m) arr.sort();
    return m;
  }, [classQuizMap, classNameById]);
  function classLabelFor(qid: string): string {
    const arr = quizClassNames.get(qid) || [];
    if (arr.length === 0) return "Unassigned";
    if (arr.length === 1) return arr[0];
    return `${arr[0]} +${arr.length - 1}`;
  }

  // Hero stats now reflect filters
  const stats = useMemo(() => {
    const ratios = atts.filter((a) => a.total > 0).map((a) => pct(a.score, a.total));
    const avg = ratios.length ? Math.round(ratios.reduce((s, x) => s + x, 0) / ratios.length) : 0;
    const studentCount = new Set(atts.map((a) => a.student_id)).size;
    return { quizzes: filteredQuizzes.length, attempts: atts.length, students: studentCount, avg };
  }, [atts, filteredQuizzes]);

  const filterLabel = useMemo(() => {
    const cls = classFilter === "all" ? "all classes" : (classes.find((c) => c.id === classFilter)?.name || "class");
    return `${PERIOD_LABELS[period]} · ${cls}`;
  }, [period, classFilter, classes]);

  // ========== Report 1: Class summary (per-quiz, NOT filtered) ==========
  async function downloadClassSummary() {
    if (!quizId) return;
    setBusy("class");
    try {
      const quiz = quizzes.find((q) => q.id === quizId)!;
      // Per-quiz report ignores the global filters — it's always all attempts on this specific quiz
      const quizAtts = allAtts.filter((a) => a.quiz_id === quizId);
      const quizAns = allAns.filter((x) => quizAtts.some((a) => a.id === x.attempt_id));

      const rows = quizAtts.map((a) => {
        const per = blankBloomCounts(); const tot = blankBloomCounts();
        quizAns.filter((x) => x.attempt_id === a.id).forEach((x) => {
          tot[x.bloom_level] += 1; if (x.is_correct) per[x.bloom_level] += 1;
        });
        const r: Record<string, string | number> = {
          Student: a.profile?.full_name || "Unknown",
          School: a.profile?.school || "",
          Grade: a.profile?.grade || "",
          Score: `${a.score}/${a.total}`,
          Percent: pct(a.score, a.total),
          "Time taken (s)": a.time_taken_seconds || "",
          Submitted: a.submitted_at ? new Date(a.submitted_at).toLocaleString() : "",
        };
        BLOOM_LEVELS.forEach((l) => {
          r[BLOOM_META[l].label] = tot[l] ? `${Math.round((per[l] / tot[l]) * 100)}%` : "—";
        });
        return r;
      });
      rows.sort((a, b) => (b.Percent as number) - (a.Percent as number));

      const wb = newWorkbook();
      const { headers, rows: tableRows } = recordsToTable(rows);
      addSheet(wb, {
        name: "Class Results",
        title: `Class results — ${quiz.name}`,
        subtitle: `Generated ${new Date().toLocaleString()}`,
        headers,
        rows: tableRows,
      });
      await downloadWorkbook(wb, `bloomiq-${quiz.name.replace(/\s+/g, "_")}-class.xlsx`);
    } finally { setBusy(null); }
  }

  // ========== Report 2: Term summary workbook ==========
  async function downloadTermSummary() {
    setBusy("term");
    try {
      // Use the filtered scope (period + class), not all data
      const wb = newWorkbook();
      const stamp = `Generated ${new Date().toLocaleString()}`;
      const scope = `Scope: ${period} · ${classFilter !== "all" ? (classes.find((c) => c.id === classFilter)?.name || "class") : "All classes"}`;

      // Sheet 1 — Quiz overview
      const quizOverview = filteredQuizzes.map((q) => {
        const qAtts = atts.filter((a) => a.quiz_id === q.id);
        const ratios = qAtts.filter((a) => a.total > 0).map((a) => pct(a.score, a.total));
        const avg = ratios.length ? Math.round(ratios.reduce((s, x) => s + x, 0) / ratios.length) : 0;
        // "Class(es)" column added so a workbook reader can tell which
        // class each test belongs to without looking it up. Multi-class
        // assignments join with a slash. "Assigned by" lets a primary
        // teacher see at a glance which co-teacher pushed each test.
        const classes = (quizClassNames.get(q.id) || []).join(" / ") || "Unassigned";
        const a = quizAssigner.get(q.id);
        const assignedBy = a ? a.name : "—";
        return {
          Quiz: q.name,
          "Class(es)": classes,
          "Assigned by": assignedBy,
          Subject: q.subject || "",
          Topic: q.topic_family || "",
          Code: q.code,
          "Time limit (min)": q.time_limit_minutes,
          Submissions: qAtts.length,
          "Class avg %": avg,
          "Top score %": ratios.length ? Math.max(...ratios) : 0,
          "At risk (<50%)": ratios.filter((r) => r < 50).length,
          Created: new Date(q.created_at).toLocaleDateString(),
        };
      });
      {
        const t = recordsToTable(quizOverview);
        addSheet(wb, { name: "Quizzes", title: "Quiz overview", subtitle: `${scope} · ${stamp}`, headers: t.headers, rows: t.rows });
      }

      // Sheet 2 — Per-student summary across all quizzes
      const byStudent = new Map<string, { name: string; attempts: number; ratios: number[] }>();
      atts.forEach((a) => {
        if (!byStudent.has(a.student_id)) byStudent.set(a.student_id, { name: a.profile?.full_name || "Unknown", attempts: 0, ratios: [] });
        const s = byStudent.get(a.student_id)!;
        s.attempts++;
        if (a.total > 0) s.ratios.push(pct(a.score, a.total));
      });
      const studentSummary = Array.from(byStudent, ([id, s]) => ({
        Student: s.name,
        "Tests taken": s.attempts,
        "Average %": s.ratios.length ? Math.round(s.ratios.reduce((x, y) => x + y, 0) / s.ratios.length) : 0,
        "Best %": s.ratios.length ? Math.max(...s.ratios) : 0,
        "Worst %": s.ratios.length ? Math.min(...s.ratios) : 0,
        StudentId: id,
      })).sort((a, b) => (b["Average %"] as number) - (a["Average %"] as number));
      {
        const t = recordsToTable(studentSummary);
        addSheet(wb, { name: "Students", title: "Per-student summary", subtitle: stamp, headers: t.headers, rows: t.rows });
      }

      // Sheet 3 — Bloom mastery (students × levels)
      const bloomMatrix: Record<string, string | number>[] = [];
      byStudent.forEach((s, sid) => {
        const row: Record<string, string | number> = { Student: s.name };
        const studentAns = ans.filter((x) => atts.find((a) => a.id === x.attempt_id && a.student_id === sid));
        BLOOM_LEVELS.forEach((l) => {
          const lvl = studentAns.filter((x) => x.bloom_level === l);
          const correct = lvl.filter((x) => x.is_correct).length;
          row[BLOOM_META[l].label] = lvl.length ? Math.round((correct / lvl.length) * 100) : "—";
        });
        bloomMatrix.push(row);
      });
      {
        const t = recordsToTable(bloomMatrix);
        addSheet(wb, { name: "Bloom mastery", title: "Bloom mastery (% correct per level)", subtitle: stamp, headers: t.headers, rows: t.rows });
      }

      // Sheet 4 — Topic mastery (students × topic_family)
      const allTopics = Array.from(new Set(filteredQuizzes.map((q) => q.topic_family || "(uncategorised)")));
      const topicMatrix: Record<string, string | number>[] = [];
      byStudent.forEach((s, sid) => {
        const row: Record<string, string | number> = { Student: s.name };
        allTopics.forEach((t) => {
          const quizIdsForTopic = filteredQuizzes.filter((q) => (q.topic_family || "(uncategorised)") === t).map((q) => q.id);
          const studentAttsForTopic = atts.filter((a) => a.student_id === sid && quizIdsForTopic.includes(a.quiz_id));
          const ratios = studentAttsForTopic.filter((a) => a.total > 0).map((a) => pct(a.score, a.total));
          row[t] = ratios.length ? Math.round(ratios.reduce((x, y) => x + y, 0) / ratios.length) : "—";
        });
        topicMatrix.push(row);
      });
      {
        const t = recordsToTable(topicMatrix);
        addSheet(wb, { name: "Topic mastery", title: "Topic mastery (% per topic family)", subtitle: stamp, headers: t.headers, rows: t.rows });
      }

      // Sheet 5 — Improvement trajectory (first vs last attempt %)
      const improvement = Array.from(byStudent, ([sid, s]) => {
        const studentAtts = atts.filter((a) => a.student_id === sid).sort((a, b) =>
          (a.submitted_at || "").localeCompare(b.submitted_at || "")
        );
        const first = studentAtts[0];
        const last = studentAtts[studentAtts.length - 1];
        const firstPct = first && first.total > 0 ? pct(first.score, first.total) : null;
        const lastPct = last && last.total > 0 ? pct(last.score, last.total) : null;
        return {
          Student: s.name,
          "First attempt %": firstPct ?? "—",
          "Latest attempt %": lastPct ?? "—",
          "Change (pp)": (firstPct !== null && lastPct !== null) ? lastPct - firstPct : "—",
          "Tests taken": s.attempts,
        };
      }).sort((a, b) => (typeof b["Change (pp)"] === "number" ? (b["Change (pp)"] as number) : -999) - (typeof a["Change (pp)"] === "number" ? (a["Change (pp)"] as number) : -999));
      {
        const t = recordsToTable(improvement);
        addSheet(wb, { name: "Improvement", title: "Improvement trajectory (first vs latest)", subtitle: stamp, headers: t.headers, rows: t.rows });
      }

      // Sheet 6 — Question quality audit
      const questionStats = new Map<string, { quiz: string; level: BloomLevel; correct: number; total: number }>();
      ans.forEach((x) => {
        const a = atts.find((aa) => aa.id === x.attempt_id);
        if (!a) return;
        const quizName = filteredQuizzes.find((q) => q.id === a.quiz_id)?.name || "?";
        if (!questionStats.has(x.question_id)) {
          questionStats.set(x.question_id, { quiz: quizName, level: x.bloom_level, correct: 0, total: 0 });
        }
        const q = questionStats.get(x.question_id)!;
        q.total++;
        if (x.is_correct) q.correct++;
      });
      const questionRows = Array.from(questionStats, ([id, q]) => ({
        QuestionId: id,
        Quiz: q.quiz,
        "Bloom level": BLOOM_META[q.level].label,
        Correct: q.correct,
        Total: q.total,
        "% correct": q.total ? Math.round((q.correct / q.total) * 100) : 0,
        Verdict: q.total < 3 ? "low data" :
                 q.correct === q.total ? "too easy" :
                 q.correct === 0 ? "too hard / unclear" :
                 q.correct / q.total < 0.4 ? "very hard" :
                 q.correct / q.total < 0.7 ? "challenging" : "well-calibrated",
      })).sort((a, b) => (a["% correct"] as number) - (b["% correct"] as number));
      {
        const t = recordsToTable(questionRows);
        addSheet(wb, { name: "Question audit", title: "Question quality audit", subtitle: stamp, headers: t.headers, rows: t.rows });
      }

      const slug = `${period}${classFilter !== "all" ? `-${(classes.find((c) => c.id === classFilter)?.name || "class").replace(/\s+/g, "_")}` : ""}`;
      await downloadWorkbook(wb, `bloomiq-term-summary-${slug}-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } finally { setBusy(null); }
  }

  // ========== Report 3: Topic mastery matrix (single sheet) ==========
  async function downloadTopicMatrix() {
    setBusy("topics");
    try {
      const allTopics = Array.from(new Set(filteredQuizzes.map((q) => q.topic_family || "(uncategorised)")));
      const byStudent = new Map<string, { name: string }>();
      atts.forEach((a) => byStudent.set(a.student_id, { name: a.profile?.full_name || "Unknown" }));

      const matrix = Array.from(byStudent, ([sid, s]) => {
        const row: Record<string, string | number> = { Student: s.name };
        allTopics.forEach((t) => {
          const quizIdsForTopic = filteredQuizzes.filter((q) => (q.topic_family || "(uncategorised)") === t).map((q) => q.id);
          const sAtts = atts.filter((a) => a.student_id === sid && quizIdsForTopic.includes(a.quiz_id));
          const ratios = sAtts.filter((a) => a.total > 0).map((a) => pct(a.score, a.total));
          row[t] = ratios.length ? Math.round(ratios.reduce((x, y) => x + y, 0) / ratios.length) : "—";
        });
        return row;
      });

      const wb = newWorkbook();
      const t = recordsToTable(matrix);
      addSheet(wb, {
        name: "Topic × Student",
        title: "Topic mastery — Topic × Student",
        subtitle: `Generated ${new Date().toLocaleString()}`,
        headers: t.headers,
        rows: t.rows,
      });
      await downloadWorkbook(wb, `bloomiq-topic-mastery-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } finally { setBusy(null); }
  }

  // ========== Report 4: Question quality audit (single sheet) ==========
  async function downloadQuestionAudit() {
    setBusy("audit");
    try {
      const stats = new Map<string, { quiz: string; level: BloomLevel; correct: number; total: number }>();
      ans.forEach((x) => {
        const a = atts.find((aa) => aa.id === x.attempt_id);
        if (!a) return;
        const quizName = filteredQuizzes.find((q) => q.id === a.quiz_id)?.name || "?";
        if (!stats.has(x.question_id)) stats.set(x.question_id, { quiz: quizName, level: x.bloom_level, correct: 0, total: 0 });
        const s = stats.get(x.question_id)!;
        s.total++;
        if (x.is_correct) s.correct++;
      });
      const rows = Array.from(stats, ([id, s]) => ({
        QuestionId: id,
        Quiz: s.quiz,
        "Bloom level": BLOOM_META[s.level].label,
        "% correct": s.total ? Math.round((s.correct / s.total) * 100) : 0,
        Correct: s.correct,
        Total: s.total,
        Verdict: s.total < 3 ? "low data" :
                 s.correct === s.total ? "too easy" :
                 s.correct === 0 ? "too hard / unclear" :
                 s.correct / s.total < 0.4 ? "very hard" :
                 s.correct / s.total < 0.7 ? "challenging" : "well-calibrated",
      })).sort((a, b) => (a["% correct"] as number) - (b["% correct"] as number));

      const wb = newWorkbook();
      const t = recordsToTable(rows);
      addSheet(wb, {
        name: "Question audit",
        title: "Question quality audit",
        subtitle: `Generated ${new Date().toLocaleString()}`,
        headers: t.headers,
        rows: t.rows,
      });
      await downloadWorkbook(wb, `bloomiq-question-audit-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } finally { setBusy(null); }
  }

  // ========== Existing: weekly digest ==========
  async function sendDigest() {
    setBusy("digest");
    setInfo("");
    const sb = supabaseBrowser();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { setBusy(null); return; }
    const res = await fetch("/api/digest", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ quizId }),
    });
    const j = await res.json();
    setInfo(j.message || (res.ok ? "Digest queued" : "Failed"));
    setBusy(null);
  }

  // Wait for the quiz fetch to resolve before deciding empty vs full
  // render. Without this, every navigation here flashes "No quizzes yet"
  // for a frame because quizzes starts at [] and the length check fires
  // before the union loader completes.
  if (!quizzesLoaded) {
    return <div className="grid place-items-center py-20"><div className="spinner" /></div>;
  }
  if (!quizzes.length) {
    return <Empty icon="📄" title="No quizzes yet" body="Create a quiz to start generating reports." />;
  }

  return (
    <div className="max-w-6xl mx-auto fade-in">
      <h1 className="h1">Reports</h1>
      <p className="muted mt-1 max-w-3xl">
        Cross-class, cross-test grand summary. Filter by period and class to see hero stats (tests assigned, submission count, class average, at-risk count) and download Excel workbooks for term reviews, parent meetings, and question-quality audits. The "By test" section below also lets you export a single test's class summary.
      </p>

      {/* Filter strip — applies to hero stats and all term-wide reports below */}
      <div className="card mt-4 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Calendar size={14} className="text-slate-400" />
          <select
            className="select max-w-[200px]"
            value={period}
            onChange={(e) => setPeriod(e.target.value as Period)}
          >
            {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
              <option key={p} value={p}>{PERIOD_LABELS[p]}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <Building2 size={14} className="text-slate-400" />
          <select
            className="select max-w-[240px]"
            value={classFilter}
            onChange={(e) => setClassFilter(e.target.value)}
            disabled={classes.length === 0}
            title={classes.length === 0 ? "You don't teach any classes yet" : undefined}
          >
            <option value="all">All classes</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <span className="ml-auto text-xs muted">
          Reports below cover <strong className="text-slate-700">{filterLabel}</strong>
        </span>
      </div>

      {/* Scope note. Visibility rule is asymmetric (primary vs co)
          so the totals are a UNION of "tests on classes where I'm
          primary" and "tests I assigned myself". Spell it out so
          a teacher reading the dashboard isn't guessing. */}
      <div className="mt-2 rounded-lg bg-slate-50/80 border border-slate-200 px-3 py-2 text-xs text-slate-600">
        <strong className="text-slate-800">What&apos;s in these stats:</strong>
        <ul className="mt-1 space-y-0.5 list-disc list-inside">
          <li>
            Tests on classes where you&apos;re the <strong>primary teacher</strong> — including tests other teachers assigned to your class.
          </li>
          <li>
            Tests <strong>you personally assigned</strong> — even on classes where you&apos;re only a co-teacher.
          </li>
        </ul>
        <p className="mt-1">
          <em>Excluded:</em> tests other teachers assigned to classes where you&apos;re only a co-teacher.
        </p>
      </div>

      {/* Hero stats */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
        <StatCard icon={ListChecks} label="Tests" value={stats.quizzes} color="from-emerald-500 to-emerald-600" />
        <StatCard icon={Users} label="Students" value={stats.students} color="from-sky-500 to-sky-600" />
        <StatCard icon={FileSpreadsheet} label="Submissions" value={stats.attempts} color="from-amber-500 to-amber-600" />
        <StatCard icon={TrendingUp} label="Average %" value={stats.attempts > 0 ? `${stats.avg}%` : "—"} color="from-violet-500 to-violet-600" />
      </div>

      {/* Section 1 — By quiz */}
      <h2 className="h2 mt-10 mb-3">By test <span className="text-sm font-normal muted">— ignores filters above</span></h2>
      <div className="card mb-3">
        <label className="label">Pick a test</label>
        <select className="select" value={quizId} onChange={(e) => setQuizId(e.target.value)}>
          {quizzes.map((q) => {
            const classLabel = classLabelFor(q.id);
            // Show: "Photosynthesis Class Quiz · Science · Grade 6 - Math A · by Mr. Raj"
            // — class to disambiguate same-named tests across classes;
            // assigner so a primary teacher reading the report can tell
            // who pushed each test.
            const subject = q.subject ? ` · ${q.subject}` : "";
            const cls = ` · ${classLabel}`;
            const a = quizAssigner.get(q.id);
            const by = a ? ` · by ${a.isMe ? "you" : a.name}` : "";
            return (
              <option key={q.id} value={q.id}>
                {q.name}{subject}{cls}{by}
              </option>
            );
          })}
        </select>
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        <ReportCard
          icon={FileSpreadsheet}
          color="from-emerald-500 to-emerald-600"
          title="Class summary"
          fmt="Excel"
          desc="Every student's score, time taken, and Bloom-level breakdown for this test. Sorted top to bottom by score."
          onClick={downloadClassSummary}
          busy={busy === "class"}
        />
        <ReportCard
          icon={FileText}
          color="from-amber-500 to-amber-600"
          title="Per-student PDF reports"
          fmt="PDF"
          desc="A printable report card for each student — strengths, weaknesses, recommended next topics. Generate one at a time from a test's attempts list."
          buttonLabel="Open test attempts →"
          onClick={() => { window.location.href = `/teacher/quizzes/${quizId}`; }}
          busy={false}
        />
      </div>

      {/* Section 2 — Term-wide */}
      <h2 className="h2 mt-10 mb-3">Term-wide</h2>
      <p className="text-sm muted mb-3">
        These reports respect the filters at the top — currently <strong className="text-slate-700">{filterLabel}</strong>. Useful for term reviews, parent meetings, single-class snapshots, or audits of your question bank.
      </p>
      <div className="grid md:grid-cols-2 gap-4">
        <ReportCard
          icon={BookOpenCheck}
          color="from-sky-500 to-sky-600"
          title="Term summary workbook"
          fmt="Excel · 6 sheets"
          desc="One file with: Tests overview · Students summary · Bloom mastery matrix · Topic mastery matrix · Improvement trajectory · Question quality audit."
          highlight
          onClick={downloadTermSummary}
          busy={busy === "term"}
        />
        <ReportCard
          icon={Layers}
          color="from-violet-500 to-violet-600"
          title="Topic mastery matrix"
          fmt="Excel"
          desc="Heatmap-style sheet: students × topic families. See which topics each student has nailed and which need re-teaching."
          onClick={downloadTopicMatrix}
          busy={busy === "topics"}
        />
        <ReportCard
          icon={TrendingUp}
          color="from-pink-500 to-pink-600"
          title="Improvement trajectory"
          fmt="Excel · in term workbook"
          desc="First attempt vs latest, with percentage-point change per student. Surfaces who's growing and who's plateauing."
          buttonLabel="Included in Term summary"
          onClick={downloadTermSummary}
          busy={busy === "term"}
        />
        <ReportCard
          icon={AlertCircle}
          color="from-red-500 to-red-600"
          title="Question quality audit"
          fmt="Excel"
          desc="Every question across every test, ranked by % correct. Flags 'too easy', 'too hard / unclear', 'challenging', 'well-calibrated' — find questions to retire or rewrite."
          onClick={downloadQuestionAudit}
          busy={busy === "audit"}
        />
      </div>

      {/* Section 3 — Communications */}
      <h2 className="h2 mt-10 mb-3">Communications</h2>
      <div className="grid md:grid-cols-2 gap-4">
        <ReportCard
          icon={Mail}
          color="from-indigo-500 to-indigo-600"
          title="Weekly class digest"
          fmt="Email preview"
          desc="A short summary email of the past week — tests, completion, average score, students needing attention. Currently a server-side preview."
          buttonLabel="Send digest"
          onClick={sendDigest}
          busy={busy === "digest"}
        />
      </div>

      {info && (
        <div className="mt-4 text-sm bg-slate-50 border border-slate-200 px-3 py-2 rounded-lg">{info}</div>
      )}

      <p className="text-xs muted mt-8 flex items-center justify-center gap-1">
        <Sparkles size={12} /> Need a custom report? Open the term workbook in Excel — every sheet is a clean dataset, easy to pivot or chart.
      </p>
    </div>
  );
}

function StatCard({
  icon: Icon, label, value, color,
}: {
  icon: React.ComponentType<{ size?: number }>;
  label: string;
  value: number | string;
  color: string;
}) {
  return (
    <div className="card card-hover">
      <div className={`w-10 h-10 rounded-lg bg-gradient-to-br ${color} text-white grid place-items-center mb-3`}>
        <Icon size={20} />
      </div>
      <div className="text-3xl font-bold">{value}</div>
      <div className="text-sm muted">{label}</div>
    </div>
  );
}

function ReportCard({
  icon: Icon, color, title, fmt, desc, onClick, busy, highlight, buttonLabel,
}: {
  icon: React.ComponentType<{ size?: number }>;
  color: string;
  title: string;
  fmt: string;
  desc: string;
  onClick: () => void;
  busy: boolean;
  highlight?: boolean;
  buttonLabel?: string;
}) {
  return (
    <div className={`card card-hover flex flex-col ${highlight ? "ring-2 ring-emerald-300" : ""}`}>
      <div className="flex items-start gap-3">
        <div className={`shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br ${color} text-white grid place-items-center`}>
          <Icon size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-bold">{title}</h3>
            {highlight && <span className="text-[10px] uppercase tracking-wide font-bold text-emerald-900 bg-emerald-100 rounded-full px-2 py-0.5">Most useful</span>}
          </div>
          <div className="text-xs muted mt-0.5">{fmt}</div>
        </div>
      </div>
      <p className="text-sm text-slate-700 mt-3 flex-1">{desc}</p>
      <div className="mt-4">
        <button type="button" className="btn btn-primary w-full" onClick={onClick} disabled={busy}>
          {busy ? <><span className="spinner" /> Generating…</> : <><Download size={16} /> {buttonLabel || "Download"}</>}
        </button>
      </div>
    </div>
  );
}
