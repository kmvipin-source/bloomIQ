"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { LayoutGrid } from "lucide-react";
import { BLOOM_LEVELS, normaliseBloom, type BloomLevel } from "@/lib/bloomReports";

// === Local types ====================================================
type Cls = { id: string; name: string; grade: string | null };
type Member = { class_id: string; student_id: string };
type Att = { id: string; student_id: string };
type Ans = { attempt_id: string; bloom_level: string | null; is_correct: boolean | null };

// Short tooltip blurb per level, shown on the column header.
const BLOOM_DESCRIPTIONS: Record<BloomLevel, string> = {
  Remember: "Recall facts",
  Understand: "Explain ideas",
  Apply: "Use info in new situations",
  Analyze: "Draw connections",
  Evaluate: "Justify a position",
  Create: "Produce new work",
};

type Cell = { correct: number; total: number };
type Row = {
  classId: string;
  className: string;
  grade: string | null;
  cells: Record<BloomLevel, Cell>;
  overallPct: number | null; // for sorting
  hasAnyData: boolean;
};

function colorFor(pct: number | null): { bg: string; fg: string } {
  if (pct === null) return { bg: "#f1f5f9", fg: "#94a3b8" }; // slate-100 / 400
  if (pct < 40) return { bg: "#fee2e2", fg: "#991b1b" };      // red-100 / 800
  if (pct < 70) return { bg: "#fef3c7", fg: "#92400e" };      // amber-100 / 800
  return { bg: "#dcfce7", fg: "#166534" };                    // green-100 / 800
}

