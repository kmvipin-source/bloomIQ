"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { Class, Profile } from "@/lib/types";
import { Copy, UserMinus, Users, UserPlus, KeyRound, ShieldAlert, UserCog, X, Trash2, Upload } from "lucide-react";
import BulkAddStudents from "@/components/BulkAddStudents";

type Member = Pick<Profile, "id" | "full_name"> & {
  joined_at: string;
  username?: string | null;
  last_login_at?: string | null;
  last_login_ip?: string | null;
  recent_distinct_ips?: number;
};

type CoTeacherRow = {
  teacher_id: string | null;        // null when this row is a pending invite
  role: "primary" | "co";
  subject: string | null;
  full_name: string | null;          // for linked teachers; null for pending
  pendingEmail: string | null;       // set for pending invites
};

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function ClassDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [cls, setCls] = useState<Class | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  // Add-student form state
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [addOk, setAddOk] = useState<{ username: string; password: string } | null>(null);

  // Co-teacher state
  const [myRole, setMyRole] = useState<"primary" | "co" | null>(null);
  const [coTeachers, setCoTeachers] = useState<CoTeacherRow[]>([]);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteSubject, setInviteSubject] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteErr, setInviteErr] = useState<string | null>(null);
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);
  const [coCopied, setCoCopied] = useState<string | null>(null); // email last copied

  // Undo state for the most recent student removal. Lets the teacher restore
  // a student they just removed by mistake, in-session. Removal is non-
  // destructive on the server (deletes the class_members row only, keeps the
  // auth account), so restore just re-creates that row.
  const [lastRemoved, setLastRemoved] = useState<
    | { student: Member; previousJoinedAt: string | null }
    | null
  >(null);
  const [restoreBusy, setRestoreBusy] = useState(false);

  // Bulk-add dialog visibility. Toggle from the "Bulk add" button next to
  // "Add student". On success, we re-load the roster from the server so the
  // newly-created students show up with the rest of the class.
  const [showBulk, setShowBulk] = useState(false);

  const isPrimary = myRole === "primary";
  const router = useRouter();

  async function deleteClass() {
    if (!cls) return;
    const expected = cls.name;
    const typed = prompt(
      `This will PERMANENTLY delete the class "${cls.name}", remove all student memberships, and delete all assignments tied to it. ` +
      `Student accounts and quiz results are kept. ` +
      `\n\nType the class name exactly to confirm:`
    );
    if (typed === null) return;
    if (typed.trim() !== expected) {
      alert("Class name didn't match. Nothing was deleted.");
      return;
    }
    const sb = supabaseBrowser();
    const { error } = await sb.from("classes").delete().eq("id", cls.id);
    if (error) {
      alert(`Could not delete: ${error.message}`);
      return;
    }
    router.push("/teacher/classes");
  }

  async function load() {
    setLoading(true);
    const sb = supabaseBrowser();
    const { data: c } = await sb.from("classes").select("*").eq("id", id).single();
    setCls(c as Class);

    const { data: mem } = await sb
      .from("class_members")
      .select("joined_at, profile:profiles!class_members_student_id_fkey(id, full_name, username)")
      .eq("class_id", id)
      .order("joined_at", { ascending: true });

    type Row = { joined_at: string; profile: { id: string; full_name: string | null; username: string | null } | null };
    const rows = ((mem as unknown as Row[]) || []).filter((r) => r.profile);
    const baseMembers: Member[] = rows.map((r) => ({
      id: r.profile!.id,
      full_name: r.profile!.full_name,
      username: r.profile!.username,
      joined_at: r.joined_at,
    }));

    // Pull recent login audit (last 30 days) — used to compute last-login + a
    // simple "distinct IPs in 7 days" anomaly signal that flags shared accounts.
    const studentIds = baseMembers.map((m) => m.id);
    if (studentIds.length > 0) {
      const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
      const { data: logs } = await sb
        .from("student_logins")
        .select("user_id, ip, created_at")
        .in("user_id", studentIds)
        .gte("created_at", since)
        .order("created_at", { ascending: false });

      type LogRow = { user_id: string; ip: string | null; created_at: string };
      const byUser = new Map<string, LogRow[]>();
      ((logs as LogRow[]) || []).forEach((l) => {
        if (!byUser.has(l.user_id)) byUser.set(l.user_id, []);
        byUser.get(l.user_id)!.push(l);
      });
      const sevenDaysAgo = Date.now() - 7 * 24 * 3600_000;
      baseMembers.forEach((m) => {
        const ls = byUser.get(m.id) || [];
        m.last_login_at = ls[0]?.created_at || null;
        m.last_login_ip = ls[0]?.ip || null;
        const distinct7d = new Set(
          ls.filter((l) => new Date(l.created_at).getTime() >= sevenDaysAgo).map((l) => l.ip).filter(Boolean)
        );
        m.recent_distinct_ips = distinct7d.size;
      });
    }

    setMembers(baseMembers);

    // Load all teachers on this class (with my role for gating UI)
    const { data: { user } } = await sb.auth.getUser();
    const [{ data: cts }, { data: invites }] = await Promise.all([
      sb.from("class_teachers")
        .select("teacher_id, role, subject, profile:profiles!class_teachers_teacher_id_fkey(full_name)")
        .eq("class_id", id),
      sb.from("class_teacher_invites")
        .select("email, role, subject")
        .eq("class_id", id),
    ]);
    type CtRow = { teacher_id: string; role: "primary" | "co"; subject: string | null; profile: { full_name: string | null } | null };
    type InvRow = { email: string; role: "primary" | "co"; subject: string | null };

    const linked: CoTeacherRow[] = ((cts as unknown as CtRow[]) || []).map((c) => ({
      teacher_id: c.teacher_id,
      role: c.role,
      subject: c.subject,
      full_name: c.profile?.full_name || null,
      pendingEmail: null,
    }));
    const pending: CoTeacherRow[] = ((invites as InvRow[]) || []).map((i) => ({
      teacher_id: null,
      role: i.role,
      subject: i.subject,
      full_name: null,
      pendingEmail: i.email,
    }));
    const combined = [...linked, ...pending];
    // Sort: primary linked first, then linked co-teachers, then any pending rows.
    combined.sort((a, b) => {
      const score = (r: CoTeacherRow) =>
        r.pendingEmail ? 2 : (r.role === "primary" ? 0 : 1);
      return score(a) - score(b);
    });
    setCoTeachers(combined);
    setMyRole(user ? (linked.find((x) => x.teacher_id === user.id)?.role || null) : null);

    setLoading(false);
  }

  async function inviteCoTeacher() {
    setInviteErr(null);
    setInviteStatus(null);
    if (!inviteEmail.trim()) return setInviteErr("Enter the teacher's email.");
    setInviteBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const res = await fetch(`/api/admin/classes/${id}/co-teachers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ email: inviteEmail.trim().toLowerCase(), subject: inviteSubject.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Invite failed");
      if (data.status === "linked") setInviteStatus("✅ Linked — they’re now a co-teacher of this class.");
      else if (data.status === "pending") setInviteStatus("⏳ No account yet for that email. The class will appear on their dashboard the moment they sign up. Use “Copy invite” on their row to share the message.");
      setInviteEmail(""); setInviteSubject("");
      setShowInvite(false);
      await load();
    } catch (e) {
      setInviteErr(e instanceof Error ? e.message : "Invite failed");
    } finally {
      setInviteBusy(false);
    }
  }

  async function makePrimary(teacherId: string, displayName: string) {
    if (!confirm(
      `Make ${displayName} the primary teacher of this class?\n\n` +
      `You will become a co-teacher. The new primary will own the roster ` +
      `and be able to invite or remove other co-teachers.`
    )) return;
    const sb = supabaseBrowser();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;
    const res = await fetch(`/api/admin/classes/${id}/primary`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ teacher_id: teacherId }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(`Could not promote: ${data.error || "unknown error"}`);
      return;
    }
    await load();
  }

  function copyCoInvite(email: string) {
    if (!cls) return;
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const msg =
      `Hi! I’ve added you as a co-teacher of ${cls.name} on BloomIQ. ` +
      `Sign up at ${origin}/signup using this email (${email}) and pick the Teacher role. ` +
      `The class will appear on your dashboard the moment you sign in.`;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(msg).catch(() => {});
    }
    setCoCopied(email);
    setTimeout(() => setCoCopied(null), 1800);
  }

  async function removePendingInvite(email: string) {
    if (!confirm(`Cancel the pending invite for ${email}?`)) return;
    const sb = supabaseBrowser();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;
    const res = await fetch(`/api/admin/classes/${id}/co-teachers`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(`Could not cancel: ${data.error || "unknown error"}`);
      return;
    }
    await load();
  }

  async function removeCoTeacher(teacherId: string, name: string) {
    if (!confirm(`Remove ${name} as co-teacher? They'll lose access to this class.`)) return;
    const sb = supabaseBrowser();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;
    const res = await fetch(`/api/admin/classes/${id}/co-teachers`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ teacher_id: teacherId }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(`Could not remove: ${data.error || "unknown error"}`);
      return;
    }
    await load();
  }

  async function resetPassword(studentId: string, name: string) {
    const newPass = prompt(`New password for ${name}? (min 6 chars). The student's current sessions will be signed out.`);
    if (!newPass) return;
    if (newPass.length < 6) {
      alert("Password must be at least 6 characters.");
      return;
    }
    const sb = supabaseBrowser();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;
    const res = await fetch(`/api/admin/students/${studentId}/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ password: newPass }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(`Could not reset: ${data.error || "unknown error"}`);
      return;
    }
    alert(`Password updated. New password for ${name}: ${newPass}\n\nShare it with them — it won't be shown again.`);
  }

  function suggestPassword() {
    // Memorable-ish: word + 3 digits. Teachers can edit before submitting.
    const words = ["sun", "moon", "river", "tiger", "lion", "fox", "ant", "owl", "lake", "wind"];
    const w = words[Math.floor(Math.random() * words.length)];
    return `${w}${Math.floor(100 + Math.random() * 900)}`;
  }

  function suggestUsername(name: string) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
    const rnd = Math.floor(10 + Math.random() * 90);
    return base ? `${base}.${rnd}` : `student.${Date.now().toString(36).slice(-5)}`;
  }

  type DupMatch = {
    id: string;
    full_name: string | null;
    username: string | null;
    classes: { id: string; name: string; grade: string | null; section: string | null }[];
    confidence: "certain" | "high" | "medium" | "low";
  };
  const [dupMatches, setDupMatches] = useState<DupMatch[] | null>(null);

  async function submitAddStudent(force: boolean) {
    setAddErr(null); setAddOk(null); setDupMatches(null);
    if (!newName.trim()) return setAddErr("Enter a student name.");
    if (!newUsername.trim()) return setAddErr("Pick a username.");
    if (newPassword.length < 6) return setAddErr("Password must be at least 6 characters.");

    setAddBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in");

      const res = await fetch("/api/admin/students", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          class_id: id,
          full_name: newName.trim(),
          username: newUsername.trim(),
          password: newPassword,
          force,
        }),
      });
      const data = await res.json();
      if (res.status === 409 && data.error === "duplicate_name" && Array.isArray(data.matches)) {
        setDupMatches(data.matches as DupMatch[]);
        return;
      }
      if (!res.ok) throw new Error(data.error || "Failed to add student");

      setAddOk({ username: newUsername.trim(), password: newPassword });
      setNewName(""); setNewUsername(""); setNewPassword("");
      await load();
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : "Failed to add student");
    } finally {
      setAddBusy(false);
    }
  }
  function addStudent() { return submitAddStudent(false); }

  async function reuseExisting(studentId: string) {
    setAddErr(null);
    setAddBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const res = await fetch("/api/admin/students/add-existing", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ class_id: id, student_id: studentId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to add existing student");
      setDupMatches(null);
      setNewName(""); setNewUsername(""); setNewPassword("");
      setShowAdd(false);
      await load();
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setAddBusy(false);
    }
  }
  useEffect(() => { if (id) load(); }, [id]);

  async function copyCode() {
    if (!cls) return;
    await navigator.clipboard.writeText(cls.join_code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function removeMember(studentId: string) {
    if (!cls) return;
    if (!confirm("Remove this student from the class? Their account, password, and quiz history are kept. You can undo right after, or have your school admin re-add them later.")) return;
    const sb = supabaseBrowser();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { alert("Your session expired. Please sign in again."); return; }

    // Capture the row from current state BEFORE we strip it - we need
    // full_name + username for the Undo banner and for restore.
    const removed = members.find((m) => m.id === studentId) || null;

    try {
      const res = await fetch(`/api/admin/students/${studentId}/remove-from-class`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ class_id: cls.id }),
      });
      let j: { error?: string; previousJoinedAt?: string | null } = {};
      let raw = "";
      try { raw = await res.text(); j = raw ? JSON.parse(raw) : {}; } catch {}
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}: ${raw.slice(0, 200)}`);
      setMembers((m) => m.filter((x) => x.id !== studentId));
      if (removed) {
        setLastRemoved({ student: removed, previousJoinedAt: j.previousJoinedAt ?? removed.joined_at ?? null });
      }
    } catch (e) {
      alert(`Could not remove: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }

  async function restoreLastRemoved() {
    if (!cls || !lastRemoved || restoreBusy) return;
    setRestoreBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired. Please sign in again.");
      const res = await fetch(`/api/admin/students/${lastRemoved.student.id}/restore-to-class`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          class_id: cls.id,
          joined_at: lastRemoved.previousJoinedAt,
        }),
      });
      let j: { error?: string } = {};
      let raw = "";
      try { raw = await res.text(); j = raw ? JSON.parse(raw) : {}; } catch {}
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}: ${raw.slice(0, 200)}`);
      // Put the student back into the local roster. We use the captured Member
      // object so visible details (last login, IP, etc.) survive the round-trip.
      setMembers((m) => {
        if (m.some((x) => x.id === lastRemoved.student.id)) return m;
        return [...m, lastRemoved.student].sort((a, b) =>
          new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime()
        );
      });
      setLastRemoved(null);
    } catch (e) {
      alert(`Could not restore: ${e instanceof Error ? e.message : "unknown error"}`);
    } finally {
      setRestoreBusy(false);
    }
  }

  function dismissUndo() {
    setLastRemoved(null);
  }

  if (loading || !cls) return <div className="grid place-items-center py-20"><div className="spinner" /></div>;

  return (
    <div className="max-w-4xl mx-auto fade-in">
      <Link href="/teacher/classes" className="text-sm text-emerald-700 font-semibold">← All classes</Link>
      <h1 className="h1 mt-2">{cls.name}</h1>
      {cls.grade && <p className="muted mt-1">Grade {cls.grade}</p>}

      {/* Bulk-add roster dialog - paste names, preview, commit. Owns its
          own multi-stage state; we just refresh the roster on success. */}
      {showBulk && cls && (
        <BulkAddStudents
          classId={cls.id}
          className={cls.name}
          onClose={() => setShowBulk(false)}
          onCreated={() => { void load(); }}
        />
      )}

      {/* Undo banner - appears right after a removal so a misclick is one
          click away from being reversed. Persists until restored or dismissed. */}
      {lastRemoved && (
        <div className="mt-4 flex items-center justify-between gap-3 flex-wrap rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <div className="text-sm text-amber-900">
            Removed <strong>{lastRemoved.student.full_name || lastRemoved.student.username || "student"}</strong> from this class.
            Their account and quiz history are kept.
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn btn-primary"
              onClick={restoreLastRemoved}
              disabled={restoreBusy}
            >
              {restoreBusy ? <span className="spinner" /> : "Undo"}
            </button>
            <button className="btn btn-ghost" onClick={dismissUndo} disabled={restoreBusy}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-4 mt-6">
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Join code</div>
          <div className="flex items-center gap-2 mt-2">
            <code className="text-2xl font-mono font-bold">{cls.join_code}</code>
            <button className="btn btn-ghost" onClick={copyCode} title="Copy">
              <Copy size={16} />
            </button>
            {copied && <span className="text-xs text-emerald-700">Copied</span>}
          </div>
          <div className="text-xs muted mt-2">
            Students go to <strong>Join a class</strong> on their dashboard and enter this code.
          </div>
        </div>
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Members</div>
          <div className="text-3xl font-bold mt-2">{members.length}</div>
          <div className="text-sm muted">student{members.length === 1 ? "" : "s"} in this class</div>
        </div>
      </div>

      {/* ========== Co-teachers ========== */}
      <div className="flex items-center justify-between mt-8 mb-3 gap-3 flex-wrap">
        <h2 className="h2 flex items-center gap-2 flex-wrap">
          <UserCog size={20} /> Teachers on this class
          {coTeachers.filter((t) => t.pendingEmail).length > 0 && (
            <span className="text-[11px] uppercase tracking-wide font-bold text-sky-800 bg-sky-50 border border-sky-200 rounded-full px-2 py-0.5">
              ⏳ {coTeachers.filter((t) => t.pendingEmail).length} pending
            </span>
          )}
        </h2>
        {isPrimary && (
          <button className="btn btn-secondary" onClick={() => { setShowInvite((v) => !v); setInviteErr(null); }}>
            <UserPlus size={16} /> Invite co-teacher
          </button>
        )}
      </div>

      {coTeachers.filter((t) => t.pendingEmail).length > 0 && (
        <div className="mb-3 text-xs text-sky-900 bg-sky-50 border border-sky-200 px-3 py-2 rounded-lg">
          You have {coTeachers.filter((t) => t.pendingEmail).length} co-teacher invite{coTeachers.filter((t) => t.pendingEmail).length === 1 ? "" : "s"} waiting for sign-up. Use “Copy invite” on each row to share the link — they’ll auto-link to this class the moment they create their account.
        </div>
      )}

      {inviteStatus && (
        <div className="mt-2 mb-4 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded-lg">
          {inviteStatus}
        </div>
      )}

      {showInvite && isPrimary && (
        <div className="card mb-4">
          <p className="text-sm muted mb-3">
            Co-teachers can assign their own quizzes to this class and see results for those quizzes.
            They can&apos;t add or remove students. If the teacher already has a BloomIQ account, they&apos;re linked instantly; otherwise we save a pending invite that auto-claims the class when they sign up.
          </p>
          <div className="grid sm:grid-cols-[1fr_180px_auto] gap-3 items-end">
            <div>
              <label className="label">Teacher email</label>
              <input className="input" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="teacher@school.edu" />
            </div>
            <div>
              <label className="label">Subject <span className="muted text-xs">(optional)</span></label>
              <input className="input" value={inviteSubject} onChange={(e) => setInviteSubject(e.target.value)} placeholder="e.g. Science" />
            </div>
            <button className="btn btn-primary" onClick={inviteCoTeacher} disabled={inviteBusy}>
              {inviteBusy ? <><span className="spinner" /> Inviting…</> : "Invite"}
            </button>
          </div>
          {inviteErr && <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{inviteErr}</div>}
        </div>
      )}

      <div className="card mb-6 p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-100">
            {coTeachers.map((t, i) => {
              const key = t.teacher_id || `pending-${t.pendingEmail}-${i}`;
              const isPending = !!t.pendingEmail;
              return (
                <tr key={key} className={isPending ? "bg-sky-50/40 hover:bg-sky-50" : "hover:bg-slate-50"}>
                  <td className="px-4 py-3 font-medium">
                    {t.full_name || (isPending ? <span className="italic text-slate-700">{t.pendingEmail}</span> : "(unnamed teacher)")}
                  </td>
                  <td className="px-4 py-3">
                    {isPending ? (
                      <span className="text-[10px] uppercase tracking-wide font-bold text-sky-800 bg-sky-50 border border-sky-200 rounded-full px-2 py-0.5">
                        ⏳ Pending {t.role === "primary" ? "primary" : `co-teacher${t.subject ? ` · ${t.subject}` : ""}`}
                      </span>
                    ) : t.role === "primary" ? (
                      <span className="text-[10px] uppercase tracking-wide font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
                        Primary
                      </span>
                    ) : (
                      <span className="text-[10px] uppercase tracking-wide font-bold text-sky-700 bg-sky-50 border border-sky-200 rounded-full px-2 py-0.5">
                        Co-teacher{t.subject ? ` · ${t.subject}` : ""}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {isPending && t.pendingEmail && (
                      <>
                        <button
                          className="btn btn-ghost text-xs mr-1"
                          onClick={() => copyCoInvite(t.pendingEmail!)}
                          title="Copy invite message"
                        >
                          {coCopied === t.pendingEmail ? "Copied" : "Copy invite"}
                        </button>
                        {isPrimary && (
                          <button
                            className="btn btn-ghost text-red-600 text-xs"
                            onClick={() => removePendingInvite(t.pendingEmail!)}
                            title="Cancel invite"
                          >
                            Cancel
                          </button>
                        )}
                      </>
                    )}
                    {!isPending && isPrimary && t.role === "co" && t.teacher_id && (
                      <>
                        <button
                          className="btn btn-ghost text-xs mr-1"
                          onClick={() => makePrimary(t.teacher_id!, t.full_name || "this teacher")}
                          title="Promote to primary teacher (you become co-teacher)"
                        >
                          Make primary
                        </button>
                        <button
                          className="btn btn-ghost text-red-600 text-xs"
                          onClick={() => removeCoTeacher(t.teacher_id!, t.full_name || "this teacher")}
                          title="Remove from class"
                        >
                          <X size={14} /> Remove
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ========== Students ========== */}
      <div className="flex items-center justify-between mt-8 mb-3">
        <h2 className="h2 flex items-center gap-2"><Users size={20} /> Students</h2>
        {isPrimary ? (
          <div className="flex gap-2">
            <button
              className="btn btn-secondary"
              onClick={() => setShowBulk(true)}
              title="Paste a list of student names and create them in one go"
            >
              <Upload size={16} /> Bulk add
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                setShowAdd((v) => !v);
                setAddErr(null); setAddOk(null);
                if (!showAdd) {
                  setNewUsername(suggestUsername(newName));
                  setNewPassword(suggestPassword());
                }
              }}
            >
              <UserPlus size={16} /> Add student
            </button>
          </div>
        ) : (
          <span className="text-xs muted inline-flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-slate-300" />
            Co-teacher view — only the primary teacher can add or remove students
          </span>
        )}
      </div>

      {showAdd && isPrimary && (
        <div className="card mb-4">
          <p className="text-sm muted mb-3">
            Create a username + password for a student who doesn&apos;t have email. Share the credentials with them — they sign in
            on the <strong>Student login</strong> tab.
          </p>
          <div className="grid sm:grid-cols-3 gap-3">
            <div>
              <label className="label">Full name</label>
              <input
                className="input"
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value);
                  if (!newUsername) setNewUsername(suggestUsername(e.target.value));
                }}
                placeholder="e.g. Priya Sharma"
              />
            </div>
            <div>
              <label className="label">Username</label>
              <div className="flex gap-2">
                <input
                  className="input"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value.toLowerCase())}
                  placeholder="priya.s.9b"
                />
                <button type="button" className="btn btn-ghost" onClick={() => setNewUsername(suggestUsername(newName))} title="Suggest">↻</button>
              </div>
            </div>
            <div>
              <label className="label">Password</label>
              <div className="flex gap-2">
                <input
                  className="input"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="At least 6 chars"
                />
                <button type="button" className="btn btn-ghost" onClick={() => setNewPassword(suggestPassword())} title="Suggest">↻</button>
              </div>
            </div>
          </div>
          {addErr && <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{addErr}</div>}
          {addOk && (
            <div className="mt-3 text-sm text-emerald-900 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded-lg">
              Student account created. Share these with the student now — the password won&apos;t be shown again:
              <div className="mt-1 font-mono text-xs">
                Username: <strong>{addOk.username}</strong> · Password: <strong>{addOk.password}</strong>
              </div>
            </div>
          )}
          {dupMatches && dupMatches.length > 0 && (
            <div className="mt-3 text-sm bg-amber-50 border-2 border-amber-300 rounded-lg p-4">
              <div className="font-bold text-amber-900 mb-1 text-base">
                ⚠ Wait — is this the same student?
              </div>
              <div className="text-xs text-amber-900/85 mb-3">
                You typed <strong>&ldquo;{newName}&rdquo;</strong>. {dupMatches.length === 1
                  ? "An account with a similar name already exists in your school:"
                  : `${dupMatches.length} accounts with similar names already exist in your school:`}
              </div>

              <div className="space-y-3">
                {dupMatches.map((m) => {
                  const otherClasses = m.classes.filter((c) => c.id !== id);
                  const inThisClass = m.classes.some((c) => c.id === id);
                  const guidance =
                    m.confidence === "certain" ? { tone: "red",     text: "Already in this class. Don't create a duplicate." } :
                    m.confidence === "high"    ? { tone: "amber",   text: "You teach the class they're in. Likely the same student — reuse this account so their progress stays connected." } :
                    m.confidence === "medium"  ? { tone: "amber",   text: "They're in a class you co-teach. Probably the same student — confirm with the primary teacher if unsure." } :
                                                  { tone: "slate",  text: "They're in another teacher's class. Likely a different person who just shares a name — but verify before creating new." };
                  const toneCls = {
                    red:    "bg-red-50 border-red-200 text-red-900",
                    amber:  "bg-amber-100 border-amber-300 text-amber-900",
                    slate:  "bg-slate-50 border-slate-200 text-slate-700",
                  }[guidance.tone];

                  return (
                    <div key={m.id} className="bg-white border border-amber-200 rounded-lg p-3">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="min-w-0">
                          <div className="font-bold text-slate-900">{m.full_name || "(unnamed)"}</div>
                          {m.username && (
                            <div className="text-xs muted mt-0.5">
                              Username <code className="text-[10px] px-1 py-0.5 bg-slate-100 rounded font-mono">{m.username}</code>
                            </div>
                          )}
                        </div>
                        <button
                          className="btn btn-primary text-xs whitespace-nowrap"
                          onClick={() => reuseExisting(m.id)}
                          disabled={addBusy || inThisClass}
                          title={inThisClass ? "Already in this class" : "Reuse this account"}
                        >
                          {inThisClass ? "Already here" : "Yes — add this student"}
                        </button>
                      </div>

                      {/* Class context — the headline information */}
                      <div className="mt-2 text-xs">
                        <div className="muted mb-1">Currently in:</div>
                        <div className="flex flex-wrap gap-1.5">
                          {m.classes.length === 0 && <span className="muted italic">no classes</span>}
                          {m.classes.map((c) => (
                            <span
                              key={c.id}
                              className={`px-2 py-0.5 rounded-full font-medium border ${
                                c.id === id
                                  ? "bg-emerald-100 text-emerald-900 border-emerald-300"
                                  : "bg-slate-100 text-slate-700 border-slate-200"
                              }`}
                            >
                              {c.name}{c.id === id ? " (this class)" : ""}
                            </span>
                          ))}
                        </div>
                      </div>

                      {/* Confidence-based guidance */}
                      <div className={`mt-2 px-2 py-1.5 rounded text-xs border ${toneCls}`}>
                        {guidance.text}
                      </div>
                      {!inThisClass && otherClasses.length === 0 && (
                        <div className="mt-1 text-[11px] muted">No class memberships — possibly a stale account.</div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="mt-4 flex flex-wrap justify-end gap-2 pt-3 border-t border-amber-200">
                <button className="btn btn-ghost text-xs" onClick={() => setDupMatches(null)} disabled={addBusy}>
                  ← Back to form
                </button>
                <button
                  className="btn btn-secondary text-xs"
                  onClick={() => submitAddStudent(true)}
                  disabled={addBusy}
                >
                  None of these — different person, create new
                </button>
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2 mt-4">
            <button className="btn btn-ghost" onClick={() => setShowAdd(false)}>Close</button>
            <button className="btn btn-primary" onClick={addStudent} disabled={addBusy}>
              {addBusy ? <><span className="spinner" /> Creating…</> : "Create account"}
            </button>
          </div>
        </div>
      )}
      {members.length === 0 ? (
        <div className="card text-center py-12 muted">
          No students yet. Share the code <code className="px-2 py-1 bg-slate-100 rounded">{cls.join_code}</code> so they can join.
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase muted">
              <tr>
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left">Username</th>
                <th className="px-4 py-3 text-left">Last login</th>
                <th className="px-4 py-3 text-left">Last login</th>
                <th className="px-4 py-3 text-left">Activity</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {members.map((m) => {
                const suspicious = (m.recent_distinct_ips || 0) >= 3;
                return (
                  <tr key={m.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium">{m.full_name || "Unknown student"}</td>
                    <td className="px-4 py-3">
                      {m.username
                        ? <code className="text-xs px-2 py-0.5 bg-slate-100 rounded">{m.username}</code>
                        : <span className="text-xs muted">— (email)</span>}
                    </td>
                    <td className="px-4 py-3 muted">
                      <div>{timeAgo(m.last_login_at)}</div>
                      {m.last_login_ip && <div className="text-xs">from {m.last_login_ip}</div>}
                    </td>
                    <td className="px-4 py-3">
                      {suspicious ? (
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full" title="Possibly a shared account">
                          <ShieldAlert size={12} /> {m.recent_distinct_ips} IPs / 7d
                        </span>
                      ) : (
                        <span className="text-xs muted">{m.recent_distinct_ips || 0} IPs / 7d</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {isPrimary && m.username && (
                        <button
                          className="btn btn-ghost"
                          onClick={() => resetPassword(m.id, m.full_name || m.username!)}
                          title="Reset password (signs them out everywhere)"
                        >
                          <KeyRound size={14} /> Reset
                        </button>
                      )}
                      {isPrimary && (
                        <button
                          className="btn btn-ghost text-red-600"
                          onClick={() => removeMember(m.id)}
                          title="Remove from class"
                        >
                          <UserMinus size={14} /> Remove
                        </button>
                      )}
                      {!isPrimary && <span className="text-xs muted">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ========== Danger zone (primary only) ========== */}
      {isPrimary && (
        <div className="mt-12 border border-red-200 rounded-xl p-4 bg-red-50/40">
          <h3 className="font-semibold text-red-800 mb-1">Danger zone</h3>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="text-sm text-red-900/80">
              Delete this class permanently. Student accounts and quiz results are kept; only this class, its memberships and assignments are removed.
            </div>
            <button className="btn btn-danger" onClick={deleteClass}>
              <Trash2 size={14} /> Delete class
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
