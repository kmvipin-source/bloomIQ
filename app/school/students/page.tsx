"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { TrendingUp, AlertTriangle, Trophy, ArrowLeft, Search } from "lucide-react";
import { pct } from "@/lib/utils";
import { loadClassQuizIdsForClasses } from "@/lib/studentScope";
import { useFocusRefetch } from "@/lib/useFocusRefetch";

type StudentRow = {
  id: string;
  name: string;
  classes: string[];
  attemptCount: number;
  avgScore: number | null;
  lastAttemptAt: string | null;
};

export default function SchoolStudentsPage() {
  const [rows, setRows] = useState<StudentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  async function load() {
      const sb = supabaseBrowser();
      // Resolve school_id via service-role /api/auth/me — direct profiles
      // selects race RLS on the edge and intermittently blank the page.
      const { data: { session } } = await sb.auth.getSession();
      const token = session?.access_token;
      if (!token) { setLoading(false); return; }
      const meRes = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!meRes.ok) { setLoading(false); return; }
      const me = await meRes.json() as { school_id: string | null };
      if (!me.school_id) { setLoading(false); return; }
      const prof = { school_id: me.school_id };

      // 1) All students in this school
      const { data: ss } = await sb
        .from("profiles")
        .select("id, full_name")
        .eq("school_id", prof.school_id)
        .eq("role", "student");
      type S = { id: string; full_name: string | null };
      const students = (ss as S[]) || [];
      const studentIds = students.map((s) => s.id);
      if (studentIds.length === 0) { setRows([]); setLoading(false); return; }

      // 2) Their class memberships
      const { data: memberships } = await sb
        .from("class_members")
        .select("student_id, class:classes(name)")
        .in("student_id", studentIds);
      type Mem = { student_id: string; class: { name: string } | null };
      const memsByStudent = new Map<string, string[]>();
      ((memberships as unknown as Mem[]) || []).forEach((m) => {
        if (!m.class) return;
        if (!memsByStudent.has(m.student_id)) memsByStudent.set(m.student_id, []);
        memsByStudent.get(m.student_id)!.push(m.class.name);
      });

      // 3) Their attempts (one batched query) — scoped to
      //    class-assigned quizzes only. Personal practice attempts
      //    by these students never appear in school admin's per-
      //    student stats; they're an entirely separate scope.
      const { data: schoolClasses } = await sb
        .from("classes")
        .select("id")
        .eq("school_id", prof.school_id);
      const schoolClassIds = ((schoolClasses as Array<{ id: string }> | null) || []).map((c) => c.id);
      const schoolClassQuizIds = await loadClassQuizIdsForClasses(sb, schoolClassIds);
      const quizIdArr = Array.from(schoolClassQuizIds);
      type Att = { student_id: string; score: number; total: number; submitted_at: string | null };
      const attsByStudent = new Map<string, Att[]>();
      if (quizIdArr.length > 0) {
        const { data: atts } = await sb
          .from("quiz_attempts")
          .select("student_id, score, total, submitted_at")
          .in("student_id", studentIds)
          .in("quiz_id", quizIdArr)
          .not("submitted_at", "is", null);
        ((atts as Att[]) || []).forEach((a) => {
          if (!attsByStudent.has(a.student_id)) attsByStudent.set(a.student_id, []);
          attsByStudent.get(a.student_id)!.push(a);
        });
      }

      // 4) Stitch the per-student row
      const out: StudentRow[] = students.map((s) => {
        const mine = attsByStudent.get(s.id) || [];
        const ratios = mine.filter((a) => a.total > 0).map((a) => pct(a.score, a.total));
        const avg = ratios.length ? Math.round(ratios.reduce((x, y) => x + y, 0) / ratios.length) : null;
        const last = mine.sort((a, b) => (b.submitted_at || "").localeCompare(a.submitted_at || ""))[0];
        return {
          id: s.id,
          name: s.full_name || "(unnamed)",
          classes: memsByStudent.get(s.id) || [],
          attemptCount: mine.length,
          avgScore: avg,
          lastAttemptAt: last?.submitted_at || null,
        };
      });

      setRows(out);
      setLoading(false);
  }
  useEffect(() => { load(); }, []);
  useFocusRefetch(load);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!needle) return true;
      const hay = `${r.name} ${r.classes.join(" ")}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [rows, search]);

  const ranked = useMemo(() => filtered.filter((r) => r.avgScore !== null), [filtered]);
  const topPerformers = useMemo(
    () => ranked.slice().sort((a, b) => (b.avgScore || 0) - (a.avgScore || 0)).slice(0, 5),
    [ranked]
  );
  const atRisk = useMemo(
    () => ranked.filter((r) => (r.avgScore || 0) < 50).sort((a, b) => (a.avgScore || 0) - (b.avgScore || 0)),
    [ranked]
  );

  if (loading) return <div className="grid place-items-center py-20"><div className="spinner" /></div>;

  return (
    <div className="max-w-6xl mx-auto fade-in">
      <Link href="/school" className="text-sm text-emerald-700 font-semibold inline-flex items-center gap-1"><ArrowLeft size={14} /> School home</Link>
      <h1 className="h1 mt-2 flex items-center gap-2"><TrendingUp size={28} /> Students</h1>
      <p className="muted mt-1">Every student across every class in your school.</p>

      <div className="grid sm:grid-cols-3 gap-4 mt-6">
        <div className="card"><div className="text-xs muted uppercase font-semibold">Total students</div><div className="text-3xl font-bold">{rows.length}</div></div>
        <div className="card"><div className="text-xs muted uppercase font-semibold">Top scorers</div><div className="text-3xl font-bold text-emerald-700">{topPerformers.length}</div></div>
        <div className="card"><div className="text-xs muted uppercase font-semibold">At risk (&lt;50%)</div><div className="text-3xl font-bold text-red-600">{atRisk.length}</div></div>
      </div>

      {/* Top performers + At risk side by side */}
      <div className="grid lg:grid-cols-2 gap-6 mt-6">
        <div className="card">
          <h3 className="font-bold mb-3 flex items-center gap-2 text-emerald-700"><Trophy size={16} /> Top performers</h3>
          {topPerformers.length === 0 ? (
            <p className="text-sm muted">Nobody has completed a test yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {topPerformers.map((s, i) => (
                <li key={s.id} className="flex items-center justify-between text-sm">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{i + 1}. {s.name}</div>
                    {s.classes.length > 0 && <div className="text-xs muted truncate">{s.classes.join(", ")}</div>}
                  </div>
                  <span className="text-emerald-700 font-semibold">{s.avgScore}%</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h3 className="font-bold mb-3 flex items-center gap-2 text-red-700"><AlertTriangle size={16} /> Needs attention</h3>
          {atRisk.length === 0 ? (
            <p className="text-sm muted">Nobody is averaging below 50% — good news.</p>
          ) : (
            <ul className="space-y-1.5">
              {atRisk.slice(0, 8).map((s) => (
                <li key={s.id} className="flex items-center justify-between text-sm">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{s.name}</div>
                    {s.classes.length > 0 && <div className="text-xs muted truncate">{s.classes.join(", ")}</div>}
                  </div>
                  <span className="text-red-700 font-semibold">{s.avgScore}%</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Search + full table */}
      <div className="card mt-6 mb-3">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input className="input pl-9" placeholder="Search by name or class..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card text-center py-12 muted">No students match.</div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase muted">
              <tr>
                <th className="px-4 py-3 text-left">Student</th>
                <th className="px-4 py-3 text-left">Classes</th>
                <th className="px-4 py-3 text-right">Tests</th>
                <th className="px-4 py-3 text-right">Avg</th>
                <th className="px-4 py-3 text-right">Last</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered
                .slice()
                .sort((a, b) => (b.avgScore || -1) - (a.avgScore || -1))
                .map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium">{s.name}</td>
                    <td className="px-4 py-3 text-xs muted">{s.classes.length > 0 ? s.classes.join(", ") : "—"}</td>
                    <td className="px-4 py-3 text-right">{s.attemptCount}</td>
                    <td className={`px-4 py-3 text-right font-semibold ${
                      s.avgScore === null ? "text-slate-400" :
                      s.avgScore >= 70 ? "text-emerald-700" :
                      s.avgScore >= 50 ? "text-amber-700" : "text-red-700"
                    }`}>
                      {s.avgScore !== null ? `${s.avgScore}%` : "—"}
                    </td>
                    <td className="px-4 py-3 text-right muted text-xs">
                      {s.lastAttemptAt ? new Date(s.lastAttemptAt).toLocaleDateString() : "—"}
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