export default function ClassComparisonHeatmap({
  schoolId,
}: { schoolId: string; schoolName?: string }) {
  const [loading, setLoading] = useState(true);
  const [classes, setClasses] = useState<Cls[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [attempts, setAttempts] = useState<Att[]>([]);
  const [answers, setAnswers] = useState<Ans[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!schoolId) { setLoading(false); return; }
      setLoading(true);
      const sb = supabaseBrowser();

      // Classes (filtered by school).
      const { data: cs } = await sb
        .from("classes")
        .select("id, name, grade")
        .eq("school_id", schoolId)
        .eq("status", "active");
      const classList = (cs as Cls[]) || [];
      const classIds = classList.map((c) => c.id);

      if (classIds.length === 0) {
        if (!cancelled) {
          setClasses([]); setMembers([]); setAttempts([]); setAnswers([]);
          setLoading(false);
        }
        return;
      }

      // Members.
      const { data: ms } = await sb
        .from("class_members")
        .select("class_id, student_id")
        .in("class_id", classIds);
      const memberList = (ms as Member[]) || [];
      const studentIds = Array.from(new Set(memberList.map((m) => m.student_id)));

      let attList: Att[] = [];
      let ansList: Ans[] = [];
      if (studentIds.length > 0) {
        // Attempts for those students.
        const { data: atts } = await sb
          .from("quiz_attempts")
          .select("id, student_id")
          .in("student_id", studentIds)
          .not("submitted_at", "is", null);
        attList = (atts as Att[]) || [];

        if (attList.length > 0) {
          const attemptIds = attList.map((a) => a.id);
          // Supabase has a default row cap, but for the typical school
          // size the answers list will fit. If we ever need to chunk
          // this, we can do it here.
          const { data: ans } = await sb
            .from("attempt_answers")
            .select("attempt_id, bloom_level, is_correct")
            .in("attempt_id", attemptIds);
          ansList = (ans as Ans[]) || [];
        }
      }

      if (!cancelled) {
        setClasses(classList);
        setMembers(memberList);
        setAttempts(attList);
        setAnswers(ansList);
        setLoading(false);
      }
    }
    run();
    return () => { cancelled = true; };
  }, [schoolId]);

  const rows = useMemo<Row[]>(() => {
    // student → class
    const studentToClass = new Map<string, string>();
    for (const m of members) studentToClass.set(m.student_id, m.class_id);

    // attempt → class
    const attemptToClass = new Map<string, string>();
    for (const a of attempts) {
      const cid = studentToClass.get(a.student_id);
      if (cid) attemptToClass.set(a.id, cid);
    }

    // Initialise an empty row for each class.
    const blank = (): Record<BloomLevel, Cell> => ({
      Remember: { correct: 0, total: 0 },
      Understand: { correct: 0, total: 0 },
      Apply: { correct: 0, total: 0 },
      Analyze: { correct: 0, total: 0 },
      Evaluate: { correct: 0, total: 0 },
      Create: { correct: 0, total: 0 },
    });
    const acc = new Map<string, Record<BloomLevel, Cell>>();
    for (const c of classes) acc.set(c.id, blank());

    for (const ans of answers) {
      const cid = attemptToClass.get(ans.attempt_id);
      if (!cid) continue;
      const lvl = normaliseBloom(ans.bloom_level);
      if (!lvl) continue;
      const cells = acc.get(cid);
      if (!cells) continue;
      cells[lvl].total++;
      if (ans.is_correct) cells[lvl].correct++;
    }

    // Build final row objects with overall mastery.
    const out: Row[] = classes.map((c) => {
      const cells = acc.get(c.id) || blank();
      let totalCorrect = 0;
      let totalAll = 0;
      for (const lvl of BLOOM_LEVELS) {
        totalCorrect += cells[lvl].correct;
        totalAll += cells[lvl].total;
      }
      return {
        classId: c.id,
        className: c.name,
        grade: c.grade,
        cells,
        overallPct: totalAll > 0 ? (totalCorrect / totalAll) * 100 : null,
        hasAnyData: totalAll > 0,
      };
    });

    // Sort: overall mastery desc, with no-data classes last.
    out.sort((a, b) => {
      if (a.overallPct === null && b.overallPct === null) {
        return a.className.localeCompare(b.className);
      }
      if (a.overallPct === null) return 1;
      if (b.overallPct === null) return -1;
      return b.overallPct - a.overallPct;
    });
    return out;
  }, [classes, members, attempts, answers]);

  if (loading) {
    return (
      <div className="grid place-items-center py-20">
        <div className="spinner" />
      </div>
    );
  }

  if (classes.length === 0) {
    return (
      <div className="card">
        <h3 className="font-semibold mb-3 flex items-center gap-2">
          <LayoutGrid size={16} /> Class comparison heatmap
        </h3>
        <p className="muted text-sm">No classes in this school yet.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h3 className="font-semibold mb-3 flex items-center gap-2">
        <LayoutGrid size={16} /> Class comparison heatmap
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr>
              <th className="px-3 py-2 text-left text-xs uppercase muted bg-slate-50">Class</th>
              <th className="px-3 py-2 text-left text-xs uppercase muted bg-slate-50">Grade</th>
              {BLOOM_LEVELS.map((lvl) => (
                <th
                  key={lvl}
                  title={BLOOM_DESCRIPTIONS[lvl]}
                  className="px-3 py-2 text-center text-xs uppercase muted bg-slate-50"
                >
                  {lvl}
                </th>
              ))}
              <th className="px-3 py-2 text-right text-xs uppercase muted bg-slate-50">Overall</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.classId} className="border-t border-slate-100">
                <td className="px-3 py-2 font-medium whitespace-nowrap">{r.className}</td>
                <td className="px-3 py-2 text-slate-600">{r.grade ?? "—"}</td>
                {BLOOM_LEVELS.map((lvl) => {
                  const cell = r.cells[lvl];
                  const pct = cell.total > 0 ? (cell.correct / cell.total) * 100 : null;
                  const { bg, fg } = colorFor(pct);
                  const tooltip =
                    cell.total > 0
                      ? `${cell.correct} / ${cell.total} correct`
                      : "no data";
                  return (
                    <td
                      key={lvl}
                      title={tooltip}
                      className="px-3 py-2 text-center font-semibold tabular-nums"
                      style={{ background: bg, color: fg }}
                    >
                      {pct === null ? "—" : `${Math.round(pct)}%`}
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-right font-semibold tabular-nums">
                  {r.overallPct === null ? "—" : `${Math.round(r.overallPct)}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs muted mt-3">
        Cell colour: <span className="px-1 rounded" style={{ background: "#fee2e2", color: "#991b1b" }}>red &lt; 40%</span>,{" "}
        <span className="px-1 rounded" style={{ background: "#fef3c7", color: "#92400e" }}>amber 40&ndash;70%</span>,{" "}
        <span className="px-1 rounded" style={{ background: "#dcfce7", color: "#166534" }}>green &ge; 70%</span>.
        Hover any cell for the raw correct/total counts.
      </p>
    </div>
  );
}
