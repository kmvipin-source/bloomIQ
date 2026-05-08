"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { Quiz, QuizAttempt, Class, QuizAssignment, Question } from "@/lib/types";
import { Copy, Download, FileText, Send, X, Users, User as UserIcon, Eye, ChevronDown, ChevronUp, Pencil, Printer } from "lucide-react";
import AssignTestModal from "@/components/AssignTestModal";
import { pct } from "@/lib/utils";
import BloomBadge from "@/components/BloomBadge";

type AttemptRow = QuizAttempt & { profile?: { full_name: string | null } };
type AssignmentRow = QuizAssignment & {
  class?: { name: string } | null;
  student?: { full_name: string | null } | null;
};
type ClassWithMembers = Class & { members: { id: string; full_name: string | null }[] };

// What we render in the test preview section. Comes from joining
// quiz_questions (which holds position) to question_bank (which holds
// the actual stem/options/explanation/Bloom level). One row per
// question, ordered the same way the student will see them.
type PreviewQuestion = Pick<
  Question,
  "id" | "stem" | "options" | "correct_index" | "explanation" | "bloom_level" | "topic"
> & { position: number };

export default function QuizDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [questions, setQuestions] = useState<number>(0);
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [shareUrl, setShareUrl] = useState("");

  // ---- Preview state -------------------------------------------------
  // The actual questions (stems / options / etc), loaded in load() via
  // a join through quiz_questions. previewOpen toggles the section
  // between collapsed (header only) and expanded (full list visible).
  // Defaults to expanded the first time the page loads — the dominant
  // need is "let me see what I built before I send it out."
  const [previewQs, setPreviewQs] = useState<PreviewQuestion[]>([]);
  const [previewOpen, setPreviewOpen] = useState<boolean>(true);
  const [showAnswers, setShowAnswers] = useState<boolean>(true);

  // Assignment state
  const [classes, setClasses] = useState<ClassWithMembers[]>([]);
  // Guards "Create a class to assign" from briefly showing when the page
  // first mounts (classes is [] until loadClassesAndAssignments resolves).
  // A teacher who DOES have classes shouldn't see the no-classes CTA.
  const [classesLoaded, setClassesLoaded] = useState(false);
  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [showAssign, setShowAssign] = useState(false);

  async function load() {
    const sb = supabaseBrowser();
    const { data: q } = await sb.from("quizzes").select("*").eq("id", id).single();
    setQuiz(q as Quiz);

    const { count } = await sb.from("quiz_questions").select("question_id", { count: "exact", head: true }).eq("quiz_id", id);
    setQuestions(count || 0);

    // Pull the actual questions for the preview section. Joined via
    // quiz_questions → question_bank, ordered by position so the
    // teacher sees them in the same order students will. RLS already
    // permits the test owner to read their own questions, so no
    // service-role hop needed.
    type QqRow = {
      position: number;
      question: Pick<Question, "id" | "stem" | "options" | "correct_index" | "explanation" | "bloom_level" | "topic"> | null;
    };
    const { data: qqRows } = await sb
      .from("quiz_questions")
      .select("position, question:question_bank(id, stem, options, correct_index, explanation, bloom_level, topic)")
      .eq("quiz_id", id)
      .order("position", { ascending: true });
    const items: PreviewQuestion[] = ((qqRows as unknown as QqRow[]) || [])
      .filter((r) => r.question)
      .map((r) => ({ ...(r.question as PreviewQuestion), position: r.position }));
    setPreviewQs(items);

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
    setClassesLoaded(true);

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
      <div className="flex items-start justify-between gap-3 mt-2 flex-wrap">
        <h1 className="h1">{quiz.name}</h1>
        {!classesLoaded ? (
          // Hold the slot until the classes fetch resolves so we don't
          // flash "Create a class to assign" at teachers who do have
          // classes. Tiny ghost button keeps layout stable.
          <button
            type="button"
            className="btn btn-secondary opacity-50"
            disabled
            aria-busy="true"
          >
            <Send size={16} /> Loading…
          </button>
        ) : classes.length > 0 ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setShowAssign(true)}
            title="Assign this test to a class or specific students"
          >
            <Send size={16} /> Assign to class
          </button>
        ) : (
          <Link className="btn btn-secondary" href="/teacher/classes">
            <Users size={16} /> Create a class to assign
          </Link>
        )}
      </div>

      <div className="grid sm:grid-cols-3 gap-4 mt-5">
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Test code</div>
          <div className="flex items-center gap-2 mt-2">
            <code className="text-2xl font-mono font-bold">{quiz.code}</code>
            <button type="button" className="btn btn-ghost" onClick={() => navigator.clipboard.writeText(quiz.code)}>
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

      {/* ============ PREVIEW (questions in this test) ============ */}
      {/* Renders the actual questions in the same order students will see
          them, with the correct option highlighted. Lets the teacher
          sanity-check the test before assigning — previously the page
          only showed a question count, not the questions themselves. */}
      <div className="card mt-8">
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => setPreviewOpen((v) => !v)}
            className="flex items-center gap-2 font-semibold text-slate-800"
            aria-expanded={previewOpen}
          >
            <Eye size={16} className="text-emerald-600" />
            Preview test
            <span className="text-sm muted font-normal">
              ({previewQs.length} {previewQs.length === 1 ? "question" : "questions"})
            </span>
            {previewOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>

          <div className="ml-auto flex items-center gap-2 flex-wrap">
            {previewOpen && previewQs.length > 0 && (
              <label className="text-xs muted inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showAnswers}
                  onChange={(e) => setShowAnswers(e.target.checked)}
                />
                Show correct answers
              </label>
            )}
            {previewQs.length > 0 && (
              <button
                type="button"
                className="btn btn-ghost text-sm"
                onClick={() => window.print()}
                title="Open the browser's print dialog (the page is print-friendly)"
              >
                <Printer size={14} /> Print
              </button>
            )}
            <Link
              href={`/teacher/quizzes/new?ids=${previewQs.map((q) => q.id).join(",")}`}
              className="btn btn-secondary text-sm"
              title="Open the composer with these questions pre-selected so you can swap or reorder them."
            >
              <Pencil size={14} /> Edit questions
            </Link>
          </div>
        </div>

        {previewOpen && (
          <div className="mt-3">
            {previewQs.length === 0 ? (
              <div className="text-sm muted text-center py-6">
                No questions in this test. Use Edit questions to add some.
              </div>
            ) : (
              <ol className="space-y-3">
                {previewQs.map((q, idx) => (
                  <li
                    key={q.id}
                    className="border border-slate-200 rounded-lg p-3 bg-white"
                  >
                    <div className="flex items-start gap-3">
                      <div className="text-sm font-bold text-slate-400 w-6 mt-0.5 shrink-0">
                        {idx + 1}.
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <BloomBadge level={q.bloom_level} />
                          {q.topic && <span className="text-xs muted">{q.topic}</span>}
                        </div>
                        <div className="text-sm font-medium">{q.stem}</div>
                        <ul className="grid sm:grid-cols-2 gap-x-4 gap-y-1 mt-2 text-sm">
                          {q.options.map((o, i) => {
                            const isCorrect = i === q.correct_index;
                            const highlight = showAnswers && isCorrect;
                            return (
                              <li
                                key={i}
                                className={
                                  highlight
                                    ? "text-emerald-700 font-semibold"
                                    : "text-slate-600"
                                }
                              >
                                <span className="text-xs uppercase tracking-wide opacity-70 mr-1">
                                  {String.fromCharCode(65 + i)}.
                                </span>
                                {o}
                                {highlight && (
                                  <span className="ml-1.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700/80">
                                    ✓ correct
                                  </span>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                        {showAnswers && q.explanation && (
                          <p className="text-xs muted mt-2">
                            <strong className="text-slate-600">Why:</strong> {q.explanation}
                          </p>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>

      {/* ============ ASSIGNMENTS ============ */}
      <div className="flex items-center justify-between mt-8 mb-3">
        <h2 className="h2">Assignments</h2>
        {classes.length > 0 ? (
          <button type="button" className="btn btn-primary" onClick={() => setShowAssign(true)}>
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
              <button type="button" className="btn btn-ghost text-red-600" onClick={() => deleteAssignment(a.id)} title="Remove">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ============ ASSIGN MODAL ============ */}
      {showAssign && (
        <AssignTestModal
          quizId={id}
          classes={classes}
          existingAssignments={assignments}
          onClose={() => setShowAssign(false)}
          onAssigned={() => loadClassesAndAssignments()}
        />
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
                      <button type="button" className="btn btn-secondary" onClick={() => downloadReport(a.id)}>
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
