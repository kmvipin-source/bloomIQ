"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { School } from "@/lib/types";
import { Building2, UserRound, ListChecks, ClipboardList, TrendingUp, Settings, Copy, Pencil, UserCog, BarChart3, MessageCircle, Sparkles } from "lucide-react";
import CurrentPlanBadge from "@/components/CurrentPlanBadge";
import RenewBanner from "@/components/RenewBanner";
import { useFeatureAccess } from "@/lib/featureAccess";
import { generateQuizCode } from "@/lib/utils";
import { loadClassQuizIdsForClasses } from "@/lib/studentScope";
import { useFocusRefetch } from "@/lib/useFocusRefetch";

type Stats = {
  teachers: number;
  classes: number;
  students: number;
  quizzes: number;
  attempts: number;
  avgScore: number;
};

type TeacherRow = {
  id: string;
  full_name: string | null;
  classCount: number;
  quizCount: number;
  assignmentCount: number;
};

type ClassRow = {
  id: string;
  name: string;
  primaryName: string | null;
  memberCount: number;
  attemptCount: number;
  avgScore: number | null;
};

export default function SchoolHome() {
  const [school, setSchool] = useState<School | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [teachers, setTeachers] = useState<TeacherRow[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);

  // Feature access — used to drive the school-plan renewal banner that
  // shows the super-teacher when their school plan is within the 7-day
  // warning window or already expired.
  const access = useFeatureAccess();

  // The Head is the profile referenced by schools.super_teacher_id.
  // Deputies (other super_teachers in the school) see almost everything
  // the Head sees, but the Transfer Admin Head action is reserved for
  // the Head themselves.
  const [callerIsHead, setCallerIsHead] = useState(false);
  const [schoolName, setSchoolName] = useState("");
  const [creating, setCreating] = useState(false);
  const [setupErr, setSetupErr] = useState<string | null>(null);

  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [renameErr, setRenameErr] = useState<string | null>(null);

  const [transferOpen, setTransferOpen] = useState(false);
  const [transferEmail, setTransferEmail] = useState("");
  const [transferring, setTransferring] = useState(false);
  const [transferErr, setTransferErr] = useState<string | null>(null);
  const [transferOk, setTransferOk] = useState<string | null>(null);

  // Bundled load via the service-role /api/school/dashboard endpoint.
  // The previous implementation pulled schools / profiles / class_teachers
  // / class_members / quiz_attempts via the user-token client which raced
  // RLS on first paint, and counted attempts against every student in
  // the school for every class (inflating per-class attemptCount with
  // cross-class data). The endpoint owns both correctness fixes.
  async function load() {
    setLoading(true);
    const sb = supabaseBrowser();
    const { data: { session } } = await sb.auth.getSession();
    const token = session?.access_token;
    if (!token) { setLoading(false); return; }
    try {
      const res = await fetch("/api/school/dashboard", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) { setLoading(false); return; }
      const j = await res.json() as {
        ok: boolean;
        needs_setup?: boolean;
        caller_is_head?: boolean;
        school?: School | null;
        teachers?: TeacherRow[];
        classes?: ClassRow[];
        stats?: Stats;
      };
      if (j.needs_setup) {
        setNeedsSetup(true);
        setLoading(false);
        return;
      }
      if (j.school) setSchool(j.school);
      setCallerIsHead(!!j.caller_is_head);
      setTeachers(j.teachers || []);
      setClasses(j.classes || []);
      if (j.stats) setStats(j.stats);
    } catch { /* fall through to spinner clear */ }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);
  useFocusRefetch(load);

  async function saveSchoolName() {
    setRenameErr(null);
    const next = draftName.trim();
    if (!next) return setRenameErr("School name can't be empty.");
    if (!school) return;
    setSavingName(true);
    try {
      const sb = supabaseBrowser();
      const { data: updated, error } = await sb
        .from("schools")
        .update({ name: next })
        .eq("id", school.id)
        .select()
        .single();
      if (error) throw error;
      setSchool(updated as School);
      setEditingName(false);
    } catch (e) {
      const err = e as { message?: string };
      setRenameErr(err?.message || "Could not rename school.");
    } finally {
      setSavingName(false);
    }
  }

  async function transferAdmin() {
    setTransferErr(null);
    setTransferOk(null);
    const email = transferEmail.trim().toLowerCase();
    if (!email) return setTransferErr("Enter the new Admin Head's email.");
    if (!confirm(
      `Transfer the Admin Head role to ${email}?\n\n` +
      `You will be demoted to a regular teacher in this school. ` +
      `This cannot be undone except by the new Admin Head transferring it back.`
    )) return;
    setTransferring(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const res = await fetch("/api/admin/school/transfer", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ new_admin_email: email }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Transfer failed.");
      setTransferOk(
        `Done. ${email} is now Admin Head. Redirecting…`
      );
      setTransferEmail("");
      setTransferOpen(false);
      // Refresh the Supabase session before navigating so the next page
      // load picks up the new role (caller is now a regular teacher).
      // window.location.replace avoids leaving an in-memory super_teacher
      // identity behind, which would otherwise let the caller click
      // "Transfer" again during the 2s gap and surface confusing errors.
      try { await sb.auth.refreshSession(); } catch { /* ignore */ }
      window.location.replace("/teacher");
      return;
    } catch (e) {
      setTransferErr(e instanceof Error ? e.message : "Transfer failed.");
    } finally {
      setTransferring(false);
    }
  }

  async function createSchool() {
    setSetupErr(null);
    if (!schoolName.trim()) return setSetupErr("Give the school a name.");
    setCreating(true);
    try {
      // Route through /api/school/create so the schools insert +
      // profiles bind happen in a single service-role transaction. The
      // previous client-side flow ignored profile-update errors and
      // could leave the admin staring at "Set up your school" with an
      // orphan schools row already created.
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const res = await fetch("/api/school/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ name: schoolName.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Could not create school.");
      setNeedsSetup(false);
      await load();
    } catch (e) {
      const err = e as { message?: string };
      setSetupErr(err?.message || "Could not create school.");
    } finally {
      setCreating(false);
    }
  }

  const [copied, setCopied] = useState(false);
  function copyCode() {
    if (!school?.join_code) return;
    navigator.clipboard.writeText(school.join_code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (loading) return <div className="grid place-items-center py-20"><div className="spinner" /></div>;

  if (needsSetup) {
    return (
      <div className="max-w-md mx-auto fade-in">
        <h1 className="h1 flex items-center gap-2"><Building2 size={28} /> Set up your school</h1>
        <p className="muted mt-1">Name your school and you&apos;ll see all teachers and classes that join it.</p>
        <div className="card mt-6">
          <label className="label">School name</label>
          <input className="input" value={schoolName} onChange={(e) => setSchoolName(e.target.value)} placeholder="e.g. Greenwood International School" />
          {setupErr && <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{setupErr}</div>}
          <button type="button" className="btn btn-primary w-full mt-4" onClick={createSchool} disabled={creating}>
            {creating ? <><span className="spinner" /> Creating…</> : "Create school"}
          </button>
          <p className="muted text-xs mt-3">
            After this, invite teachers from the <strong>Teachers</strong> page so their classes and analytics roll up here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto fade-in">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          {editingName ? (
            <div className="flex items-center gap-2 flex-wrap">
              <input
                className="input max-w-md"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="School name"
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") saveSchoolName(); if (e.key === "Escape") setEditingName(false); }}
              />
              <button type="button" className="btn btn-primary" onClick={saveSchoolName} disabled={savingName}>
                {savingName ? <span className="spinner" /> : "Save"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => { setEditingName(false); setRenameErr(null); }} disabled={savingName}>
                Cancel
              </button>
            </div>
          ) : (
            <h1 className="h1 flex items-center gap-2 flex-wrap">
              <Building2 size={28} /> {school?.name}
              <button type="button"
                className="btn btn-ghost p-1"
                title="Rename school"
                onClick={() => { setDraftName(school?.name || ""); setEditingName(true); setRenameErr(null); }}
              >
                <Pencil size={14} />
              </button>
            </h1>
          )}
          {renameErr && (
            <div className="mt-2 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{renameErr}</div>
          )}
          <p className="muted mt-1">School-wide overview · {stats?.teachers || 0} teacher{stats?.teachers === 1 ? "" : "s"} · {stats?.students || 0} student{stats?.students === 1 ? "" : "s"}</p>
          <div className="mt-2"><CurrentPlanBadge /></div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link href="/school/reports" className="btn btn-primary"><BarChart3 size={14} /> Bloom Pulse</Link>
          {/* Transfer Admin Head is reserved for the Head — Deputies don't see this. */}
          {callerIsHead && (
            <button type="button" className="btn btn-secondary" onClick={() => setTransferOpen((v) => !v)}>
              <UserCog size={14} /> Transfer Admin Head
            </button>
          )}
          <Link href="/school/teachers" className="btn btn-secondary"><Settings size={14} /> Manage teachers</Link>
        </div>
      </div>

      {transferOpen && (
        <div className="card mt-4">
          <h3 className="font-semibold mb-2 flex items-center gap-2"><UserCog size={16} /> Transfer Admin Head role</h3>
          <p className="text-sm muted mb-3">
            Hand the school over to another teacher. They must already have a BloomIQ account.
            You&apos;ll keep your account but be demoted to a regular teacher in this school.
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              className="input flex-1 min-w-[240px]"
              type="email"
              value={transferEmail}
              onChange={(e) => setTransferEmail(e.target.value)}
              placeholder="new.head@example.com"
              disabled={transferring}
            />
            <button type="button" className="btn btn-primary" onClick={transferAdmin} disabled={transferring || !transferEmail.trim()}>
              {transferring ? <><span className="spinner" /> Transferring…</> : "Transfer"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => { setTransferOpen(false); setTransferErr(null); setTransferEmail(""); }} disabled={transferring}>
              Cancel
            </button>
          </div>
          {transferErr && (
            <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{transferErr}</div>
          )}
          {transferOk && (
            <div className="mt-3 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded-lg">{transferOk}</div>
          )}
        </div>
      )}

      {/* Renewal banner — only visible to super-teachers whose school
          plan is within the 7-day warning window or already expired. */}
      {!access.isLoading && (
        <RenewBanner
          expiresAt={access.expiresAt}
          isExpired={access.isExpired}
          isInGrace={access.isInGrace}
          graceRemainingDays={access.graceRemainingDays}
          planSlug={access.planSlug}
          source={access.source}
          schoolName={school?.name || null}
        />
      )}

      {school?.join_code && (
        <div className="card mt-4 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="text-xs muted uppercase tracking-wide font-semibold">School code</div>
            <div className="flex items-center gap-2 mt-1">
              <code className="text-2xl font-mono font-bold">{school.join_code}</code>
              <button type="button" className="btn btn-ghost p-1" onClick={copyCode} title="Copy"><Copy size={16} /></button>
              {copied && <span className="text-xs text-emerald-700">Copied</span>}
            </div>
          </div>
          <p className="text-xs muted max-w-sm">
            Share this code with your teachers. They&apos;ll enter it on their dashboard to join the school. Or invite them by email from the <Link href="/school/teachers" className="text-emerald-700 font-semibold">Teachers page</Link>.
          </p>
        </div>
      )}

      {/* Scope note. Unlike a teacher's home, an admin sees school-wide
          totals — no primary-vs-co split. Spell it out so the Head /
          Deputy isn't guessing whether co-teacher tests or other
          teachers' classes are included. */}
      <div className="mt-5 rounded-lg bg-slate-50/80 border border-slate-200 px-3 py-2 text-xs text-slate-600">
        <strong className="text-slate-800">What&apos;s in these totals:</strong>
        <ul className="mt-1 space-y-0.5 list-disc list-inside">
          <li>
            <strong>Teachers</strong> &amp; <strong>Classes</strong>: everyone who joined this school and every class created here.
          </li>
          <li>
            <strong>Tests made</strong>: every test created by any teacher in this school, regardless of who assigned it or whether it&apos;s assigned yet.
          </li>
          <li>
            <strong>Attempts</strong>: every submitted class attempt across every class in your school. Live class engagement (Host live sessions) is tracked separately and does <em>not</em> count here.
          </li>
        </ul>
        <p className="mt-1">
          The Admin Head and Deputies share this view. Only the Head can transfer the Admin Head role.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
        <Stat href="/school/teachers" label="Teachers"     value={stats?.teachers}  icon={UserRound}     color="from-emerald-500 to-emerald-600" />
        <Stat href="/school/classes"  label="Classes"      value={stats?.classes}   icon={Building2}     color="from-sky-500 to-sky-600" />
        <Stat href="/school/reports"  label="Tests made"   value={stats?.quizzes}   icon={ListChecks}    color="from-amber-500 to-amber-600" />
        <Stat href="/school/reports"  label="Attempts"     value={stats?.attempts}  icon={ClipboardList} color="from-violet-500 to-violet-600" sub={stats && stats.attempts > 0 ? `Avg ${stats.avgScore}%` : undefined} />
      </div>

      <h2 className="h2 mt-8 mb-3 flex items-center gap-2"><UserRound size={20} /> Teacher activity</h2>
      {teachers.length === 0 ? (
        <div className="card text-center py-8 muted text-sm">
          No teachers in this school yet. <Link href="/school/teachers" className="text-emerald-700 font-semibold">Invite some →</Link>
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase muted">
              <tr>
                <th className="px-4 py-3 text-left">Teacher</th>
                <th className="px-4 py-3 text-right">Classes</th>
                <th className="px-4 py-3 text-right">Tests</th>
                <th className="px-4 py-3 text-right">Assignments</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {teachers.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium">{t.full_name || "(unnamed)"}</td>
                  <td className="px-4 py-3 text-right">{t.classCount}</td>
                  <td className="px-4 py-3 text-right">{t.quizCount}</td>
                  <td className="px-4 py-3 text-right">{t.assignmentCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="h2 mt-8 mb-3 flex items-center gap-2"><Building2 size={20} /> Classes</h2>
      {classes.length === 0 ? (
        <div className="card text-center py-8 muted text-sm">No classes yet.</div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase muted">
              <tr>
                <th className="px-4 py-3 text-left">Class</th>
                <th className="px-4 py-3 text-left">Primary teacher</th>
                <th className="px-4 py-3 text-right">Students</th>
                <th className="px-4 py-3 text-right">Avg score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {classes.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium">{c.name}</td>
                  <td className="px-4 py-3">{c.primaryName || <span className="muted">—</span>}</td>
                  <td className="px-4 py-3 text-right">{c.memberCount}</td>
                  <td className="px-4 py-3 text-right">{c.avgScore !== null ? `${c.avgScore}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="muted text-xs mt-6 text-center flex items-center justify-center gap-1">
        <TrendingUp size={12} /> Detailed per-teacher and per-student reports — coming next.
      </p>
    </div>
  );
}

function Stat({
  label, value, icon: Icon, color, sub, href,
}: {
  label: string; value: number | undefined; icon: React.ComponentType<{ size?: number }>;
  color: string; sub?: string;
  /** When provided, the tile becomes a real link to a drill-down page.
   *  Without it the tile renders as plain content (no hover affordance)
   *  so users don't get tricked into clicking inert KPIs. */
  href?: string;
}) {
  const inner = (
    <>
      <div className={`w-10 h-10 rounded-lg bg-gradient-to-br ${color} text-white grid place-items-center mb-3`}>
        <Icon size={20} />
      </div>
      <div className="text-3xl font-bold">{value ?? "—"}</div>
      <div className="text-sm muted">{label}</div>
      {sub && <div className="text-xs muted mt-0.5">{sub}</div>}
    </>
  );
  if (href) {
    return (
      <Link href={href} className="card card-hover block focus:outline-none focus:ring-2 focus:ring-emerald-500 rounded-xl">
        {inner}
      </Link>
    );
  }
  return <div className="card">{inner}</div>;
}

function NavCard({
  href, title, subtitle, icon: Icon, gradient,
}: {
  href: string;
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ size?: number }>;
  gradient: string;
}) {
  return (
    <Link href={href} className="card card-hover flex items-start gap-4">
      <div className={`w-12 h-12 rounded-lg bg-gradient-to-br ${gradient} text-white grid place-items-center flex-shrink-0`}>
        <Icon size={24} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-base">{title}</div>
        <div className="text-sm muted mt-0.5">{subtitle}</div>
      </div>
    </Link>
  );
}
