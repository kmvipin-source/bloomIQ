"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import type { Question, Quiz } from "@/lib/types";
import BloomBadge from "@/components/BloomBadge";
import { formatSeconds } from "@/lib/utils";
import { ChevronLeft, ChevronRight, AlarmClock, Clock, Play, AlertCircle } from "lucide-react";
import { track } from "@/lib/posthog";
import { triggerScoreRecompute } from "@/lib/scoreRecompute";
import {
  computeAttemptScore,
  marksEarnedFor,
  resolveScheme,
  type AttemptAnswerInput,
} from "@/lib/scoring";

export default function TakeQuiz() {
  const router = useRouter();
  const { code } = useParams<{ code: string }>();
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [idx, setIdx] = useState(0);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number>(0);
  const [submitting, setSubmitting] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const startedAtRef = useRef<number>(Date.now());
  const submittingRef = useRef(false);

  // Per-question timing — gated by per-attempt opt-in. The student picks
  // it on the pre-test screen via a checkbox; we used to ask via a
  // mid-quiz modal but moved to a pre-test checkbox so the question is
  // answered BEFORE the timer starts and is visible per-attempt rather
  // than once-forever.
  //
  // trackTime is the LOCKED-IN state for this attempt — set when the
  // student clicks "Begin test". trackTimeChoice is the live checkbox
  // state on the pre-test screen, pre-filled from profile.
  const [trackTime, setTrackTime] = useState<boolean>(false);
  const [trackTimeChoice, setTrackTimeChoice] = useState<boolean>(false);

  // Pre-test gating — `started` flips true only when the student clicks
  // "Begin test" (or when we resume an in-progress attempt found in DB).
  // Until then, the pre-test screen renders, no attempt row is created,
  // and the timer is paused.
  const [quizLoaded, setQuizLoaded] = useState(false);
  const [started, setStarted] = useState(false);
  const [beginning, setBeginning] = useState(false);

  // Per-question timing accumulators. We sum ms across ALL visits to a
  // question (back-button revisits count) so the final number reflects
  // total cognitive time, not just the first viewing.
  const questionMsRef = useRef<Record<string, number>>({});
  // Timestamp at which the currently-visible question became current.
  // Null when the timer is paused (tab hidden, student hasn't consented,
  // or questions still loading).
  const currentQStartRef = useRef<number | null>(null);
  // Id of the question whose timer is currently running. Tracked alongside
  // currentQStartRef so we know which bucket to flush into when idx changes.
  const currentQIdRef = useRef<string | null>(null);

  // Flush accumulated time for the currently-tracked question into the map.
  // Idempotent — clears the current marker so it can't double-count.
  const flushCurrentQuestionTime = useCallback(() => {
    const qid = currentQIdRef.current;
    const startedAt = currentQStartRef.current;
    if (qid && startedAt !== null) {
      const elapsed = Date.now() - startedAt;
      if (elapsed > 0) {
        questionMsRef.current[qid] = (questionMsRef.current[qid] || 0) + elapsed;
      }
    }
    currentQIdRef.current = null;
    currentQStartRef.current = null;
  }, []);

  // Load quiz + questions + check for existing in-progress attempt.
  // Does NOT create a new attempt — that's deferred to the Begin button
  // so the per-attempt timer doesn't start clocking the moment the page
  // loads (a student who closes the tab without starting shouldn't burn
  // a daily attempt slot or have a mismatched started_at).
  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      const { data: { user } } = await sb.auth.getUser();
      if (!user || !session) { setLoadErr("Not signed in."); return; }

      // Quiz + questions come from the server-mediated endpoint (admin
      // client behind it). Direct table reads here used to require open
      // RLS on `quizzes` / `quiz_questions` / `question_bank` for every
      // authenticated user — this closes that exposure.
      const r = await fetch(`/api/student/quiz-by-code?code=${encodeURIComponent(code)}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (r.status === 404) { setLoadErr(`No quiz found with code "${code}". It may have been deleted, or the code is wrong.`); return; }
      if (r.status === 410) { setLoadErr("This quiz is closed."); return; }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setLoadErr(`Could not load quiz: ${j?.error || r.status}`);
        return;
      }
      const j = await r.json();
      const q = j.quiz as Quiz;
      const qs: Question[] = (j.questions as Question[]) || [];
      setQuiz(q);
      if (qs.length === 0) {
        setLoadErr("This quiz has no questions attached. (Generation may have failed mid-way.)");
        return;
      }
      setQuestions(qs);

      // Pre-fill the pre-test checkbox from the student's profile default.
      // NULL (never asked) and FALSE both default the checkbox to OFF;
      // TRUE pre-checks it. The student can flip it for THIS attempt
      // without affecting future attempts unless they keep it flipped.
      const { data: prof } = await sb
        .from("profiles")
        .select("track_question_time")
        .eq("id", user.id)
        .maybeSingle();
      const profileDefault = (prof as { track_question_time: boolean | null } | null)?.track_question_time;
      setTrackTimeChoice(profileDefault === true);

      // Look for an in-progress attempt. If found → resume immediately
      // (skip the pre-test screen — they already started; their consent
      // was locked in at that time). If not → wait for the student to
      // click Begin.
      const { data: existing } = await sb
        .from("quiz_attempts")
        .select("id, started_at")
        .eq("quiz_id", q.id)
        .eq("student_id", user.id)
        .is("submitted_at", null)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existing) {
        setAttemptId(existing.id);
        startedAtRef.current = new Date(existing.started_at).getTime();
        setTrackTime(profileDefault === true);
        const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
        const total = q.time_limit_minutes * 60;
        setSecondsLeft(Math.max(0, total - elapsed));
        setStarted(true);
      } else {
        // New attempt path — render the pre-test screen.
        setQuizLoaded(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // Begin the test from the pre-test screen. Persists the checkbox state
  // to the profile (so it pre-fills correctly next time) AND to local
  // state for THIS attempt's recording behavior, then creates the
  // attempt row and flips `started`.
  const begin = useCallback(async () => {
    if (!quiz || !questions.length) return;
    setBeginning(true);
    setLoadErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { setLoadErr("Not signed in."); return; }

      // Route the attempt insert through a service-role API endpoint to
      // dodge the RLS race that intermittently rejected this insert from
      // the user-token client with "new row violates row-level security
      // policy for table 'quiz_attempts'". The endpoint re-verifies the
      // bearer, persists the track_question_time preference, and inserts
      // the attempt row with the daily-cap trigger still applied.
      const r = await fetch("/api/student/attempt-start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          quiz_id: quiz.id,
          total: questions.length,
          track_question_time: trackTimeChoice,
        }),
      });
      const j = await r.json().catch(() => ({} as { error?: string; attempt?: { id: string } }));
      if (!r.ok || !j?.attempt?.id) {
        setLoadErr(`Could not start attempt: ${j?.error || `HTTP ${r.status}`}`);
        return;
      }
      setAttemptId(j.attempt.id);
      startedAtRef.current = Date.now();
      setSecondsLeft(quiz.time_limit_minutes * 60);
      setTrackTime(trackTimeChoice);
      setStarted(true);
      track("quiz_started", {
        quiz_id: quiz.id,
        quiz_code: code,
        total_questions: questions.length,
        time_limit_minutes: quiz.time_limit_minutes,
      });
    } finally {
      setBeginning(false);
    }
  }, [quiz, questions, trackTimeChoice]);

  const submit = useCallback(async () => {
    if (submittingRef.current || !attemptId || !quiz) return;
    submittingRef.current = true;
    setSubmitting(true);
    // Capture the time still running on the current question before we
    // freeze the timing snapshot — otherwise the last-viewed question
    // would be undercounted by however long the student stared at it.
    if (trackTime) flushCurrentQuestionTime();
    const sb = supabaseBrowser();

    // ─── Marking scheme — resolved ONCE here, snapshotted on the attempt ───
    // The quiz row carries the scheme the teacher (or student-creator)
    // picked. NULL => legacy +1/0/0 (resolveScheme handles that). We
    // freeze the resolved scheme onto the attempt so future admin edits
    // to the quiz cannot retroactively re-grade this attempt.
    const scheme = resolveScheme((quiz as { marking_scheme?: unknown }).marking_scheme);

    // Build the per-question answer outcomes once. Used both for
    // computing the attempt-level totals AND for the per-row
    // marks_earned writes. Skipped questions = selected_index === null
    // → counted as unattempted (scheme.rules.default.unattempted, 0
    // for every preset except future CUSTOMs).
    const answerInputs: AttemptAnswerInput[] = questions.map((q) => {
      const sel = answers[q.id];
      const selected_index = typeof sel === "number" ? sel : null;
      return {
        selected_index,
        is_correct: selected_index !== null && selected_index === q.correct_index,
      };
    });

    // Single source of truth: lib/scoring.ts computes raw_score, max_score,
    // percentage, counts (correct/wrong/unattempted/total). Identical math
    // to the old hardcoded loop when scheme is the legacy default.
    const breakdown = computeAttemptScore(answerInputs, scheme);

    // Per-question rows — now carry marks_earned alongside the existing
    // is_correct. Bloom mastery still keys off is_correct, so the
    // ZCORIQ Bloom Score recompute is unaffected. Skipped questions still
    // get is_correct: null (legacy invariant), but marks_earned: 0.
    const rows = questions.map((q, i) => {
      const ai = answerInputs[i];
      // Only record per-question timing when the student consented.
      // Otherwise leave the column NULL — the cohort benchmark routes
      // already filter NULL rows out, so non-consenting students don't
      // pollute the cohort baseline AND don't see their own timing later.
      const time_taken_ms = trackTime
        ? Math.min(questionMsRef.current[q.id] ?? 0, 10 * 60 * 1000)
        : null;
      return {
        attempt_id: attemptId,
        question_id: q.id,
        selected_index: ai.selected_index,
        // Preserve the historical convention: is_correct is NULL for a
        // skipped question (not false). Code throughout the app
        // distinguishes "got it wrong" from "didn't attempt."
        is_correct: ai.selected_index !== null ? ai.is_correct : null,
        bloom_level: q.bloom_level,
        time_taken_ms,
        marks_earned: marksEarnedFor(ai, scheme),
      };
    });
    if (rows.length) await sb.from("attempt_answers").insert(rows);
    const seconds = Math.floor((Date.now() - startedAtRef.current) / 1000);

    // Persist BOTH the new (raw_score / max_score / snapshot) AND the
    // legacy (score / total) columns. The legacy columns store the
    // back-compat correct-count value — i.e., what the old code would
    // have written — clamped at 0 because the legacy schema is int and
    // many readers assume non-negative. Result page + new reports read
    // raw_score; existing readers that still consume score keep working.
    await sb.from("quiz_attempts").update({
      submitted_at: new Date().toISOString(),
      score: Math.max(0, breakdown.counts.correct),     // legacy: correct-count, never negative
      total: breakdown.counts.total,                     // legacy: question count
      raw_score: breakdown.raw_score,                    // new: signed points (can be negative)
      max_score: breakdown.max_score,                    // new: total possible points
      marking_scheme_snapshot: scheme,                   // new: frozen rule
      time_taken_seconds: seconds,
    }).eq("id", attemptId);
    track("quiz_submitted", {
      quiz_id: quiz.id,
      attempt_id: attemptId,
      // Telemetry keeps the legacy correct-count for back-compat with
      // existing PostHog dashboards. New raw/percentage attributes
      // surface marking-scheme-aware numbers without breaking funnels.
      score: breakdown.counts.correct,
      total: breakdown.counts.total,
      raw_score: breakdown.raw_score,
      max_score: breakdown.max_score,
      percentage: breakdown.percentage,
      scheme_preset: breakdown.scheme.preset,
      negative_marks_enabled: breakdown.scheme.negative_marks_enabled,
      time_taken_seconds: seconds,
    });
    // Recompute the ZCORIQ score so the badge + Future You reflect
    // the new attempt. Fire-and-forget — see lib/scoreRecompute.
    void triggerScoreRecompute("quiz", attemptId);
    toast.success("Quiz submitted successfully.");
    router.replace(`/student/results/${attemptId}`);
  }, [answers, attemptId, questions, quiz, router, flushCurrentQuestionTime, trackTime]);

  // Helper: start the timer for whichever question is currently visible.
  // Wrapped so the visibility-change handler and the idx-change effect
  // can both call it without duplicating logic.
  const startTimerForCurrent = useCallback(() => {
    const qid = questions[idx]?.id;
    if (qid) {
      currentQIdRef.current = qid;
      currentQStartRef.current = Date.now();
    }
  }, [idx, questions]);

  // Track per-question time on idx changes (and once questions load).
  // Gated on trackTime — students who declined consent get no timing
  // recording at all.
  useEffect(() => {
    if (!questions.length || !trackTime) return;
    flushCurrentQuestionTime();
    startTimerForCurrent();
    return () => { flushCurrentQuestionTime(); };
  }, [idx, questions, trackTime, flushCurrentQuestionTime, startTimerForCurrent]);

  // Tab-visibility pause. When the student switches tabs / minimizes /
  // their device sleeps, document.hidden flips to true — we flush the
  // running question's time and stop counting. On return, we restart the
  // timer fresh on whatever question is now visible. Without this, a
  // 5-minute coffee break would silently get logged as "thinking time".
  useEffect(() => {
    if (!trackTime) return;
    const onVisibility = () => {
      if (document.hidden) {
        flushCurrentQuestionTime();
      } else {
        startTimerForCurrent();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [trackTime, flushCurrentQuestionTime, startTimerForCurrent]);

  // Tick timer
  useEffect(() => {
    if (!quiz || !attemptId) return;
    const t = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) { clearInterval(t); submit(); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [quiz, attemptId, submit]);

  // F114 fix (QA): warn on tab-close / nav-away while an attempt is in
  // flight. Browsers ignore custom strings, but setting returnValue
  // triggers the native "Leave site?" confirm.
  useEffect(() => {
    if (!attemptId || submitting) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [attemptId, submitting]);

  if (loadErr) {
    return (
      <div className="min-h-screen grid place-items-center px-6">
        <div className="card max-w-lg w-full text-center">
          <div className="text-3xl mb-2">😕</div>
          <div className="font-semibold mb-2">Couldn&apos;t open this test</div>
          <div className="text-sm text-slate-600 mb-4">{loadErr}</div>
          <button type="button" className="btn btn-secondary" onClick={() => router.replace("/student")}>Back to home</button>
        </div>
      </div>
    );
  }

  // Pre-test screen — rendered when the quiz is loaded but the student
  // hasn't clicked Begin yet (and we haven't auto-resumed an in-progress
  // attempt). Hosts the per-question-time-tracking checkbox plus a
  // summary of what they're about to take. The timer doesn't start
  // until they click Begin.
  if (quiz && questions.length > 0 && !started && quizLoaded) {
    return (
      <div className="min-h-screen grid place-items-center bg-slate-50 px-4 py-8">
        <div className="card max-w-md w-full">
          <div className="text-[11px] uppercase tracking-wide font-bold text-emerald-700">Ready to start</div>
          <h1 className="text-2xl font-bold mt-1">{quiz.name}</h1>
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div className="flex items-center gap-2">
              <Clock size={16} className="muted" />
              <span><strong>{quiz.time_limit_minutes}</strong> min</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="muted text-xs">●</span>
              <span><strong>{questions.length}</strong> question{questions.length === 1 ? "" : "s"}</span>
            </div>
          </div>

          {/* ── Marking-scheme summary ────────────────────────────────
              Shown when the quiz has a non-default scheme (e.g. JEE Main
              with +4/−1). Resolves a NULL marking_scheme to PRACTICE
              transparently. Practice quizzes (+1/0) hide this block
              entirely to keep the cover page clean.
              The student MUST see this before clicking Begin — knowing
              "wrong answers cost you 1 mark" is a basic test-strategy
              precondition. */}
          {(() => {
            const previewScheme = resolveScheme((quiz as { marking_scheme?: unknown }).marking_scheme);
            const nonDefault = previewScheme.preset !== "PRACTICE" || previewScheme.negative_marks_enabled;
            if (!nonDefault) return null;
            const r = previewScheme.rules.default;
            return (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs">
                <div className="font-bold text-amber-900 uppercase tracking-wide text-[10px]">
                  Marking scheme
                </div>
                <div className="grid grid-cols-3 gap-2 mt-2 text-slate-800">
                  <div>
                    <div className="text-slate-500 text-[10px]">Correct</div>
                    <div className="font-bold text-emerald-700">+{r.correct}</div>
                  </div>
                  <div>
                    <div className="text-slate-500 text-[10px]">Wrong</div>
                    <div className={`font-bold ${r.wrong < 0 ? "text-rose-700" : ""}`}>
                      {r.wrong > 0 ? "+" : ""}{r.wrong}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500 text-[10px]">Skip</div>
                    <div className="font-bold">{r.unattempted}</div>
                  </div>
                </div>
                {previewScheme.negative_marks_enabled && (
                  <div className="text-[11px] text-amber-900 mt-2 leading-snug">
                    Wrong answers <strong>deduct marks</strong>. Skip a question if you&apos;re not sure.
                  </div>
                )}
              </div>
            );
          })()}

          {/* Per-question time tracking checkbox.
              Pre-filled from the student's saved default (profile.track_question_time)
              and saved back on Begin so it pre-fills correctly next time too.
              The student can flip it for THIS attempt without committing forever. */}
          <label
            className="mt-5 p-3 rounded-lg border flex items-start gap-3 cursor-pointer transition"
            style={{
              borderColor: trackTimeChoice ? "var(--brand-300, #6ee7b7)" : "var(--color-border, #e2e8f0)",
              background: trackTimeChoice
                ? "color-mix(in oklab, var(--brand-100, #d1fae5) 50%, transparent)"
                : "var(--color-bg-soft, #f8fafc)",
            }}
          >
            <input
              type="checkbox"
              checked={trackTimeChoice}
              onChange={(e) => setTrackTimeChoice(e.target.checked)}
              className="mt-0.5 shrink-0 w-4 h-4 cursor-pointer"
            />
            <div className="text-sm">
              <div className="font-semibold">Track my time per question</div>
              <div className="muted text-xs mt-0.5 leading-relaxed">
                See your pacing for each question after the test. On <strong>Premium Plus</strong>,
                also see how you compare to other students. Times stay private — comparisons are
                anonymized aggregates. You can change this any time from Settings.
              </div>
            </div>
          </label>

          <button
            type="button"
            className="btn btn-primary w-full mt-5"
            disabled={beginning}
            onClick={begin}
          >
            {beginning ? (
              <><span className="spinner" /> Starting…</>
            ) : (
              <><Play size={14} /> Begin test</>
            )}
          </button>

          <div className="mt-3 text-[11px] muted flex items-start gap-1.5">
            <AlertCircle size={11} className="mt-0.5 shrink-0" />
            <span>Once you click Begin, the {quiz.time_limit_minutes}-minute timer starts and cannot be paused.</span>
          </div>
        </div>
      </div>
    );
  }

  if (!quiz || !questions.length || !attemptId) {
    return <div className="min-h-screen grid place-items-center"><div className="spinner" /></div>;
  }

  const q = questions[idx];
  const answered = Object.keys(answers).length;
  const lowTime = secondsLeft < 60;

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Top bar */}
      <header className="sticky top-0 bg-white border-b border-slate-200 z-10">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <div className="font-bold">{quiz.name}</div>
            <div className="text-xs muted">Question {idx + 1} of {questions.length} · {answered} answered</div>
          </div>
          <div className={`flex items-center gap-2 px-3 py-2 rounded-lg font-mono font-bold text-lg ${lowTime ? "text-red-700 bg-red-50 border border-red-200 animate-pulse" : "text-slate-900 bg-slate-100"}`}>
            <AlarmClock size={18} /> {formatSeconds(secondsLeft)}
          </div>
        </div>
        {/* Progress bar */}
        <div className="h-1 bg-slate-100">
          <div className="h-full bg-emerald-500 transition-all" style={{ width: `${((idx + 1) / questions.length) * 100}%` }} />
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8">
        <div className="card fade-in" key={q.id}>
          <BloomBadge level={q.bloom_level} />
          <h2 className="text-xl font-semibold mt-3 mb-5 leading-snug">{q.stem}</h2>
          <div className="space-y-2">
            {q.options.map((o, i) => {
              const sel = answers[q.id] === i;
              return (
                <button type="button"
                  key={i}
                  onClick={() => setAnswers((a) => ({ ...a, [q.id]: i }))}
                  className={`w-full text-left p-4 rounded-lg border transition flex gap-3 items-center ${
                    sel ? "border-emerald-500 bg-emerald-50" : "border-slate-200 hover:bg-slate-50"
                  }`}
                >
                  <span className={`w-7 h-7 grid place-items-center rounded-full font-bold text-sm ${sel ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600"}`}>
                    {String.fromCharCode(65 + i)}
                  </span>
                  <span className="flex-1">{o}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between mt-6">
          <button type="button" className="btn btn-secondary" disabled={idx === 0} onClick={() => setIdx((i) => Math.max(0, i - 1))}>
            <ChevronLeft size={16} /> Back
          </button>
          <div className="text-sm muted hidden sm:flex gap-1">
            {questions.map((qq, i) => (
              <button type="button" key={qq.id} onClick={() => setIdx(i)}
                className={`w-7 h-7 rounded text-xs font-semibold ${
                  i === idx ? "bg-emerald-600 text-white"
                    : answers[qq.id] !== undefined ? "bg-emerald-100 text-emerald-800"
                    : "bg-slate-100 text-slate-500"}`}>
                {i + 1}
              </button>
            ))}
          </div>
          {idx < questions.length - 1 ? (
            <button type="button" aria-label="Go to next question" className="btn btn-primary" onClick={() => setIdx((i) => Math.min(questions.length - 1, i + 1))}>
              Next <ChevronRight size={16} />
            </button>
          ) : (
            <button
              type="button"
              aria-label={submitting ? "Submitting your answers" : "Submit quiz"}
              aria-busy={submitting}
              className="btn btn-primary"
              disabled={submitting}
              onClick={() => {
                if (answered < questions.length && !confirm(`You haven't answered ${questions.length - answered} question(s). Submit anyway?`)) return;
                submit();
              }}
            >
              {submitting ? <><span className="spinner" /> Submitting…</> : "Submit"}
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
