"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
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

  // Load quiz + questions + create attempt (runs ONCE per code)
  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) { setLoadErr("Not signed in."); return; }

      const { data: q, error: qErr } = await sb.from("quizzes").select("*").eq("code", code).maybeSingle();
      if (qErr) { setLoadErr(`Could not load quiz: ${qErr.message}`); return; }
      if (!q) { setLoadErr(`No quiz found with code "${code}". It may have been deleted, or the code is wrong.`); return; }
      setQuiz(q as Quiz);

      const { data: qq, error: qqErr } = await sb
        .from("quiz_questions")
        .select("position, question_bank!inner(*)")
        .eq("quiz_id", q.id)
        .order("position", { ascending: true });
      if (qqErr) { setLoadErr(`Could not load questions: ${qqErr.message}`); return; }
      const qs: Question[] = ((qq as unknown) as Array<{ question_bank: Question }> | null)?.map((r) => r.question_bank) || [];
      if (qs.length === 0) {
        setLoadErr(`This quiz has no questions attached. (Generation may have failed mid-way.)`);
        return;
      }
      setQuestions(qs);

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
    const sb = supabaseBrowser();
    let score = 0;
    const rows = questions.map((q) => {
      const sel = answers[q.id];
      const correct = typeof sel === "number" && sel === q.correct_index;
      if (correct) score += 1;
      return {
        attempt_id: attemptId,
        question_id: q.id,
        selected_index: typeof sel === "number" ? sel : null,
        is_correct: typeof sel === "number" ? correct : null,
        bloom_level: q.bloom_level,
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
    router.replace(`/student/results/${attemptId}`);
  }, [answers, attemptId, questions, quiz, router]);

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
