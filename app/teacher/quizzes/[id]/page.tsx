"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { Quiz, QuizAttempt, Class, QuizAssignment } from "@/lib/types";
import { Copy, Download, FileText, Send, X, Users, User as UserIcon } from "lucide-react";
import { pct } from "@/lib/utils";

type AttemptRow = QuizAttempt & { profile?: { full_name: string | null } };
type AssignmentRow = QuizAssignment & {
  class?: { name: string } | null;
  student?: { full_name: string | null } | null;
};
type ClassWithMembers = Class & { members: { id: string; full_name: string | null }[] };

export default function QuizDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [questions, setQuestions] = useState<number>(0);
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [shareUrl, setShareUrl] = useState("");

  // Assignment state
  const [classes, setClasses] = useState<ClassWithMembers[]>([]);
  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [showAssign, setShowAssign] = useState(false);
  const [pickedClassId, setPickedClassId] = useState<string>("");
  const [scope, setScope] = useState<"whole" | "specific">("whole");
  const [pickedStudents, setPickedStudents] = useState<Set<string>>(new Set());
  const [dueAt, setDueAt] = useState<string>("");
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignErr, setAssignErr] = useState<string | null>(null);

  async function load() {
    const sb = supabaseBrowser();
    const { data: q } = await sb.from("quizzes").select("*").eq("id", id).single();
    setQuiz(q as Quiz);

    const { count } = await sb.from("quiz_questions").select("question_id", { count: "exact", head: true }).eq("quiz_id", id);
    setQuestions(count || 0);

    const { data: atts } = await sb
      .from("quiz_attempts")
      .select("*, profile:profiles!quiz_attempts_student_id_fkey(full_name)")
      .eq("quiz_id", id)
      .order("submitted_at", { ascending: false, nullsFirst: false });
    setAttempts((atts as unknown as AttemptRow[]) || []);

    if (typeof window !== "undefined") setShareUrl(`${window.location.origin}/student/join`);
    await loadClassesAndAssignments();
  }

  async function loadClassesAndAssignments() {
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;

    // Load classes I teach (primary OR co) for the assign picker
    const { data: cts } = await sb
      .from("class_teachers")
      .select("class:classes(*)")
      .eq("teacher_id", user.id);
    type CtRow = { class: Class | null };
    const classList = ((cts as unknown as CtRow[]) || [])
      .map((r) => r.class)
      .filter((c): c is Class => c !== null)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const enriched: ClassWithMembers[] = await Promise.all(
      classList.map(async (c) => {
        const { data: mem } = await sb
          .from("class_members")
          .select("profile:profiles!class_members_student_id_fkey(id, full_name)")
          .eq("class_id", c.id);
        type Row = { profile: { id: string; full_name: string | null } | null };
        const members = ((mem as unknown as Row[]) || [])
          .filter((m) => m.profile)
          .map((m) => ({ id: m.profile!.id, full_name: m.profile!.full_name }));
        return { ...c, members };
      })
    );
    setClasses(enriched);

    // Load existing assignments for this quiz
    const { data: asg } = await sb
      .from("quiz_assignments")
      .select(`
        *,
        class:classes(name),
        student:profiles!quiz_assignments_student_id_fkey(full_name)
      `)
      .eq("quiz_id", id)
      .order("created_at", { ascending: false });
    setAssignments((asg as unknown as AssignmentRow[]) || []);
  }

  useEffect(() => { if (id) load(); }, [id]);

  async function downloadReport(attemptId: string) {
    const sb = supabaseBrowser();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;
    const res = await fetch(`/api/report/${attemptId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (!res.ok) { alert("Failed to generate report"); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `bloomiq-report-${attemptId.slice(0,8)}.pdf`; a.click();
    URL.revokeObjectURL(url);
  }

  // -------- Assignment helpers --------
  const pickedClass = useMemo(() => classes.find((c) => c.id === pickedClassId) || null, [classes, pickedClassId]);

  function toggleStudent(sid: string) {
    setPickedStudents((s) => {
      const n = new Set(s);
      if (n.has(sid)) n.delete(sid); else n.add(sid);
      return n;
    });
  }

  function resetAssignForm() {
    setShowAssign(false);
    setPickedClassId("");
    setScope("whole");
    setPickedStudents(new Set());
    setDueAt("");
    setAssignErr(null);
  }

  async function saveAssignment() {
    setAssignErr(null);
    if (!pickedClassId) return setAssignErr("Pick a class first.");
    if (scope === "specific" && pickedStudents.size === 0) {
      return setAssignErr("Select at least one student, or switch to whole-class.");
    }
    // Due date+time is now mandatory — every assignment must have a
    // deadline so the student knows when to submit and so the
    // extension-request flow has a clear "by when" to extend.
    if (!dueAt) {
      return setAssignErr("Pick a due date and time.");
    }
    const dueMs = Date.parse(dueAt);
    if (Number.isNaN(dueMs) || dueMs <= Date.now()) {
      return setAssignErr("Due date must be in the future.");
    }

    // Duplicate-assignment guard. If this exact (quiz, class) or
    // (quiz, student) pair already has an assignment row, prompt
    // before inserting a second one — multiple silent duplicates
    // confuse students ("which one do I answer?") and inflate the
    // teacher's analytics. Confirm and proceed if intentional
    // (e.g., different due dates for two cohorts).
    const dupes = scope === "whole"
      ? assignments.filter((a) => a.class_id === pickedClassId)
      : assignments.filter((a) => a.student_id !== null && pickedStudents.has(a.student_id));
    if (dupes.length > 0) {
      const who = scope === "whole"
        ? `the class "${pickedClass?.name || ""}"`
        : `${dupes.length} student${dupes.length === 1 ? "" : "s"}`;
      const ok = window.confirm(
        `This test is already assigned to ${who}. Assign again with the new due date?`,
      );
      if (!ok) return;
    }

    setAssignBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) throw new Error("Not signed in");

      const due_at = new Date(dueMs).toISOString();
      const rows = scope === "whole"
        ? [{ quiz_id: id, class_id: pickedClassId, student_id: null, assigned_by: user.id, due_at }]
        : Array.from(pickedStudents).map((sid) => ({
            quiz_id: id, class_id: null, student_id: sid, assigned_by: user.id, due_at,
          }));

      const { error } = await sb.from("quiz_assignments").insert(rows);
      if (error) throw error;
      resetAssignForm();
      await loadClassesAndAssignments();
    } catch (e) {
      setAssignErr(e instanceof Error ? e.message : "Could not assign");
    } finally {
      setAssignBusy(false);
    }
  }

  async function deleteAssignment(aid: string) {
    if (!confirm("Remove this assignment? The students will no longer see it as assigned.")) return;
    const sb = supabaseBrowser();
    const { error } = await sb.from("quiz_assignments").delete().eq("id", aid);
    if (error) {
      alert(`Could not remove: ${error.message}`);
      return;
    }
    setAssignments((a) => a.filter((x) => x.id !== aid));
  }

  if (!quiz) return <div className="grid place-items-center py-20"><div className="spinner" /></div>;

  const completed = attempts.filter((a) => a.submitted_at);
  const avg = completed.length ? Math.round(completed.reduce((s, a) => s + pct(a.score, a.total), 0) / completed.length) : 0;

  return (
    <div className="max-w-5xl mx-auto fade-in">
      <Link href="/teacher/quizzes" className="text-sm text-emerald-700 font-semibold">← All tests</Link>
      <h1 className="h1 mt-2">{quiz.name}</h1>

      <div className="grid sm:grid-cols-3 gap-4 mt-5">
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Test code</div>
          <div className="flex items-center gap-2 mt-2">
            <code className="text-2xl font-mono font-bold">{quiz.code}</code>
            <button className="btn btn-ghost" onClick={() => navigator.clipboard.writeText(quiz.code)}>
              <Copy size={16} />
            </button>
          </div>
          <div className="text-xs muted mt-2">Open access: any student with the code can take it. For targeted access, assign below.</div>
          <div className="text-xs text-emerald-700 break-all">{shareUrl}</div>
        </div>
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Setup</div>
          <div className="text-2xl font-bold mt-2">{questions}</div>
          <div className="text-sm muted">questions · {quiz.time_limit_minutes} min</div>
        </div>
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Class average</div>
          <div className="text-2xl font-bold mt-2">{completed.length ? `${avg}%` : "—"}</div>
          <div className="text-sm muted">{completed.length} of {attempts.length} submitted</div>
        </div>
      </div>

      {/* ============ ASSIGNMENTS ============ */}
      <div className="flex items-center justify-between mt-8 mb-3">
        <h2 className="h2">Assignments</h2>
        {classes.length > 0 ? (
          <button className="btn btn-primary" onClick={() => setShowAssign(true)}>
            <Send size={16} /> Assign to class / students
          </button>
        ) : (
          <Link className="btn btn-secondary" href="/teacher/classes">
            <Users size={16} /> Create a class first
          </Link>
        )}
      </div>

      {assignments.length === 0 ? (
        <div className="card text-center py-8 muted text-sm">
          No assignments yet. The quiz is open via its code. Assign to a class or students for targeted access and tracking.
        </div>
      ) : (
        <div className="space-y-2">
          {assignments.map((a) => (
            <div key={a.id} className="card flex items-center gap-3">
              {a.class_id ? (
                <Users size={18} className="text-emerald-600 shrink-0" />
              ) : (
                <UserIcon size={18} className="text-sky-600 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="font-medium">
                  {a.class_id ? <>Class: {a.class?.name || "Unknown"}</> : <>Student: {a.student?.full_name || "Unknown"}</>}
                </div>
                <div className="text-xs muted">
                  Assigned {new Date(a.created_at).toLocaleDateString()}
                  {a.due_at && <> · Due {new Date(a.due_at).toLocaleString()}</>}
                </div>
              </div>
              <button className="btn btn-ghost text-red-600" onClick={() => deleteAssignment(a.id)} title="Remove">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ============ ASSIGN MODAL ============ */}
      {showAssign && (
        <div className="fixed inset-0 bg-black/40 grid place-items-center z-50 p-4" onClick={resetAssignForm}>
          <div
            className="card max-w-lg w-full overflow-y-auto"
            style={{ maxHeight: "calc(100vh - 2rem)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="h2">Assign test</h3>
              <button onClick={resetAssignForm} className="btn btn-ghost"><X size={16} /></button>
            </div>

            <label className="label">Class</label>
            <select
              className="select"
              value={pickedClassId}
              onChange={(e) => { setPickedClassId(e.target.value); setPickedStudents(new Set()); }}
            >
              <option value="">— Pick a class —</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.members.length} student{c.members.length === 1 ? "" : "s"})</option>
              ))}
            </select>

            {pickedClass && (
              <>
                <label className="label mt-4">Who in {pickedClass.name}?</label>
                <div className="flex gap-2 mb-3">
                  <button
                    type="button"
                    className={`btn ${scope === "whole" ? "btn-primary" : "btn-secondary"}`}
                    onClick={() => setScope("whole")}
                  >
                    Entire class ({pickedClass.members.length})
                  </button>
                  <button
                    type="button"
                    className={`btn ${scope === "specific" ? "btn-primary" : "btn-secondary"}`}
                    onClick={() => setScope("specific")}
                    disabled={pickedClass.members.length === 0}
                  >
                    Specific students
                  </button>
                </div>

                {scope === "specific" && (
                  pickedClass.members.length === 0 ? (
                    <div className="text-sm muted">This class has no members yet.</div>
                  ) : (
                    <div className="border border-slate-200 rounded-lg max-h-56 overflow-y-auto divide-y divide-slate-100">
                      {pickedClass.members.map((m) => {
                        const on = pickedStudents.has(m.id);
                        return (
                          <label key={m.id} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-slate-50">
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => toggleStudent(m.id)}
                              className="h-4 w-4 accent-emerald-600"
                            />
                            <span className="text-sm">{m.full_name || "Unknown student"}</span>
                          </label>
                        );
                      })}
                    </div>
                  )
                )}
              </>
            )}

            <label className="label mt-4">
              Due date &amp; time <span className="text-red-600">*</span>
            </label>
            <input
              type="datetime-local"
              className="input"
              required
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
            />

            {assignErr && <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{assignErr}</div>}

            <div className="flex justify-end gap-2 mt-5">
              <button className="btn btn-ghost" onClick={resetAssignForm}>Cancel</button>
              <button className="btn btn-primary" onClick={saveAssignment} disabled={assignBusy}>
                {assignBusy ? <><span className="spinner" /> Assigning…</> : "Assign"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============ ATTEMPTS ============ */}
      <h2 className="h2 mt-8 mb-3">Attempts</h2>
      {attempts.length === 0 ? (
        <div className="card text-center py-12 muted">
          No attempts yet. Share the code <code className="px-2 py-1 bg-slate-100 rounded">{quiz.code}</code> with your students, or assign the test above.
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase muted">
              <tr>
                <th className="px-4 py-3 text-left">Student</th>
                <th className="px-4 py-3 text-left">Score</th>
                <th className="px-4 py-3 text-left">Submitted</th>
                <th className="px-4 py-3 text-right">Report</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {attempts.map((a) => (
                <tr key={a.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium">{a.profile?.full_name || "Unknown"}</td>
                  <td className="px-4 py-3">
                    {a.submitted_at ? <strong>{a.score}/{a.total}</strong> : <span className="badge badge-pending">In progress</span>}
                    {a.submitted_at && <span className="muted ml-2">({pct(a.score, a.total)}%)</span>}
                  </td>
                  <td className="px-4 py-3 muted">{a.submitted_at ? new Date(a.submitted_at).toLocaleString() : "—"}</td>
                  <td className="px-4 py-3 text-right">
                    {a.submitted_at && (
                      <button className="btn btn-secondary" onClick={() => downloadReport(a.id)}>
                        <Download size={14} /> PDF
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6 flex gap-2">
        <Link href={`/teacher/analytics?quiz=${quiz.id}`} className="btn btn-secondary"><FileText size={16} /> Class analytics</Link>
      </div>
    </div>
  );
}
