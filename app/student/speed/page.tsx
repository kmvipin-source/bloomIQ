"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { BLOOM_META, isBloomLevel, type BloomLevel } from "@/lib/bloom";
import { triggerScoreRecompute } from "@/lib/scoreRecompute";
import {
  Timer, Zap, Sparkles, ArrowLeft, Loader2, CheckCircle2, XCircle, History,
} from "lucide-react";
import CurrentGoalChip from "@/components/CurrentGoalChip";
import MarkingSchemePicker from "@/components/MarkingSchemePicker";
import { type MarkingScheme } from "@/lib/scoring";
import { suggestPresetForGoal, type ScoringPresetKey } from "@/lib/scoringPresets";
import { suggestedTopics, placeholderTopic } from "@/lib/topicSuggestions";
import { type LearnerProfile } from "@/components/LearnerProfilePrompt";

// =============================================================================
// SPEED-ACCURACY TRAINER — competitive-exam pacing tool. Each question has a
// target time based on its Bloom level. After submission the student sees a
// 4-quadrant verdict (Fast+Right / Slow+Right / Fast+Wrong / Slow+Wrong),
// which is the single most important diagnostic in JEE/NEET-style prep.
// =============================================================================

type ServerQ = {
  stem: string;
  options: string[];
  correct_index: number;
  bloom_level: BloomLevel;
  target_ms: number;
  explanation?: string;
};

type SubmitResp = {
  id: string;
  total_questions: number;
  correct_count: number;
  total_time_ms: number;
  quadrant: { fast_right: number; slow_right: number; fast_wrong: number; slow_wrong: number };
  verdict: { title: string; coaching: string };
};

type HistoryRow = {
  id: string;
  topic: string | null;
  total_questions: number;
  correct_count: number;
  fast_right_count: number;
  slow_right_count: number;
  fast_wrong_count: number;
  slow_wrong_count: number;
  total_time_ms: number;
  created_at: string;
};

