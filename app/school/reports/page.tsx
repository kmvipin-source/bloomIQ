"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  BarChart3, Download, Copy, ArrowLeft, Users, BookOpen, AlertTriangle,
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
type Ans = { attempt_id: string; bloom_level: string | null; is_correct: boolean | null };
type Profile = { id: string; full_name: string | null; role: string };
type Cls = { id: string; name: string; grade: string | null; owner_id: string | null };
type Member = { class_id: string; student_id: string };

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

    // Attempts in window
    let attemptsQ = sb
      .from("quiz_attempts")
      .select("id, student_id, quiz_id, score, total, submitted_at")
      .in("student_id", studentIds)
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
      .select("attempt_id, bloom_level, is_correct")
      .in("attempt_id", attemptIds);
    setAnswers((ans as Ans[]) || []);

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
  const atRisk = useMemo(() => {
    type Row = { id: string; name: string; grade: string | null; attempts: number; avgScore: number };
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
      const grade = cid ? (classById.get(cid)?.grade ?? null) : null;
      rows.push({ id: s.id, name: s.full_name || "(unnamed)", grade, attempts: ratios.length, avgScore: avg });
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
        headers: ["Student", "Grade", "Attempts (window)", "Avg score (%)"],
        rows: atRisk.map((s) => [s.name, s.grade ?? "—", s.attempts, s.avgScore]),
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
      lines.push(`At-risk: ${atRisk.length} student${atRisk.length === 1 ? "" : "s"} below 50% across 3+ attempts.`);
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
          <p className="muted mt-1">{schoolName || "Your school"} · How your school is teaching across Bloom’s taxonomy.</p>
        </div>
        {activeTab === "overview" && (
          <div className="flex items-center gap-2 flex-wrap">
            <select className="select max-w-[160px]" value={rangeId} onChange={(e) => setRangeId(e.target.value)}>
              {RANGE_PRESETS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
            <button className="btn btn-secondary" onClick={downloadPDF} disabled={busyExport !== null}>
              <Download size={14} /> {busyExport === "pdf" ? "Building…" : "PDF"}
            </button>
            <button className="btn btn-secondary" onClick={downloadXlsx} disabled={busyExport !== null}>
              <Download size={14} /> {busyExport === "xlsx" ? "Building…" : "Excel"}
            </button>
            <button className="btn btn-ghost" onClick={copySummary} disabled={busyExport !== null}>
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
            <button
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

        {/* At-risk students */}
        <div className="card">
          <h3 className="font-semibold mb-3 flex items-center gap-2 text-red-800"><AlertTriangle size={16} /> At-risk students</h3>
          {atRisk.length === 0 ? (
            <p className="muted text-sm">Nobody is currently below 50% across 3+ attempts. 🎉</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase muted">
                  <tr>
                    <th className="px-3 py-2 text-left">Student</th>
                    <th className="px-3 py-2 text-right">Grade</th>
                    <th className="px-3 py-2 text-right">Attempts</th>
                    <th className="px-3 py-2 text-right">Avg score</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {atRisk.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2 font-medium">{s.name}</td>
                      <td className="px-3 py-2 text-right">{s.grade ?? "—"}</td>
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
