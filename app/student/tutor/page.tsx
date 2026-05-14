"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  Bot, Send, ArrowLeft, Loader2, Sparkles, MessageSquare, Trash2, Crown,
} from "lucide-react";
import { useFeatureAccess } from "@/lib/featureAccess";

// =============================================================================
// DOUBT-CLEARING AI TUTOR — Socratic chat. Stateless on the server (each turn
// re-sends history). Optionally anchored to a specific question_id passed via
// ?question_id=... (so a "Help me understand" button on a quiz page can deep-
// link straight here). v1 keeps the chat in component state — refresh wipes
// it, which keeps the surface tiny.
// =============================================================================

type Turn = { role: "user" | "assistant"; content: string };

type AnchorContext = {
  question_stem?: string;
  options?: string[];
  correct_index?: number;
  topic?: string;
};

function TutorInner() {
  const search = useSearchParams();
  const questionId = search.get("question_id");

  // Doubt-Clearing AI Tutor is a premium feature (key: ai_tutor_text). The
  // /student/train tile already shows a PREMIUM badge; the page itself was
  // unlocked, which let free users in by deep-linking. Gate here so both
  // surfaces agree.
  const access = useFeatureAccess();
  const allowed = access.allowed.has("ai_tutor_text");

  const [context, setContext] = useState<AnchorContext | null>(null);
  const [loadingCtx, setLoadingCtx] = useState(false);
  const [history, setHistory] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load anchor context (a specific question) if deep-linked.
  useEffect(() => {
    if (!questionId) return;
    setLoadingCtx(true);
    (async () => {
      const sb = supabaseBrowser();
      const { data } = await sb
        .from("question_bank")
        .select("topic, stem, options, correct_index")
        .eq("id", questionId)
        .maybeSingle();
      if (data) {
        setContext({
          question_stem: (data as { stem: string }).stem,
          options: (data as { options: string[] }).options,
          correct_index: (data as { correct_index: number }).correct_index,
          topic: (data as { topic: string | null }).topic ?? undefined,
        });
      }
      setLoadingCtx(false);
    })();
  }, [questionId]);

  // Auto-scroll to bottom on new turn.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [history, busy]);

  async function send() {
    const message = input.trim();
    if (!message) return;
    setErr(null);
    const newHistory: Turn[] = [...history, { role: "user", content: message }];
    setHistory(newHistory);
    setInput("");
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired — please sign in again.");
      const r = await fetch("/api/tutor/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          context: context || undefined,
          history: newHistory.slice(0, -1),  // server expects history *up to* the new message
          message,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Tutor failed");
      setHistory((h) => [...h, { role: "assistant", content: j.reply as string }]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Tutor failed");
      // Roll back the optimistic user turn so they can edit + retry.
      setHistory((h) => h.slice(0, -1));
      setInput(message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setHistory([]);
    setErr(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  // 2026-05-13: spinner while access resolves so the chat shell doesn't
  // briefly flash for users who'll be redirected to the paywall card.
  if (access.isLoading) {
    return <div className="grid place-items-center py-20"><div className="spinner" /></div>;
  }

  if (!allowed) {
    return (
      <div className="max-w-2xl mx-auto fade-in">
        <Link href="/student" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-emerald-700 mb-3">
          <ArrowLeft size={14} /> Back to dashboard
        </Link>
        <div className="card text-center">
          <div className="mx-auto w-14 h-14 rounded-full bg-indigo-100 grid place-items-center">
            <Bot size={26} className="text-indigo-700" />
          </div>
          <h1 className="h1 mt-3">Doubt-Clearing AI Tutor</h1>
          <p className="muted mt-2">
            A 24/7 Socratic tutor that walks you through concepts step by step — no answer dumps.
          </p>
          <div className="mt-4 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 text-xs font-semibold">
            <Crown size={12} /> Available on Premium and Premium Plus
          </div>
          <div className="mt-5">
            <Link href="/pricing" className="btn btn-primary inline-flex items-center gap-2">
              <Sparkles size={14} /> See Premium plans
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto fade-in">
      <Link href="/student" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-emerald-700 mb-3">
        <ArrowLeft size={14} /> Back to dashboard
      </Link>

      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-indigo-100 text-indigo-700 p-3 shrink-0">
          <Bot size={22} />
        </div>
        <div className="flex-1">
          <h1 className="h1">Doubt-Clearing AI Tutor</h1>
          <p className="muted mt-1">
            Stuck on a concept? Chat through it. The tutor is Socratic — it asks back, walks you through, doesn&apos;t
            just dump the answer.
          </p>
        </div>
      </div>

      {/* Anchor context banner if deep-linked */}
      {questionId && (
        <div className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50/60 p-3 text-sm">
          <div className="text-xs uppercase tracking-wide font-semibold text-indigo-800 mb-1">Anchor question</div>
          {loadingCtx && <span className="text-slate-700 inline-flex items-center gap-2"><Loader2 className="animate-spin" size={14} /> Loading…</span>}
          {!loadingCtx && context && (
            <>
              <div className="font-medium">{context.question_stem}</div>
              {context.options && (
                <ul className="mt-2 text-xs text-slate-700 space-y-0.5">
                  {context.options.map((o, i) => (
                    <li key={i}>
                      <strong>{String.fromCharCode(65 + i)}.</strong> {o}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {!loadingCtx && !context && (
            <span className="muted">Couldn&apos;t load that question — chatting freeform.</span>
          )}
        </div>
      )}

      {/* Chat area */}
      <div ref={scrollRef} className="card mt-4 h-[440px] overflow-y-auto p-4 space-y-3">
        {history.length === 0 ? (
          <div className="text-center py-12 muted text-sm">
            <Sparkles size={20} className="mx-auto text-indigo-500 mb-2" />
            <p>Type your doubt below to start. Try things like:</p>
            <ul className="mt-2 text-xs space-y-1">
              <li>&ldquo;I don&apos;t get why kinetic energy has a 1/2 in front of mv²&rdquo;</li>
              <li>&ldquo;What&apos;s the difference between mitosis and meiosis?&rdquo;</li>
              <li>&ldquo;Why does my answer to question 3 keep coming wrong?&rdquo;</li>
            </ul>
          </div>
        ) : (
          history.map((t, i) => (
            <div
              key={i}
              className={`flex ${t.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap ${
                  t.role === "user"
                    ? "bg-emerald-600 text-white rounded-br-sm"
                    : "bg-slate-100 text-slate-900 rounded-bl-sm"
                }`}
              >
                {t.content}
              </div>
            </div>
          ))
        )}
        {busy && (
          <div className="flex justify-start">
            <div className="bg-slate-100 text-slate-700 rounded-2xl rounded-bl-sm px-3.5 py-2 text-sm inline-flex items-center gap-2">
              <Loader2 className="animate-spin" size={14} /> Thinking…
            </div>
          </div>
        )}
      </div>

      {err && (
        <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>
      )}

      {/* Composer */}
      <div className="mt-3 card p-3">
        <textarea
          className="textarea min-h-[70px]"
          placeholder="Ask anything — your doubt, a question type that's tripping you up, a concept that's foggy."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={2000}
          disabled={busy}
        />
        <div className="flex items-center justify-between mt-2 flex-wrap gap-2">
          <p className="text-xs muted">Enter to send · Shift+Enter for new line · {input.length}/2000</p>
          <div className="flex gap-2">
            {history.length > 0 && (
              <button type="button" className="btn btn-secondary" onClick={reset} disabled={busy}>
                <Trash2 size={14} /> Clear
              </button>
            )}
            <button type="button" className="btn btn-primary" onClick={send} disabled={busy || !input.trim()}>
              {busy ? <><Loader2 className="animate-spin" size={14} /> Sending…</> : <><Send size={14} /> Send</>}
            </button>
          </div>
        </div>
      </div>

      <p className="muted text-xs mt-4 inline-flex items-center gap-1">
        <MessageSquare size={11} /> v1: chat resets when you leave the page. Persisted history is on the backlog.
      </p>
    </div>
  );
}

export default function TutorPage() {
  return (
    <Suspense fallback={<div className="grid place-items-center py-20"><div className="spinner" /></div>}>
      <TutorInner />
    </Suspense>
  );
}
