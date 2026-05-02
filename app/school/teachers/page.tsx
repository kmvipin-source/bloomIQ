"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { School } from "@/lib/types";
import { UserPlus, UserMinus, Copy, ArrowLeft } from "lucide-react";

type TeacherRow = {
  id: string;
  full_name: string | null;
  email: string | null;
  classCount: number;
  quizCount: number;
  primaryCount: number;
  coCount: number;
};

export default function SchoolTeachersPage() {
  const [school, setSchool] = useState<School | null>(null);
  const [teachers, setTeachers] = useState<TeacherRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  async function load() {
    setLoading(true);
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;

    const { data: prof } = await sb.from("profiles").select("school_id").eq("id", user.id).single();
    if (!prof?.school_id) {
      setLoading(false);
      return;
    }
    const { data: sch } = await sb.from("schools").select("*").eq("id", prof.school_id).single();
    setSchool(sch as School);

    // Teachers in this school + their stats
    const { data: ts } = await sb
      .from("profiles")
      .select("id, full_name")
      .eq("school_id", prof.school_id)
      .eq("role", "teacher");
    type T = { id: string; full_name: string | null };
    const teacherList = (ts as T[]) || [];

    const rows: TeacherRow[] = await Promise.all(
      teacherList.map(async (t) => {
        const [{ count: classCt }, { count: quizCt }, { count: primaryCt }, { count: coCt }] = await Promise.all([
          sb.from("class_teachers").select("class_id", { count: "exact", head: true }).eq("teacher_id", t.id),
          sb.from("quizzes").select("id", { count: "exact", head: true }).eq("owner_id", t.id),
          sb.from("class_teachers").select("class_id", { count: "exact", head: true }).eq("teacher_id", t.id).eq("role", "primary"),
          sb.from("class_teachers").select("class_id", { count: "exact", head: true }).eq("teacher_id", t.id).eq("role", "co"),
        ]);
        return {
          id: t.id,
          full_name: t.full_name,
          email: null,
          classCount: classCt || 0,
          quizCount: quizCt || 0,
          primaryCount: primaryCt || 0,
          coCount: coCt || 0,
        };
      })
    );
    rows.sort((a, b) => (b.classCount + b.quizCount) - (a.classCount + a.quizCount));

    // Hydrate emails. Email lives on auth.users, not on profiles, so
    // we hit the GET /api/admin/school/teachers endpoint which reads
    // it via the service-role admin client. Done after the other
    // stats so a slow auth round-trip doesn't hold up the table.
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
    } catch { /* non-fatal — email column just shows "—" */ }

    setTeachers(rows);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function remove(teacherId: string, name: string) {
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

  return (
    <div className="max-w-4xl mx-auto fade-in">
      <Link href="/school" className="text-sm text-emerald-700 font-semibold inline-flex items-center gap-1"><ArrowLeft size={14} /> School home</Link>
      <h1 className="h1 mt-2">Teachers — {school.name}</h1>
      <p className="muted mt-1">Teachers join the school either by entering the school code below, or automatically when you assign them to a class on the <Link href="/school/classes" className="text-emerald-700 font-semibold">Classes</Link> page.</p>

      {/* ============ School code (the only standalone onboarding path) ============ */}
      <div className="card mt-6">
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

      {/* ============ Current teachers ============ */}
      <h2 className="h2 mt-8 mb-3 flex items-center gap-2"><UserPlus size={20} /> Current teachers ({teachers.length})</h2>
      {teachers.length === 0 ? (
        <div className="card text-center py-8 muted text-sm">
          No teachers yet. Share the school code above, or assign a teacher to a class on the Classes page — they’ll be pulled into the school automatically.
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
                <th className="px-4 py-3 text-right">Action</th>
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
                      {t.primaryCount === 0 && t.coCount === 0 && (
                        <span className="text-[10px] uppercase tracking-wide font-bold px-2 py-0.5 rounded-full" style={{ background: "#fef3c7", color: "#92400e" }}>
                          Unassigned
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">{t.classCount}</td>
                  <td className="px-4 py-3 text-right">{t.quizCount}</td>
                  <td className="px-4 py-3 text-right">
                    <button className="btn btn-ghost text-red-600" onClick={() => remove(t.id, t.full_name || "this teacher")}>
                      <UserMinus size={14} /> Remove
                    </button>
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
