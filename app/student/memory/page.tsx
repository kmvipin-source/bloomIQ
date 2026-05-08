"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { BLOOM_META, isBloomLevel, type BloomLevel } from "@/lib/bloom";
import {
  Brain, ArrowLeft, CheckCircle2, XCircle, Sparkles, Trophy, Loader2, Flame,
} from "lucide-react";

// =============================================================================
// MEMORY TUNE-UP — daily spaced-repetition review queue.
//
// Pull due cards, show one at a time, let the student answer + self-rate, then
// re-schedule via SM-2. The rating UI is simplified to 4 buttons (Anki-style).
// =============================================================================

type Card = {
  review_id: string;
  question_id: string;
  topic: string | null;
  bloom_level: string;
  stem: string;
  options: string[];
  correct_index: number;
  explanation: string | null;
  interval_days: number;
  reps: number;
};

type Stats = { total: number; due_today: number };
type Streak = { current_streak: number; longest_streak: number };

const RATING_BUTTONS: Array<{ rating: number; label: string; color: string; sub: string }> = [
  { rating: 1, label: "Again",     color: "btn-danger",                                                 sub: "Forgot it" },
  { rating: 3, label: "Hard",      color: "bg-amber-100 text-amber-900 border border-amber-300",       sub: "Got it but barely" },
  { rating: 4, label: "Good",      color: "bg-emerald-100 text-emerald-900 border border-emerald-300", sub: "Confident" },
  { rating: 5, label: "Easy",      color: "bg-sky-100 text-sky-900 border border-sky-300",             sub: "Trivial" },
];

