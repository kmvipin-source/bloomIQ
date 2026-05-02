"use client";

import { useEffect, useState } from "react";
import { Inbox, CheckCircle2, XCircle, Clock } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";

type RetakeRequest = {
  id: string;
  assignment_id: string;
  status: "pending" | "approved" | "denied";
  note: string | null;
  decision_note: string | null;
  created_at: string;
  decided_at: string | null;
  quiz: { id: string; name: string; code: string };
  student_name: string;
};

export default function TeacherRetakeRequests() {
  const [items, setItems] = useState<RetakeRequest[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [decisionNote, setDecisionNote] = useState<Record<string, string>>({});
  // Per-request "new due date/time" picker. Pre-fills to "+7 days from
  // now" when the input first renders; submitted as new_due_at on
  // approve.
  const [newDueAt, setNewDueAt] = useState<Record<string, string>>({});

  async function load() {
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return;
      const r = await fetch("/api/teacher/retake-requests", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      const j = await r.json();
      if (r.ok) setItems(j.requests as RetakeRequest[]);
    } catch { /* silent */ }
  }
  useEffect(() => { load(); }, []);

  async function decide(id: string, decision: "approve" | "deny") {
    setBusy(id);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Session expired.");
      const r = await fetch(`/api/teacher/retake-requests/${id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          decision,
          note: decisionNote[id] || "",
          // Only meaningful on approve. Server validates it parses
          // and is in the future.
          new_due_at: decision === "approve" ? (newDueAt[id] || "") : "",
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Failed");
      toast.success(decision === "approve" ? "Request approved — quiz reopened." : "Request denied.");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  if (!items) return null;
  const pending = items.filter((i) => i.status === "pending");
  if (items.length === 0) return null;

  return (
    <div className="card mt-6">
      <div className="flex items-center gap-2 mb-3">
        <Inbox size={18} className="text-emerald-700" />
        <h2 className="font-bold text-lg">Retake requests</h2>
        {pending.length > 0 && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-semibold">
            {pending.length} pending
          </span>
        )}
      </div>

      {pending.length === 0 ? (
        <p className="text-sm muted">No pending requests.</p>
      ) : (
        <ul className="divide-y" style={{ borderColor: "var(--color-border)" }}>
          {pending.map((it) => (
            <li key={it.id} className="py-3 space-y-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-semibold">{it.student_name}</span>
                <span className="text-xs muted">requested retake of</span>
                <span className="font-medium">{it.quiz.name}</span>
                <span className="text-xs muted font-mono">({it.quiz.code})</span>
              </div>
              {it.note && (
                <blockquote className="text-sm pl-3 border-l-2 border-emerald-400 italic text-slate-700">
                  &quot;{it.note}&quot;
                </blockquote>
              )}
              <input
                className="input text-xs"
                placeholder="Optional reply note (visible to student)"
                value={decisionNote[it.id] || ""}
                onChange={(e) => setDecisionNote((m) => ({ ...m, [it.id]: e.target.value }))}
                maxLength={500}
              />
              {/* New due date/time — teacher can pick exactly when the
                  extended assignment closes. Defaults to +7 days from
                  now if they don't change it. */}
              <div className="flex items-center gap-2 flex-wrap">
                <label className="text-xs muted shrink-0">New due date &amp; time</label>
                <input
                  type="datetime-local"
                  className="input text-xs"
                  value={
                    newDueAt[it.id] ||
                    (() => {
                      const d = new Date(Date.now() + 7 * 86400000);
                      const pad = (n: number) => String(n).padStart(2, "0");
                      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
                    })()
                  }
                  onChange={(e) => setNewDueAt((m) => ({ ...m, [it.id]: e.target.value }))}
                />
              </div>
              <div className="flex gap-2">
                <button
                  className="btn btn-primary text-xs inline-flex items-center gap-1.5"
                  disabled={busy === it.id}
                  onClick={() => decide(it.id, "approve")}
                >
                  <CheckCircle2 size={12} /> Approve</button>
                <button
                  className="btn btn-secondary text-xs inline-flex items-center gap-1.5"
                  disabled={busy === it.id}
                  onClick={() => decide(it.id, "deny")}
                >
                  <XCircle size={12} /> Deny
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Recently decided — collapsed view */}
      {items.some((i) => i.status !== "pending") && (
        <details className="mt-3">
          <summary className="text-xs muted cursor-pointer">
            Recently decided ({items.filter((i) => i.status !== "pending").length})
          </summary>
          <ul className="mt-2 space-y-1 text-xs">
            {items.filter((i) => i.status !== "pending").slice(0, 10).map((it) => (
              <li key={it.id} className="flex items-center gap-2">
                {it.status === "approved" ? <CheckCircle2 size={12} className="text-emerald-700" /> : <XCircle size={12} className="text-red-700" />}
                <span className="font-medium">{it.student_name}</span>
                <span className="muted">— {it.quiz.name}</span>
                <span className="muted ml-auto">{it.decided_at ? new Date(it.decided_at).toLocaleDateString() : ""}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
