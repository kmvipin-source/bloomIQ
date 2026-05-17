"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  Users, Search, Pencil, Trash2, ShieldAlert, ShieldCheck, Building2,
  GraduationCap, UserRound, AlertCircle, Save, X, ArrowLeft,
} from "lucide-react";

/**
 * /admin/users
 *
 * Platform-admin user management. Lists every account on the platform
 * with edit + delete actions. Pulls data from /api/admin/users (service
 * role); mutations go through PATCH/DELETE /api/admin/users/[id].
 *
 * Edit form supports renaming, role changes (student / teacher /
 * super_teacher / platform_admin), the is_school_student flag, and
 * the platform_admin flag. Delete is a hard delete (auth.users +
 * profiles + cascades).
 */

type SubRole =
  | "individual_student"
  | "school_student"
  | "primary_teacher"
  | "co_teacher"
  | "unassigned_teacher";

type User = {
  id: string;
  full_name: string | null;
  email: string | null;
  role: "student" | "teacher" | null;
  is_school_student: boolean;
  is_test_account: boolean;
  sub_role: SubRole;
  school_id: string | null;
  school_name: string | null;
  created_at: string | null;
  // Finding #26 fix: platform_admin is read at filter time (F175) but was
  // missing from the type. TS strict caught the property access.
  platform_admin: boolean;
};

// F175 note (QA): "platform_admin" is a flag on profiles, not a
// sub_role. We expose it here as a synthetic RoleFilter value so the
// chip list can include a one-click "show admins only" filter.
type RoleFilter = "all" | SubRole | "all_teachers" | "platform_admins";

const SUB_ROLE_LABEL: Record<SubRole, string> = {
  individual_student: "Individual Student",
  school_student: "School Student",
  primary_teacher: "Primary Teacher",
  co_teacher: "Co-Teacher",
  unassigned_teacher: "Teacher",
};

const SUB_ROLE_TONE: Record<SubRole, string> = {
  individual_student: "bg-sky-50 text-sky-800 border-sky-200",
  school_student: "bg-indigo-50 text-indigo-800 border-indigo-200",
  primary_teacher: "bg-emerald-50 text-emerald-800 border-emerald-200",
  co_teacher: "bg-violet-50 text-violet-800 border-violet-200",
  unassigned_teacher: "bg-slate-50 text-slate-700 border-slate-200",
};