export default function MemoryPage() {
  const [loading, setLoading] = useState(true);
  const [cards, setCards] = useState<Card[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, due_today: 0 });
  const [streak, setStreak] = useState<Streak>({ current_streak: 0, longest_streak: 0 });
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => { void load(); }, []);

  async function load() {
    setLoading(true);
    setDone(false);
    setIdx(0);
    setPicked(null);
    const sb = supabaseBrowser();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { setLoading(false); return; }

    const [dueRes, streakRes] = await Promise.all([
      fetch("/api/srs/due?limit=12", { headers: { Authorization: `Bearer ${session.access_token}` } }),
      // Streak data lives on bloom_climber_streaks (formerly Bloom Climber).
      // We re-use that row as the unified daily-ritual streak now that
      // Climber is folded into Memory Tune-Up. Wrapped in try/catch so a
      // missing table never breaks the page.
      sb.from("bloom_climber_streaks")
        .select("current_streak, longest_streak")
        .eq("user_id", (await sb.auth.getUser()).data.user?.id || "")
        .maybeSingle(),
    ]);

    const j = await dueRes.json();
    if (dueRes.ok) {
      setCards(j.cards || []);
      setStats(j.stats || { total: 0, due_today: 0 });
      if ((j.cards || []).length === 0) setDone(true);
    }
    if (streakRes.data) {
      setStreak({
        current_streak: (streakRes.data as { current_streak?: number }).current_streak || 0,
        longest_streak: (streakRes.data as { longest_streak?: number }).longest_streak || 0,
      });
    }
    setLoading(false);
  }

  async function rate(rating: number) {
    if (busy) return;
    const card = cards[idx];
    if (!card) return;
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return;
      await fetch("/api/srs/review", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ review_id: card.review_id, rating }),
      });
      // Move to next card
      if (idx >= cards.length - 1) {
        setDone(true);
      } else {
        setIdx(idx + 1);
        setPicked(null);
      }
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="grid place-items-center py-20"><div className="spinner" /></div>;

  return (
    <div className="max-w-3xl mx-auto fade-in">
      <Link href="/student" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-emerald-700 mb-3">
        <ArrowLeft size={14} /> Back to dashboard
      </Link>

      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-cyan-100 text-cyan-700 p-3 shrink-0">
          <Brain size={22} />
        </div>
        <div className="flex-1">
          <h1 className="h1">Memory Tune-Up</h1>
          <p className="muted mt-1">
            Spaced repetition for your wrong answers. Five minutes a day keeps the forgetting curve at bay.
          </p>
        </div>
      </div>

      {/* Queue stats */}
      <div className="grid sm:grid-cols-4 gap-3 mt-6">
        <div className="card flex items-center gap-3">
          <div className="rounded-lg bg-orange-100 text-orange-700 p-2"><Flame size={18} /></div>
          <div>
            <div className="text-xs muted uppercase font-semibold">Streak</div>
            <div className="text-2xl font-bold">{streak.current_streak}</div>
            <div className="text-[10px] muted">best {streak.longest_streak}</div>
          </div>
        </div>
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Due today</div>
          <div className="text-3xl font-bold">{stats.due_today}</div>
        </div>
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">In queue</div>
          <div className="text-3xl font-bold">{stats.total}</div>
        </div>
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Reviewing now</div>
          <div className="text-3xl font-bold">{cards.length}</div>
        </div>
      </div>

      {/* Empty / done state */}
      {done && (
        <div className="card mt-6 text-center py-10 bg-emerald-50/40 border-emerald-200">
          <div className="rounded-full bg-emerald-100 text-emerald-700 w-14 h-14 grid place-items-center mx-auto mb-3">
            <Trophy size={22} />
          </div>
          <h2 className="font-semibold text-lg">All caught up</h2>
          <p className="text-sm muted mt-1 max-w-md mx-auto">
            {stats.total === 0
              ? "No cards in your queue yet. Take a quiz, then hit \"Add my mistakes to memory\" on the results page."
              : "No more reviews due today. Come back tomorrow — your queue resets at midnight."}
          </p>
          <div className="mt-4 flex gap-2 justify-center">
            <button type="button" className="btn btn-secondary" onClick={load}>Refresh</button>
            <Link href="/student" className="btn btn-primary">Back to dashboard</Link>
          </div>
        </div>
      )}

      {/* Active card */}
      {!done && cards[idx] && (() => {
        const card = cards[idx];
        const lvl: BloomLevel | null = isBloomLevel(card.bloom_level) ? (card.bloom_level as BloomLevel) : null;
        const wasPicked = picked !== null;
        const isCorrect = picked === card.correct_index;

        return (
          <div className="mt-6 space-y-4">
            <div className="flex items-center justify-between text-xs muted">
              <span>Card {idx + 1} of {cards.length}</span>
              <span>{card.reps === 0 ? "First review" : `Repeat #${card.reps + 1} · last interval ${card.interval_days}d`}</span>
            </div>

            <div className="card">
              <div className="flex items-center gap-2 flex-wrap mb-2">
                {lvl && <span className={`badge badge-${lvl}`}>{BLOOM_META[lvl].label}</span>}
                {card.topic && <span className="badge bg-slate-100 text-slate-700">{card.topic}</span>}
              </div>
              <div className="font-medium text-slate-900">{card.stem}</div>
              <div className="mt-3 space-y-2">
                {card.options.map((o, oi) => {
                  const isCorrectOpt = oi === card.correct_index;
                  const isPickedOpt = oi === picked;
                  const showResult = wasPicked;
                  let cls = "bg-white border-slate-200 hover:border-emerald-300";
                  if (showResult && isCorrectOpt) cls = "bg-emerald-50 border-emerald-400";
                  else if (showResult && isPickedOpt && !isCorrect) cls = "bg-red-50 border-red-400";
                  else if (isPickedOpt) cls = "bg-emerald-50/50 border-emerald-300";
                  return (
                    <button
                      key={oi}
                      type="button"
                      onClick={() => !wasPicked && setPicked(oi)}
                      disabled={wasPicked}
                      className={`w-full text-left text-sm rounded-lg border px-3 py-2 transition ${cls}`}
                    >
                      <span className="font-semibold mr-2">{String.fromCharCode(65 + oi)}.</span> {o}
                      {showResult && isCorrectOpt && <CheckCircle2 size={14} className="inline-block ml-2 text-emerald-700" />}
                      {showResult && isPickedOpt && !isCorrect && <XCircle size={14} className="inline-block ml-2 text-red-700" />}
                    </button>
                  );
                })}
              </div>

              {wasPicked && card.explanation && (
                <div className="mt-3 text-xs text-slate-800 bg-slate-50 border border-slate-200 rounded-md px-3 py-2 leading-relaxed">
                  <strong className="text-slate-900">Why: </strong>{card.explanation}
                </div>
              )}
            </div>

            {/* Rating panel — only shows after picking, so the student commits to an answer first */}
            {wasPicked && (
              <div className="card">
                <h3 className="font-semibold text-sm mb-1">How well did you remember it?</h3>
                <p className="text-xs muted mb-3">
                  Be honest. The schedule depends on it. <strong>Again</strong> reschedules tomorrow; <strong>Easy</strong> pushes the next review weeks out.
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {RATING_BUTTONS.map((b) => (
                    <button
                      key={b.rating}
                      type="button"
                      onClick={() => rate(b.rating)}
                      disabled={busy}
                      className={`rounded-lg px-3 py-3 text-sm font-semibold transition flex flex-col items-center justify-center ${b.color} ${busy ? "opacity-60" : "hover:brightness-105"}`}
                    >
                      <span>{b.label}</span>
                      <span className="text-[10px] font-normal opacity-80">{b.sub}</span>
                    </button>
                  ))}
                </div>
                {busy && <p className="text-xs muted mt-2 inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> Updating schedule…</p>}
              </div>
            )}

            {!wasPicked && (
              <p className="text-xs muted text-center">
                <Sparkles size={11} className="inline" /> Pick an answer first — then rate how confident you were.
              </p>
            )}
          </div>
        );
      })()}
    </div>
  );
}
