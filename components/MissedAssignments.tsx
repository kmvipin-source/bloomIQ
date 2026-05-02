"use client";

import { useEffect, useState } from "react";
import { AlarmClock, Send, CheckCircle2, XCircle, Clock } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";

type Item = {
  assignment_id: string;
  quiz: { id: string; name: string; code: string };
  due_at: string;
  teacher_name: string;
  request: { id: string; status: "pending" | "approved" | "denied"; decision_note: string | null } | null;
};

export default function MissedAssignments() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return;
      const r = await fetch("/api/student/missed-assignments", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      const j = await r.json();
      if (r.ok) setItems(j.items as Item[]);
    } catch { /* silent */ }
  }
  useEffect(() => { load(); }, []);

  async function submitRequest(assignmentId: string) {
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Session expired.");
      const r = await fetch("/api/student/retake-request", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ assignment_id: assignmentId, note: note.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Failed");
      toast.success("Request sent to your teacher.");
      setOpenId(null);
      setNote("");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to send request.");
    } finally {
      setBusy(false);
    }
  }

  if (!items || items.length === 0) return null;

  return (
    <div className="card mt-6 border-amber-200" style={{ background: "linear-gradient(135deg, #fffbeb, #fff)" }}>
      <div className="flex items-center gap-2 mb-3">
        <AlarmClock size={18} className="text-amber-700" />
        <h2 className="font-bold text-lg">Missed quizzes</h2>
        <span className="text-xs muted">{items.length} pending</span>
      </div>
      <p className="text-xs muted mb-3">Past the due date but not attempted. Send a note to the teacher who set it.</p>

      <ul className="divide-y" style={{ borderColor: "var(--color-border)" }}>
        {items.map((it) => {
          const dueLocal = new Date(it.due_at).toLocaleString();
          const status = it.request?.status;
          return (
            <li key={it.assignment_id} className="py-3 flex flex-wrap items-start gap-3">
              <div className="flex-1 min-w-[220px]">
                <div className="font-semibold">{it.quiz.name}</div>
                <div className="text-xs muted mt-0.5">
                  Code <span className="font-mono">{it.quiz.code}</span> · Due {dueLocal} · Set by {it.teacher_name}
                </div>
                {it.request && (
                  <div className="text-xs mt-1.5">
                    {status === "pending" && <span className="inline-flex items-center gap-1 text-amber-700"><Clock size={12} /> Request pending</span>}
                    {status === "approved" && <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 size={12} /> Approved — quiz reopened</span>}
                    {status === "denied" && <span className="inline-flex items-center gap-1 text-red-700"><XCircle size={12} /> Denied{it.request.decision_note ? ` — ${it.request.decision_note}` : ""}</span>}
                  </div>
                )}
              </div>
              {!it.request && (
                <div className="shrink-0">
                  {openId === it.assignment_id ? (
                    <div className="flex flex-col gap-2 w-full sm:w-[320px]">
                      <textarea
                        className="input"
                        rows={2}
                        placeholder="Note to teacher (e.g. I'd like to take it on Monday)"
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        maxLength={500}
                      />
                      <div className="flex gap-2">
                        <button
                          className="btn btn-primary text-xs inline-flex items-center gap-1.5 flex-1"
                          disabled={busy || note.trim().length < 5}
                          onClick={() => submitRequest(it.assignment_id)}
                        >
                          <Send size={12} /> Send request
                        </button>
                        <button
                          className="btn btn-secondary text-xs"
                          disabled={busy}
                          onClick={() => { setOpenId(null); setNote(""); }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="btn btn-secondary text-xs inline-flex items-center gap-1.5"
                      onClick={() => { setOpenId(it.assignment_id); setNote(""); }}
                    >
                      <Send size={12} /> Request to take
                    </button>
                  )}
                </div>
              )}
              {it.request?.status === "approved" && (
                <a
                  href={`/student/quiz/${it.quiz.code}`}
                  className="btn btn-primary text-xs inline-flex items-center gap-1.5"
                >
                  Take now
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
