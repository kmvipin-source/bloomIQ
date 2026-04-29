"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { ExamPaper, ExamPaperQuestion } from "@/lib/types";
import { Printer, Eye, EyeOff } from "lucide-react";

export default function PrintPaperPage() {
  const { id } = useParams<{ id: string }>();
  const [paper, setPaper] = useState<ExamPaper | null>(null);
  const [questions, setQuestions] = useState<ExamPaperQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAnswers, setShowAnswers] = useState(false);

  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: p } = await sb.from("exam_papers").select("*").eq("id", id).single();
      setPaper(p as ExamPaper);
      const { data: qs } = await sb.from("exam_paper_questions").select("*").eq("paper_id", id).order("position", { ascending: true });
      setQuestions((qs as ExamPaperQuestion[]) || []);
      setLoading(false);
    })();
  }, [id]);

  const grouped = useMemo(() => {
    const map = new Map<string, ExamPaperQuestion[]>();
    questions.forEach((q) => {
      if (!map.has(q.section_name)) map.set(q.section_name, []);
      map.get(q.section_name)!.push(q);
    });
    return Array.from(map.entries());
  }, [questions]);

  const totalMarks = useMemo(() => questions.reduce((s, q) => s + (q.marks || 0), 0), [questions]);

  if (loading || !paper) return <div className="grid place-items-center py-20"><div className="spinner" /></div>;

  return (
    <>
      {/* Print-only styles */}
      <style jsx global>{`
        @media print {
          body { background: white !important; }
          .no-print { display: none !important; }
          .print-paper { padding: 0 !important; max-width: none !important; box-shadow: none !important; }
          .print-question { break-inside: avoid; }
          .print-section { break-after: auto; }
        }
      `}</style>

      {/* Toolbar (hidden in print) */}
      <div className="no-print sticky top-0 z-10 bg-slate-100 border-b border-slate-200 px-4 py-2 flex items-center justify-between gap-3 flex-wrap">
        <span className="text-sm text-slate-700">
          Print preview — use your browser&apos;s <strong>Print</strong> dialog (or save as PDF).
        </span>
        <div className="flex gap-2">
          <button
            className="btn btn-secondary text-sm"
            onClick={() => setShowAnswers((v) => !v)}
          >
            {showAnswers ? <><EyeOff size={14} /> Hide answer key</> : <><Eye size={14} /> Show answer key</>}
          </button>
          <button className="btn btn-primary text-sm" onClick={() => window.print()}>
            <Printer size={14} /> Print
          </button>
        </div>
      </div>

      <div className="print-paper max-w-3xl mx-auto bg-white p-10 my-6 shadow rounded-lg" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
        {/* Header */}
        <div className="text-center border-b-2 border-slate-900 pb-4 mb-5">
          {paper.school_name && <div className="text-lg font-bold uppercase tracking-wide">{paper.school_name}</div>}
          <div className="text-2xl font-bold mt-1">{paper.name}</div>
          <div className="flex justify-center gap-4 mt-2 text-sm flex-wrap">
            {paper.subject && <span><strong>Subject:</strong> {paper.subject}</span>}
            {paper.class_grade && <span><strong>Class:</strong> {paper.class_grade}</span>}
            {paper.exam_date && <span><strong>Date:</strong> {new Date(paper.exam_date).toLocaleDateString()}</span>}
            {paper.duration_minutes && <span><strong>Duration:</strong> {paper.duration_minutes} min</span>}
            <span><strong>Maximum marks:</strong> {totalMarks}</span>
          </div>
        </div>

        {/* Instructions */}
        {paper.instructions && (
          <div className="mb-6 p-3 bg-slate-50 border border-slate-200 rounded text-sm">
            <div className="font-bold mb-1">General instructions:</div>
            <div className="whitespace-pre-wrap">{paper.instructions}</div>
          </div>
        )}

        {/* Sections */}
        {grouped.map(([sectionName, qs]) => {
          const sectionMarks = qs.reduce((s, q) => s + q.marks, 0);
          return (
            <section key={sectionName} className="print-section mb-6">
              <h2 className="text-lg font-bold border-b border-slate-300 pb-1 mb-3 flex items-center justify-between">
                <span>{sectionName}</span>
                <span className="text-sm font-normal text-slate-600">[{sectionMarks} marks]</span>
              </h2>
              <ol className="space-y-4">
                {qs.map((q) => (
                  <li key={q.id} className="print-question flex items-start gap-3">
                    <span className="font-bold w-8 shrink-0">Q{questions.findIndex((x) => x.id === q.id) + 1}.</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 whitespace-pre-wrap">{q.stem}</div>
                        <span className="text-sm font-bold whitespace-nowrap text-slate-700">[{q.marks}]</span>
                      </div>

                      {/* MCQ options */}
                      {q.question_type === "mcq" && Array.isArray(q.options) && (
                        <ol className="mt-2 ml-4 grid sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
                          {q.options.map((opt, i) => (
                            <li key={i}>
                              <span className="font-mono mr-2">({String.fromCharCode(65 + i)})</span>{opt}
                            </li>
                          ))}
                        </ol>
                      )}

                      {/* Writing space hint */}
                      {(q.question_type === "short_answer" || q.question_type === "long_answer" || q.question_type === "numerical" || q.question_type === "fill_blank") && (
                        <div className="mt-3 text-xs text-slate-400 italic">
                          {q.question_type === "long_answer" ? "[ Use additional sheet if needed ]" :
                            q.question_type === "fill_blank" ? "" :
                            "[ Answer in space provided ]"}
                        </div>
                      )}

                      {/* Answer key (toggleable, hidden by default) */}
                      {showAnswers && q.correct_answer && (
                        <div className="mt-2 p-2 rounded border border-emerald-300 bg-emerald-50 text-xs">
                          <div className="font-bold text-emerald-900">Answer key:</div>
                          <div className="text-slate-800 whitespace-pre-wrap">{q.correct_answer}</div>
                          {q.explanation && <div className="text-slate-600 mt-1"><em>Note: {q.explanation}</em></div>}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          );
        })}

        <div className="mt-8 text-center text-xs text-slate-400">— END OF PAPER —</div>
      </div>
    </>
  );
}
