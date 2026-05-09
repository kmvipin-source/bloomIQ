"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { ArrowLeft, Layers, RotateCcw, Sparkles, ThumbsUp, ThumbsDown, ChevronLeft, ChevronRight } from "lucide-react";
import { BLOOM_LEVELS, BLOOM_META, type BloomLevel } from "@/lib/bloom";

type Card = { front: string; back: string };
type Mark = "todo" | "got" | "again";

export default function FlashcardsPage() {
  const search = useSearchParams();

  // Suggested defaults pulled from query string (so /student/progress can deep-link).
  const initialBloom = (search.get("level") as BloomLevel) || ("understand" as BloomLevel);
  const initialTopic = search.get("topic") || "";

  const [bloom, setBloom] = useState<BloomLevel>(initialBloom);
  const [topic, setTopic] = useState(initialTopic);
  const [count, setCount] = useState(8);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [cards, setCards] = useState<Card[]>([]);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);

  // If there are query params, auto-generate on first mount.
  useEffect(() => {
    if (initialBloom || initialTopic) {
      generate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function generate() {
    setErr(null);
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const res = await fetch("/api/flashcards", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ bloom_level: bloom, topic: topic.trim() || undefined, count }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Generate failed");
      const c = (json.cards as Card[]) || [];
      if (c.length === 0) throw new Error("No cards came back. Try a more specific topic.");
      setCards(c);
      setMarks(c.map(() => "todo"));
      setIdx(0);
      setFlipped(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Generate failed");
    } finally {
      setBusy(false);
    }
  }

  function nav(delta: number) {
    if (cards.length === 0) return;
    setFlipped(false);
    setIdx((i) => (i + delta + cards.length) % cards.length);
  }

  function mark(m: Mark) {
    if (cards.length === 0) return;
    setMarks((arr) => arr.map((x, i) => (i === idx ? m : x)));
    // Auto-advance on a mark.
    setTimeout(() => nav(1), 150);
  }

  const got = marks.filter((m) => m === "got").length;
  const again = marks.filter((m) => m === "again").length;
  const remaining = marks.filter((m) => m === "todo").length;

  const card = cards[idx];

  return (
    <div className="max-w-3xl mx-auto fade-in">
      <Link href="/student" className="text-sm text-emerald-700 font-semibold inline-flex items-center gap-1"><ArrowLeft size={14} /> Dashboard</Link>
      <h1 className="h1 mt-2 flex items-center gap-2"><Layers size={28} /> Focus-area flashcards</h1>
      <p className="muted mt-1">Quick drills for the level (and optionally the topic) you want to strengthen.</p>

      {/* ============ Generate panel ============ */}
      <div className="card mt-6">
        <div className="grid sm:grid-cols-[1fr_180px_120px_auto] gap-3 items-end">
          <div>
            <label className="label">Topic (optional)</label>
            <input
              className="input"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="e.g. Photosynthesis, Fractions, Indian Independence"
            />
          </div>
          <div>
            <label className="label">Bloom level</label>
            <select className="select" value={bloom} onChange={(e) => setBloom(e.target.value as BloomLevel)}>
              {BLOOM_LEVELS.map((l) => <option key={l} value={l}>{BLOOM_META[l].label}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Cards</label>
            <select className="select" value={count} onChange={(e) => setCount(Number(e.target.value))}>
              <option value={6}>6</option>
              <option value={8}>8</option>
              <option value={10}>10</option>
              <option value={12}>12</option>
            </select>
          </div>
          <button type="button" className="btn btn-primary" onClick={generate} disabled={busy}>
            {busy ? <><span className="spinner" /> Building…</> : <><Sparkles size={14} /> Generate</>}
          </button>
        </div>
        {err && (
          <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>
        )}
        <p className="text-xs muted mt-3">
          Tip: leave Topic empty for a general drill at this Bloom level. Add a topic to focus the cards.
        </p>
      </div>

      {/* ============ Progress ribbon ============ */}
      {cards.length > 0 && (
        <div className="mt-6 flex items-center justify-between gap-3 flex-wrap text-sm">
          <div className="text-slate-700">
            Card <strong>{idx + 1}</strong> / {cards.length}
          </div>
          <div className="flex items-center gap-3 text-xs muted">
            <span className="inline-flex items-center gap-1 text-emerald-700"><ThumbsUp size={12} /> {got} got</span>
            <span className="inline-flex items-center gap-1 text-amber-700"><ThumbsDown size={12} /> {again} again</span>
            <span>· {remaining} unmarked</span>
          </div>
        </div>
      )}

      {/* ============ The card itself ============ */}
      {cards.length > 0 && card && (
        <div className="mt-3">
          <div
            className={`card cursor-pointer select-none min-h-[200px] flex items-center justify-center text-center px-6 py-8 transition-all ${
              flipped
                ? "bg-gradient-to-br from-sky-50 to-emerald-50 border-emerald-300"
                : "bg-white"
            }`}
            onClick={() => setFlipped((v) => !v)}
            title="Click to flip"
          >
            <div className="max-w-2xl">
              {!flipped ? (
                <>
                  <div className="text-xs uppercase tracking-wide font-bold text-slate-500 mb-2">Front · click to flip</div>
                  <div className="text-lg font-semibold leading-relaxed">{card.front}</div>
                </>
              ) : (
                <>
                  <div className="text-xs uppercase tracking-wide font-bold text-emerald-700 mb-2">Back · click to flip back</div>
                  <div className="text-base leading-relaxed whitespace-pre-line">{card.back}</div>
                </>
              )}
            </div>
          </div>

          {/* Action bar */}
          <div className="mt-4 flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <button type="button" className="btn btn-ghost" onClick={() => nav(-1)} title="Previous"><ChevronLeft size={16} /> Prev</button>
              <button type="button" className="btn btn-ghost" onClick={() => nav(1)} title="Next">Next <ChevronRight size={16} /></button>
              <button type="button" className="btn btn-ghost" onClick={() => setFlipped((v) => !v)}><RotateCcw size={14} /> Flip</button>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" className="btn btn-secondary text-amber-800" onClick={() => mark("again")}><ThumbsDown size={14} /> Need more practice</button>
              <button type="button" className="btn btn-primary" onClick={() => mark("got")}><ThumbsUp size={14} /> Got it</button>
            </div>
          </div>

          {/* End-of-deck recap */}
          {got + again >= cards.length && (
            <div className="card mt-6 bg-emerald-50 border-emerald-200 text-center py-6">
              <div className="text-3xl mb-1">🎯</div>
              <div className="font-semibold text-emerald-900">Deck done — {got} of {cards.length} got it</div>
              <p className="text-sm text-emerald-900/80 mt-1">
                {again > 0
                  ? `${again} card${again === 1 ? "" : "s"} flagged for more practice. Generate a new deck or come back later.`
                  : "All marked. Try a harder Bloom level next!"}
              </p>
              <div className="mt-3 flex items-center justify-center gap-2">
                <button type="button" className="btn btn-primary" onClick={generate} disabled={busy}><Sparkles size={14} /> New deck</button>
                <Link href="/student/progress" className="btn btn-secondary">Back to Progress</Link>
              </div>
            </div>
          )}
        </div>
      )}

      {cards.length === 0 && !busy && (
        <div className="card mt-6 text-center py-10 muted text-sm">
          Pick a Bloom level (and optionally a topic), then hit <strong>Generate</strong>.
        </div>
      )}
    </div>
  );
}
