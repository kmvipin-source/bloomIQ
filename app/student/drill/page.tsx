"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Zap, ChevronRight, Check, X, ArrowLeft, RefreshCw } from "lucide-react";
import BloomBadge from "@/components/BloomBadge";
import type { BloomLevel } from "@/lib/bloom";

type DrillItem = {
  id: string;
  stem: string;
  options: string[];
  bloom_level: BloomLevel;
  topic: string | null;
};

type SubmitResult = {
  score: number;
  total: number;
  per_question: Array<{
    question_id: string;
    stem: string;
    is_correct: boolean;
    selected_index: number | null;
    correct_index: number | null;
    explanation: string | null;
  }>;
};

export default function DailyDrillPage() {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<DrillItem[]>([]);
  const [reason, setReason] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const [picks, setPicks] = useState<Record<string, number | null>>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true); setErr(null); setResult(null); setIdx(0); setPicks({});
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { setErr("Please sign in."); setLoading(false); return; }
      const res = await fetch("/api/student/daily-drill", {
        method: "GET",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load drill.");
      setItems((data.items as DrillItem[]) || []);
      setReason(data.reason || null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const current = items[idx];
  const allAnswered = useMemo(
    () => items.length > 0 && items.every((it) => picks[it.id] !== undefined),
    [items, picks]
  );

  function pick(i: number) {
    if (!current) return;
    setPicks((p) => ({ ...p, [current.id]: i }));
  }

  async function submit() {
    setSubmitting(true); setErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Please sign in.");
      const payload = {
        answers: items.map((it) => ({
          question_id: it.id,
          selected_index: picks[it.id] ?? null,
        })),
      };
      const res = await fetch("/api/student/daily-drill/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not submit.");
      setResult(data as SubmitResult);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Submit failed.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <div className="grid place-items-center py-20"><div className="spinner" /></div>;
  }

  return (
    <div className="max-w-3xl mx-auto fade-in">
      <Link href="/student" className="text-sm text-slate-500 hover:text-slate-800 inline-flex items-center gap-1">
        <ArrowLeft size={14} /> Back home
      </Link>
      <div className="flex items-center gap-3 mt-2">
        <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-amber-400 to-orange-500 text-white grid place-items-center">
          <Zap size={20} />
        </div>
        <div>
          <h1 className="h1">Today&apos;s smart drill</h1>
          <p className="muted text-sm">5 questions targeted at your weakest spots.</p>
        </div>
      </div>

      {err && (
        <div className="mt-6 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
          {err}
        </div>
      )}

      {/* Empty state */}
      {!result && items.length === 0 && (
        <div className="mt-8 card text-center py-12">
          <div className="text-4xl mb-2">🎯</div>
          <div className="font-semibold mb-1">No drill ready yet</div>
          <div className="muted text-sm">
            {reason === "no_data_yet"
              ? "Take a few quizzes first so we can spot your weakest areas."
              : "Come back tomorrow — we'll have a fresh drill ready."}
          </div>
          <div className="mt-4 flex items-center justify-center gap-2">
            <Link href="/student/practice" className="btn btn-primary">Try adaptive practice</Link>
            <button onClick={load} className="btn btn-secondary"><RefreshCw size={14} /> Refresh</button>
          </div>
        </div>
      )}

      {/* In-progress one-at-a-time */}
      {!result && current && (
        <div className="mt-6 card">
          <div className="flex items-center justify-between mb-4">
            <div className="text-xs muted uppercase tracking-wide font-semibold">
              Question {idx + 1} of {items.length}
            </div>
            <div className="flex gap-1">
              {items.map((it, i) => (
                <span
                  key={it.id}
                  className={`w-6 h-1.5 rounded-full ${
                    i < idx ? "bg-emerald-500"
                    : i === idx ? "bg-emerald-300"
                    : "bg-slate-200"
                  }`}
                />
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <BloomBadge level={current.bloom_level} />
            {current.topic && <span className="text-xs muted">{current.topic}</span>}
          </div>
          <div className="text-base font-medium mb-4">{current.stem}</div>
          <div className="grid sm:grid-cols-2 gap-2">
            {current.options.map((o, i) => {
              const sel = picks[current.id] === i;
              return (
                <button
                  key={i}
                  onClick={() => pick(i)}
                  className={`text-left px-4 py-3 rounded-lg border-2 text-sm transition ${
                    sel
                      ? "border-emerald-500 bg-emerald-50 text-emerald-900"
                      : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                  }`}
                >
                  <span className="text-xs uppercase tracking-wide font-bold opacity-70 mr-1">
                    {String.fromCharCode(65 + i)}.
                  </span>{o}
                </button>
              );
            })}
          </div>

          <div className="mt-6 flex items-center justify-between">
            <button
              onClick={() => setIdx((i) => Math.max(0, i - 1))}
              disabled={idx === 0}
              className="btn btn-ghost"
            >
              <ArrowLeft size={14} /> Previous
            </button>
            {idx < items.length - 1 ? (
              <button
                onClick={() => setIdx((i) => Math.min(items.length - 1, i + 1))}
                className="btn btn-primary"
              >
                Next <ChevronRight size={14} />
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={submitting || !allAnswered}
                className="btn btn-primary"
                title={!allAnswered ? "Answer all questions before finishing." : ""}
              >
                {submitting ? <><span className="spinner" /> Scoring…</> : "Finish drill"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Summary */}
      {result && (
        <div className="mt-6">
          <div className="card text-center">
            <div className="text-xs uppercase tracking-wide font-semibold muted">Your score</div>
            <div className="text-5xl font-bold mt-2">
              {result.score}<span className="text-2xl muted"> / {result.total}</span>
            </div>
            <div className="text-sm muted mt-1">
              {result.score === result.total
                ? "Perfect — you crushed it."
                : result.score === 0
                ? "Tough one. Tomorrow's drill will retune."
                : `${Math.round((result.score / result.total) * 100)}% — keep going.`}
            </div>
          </div>

          <h2 className="h2 mt-6 mb-2">Question by question</h2>
          <div className="space-y-3">
            {result.per_question.map((p, i) => {
              const item = items.find((it) => it.id === p.question_id);
              return (
                <div key={p.question_id} className={`card border-l-4 ${p.is_correct ? "border-emerald-500" : "border-red-400"}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`w-6 h-6 rounded-full grid place-items-center text-xs font-bold text-white ${p.is_correct ? "bg-emerald-500" : "bg-red-500"}`}>
                      {p.is_correct ? <Check size={14} /> : <X size={14} />}
                    </span>
                    <span className="text-xs muted">Question {i + 1}</span>
                  </div>
                  <div className="text-sm font-medium mb-2">{p.stem}</div>
                  {item && (
                    <ul className="grid sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">
                      {item.options.map((o, oi) => {
                        const isCorrect = oi === p.correct_index;
                        const isPick = oi === p.selected_index;
                        return (
                          <li key={oi} className={
                            isCorrect ? "text-emerald-700 font-semibold"
                            : isPick ? "text-red-700"
                            : "text-slate-600"
                          }>
                            <span className="text-xs uppercase opacity-60 mr-1">{String.fromCharCode(65 + oi)}.</span>{o}
                            {isCorrect && <span className="ml-1 text-[10px] uppercase font-bold tracking-wide text-emerald-600">correct</span>}
                            {isPick && !isCorrect && <span className="ml-1 text-[10px] uppercase font-bold tracking-wide text-red-600">your pick</span>}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {p.explanation && (
                    <div className="text-xs muted mt-2"><strong>Why:</strong> {p.explanation}</div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-6 flex flex-wrap gap-2 justify-center">
            <button onClick={load} className="btn btn-secondary"><RefreshCw size={14} /> New drill</button>
            <Link href="/student" className="btn btn-primary">Back to home</Link>
          </div>
        </div>
      )}
    </div>
  );
}
