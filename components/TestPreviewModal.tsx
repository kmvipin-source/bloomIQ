"use client";

/**
 * TestPreviewModal — Finding #68 (Round 14).
 *
 * Renders the in-progress test as a student will see it: stem + 4 lettered
 * options per question, NO correct-answer highlighting, with the test
 * name + time limit in the modal header. Backdrop click + Esc both close.
 *
 * Why a standalone file (not inline JSX in the composer):
 *   The first attempt at this lived inline in app/teacher/quizzes/new/page.tsx
 *   and the modal markup ended up inserted at the wrong function boundary
 *   (it landed inside ClassFitCard rather than ComposerInner). Extracting
 *   to its own file means the composer just renders <TestPreviewModal/>
 *   from its existing JSX tree — no risk of breaking the surrounding
 *   structure.
 */

import { useEffect } from "react";
import { Clock, X } from "lucide-react";

export type PreviewQuestion = {
  id: string;
  stem: string;
  options: string[];
  topic?: string | null;
};

export default function TestPreviewModal({
  open,
  onClose,
  name,
  timeLimitMinutes,
  questions,
}: {
  open: boolean;
  onClose: () => void;
  name: string;
  timeLimitMinutes: number;
  questions: PreviewQuestion[];
}) {
  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Preview test as student"
    >
      <div
        className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-slate-200 bg-slate-50">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Student preview</div>
            <h2 className="text-lg font-bold text-slate-900">{name.trim() || "(untitled test)"}</h2>
          </div>
          <div className="text-xs text-slate-600 flex items-center gap-3">
            <span className="inline-flex items-center gap-1"><Clock size={12} />{timeLimitMinutes} min</span>
            <span>{questions.length} question{questions.length === 1 ? "" : "s"}</span>
            <button
              type="button"
              onClick={onClose}
              className="ml-2 p-1.5 hover:bg-slate-200 rounded text-slate-600"
              title="Close (Esc)"
              aria-label="Close preview"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="overflow-y-auto px-5 py-4 space-y-5">
          {questions.length === 0 ? (
            <div className="text-center py-10 text-sm text-slate-500">No questions selected yet.</div>
          ) : (
            questions.map((q, i) => (
              <div key={q.id} className="border border-slate-200 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2 text-xs text-slate-500">
                  <span className="font-semibold">Question {i + 1} of {questions.length}</span>
                  {q.topic && <span>· {q.topic}</span>}
                </div>
                <div className="text-slate-900 font-medium leading-relaxed mb-3 whitespace-pre-wrap">{q.stem}</div>
                <ol className="space-y-2">
                  {(q.options || []).map((opt, oi) => (
                    <li
                      key={oi}
                      className="flex items-start gap-2 p-2 rounded border border-slate-200 hover:bg-slate-50 cursor-default"
                    >
                      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full border border-slate-300 text-xs font-semibold text-slate-600 shrink-0 mt-0.5">
                        {"ABCD"[oi]}
                      </span>
                      <span className="text-sm text-slate-800">{opt}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ))
          )}
        </div>
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-slate-200 bg-slate-50 text-xs">
          <span className="text-slate-500">
            This is a preview — students won&apos;t see correct answers. Submit happens at the end of the real test.
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
          >
            Close preview
          </button>
        </div>
      </div>
    </div>
  );
}
