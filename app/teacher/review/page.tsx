"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { BLOOM_META } from "@/lib/bloom";
import type { Question } from "@/lib/types";
import BloomBadge from "@/components/BloomBadge";
import Empty from "@/components/Empty";
import { Check, X, Save, CheckSquare, Square } from "lucide-react";

export default function ReviewPage() {
  const [items, setItems] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState<Record<string, Partial<Question>>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());

  async function load() {
    setLoading(true);
    const sb = supabaseBrowser();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { setLoading(false); return; }
    // Use the service-role /api/teacher/question-bank endpoint instead of
    // reading question_bank directly — the user-token client raced RLS
    // and was returning an empty list even when the dashboard KPI
    // correctly showed pending rows.
    const r = await fetch("/api/teacher/question-bank?status=pending", {
      headers: { Authorization: `Bearer ${session.access_token}` },
      cache: "no-store",
    });
    if (r.ok) {
      const j = await r.json() as { items: Question[] };
      setItems(j.items || []);
    } else {
      setItems([]);
    }
    setSelected(new Set());
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  function setField(id: string, patch: Partial<Question>) {
    setEdits((e) => ({ ...e, [id]: { ...e[id], ...patch } }));
  }

  function toggleSelected(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  const allSelected = items.length > 0 && selected.size === items.length;
  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)));
  }

  async function bulkSetStatus(status: "approved" | "rejected") {
    if (!selected.size) return;
    const verb = status === "approved" ? "Approve" : "Reject";
    if (!confirm(`${verb} ${selected.size} selected question${selected.size === 1 ? "" : "s"}?`)) return;
    const sb = supabaseBrowser();
    const ids = Array.from(selected);
    // Apply pending edits one-by-one, then batch the rest in a single update
    const dirty = ids.filter((id) => edits[id]);
    for (const id of dirty) {
      await sb.from("question_bank").update({ ...edits[id], status }).eq("id", id);
    }
    const clean = ids.filter((id) => !edits[id]);
    if (clean.length) {
      await sb.from("question_bank").update({ status }).in("id", clean);
    }
    setEdits({});
    await load();
  }

  async function save(q: Question) {
    const sb = supabaseBrowser();
    const patch = edits[q.id] || {};
    await sb.from("question_bank").update(patch).eq("id", q.id);
    setEdits((e) => { const { [q.id]: _, ...rest } = e; return rest; });
    await load();
  }

  async function setStatus(q: Question, status: "approved" | "rejected") {
    const sb = supabaseBrowser();
    const patch = { ...(edits[q.id] || {}), status };
    await sb.from("question_bank").update(patch).eq("id", q.id);
    setEdits((e) => { const { [q.id]: _, ...rest } = e; return rest; });
    await load();
  }

  async function approveAll() {
    if (!items.length) return;
    if (!confirm(`Approve all ${items.length} pending questions?`)) return;
    const sb = supabaseBrowser();
    await sb.from("question_bank").update({ status: "approved" }).in("id", items.map((i) => i.id));
    await load();
  }

  if (loading) return <div className="grid place-items-center py-20"><div className="spinner" /></div>;

  if (items.length === 0) {
    // Empty state used to have a "Generate questions" CTA, but the
    // sidebar already exposes Generate Questions one click away —
    // duplicating it here added clutter without changing reachability.
    // Keep the empty state purely informational.
    return (
      <Empty
        icon="✅"
        title="Nothing to review"
        body="Your AI-drafted question queue is empty. Use Generate Questions in the sidebar when you want to draft more."
      />
    );
  }

  return (
    <div className="max-w-4xl mx-auto fade-in">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="h1">Review pending questions</h1>
          <p className="muted mt-1">
            {items.length} awaiting review
            {selected.size > 0 ? ` · ${selected.size} selected` : " · edit before approving"}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" className="btn btn-secondary" onClick={toggleSelectAll}>
            {allSelected ? <CheckSquare size={16} /> : <Square size={16} />}
            {allSelected ? "Deselect all" : "Select all"}
          </button>
          {selected.size > 0 ? (
            <>
              <button type="button" className="btn btn-danger" onClick={() => bulkSetStatus("rejected")}>
                <X size={16} /> Reject {selected.size}
              </button>
              <button type="button" className="btn btn-primary" onClick={() => bulkSetStatus("approved")}>
                <Check size={16} /> Approve {selected.size}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={approveAll}>Approve all</button>
          )}
        </div>
      </div>

      <div className="space-y-4 mt-6">
        {items.map((q) => {
          const e = edits[q.id] || {};
          const stem = e.stem ?? q.stem;
          const opts = (e.options as string[] | undefined) ?? q.options;
          const correct = (e.correct_index as number | undefined) ?? q.correct_index;
          const explanation = (e.explanation as string | null | undefined) ?? q.explanation;
          const dirty = !!edits[q.id];

          return (
            <div key={q.id} className={`card ${selected.has(q.id) ? "ring-2 ring-emerald-400" : ""}`}>
              <div className="flex items-center gap-3 mb-3">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-emerald-600 cursor-pointer"
                  checked={selected.has(q.id)}
                  onChange={() => toggleSelected(q.id)}
                  aria-label="Select question"
                />
                <BloomBadge level={q.bloom_level} />
                <span className="text-xs muted">{BLOOM_META[q.bloom_level].description}</span>
                {q.topic && <span className="text-xs muted ml-auto">Topic: {q.topic}</span>}
              </div>

              <label className="label">Question</label>
              <textarea
                className="textarea"
                rows={6}
                style={{ resize: "vertical", minHeight: "5rem", fieldSizing: "content" } as React.CSSProperties}
                value={stem}
                onChange={(ev) => setField(q.id, { stem: ev.target.value })}
              />

              <div className="grid sm:grid-cols-2 gap-3 mt-3">
                {opts.map((o, i) => (
                  <label key={i}
                    className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition ${
                      correct === i ? "border-emerald-500 bg-emerald-50" : "border-slate-200 hover:bg-slate-50"
                    }`}>
                    <input
                      type="radio"
                      name={`c-${q.id}`}
                      checked={correct === i}
                      onChange={() => setField(q.id, { correct_index: i })}
                      className="mt-1"
                    />
                    <input
                      className="flex-1 bg-transparent outline-none text-sm"
                      value={o}
                      onChange={(ev) => {
                        const next = [...opts]; next[i] = ev.target.value;
                        setField(q.id, { options: next });
                      }}
                    />
                  </label>
                ))}
              </div>

              <label className="label mt-4">Explanation</label>
              <textarea
                className="textarea"
                rows={4}
                style={{ resize: "vertical", minHeight: "4rem", fieldSizing: "content" } as React.CSSProperties}
                value={explanation || ""}
                onChange={(ev) => setField(q.id, { explanation: ev.target.value })}
              />

              <div className="flex items-center gap-2 mt-4 justify-end">
                {dirty && (
                  <button type="button" className="btn btn-secondary" onClick={() => save(q)}>
                    <Save size={16} /> Save
                  </button>
                )}
                <button type="button"
                  className="btn btn-primary"
                  onClick={() => approve(q.id)}
                  title="Approve and add to your bank"
                >
                  <Check size={16} /> Approve
                </button>
                <button type="button"
                  className="btn btn-ghost text-red-600"
                  onClick={() => reject(q.id)}
                  title="Reject and remove"
                >
                  <X size={16} /> Reject
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
