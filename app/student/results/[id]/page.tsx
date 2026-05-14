"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { BLOOM_LEVELS, BLOOM_META, blankBloomCounts, type BloomLevel } from "@/lib/bloom";
import { BloomRadar } from "@/components/BloomChart";
import type { QuizAttempt } from "@/lib/types";
import { formatSeconds } from "@/lib/utils";
import {
  resolveScheme,
  percentageOf,
  rawScoreLabel,
  type MarkingScheme,
} from "@/lib/scoring";
import { SCORING_PRESETS } from "@/lib/scoringPresets";
import {
  classifyQuizForRankPrediction,
  type RankEligibility,
} from "@/lib/rankPredictorEligibility";
import ExploreMoreSubTopics from "@/components/ExploreMoreSubTopics";
import { Sparkles, Search, AlertOctagon, Crosshair, Trophy, Brain, Clock, Lock, Info, Settings as SettingsIcon, CheckCircle2, XCircle, MinusCircle } from "lucide-react";

// Extended detail to carry quiz subject + family — needed by the foolproof
// gate around the Mock Rank Predictor surface (2026-05-13). The previous
// `Detail` type only carried name + code, which is why the rank surface
// happily appeared on a Java quiz.
//
// Column note: the quizzes table stores the user-supplied topic as `subject`
// (migration 04), not `topic`. `topic` only lives on question_bank rows.
type Detail = QuizAttempt & { quiz: { name: string; code: string; subject: string | null; topic_family: string | null } | null };

/** Per-question review row. Joined from attempt_answers + question_bank
 *  so the student can see WHICH option they picked, the correct option,
 *  and the explanation. Vipin caught the absence of this surface on
 *  2026-05-12 — students were submitting tests with no way to learn
 *  from their mistakes. */
type ReviewItem = {
  question_id: string;
  position: number;
  stem: string;
  options: string[];
  selected_index: number | null;
  correct_index: number;
  explanation: string | null;
  is_correct: boolean | null;
  bloom_level: BloomLevel;
  marks_earned: number | null;
};

