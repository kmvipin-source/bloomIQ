"use client";

// =============================================================================
// app/student/bloom-score/page.tsx
// -----------------------------------------------------------------------------
// BloomIQ Score Calibration — the killer first-run experience.
//
// 12 Bloom-tagged questions, ~7 minutes, ends with a routed reveal at
// /student/future. Bloom labels are HIDDEN from the student during the
// quiz on purpose — we want clean cognitive measurement, not test-taking
// strategy ("oh this is an Apply question, let me change my approach").
//
// Per-question timer is tracked but NOT visibly counted-down — visible
// timers spike anxiety which corrupts the calibration. We measure speed
// silently and feed it into the score formula.
//
// Note: the existing /student/calibration route belongs to the Confidence
// Calibration profile (a different feature). We live at /student/bloom-score
// to stay out of its way.
// =============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Sparkles, ArrowRight, RefreshCw, AlertTriangle } from "lucide-react";

type Q = {
  index: number;
  stem: string;
  options: [string, string, string, string];
  correct_index: 0 | 1 | 2 | 3;
  bloom_level: string;
  topic: string;
  benchmark_seconds: number;
  explanation?: string;
};

type StartResp = {
  ok: true;
  session_id: string;
  exam_goal: string | null;
  groq_model: string;
  questions: Q[];
};

type ResponseRow = {
  question: Q;
  selected_index: number | null;
  time_taken_seconds: number;
};

