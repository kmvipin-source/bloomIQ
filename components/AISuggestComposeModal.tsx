"use client";

/**
 * AISuggestComposeModal — Finding #71 (Round 14).
 *
 * One-button "Suggest a test for me" flow for teachers. The teacher tells
 * us: which class, target Bloom mix (broad / mid / deep), and how many
 * questions. The server returns a curated list of question IDs from the
 * teacher's existing question bank, picked with diversity heuristics
 * (mix of Bloom levels + topic spread). The teacher confirms and the
 * IDs land in the composer's `selectedIds` state.
 *
 * Why standalone: keeps the composer's JSX tree untouched.
 *
 * Wiring contract (caller does):
 *   const [aiOpen, setAiOpen] = useState(false);
 *   <button onClick={() => setAiOpen(true)}>Suggest a test</button>
 *   <AISuggestComposeModal
 *     open={aiOpen}
 *     onClose={() => setAiOpen(false)}
 *     classes={classes}
 *     defaultClassId={targetClassId}
 *     onApply={(ids) => setSelectedIds(ids)}
 *   />
 */

import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";

type ClassOption = {
  id: string;
  name: string;
  grade?: string | null;
  section?: string | null;
  subject?: string | null;
};

type Depth = "broad" | "mid" | "deep";

export default function AISuggestComposeModal({
  open,
  onClose,
  classes,
  defaultClassId,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  classes: ClassOption[];
  defaultClassId: string;
  onApply: (questionIds: string[]) => void;
}) {
  const [classId, setClassId] = useState(defaultClassId || "");
  const [depth, setDepth] = useState<Depth>("mid");
  const [count, setCount] = useState(10);
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [previewIds, setPreviewIds] = useState<string[] | null>(null);
  const [previewMeta, setPreviewMeta] = useState<{
    bloom_breakdown?: Record<string, number>;
    topics?: string[];
    matched?: number;
    bank_size?: number;
  } | null>(null);

  // Reset state each time the modal opens fresh.
  useEffect(() => {
    if (open) {
      setClassId(defaultClassId || "");
      setDepth("mid");
      setCount(10);
      setTopic("");
      setErr(null);
      setPreviewIds(null);
      setPreviewMeta(null);
    }
  }, [open, defaultClassId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function suggest() {
    setBusy(true);
    setErr(null);
    setPreviewIds(null);
    setPreviewMeta(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in");

      const res = await fetch("/api/teacher/quiz-suggest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          class_id: classId || null,
          depth,
          count,
          topic: topic.trim() || null,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || "Suggestion failed");
      setPreviewIds(j.question_ids || []);
      setPreviewMeta({
        bloom_breakdown: j.bloom_breakdown,
        topics: j.topics,
        matched: j.matched,
        bank_size: j.bank_size,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Suggestion failed");
    } finally {
      setBusy(false);
    }
  }

  function apply() {
    if (!previewIds) return;
    onApply(previewIds);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="AI-suggested test composition"
    >
      <div
        className="bg-white rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-slate-200 bg-gradient-to-r from-purple-50 to-emerald-50">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-emerald-600 text-white">
              <Sparkles size={16} />
            </span>
            <div>
              <h2 className="text-base font-bold text-slate-900">Suggest a test for me</h2>
              <p className="text-xs text-slate-600">We&apos;ll pick from your approved question bank with a balanced mix.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 hover:bg-white/60 rounded text-slate-600" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {classes.length > 0 && (
            <div>
              <label className="label">Which class? <span className="muted text-xs">(optional)</span></label>
              <select
                className="select w-full"
                value={classId}
                onChange={(e) => setClassId(e.target.value)}
              >
                <option value="">All classes</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.grade ? ` · Grade ${c.grade}` : ""}{c.subject ? ` · ${c.subject}` : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="label">Topic focus <span className="muted text-xs">(optional)</span></label>
            <input
              className="input w-full"
              placeholder="e.g. Algebra, Photosynthesis — leave blank to span the whole bank"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
          </div>

          <div>
            <label className="label">Depth</label>
            <div className="grid grid-cols-3 gap-2">
              {([
                { id: "broad" as Depth, label: "Broad", desc: "Remember + Understand-heavy" },
                { id: "mid" as Depth, label: "Mid", desc: "Apply + Analyze-heavy" },
                { id: "deep" as Depth, label: "Deep", desc: "Analyze + Evaluate + Create" },
              ]).map((d) => {
                const on = depth === d.id;
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setDepth(d.id)}
                    className={`text-left p-2 rounded-lg border text-xs transition ${
                      on
                        ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-200"
                        : "border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    <div className="font-semibold text-sm">{d.label}</div>
                    <div className="text-slate-500">{d.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="label">How many questions?</label>
            <input
              type="number"
              min={3}
              max={40}
              className="input w-24"
              value={count}
              onChange={(e) => setCount(Math.max(3, Math.min(40, Number(e.target.value) || 10)))}
            />
            <p className="text-xs muted mt-1">Cap is 40 to keep the suggestion focused.</p>
          </div>

          {err && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>}

          {previewIds && (
            <div className="rounded-lg bg-emerald-50/60 border border-emerald-200 px-3 py-3 text-sm">
              <div className="font-semibold text-emerald-900 mb-1">
                Suggested {previewIds.length} of {count} requested
                {previewMeta?.bank_size != null && <span className="muted font-normal"> · from {previewMeta.bank_size} bank questions</span>}
              </div>
              {previewMeta?.bloom_breakdown && (
                <div className="text-xs text-slate-700 flex flex-wrap gap-2 mt-1">
                  {Object.entries(previewMeta.bloom_breakdown).map(([k, v]) => (
                    <span key={k} className="px-2 py-0.5 rounded-full bg-white border border-slate-200">{k}: {v}</span>
                  ))}
                </div>
              )}
              {previewMeta?.topics && previewMeta.topics.length > 0 && (
                <div className="text-xs text-slate-600 mt-2">
                  Topics: {previewMeta.topics.slice(0, 5).join(", ")}
                  {previewMeta.topics.length > 5 ? ` +${previewMeta.topics.length - 5} more` : ""}
                </div>
              )}
              {previewIds.length < count && (
                <div className="text-xs text-amber-700 mt-2">
                  Your bank had fewer matching questions than requested. Generate more on /teacher/generate, then retry.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 bg-slate-50">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
          {previewIds ? (
            <>
              <button type="button" className="btn btn-secondary btn-sm" onClick={suggest} disabled={busy}>
                {busy ? "..." : "Re-suggest"}
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={apply} disabled={previewIds.length === 0}>
                Apply to composer
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={suggest}
              disabled={busy}
            >
              {busy ? <><span className="spinner" /> Suggesting…</> : <><Sparkles size={14} /> Suggest</>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
