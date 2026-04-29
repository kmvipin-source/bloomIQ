"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { AlertTriangle, TrendingDown, Clock } from "lucide-react";

// === Local types ====================================================
type Cls = { id: string; name: string };
type Member = { class_id: string; student_id: string };
type Profile = { id: string; full_name: string | null };
type Att = {
  id: string;
  student_id: string;
  score: number;
  total: number;
  submitted_at: string | null;
};

// What we render per row in the watchlist.
type RiskRow = {
  studentId: string;
  name: string;
  classNames: string[];
  attemptsCount: number;
  last3Avg: number | null;
  declining: boolean;
  inactiveDays: number; // Infinity if no attempts ever
  lastActiveAt: string | null;
  // Severity bucket: 0 = low score, 1 = declining, 2 = inactive
  tier: 0 | 1 | 2;
  // Sortable secondary key within tier (lower = worse).
  // For tier 0 = avg, tier 1 = avg, tier 2 = -inactiveDays.
  withinTierKey: number;
};

function relativeFromNow(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(ms / 3_600_000);
  if (hrs >= 1) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const mins = Math.floor(ms / 60_000);
  if (mins >= 1) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  return "just now";
}

// schoolName is currently used only as a prop for symmetry with the other
// tab components / future drill-down headings; we accept it but don't
// render it inside the watchlist itself.
export default function AtRiskWatchlist({
  schoolId,
}: { schoolId: string; schoolName?: string }) {
  const [loading, setLoading] = useState(true);
  const [classes, setClasses] = useState<Cls[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [attempts, setAttempts] = useState<Att[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!schoolId) { setLoading(false); return; }
      setLoading(true);
      const sb = supabaseBrowser();

      // 1) Classes in this school (defence in depth: filter by school_id).
      const { data: cs } = await sb
        .from("classes")
        .select("id, name")
        .eq("school_id", schoolId);
      const classList = (cs as Cls[]) || [];
      const classIds = classList.map((c) => c.id);
      if (classIds.length === 0) {
        if (!cancelled) {
          setClasses([]); setMembers([]); setProfiles([]); setAttempts([]);
          setLoading(false);
        }
        return;
      }

      // 2) Class membership rows.
      const { data: ms } = await sb
        .from("class_members")
        .select("class_id, student_id")
        .in("class_id", classIds);
      const memberList = (ms as Member[]) || [];
      const studentIds = Array.from(new Set(memberList.map((m) => m.student_id)));

      if (studentIds.length === 0) {
        if (!cancelled) {
          setClasses(classList); setMembers(memberList);
          setProfiles([]); setAttempts([]);
          setLoading(false);
        }
        return;
      }

      // 3) Profiles for those students. We also re-filter by school_id so
      //    that even if class_members ever leaks a foreign student, we'd
      //    still drop them here.
      const { data: profs } = await sb
        .from("profiles")
        .select("id, full_name")
        .in("id", studentIds)
        .eq("school_id", schoolId);
      const profList = (profs as Profile[]) || [];

      // 4) All submitted quiz_attempts for those students, newest first.
      const { data: atts } = await sb
        .from("quiz_attempts")
        .select("id, student_id, score, total, submitted_at")
        .in("student_id", studentIds)
        .not("submitted_at", "is", null)
        .order("submitted_at", { ascending: false });
      const attList = (atts as Att[]) || [];

      if (!cancelled) {
        setClasses(classList);
        setMembers(memberList);
        setProfiles(profList);
        setAttempts(attList);
        setLoading(false);
      }
    }
    run();
    return () => { cancelled = true; };
  }, [schoolId]);

  const classById = useMemo(() => {
    const m = new Map<string, Cls>();
    for (const c of classes) m.set(c.id, c);
    return m;
  }, [classes]);

  // Map student_id → array of class names they belong to.
  const classNamesByStudent = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const mb of members) {
      const cls = classById.get(mb.class_id);
      if (!cls) continue;
      const arr = m.get(mb.student_id) || [];
      arr.push(cls.name);
      m.set(mb.student_id, arr);
    }
    return m;
  }, [members, classById]);

  // Group attempts by student. Already in desc order from query above.
  const attemptsByStudent = useMemo(() => {
    const m = new Map<string, Att[]>();
    for (const a of attempts) {
      const arr = m.get(a.student_id) || [];
      arr.push(a);
      m.set(a.student_id, arr);
    }
    return m;
  }, [attempts]);

  // Compute risk rows.
  const rows = useMemo<RiskRow[]>(() => {
    const out: RiskRow[] = [];
    for (const p of profiles) {
      const studentAttempts = attemptsByStudent.get(p.id) || [];
      const last3 = studentAttempts.slice(0, 3);
      // Pcts are calculated newest-first → last3[0] is most recent.
      const pcts = last3
        .filter((a) => a.total > 0)
        .map((a) => (a.score / a.total) * 100);

      const last3Avg = pcts.length >= 2
        ? pcts.reduce((s, x) => s + x, 0) / pcts.length
        : null;

      // "Declining" means each attempt is strictly lower than the previous
      // one — but the array is newest-first, so we check that newer < older.
      // i.e. pcts[0] < pcts[1] < pcts[2]. We require ≥3 attempts.
      let declining = false;
      if (pcts.length >= 3 && last3.length >= 3) {
        declining = pcts[0] < pcts[1] && pcts[1] < pcts[2];
      }

      const lastActiveAt = studentAttempts[0]?.submitted_at ?? null;
      const inactiveDays = lastActiveAt
        ? Math.floor((Date.now() - new Date(lastActiveAt).getTime()) / 86_400_000)
        : Number.POSITIVE_INFINITY;

      const memberCount = (classNamesByStudent.get(p.id) || []).length;

      // Decide which (if any) risk tier this student falls into. We apply
      // tiers in priority order so a student matching multiple shows the
      // most-actionable one first.
      let tier: 0 | 1 | 2 | null = null;
      if (last3Avg !== null && last3Avg < 50) tier = 0;
      else if (declining) tier = 1;
      else if (inactiveDays >= 14 && memberCount > 0) tier = 2;
      if (tier === null) continue;

      let withinTierKey = 0;
      if (tier === 0) withinTierKey = last3Avg ?? 0;       // lower avg = worse
      else if (tier === 1) withinTierKey = last3Avg ?? 0;  // tie-break by avg
      else withinTierKey = -inactiveDays;                   // more days = worse

      out.push({
        studentId: p.id,
        name: p.full_name || "(unnamed student)",
        classNames: classNamesByStudent.get(p.id) || [],
        attemptsCount: studentAttempts.length,
        last3Avg,
        declining,
        inactiveDays,
        lastActiveAt,
        tier,
        withinTierKey,
      });
    }

    // Sort: tier asc, then withinTierKey asc. (lower key = more severe).
    out.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      return a.withinTierKey - b.withinTierKey;
    });
    return out;
  }, [profiles, attemptsByStudent, classNamesByStudent]);

  if (loading) {
    return (
      <div className="grid place-items-center py-20">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="card">
      <h3 className="font-semibold mb-3 flex items-center gap-2 text-red-800">
        <AlertTriangle size={16} /> At-risk student watchlist
      </h3>
      {rows.length === 0 ? (
        <p className="muted text-sm">No students are flagged as at-risk this week. 🎉</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase muted">
              <tr>
                <th className="px-3 py-2 text-left">Student</th>
                <th className="px-3 py-2 text-left">Class(es)</th>
                <th className="px-3 py-2 text-left">Reason</th>
                <th className="px-3 py-2 text-right">Last activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => {
                let chip;
                if (r.tier === 0) {
                  chip = (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-800">
                      <AlertTriangle size={12} /> Low score {Math.round(r.last3Avg ?? 0)}%
                    </span>
                  );
                } else if (r.tier === 1) {
                  chip = (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
                      <TrendingDown size={12} /> Declining
                    </span>
                  );
                } else {
                  const days = Number.isFinite(r.inactiveDays) ? r.inactiveDays : "∞";
                  chip = (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-200 text-slate-800">
                      <Clock size={12} /> Inactive {days} days
                    </span>
                  );
                }
                return (
                  <tr key={r.studentId} className="hover:bg-slate-50">
                    <td className="px-3 py-2 font-medium">{r.name}</td>
                    <td className="px-3 py-2 text-slate-600">
                      {r.classNames.length > 0 ? r.classNames.join(", ") : "—"}
                    </td>
                    <td className="px-3 py-2">{chip}</td>
                    <td className="px-3 py-2 text-right text-slate-600">
                      {relativeFromNow(r.lastActiveAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-xs muted mt-3">
            Flagged when a student&rsquo;s last-3 average is below 50%, their last 3 attempts
            are strictly declining, or they&rsquo;ve been inactive for 14+ days.
          </p>
        </div>
      )}
    </div>
  );
}
