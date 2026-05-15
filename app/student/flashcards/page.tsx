"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { ArrowLeft, Layers, RotateCcw, Sparkles, ThumbsUp, ThumbsDown, ChevronLeft, ChevronRight } from "lucide-react";
import { BLOOM_LEVELS, BLOOM_META, type BloomLevel } from "@/lib/bloom";
import { placeholderTopic } from "@/lib/topicSuggestions";
import { type LearnerProfile } from "@/components/LearnerProfilePrompt";
import CurrentGoalChip from "@/components/CurrentGoalChip";
import {
  detectExamFromTopic,
  EXAM_DETECTORS,
  type ExamMeta,
} from "@/lib/examDetectors";

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

  // Learning-context-aware placeholder (2026-05-12). Pulls exam_goal +
  // learner_profile so a CAT student sees CAT topic examples, not
  // "Photosynthesis, Fractions, Indian Independence".
  const [examGoal, setExamGoal] = useState<string | null>(null);
  const [learnerProfile, setLearnerProfile] = useState<LearnerProfile | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) return;
        const { data: prof } = await sb
          .from("profiles")
          .select("exam_goal, learner_profile")
          .eq("id", user.id)
          .maybeSingle();
        const row = prof as { exam_goal: string | null; learner_profile: string | null } | null;
        if (row?.exam_goal) setExamGoal(row.exam_goal);
        const lp = row?.learner_profile;
        if (lp === "k12" || lp === "competitive_exam" || lp === "corporate") {
          setLearnerProfile(lp);
        }
      } catch { /* silent — fall back to k12 default */ }
    })();
  }, []);

  // 2026-05-14: LLM-validated topic-vs-syllabus warning (same /api/topic-validate
  // route, same debounced pattern as /student/generate, /teacher/generate, and
  // /student/speed). Catches mismatches like "NEET student typing history" before
  // the flashcards are generated.
  const examMeta = useMemo<ExamMeta | null>(() => {
    const fromTopic = detectExamFromTopic(topic);
    if (fromTopic) return fromTopic;
    if (!examGoal) return null;
    const g = examGoal.toLowerCase().trim();
    if (g.startsWith("jee")) return EXAM_DETECTORS.JEE;
    if (g.startsWith("neet")) return EXAM_DETECTORS.NEET;
    if (g === "cat" || g === "cat_prep") return EXAM_DETECTORS.CAT;
    if (g === "upsc" || g === "upsc_prep") return EXAM_DETECTORS.UPSC;
    if (g === "gmat" || g === "gmat_prep") return EXAM_DETECTORS.GMAT;
    if (g === "gre"  || g === "gre_prep")  return EXAM_DETECTORS.GRE;
    if (g === "gate" || g === "gate_prep") return EXAM_DETECTORS.GATE;
    if (g === "clat" || g === "clat_prep") return EXAM_DETECTORS.CLAT;
    if (g === "bitsat" || g === "bitsat_prep") return EXAM_DETECTORS.BITSAT;
    if (g === "sat"  || g === "sat_prep")  return EXAM_DETECTORS.SAT;
    if (g === "nda"  || g === "nda_prep")  return EXAM_DETECTORS.NDA;
    if (g === "cuet" || g === "cuet_prep") return EXAM_DETECTORS.CUET;
    return null;
  }, [topic, examGoal]);
  const [topicValidation, setTopicValidation] = useState<{
    loading: boolean;
    result: { valid: boolean; reason: string; suggestedExam: string | null } | null;
  }>({ loading: false, result: null });
  useEffect(() => {
    if (!examMeta || (topic || "").trim().length < 3) {
      setTopicValidation({ loading: false, result: null });
      return;
    }
    const controller = new AbortController();
    setTopicValidation((s) => ({ ...s, loading: true }));
    const handle = setTimeout(async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return;
        const res = await fetch("/api/topic-validate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            topic: topic.trim(),
            examName: examMeta.name,
            examDescription: examMeta.description,
            examSections: examMeta.sections,
          }),
          signal: controller.signal,
        });
        const j = (await res.json()) as {
          valid?: boolean;
          reason?: string;
          suggestedExam?: string | null;
        };
        if (controller.signal.aborted) return;
        setTopicValidation({
          loading: false,
          result: {
            valid: j.valid !== false,
            reason: String(j.reason || ""),
            suggestedExam: j.suggestedExam ? String(j.suggestedExam) : null,
          },
        });
      } catch (e) {
        if ((e as Error)?.name !== "AbortError") {
          setTopicValidation({ loading: false, result: null });
        }
      }
    }, 800);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [topic, examMeta]);

  const [cards, setCards] = useState<Card[]>([]);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);

  // 2026-05-13: only auto-fire ONCE per mount even on browser back/forward
  // (which can re-mount the page). Without this guard a back-then-forward
  // doubles the LLM call → wasted tokens.
  const autoFiredRef = useRef(false);
  useEffect(() => {
    if (autoFiredRef.current) return;
    if (initialBloom || initialTopic) {
      autoFiredRef.current = true;
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
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Link href="/student" className="text-sm text-emerald-700 font-semibold inline-flex items-center gap-1"><ArrowLeft size={14} /> Dashboard</Link>
        <CurrentGoalChip />
      </div>
      <h1 className="h1 mt-2 flex items-center gap-2"><Layers size={28} /> Focus-area flashcards</h1>
      <p className="muted mt-1">Quick drills for the level (and optionally the topic) you want to strengthen.</p>

      {/* 2026-05-14: LLM-validated topic-vs-syllabus warning. Same pattern
          as /student/generate. Surfaces mismatches (e.g. NEET student asking
          for "history" flashcards) before generation. Non-blocking. */}
      {topicValidation.result &&
        !topicValidation.result.valid &&
        examMeta && (
          <div className="card mt-6 bg-amber-50/60 border-amber-200">
            <div className="flex items-start gap-2 text-xs text-amber-900">
              <span className="font-bold">⚠</span>
              <div className="flex-1">
                <strong>{topicValidation.result.reason}</strong>
                {topicValidation.result.suggestedExam ? (
                  <>{" "}This topic fits <strong>{topicValidation.result.suggestedExam}</strong> better — switch your goal in <a href="/settings" className="underline font-semibold">Settings</a> if needed.</>
                ) : (
                  <>{" "}If this is intentional, proceed — flashcards will still be generated.</>
                )}
              </div>
            </div>
          </div>
        )}

      {/* ============ Generate panel ============ */}
      <div className="card mt-6">
        <div className="grid sm:grid-cols-[1fr_180px_120px_auto] gap-3 items-end">
          <div>
            <label className="label">Topic (optional)</label>
            <input
              className="input"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder={placeholderTopic(examGoal, learnerProfile)}
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
