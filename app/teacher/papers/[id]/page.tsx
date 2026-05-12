"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { ExamPaper, ExamPaperQuestion, ExamQuestionType } from "@/lib/types";
import {
  ArrowLeft, Printer, CheckCircle2, Trash2, Pencil, Save, ChevronUp, ChevronDown,
} from "lucide-react";

const Q_TYPE_LABEL: Record<ExamQuestionType, string> = {
  mcq:           "MCQ",
  true_false:    "True / False",
  fill_blank:    "Fill in blank",
  short_answer:  "Short answer",
  long_answer:   "Long answer",
  numerical:     "Numerical",
};

export default function PaperDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [paper, setPaper] = useState<ExamPaper | null>(null);
  const [questions, setQuestions] = useState<ExamPaperQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const sb = supabaseBrowser();
    const { data: p } = await sb.from("exam_papers").select("*").eq("id", id).single();
    setPaper(p as ExamPaper);
    const { data: qs } = await sb.from("exam_paper_questions").select("*").eq("paper_id", id).order("position", { ascending: true });
    setQuestions((qs as ExamPaperQuestion[]) || []);
    setLoading(false);
  }, [id]);
  useEffect(() => { if (id) load(); }, [id, load]);

  const computedTotal = useMemo(() => questions.reduce((s, q) => s + (q.marks || 0), 0), [questions]);

  const grouped = useMemo(() => {
    const map = new Map<string, ExamPaperQuestion[]>();
    questions.forEach((q) => {
      if (!map.has(q.section_name)) map.set(q.section_name, []);
      map.get(q.section_name)!.push(q);
    });
    return Array.from(map.entries());
  }, [questions]);

  async function savePaperMeta(patch: Partial<ExamPaper>) {
    if (!paper) return;
    setBusy(true);
    const sb = supabaseBrowser();
    await sb.from("exam_papers").update(patch).eq("id", paper.id);
    setPaper({ ...paper, ...patch });
    setBusy(false);
  }

  async function saveQuestion(q: ExamPaperQuestion) {
    setBusy(true);
    const sb = supabaseBrowser();
    await sb.from("exam_paper_questions").update({
      stem: q.stem,
      options: q.options,
      correct_answer: q.correct_answer,
      explanation: q.explanation,
      marks: q.marks,
      bloom_level: q.bloom_level,
      section_name: q.section_name,
    }).eq("id", q.id);
    setEditingId(null);
    setBusy(false);
    await load();
  }

  async function deleteQuestion(qid: string) {
    if (!confirm("Delete this question? This cannot be undone.")) return;
    const sb = supabaseBrowser();
    await sb.from("exam_paper_questions").delete().eq("id", qid);
    await load();
  }

  async function move(qid: string, dir: -1 | 1) {
    const idx = questions.findIndex((x) => x.id === qid);
    if (idx < 0) return;
    const target = idx + dir;
    if (target < 0 || target >= questions.length) return;
    const a = questions[idx];
    const b = questions[target];
    const sb = supabaseBrowser();
    // Three-step swap via a sentinel position. Two direct UPDATEs
    // (a.position = b.position; b.position = a.position) would
    // either collide on a unique (paper_id, position) constraint or
    // leave both rows briefly at the same position. The sentinel (-1)
    // sits outside the valid 0..N range, so it's safe to park `a` on
    // it while `b` moves into a's slot.
    await sb.from("exam_paper_questions").update({ position: -1 }).eq("id", a.id);
    await sb.from("exam_paper_questions").update({ position: a.position }).eq("id", b.id);
    await sb.from("exam_paper_questions").update({ position: b.position }).eq("id", a.id);
    await load();
  }

  async function finalize() {
    if (!paper) return;
    if (!confirm("Finalize this paper? You can still edit afterwards, but the status will be marked finalized.")) return;
    await savePaperMeta({ status: "finalized", total_marks: computedTotal });
  }

  async function deletePaper() {
    if (!paper) return;
    if (!confirm(`Delete "${paper.name}"? This permanently removes the paper and all its questions.`)) return;
    const sb = supabaseBrowser();
    await sb.from("exam_papers").delete().eq("id", paper.id);
    router.push("/teacher/papers");
  }

  if (loading || !paper) {
    return <div className="grid place-items-center py-20"><div className="spinner" /></div>;
  }

  return (
    <div className="max-w-4xl mx-auto fade-in">
      <Link href="/teacher/papers" className="text-sm text-emerald-700 font-semibold inline-flex items-center gap-1"><ArrowLeft size={14} /> All tests</Link>

      <div className="flex items-start justify-between gap-3 flex-wrap mt-2">
        <div className="min-w-0">
          <h1 className="h1">{paper.name}</h1>
          <div className="flex items-center gap-2 mt-1 flex-wrap text-xs muted">
            {paper.subject && <span>{paper.subject}</span>}
            {paper.class_grade && <span>· {paper.class_grade}</span>}
            <span>· {questions.length} question{questions.length === 1 ? "" : "s"}</span>
            <span>· {computedTotal} marks</span>
            {paper.duration_minutes && <span>· {paper.duration_minutes} min</span>}
            {paper.status === "finalized" ? (
              <span className="text-[10px] uppercase tracking-wide font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5 inline-flex items-center gap-1">
                <CheckCircle2 size={10} /> Finalized
              </span>
            ) : (
              <span className="text-[10px] uppercase tracking-wide font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5 inline-flex items-center gap-1">
                <Pencil size={10} /> Draft
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link href={`/teacher/papers/${paper.id}/print`} target="_blank" className="btn btn-secondary"><Printer size={14} /> Print</Link>
          {paper.status !== "finalized" && (
            <button type="button" className="btn btn-primary" onClick={finalize} disabled={busy}><CheckCircle2 size={14} /> Finalize</button>
          )}
        </div>
      </div>

      {/* Paper metadata editor */}
      <details className="card mt-4">
        <summary className="cursor-pointer font-semibold">Edit test details</summary>
        <div className="grid sm:grid-cols-2 gap-3 mt-3">
          <div>
            <label className="label">Test name</label>
            <input className="input" value={paper.name} onChange={(e) => setPaper({ ...paper, name: e.target.value })} onBlur={() => savePaperMeta({ name: paper.name })} />
          </div>
          <div>
            <label className="label">Subject</label>
            <input className="input" value={paper.subject || ""} onChange={(e) => setPaper({ ...paper, subject: e.target.value })} onBlur={() => savePaperMeta({ subject: paper.subject || null })} />
          </div>
          <div>
            <label className="label">School name</label>
            <input className="input" value={paper.school_name || ""} onChange={(e) => setPaper({ ...paper, school_name: e.target.value })} onBlur={() => savePaperMeta({ school_name: paper.school_name || null })} />
          </div>
          <div>
            <label className="label">Class / grade</label>
            <input className="input" value={paper.class_grade || ""} onChange={(e) => setPaper({ ...paper, class_grade: e.target.value })} onBlur={() => savePaperMeta({ class_grade: paper.class_grade || null })} />
          </div>
          <div>
            <label className="label">Date</label>
            <input type="date" className="input" value={paper.exam_date || ""} onChange={(e) => setPaper({ ...paper, exam_date: e.target.value || null })} onBlur={() => savePaperMeta({ exam_date: paper.exam_date || null })} />
          </div>
          <div>
            <label className="label">Duration (min)</label>
            <input
              type="number"
              className="input"
              value={paper.duration_minutes ?? ""}
              onChange={(e) => {
                // `+"" || null` collapses 0 and "" both to null, so a
                // user explicitly typing 0 saw the field blank itself.
                // Treat "" as null (cleared), but keep the typed number
                // (including 0) so it round-trips correctly.
                const raw = e.target.value;
                setPaper({
                  ...paper,
                  duration_minutes: raw === "" ? null : Number(raw),
                });
              }}
              onBlur={() => savePaperMeta({ duration_minutes: paper.duration_minutes })}
            />
          </div>
        </div>
        <div className="mt-3">
          <label className="label">Instructions</label>
          <textarea className="textarea" rows={2} value={paper.instructions || ""} onChange={(e) => setPaper({ ...paper, instructions: e.target.value })} onBlur={() => savePaperMeta({ instructions: paper.instructions || null })} />
        </div>
      </details>

      {/* Sections + questions */}
      <div className="space-y-6 mt-6">
        {grouped.map(([sectionName, qs]) => {
          const sectionMarks = qs.reduce((s, q) => s + (q.marks || 0), 0);
          return (
            <section key={sectionName}>
              <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                <h2 className="text-lg font-bold">{sectionName}</h2>
                <span className="text-xs muted">{qs.length} question{qs.length === 1 ? "" : "s"} · {sectionMarks} marks</span>
              </div>

              <div className="space-y-2">
                {qs.map((q, idxInSection) => {
                  const isEditing = editingId === q.id;
                  return (
                    <div key={q.id} className="card">
                      <div className="flex items-start gap-3">
                        <span className="text-xs font-bold text-slate-400 mt-0.5">Q{questions.findIndex((x) => x.id === q.id) + 1}.</span>
                        <div className="flex-1 min-w-0">
                          {isEditing ? (
                            <EditableQuestion q={q} onChange={(patch) => setQuestions((arr) => arr.map((x) => x.id === q.id ? { ...x, ...patch } : x))} />
                          ) : (
                            <ReadOnlyQuestion q={q} />
                          )}
                        </div>
                        <div className="flex flex-col gap-0.5 shrink-0">
                          <button type="button" onClick={() => move(q.id, -1)} disabled={idxInSection === 0} className="p-1 disabled:opacity-30 hover:bg-slate-100 rounded text-slate-500" title="Move up"><ChevronUp size={14} /></button>
                          <button type="button" onClick={() => move(q.id, 1)} disabled={idxInSection === qs.length - 1} className="p-1 disabled:opacity-30 hover:bg-slate-100 rounded text-slate-500" title="Move down"><ChevronDown size={14} /></button>
                        </div>
                        {isEditing ? (
                          <button type="button" className="btn btn-primary text-xs" onClick={() => saveQuestion(q)} disabled={busy}>
                            <Save size={12} /> Save
                          </button>
                        ) : (
                          <button type="button" className="btn btn-ghost text-xs" onClick={() => setEditingId(q.id)}>
                            <Pencil size={12} /> Edit
                          </button>
                        )}
                        <button type="button" className="btn btn-ghost text-red-600 p-2" onClick={() => deleteQuestion(q.id)} title="Delete"><Trash2 size={14} /></button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      <div className="mt-12 border border-red-200 rounded-xl p-4 bg-red-50/40">
        <h3 className="font-semibold text-red-800 mb-1">Danger zone</h3>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="text-sm text-red-900/80">Delete this test permanently.</div>
          <button type="button" className="btn btn-danger" onClick={deletePaper}><Trash2 size={14} /> Delete test</button>
        </div>
      </div>
    </div>
  );
}

function ReadOnlyQuestion({ q }: { q: ExamPaperQuestion }) {
  return (
    <>
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span className="text-[10px] uppercase tracking-wide font-bold text-slate-700 bg-slate-100 rounded-full px-2 py-0.5">{Q_TYPE_LABEL[q.question_type]}</span>
        <span className="text-[10px] font-bold text-emerald-800 bg-emerald-50 rounded-full px-2 py-0.5">{q.marks} mark{q.marks === 1 ? "" : "s"}</span>
        {q.bloom_level && <span className="text-[10px] muted">{q.bloom_level}</span>}
      </div>
      <div className="text-sm font-medium whitespace-pre-wrap">{q.stem}</div>
      {q.question_type === "mcq" && Array.isArray(q.options) && (
        <ol className="mt-2 grid sm:grid-cols-2 gap-1 text-sm">
          {q.options.map((o, i) => (
            <li key={i} className={q.correct_answer === String.fromCharCode(65 + i) ? "text-emerald-800 font-semibold" : "text-slate-600"}>
              <span className="font-mono text-xs muted mr-1">{String.fromCharCode(65 + i)}.</span> {o}
            </li>
          ))}
        </ol>
      )}
      {q.correct_answer && q.question_type !== "mcq" && (
        <div className="mt-2 text-xs">
          <strong className="text-emerald-800">Answer:</strong> <span className="text-slate-700 whitespace-pre-wrap">{q.correct_answer}</span>
        </div>
      )}
      {q.explanation && (
        <div className="mt-1 text-xs muted">
          <strong>Notes:</strong> {q.explanation}
        </div>
      )}
    </>
  );
}

function EditableQuestion({ q, onChange }: { q: ExamPaperQuestion; onChange: (patch: Partial<ExamPaperQuestion>) => void }) {
  return (
    <div className="space-y-2">
      <div className="flex gap-2 flex-wrap">
        <input className="input flex-1" value={q.section_name} onChange={(e) => onChange({ section_name: e.target.value })} placeholder="Section name" />
        <input type="number" min={1} max={50} className="input w-24" value={q.marks} onChange={(e) => onChange({ marks: Math.max(1, +e.target.value || 1) })} />
      </div>
      <textarea className="textarea" rows={3} value={q.stem} onChange={(e) => onChange({ stem: e.target.value })} placeholder="Question stem" />
      {q.question_type === "mcq" && (
        <div className="grid sm:grid-cols-2 gap-2">
          {(q.options || ["", "", "", ""]).map((opt, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-xs font-mono muted w-4">{String.fromCharCode(65 + i)}.</span>
              <input
                className={`input flex-1 ${q.correct_answer === String.fromCharCode(65 + i) ? "border-emerald-500" : ""}`}
                value={opt}
                onChange={(e) => {
                  const next = [...(q.options || ["", "", "", ""])];
                  next[i] = e.target.value;
                  onChange({ options: next });
                }}
              />
              <button type="button"
                className={`text-xs px-2 py-1 rounded ${q.correct_answer === String.fromCharCode(65 + i) ? "bg-emerald-600 text-white" : "bg-slate-100"}`}
                onClick={() => onChange({ correct_answer: String.fromCharCode(65 + i) })}
                title="Mark as correct"
              >
                ✓
              </button>
            </div>
          ))}
        </div>
      )}
      {q.question_type !== "mcq" && (
        <textarea className="textarea" rows={2} value={q.correct_answer || ""} onChange={(e) => onChange({ correct_answer: e.target.value })} placeholder="Model answer / answer key" />
      )}
      <textarea className="textarea" rows={1} value={q.explanation || ""} onChange={(e) => onChange({ explanation: e.target.value })} placeholder="Notes / working (optional)" />
    </div>
  );
}
