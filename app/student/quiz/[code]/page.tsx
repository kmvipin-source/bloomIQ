"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import type { Question, Quiz } from "@/lib/types";
import BloomBadge from "@/components/BloomBadge";
import { formatSeconds } from "@/lib/utils";
import { ChevronLeft, ChevronRight, AlarmClock } from "lucide-react";

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

  // Per-question timing — gated by student consent. trackTime is the
  // resolved opt-in state; null while we're still loading the profile,
  // false until the student says yes (default-deny). showConsent flips
  // true exactly once for students who haven't been asked yet.
  const [trackTime, setTrackTime] = useState<boolean | null>(null);
  const [showConsent, setShowConsent] = useState(false);
  const [savingConsent, setSavingConsent] = useState(false);

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

  // Load quiz + questions + create attempt (runs ONCE per code)
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

      // Resolve the student's consent for per-question time tracking.
      // null  → never asked → show one-time modal, default to NOT tracking
      //         until they answer.
      // true  → opted in.
      // false → opted out (and we respect that — no nag, no modal).
      const { data: prof } = await sb
        .from("profiles")
        .select("track_question_time")
        .eq("id", user.id)
        .maybeSingle();
      const consent = (prof as { track_question_time: boolean | null } | null)?.track_question_time;
      if (consent === true) {
        setTrackTime(true);
      } else if (consent === false) {
        setTrackTime(false);
      } else {
        setTrackTime(false);    // default-deny until answered
        setShowConsent(true);   // ask once
      }

      // Reuse most recent unsubmitted attempt or create new
      const { data: existing } = await sb
        .from("quiz_attempts")
        .select("id, started_at")
        .eq("quiz_id", q.id)
        .eq("student_id", user.id)
        .is("submitted_at", null)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      let aId: string;
      if (existing) {
        aId = existing.id;
        startedAtRef.current = new Date(existing.started_at).getTime();
      } else {
        const { data: created, error } = await sb
          .from("quiz_attempts")
          .insert({ quiz_id: q.id, student_id: user.id, total: qs.length })
          .select()
          .single();
        if (error || !created) { setLoadErr(`Could not start attempt: ${error?.message || "unknown error"}`); return; }
        aId = created.id;
        startedAtRef.current = Date.now();
      }
      setAttemptId(aId);

      const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
      const total = q.time_limit_minutes * 60;
      setSecondsLeft(Math.max(0, total - elapsed));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const submit = useCallback(async () => {
    if (submittingRef.current || !attemptId || !quiz) return;
    submittingRef.current = true;
    setSubmitting(true);
    // Capture the time still running on the current question before we
    // freeze the timing snapshot — otherwise the last-viewed question
    // would be undercounted by however long the student stared at it.
    if (trackTime) flushCurrentQuestionTime();
    const sb = supabaseBrowser();
    let score = 0;
    const rows = questions.map((q) => {
      const sel = answers[q.id];
      const correct = typeof sel === "number" && sel === q.correct_index;
      if (correct) score += 1;
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
        selected_index: typeof sel === "number" ? sel : null,
        is_correct: typeof sel === "number" ? correct : null,
        bloom_level: q.bloom_level,
        time_taken_ms,
      };
    });
    if (rows.length) await sb.from("attempt_answers").insert(rows);
    const seconds = Math.floor((Date.now() - startedAtRef.current) / 1000);
    await sb.from("quiz_attempts").update({
      submitted_at: new Date().toISOString(),
      score,
      total: questions.length,
      time_taken_seconds: seconds,
    }).eq("id", attemptId);
    toast.success("Quiz submitted successfully.");
    router.replace(`/student/results/${attemptId}`);
  }, [answers, attemptId, questions, quiz, router, flushCurrentQuestionTime, trackTime]);

  // Persist the student's consent answer + apply it locally. Used by both
  // buttons of the one-time modal. Failure to persist is non-fatal — we
  // still apply the choice in this session; we'll just ask again next
  // quiz, which is preferable to blocking them on a network blip.
  const recordConsent = useCallback(async (allow: boolean) => {
    setSavingConsent(true);
    try {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (user) {
        await sb.from("profiles").update({ track_question_time: allow }).eq("id", user.id);
      }
    } catch { /* ignore */ }
    setTrackTime(allow);
    setShowConsent(false);
    setSavingConsent(false);
  }, []);

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

  if (loadErr) {
    return (
      <div className="min-h-screen grid place-items-center px-6">
        <div className="card max-w-lg w-full text-center">
          <div className="text-3xl mb-2">😕</div>
          <div className="font-semibold mb-2">Couldn&apos;t open this quiz</div>
          <div className="text-sm text-slate-600 mb-4">{loadErr}</div>
          <button className="btn btn-secondary" onClick={() => router.replace("/student")}>Back to home</button>
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
      {/* One-time consent modal: shown only when the student has never
          been asked. Both buttons persist their answer to profiles so we
          don't ask again. Uses position: fixed so it overlays the quiz
          and prevents accidental clicks on the questions behind. */}
      {showConsent && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/60 backdrop-blur-sm px-4">
          <div className="card max-w-md w-full">
            <h2 className="text-lg font-semibold mb-2">Track your time per question?</h2>
            <p className="text-sm text-slate-700 leading-relaxed">
              We can record how many seconds you spend on each question. After the test, you&apos;ll see your
              own pacing — which questions you flew through and which slowed you down. On{" "}
              <strong>Premium Plus</strong>, you can also see how your pace compares to other students.
            </p>
            <p className="text-xs text-slate-500 mt-2">
              You can change this any time in Settings. We never share your data with other students —
              comparisons are anonymized aggregates.
            </p>
            <div className="mt-4 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
              <button
                className="btn btn-secondary"
                onClick={() => recordConsent(false)}
                disabled={savingConsent}
              >
                Not now
              </button>
              <button
                className="btn btn-primary"
                onClick={() => recordConsent(true)}
                disabled={savingConsent}
              >
                Yes, track my time
              </button>
            </div>
          </div>
        </div>
      )}

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
                <button
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
          <button className="btn btn-secondary" disabled={idx === 0} onClick={() => setIdx((i) => Math.max(0, i - 1))}>
            <ChevronLeft size={16} /> Back
          </button>
          <div className="text-sm muted hidden sm:flex gap-1">
            {questions.map((qq, i) => (
              <button key={qq.id} onClick={() => setIdx(i)}
                className={`w-7 h-7 rounded text-xs font-semibold ${
                  i === idx ? "bg-emerald-600 text-white"
                    : answers[qq.id] !== undefined ? "bg-emerald-100 text-emerald-800"
                    : "bg-slate-100 text-slate-500"}`}>
                {i + 1}
              </button>
            ))}
          </div>
          {idx < questions.length - 1 ? (
            <button className="btn btn-primary" onClick={() => setIdx((i) => Math.min(questions.length - 1, i + 1))}>
              Next <ChevronRight size={16} />
            </button>
          ) : (
            <button className="btn btn-primary" disabled={submitting} onClick={() => {
              if (answered < questions.length && !confirm(`You haven't answered ${questions.length - answered} question(s). Submit anyway?`)) return;
              submit();
            }}>
              {submitting ? <><span className="spinner" /> Submitting…</> : "Submit"}
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
