"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Building2, ArrowLeft, Search, Plus } from "lucide-react";
import { pct } from "@/lib/utils";

// === Class-naming standard ===========================================
// Every class follows the canonical format:   Grade {N} · Section {X}
// - Common grades 1..12 in the dropdown; "Other (specify)" lets the user
//   type Pre-K, LKG, UKG, "11+12", or any school-specific label.
// - Common sections A..H in the dropdown; "Other (specify)" lets the user
//   type house names like "Saraswati", numbered sections, etc.
// Class creation is INDEPENDENT of teacher assignment — the Admin Head sets
// up class structure first, then assigns a primary teacher later.
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
  primaryEmail: string | null;       // email of the linked primary, if known
  pendingPrimaryEmail: string | null; // email of a pending invite (no account yet)
  coTeacherCount: number;            // active (non-primary) co-teachers
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

  // New-class form state.
  // gradeChoice/sectionChoice are the dropdown selection ("9", "A", or "__other__").
  // gradeOther/sectionOther hold the free-text input when "Other" is picked.
  // The effective value submitted is one or the other, depending on the choice.
  const [gradeChoice, setGradeChoice] = useState("");
  const [gradeOther, setGradeOther] = useState("");
  const [sectionChoice, setSectionChoice] = useState("");
  const [sectionOther, setSectionOther] = useState("");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  // Teachers in this school — used to populate the "Set primary teacher" picker.
  const [teachersInSchool, setTeachersInSchool] = useState<Teacher[]>([]);

  // Per-class assign-primary UI: which class is being edited, the typed
  // email, busy/error state, and (after save) a status message that says
  // whether the teacher was linked directly or stored as a pending invite.
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
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;

    const { data: prof } = await sb.from("profiles").select("school_id").eq("id", user.id).single();
    if (!prof?.school_id) { setLoading(false); return; }

    // Teachers-in-school for the assign-primary picker.
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
        const [{ data: ct }, { count: mCt }, { data: invite }, { count: coCount }] = await Promise.all([
          sb.from("class_teachers").select("teacher_id, profile:profiles!class_teachers_teacher_id_fkey(full_name)").eq("class_id", c.id).eq("role", "primary").maybeSingle(),
          sb.from("class_members").select("student_id", { count: "exact", head: true }).eq("class_id", c.id),
          sb.from("class_teacher_invites").select("email").eq("class_id", c.id).eq("role", "primary").maybeSingle(),
          sb.from("class_teachers").select("teacher_id", { count: "exact", head: true }).eq("class_id", c.id).eq("role", "co"),
        ]);
        type CtRow = { teacher_id: string; profile: { full_name: string | null } | null };
        const ctRow = ct as unknown as CtRow | null;
        const primaryId = ctRow?.teacher_id || null;
        const primaryName = ctRow?.profile?.full_name || null;
        const pendingPrimaryEmail = (invite as { email: string } | null)?.email || null;

        const { count: qCt } = await sb.from("quiz_assignments").select("id", { count: "exact", head: true }).eq("class_id", c.id);

        const { data: members } = await sb.from("class_members").select("student_id").eq("class_id", c.id);
        const studentIds = ((members as Array<{ student_id: string }>) || []).map((m) => m.student_id);
        let avgScore: number | null = null;
        if (studentIds.length > 0) {
          const { data: atts } = await sb
            .from("quiz_attempts")
            .select("score, total")
            .in("student_id", studentIds)
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
          primaryEmail: null,  // not surfaced for now; we already have the name
          pendingPrimaryEmail,
          coTeacherCount: coCount || 0,
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
      let json: { error?: string; status?: string } = {};
      let raw = "";
      try { raw = await res.text(); json = raw ? JSON.parse(raw) : {}; } catch {}
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}: ${raw.slice(0,200)}`);
      if (json.status === "linked") setAssignStatus("\u2705 Linked — that teacher is now the primary.");
      else if (json.status === "pending") setAssignStatus("\u23f3 No account yet for that email. The class will auto-link when they sign up. Use \u201cCopy invite\u201d to share the message.");
      else if (json.status === "unassigned") setAssignStatus("Class is now unassigned.");
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
      `Hi! I\u2019ve set you as the primary teacher of ${c.name} on BloomIQ. ` +
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
      // If the server returns non-JSON (rare — usually only when something
      // crashes before the route handler), keep the raw text around so we
      // can surface it instead of the generic "Could not create class".
      let json: { error?: string; ok?: boolean } = {};
      let rawText = "";
      try {
        rawText = await res.text();
        json = rawText ? JSON.parse(rawText) : {};
      } catch {
        // not JSON
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
    // Numeric grades sort numerically; non-numeric (Pre-K, LKG) drop to the end alphabetically.
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

      {/* New class — independent of teacher assignment. Just structure. */}
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

      {/* Filters */}
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
                <th className="px-4 py-3 text-right">Students</th>
                <th className="px-4 py-3 text-right">Quizzes</th>
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
                    {c.primaryName ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-[10px] uppercase tracking-wide font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">✅ Active</span>
                        {c.primaryName}
                      </span>
                    ) : c.pendingPrimaryEmail ? (
                      <span className="inline-flex items-center gap-1.5 italic">
                        <span className="text-[10px] uppercase tracking-wide font-bold text-sky-800 bg-sky-50 border border-sky-200 rounded-full px-2 py-0.5">⏳ Pending</span>
                        <span className="text-slate-700">{c.pendingPrimaryEmail}</span>
                      </span>
                    ) : (
                      <span className="text-[10px] uppercase tracking-wide font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
                        Unassigned
                      </span>
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
                      {c.primaryName || c.pendingPrimaryEmail ? "Change" : "Set primary"}
                    </button>
                  </td>
                </tr>
                {assignFor === c.id && (
                  <tr className="bg-slate-50">
                    <td colSpan={6} className="px-4 py-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <label className="text-xs muted">Primary teacher email:</label>
                        <input
                          type="email"
                          className="input max-w-[280px]"
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
                            const warn = (c.coTeacherCount > 0 || c.memberCount > 0)
                              ? `Unassign the primary of ${c.name}?\n\n` +
                                `This class has ${c.coTeacherCount} co-teacher${c.coTeacherCount === 1 ? "" : "s"} and ${c.memberCount} student${c.memberCount === 1 ? "" : "s"}. ` +
                                `They keep access, but adding more co-teachers will require the Admin Head until you assign a new primary. Continue?`
                              : `Unassign the primary of ${c.name}? The class will become unassigned.`;
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
                      <p className="text-xs muted mt-2">
                        If the teacher already has a BloomIQ account with this email, they’ll be linked instantly.
                        Otherwise we’ll save a pending invite and link them automatically when they sign up.
                      </p>
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
