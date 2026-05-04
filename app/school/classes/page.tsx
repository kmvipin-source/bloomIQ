"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Building2, ArrowLeft, Search, Plus } from "lucide-react";
import { pct } from "@/lib/utils";
import { loadClassQuizIdsForClasses } from "@/lib/studentScope";

const GRADE_OPTIONS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const SECTION_OPTIONS = ["A", "B", "C", "D", "E", "F", "G", "H"];
const OTHER = "__other__";

function buildCanonicalName(g: string, sec: string): string {
  if (!g.trim()) return "";
  const parts = [`Grade ${g.trim()}`];
  if (sec.trim()) parts.push(`Section ${sec.trim()}`);
  return parts.join(" · ");
}

type ClassRow = {
  id: string;
  name: string;
  grade: string | null;
  section: string | null;
  primaryId: string | null;
  primaryName: string | null;
  primaryEmail: string | null;
  pendingPrimaryEmail: string | null;
  inviteStatus: "pending" | "accepted" | "declined" | null;
  inviteEmail: string | null;
  coTeacherCount: number;
  // Acting cover (Option B / migration 48): the canonical primary stays
  // primary while a fill-in is added as 'acting' for temporary leave cover.
  // Both columns null when no cover is active.
  actingId: string | null;
  actingName: string | null;
  memberCount: number;
  quizCount: number;
  avgScore: number | null;
};

type Teacher = { id: string; full_name: string | null };