export default function BloomScoreCalibrationPage() {
  const router = useRouter();

  const [phase, setPhase] = useState<"intro" | "loading" | "quiz" | "submitting" | "error">("intro");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [examGoal, setExamGoal] = useState<string | null>(null);
  const [groqModel, setGroqModel] = useState<string | null>(null);
  const [questions, setQuestions] = useState<Q[]>([]);

  const [current, setCurrent] = useState(0);
  const [responses, setResponses] = useState<ResponseRow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);

  // Per-question stopwatch — silent. Reset whenever `current` changes.
  const questionStartRef = useRef<number>(Date.now());
  const startedAtRef = useRef<number>(Date.now());
  useEffect(() => { questionStartRef.current = Date.now(); }, [current]);

  const total = questions.length;
  const progress = total === 0 ? 0 : Math.round((current / total) * 100);
  const q = useMemo(() => questions[current], [questions, current]);

  async function startCalibration() {
    setPhase("loading");
    setErrMsg(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) {
        router.replace("/login?next=/student/bloom-score");
        return;
      }
      const r = await fetch("/api/student/calibration/start", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await r.json();
      if (!r.ok || !data?.ok) throw new Error(data?.error || "Couldn't start calibration");
      const payload = data as StartResp;
      setSessionId(payload.session_id);
      setExamGoal(payload.exam_goal);
      setGroqModel(payload.groq_model);
      setQuestions(payload.questions);
      setCurrent(0);
      setResponses([]);
      setSelected(null);
      startedAtRef.current = Date.now();
      questionStartRef.current = Date.now();
      setPhase("quiz");
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Failed to start");
      setPhase("error");
    }
  }

  function recordAndAdvance() {
    if (!q) return;
    const elapsed = Math.max(1, Math.round((Date.now() - questionStartRef.current) / 1000));
    const row: ResponseRow = {
      question: q,
      selected_index: selected,
      time_taken_seconds: elapsed,
    };
    const next = [...responses, row];
    setResponses(next);
    setSelected(null);

    if (current + 1 < total) {
      setCurrent(current + 1);
    } else {
      void submit(next);
    }
  }

  async function submit(rows: ResponseRow[]) {
    setPhase("submitting");
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Session expired");
      const totalSeconds = Math.round((Date.now() - startedAtRef.current) / 1000);

      const r = await fetch("/api/student/calibration/submit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          session_id: sessionId,
          exam_goal: examGoal,
          groq_model: groqModel,
          total_seconds: totalSeconds,
          responses: rows,
        }),
      });
      const data = await r.json();
      if (!r.ok || !data?.ok) throw new Error(data?.error || "Submit failed");

      // Push the result into sessionStorage so the reveal page can render
      // immediately without an extra round-trip. The reveal page also
      // calls /api/student/score as a fallback for direct navigation.
      try {
        sessionStorage.setItem("bloomiq:lastReveal", JSON.stringify(data));
      } catch { /* sessionStorage may be disabled — fallback handles it */ }

      router.replace("/student/future?fresh=1");
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Submit failed");
      setPhase("error");
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // RENDERS
  // ─────────────────────────────────────────────────────────────────

  if (phase === "intro") {
    return (
      <div className="max-w-2xl mx-auto pt-10">
        <div className="card p-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-12 h-12 rounded-xl grid place-items-center"
                 style={{ background: "linear-gradient(135deg, #10b981 0%, #6366f1 100%)" }}>
              <Sparkles className="text-white" />
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider opacity-60">First-time setup</div>
              <h1 className="text-2xl font-bold">Discover your BloomIQ Score</h1>
            </div>
          </div>

          <p className="mt-4 text-base leading-relaxed">
            12 questions. About 7 minutes. We use them to measure not just <em>what</em>{" "}
            you know — but <em>how</em> you think across all six levels of Bloom&apos;s
            Taxonomy.
          </p>

          <p className="mt-3 text-base leading-relaxed">
            At the end you&apos;ll get a single 3-digit score (300–900), a predicted
            exam-day rank, and a glimpse of the score you&apos;d hit if you closed your
            top weak spots.
          </p>

          <div className="mt-6 grid grid-cols-3 gap-3">
            <Stat n="12" label="Questions" />
            <Stat n="~7" label="Minutes" />
            <Stat n="6" label="Bloom levels" />
          </div>

          <button
            className="btn btn-primary mt-6 w-full text-base py-3 flex items-center justify-center gap-2"
            onClick={startCalibration}
          >
            Start calibration <ArrowRight size={18} />
          </button>

          <p className="mt-3 text-xs opacity-60 text-center">
            You can re-take this anytime to refresh your baseline.
          </p>
        </div>
      </div>
    );
  }

  if (phase === "loading") {
    return (
      <div className="max-w-xl mx-auto pt-20 text-center">
        <div className="spinner mx-auto" />
        <p className="mt-4 opacity-70">Crafting your calibration… (this takes ~10 seconds)</p>
      </div>
    );
  }

  if (phase === "submitting") {
    return (
      <div className="max-w-xl mx-auto pt-20 text-center">
        <div className="spinner mx-auto" />
        <p className="mt-4 opacity-70">Calculating your BloomIQ Score…</p>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="max-w-xl mx-auto pt-20">
        <div className="card p-6 border-2" style={{ borderColor: "#ef4444" }}>
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle size={20} className="text-red-500" />
            <h2 className="font-bold">Something went wrong</h2>
          </div>
          <p className="text-sm opacity-80">{errMsg}</p>
          <button
            className="btn btn-primary mt-4 flex items-center gap-2"
            onClick={() => setPhase("intro")}
          >
            <RefreshCw size={16} /> Try again
          </button>
        </div>
      </div>
    );
  }

  // phase === "quiz"
  if (!q) return null;
  return (
    <div className="max-w-2xl mx-auto pt-6 pb-24">
      {/* Progress strip */}
      <div className="mb-6">
        <div className="flex justify-between text-xs opacity-70 mb-2">
          <span>Question {current + 1} of {total}</span>
          <span>{progress}%</span>
        </div>
        <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(0,0,0,0.08)" }}>
          <div
            className="h-full transition-all duration-300"
            style={{
              width: `${progress}%`,
              background: "linear-gradient(90deg, #10b981 0%, #6366f1 100%)",
            }}
          />
        </div>
      </div>

      <div className="card p-6">
        {q.topic ? (
          <div className="text-xs uppercase tracking-wider opacity-50 mb-2">
            {q.topic}
          </div>
        ) : null}
        <h2 className="text-lg font-semibold leading-relaxed mb-5">{q.stem}</h2>

        <div className="grid gap-3">
          {q.options.map((opt, i) => {
            const active = selected === i;
            return (
              <button
                key={i}
                onClick={() => setSelected(i)}
                className="text-left rounded-lg p-4 border-2 transition-all"
                style={{
                  borderColor: active ? "#6366f1" : "rgba(0,0,0,0.08)",
                  background: active ? "rgba(99,102,241,0.08)" : "transparent",
                }}
              >
                <div className="flex items-start gap-3">
                  <div
                    className="w-6 h-6 rounded-full grid place-items-center text-xs font-semibold flex-shrink-0 mt-0.5"
                    style={{
                      background: active ? "#6366f1" : "rgba(0,0,0,0.06)",
                      color: active ? "white" : "inherit",
                    }}
                  >
                    {String.fromCharCode(65 + i)}
                  </div>
                  <div className="flex-1">{opt}</div>
                </div>
              </button>
            );
          })}
        </div>

        <div className="mt-6 flex items-center justify-between">
          <button
            className="text-sm opacity-60 hover:opacity-100 transition"
            onClick={recordAndAdvance}
          >
            Skip this question
          </button>
          <button
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50"
            disabled={selected === null}
            onClick={recordAndAdvance}
          >
            {current + 1 === total ? "Finish" : "Next"} <ArrowRight size={16} />
          </button>
        </div>
      </div>

      <p className="text-xs opacity-50 text-center mt-6">
        We don&apos;t show Bloom labels during the quiz on purpose — clean cognitive
        measurement gives a sharper score.
      </p>
    </div>
  );
}

function Stat({ n, label }: { n: string; label: string }) {
  return (
    <div className="rounded-lg p-3 text-center" style={{ background: "rgba(0,0,0,0.03)" }}>
      <div className="text-xl font-bold">{n}</div>
      <div className="text-xs opacity-60">{label}</div>
    </div>
  );
}