export default function ResultsPage() {
  const { id } = useParams<{ id: string }>();
  const [attempt, setAttempt] = useState<Detail | null>(null);
  const [byLevel, setByLevel] = useState<Record<BloomLevel, { c: number; t: number }>>({
    remember: { c: 0, t: 0 }, understand: { c: 0, t: 0 }, apply: { c: 0, t: 0 },
    analyze: { c: 0, t: 0 }, evaluate: { c: 0, t: 0 }, create: { c: 0, t: 0 },
  });
  const [recs, setRecs] = useState("");
  const [loadingRecs, setLoadingRecs] = useState(false);

  // ----- Misconception Detective state -----
  // We let the student kick off diagnosis explicitly (vs. running it
  // automatically on submit) so we don't burn AI tokens on attempts they
  // don't care about.
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagErr, setDiagErr] = useState<string | null>(null);
  const [diagnosed, setDiagnosed] = useState<Array<{ label: string; detail: string; strikes: number }> | null>(null);

  // ----- Distractor Trap state -----
  const [trapBusy, setTrapBusy] = useState(false);
  const [trapErr, setTrapErr] = useState<string | null>(null);
  const [traps, setTraps] = useState<Array<{ trap_type: string; trap_label: string; detail: string }> | null>(null);

  // ----- Mock Rank Predictor state -----
  const [rankBusy, setRankBusy] = useState(false);
  const [rankErr, setRankErr] = useState<string | null>(null);
  const [rank, setRank] = useState<{
    exam_type: string;
    percentile: number;
    predicted_air: number;
    total_candidates: number;
    recommendations: string[];
    // Server-side foolproofing: snap CAT pick → JEE_MAIN if the quiz topic
    // was "JEE Physics" etc. Surface to the user instead of silently doing it.
    exam_type_override?: { from: string; to: string; reason: string } | null;
    eligibility_note?: string | null;
  } | null>(null);
  const [examType, setExamType] = useState<"JEE_MAIN" | "NEET" | "CAT" | "CUSTOM">("JEE_MAIN");

  // ----- Spaced Repetition enqueue state -----
  const [srsBusy, setSrsBusy] = useState(false);
  const [srsResult, setSrsResult] = useState<{ enqueued: number; skipped: number } | null>(null);
  const [srsErr, setSrsErr] = useState<string | null>(null);

  // ----- Per-question pacing state -----
  // benchData.questions[] is sorted by quiz position. Each row is the
  // student's own answer + (optionally) cohort median if entitled.
  type BenchRow = {
    question_id: string;
    position: number;
    is_correct: boolean | null;
    bloom_level: string | null;
    your_ms: number | null;
    median_ms: number | null;
    n_samples: number;
    speed_label: "fast" | "on_pace" | "slow" | "no_benchmark" | "no_data";
  };
  type BenchPayload = {
    questions: BenchRow[];
    overall: { your_total_ms: number; median_total_ms: number; delta_pct: number | null; questions_with_benchmark: number } | null;
    benchmark_allowed: boolean;
    required_tier?: string | null;
  };
  const [benchData, setBenchData] = useState<BenchPayload | null>(null);
  // The student's own consent value — drives whether we even attempt
  // to fetch benchmarks. NULL/false → show the consent CTA instead.
  const [trackTime, setTrackTime] = useState<boolean | null | undefined>(undefined);
  // School student? Used to swap the Premium Plus / "See plans" upgrade
  // copy for a quieter "your school's plan doesn't include this" note —
  // school students can't self-upgrade, so the /pricing CTA is wrong
  // for them. We default to null (unknown) and resolve in the profile
  // fetch below; banner waits for the resolution to avoid a flash.
  const [isSchoolStudent, setIsSchoolStudent] = useState<boolean | null>(null);

  // Per-question review (added 2026-05-12). Loaded alongside the
  // attempt summary so the student can see every question they
  // attempted, what they picked, the correct answer, and the
  // explanation. Empty array while loading.
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [reviewExpanded, setReviewExpanded] = useState<boolean>(true);

  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      // Pull subject + topic_family so the rank-predictor gate can decide
      // whether the surface should appear at all (2026-05-13). Without
      // these fields a Java quiz looked identical to a CAT mock to the UI.
      // Column note: quizzes.subject is the user-supplied topic; the
      // column literally named `topic` exists only on question_bank.
      const { data: a } = await sb
        .from("quiz_attempts")
        .select("*, quiz:quizzes(name, code, subject, topic_family)")
        .eq("id", id)
        .single();
      setAttempt(a as Detail);
      // Extended select on 2026-05-12 — we now also pull selected_index,
      // marks_earned, question_id so the per-question review section can
      // join against the question bank without a second pass. The Bloom
      // aggregation below still uses only bloom_level + is_correct so
      // its math is unchanged.
      const { data: ans } = await sb
        .from("attempt_answers")
        .select("is_correct, bloom_level, question_id, selected_index, marks_earned")
        .eq("attempt_id", id);
      const counts = { ...blankBloomCounts() } as Record<BloomLevel, number>;
      const tot = { ...blankBloomCounts() } as Record<BloomLevel, number>;
      (ans || []).forEach((x: { bloom_level: BloomLevel; is_correct: boolean | null }) => {
        tot[x.bloom_level] += 1; if (x.is_correct) counts[x.bloom_level] += 1;
      });
      const next = {} as Record<BloomLevel, { c: number; t: number }>;
      BLOOM_LEVELS.forEach((l) => next[l] = { c: counts[l], t: tot[l] });
      setByLevel(next);

      // Per-question review fetch. attempt_answers gives us the student's
      // pick + is_correct + bloom_level + marks_earned; question_bank gives
      // us the stem, all 4 options, correct_index, and explanation. We
      // also pull quiz_questions for the canonical question order so the
      // review renders in the same sequence the student saw during the test.
      type AnsRow = {
        question_id: string;
        selected_index: number | null;
        marks_earned: number | null;
        is_correct: boolean | null;
        bloom_level: BloomLevel;
      };
      const ansTyped = (ans as AnsRow[] | null) || [];
      const qids = ansTyped.map((a) => a.question_id).filter(Boolean);
      if (qids.length > 0) {
        const [qBank, qOrder] = await Promise.all([
          sb
            .from("question_bank")
            .select("id, stem, options, correct_index, explanation")
            .in("id", qids),
          sb
            .from("quiz_questions")
            .select("question_id, position")
            .eq("quiz_id", (a as Detail | null)?.quiz_id || "")
            .in("question_id", qids),
        ]);
        type QbRow = { id: string; stem: string; options: string[]; correct_index: number; explanation: string | null };
        type QqRow = { question_id: string; position: number };
        const qbById = new Map<string, QbRow>();
        ((qBank.data as QbRow[]) || []).forEach((r) => qbById.set(r.id, r));
        const positionById = new Map<string, number>();
        ((qOrder.data as QqRow[]) || []).forEach((r) => positionById.set(r.question_id, r.position));
        const items: ReviewItem[] = ansTyped
          .map((row) => {
            const q = qbById.get(row.question_id);
            if (!q) return null;
            return {
              question_id: row.question_id,
              position: positionById.get(row.question_id) ?? 0,
              stem: q.stem,
              options: Array.isArray(q.options) ? q.options : [],
              selected_index: row.selected_index,
              correct_index: q.correct_index,
              explanation: q.explanation || null,
              is_correct: row.is_correct,
              bloom_level: row.bloom_level,
              marks_earned: row.marks_earned,
            };
          })
          .filter((x): x is ReviewItem => x !== null)
          .sort((x, y) => x.position - y.position);
        setReviewItems(items);
      }

      // Resolve consent + load per-question pacing. Skip the API call
      // entirely when the student opted out — we'll render the opt-in
      // CTA instead.
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;
      const { data: prof } = await sb
        .from("profiles")
        .select("track_question_time, is_school_student")
        .eq("id", user.id)
        .maybeSingle();
      const profRow = prof as {
        track_question_time: boolean | null;
        is_school_student: boolean | null;
      } | null;
      const consent = profRow?.track_question_time ?? null;
      setTrackTime(consent);
      setIsSchoolStudent(!!profRow?.is_school_student);
      if (consent === true) {
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return;
        try {
          const r = await fetch(`/api/student/question-benchmarks?attempt_id=${id}`, {
            headers: { Authorization: `Bearer ${session.access_token}` },
          });
          if (r.ok) {
            const j = await r.json();
            setBenchData(j as BenchPayload);
          }
        } catch { /* non-fatal — section just won't render */ }
      }
    })();
  }, [id]);

  async function getRecs() {
    if (!attempt) return;
    setLoadingRecs(true);
    const sb = supabaseBrowser();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;
    const levels = BLOOM_LEVELS.map((l) => ({ level: l, ...byLevel[l] }));
    const res = await fetch("/api/recommendations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ levels, score: attempt.score, total: attempt.total, quizName: attempt.quiz?.name }),
    });
    const j = await res.json();
    setRecs(j.text || "");
    setLoadingRecs(false);
  }

  async function diagnose() {
    if (!attempt) return;
    setDiagErr(null);
    setDiagBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired — please sign in again.");
      const r = await fetch("/api/misconception/diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ attempt_id: attempt.id }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Diagnosis failed");
      setDiagnosed(j.misconceptions || []);
    } catch (e) {
      setDiagErr(e instanceof Error ? e.message : "Diagnosis failed");
    } finally {
      setDiagBusy(false);
    }
  }

  async function diagnoseTraps() {
    if (!attempt) return;
    setTrapErr(null);
    setTrapBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired — please sign in again.");
      const r = await fetch("/api/traps/diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ attempt_id: attempt.id }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Trap diagnosis failed");
      setTraps(j.traps || []);
    } catch (e) {
      setTrapErr(e instanceof Error ? e.message : "Trap diagnosis failed");
    } finally {
      setTrapBusy(false);
    }
  }

  async function enqueueMistakes() {
    if (!attempt) return;
    setSrsErr(null);
    setSrsBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired — please sign in again.");
      const r = await fetch("/api/srs/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ attempt_id: attempt.id }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Enqueue failed");
      setSrsResult({ enqueued: j.enqueued || 0, skipped: j.skipped || 0 });
    } catch (e) {
      setSrsErr(e instanceof Error ? e.message : "Enqueue failed");
    } finally {
      setSrsBusy(false);
    }
  }

  async function predictRank() {
    if (!attempt) return;
    setRankErr(null);
    setRankBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired — please sign in again.");
      const r = await fetch("/api/rank/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ attempt_id: attempt.id, exam_type: examType }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Rank prediction failed");
      setRank({
        exam_type: j.exam_type,
        percentile: j.percentile,
        predicted_air: j.predicted_air,
        total_candidates: j.total_candidates,
        recommendations: j.recommendations || [],
        exam_type_override: j.exam_type_override ?? null,
        eligibility_note: j.eligibility_note ?? null,
      });
    } catch (e) {
      setRankErr(e instanceof Error ? e.message : "Rank prediction failed");
    } finally {
      setRankBusy(false);
    }
  }

  /**
   * Pretty-print a numeric score. Integers stay clean ("66"). Decimal
   * scores from CUSTOM schemes show two decimals ("65.50"). Negatives
   * keep their minus sign — transparency matches CAT/JEE conventions.
   */
  function formatScoreNumber(n: number): string {
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(2);
  }

  if (!attempt) return <div className="grid place-items-center py-20"><div className="spinner" /></div>;

  // Marking-scheme aware score display. percentageOf() prefers the new
  // raw_score / max_score columns (migration 76) and falls back to the
  // legacy score / total for any pre-migration attempt. Negative raw
  // scores show their true value (transparency); the percentage is
  // clamped at 0 by lib/scoring.ts.
  const attemptForScore = attempt as unknown as {
    raw_score?: number | null;
    max_score?: number | null;
    score?: number | null;
    total?: number | null;
    marking_scheme_snapshot?: unknown;
  };
  const percentExact = percentageOf(attemptForScore);
  const percent = Math.round(percentExact);
  const rawLabel = rawScoreLabel(attemptForScore);
  const scheme: MarkingScheme = resolveScheme(attemptForScore.marking_scheme_snapshot);
  const isNonDefaultScheme =
    scheme.preset !== "PRACTICE" || scheme.negative_marks_enabled;
  // Counts for the breakdown card (correct × +marks, wrong × −marks, etc.).
  // Built from the Bloom counters we already loaded above.
  const totalCorrect = BLOOM_LEVELS.reduce((s, l) => s + byLevel[l].c, 0);
  const totalQuestions = BLOOM_LEVELS.reduce((s, l) => s + byLevel[l].t, 0);
  const totalWrongOrSkipped = totalQuestions - totalCorrect;
  // We don't have wrong-vs-skipped split here (the page only loaded
  // is_correct + bloom_level for the radar). Show the union for now and
  // surface a TODO comment — a future read-side refactor can fetch
  // selected_index too if richer breakdown is wanted.

  const radarData = BLOOM_LEVELS.map((l) => ({ level: l, correct: byLevel[l].c, total: byLevel[l].t }));

  // Smart feedback: find strongest and weakest level (with at least 1 question)
  const present = BLOOM_LEVELS.filter((l) => byLevel[l].t > 0)
    .map((l) => ({ l, p: byLevel[l].c / byLevel[l].t }))
    .sort((a, b) => b.p - a.p);
  const strong = present[0];
  const weak = present[present.length - 1];

  return (
    <div className="max-w-4xl mx-auto fade-in">
      <Link href="/student" className="text-sm text-emerald-700 font-semibold">← Back to home</Link>

      <div className="card mt-3 bg-gradient-to-br from-emerald-50 to-white">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <div className="muted text-sm">{attempt.quiz?.name}</div>
            <div className="h1 mt-1">{percent}%</div>
            <div className="muted">
              {/* Score line shows marks-aware totals when available
                  (raw_score / max_score from migration 76), else falls
                  back to "X of Y correct" for legacy attempts. */}
              {rawLabel ? (
                <>
                  <strong className={rawLabel.raw < 0 ? "text-rose-700" : ""}>
                    {formatScoreNumber(rawLabel.raw)}
                  </strong>
                  {" "}/{" "}{formatScoreNumber(rawLabel.max)}
                  {" "}({totalCorrect} of {totalQuestions} correct)
                </>
              ) : (
                <>{attempt.score} of {attempt.total} correct</>
              )}
              {" "}· {attempt.time_taken_seconds ? formatSeconds(attempt.time_taken_seconds) : "—"}
            </div>
            {/* Marking-scheme line — only when the attempt was scored
                under a non-default scheme. Practice quizzes stay clean. */}
            {isNonDefaultScheme && (
              <div className="text-xs muted mt-1.5">
                Marking: <strong>{SCORING_PRESETS[scheme.preset].label}</strong>
                {" "}— +{scheme.rules.default.correct} correct
                {scheme.negative_marks_enabled
                  ? `, ${scheme.rules.default.wrong > 0 ? "+" : ""}${scheme.rules.default.wrong} wrong`
                  : ", 0 wrong"}
                , {scheme.rules.default.unattempted} skipped
              </div>
            )}
            {/* Negative-raw coaching nudge. Only shows on attempts where
                the student went into the red — e.g., wildly guessed a
                JEE Main mock and got more wrong than correct. */}
            {rawLabel && rawLabel.raw < 0 && (
              <div className="text-xs mt-2 px-3 py-2 rounded-md bg-amber-50 border border-amber-200 text-amber-900">
                <strong>Heads up:</strong> Raw score went negative because wrong answers
                deducted more than correct answers awarded. Percentage is shown as 0%.
                On tests with negative marking, it&apos;s often better to leave a question
                blank than to guess.
              </div>
            )}
          </div>
          <div className="text-6xl">
            {percent >= 80 ? "🌟" : percent >= 60 ? "👍" : percent >= 40 ? "💪" : "📚"}
          </div>
        </div>

        {/* Marks breakdown card — only when scheme is non-default AND
            we have at least one wrong/skipped to make the breakdown
            non-trivial. Pure visualisation: "18 × +4 = +72". */}
        {isNonDefaultScheme && totalQuestions > 0 && (
          <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2">
              <div className="text-emerald-700 font-bold tabular-nums">
                {totalCorrect} × +{scheme.rules.default.correct}
              </div>
              <div className="text-emerald-900 mt-0.5">
                = +{(totalCorrect * scheme.rules.default.correct).toFixed(2).replace(/\.?0+$/, "")}
              </div>
              <div className="text-[10px] muted mt-1">Correct</div>
            </div>
            <div className="rounded-md bg-rose-50 border border-rose-200 px-3 py-2">
              <div className="text-rose-700 font-bold tabular-nums">
                {totalWrongOrSkipped} × {scheme.rules.default.wrong > 0 ? "+" : ""}{scheme.rules.default.wrong}
              </div>
              <div className="text-rose-900 mt-0.5">
                = {(totalWrongOrSkipped * scheme.rules.default.wrong).toFixed(2).replace(/\.?0+$/, "")}
              </div>
              <div className="text-[10px] muted mt-1">Wrong or skipped*</div>
            </div>
            <div className="rounded-md bg-slate-50 border border-slate-200 px-3 py-2">
              <div className="text-slate-700 font-bold tabular-nums">
                {rawLabel ? formatScoreNumber(rawLabel.raw) : "—"} / {rawLabel ? formatScoreNumber(rawLabel.max) : "—"}
              </div>
              <div className="text-slate-900 mt-0.5 font-bold text-base">
                {percent}%
              </div>
              <div className="text-[10px] muted mt-1">Total</div>
            </div>
            <div className="col-span-3 text-[10px] muted">
              *Detailed wrong-vs-skipped split available on individual
              question review (Bloom radar below).
            </div>
          </div>
        )}
      </div>

      {strong && weak && strong.l !== weak.l && (
        <div className="card mt-4">
          <div className="flex flex-wrap gap-4">
            <div className="flex-1 min-w-60">
              <div className="text-xs muted uppercase font-semibold">Strongest level</div>
              <div className="mt-1 text-emerald-700 font-bold">{BLOOM_META[strong.l].label} · {Math.round(strong.p * 100)}%</div>
              <p className="text-sm muted mt-1">You can {BLOOM_META[strong.l].verb.toLowerCase()} this material well.</p>
            </div>
            <div className="flex-1 min-w-60">
              <div className="text-xs muted uppercase font-semibold">Focus next on</div>
              <div className="mt-1 text-amber-700 font-bold">{BLOOM_META[weak.l].label} · {Math.round(weak.p * 100)}%</div>
              <p className="text-sm muted mt-1">{BLOOM_META[weak.l].description}</p>
            </div>
          </div>
        </div>
      )}

      <div className="card mt-4">
        <h3 className="h2 mb-2">Your thinking-level profile</h3>
        <BloomRadar data={radarData} />
      </div>

      {/* ============ PER-QUESTION PACING ============
          Three render modes:
            1. consent === false (or null & not yet asked anywhere) →
               opt-in CTA pointing to /settings.
            2. consent === true + benchmark_allowed → full per-question
               table with own time + cohort median + speed indicator.
            3. consent === true + benchmark_allowed=false → own-time only,
               with a 🔒 chip teasing the cohort feature on Premium Plus.
          We never render this section until trackTime resolves (avoids
          flash of "enable tracking" for paying students). */}
      {trackTime === false && (
        <div className="card mt-4 bg-slate-50">
          <div className="flex items-start gap-3">
            <Clock size={20} className="text-slate-500 mt-0.5 shrink-0" />
            <div className="flex-1">
              <h3 className="h2">See your pacing per question</h3>
              <p className="text-sm muted mt-1 max-w-xl">
                You currently have time-tracking turned off. Turn it on in{" "}
                <Link href="/settings" className="text-emerald-700 underline">Settings</Link>{" "}
                to see how long you spent on each question after future tests — and on Premium
                Plus, how your pace compares to other students.
              </p>
            </div>
          </div>
        </div>
      )}

      {trackTime === true && benchData && benchData.questions.length > 0 && (
        <div className="card mt-4">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
            <h3 className="h2 inline-flex items-center gap-2">
              <Clock size={18} /> Per-question pacing
            </h3>
            {benchData.overall && benchData.overall.delta_pct !== null && (
              <div className="text-xs muted">
                Overall: you took{" "}
                <strong className={benchData.overall.delta_pct > 15 ? "text-rose-700" : benchData.overall.delta_pct < -15 ? "text-emerald-700" : "text-slate-700"}>
                  {benchData.overall.delta_pct > 0 ? "+" : ""}{benchData.overall.delta_pct}%
                </strong>{" "}
                vs. cohort median across {benchData.overall.questions_with_benchmark} questions
              </div>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase muted border-b border-slate-200">
                <tr>
                  <th className="text-left py-2 pr-3">#</th>
                  <th className="text-left py-2 pr-3">Result</th>
                  <th className="text-left py-2 pr-3">Bloom</th>
                  <th className="text-right py-2 pr-3">Your time</th>
                  <th className="text-right py-2 pr-3">
                    {benchData.benchmark_allowed ? "Cohort median" : (
                      <span className="inline-flex items-center gap-1">
                        Cohort median <Lock size={11} />
                      </span>
                    )}
                  </th>
                  <th className="text-left py-2">Pace</th>
                </tr>
              </thead>
              <tbody>
                {benchData.questions.map((row, idx) => {
                  const yourS = row.your_ms !== null ? Math.round(row.your_ms / 1000) : null;
                  const medS = row.median_ms !== null ? Math.round(row.median_ms / 1000) : null;
                  const paceTone =
                    row.speed_label === "fast"   ? "bg-emerald-50 text-emerald-800 border-emerald-200" :
                    row.speed_label === "slow"   ? "bg-rose-50 text-rose-800 border-rose-200"          :
                    row.speed_label === "on_pace"? "bg-slate-50 text-slate-700 border-slate-200"        :
                                                   "bg-slate-50 text-slate-500 border-slate-200";
                  const paceLabel =
                    row.speed_label === "fast"          ? "Fast"          :
                    row.speed_label === "slow"          ? "Slow"          :
                    row.speed_label === "on_pace"       ? "On pace"       :
                    row.speed_label === "no_benchmark"  ? `Need ${5 - row.n_samples > 0 ? 5 - row.n_samples : 0} more samples` :
                                                          "—";
                  return (
                    <tr key={row.question_id} className="border-b border-slate-100 last:border-0">
                      <td className="py-2 pr-3 font-medium">Q{row.position ?? (idx + 1)}</td>
                      <td className="py-2 pr-3">
                        {row.is_correct === true  ? <span className="text-emerald-700">✓ Correct</span> :
                         row.is_correct === false ? <span className="text-rose-700">✗ Wrong</span>     :
                                                    <span className="muted">— Skipped</span>}
                      </td>
                      <td className="py-2 pr-3 capitalize text-slate-600">{row.bloom_level || "—"}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{yourS !== null ? `${yourS}s` : "—"}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {benchData.benchmark_allowed
                          ? (medS !== null ? `${medS}s` : <span className="muted text-xs">—</span>)
                          : <span className="muted text-xs">{isSchoolStudent ? "—" : "Premium Plus"}</span>}
                      </td>
                      <td className="py-2">
                        {benchData.benchmark_allowed ? (
                          <span className={`inline-block text-xs px-2 py-0.5 rounded-full border ${paceTone}`}>
                            {paceLabel}
                          </span>
                        ) : isSchoolStudent ? (
                          <span className="muted text-xs">—</span>
                        ) : (
                          <Link href="/pricing" className="inline-flex items-center gap-1 text-xs text-amber-800 hover:text-amber-700">
                            <Lock size={11} /> Unlock
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!benchData.benchmark_allowed && isSchoolStudent === false && (
            <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[13px] text-amber-900 flex items-start gap-2">
              <Lock size={14} className="mt-0.5 shrink-0" />
              <div>
                <strong>Cohort comparison is a Premium Plus feature.</strong> Upgrade to see how your
                pace stacks up against other students on each question, with fast / on-pace / slow
                indicators. Your own per-question times are always visible.{" "}
                <Link href="/pricing" className="underline">See plans →</Link>
              </div>
            </div>
          )}
          {!benchData.benchmark_allowed && isSchoolStudent === true && (
            <div className="mt-3 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-[13px] muted flex items-start gap-2">
              <Lock size={14} className="mt-0.5 shrink-0" />
              <div>
                Per-question pace comparison against other students isn&apos;t included in your
                school&apos;s plan. Your own per-question times are always shown above.
              </div>
            </div>
          )}
          <div className="mt-3 text-xs muted flex items-start gap-1.5">
            <SettingsIcon size={12} className="mt-0.5 shrink-0" />
            <span>
              Times are total ms across all visits to each question (back-button revisits accumulate).
              Tab-switches don&apos;t count. Cohort medians need at least 5 other students to be shown.
              You can turn time tracking off any time in <Link href="/settings" className="underline">Settings</Link>.
            </span>
          </div>
        </div>
      )}

      <div className="card mt-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="h2">Personalised study plan</h3>
          <button type="button" className="btn btn-primary" onClick={getRecs} disabled={loadingRecs}>
            {loadingRecs ? <><span className="spinner" /> Generating…</> : <><Sparkles size={16} /> Generate</>}
          </button>
        </div>
        {recs ? (
          <div className="prose prose-sm max-w-none text-slate-700 whitespace-pre-wrap">{recs}</div>
        ) : (
          <p className="muted text-sm">Tap Generate to get personalised study tips based on your performance.</p>
        )}
      </div>

      {/* ============ MISCONCEPTION DETECTIVE ============
          Lets the student turn each wrong answer into a precisely-named mental
          error that gets logged in their personal ledger at /student/misconceptions.
          We only show this for completed attempts that have at least one wrong
          answer (otherwise there's nothing to diagnose). */}
      {attempt.submitted_at && attempt.score < attempt.total && (
        <div className="card mt-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-2">
              <Search size={20} className="text-amber-700 mt-1 shrink-0" />
              <div>
                <h3 className="h2">Why did I get those wrong?</h3>
                <p className="text-sm muted mt-1 max-w-md">
                  Diagnose the *specific* mental error behind each wrong answer. We&apos;ll add them to your
                  Misconception Ledger so you can drill them away.
                </p>
              </div>
            </div>
            {!diagnosed && (
              <button type="button" className="btn btn-primary" onClick={diagnose} disabled={diagBusy}>
                {diagBusy ? <><span className="spinner" /> Diagnosing…</> : <><Search size={16} /> Diagnose my mistakes</>}
              </button>
            )}
          </div>

          {diagErr && (
            <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{diagErr}</div>
          )}

          {diagnosed && diagnosed.length === 0 && (
            <p className="mt-3 text-sm muted">
              No clear misconception pattern came back — your wrong picks looked more like random slips than a
              consistent mental error.
            </p>
          )}

          {diagnosed && diagnosed.length > 0 && (
            <div className="mt-4 space-y-2">
              {diagnosed.map((m, i) => (
                <div key={i} className="border border-amber-200 bg-amber-50/40 rounded-lg p-3 text-sm flex items-start gap-2">
                  {m.strikes >= 3
                    ? <AlertOctagon size={14} className="text-red-600 mt-0.5 shrink-0" />
                    : <span className="text-amber-600 mt-0.5">!</span>}
                  <div className="flex-1">
                    <div className="font-medium text-slate-900">{m.detail}</div>
                    <div className="text-xs muted mt-0.5">
                      {m.strikes === 1 ? "First time we've seen this." : `Seen ${m.strikes} time${m.strikes === 1 ? "" : "s"} now.`}
                    </div>
                  </div>
                </div>
              ))}
              <div className="pt-2">
                <Link href="/student/misconceptions" className="btn btn-secondary">
                  Open Misconception Ledger →
                </Link>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ============ SPACED REPETITION ENQUEUE ============
          One-click "send my wrong answers to Memory Tune-Up". Idempotent —
          re-clicking just skips already-queued items. */}
      {attempt.submitted_at && attempt.score < attempt.total && (
        <div className="card mt-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-2">
              <Brain size={20} className="text-cyan-700 mt-1 shrink-0" />
              <div>
                <h3 className="h2">Don&apos;t forget the questions you missed</h3>
                <p className="text-sm muted mt-1 max-w-md">
                  Add your wrong answers to Memory Tune-Up. We&apos;ll quiz you on them tomorrow, then 3 days,
                  then a week, then 2 weeks — whatever your forgetting curve needs.
                </p>
              </div>
            </div>
            {!srsResult && (
              <button type="button" className="btn btn-primary" onClick={enqueueMistakes} disabled={srsBusy}>
                {srsBusy ? <><span className="spinner" /> Adding…</> : <><Brain size={16} /> Add my mistakes to memory</>}
              </button>
            )}
          </div>

          {srsErr && (
            <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{srsErr}</div>
          )}

          {srsResult && (
            <div className="mt-3 rounded-lg bg-cyan-50 border border-cyan-200 px-3 py-2 text-sm text-cyan-900 flex items-center justify-between flex-wrap gap-2">
              <div>
                <strong>{srsResult.enqueued}</strong> question{srsResult.enqueued === 1 ? "" : "s"} added to your review queue.
                {srsResult.skipped > 0 && <span className="muted"> {srsResult.skipped} already in queue.</span>}
              </div>
              <Link href="/student/memory" className="btn btn-secondary">Open Memory Tune-Up →</Link>
            </div>
          )}
        </div>
      )}

      {/* ============ DISTRACTOR TRAP DETECTOR ============
          Misconception Detective says "your understanding is wrong."
          This says "your understanding is fine, but the examiner's wording got you." */}
      {attempt.submitted_at && attempt.score < attempt.total && (
        <div className="card mt-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-2">
              <Crosshair size={20} className="text-rose-700 mt-1 shrink-0" />
              <div>
                <h3 className="h2">Did you fall for any traps?</h3>
                <p className="text-sm muted mt-1 max-w-md">
                  Examiners design specific psychological traps in MCQ distractors. We&apos;ll classify each
                  wrong pick by trap type so you stop falling for them.
                </p>
              </div>
            </div>
            {!traps && (
              <button type="button" className="btn btn-primary" onClick={diagnoseTraps} disabled={trapBusy}>
                {trapBusy ? <><span className="spinner" /> Hunting traps…</> : <><Crosshair size={16} /> Find my traps</>}
              </button>
            )}
          </div>

          {trapErr && (
            <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{trapErr}</div>
          )}

          {traps && traps.length === 0 && (
            <p className="mt-3 text-sm muted">
              No clear trap pattern came back — your wrong picks didn&apos;t match the common examiner-trap types.
            </p>
          )}

          {traps && traps.length > 0 && (
            <div className="mt-4 space-y-2">
              {traps.map((t, i) => (
                <div key={i} className="border border-rose-200 bg-rose-50/40 rounded-lg p-3 text-sm flex items-start gap-2">
                  <span className="text-rose-600 mt-0.5">⚠</span>
                  <div className="flex-1">
                    <div className="font-medium text-slate-900">{t.trap_label}</div>
                    <div className="text-xs text-slate-700 mt-0.5">{t.detail}</div>
                  </div>
                </div>
              ))}
              <div className="pt-2">
                <Link href="/student/traps" className="btn btn-secondary">
                  Open Trap Profile →
                </Link>
              </div>
            </div>
          )}
        </div>
      )}

      {/* "Explore more sub-topics" — Phase 4 of generate-context-v2.
          Renders nothing if the quiz has no topic or no useful chips.
          Click a chip → /student/generate prefilled with topic + chip. */}
      <ExploreMoreSubTopics topic={attempt.quiz?.subject ?? attempt.quiz?.name ?? null} />

      {/* ============ MOCK RANK PREDICTOR ============
          Pure UX layer that converts your raw score into a competitive-exam
          AIR estimate. Sits at the bottom of the page so it feels like the
          finishing flourish on a mock test.

          Foolproof gate (2026-05-13): we classify the quiz against the same
          eligibility module the backend uses. If the quiz is a corporate
          skill (Java, Python, AWS, …) we replace the predictor with a
          friendly "this isn't a competitive exam mock" note instead of
          showing a dropdown that would just trigger a 422 from the server.
          For real exam mocks we auto-default the exam_type dropdown to
          the matching value so the student doesn't have to think. */}
      {(() => {
        if (!attempt.submitted_at) return null;
        const eligibility: RankEligibility = classifyQuizForRankPrediction({
          topic: attempt.quiz?.subject ?? null,
          name: attempt.quiz?.name ?? null,
          topicFamily: attempt.quiz?.topic_family ?? null,
        });

        // ─ Allowlist gate (2026-05-13 evening): the rank predictor is ONLY
        //   meaningful when the quiz is clearly a competitive-exam mock.
        //   Show it for matches_known_exam (JEE/NEET/CAT) and
        //   competitive_exam_other (GMAT/GATE/UPSC/…). For corporate_skill
        //   (Java/HSM/Kubernetes) AND generic (Photosynthesis/Algebra/anything
        //   else), refuse — there's no All-India Rank for those tests. This
        //   replaces the previous "blocklist of corporate skills" design,
        //   which required adding tokens forever to stop new failure cases.
        const isExamMock =
          eligibility.verdict === "matches_known_exam" ||
          eligibility.verdict === "competitive_exam_other";
        if (!isExamMock) {
          return (
            <div className="card mt-4 bg-slate-50/60">
              <div className="flex items-start gap-3">
                <Info size={20} className="text-slate-500 mt-0.5 shrink-0" />
                <div className="flex-1">
                  <h3 className="h2">Rank prediction not available for this test</h3>
                  <p className="text-sm muted mt-1 max-w-xl">
                    The Mock Rank Predictor only works for competitive-exam mocks
                    (JEE / NEET / CAT / GMAT / GATE / UPSC and the like). This
                    test doesn&apos;t look like an exam mock, so there&apos;s no
                    All-India Rank to estimate. If you want a rank against a
                    specific exam cohort, type a score directly on the{" "}
                    <Link href="/student/rank" className="text-emerald-700 underline">Mock Rank Predictor</Link>.
                  </p>
                </div>
              </div>
            </div>
          );
        }

        // ─ Predictor surface for everything else. Suggest the exam_type
        //   the topic implies (e.g., quiz topic "CAT mock 1" → default
        //   the dropdown to CAT). The user can still override.
        const suggestedExam =
          eligibility.verdict === "matches_known_exam"
            ? eligibility.suggestedExamType
            : null;
        // Side effect: align local state with the suggestion on first render.
        // Guarded so the user's manual change isn't clobbered.
        if (suggestedExam && examType === "JEE_MAIN" && suggestedExam !== "JEE_MAIN" && !rank && !rankBusy) {
          // Defer to next tick to avoid setState-during-render.
          queueMicrotask(() => setExamType(suggestedExam));
        }

        return (
          <div className="card mt-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-start gap-2">
                <Trophy size={20} className="text-amber-700 mt-1 shrink-0" />
                <div>
                  <h3 className="h2">Predict my rank</h3>
                  <p className="text-sm muted mt-1 max-w-md">
                    See an estimated All-India Rank for this score against a JEE Main, NEET, or CAT-sized cohort.
                    {suggestedExam && (
                      <span className="block mt-1 text-xs text-amber-800">
                        This test looks like a {suggestedExam.replace("_", " ")} mock — we&apos;ve pre-selected it below.
                      </span>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex gap-2 items-center flex-wrap">
                <select
                  className="select"
                  value={examType}
                  onChange={(e) => setExamType(e.target.value as typeof examType)}
                >
                  <option value="JEE_MAIN">JEE Main</option>
                  <option value="NEET">NEET</option>
                  <option value="CAT">CAT</option>
                  <option value="CUSTOM">Custom</option>
                </select>
                <button type="button" className="btn btn-primary" onClick={predictRank} disabled={rankBusy}>
                  {rankBusy ? <><span className="spinner" /> Calculating…</> : <><Trophy size={16} /> Predict rank</>}
                </button>
              </div>
            </div>

            {rankErr && (
              <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{rankErr}</div>
            )}

            {rank && (
              <div className="mt-4 grid sm:grid-cols-3 gap-3">
                {/* If the server snapped exam_type (e.g., user picked CAT
                    but quiz topic was JEE Physics), surface that loudly so
                    the student sees an honest explanation rather than a
                    silently-different prediction. */}
                {rank.exam_type_override && (
                  <div className="sm:col-span-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] text-amber-900 flex items-start gap-2">
                    <Info size={14} className="mt-0.5 shrink-0" />
                    <div>
                      <strong>Heads up:</strong> {rank.exam_type_override.reason}
                    </div>
                  </div>
                )}
                <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-3">
                  <div className="text-xs muted uppercase font-semibold">Percentile</div>
                  <div className="text-2xl font-bold mt-0.5">{rank.percentile.toFixed(1)}</div>
                </div>
                <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-3">
                  <div className="text-xs muted uppercase font-semibold">Predicted AIR ({rank.exam_type.replace("_", " ")})</div>
                  <div className="text-2xl font-bold mt-0.5">~{rank.predicted_air.toLocaleString()}</div>
                  <div className="text-[11px] muted mt-0.5">in {rank.total_candidates.toLocaleString()} candidates</div>
                </div>
                <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-3">
                  <Link href="/student/rank" className="btn btn-secondary w-full">All predictions →</Link>
                </div>

                {rank.recommendations.length > 0 && (
                  <div className="sm:col-span-3">
                    <div className="text-xs muted uppercase font-semibold mb-2">Where to gain marks fastest</div>
                    <ul className="space-y-1.5 text-sm">
                      {rank.recommendations.map((r, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className="mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-600 text-white text-xs font-bold shrink-0">{i + 1}</span>
                          <span>{r}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* ============ REVIEW YOUR ANSWERS ============
          Per-question walkthrough so the student can see what they got
          right, what they got wrong, what they skipped, and WHY (via
          the AI-authored explanation). Vipin caught the absence of
          this surface on 2026-05-12 — every test surface generated
          questions but no surface let the learner inspect them after.
          Collapsible so the page doesn't dump 30 questions on the
          student by default — open by default for ≤10 questions,
          collapsed by default beyond that. */}
      {attempt.submitted_at && reviewItems.length > 0 && (
        <div className="card mt-4">
          <button
            type="button"
            className="w-full flex items-center justify-between gap-3 text-left"
            onClick={() => setReviewExpanded((v) => !v)}
          >
            <div>
              <h3 className="h2">Review your answers</h3>
              <p className="text-sm muted mt-1">
                {reviewItems.length} question{reviewItems.length === 1 ? "" : "s"} —
                see what you picked, the correct answer, and an explanation for each.
              </p>
            </div>
            <span className="text-sm font-semibold text-emerald-700 whitespace-nowrap">
              {reviewExpanded ? "Hide ▲" : "Show ▼"}
            </span>
          </button>

          {reviewExpanded && (
            <div className="mt-4 space-y-4">
              {reviewItems.map((q, idx) => {
                const isSkipped = q.selected_index === null;
                const isWrong = !isSkipped && q.is_correct === false;
                const isRight = !isSkipped && q.is_correct === true;
                const headerStyle = isRight
                  ? "border-emerald-200 bg-emerald-50/40"
                  : isWrong
                  ? "border-red-200 bg-red-50/40"
                  : "border-amber-200 bg-amber-50/40";
                return (
                  <div
                    key={q.question_id}
                    className={`rounded-lg border-2 ${headerStyle} p-4`}
                  >
                    <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-slate-800 text-white text-xs font-bold shrink-0">
                          {idx + 1}
                        </span>
                        <span className={`badge badge-${q.bloom_level}`}>
                          {BLOOM_META[q.bloom_level]?.label || q.bloom_level}
                        </span>
                        {isRight && (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-800 bg-emerald-100 border border-emerald-300 rounded-full px-2 py-0.5">
                            <CheckCircle2 size={12} /> Correct
                          </span>
                        )}
                        {isWrong && (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-800 bg-red-100 border border-red-300 rounded-full px-2 py-0.5">
                            <XCircle size={12} /> Wrong
                          </span>
                        )}
                        {isSkipped && (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-900 bg-amber-100 border border-amber-300 rounded-full px-2 py-0.5">
                            <MinusCircle size={12} /> Skipped
                          </span>
                        )}
                      </div>
                      {q.marks_earned !== null && (
                        <span className={`text-xs font-mono font-semibold ${
                          q.marks_earned > 0 ? "text-emerald-700"
                          : q.marks_earned < 0 ? "text-red-700"
                          : "text-slate-600"
                        }`}>
                          {q.marks_earned > 0 ? "+" : ""}{q.marks_earned} mark{Math.abs(q.marks_earned) === 1 ? "" : "s"}
                        </span>
                      )}
                    </div>

                    <div className="font-medium text-slate-900 mb-3 leading-relaxed">
                      {q.stem}
                    </div>

                    <div className="space-y-1.5">
                      {q.options.map((opt, oi) => {
                        const isStudentPick = q.selected_index === oi;
                        const isAnswerKey = q.correct_index === oi;
                        const cls = isAnswerKey
                          ? "border-emerald-500 bg-emerald-50"
                          : isStudentPick
                          ? "border-red-400 bg-red-50"
                          : "border-slate-200 bg-white";
                        return (
                          <div
                            key={oi}
                            className={`rounded-md border-2 ${cls} px-3 py-2 text-sm flex items-start gap-2`}
                          >
                            <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold shrink-0 mt-0.5 ${
                              isAnswerKey ? "bg-emerald-600 text-white"
                              : isStudentPick ? "bg-red-500 text-white"
                              : "bg-slate-200 text-slate-700"
                            }`}>
                              {String.fromCharCode(65 + oi)}
                            </span>
                            <span className="flex-1 leading-relaxed">{opt}</span>
                            <span className="flex flex-col items-end gap-0.5 text-[10px] uppercase tracking-wide font-semibold">
                              {isStudentPick && (
                                <span className={isAnswerKey ? "text-emerald-700" : "text-red-700"}>
                                  Your pick
                                </span>
                              )}
                              {isAnswerKey && !isStudentPick && (
                                <span className="text-emerald-700">Correct</span>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    {q.explanation && (
                      <div className="mt-3 rounded-md bg-slate-50 border border-slate-200 px-3 py-2 text-sm leading-relaxed">
                        <div className="text-[10px] uppercase tracking-wide font-bold text-slate-500 mb-1">
                          Explanation
                        </div>
                        <div className="text-slate-800">{q.explanation}</div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