export default function SchoolClassesPage() {
  const [rows, setRows] = useState<ClassRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [teacherFilter, setTeacherFilter] = useState<string>("all");
  const [gradeFilter, setGradeFilter] = useState<string>("all");

  const [gradeChoice, setGradeChoice] = useState("");
  const [gradeOther, setGradeOther] = useState("");
  const [sectionChoice, setSectionChoice] = useState("");
  const [sectionOther, setSectionOther] = useState("");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  const [teachersInSchool, setTeachersInSchool] = useState<Teacher[]>([]);

  const [assignFor, setAssignFor] = useState<string | null>(null);
  const [assignEmail, setAssignEmail] = useState("");
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignErr, setAssignErr] = useState<string | null>(null);
  const [assignStatus, setAssignStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const grade = gradeChoice === OTHER ? gradeOther.trim() : gradeChoice;
  const section = sectionChoice === OTHER
    ? sectionOther.trim()
    : sectionChoice;
  const canonicalName = buildCanonicalName(grade, section);

  async function load() {
    setLoading(true);
    const sb = supabaseBrowser();
    // Resolve school_id via service-role /api/auth/me to dodge the RLS race
    // that otherwise returns null on first paint and blanks the class list.
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

    const { data: teachers } = await sb
      .from("profiles")
      .select("id, full_name")
      .eq("school_id", prof.school_id)
      .eq("role", "teacher")
      .order("full_name", { ascending: true, nullsFirst: false });
    setTeachersInSchool((teachers as Teacher[]) || []);

    const { data: cs } = await sb
      .from("classes")
      .select("id, name, grade, section, owner_id, created_at")
      .eq("school_id", prof.school_id)
      .order("created_at", { ascending: false });
    type Cs = { id: string; name: string; grade: string | null; section: string | null; owner_id: string | null; created_at: string };
    const classList = (cs as Cs[]) || [];

    const hydrated: ClassRow[] = await Promise.all(
      classList.map(async (c) => {
        const [{ data: ct }, { count: mCt }, { data: invite }, { count: coCount }, { data: acting }] = await Promise.all([
          sb.from("class_teachers").select("teacher_id, profile:profiles!class_teachers_teacher_id_fkey(full_name)").eq("class_id", c.id).eq("role", "primary").maybeSingle(),
          sb.from("class_members").select("student_id", { count: "exact", head: true }).eq("class_id", c.id),
          // Sort by invited_at desc so a freshly created pending invite
          // (responded_at = null) surfaces ahead of an older declined one.
          // Sorting by responded_at put pending rows at the bottom and
          // surfaced stale "Rejected" badges instead of the live invite.
          sb.from("class_teacher_invites").select("email, status, responded_at, invited_at").eq("class_id", c.id).eq("role", "primary").order("invited_at", { ascending: false }).limit(1).maybeSingle(),
          sb.from("class_teachers").select("teacher_id", { count: "exact", head: true }).eq("class_id", c.id).eq("role", "co"),
          sb.from("class_teachers").select("teacher_id, profile:profiles!class_teachers_teacher_id_fkey(full_name)").eq("class_id", c.id).eq("role", "acting").maybeSingle(),
        ]);
        type ActingRow = { teacher_id: string; profile: { full_name: string | null } | null };
        const actingRow = acting as unknown as ActingRow | null;
        const actingId = actingRow?.teacher_id || null;
        const actingName = actingRow?.profile?.full_name || null;
        type CtRow = { teacher_id: string; profile: { full_name: string | null } | null };
        const ctRow = ct as unknown as CtRow | null;
        const primaryId = ctRow?.teacher_id || null;
        const primaryName = ctRow?.profile?.full_name || null;
        type InviteRow = { email: string; status: "pending" | "accepted" | "declined" | null };
        const inviteRow = invite as InviteRow | null;
        const inviteEmail = inviteRow?.email || null;
        const inviteStatus = inviteRow?.status || null;
        const pendingPrimaryEmail = inviteStatus === "pending" ? inviteEmail : null;

        const { count: qCt } = await sb.from("quiz_assignments").select("id", { count: "exact", head: true }).eq("class_id", c.id);

        const { data: members } = await sb.from("class_members").select("student_id").eq("class_id", c.id);
        const studentIds = ((members as Array<{ student_id: string }>) || []).map((m) => m.student_id);
        const classAssignedQuizIds = await loadClassQuizIdsForClasses(sb, [c.id]);
        const assignedIdsArr = Array.from(classAssignedQuizIds);
        let avgScore: number | null = null;
        if (studentIds.length > 0 && assignedIdsArr.length > 0) {
          const { data: atts } = await sb
            .from("quiz_attempts")
            .select("score, total")
            .in("student_id", studentIds)
            .in("quiz_id", assignedIdsArr)
            .not("submitted_at", "is", null);
          const arr = (atts as Array<{ score: number; total: number }> | null) || [];
          const ratios = arr.filter((a) => a.total > 0).map((a) => pct(a.score, a.total));
          avgScore = ratios.length ? Math.round(ratios.reduce((s, x) => s + x, 0) / ratios.length) : null;
        }

        return {
          id: c.id,
          name: c.name,
          grade: c.grade,
          section: c.section,
          primaryId,
          primaryName,
          primaryEmail: null,
          pendingPrimaryEmail,
          inviteStatus,
          inviteEmail,
          coTeacherCount: coCount || 0,
          actingId,
          actingName,
          memberCount: mCt || 0,
          quizCount: qCt || 0,
          avgScore,
        };
      })
    );
    setRows(hydrated);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  // End acting cover — used when the canonical primary returns from leave
  // and the temporary cover should go away. One click per class; no
  // re-reassign of primary required (that's the whole point of Option B).
  async function endActingCover(classId: string, primaryName: string | null, actingName: string | null) {
    if (!confirm(
      `End the acting cover on this class?

` +
      (actingName ? `${actingName} will lose acting privileges and revert to a regular co-teacher relationship (if they had one), or be removed from the class. ` : "") +
      (primaryName ? `${primaryName} stays as the primary teacher.` : "")
    )) return;
    setAssignErr(null);
    setAssignStatus(null);
    setAssignBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const r = await fetch(`/api/admin/classes/${classId}/primary`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ end_acting: true }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Failed");
      setAssignStatus("✅ Acting cover ended.");
      await load();
    } catch (e) {
      setAssignErr(e instanceof Error ? e.message : "Could not end acting cover");
    } finally {
      setAssignBusy(false);
    }
  }

  async function assignPrimary(classId: string, email: string | null) {
    setAssignErr(null);
    setAssignStatus(null);
    setAssignBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const res = await fetch(`/api/admin/classes/${classId}/primary`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ email }),
      });
      let json: { error?: string; status?: string; removed_from_school?: boolean } = {};
      let raw = "";
      try { raw = await res.text(); json = raw ? JSON.parse(raw) : {}; } catch {}
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}: ${raw.slice(0,200)}`);
      if (json.status === "linked") setAssignStatus("✅ Linked — that teacher is now the primary.");
      else if (json.status === "pending") setAssignStatus("⏳ Invite sent. The class will show as Pending until the teacher accepts it from their dashboard. Use “Copy invite” to share the sign-in link.");
      else if (json.status === "unassigned") {
        setAssignStatus(json.removed_from_school
          ? "Class unassigned. The previous primary had no other classes in this school, so they were also removed from the school roster."
          : "Class unassigned. The previous primary still has other classes here, so they stay on the school roster.");
      }
      setAssignFor(null);
      setAssignEmail("");
      await load();
    } catch (e) {
      setAssignErr(e instanceof Error ? e.message : "Could not change primary teacher");
    } finally {
      setAssignBusy(false);
    }
  }

  function copyInvite(c: ClassRow, email: string) {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const msg =
      `Hi! I’ve set you as the primary teacher of ${c.name} on BloomIQ. ` +
      `Sign up at ${origin}/signup using this email (${email}) and pick the Teacher role. ` +
      `The class will appear on your dashboard automatically once you sign in.`;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(msg).catch(() => {});
    }
    setCopied(c.id);
    setTimeout(() => setCopied(null), 1800);
  }

  async function createClass() {
    setCreateErr(null);
    if (!gradeChoice) return setCreateErr("Pick a grade.");
    if (gradeChoice === OTHER && !grade) return setCreateErr("Type the grade label.");
    if (!sectionChoice) return setCreateErr("Pick a section.");
    if (sectionChoice === OTHER && !section) return setCreateErr("Type the section label.");

    setCreating(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in");

      const res = await fetch("/api/admin/classes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ grade, section }),
      });
      let json: { error?: string; ok?: boolean } = {};
      let rawText = "";
      try {
        rawText = await res.text();
        json = rawText ? JSON.parse(rawText) : {};
      } catch {
      }
      if (!res.ok) {
        const detail = json?.error || (rawText ? rawText.slice(0, 200) : "");
        throw new Error(detail
          ? `HTTP ${res.status}: ${detail}`
          : `HTTP ${res.status} from /api/admin/classes`);
      }

      setGradeChoice(""); setGradeOther("");
      setSectionChoice(""); setSectionOther("");
      await load();
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : "Could not create class");
    } finally {
      setCreating(false);
    }
  }

  const teachers = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => r.primaryName && set.add(r.primaryName));
    return Array.from(set).sort();
  }, [rows]);

  const grades = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => r.grade && set.add(r.grade));
    return Array.from(set).sort((a, b) => {
      const an = Number(a), bn = Number(b);
      if (!isNaN(an) && !isNaN(bn)) return an - bn;
      if (!isNaN(an)) return -1;
      if (!isNaN(bn)) return 1;
      return a.localeCompare(b);
    });
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (teacherFilter !== "all" && r.primaryName !== teacherFilter) return false;
      if (gradeFilter !== "all" && r.grade !== gradeFilter) return false;
      if (needle) {
        const hay = `${r.name} ${r.section || ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [rows, search, teacherFilter, gradeFilter]);

  const overall = useMemo(() => {
    const totalStudents = filtered.reduce((s, r) => s + r.memberCount, 0);
    const ratios = filtered.map((r) => r.avgScore).filter((x): x is number => x !== null);
    const avg = ratios.length ? Math.round(ratios.reduce((s, x) => s + x, 0) / ratios.length) : 0;
    const unassigned = filtered.filter((r) => !r.primaryName).length;
    return { classes: filtered.length, students: totalStudents, avg, unassigned };
  }, [filtered]);

  if (loading) return <div className="grid place-items-center py-20"><div className="spinner" /></div>;

  const canSubmit = !!grade && !!section && !creating;

  return (
    <div className="max-w-6xl mx-auto fade-in">
      <Link href="/school" className="text-sm text-emerald-700 font-semibold inline-flex items-center gap-1"><ArrowLeft size={14} /> School home</Link>
      <h1 className="h1 mt-2 flex items-center gap-2"><Building2 size={28} /> All classes</h1>
      <p className="muted mt-1">Every class across every teacher in your school.</p>

      <div className="grid sm:grid-cols-3 gap-4 mt-6">
        <div className="card"><div className="text-xs muted uppercase font-semibold">Classes</div><div className="text-3xl font-bold">{overall.classes}</div></div>
        <div className="card"><div className="text-xs muted uppercase font-semibold">Total students</div><div className="text-3xl font-bold">{overall.students}</div></div>
        <div className="card"><div className="text-xs muted uppercase font-semibold">Avg score across classes</div><div className="text-3xl font-bold">{overall.avg ? `${overall.avg}%` : "—"}</div></div>
      </div>

      <div className="card mt-6">
        <h3 className="font-semibold mb-3 flex items-center gap-2"><Plus size={16} /> New class</h3>

        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Grade</label>
            <select className="select" value={gradeChoice} onChange={(e) => setGradeChoice(e.target.value)}>
              <option value="">— Pick grade —</option>
              {GRADE_OPTIONS.map((g) => (
                <option key={g} value={g}>Grade {g}</option>
              ))}
              <option value={OTHER}>Other (specify)…</option>
            </select>
            {gradeChoice === OTHER && (
              <input
                className="input mt-2"
                value={gradeOther}
                onChange={(e) => setGradeOther(e.target.value)}
                placeholder="e.g. Pre-K, LKG, UKG, 11+12"
                maxLength={30}
                autoFocus
              />
            )}
          </div>
          <div>
            <label className="label">Section</label>
            <select className="select" value={sectionChoice} onChange={(e) => setSectionChoice(e.target.value)}>
              <option value="">— Pick section —</option>
              {SECTION_OPTIONS.map((s) => (
                <option key={s} value={s}>Section {s}</option>
              ))}
              <option value={OTHER}>Other (specify)…</option>
            </select>
            {sectionChoice === OTHER && (
              <input
                className="input mt-2"
                value={sectionOther}
                onChange={(e) => setSectionOther(e.target.value)}
                placeholder="e.g. Saraswati, Alpha, 1, Red"
                maxLength={30}
                autoFocus
              />
            )}
          </div>
        </div>

        <div className="mt-3 p-3 rounded-lg bg-slate-50 border border-slate-200 text-sm">
          <div className="muted text-xs uppercase tracking-wide mb-1">Class name preview</div>
          <div className="font-semibold">
            {canonicalName || <span className="muted font-normal italic">Pick grade and section above…</span>}
          </div>
          <p className="text-xs muted mt-1">
            Every class follows this format. Assign a primary teacher to the class after it&rsquo;s created.
          </p>
        </div>

        <div className="flex justify-end mt-4">
          <button
            className="btn btn-primary"
            disabled={!canSubmit}
            onClick={createClass}
          >
            {creating ? <><span className="spinner" /> Creating…</> : "Create class"}
          </button>
        </div>
        {createErr && (
          <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
            {createErr}
          </div>
        )}
      </div>

      {overall.unassigned > 0 && (
        <div className="mt-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
          {overall.unassigned} class{overall.unassigned === 1 ? "" : "es"} without a primary teacher. Assign one to start using the class.
        </div>
      )}

      {assignStatus && (
        <div className="mt-4 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded-lg">
          {assignStatus}
        </div>
      )}

      <div className="card mt-6 flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input className="input pl-9" placeholder="Search class or section..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select className="select max-w-[200px]" value={teacherFilter} onChange={(e) => setTeacherFilter(e.target.value)}>
          <option value="all">All teachers</option>
          {teachers.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="select max-w-[140px]" value={gradeFilter} onChange={(e) => setGradeFilter(e.target.value)}>
          <option value="all">All grades</option>
          {grades.map((g) => <option key={g} value={g}>Grade {g}</option>)}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="card mt-4 text-center py-12 muted">
          {rows.length === 0 ? "No classes in this school yet." : "No classes match these filters."}
        </div>
      ) : (
        <div className="card mt-4 overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase muted">
              <tr>
                <th className="px-4 py-3 text-left">Class</th>
                <th className="px-4 py-3 text-left">Primary teacher</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-right">Students</th>
                <th className="px-4 py-3 text-right">Tests</th>
                <th className="px-4 py-3 text-right">Avg score</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((c) => (
                <Fragment key={c.id}>
                <tr className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div className="font-medium">{c.name}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      {c.primaryName ? (
                        <span>{c.primaryName}</span>
                      ) : c.pendingPrimaryEmail ? (
                        <span className="text-slate-700 italic">{c.pendingPrimaryEmail}</span>
                      ) : c.inviteEmail ? (
                        <span className="text-slate-700 italic">{c.inviteEmail}</span>
                      ) : (
                        <span className="muted italic">—</span>
                      )}
                      {c.actingName && (
                        <span className="inline-flex items-center gap-1.5 flex-wrap">
                          <span className="text-[10px] uppercase tracking-wide font-bold text-violet-800 bg-violet-50 border border-violet-200 rounded-full px-2 py-0.5">🛡 Cover</span>
                          <span className="text-slate-700 text-xs">{c.actingName}</span>
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {c.primaryName ? (
                      <span className="text-[10px] uppercase tracking-wide font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">✅ Assigned</span>
                    ) : c.inviteStatus === "pending" ? (
                      <span className="text-[10px] uppercase tracking-wide font-bold text-sky-800 bg-sky-50 border border-sky-200 rounded-full px-2 py-0.5">⏳ Pending</span>
                    ) : c.inviteStatus === "declined" ? (
                      <span className="text-[10px] uppercase tracking-wide font-bold text-red-800 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">❌ Rejected</span>
                    ) : (
                      <span className="text-[10px] uppercase tracking-wide font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">Unassigned</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">{c.memberCount}</td>
                  <td className="px-4 py-3 text-right">{c.quizCount}</td>
                  <td className={`px-4 py-3 text-right font-semibold ${
                    c.avgScore === null ? "text-slate-400" :
                    c.avgScore >= 70 ? "text-emerald-700" :
                    c.avgScore >= 50 ? "text-amber-700" : "text-red-700"
                  }`}>
                    {c.avgScore !== null ? `${c.avgScore}%` : "—"}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {c.pendingPrimaryEmail && (
                      <button
                        className="btn btn-ghost text-xs mr-1"
                        onClick={() => copyInvite(c, c.pendingPrimaryEmail!)}
                        title="Copy invite message"
                      >
                        {copied === c.id ? "Copied" : "Copy invite"}
                      </button>
                    )}
                    <button
                      className="btn btn-ghost text-xs"
                      onClick={() => {
                        setAssignFor(assignFor === c.id ? null : c.id);
                        setAssignEmail(c.pendingPrimaryEmail || "");
                        setAssignErr(null);
                        setAssignStatus(null);
                      }}
                    >
                      {c.actingName
                        ? "Change cover"
                        : c.primaryName
                          ? "Cover"
                          : c.pendingPrimaryEmail
                            ? "Re-invite"
                            : "Assign primary"}
                    </button>
                    {c.actingName && (
                      <button
                        className="btn btn-ghost text-xs ml-1"
                        onClick={() => endActingCover(c.id, c.primaryName, c.actingName)}
                        disabled={assignBusy}
                        title="Remove the acting cover. The canonical primary stays primary."
                      >
                        End cover
                      </button>
                    )}
                  </td>
                </tr>
                {assignFor === c.id && (
                  <tr className="bg-slate-50">
                    <td colSpan={7} className="px-4 py-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        {teachersInSchool.length > 0 && (
                          <>
                            <label className="text-xs muted">Pick teacher:</label>
                            <select
                              className="input max-w-[260px]"
                              defaultValue=""
                              disabled={assignBusy}
                              onChange={async (e) => {
                                const tid = e.target.value;
                                if (!tid) return;
                                const targetName = teachersInSchool.find((t) => t.id === tid)?.full_name || "this teacher";
                                const hasPrimary = !!c.primaryName;
                                const confirmMsg = hasPrimary
                                  ? `Add ${targetName} as the ACTING COVER on ${c.name}?\n\n` +
                                    `${c.primaryName} stays as the primary teacher and keeps full access. ` +
                                    `${targetName} gets equivalent privileges as a temporary cover. ` +
                                    `When ${c.primaryName} returns, click "End acting cover" — no need to re-assign anyone.`
                                  : `Make ${targetName} the primary teacher of ${c.name}?`;
                                if (!confirm(confirmMsg)) {
                                  e.target.value = "";
                                  return;
                                }
                                const sb = supabaseBrowser();
                                const { data: { session } } = await sb.auth.getSession();
                                if (!session) return;
                                setAssignBusy(true);
                                try {
                                  const r = await fetch(`/api/admin/classes/${c.id}/primary`, {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
                                    body: JSON.stringify({ teacher_id: tid, immediate: true }),
                                  });
                                  const j = await r.json();
                                  if (!r.ok) throw new Error(j?.error || "Failed");
                                  setAssignFor(null);
                                  setAssignEmail("");
                                  setAssignStatus(c.primaryName
                                    ? `✅ ${targetName} is now the acting cover on ${c.name}. ${c.primaryName} stays as primary.`
                                    : `✅ ${targetName} is now the primary teacher of ${c.name}.`);
                                  await load();
                                } catch (err) {
                                  setAssignErr(err instanceof Error ? err.message : "Failed");
                                } finally {
                                  setAssignBusy(false);
                                }
                              }}
                            >
                              <option value="">— Select a teacher in this school —</option>
                              {teachersInSchool.map((t) => (
                                <option key={t.id} value={t.id}>{t.full_name || t.id.slice(0, 8)}</option>
                              ))}
                            </select>
                            <span className="text-xs muted">or by email:</span>
                          </>
                        )}
                        <input
                          type="email"
                          className="input max-w-[260px]"
                          value={assignEmail}
                          onChange={(e) => setAssignEmail(e.target.value)}
                          placeholder="teacher@example.com"
                          disabled={assignBusy}
                          autoFocus
                        />
                        <button
                          className="btn btn-primary"
                          disabled={assignBusy || !assignEmail.trim()}
                          onClick={() => assignPrimary(c.id, assignEmail.trim() || null)}
                        >
                          {assignBusy ? <span className="spinner" /> : "Save"}
                        </button>
                        <button
                          className="btn btn-ghost"
                          onClick={() => {
                            const warn =
                              `Unassign the primary of ${c.name}?\n\n` +
                              `The previous primary will be removed from this class. ` +
                              `If they have no other classes in this school, they will also be dropped from the school roster automatically. ` +
                              ((c.coTeacherCount > 0 || c.memberCount > 0)
                                ? `This class has ${c.coTeacherCount} co-teacher${c.coTeacherCount === 1 ? "" : "s"} and ${c.memberCount} student${c.memberCount === 1 ? "" : "s"} — they keep their access. Continue?`
                                : `Continue?`);
                            if (confirm(warn)) assignPrimary(c.id, null);
                          }}
                          disabled={assignBusy}
                          title="Unassign primary teacher"
                        >
                          Unassign
                        </button>
                        <button className="btn btn-ghost" onClick={() => { setAssignFor(null); setAssignErr(null); setAssignStatus(null); }} disabled={assignBusy}>
                          Cancel
                        </button>
                      </div>
                      {teachersInSchool.length === 0 ? (
                        <div className="text-xs mt-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-900">
                          No teachers in this school yet — the dropdown of in-school teachers
                          will appear here once they accept their invite. For now, type the
                          teacher&rsquo;s email above to send a primary-teacher invite, or
                          add them first from the{" "}
                          <Link href="/school/teachers" className="font-semibold underline">
                            Teachers page
                          </Link>.
                        </div>
                      ) : (
                        <p className="text-xs muted mt-2">
                          <strong>Picking from the dropdown</strong> adds an <em>acting cover</em> — the
                          canonical primary keeps the role and full access; the cover gets equivalent
                          privileges temporarily. When the primary returns, click <strong>End acting cover</strong>
                          on the row. No re-assignment needed.
                          <br />
                          <strong>Typing an email</strong> sends an invite the new teacher must accept —
                          the gentler path for permanent onboarding (currently this still goes through
                          the legacy primary-transfer flow; tightened in a follow-up).
                        </p>
                      )}
                      {assignErr && (
                        <div className="mt-2 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{assignErr}</div>
                      )}
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