function fmtSec(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}m ${rem.toString().padStart(2, "0")}s`;
}

export default function SpeedTrainerPage() {
  const [topic, setTopic] = useState("");
  const [recentTopics, setRecentTopics] = useState<string[]>([]);
  const [count, setCount] = useState(8);

  // Learning-context-aware topic suggestions + sticky marking scheme.
  // Both pull from profile (exam_goal, learner_profile, last_marking_scheme)
  // so a CAT student sees CAT-style topic chips + their previously-picked
  // marking scheme, a corporate learner sees Kubernetes / AWS / Java chips,
  // and a Class 10 student sees board-pattern topics — never "Kinematics"
  // for everyone.
  const [examGoal, setExamGoal] = useState<string | null>(null);
  const [learnerProfile, setLearnerProfile] = useState<LearnerProfile | null>(null);
  const [markingScheme, setMarkingScheme] = useState<MarkingScheme | null>(null);
  const [suggestedPreset, setSuggestedPreset] = useState<ScoringPresetKey>("PRACTICE");

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Active session state
  const [questions, setQuestions] = useState<ServerQ[] | null>(null);
  const [activeTopic, setActiveTopic] = useState<string>("");
  const [picks, setPicks] = useState<number[]>([]);
  const [times, setTimes] = useState<number[]>([]);
  // Confidence rating per question (1=guess, 4=sure). 0 = not yet rated.
  const [confidences, setConfidences] = useState<number[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [questionStartMs, setQuestionStartMs] = useState<number>(0);

  const [result, setResult] = useState<SubmitResp | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);

  // Per-question countdown display
  const tickRef = useRef<number | null>(null);
  const [, setNow] = useState(0); // forces re-render each tick

  useEffect(() => {
    void loadHistory();
    void loadRecentTopics();
    void loadLearningContext();
  }, []);

  // Fetch the student's exam_goal, learner_profile, and last_marking_scheme.
  // Drives the topic-suggestion chips, the placeholder, the marking-scheme
  // picker's pre-fill, and the marking-scheme suggestion banner.
  async function loadLearningContext() {
    try {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;
      const { data: prof } = await sb
        .from("profiles")
        .select("exam_goal, learner_profile, last_marking_scheme")
        .eq("id", user.id)
        .maybeSingle();
      const row = prof as {
        exam_goal: string | null;
        learner_profile: string | null;
        last_marking_scheme: unknown | null;
      } | null;
      if (row?.exam_goal) setExamGoal(row.exam_goal);
      const lp = row?.learner_profile;
      if (lp === "k12" || lp === "competitive_exam" || lp === "corporate") {
        setLearnerProfile(lp);
      }
      setSuggestedPreset(suggestPresetForGoal(row?.exam_goal ?? null));
      if (row?.last_marking_scheme && typeof row.last_marking_scheme === "object") {
        setMarkingScheme(row.last_marking_scheme as MarkingScheme);
      }
    } catch { /* silent — chips fall back to k12 defaults */ }
  }

  useEffect(() => {
    // Tick the countdown for the active question
    if (!questions || result) return;
    tickRef.current = window.setInterval(() => setNow(Date.now()), 250) as unknown as number;
    return () => {
      if (tickRef.current) window.clearInterval(tickRef.current);
    };
  }, [questions, result, currentIdx]);

  async function loadHistory() {
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;
    const { data } = await sb
      .from("speed_sessions")
      .select("id, topic, total_questions, correct_count, fast_right_count, slow_right_count, fast_wrong_count, slow_wrong_count, total_time_ms, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(8);
    setHistory((data as unknown as HistoryRow[]) || []);
  }

  async function loadRecentTopics() {
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;
    const { data } = await sb
      .from("question_bank")
      .select("topic")
      .eq("owner_id", user.id)
      .not("topic", "is", null)
      .order("created_at", { ascending: false })
      .limit(60);
    const seen = new Set<string>();
    for (const r of ((data || []) as Array<{ topic: string | null }>)) {
      if (r.topic && !seen.has(r.topic)) seen.add(r.topic);
      if (seen.size >= 6) break;
    }
    setRecentTopics(Array.from(seen));
  }

  async function start() {
    setErr(null);
    setResult(null);
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired — please sign in again.");
      const r = await fetch("/api/speed/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        // markingScheme is forwarded to the server so it can persist
        // last_marking_scheme on success and (when meaningful for this
        // surface) drive negative-marks-aware scoring on submit.
        body: JSON.stringify({ topic: topic.trim() || undefined, count, markingScheme }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Could not start session");
      const qs: ServerQ[] = (j.questions || []).filter((q: { bloom_level: string }) => isBloomLevel(q.bloom_level));
      if (qs.length === 0) throw new Error("AI returned no usable questions.");
      setQuestions(qs);
      setActiveTopic(j.topic || topic);
      setPicks(new Array(qs.length).fill(-1));
      setTimes(new Array(qs.length).fill(0));
      setConfidences(new Array(qs.length).fill(0));
      setCurrentIdx(0);
      setQuestionStartMs(Date.now());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start session");
    } finally {
      setBusy(false);
    }
  }

  function rateConfidence(level: number) {
    if (!questions) return;
    const next = [...confidences];
    next[currentIdx] = level;
    setConfidences(next);
  }

  function pick(optionIdx: number) {
    if (!questions) return;
    const elapsed = Date.now() - questionStartMs;
    const newPicks = [...picks];
    newPicks[currentIdx] = optionIdx;
    const newTimes = [...times];
    newTimes[currentIdx] = elapsed;
    setPicks(newPicks);
    setTimes(newTimes);

    // Auto-advance after a brief beat so the student feels the rhythm.
    if (currentIdx < questions.length - 1) {
      window.setTimeout(() => {
        setCurrentIdx((i) => i + 1);
        setQuestionStartMs(Date.now());
      }, 250);
    }
  }

  function skip() {
    if (!questions) return;
    const elapsed = Date.now() - questionStartMs;
    const newTimes = [...times];
    newTimes[currentIdx] = elapsed;
    setTimes(newTimes);
    if (currentIdx < questions.length - 1) {
      setCurrentIdx((i) => i + 1);
      setQuestionStartMs(Date.now());
    }
  }

  async function submit() {
    if (!questions) return;
    setBusy(true);
    setErr(null);
    try {
      // Make sure the current (last) question's elapsed time is captured.
      const finalTimes = [...times];
      if (finalTimes[currentIdx] === 0) {
        finalTimes[currentIdx] = Date.now() - questionStartMs;
      }
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired — please sign in again.");
      const payload = {
        topic: activeTopic,
        questions: questions.map((q, i) => ({
          stem: q.stem,
          options: q.options,
          correct_index: q.correct_index,
          bloom_level: q.bloom_level,
          target_ms: q.target_ms,
          time_ms: finalTimes[i] || 0,
          picked: picks[i],
          explanation: q.explanation || null,
        })),
      };
      const r = await fetch("/api/speed/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Submit failed");
      setResult(j as SubmitResp);
      void loadHistory();
      // Recompute BloomIQ score after a speed-trainer round.
      void triggerScoreRecompute("drill", null);

      // Best-effort: log confidence-calibration events alongside the speed
      // session. Only events where the student actually rated their confidence
      // (>= 1) are sent. Failure is silent — calibration is non-critical.
      try {
        const events = questions
          .map((q, i) => {
            const conf = confidences[i] || 0;
            if (conf < 1 || picks[i] < 0) return null;
            return {
              source: "speed",
              confidence: conf,
              was_correct: picks[i] === q.correct_index,
              bloom_level: q.bloom_level,
              topic: activeTopic || null,
            };
          })
          .filter(Boolean);
        if (events.length > 0) {
          await fetch("/api/calibration/log", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
            body: JSON.stringify({ events }),
          });
        }
      } catch { /* silent — calibration is best-effort */ }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Submit failed");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setQuestions(null);
    setResult(null);
    setPicks([]);
    setTimes([]);
    setConfidences([]);
    setCurrentIdx(0);
  }

  const allAnswered = questions ? picks.every((p) => p !== -1) : false;
  const onLast = questions ? currentIdx === questions.length - 1 : false;

  return (
    <div className="max-w-3xl mx-auto fade-in">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <Link href="/student" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-emerald-700">
          <ArrowLeft size={14} /> Back to dashboard
        </Link>
        {/* Persistent goal chip — tap to change context from anywhere. */}
        <CurrentGoalChip />
      </div>

      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-orange-100 text-orange-700 p-3 shrink-0">
          <Timer size={22} />
        </div>
        <div className="flex-1">
          <h1 className="h1">Speed-Accuracy Trainer</h1>
          <p className="muted mt-1">
            Each question gets a target time based on its Bloom level. Beat the timer with the right answer, and
            you&apos;re exam-ready. Burn the clock — even when you&apos;re right — and you need pace work.
          </p>
        </div>
      </div>

      {/* SETUP */}
      {!questions && !result && (
        <div className="card mt-6 space-y-4">
          <div>
            <label className="label">Topic</label>
            <input
              className="input"
              placeholder={placeholderTopic(examGoal, learnerProfile)}
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              maxLength={120}
            />
            {/* Suggested topics — goal-aware. A CAT student sees QA/VARC
                topics, a corporate learner sees Kubernetes/AWS/Java, a
                Class 10 student sees board topics. Tap a chip to fill
                the input. The "recent topics" chip row sits below
                (history-driven, not goal-driven). */}
            <div className="mt-2 flex flex-wrap gap-2">
              {suggestedTopics(examGoal, learnerProfile).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTopic(t)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition ${
                    topic === t
                      ? "bg-emerald-100 border-emerald-300 text-emerald-800 font-semibold"
                      : "bg-white border-slate-200 text-slate-700 hover:border-emerald-300"
                  }`}
                  title="Tap to use this topic"
                >
                  {t}
                </button>
              ))}
            </div>
            {recentTopics.length > 0 && (
              <div className="mt-3">
                <div className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 mb-1">
                  Recent topics
                </div>
                <div className="flex flex-wrap gap-2">
                  {recentTopics.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTopic(t)}
                      className={`text-xs px-2.5 py-1 rounded-full border transition ${
                        topic === t
                          ? "bg-emerald-100 border-emerald-300 text-emerald-800 font-semibold"
                          : "bg-white border-slate-200 text-slate-700 hover:border-emerald-300"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div>
            <label className="label">Number of questions</label>
            <div className="flex gap-2 flex-wrap">
              {[5, 8, 10, 15].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setCount(n)}
                  className={`btn ${count === n ? "btn-primary" : "btn-secondary"}`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          {/* Marking scheme — sticky pre-fill from profile.last_marking_scheme.
              Default = PRACTICE (+1/0); set once via the picker and it
              follows the user across Speed / Sprint / Drill / Practice /
              Generate / Teacher quiz builder. */}
          <div>
            <label className="label">Marking scheme</label>
            <MarkingSchemePicker
              value={markingScheme}
              onChange={setMarkingScheme}
              suggested={suggestedPreset}
            />
          </div>

          {err && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>
          )}
          <button type="button" className="btn btn-primary" onClick={start} disabled={busy}>
            {busy ? <><Loader2 className="animate-spin" size={16} /> Loading questions…</> : <><Zap size={16} /> Start trainer</>}
          </button>
        </div>
      )}

      {/* SESSION IN PROGRESS */}
      {questions && !result && (() => {
        const q = questions[currentIdx];
        const elapsed = Date.now() - questionStartMs;
        const remaining = Math.max(0, q.target_ms - elapsed);
        const overBy = Math.max(0, elapsed - q.target_ms);
        const overTime = elapsed > q.target_ms;
        return (
          <div className="mt-6 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="text-sm muted">
                Question <strong className="text-slate-900">{currentIdx + 1}</strong> of {questions.length}
                <span className="mx-2">·</span>
                <span className={`badge badge-${q.bloom_level}`}>{BLOOM_META[q.bloom_level].label}</span>
              </div>
              <div className={`text-sm font-bold ${overTime ? "text-red-700" : remaining < 10_000 ? "text-amber-700" : "text-emerald-700"}`}>
                {overTime ? <>Over by {fmtSec(overBy)}</> : <>{fmtSec(remaining)} left</>}
                <span className="ml-1 muted text-xs font-normal">target {fmtSec(q.target_ms)}</span>
              </div>
            </div>

            {/* Timer bar */}
            <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all ${overTime ? "bg-red-500" : remaining < 10_000 ? "bg-amber-500" : "bg-emerald-500"}`}
                style={{ width: `${Math.min(100, (elapsed / q.target_ms) * 100)}%` }}
              />
            </div>

            <div className="card">
              <div className="font-medium text-slate-900">{q.stem}</div>

              {/* Confidence picker — student must rate their gut BEFORE picking
                  the answer. Optional: if they skip, no calibration is logged
                  for this question. We disable rate changes once an answer is
                  picked so the rating reflects pre-answer gut, not hindsight. */}
              <div className="mt-3 rounded-lg bg-teal-50/50 border border-teal-200 p-2.5">
                <div className="text-[10px] uppercase tracking-wide font-semibold text-teal-800 mb-1.5">
                  How confident are you? <span className="font-normal text-slate-600">(rate before answering — optional, calibrates your gut)</span>
                </div>
                <div className="flex gap-1.5 flex-wrap">
                  {[
                    { lvl: 1, label: "Guess" },
                    { lvl: 2, label: "Probably not" },
                    { lvl: 3, label: "Probably" },
                    { lvl: 4, label: "Sure" },
                  ].map((b) => {
                    const active = confidences[currentIdx] === b.lvl;
                    const locked = picks[currentIdx] !== -1;
                    return (
                      <button
                        key={b.lvl}
                        type="button"
                        onClick={() => !locked && rateConfidence(b.lvl)}
                        disabled={locked}
                        className={`text-xs rounded-full border px-2.5 py-1 transition ${
                          active
                            ? "bg-teal-600 text-white border-teal-600"
                            : "bg-white text-slate-700 border-slate-200 hover:border-teal-400"
                        } ${locked ? "opacity-60 cursor-not-allowed" : ""}`}
                      >
                        {b.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="mt-3 space-y-2">
                {q.options.map((o, oi) => (
                  <button
                    key={oi}
                    type="button"
                    onClick={() => pick(oi)}
                    disabled={picks[currentIdx] !== -1}
                    className={`w-full text-left text-sm rounded-lg border px-3 py-2 transition ${
                      picks[currentIdx] === oi
                        ? "bg-emerald-50/70 border-emerald-300"
                        : "bg-white border-slate-200 hover:border-emerald-300"
                    }`}
                  >
                    <span className="font-semibold mr-2">{String.fromCharCode(65 + oi)}.</span> {o}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-2 flex-wrap">
              {!onLast && (
                <button type="button" className="btn btn-secondary" onClick={skip}>Skip</button>
              )}
              {onLast && (
                <button type="button" className="btn btn-primary ml-auto" onClick={submit} disabled={busy || !allAnswered}>
                  {busy ? <><Loader2 className="animate-spin" size={14} /> Scoring…</> : <>Finish &amp; see results</>}
                </button>
              )}
              {onLast && !allAnswered && (
                <span className="text-xs text-amber-700 ml-auto self-center">Answer every question to finish.</span>
              )}
            </div>
          </div>
        );
      })()}

      {/* RESULT */}
      {result && (
        <div className="mt-6 space-y-4">
          <div className={`card border-2 ${result.verdict.title === "Sharpshooter" ? "border-emerald-300 bg-emerald-50/40" : "border-amber-300 bg-amber-50/40"}`}>
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <div className="text-xs uppercase tracking-wide font-semibold text-slate-700">Verdict</div>
                <div className="text-2xl font-bold mt-0.5">{result.verdict.title}</div>
                <p className="text-sm text-slate-700 mt-2 max-w-prose">{result.verdict.coaching}</p>
              </div>
              <div className="text-right">
                <div className="text-3xl font-bold">{result.correct_count}/{result.total_questions}</div>
                <div className="text-xs muted">in {fmtSec(result.total_time_ms)}</div>
              </div>
            </div>
          </div>

          {/* Quadrant card */}
          <div className="card">
            <h3 className="font-semibold mb-3">Where your answers landed</h3>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3">
                <div className="flex items-center gap-1 text-emerald-800 font-semibold">
                  <CheckCircle2 size={14} /> Fast &amp; right
                </div>
                <div className="text-2xl font-bold mt-1">{result.quadrant.fast_right}</div>
                <div className="text-[11px] muted">Exam-ready answers</div>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
                <div className="flex items-center gap-1 text-amber-800 font-semibold">
                  <Timer size={14} /> Slow &amp; right
                </div>
                <div className="text-2xl font-bold mt-1">{result.quadrant.slow_right}</div>
                <div className="text-[11px] muted">You knew it but burned the clock</div>
              </div>
              <div className="rounded-lg border border-orange-200 bg-orange-50/50 p-3">
                <div className="flex items-center gap-1 text-orange-800 font-semibold">
                  <Zap size={14} /> Fast &amp; wrong
                </div>
                <div className="text-2xl font-bold mt-1">{result.quadrant.fast_wrong}</div>
                <div className="text-[11px] muted">Too quick — read more carefully</div>
              </div>
              <div className="rounded-lg border border-red-200 bg-red-50/50 p-3">
                <div className="flex items-center gap-1 text-red-800 font-semibold">
                  <XCircle size={14} /> Slow &amp; wrong
                </div>
                <div className="text-2xl font-bold mt-1">{result.quadrant.slow_wrong}</div>
                <div className="text-[11px] muted">You don&apos;t know it yet — go study</div>
              </div>
            </div>
          </div>

          {/* Bridge to the read-only Confidence Insights dashboard. Speed
              Trainer is where confidence ratings are COLLECTED; the
              dashboard at /student/calibration aggregates those ratings
              into a stated-vs-actual chart. Surfacing it here forward
              makes the relationship explicit so students don't
              experience the "two names, same screen" confusion that
              Vipin flagged on 2026-05-13. */}
          <Link
            href="/student/calibration"
            className="card flex items-center justify-between gap-3 hover:bg-teal-50/40 transition border-teal-200"
          >
            <div className="flex items-start gap-3">
              <div className="rounded-lg bg-teal-100 text-teal-700 p-2 shrink-0">
                <Sparkles size={16} />
              </div>
              <div>
                <div className="font-semibold">Confidence Insights ready</div>
                <div className="text-xs muted">
                  Every Sure / Probably / Guess you marked on this session has been logged. See how
                  well-calibrated your hunches are over time.
                </div>
              </div>
            </div>
            <span className="text-sm font-semibold text-teal-700 whitespace-nowrap">Open dashboard →</span>
          </Link>

          {/* ============ PER-QUESTION REVIEW ============
              Now that the session is graded, show every question with the
              correct answer + the student's pick + the explanation. This is
              the surface the student actually learns from — the quadrant
              card is the diagnosis, this is the cure. */}
          {questions && (
            <div className="card">
              <h3 className="font-semibold">Review every answer</h3>
              <p className="text-xs muted mt-1 mb-4">
                Green = correct answer. Red = your pick that was wrong. Read each explanation — that&apos;s where the
                learning happens.
              </p>

              <div className="space-y-3">
                {questions.map((q, qi) => {
                  const studentPick = picks[qi];
                  const skipped = studentPick === -1;
                  const isRight = studentPick === q.correct_index;
                  const timeMs = times[qi] || 0;
                  const fast = timeMs <= q.target_ms;
                  const overBy = timeMs - q.target_ms;

                  // Header status pill: right/wrong/skipped + fast/slow.
                  const statusBg =
                    skipped     ? "bg-slate-100 text-slate-700"
                    : isRight   ? "bg-emerald-100 text-emerald-800"
                                : "bg-red-100 text-red-800";
                  const statusLabel =
                    skipped     ? "Skipped"
                    : isRight   ? "Correct"
                                : "Wrong";

                  return (
                    <div key={qi} className="rounded-lg border border-slate-200 bg-white p-4">
                      {/* Header row: Q#, Bloom, time, status */}
                      <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-semibold text-slate-500">Q{qi + 1}</span>
                          <span className={`badge badge-${q.bloom_level}`}>{BLOOM_META[q.bloom_level].label}</span>
                          <span className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${statusBg}`}>
                            {statusLabel}
                          </span>
                        </div>
                        <div className="text-xs">
                          <span className={fast ? "text-emerald-700" : "text-amber-700"}>
                            {fmtSec(timeMs)}
                          </span>
                          <span className="muted ml-1">
                            (target {fmtSec(q.target_ms)}{!fast && overBy > 0 ? ` · over by ${fmtSec(overBy)}` : ""})
                          </span>
                        </div>
                      </div>

                      {/* Stem */}
                      <div className="font-medium text-sm text-slate-900">{q.stem}</div>

                      {/* Options with correct/picked markings */}
                      <div className="mt-3 space-y-1.5">
                        {q.options.map((o, oi) => {
                          const isCorrect = oi === q.correct_index;
                          const isStudentPick = oi === studentPick;
                          const isWrongPick = isStudentPick && !isRight;

                          let cls = "border-slate-200 bg-white text-slate-700";
                          if (isCorrect) cls = "border-emerald-400 bg-emerald-50 text-emerald-900";
                          else if (isWrongPick) cls = "border-red-400 bg-red-50 text-red-900";

                          return (
                            <div
                              key={oi}
                              className={`flex items-start gap-2 text-sm rounded-md border px-3 py-2 ${cls}`}
                            >
                              <span className="font-semibold w-5 shrink-0">{String.fromCharCode(65 + oi)}.</span>
                              <span className="flex-1">{o}</span>
                              {isCorrect && (
                                <span className="text-xs font-semibold text-emerald-700 inline-flex items-center gap-1 shrink-0">
                                  <CheckCircle2 size={12} /> Correct answer
                                </span>
                              )}
                              {isWrongPick && (
                                <span className="text-xs font-semibold text-red-700 inline-flex items-center gap-1 shrink-0">
                                  <XCircle size={12} /> Your pick
                                </span>
                              )}
                              {isStudentPick && isRight && (
                                <span className="text-xs font-semibold text-emerald-700 inline-flex items-center gap-1 shrink-0">
                                  Your pick
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {/* Explanation */}
                      {q.explanation && (
                        <div className="mt-3 text-xs text-slate-800 bg-slate-50 border border-slate-200 rounded-md px-3 py-2 leading-relaxed">
                          <strong className="text-slate-900">Why this is the answer: </strong>
                          {q.explanation}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button type="button" className="btn btn-primary" onClick={reset}>
              <Sparkles size={14} /> Train again
            </button>
            <Link href="/student" className="btn btn-secondary">
              Back to dashboard
            </Link>
          </div>
        </div>
      )}

      {/* HISTORY */}
      <h2 className="h2 mt-10 mb-3 flex items-center gap-2">
        <History size={18} /> Recent sessions
      </h2>
      {history.length === 0 ? (
        <div className="card text-center py-8 muted text-sm">No sessions yet.</div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase muted">
              <tr>
                <th className="px-4 py-3 text-left">Topic</th>
                <th className="px-4 py-3 text-left">Score</th>
                <th className="px-4 py-3 text-left">Fast+right</th>
                <th className="px-4 py-3 text-left">Slow+right</th>
                <th className="px-4 py-3 text-left">Time</th>
                <th className="px-4 py-3 text-left">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {history.map((h) => (
                <tr key={h.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium">{h.topic || "—"}</td>
                  <td className="px-4 py-3">{h.correct_count}/{h.total_questions}</td>
                  <td className="px-4 py-3 text-emerald-700 font-semibold">{h.fast_right_count}</td>
                  <td className="px-4 py-3 text-amber-700">{h.slow_right_count}</td>
                  <td className="px-4 py-3 muted">{fmtSec(h.total_time_ms)}</td>
                  <td className="px-4 py-3 muted">{new Date(h.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
