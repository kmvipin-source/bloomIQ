"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  Sparkles, Send, RotateCcw, AlertCircle, ArrowLeft, MessageCircle,
} from "lucide-react";

// =============================================================================
// /teacher/coach — Teacher AI Coach
// -----------------------------------------------------------------------------
// Chat-style page that lets a teacher ask questions about their classes' quiz
// performance. Posts to /api/teacher/coach with the bearer token; appends each
// reply to a local history. Renders a typing-dots state while waiting and shows
// suggested-question chips when there's no history yet.
// =============================================================================

type Turn = { role: "user" | "assistant"; content: string };
type Snapshot = {
  asOf: string;
  totals: {
    classes: number;
    students: number;
    quizzes_owned: number;
    attempts_30d: number;
    avg_score_30d: number | null;
  };
};

const SUGGESTIONS = [
  "Which student should I worry about?",
  "What's my class's weakest Bloom level?",
  "Suggest a question for tomorrow's lesson",
  "Where am I making good progress?",
];

function relativeFromNow(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(ms / 3_600_000);
  if (hrs >= 1) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const mins = Math.floor(ms / 60_000);
  if (mins >= 1) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  return "just now";
}

export default function TeacherCoachPage() {
  const [history, setHistory] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to the bottom whenever the history grows or we start typing.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [history, busy]);

  // Auto-grow the textarea up to a sensible cap.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [draft]);

  async function sendMessage(messageOverride?: string) {
    const message = (messageOverride ?? draft).trim();
    if (!message || busy) return;
    setErr(null);
    setRetryMessage(null);
    setBusy(true);
    const nextHistory: Turn[] = [...history, { role: "user", content: message }];
    setHistory(nextHistory);
    setDraft("");

    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("You're signed out — please log in again.");

      const res = await fetch("/api/teacher/coach", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          message,
          // Only ship the prior turns (not the message we just added).
          history: history.slice(-10),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json?.error || `Coach request failed (${res.status}).`);
      }
      const reply: string = typeof json.reply === "string" ? json.reply : "";
      if (json.contextSnapshot) setSnapshot(json.contextSnapshot as Snapshot);
      setHistory([...nextHistory, { role: "assistant", content: reply || "(no reply)" }]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Coach failed to reply.");
      setRetryMessage(message);
      // Roll back the user message so retry is straightforward.
      setHistory(history);
      setDraft(message);
    } finally {
      setBusy(false);
      // After a send completes (success OR failure), put focus back on the
      // textarea so the teacher can type the next question without first
      // having to click the input again. Without this, the click target is
      // sometimes hard to land on (especially when scroll has shifted),
      // which made the second message look like the chat was broken.
      // queueMicrotask so React commits the disabled→enabled transition
      // before we focus.
      queueMicrotask(() => textareaRef.current?.focus());
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      sendMessage();
    }
  }

  function reset() {
    if (busy) return;
    if (history.length === 0) return;
    if (!confirm("Reset the conversation? This clears all messages.")) return;
    setHistory([]);
    setErr(null);
    setRetryMessage(null);
    setDraft("");
  }

  const empty = history.length === 0;

  return (
    <div className="max-w-4xl mx-auto fade-in flex flex-col" style={{ minHeight: "calc(100vh - 4rem)" }}>
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <Link href="/teacher" className="muted text-xs inline-flex items-center gap-1 hover:underline">
            <ArrowLeft size={12} /> Back to dashboard
          </Link>
          <h1 className="h1 flex items-center gap-2 mt-1">
            <MessageCircle size={28} /> Teacher Coach
          </h1>
          <p className="muted mt-1">Ask anything about your classes.</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button"
            className="btn btn-ghost"
            onClick={reset}
            disabled={busy || history.length === 0}
            title="Clear the conversation"
          >
            <RotateCcw size={14} /> Reset
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 mt-6 space-y-4 overflow-y-auto pr-1"
        style={{ minHeight: 320 }}
      >
        {empty ? (
          <EmptyState onPick={(q) => sendMessage(q)} disabled={busy} />
        ) : (
          history.map((t, i) => (
            <Bubble key={i} role={t.role} content={t.content} />
          ))
        )}
        {busy && <TypingBubble />}
      </div>

      {/* Error banner */}
      {err && (
        <div className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-start gap-2">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-semibold">Couldn&rsquo;t reach the coach</div>
            <div className="text-xs mt-0.5">{err}</div>
          </div>
          {retryMessage && (
            <button type="button"
              className="btn btn-ghost text-xs"
              onClick={() => sendMessage(retryMessage)}
              disabled={busy}
            >
              Retry
            </button>
          )}
        </div>
      )}

      {/* Composer */}
      <div className="mt-4 sticky bottom-0">
        {empty && (
          <div className="flex flex-wrap gap-2 mb-3">
            {SUGGESTIONS.map((s) => (
              <button type="button"
                key={s}
                className="btn btn-ghost text-xs border border-slate-200 rounded-full"
                onClick={() => sendMessage(s)}
                disabled={busy}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            className="textarea flex-1 min-h-[44px] resize-none"
            placeholder="Ask the coach a question…  (Cmd/Ctrl+Enter to send)"
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, 1000))}
            onKeyDown={onKeyDown}
            disabled={busy}
            rows={1}
          />
          <button type="button"
            className="btn btn-primary"
            onClick={() => sendMessage()}
            disabled={busy || !draft.trim()}
            title="Send (Cmd/Ctrl+Enter)"
          >
            {busy ? <span className="spinner" /> : <><Send size={14} /> Send</>}
          </button>
        </div>
        <p className="muted text-xs mt-3 text-center">
          Coach answers reflect your students&rsquo; data as of {snapshot ? relativeFromNow(snapshot.asOf) : "your last question"}.
          The Coach can be wrong &mdash; verify before acting.
        </p>
      </div>
    </div>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

function EmptyState({
  onPick, disabled,
}: { onPick: (q: string) => void; disabled: boolean }) {
  return (
    <div className="card text-center py-10">
      <div className="w-14 h-14 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-600 text-white grid place-items-center mx-auto mb-3">
        <Sparkles size={26} />
      </div>
      <h2 className="text-lg font-semibold">Your classroom co-pilot</h2>
      <p className="muted text-sm mt-1 max-w-md mx-auto">
        I&rsquo;ve already pulled this week&rsquo;s scores, top students, and
        at-risk signals across your classes. Ask anything &mdash; I&rsquo;ll cite the numbers.
      </p>
      <div className="flex flex-wrap gap-2 justify-center mt-5 max-w-lg mx-auto">
        {SUGGESTIONS.map((s) => (
          <button type="button"
            key={s}
            className="btn btn-ghost text-xs border border-slate-200 rounded-full"
            onClick={() => onPick(s)}
            disabled={disabled}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function Bubble({ role, content }: { role: "user" | "assistant"; content: string }) {
  if (role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] bg-slate-100 text-slate-900 px-4 py-2 rounded-2xl rounded-br-sm whitespace-pre-wrap text-sm">
          {content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start gap-2">
      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-600 text-white grid place-items-center flex-shrink-0">
        <Sparkles size={16} />
      </div>
      <div className="max-w-[80%] bg-white border border-slate-200 px-4 py-2 rounded-2xl rounded-bl-sm whitespace-pre-wrap text-sm">
        {content}
      </div>
    </div>
  );
}

function TypingBubble() {
  return (
    <div className="flex justify-start gap-2">
      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-600 text-white grid place-items-center flex-shrink-0">
        <Sparkles size={16} />
      </div>
      <div className="bg-white border border-slate-200 px-4 py-3 rounded-2xl rounded-bl-sm">
        <div className="flex items-center gap-1">
          <span className="dot" />
          <span className="dot" style={{ animationDelay: "150ms" }} />
          <span className="dot" style={{ animationDelay: "300ms" }} />
        </div>
        <style jsx>{`
          .dot {
            display: inline-block;
            width: 6px;
            height: 6px;
            background-color: #94a3b8;
            border-radius: 9999px;
            animation: blink 1s infinite ease-in-out;
          }
          @keyframes blink {
            0%, 80%, 100% { opacity: 0.2; transform: translateY(0); }
            40% { opacity: 1; transform: translateY(-2px); }
          }
        `}</style>
      </div>
    </div>
  );
}