export default function AdminUsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");

  const [editing, setEditing] = useState<User | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftRole, setDraftRole] = useState<NonNullable<User["role"]>>("student");
  const [draftSchoolStudent, setDraftSchoolStudent] = useState(false);
  const [draftTestAccount, setDraftTestAccount] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const r = await fetch("/api/admin/users", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setUsers((j.users as User[]) || []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  function openEdit(u: User) {
    setEditing(u);
    setDraftName(u.full_name || "");
    setDraftRole((u.role || "student") as NonNullable<User["role"]>);
    setDraftSchoolStudent(u.is_school_student);
    setDraftTestAccount(u.is_test_account);
    setActionErr(null);
    setActionOk(null);
  }
  function closeEdit() {
    setEditing(null);
    setActionErr(null);
  }

  async function saveEdit() {
    if (!editing) return;
    setSaving(true);
    setActionErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      // Only patch fields the operator actually changed. Sending
      // `role` unconditionally meant a user whose existing role was
      // null (rare but real) silently became 'student' the moment
      // the admin saved any other field — the dropdown defaulted to
      // 'student' for null-role users.
      const patch: Record<string, unknown> = {
        full_name: draftName,
        is_school_student: draftSchoolStudent,
        is_test_account: draftTestAccount,
      };
      if (draftRole !== editing.role) patch.role = draftRole;
      const r = await fetch(`/api/admin/users/${editing.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(patch),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setActionOk(`Updated ${editing.full_name || editing.email}.`);
      setEditing(null);
      await load();
      setTimeout(() => setActionOk(null), 2500);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteUser(u: User) {
    const label = u.full_name || u.email || u.id.slice(0, 8);
    if (!confirm(
      `Permanently delete ${label}?\n\n` +
      `This wipes their auth account, profile, and all cascading data ` +
      `(class memberships, attempts, owned quizzes). This cannot be undone.`,
    )) return;
    setDeletingId(u.id);
    setActionErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const r = await fetch(`/api/admin/users/${u.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setActionOk(`Deleted ${label}.`);
      await load();
      setTimeout(() => setActionOk(null), 2500);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setDeletingId(null);
    }
  }

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return users.filter((u) => {
      if (roleFilter === "all_teachers") {
        if (u.role !== "teacher") return false;
      } else if (roleFilter === "platform_admins") {
        // F175 fix (QA): synthetic filter — platform_admin is on profiles,
        // not in sub_role, so it needs its own branch.
        if (!u.platform_admin) return false;
      } else if (roleFilter !== "all") {
        if (u.sub_role !== roleFilter) return false;
      }
      if (!needle) return true;
      const hay = `${u.full_name || ""} ${u.email || ""} ${u.school_name || ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [users, search, roleFilter]);

  const counts = useMemo(() => {
    const c = {
      all: users.length,
      individual_student: 0,
      school_student: 0,
      all_teachers: 0,
      primary_teacher: 0,
      co_teacher: 0,
    };
    for (const u of users) {
      if (u.sub_role === "individual_student") c.individual_student++;
      else if (u.sub_role === "school_student") c.school_student++;
      if (u.role === "teacher") c.all_teachers++;
      if (u.sub_role === "primary_teacher") c.primary_teacher++;
      if (u.sub_role === "co_teacher") c.co_teacher++;
    }
    return c;
  }, [users]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/dashboard" className="text-sm text-emerald-700 font-semibold inline-flex items-center gap-1 mb-2">
          <ArrowLeft size={14} /> Platform dashboard
        </Link>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Users size={26} /> User management</h1>
        <p className="text-sm muted mt-1">
          Edit or delete any account on the platform. Role changes apply immediately and may
          orphan downstream relationships (class assignments, school admin headship) — review
          consequences before saving.
        </p>
      </div>

      {actionOk && (
        <div className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded-lg inline-flex items-center gap-2">
          <ShieldCheck size={14} /> {actionOk}
        </div>
      )}
      {actionErr && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg inline-flex items-center gap-2">
          <AlertCircle size={14} /> {actionErr}
        </div>
      )}

      {/* Filter chips + search */}
      <div className="card flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className="input pl-9"
            placeholder="Search by name, email, or school…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {([
            ["all", `All (${counts.all})`],
            ["individual_student", `Individual Students (${counts.individual_student})`],
            ["school_student", `School Students (${counts.school_student})`],
            ["all_teachers", `Teachers (${counts.all_teachers})`],
            ["primary_teacher", `Primary (${counts.primary_teacher})`],
            ["co_teacher", `Co-Teachers (${counts.co_teacher})`],
            // F175 fix (QA): show-admins chip — convenience for ops.
            ["platform_admins", `Platform Admins (${users.filter((u) => u.platform_admin).length})`],
          ] as Array<[RoleFilter, string]>).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition ${
                roleFilter === key
                  ? "bg-emerald-600 text-white border-emerald-600"
                  : "bg-white text-slate-700 border-slate-200 hover:border-emerald-500"
              }`}
              onClick={() => setRoleFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Users table */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="card animate-pulse flex items-center gap-3">
              <div className="h-9 w-9 rounded-full bg-slate-200" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-48 rounded bg-slate-200" />
                <div className="h-3 w-32 rounded bg-slate-100" />
              </div>
              <div className="h-6 w-16 rounded bg-slate-100" />
            </div>
          ))}
        </div>
      ) : err ? (
        <div className="card border-red-200 bg-red-50">
          <div className="font-bold text-red-700 inline-flex items-center gap-2">
            <ShieldAlert size={16} /> Could not load users
          </div>
          <div className="text-sm text-red-700 mt-1">{err}</div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card text-center py-12 muted">No users match these filters.</div>
      ) : (
        <div className="card p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase muted">
              <tr>
                <th className="px-4 py-3 text-left">User</th>
                <th className="px-4 py-3 text-left">Role</th>
                <th className="px-4 py-3 text-left">School</th>
                <th className="px-4 py-3 text-left">Created</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((u) => (
                <tr key={u.id} className="hover:bg-slate-50 align-top">
                  <td className="px-4 py-3">
                    <div className="font-medium">{u.full_name || <span className="muted italic">(no name)</span>}</div>
                    <div className="text-xs muted truncate max-w-[260px]">{u.email || u.id}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <span className={`inline-block text-[10px] uppercase tracking-wide font-bold rounded-full px-2 py-0.5 border ${SUB_ROLE_TONE[u.sub_role]}`}>
                        {SUB_ROLE_LABEL[u.sub_role]}
                      </span>
                      {u.is_test_account && (
                        <span className="inline-block text-[10px] uppercase tracking-wide font-bold rounded-full px-2 py-0.5 border bg-amber-50 text-amber-800 border-amber-200">
                          🧪 Beta Tester
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {u.school_name ? (
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        <Building2 size={12} className="text-slate-400" /> {u.school_name}
                      </span>
                    ) : (
                      <span className="muted text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs muted">
                    {u.created_at ? new Date(u.created_at).toLocaleDateString("en-IN") : "—"}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button type="button"
                      className="btn btn-ghost text-xs inline-flex items-center gap-1"
                      onClick={() => openEdit(u)}
                    >
                      <Pencil size={12} /> Edit
                    </button>
                    <button type="button"
                      className="btn btn-ghost text-xs text-red-600 inline-flex items-center gap-1 ml-1"
                      onClick={() => deleteUser(u)}
                      disabled={deletingId === u.id}
                    >
                      {deletingId === u.id ? <span className="spinner" /> : <Trash2 size={12} />} Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit modal */}
      {editing && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 backdrop-blur-sm px-4">
          <div className="w-full max-w-md card bg-white">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-bold inline-flex items-center gap-2">
                <UserRound size={18} /> Edit user
              </h2>
              <button type="button" className="btn btn-ghost p-1" onClick={closeEdit}><X size={16} /></button>
            </div>
            <p className="text-xs muted mb-4">{editing.email || editing.id}</p>

            <div className="space-y-3">
              <div>
                <label className="label">Full name</label>
                <input
                  className="input"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder="(no name)"
                />
              </div>
              <div>
                <label className="label">Role</label>
                <select
                  className="input"
                  value={draftRole}
                  onChange={(e) => setDraftRole(e.target.value as NonNullable<User["role"]>)}
                >
                  <option value="student">Student</option>
                  <option value="teacher">Teacher</option>
                </select>
                <p className="text-xs muted mt-1">
                  Switching between Student and Teacher can orphan class memberships
                  or class assignments. Verify before saving. School admins and
                  platform admins are managed elsewhere.
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draftSchoolStudent}
                  onChange={(e) => setDraftSchoolStudent(e.target.checked)}
                />
                <span>School-managed student (sets <code className="text-xs">is_school_student</code>)</span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draftTestAccount}
                  onChange={(e) => setDraftTestAccount(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Beta tester (sets <code className="text-xs">is_test_account</code>) — this account&apos;s
                  activity is excluded from platform dashboards / revenue / top-students rollups.
                  Use for the QA cohort hitting prod.
                </span>
              </label>
            </div>

            {actionErr && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg mt-3">
                {actionErr}
              </div>
            )}

            <div className="flex gap-2 mt-5">
              <button type="button" className="btn btn-secondary flex-1" onClick={closeEdit} disabled={saving}>
                Cancel
              </button>
              <button type="button"
                className="btn btn-primary flex-1 inline-flex items-center justify-center gap-1.5"
                onClick={saveEdit}
                disabled={saving}
              >
                {saving ? <><span className="spinner" /> Saving…</> : <><Save size={14} /> Save</>}
              </button>
            </div>
          </div>
        </div>
      )}

      <p className="text-xs muted text-center">
        <GraduationCap size={12} className="inline mr-1" />
        For plan-level CRUD, use{" "}
        <Link href="/admin/plans" className="underline">/admin/plans</Link>
        {" "}(proposal queue gates price changes).
      </p>
    </div>
  );
}
