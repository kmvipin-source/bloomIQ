"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { School } from "@/lib/types";
import { UserPlus, UserMinus, Copy, ArrowLeft, ShieldCheck, Shield, ArrowUpRight, ArrowDownRight } from "lucide-react";

type TeacherRow = {
  id: string;
  full_name: string | null;
  email: string | null;
  // Role within the school: 'head', 'deputy', or 'teacher'. Drives badges
  // and which actions are available on the row.
  schoolRole: "head" | "deputy" | "teacher";
  classCount: number;
  quizCount: number;
  primaryCount: number;
  coCount: number;
};

type RoleAction =
  | { type: "promote"; teacher_id: string; full_name: string }
  | { type: "demote"; teacher_id: string; full_name: string }
  | null;

const DEPUTY_CAP = 2;

export default function SchoolTeachersPage() {
  const [school, setSchool] = useState<School | null>(null);
  const [teachers, setTeachers] = useState<TeacherRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  // True when the *current viewer* is the Head (not just a Deputy). Only
  // the Head sees promote/demote-to-Deputy controls — see migration 47.
  const [callerIsHead, setCallerIsHead] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<RoleAction>(null);

  async function load() {
    setLoading(true);
    const sb = supabaseBrowser();
    // Service-role identity + school_id lookup so first paint after login
    // can't race RLS and blank the page.
    const { data: { session } } = await sb.auth.getSession();
    const token = session?.access_token;
    if (!token) { setLoading(false); return; }
    const meRes = await fetch("/api/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!meRes.ok) { setLoading(false); return; }
    const me = await meRes.json() as { uid: string; school_id: string | null };
    if (!me.school_id) { setLoading(false); return; }
    const prof = { school_id: me.school_id };
    const user = { id: me.uid };
    const { data: sch } = await sb.from("schools").select("*").eq("id", prof.school_id).single();
    setSchool(sch as School);
    setCallerIsHead((sch as School)?.super_teacher_id === user.id);

    const { data: ts } = await sb
      .from("profiles")
      .select("id, full_name, role")
      .eq("school_id", prof.school_id)
      .in("role", ["teacher", "super_teacher"]);
    type T = { id: string; full_name: string | null; role: "teacher" | "super_teacher" };
    const memberList = (ts as T[]) || [];

    const headId = (sch as School)?.super_teacher_id || null;
    const rows: TeacherRow[] = await Promise.all(
      memberList.map(async (t) => {
        const [{ count: classCt }, { count: quizCt }, { count: primaryCt }, { count: coCt }] = await Promise.all([
          sb.from("class_teachers").select("class_id", { count: "exact", head: true }).eq("teacher_id", t.id),
          sb.from("quizzes").select("id", { count: "exact", head: true }).eq("owner_id", t.id),
          sb.from("class_teachers").select("class_id", { count: "exact", head: true }).eq("teacher_id", t.id).eq("role", "primary"),
          sb.from("class_teachers").select("class_id", { count: "exact", head: true }).eq("teacher_id", t.id).eq("role", "co"),
        ]);
        const schoolRole: TeacherRow["schoolRole"] =
          t.id === headId ? "head" : t.role === "super_teacher" ? "deputy" : "teacher";
        return {
          id: t.id,
          full_name: t.full_name,
          email: null,
          schoolRole,
          classCount: classCt || 0,
          quizCount: quizCt || 0,
          primaryCount: primaryCt || 0,
          coCount: coCt || 0,
        };
      })
    );
    rows.sort((a, b) => {
      const rank = (r: TeacherRow) => (r.schoolRole === "head" ? 0 : r.schoolRole === "deputy" ? 1 : 2);
      const dr = rank(a) - rank(b);
      if (dr !== 0) return dr;
      return (b.classCount + b.quizCount) - (a.classCount + a.quizCount);
    });

    try {
      const { data: { session } } = await sb.auth.getSession();
      if (session) {
        const r = await fetch("/api/admin/school/teachers", {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (r.ok) {
          const j = await r.json();
          type EmailRow = { id: string; email: string | null };
          const emailById = new Map<string, string | null>(
            ((j.teachers as EmailRow[]) || []).map((t) => [t.id, t.email]),
          );
          for (const row of rows) row.email = emailById.get(row.id) ?? null;
        }
      }
    } catch { /* non-fatal */ }

    setTeachers(rows);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function remove(teacherId: string, name: string, schoolRole: TeacherRow["schoolRole"]) {
    if (schoolRole === "head") {
      alert("You can't remove the Admin Head. Use Transfer Admin Head from /school first.");
      return;
    }
    if (schoolRole === "deputy") {
      alert("Demote this deputy to a regular teacher first, then remove them.");
      return;
    }
    if (!confirm(`Remove ${name} from this school? Their classes and quizzes stay with them, but won't roll up to the school dashboard anymore.`)) return;
    const sb = supabaseBrowser();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;
    const res = await fetch("/api/admin/school/teachers", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ teacher_id: teacherId }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(`Could not remove: ${data.error}`);
      return;
    }
    await load();
  }

  async function runRoleAction(action: NonNullable<RoleAction>) {
    if (!callerIsHead) return;
    setActionErr(null);
    setBusyId(action.teacher_id);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const res = await fetch("/api/admin/school/deputy", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ teacher_id: action.teacher_id, action: action.type }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed");
      setConfirmAction(null);
      await load();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusyId(null);
    }
  }

  function copyCode() {
    if (!school?.join_code) return;
    navigator.clipboard.writeText(school.join_code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (loading) return <div className="grid place-items-center py-20"><div className="spinner" /></div>;

  if (!school) {
    return (
      <div className="max-w-3xl mx-auto fade-in">
        <Link href="/school" className="text-sm text-emerald-700 font-semibold inline-flex items-center gap-1"><ArrowLeft size={14} /> Back</Link>
        <div className="card mt-4 text-center py-8 muted">Set up your school first.</div>
      </div>
    );
  }

  const deputyCount = teachers.filter((t) => t.schoolRole === "deputy").length;
  const canPromoteMore = deputyCount < DEPUTY_CAP;

  return (
    <div className="max-w-4xl mx-auto fade-in">
      <Link href="/school" className="text-sm text-emerald-700 font-semibold inline-flex items-center gap-1"><ArrowLeft size={14} /> School home</Link>
      <h1 className="h1 mt-2">Teachers — {school.name}</h1>
      <p className="muted mt-1">Teachers join the school either by entering the school code below, or automatically when you assign them to a class on the <Link href="/school/classes" className="text-emerald-700 font-semibold">Classes</Link> page.</p>

      <div className="card mt-6" style={{ background: "color-mix(in oklab, var(--brand-100, #d1fae5) 30%, var(--color-card))" }}>
        <h3 className="font-semibold mb-1 flex items-center gap-2"><ShieldCheck size={16} /> Business continuity — deputies</h3>
        <p className="text-sm muted">
          Promote up to {DEPUTY_CAP} teachers to <strong>Deputy Admin Head</strong>. Deputies can do
          everything you do — manage classes, view reports, talk to BloomIQ about renewal —
          except they can&apos;t promote/demote other deputies or transfer the Head role.
          This is your insurance for unplanned leave. <strong>Currently {deputyCount} of {DEPUTY_CAP} deputies appointed.</strong>
        </p>
      </div>

      <div className="card mt-4">
        <h3 className="font-semibold mb-1 flex items-center gap-2">📱 School code</h3>
        <p className="text-xs muted mb-3">Share this with teachers — they enter it on their dashboard to join your school. They can also be added on the spot from the Classes page; their account links automatically when they sign up.</p>
        {school.join_code ? (
          <div className="flex items-center gap-2">
            <code className="text-2xl font-mono font-bold">{school.join_code}</code>
            <button className="btn btn-ghost p-1" onClick={copyCode} title="Copy"><Copy size={16} /></button>
            {copied && <span className="text-xs text-emerald-700">Copied</span>}
          </div>
        ) : (
          <p className="text-xs muted">No code yet. Visit the School Home to generate one.</p>
        )}
      </div>

      {actionErr && (
        <div className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{actionErr}</div>
      )}

      <h2 className="h2 mt-8 mb-3 flex items-center gap-2"><UserPlus size={20} /> Current teachers ({teachers.length})</h2>
      {teachers.length === 0 ? (
        <div className="card text-center py-8 muted text-sm">
          No teachers yet. Share the school code above, or assign a teacher to a class on the Classes page — they&apos;ll be pulled into the school automatically.
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase muted">
              <tr>
                <th className="px-4 py-3 text-left">Teacher</th>
                <th className="px-4 py-3 text-left">Role</th>
                <th className="px-4 py-3 text-right">Classes</th>
                <th className="px-4 py-3 text-right">Tests</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {teachers.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div className="font-medium">{t.full_name || "(unnamed)"}</div>
                    {t.email && (
                      <div className="text-xs muted mt-0.5 truncate" title={t.email}>{t.email}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {t.schoolRole === "head" && (
                        <span className="text-[10px] uppercase tracking-wide font-bold px-2 py-0.5 rounded-full inline-flex items-center gap-1" style={{ background: "#fef3c7", color: "#92400e" }}>
                          <ShieldCheck size={10} /> Admin Head
                        </span>
                      )}
                      {t.schoolRole === "deputy" && (
                        <span className="text-[10px] uppercase tracking-wide font-bold px-2 py-0.5 rounded-full inline-flex items-center gap-1" style={{ background: "#fef3c7", color: "#92400e" }}>
                          <Shield size={10} /> Deputy
                        </span>
                      )}
                      {t.primaryCount > 0 && (
                        <span className="text-[10px] uppercase tracking-wide font-bold px-2 py-0.5 rounded-full" style={{ background: "#dbeafe", color: "#1e3a8a" }}>
                          Primary{t.primaryCount > 1 ? ` ×${t.primaryCount}` : ""}
                        </span>
                      )}
                      {t.coCount > 0 && (
                        <span className="text-[10px] uppercase tracking-wide font-bold px-2 py-0.5 rounded-full" style={{ background: "#ede9fe", color: "#5b21b6" }}>
                          Co-teacher{t.coCount > 1 ? ` ×${t.coCount}` : ""}
                        </span>
                      )}
                      {t.schoolRole === "teacher" && t.primaryCount === 0 && t.coCount === 0 && (
                        <span className="text-[10px] uppercase tracking-wide font-bold px-2 py-0.5 rounded-full" style={{ background: "#fef3c7", color: "#92400e" }}>
                          Unassigned
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">{t.classCount}</td>
                  <td className="px-4 py-3 text-right">{t.quizCount}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {callerIsHead && t.schoolRole === "teacher" && (
                      <button
                        className="btn btn-ghost text-xs mr-1"
                        onClick={() => setConfirmAction({ type: "promote", teacher_id: t.id, full_name: t.full_name || "this teacher" })}
                        disabled={busyId !== null || !canPromoteMore}
                        title={canPromoteMore ? "Promote to Deputy Admin Head" : `Already at ${DEPUTY_CAP}-deputy cap`}
                      >
                        <ArrowUpRight size={14} /> Make deputy
                      </button>
                    )}
                    {callerIsHead && t.schoolRole === "deputy" && (
                      <button
                        className="btn btn-ghost text-xs mr-1"
                        onClick={() => setConfirmAction({ type: "demote", teacher_id: t.id, full_name: t.full_name || "this deputy" })}
                        disabled={busyId !== null}
                        title="Demote back to regular teacher"
                      >
                        <ArrowDownRight size={14} /> Step down
                      </button>
                    )}
                    {t.schoolRole !== "head" && (
                      <button className="btn btn-ghost text-red-600 text-xs" onClick={() => remove(t.id, t.full_name || "this teacher", t.schoolRole)}>
                        <UserMinus size={14} /> Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirmAction && (
        <div
          className="fixed inset-0 z-50 grid place-items-center p-4"
          style={{ background: "rgba(15, 23, 42, 0.55)" }}
          onClick={() => setConfirmAction(null)}
        >
          <div
            className="card max-w-md w-full"
            style={{ background: "var(--color-card)" }}
            onClick={(e) => e.stopPropagation()}
          >
            {confirmAction.type === "promote" ? (
              <>
                <h3 className="font-semibold flex items-center gap-2"><ArrowUpRight size={18} /> Promote {confirmAction.full_name} to Deputy?</h3>
                <p className="text-sm muted mt-2">
                  Deputies can manage classes, view all school reports, and talk to BloomIQ
                  about renewal. They <strong>cannot</strong> promote/demote other deputies
                  or transfer your Admin Head role.
                </p>
                <p className="text-xs muted mt-2">
                  You&apos;re using deputy slot {deputyCount + 1} of {DEPUTY_CAP}.
                </p>
              </>
            ) : (
              <>
                <h3 className="font-semibold flex items-center gap-2"><ArrowDownRight size={18} /> Demote {confirmAction.full_name} back to teacher?</h3>
                <p className="text-sm muted mt-2">
                  They&apos;ll lose access to school-wide management, but keep their classes,
                  quizzes, and the school membership. Reversible — you can promote them again later.
                </p>
              </>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <button className="btn btn-ghost" onClick={() => setConfirmAction(null)} disabled={busyId !== null}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={() => runRoleAction(confirmAction)}
                disabled={busyId !== null}
              >
                {busyId === confirmAction.teacher_id ? <span className="spinner" /> : confirmAction.type === "promote" ? "Promote" : "Demote"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
