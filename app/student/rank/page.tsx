"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Trophy, ArrowLeft, History, Lightbulb, Loader2, Sparkles, Lock, Info } from "lucide-react";

// =============================================================================
// MOCK RANK PREDICTOR — convert any score → AIR estimate. Independent students
// only. School students see a friendly "this feature is for exam aspirants"
// note instead.
// =============================================================================

type ExamType = "JEE_MAIN" | "NEET" | "CAT" | "CUSTOM";

const EXAM_LABEL: Record<ExamType, string> = {
  JEE_MAIN: "JEE Main",
  NEET: "NEET",
  CAT: "CAT",
  CUSTOM: "Custom mock",
};

type Pred = {
  id: string;
  exam_type: ExamType;
  raw_score: number;
  max_score: number;
  percentile: number;
  predicted_air: number;
  // air_low / air_high define the 95% confidence band returned by the API.
  // Optional because past predictions persisted before this field was added
  // won't have it; treat absent as "not modeled".
  air_low?: number;
  air_high?: number;
  score_margin_pp?: number;
  total_candidates: number;
  recommendations: string[] | null;
  model?: { name: string; version: string; assumptions: string[] };
  created_at: string;
};

export default function RankPage() {
  const [isSchoolStudent, setIsSchoolStudent] = useState<boolean | null>(null);
  // 2026-05-13: also gate on exam_goal — independent students who picked
  // a K-12 board goal don't have an AIR to predict. Treat them like school
  // students for this surface (show the friendly "not for you" card).
  const [isK12Goal, setIsK12Goal] = useState<boolean>(false);
  const [list, setList] = useState<Pred[]>([]);
  const [loading, setLoading] = useState(true);

  // Ad-hoc form
  const [examType, setExamType] = useState<ExamType>("JEE_MAIN");
  const [rawScore, setRawScore] = useState("");
  const [maxScore, setMaxScore] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<Pred | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) { setLoading(false); return; }
    const { data: prof } = await sb
      .from("profiles")
      .select("is_school_student, exam_goal")
      .eq("id", user.id)
      .single();
    const profRow = prof as { is_school_student: boolean | null; exam_goal: string | null } | null;
    setIsSchoolStudent(!!profRow?.is_school_student);
    // K-12 goals (board exams + class buckets) don't produce an All-India Rank.
    const k12Goals = new Set([
      "class10_boards", "class_10_boards", "class12_boards", "class_12_boards",
      "class_9", "class9", "class_5_8", "class5_8",
    ]);
    setIsK12Goal(k12Goals.has((profRow?.exam_goal || "").toLowerCase()));
    if (!profRow?.is_school_student) {
      const { data } = await sb
        .from("mock_rank_predictions")
        .select("id, exam_type, raw_score, max_score, percentile, predicted_air, total_candidates, recommendations, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(20);
      setList((data as unknown as Pred[]) || []);
    }
    setLoading(false);
  }

  async function predict() {
    setErr(null);
    setResult(null);
    const r = Number(rawScore);
    const m = Number(maxScore);
    if (!Number.isFinite(r) || !Number.isFinite(m) || m <= 0 || r < 0 || r > m) {
      setErr("Enter a valid raw score and max score.");
      return;
    }
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired — please sign in again.");
      const res = await fetch("/api/rank/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ raw_score: r, max_score: m, exam_type: examType }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || "Prediction failed");
      setResult(j as Pred);
      void load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Prediction failed");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="grid place-items-center py-20"><div className="spinner" /></div>;

  if (isSchoolStudent || isK12Goal) {
    return (
      <div className="max-w-2xl mx-auto fade-in">
        <Link href="/student" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-emerald-700 mb-3">
          <ArrowLeft size={14} /> Back to dashboard
        </Link>
        <div className="card text-center py-10">
          <div className="rounded-full bg-amber-100 text-amber-700 w-14 h-14 grid place-items-center mx-auto mb-3">
            <Lock size={22} />
          </div>
          <h2 className="font-semibold text-lg">Mock Rank Predictor is for exam aspirants</h2>
          <p className="text-sm muted mt-2 max-w-md mx-auto">
            This feature predicts an All-India Rank from a mock-test score — it&apos;s built for students preparing
            for JEE, NEET, CAT and similar competitive exams. As a school student, your class quizzes are graded
            by your teacher and don&apos;t map to a national rank.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto fade-in">
      <Link href="/student" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-emerald-700 mb-3">
        <ArrowLeft size={14} /> Back to dashboard
      </Link>

      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-amber-100 text-amber-700 p-3 shrink-0">
          <Trophy size={22} />
        </div>
        <div className="flex-1">
          <h1 className="h1">Mock Rank Predictor</h1>
          <p className="muted mt-1">
            Type any mock-test score and we&apos;ll estimate your All-India Rank against a JEE / NEET / CAT-sized
            cohort. Useful for benchmarking after coaching tests too.
          </p>
        </div>
      </div>

      <div className="card mt-6 grid sm:grid-cols-3 gap-3">
        <div>
          <label className="label">Exam type</label>
          <select className="select" value={examType} onChange={(e) => setExamType(e.target.value as ExamType)}>
            <option value="JEE_MAIN">JEE Main</option>
            <option value="NEET">NEET</option>
            <option value="CAT">CAT</option>
            <option value="CUSTOM">Custom mock</option>
          </select>
        </div>
        <div>
          <label className="label">Raw score</label>
          <input className="input" inputMode="decimal" value={rawScore} onChange={(e) => setRawScore(e.target.value)} placeholder="e.g. 142" />
        </div>
        <div>
          <label className="label">Max score</label>
          <input className="input" inputMode="decimal" value={maxScore} onChange={(e) => setMaxScore(e.target.value)} placeholder="e.g. 300" />
        </div>
        <div className="sm:col-span-3 flex items-center gap-2">
          <button type="button" className="btn btn-primary" onClick={predict} disabled={busy}>
            {busy ? <><Loader2 className="animate-spin" size={16} /> Calculating…</> : <><Sparkles size={16} /> Predict rank</>}
          </button>
          {err && <span className="text-sm text-red-700">{err}</span>}
        </div>
      </div>

      {result && (
        <div className="card mt-4 bg-amber-50/40 border-amber-200">
          <div className="grid sm:grid-cols-3 gap-3">
            <div>
              <div className="text-xs muted uppercase font-semibold">Score</div>
              <div className="text-2xl font-bold">{result.raw_score}/{result.max_score}</div>
              <div className="text-xs muted">{((result.raw_score / Math.max(result.max_score, 1)) * 100).toFixed(1)}%</div>
            </div>
            <div>
              <div className="text-xs muted uppercase font-semibold">Percentile</div>
              <div className="text-2xl font-bold">~{result.percentile.toFixed(1)}</div>
              <div className="text-xs muted">approximate</div>
            </div>
            <div>
              <div className="text-xs muted uppercase font-semibold">
                Estimated AIR range ({EXAM_LABEL[result.exam_type]})
              </div>
              {/* Show a band, not a point. If the API didn't return a band
                  (older response or partial failure), fall back to ~point. */}
              {result.air_low && result.air_high ? (
                <>
                  <div className="text-2xl font-bold leading-tight">
                    {result.air_low.toLocaleString()}
                    <span className="mx-1.5 text-amber-700">–</span>
                    {result.air_high.toLocaleString()}
                  </div>
                  <div className="text-xs muted">
                    midpoint ~{result.predicted_air.toLocaleString()} · cohort {result.total_candidates.toLocaleString()}
                  </div>
                </>
              ) : (
                <>
                  <div className="text-2xl font-bold">~{result.predicted_air.toLocaleString()}</div>
                  <div className="text-xs muted">in {result.total_candidates.toLocaleString()} candidates</div>
                </>
              )}
            </div>
          </div>

          {/* ── Test-length confidence chip. A 10-question quiz can't pin
                down ability the way a 200-Q paper does — surface that
                directly so the student weighs the prediction accordingly. */}
          {(() => {
            const n = result.max_score;
            // Bands chosen against typical test lengths for the supported
            // exams (JEE/NEET ≈ 90–200 Q, mock papers 30–60 Q, quick
            // revision tests <20). These are rules of thumb; tune later.
            let label: string, tone: string, blurb: string;
            if (n < 20) {
              label = "Low confidence";
              tone  = "bg-rose-100 border-rose-300 text-rose-900";
              blurb = `Only ${n} question${n === 1 ? "" : "s"} — that's very little to estimate ability from. The rank range is wide and the midpoint should not be taken seriously. Run a longer mock for a meaningful prediction.`;
            } else if (n < 60) {
              label = "Limited confidence";
              tone  = "bg-amber-100 border-amber-300 text-amber-900";
              blurb = `${n} questions is enough for a directional read but the true rank could comfortably sit anywhere in the band shown. Don't make decisions off this alone.`;
            } else if (n < 120) {
              label = "Moderate confidence";
              tone  = "bg-yellow-50 border-yellow-300 text-yellow-900";
              blurb = `${n} questions gives a reasonable estimate. Still treat the band — not the midpoint — as the answer.`;
            } else {
              label = "Higher confidence";
              tone  = "bg-emerald-50 border-emerald-300 text-emerald-900";
              blurb = `${n} questions is a substantive sample. The band is tight, but the model's cohort assumptions still apply.`;
            }
            return (
              <div className={`mt-4 rounded-lg border px-3 py-2.5 text-[13px] leading-relaxed flex items-start gap-2 ${tone}`}>
                <Info size={14} className="mt-0.5 shrink-0" />
                <div>
                  <strong>{label}</strong> — {blurb}
                </div>
              </div>
            );
          })()}

          {/* ── Honest-uncertainty banner. Always shown so students don't
                take the AIR as a precise prediction. Wording deliberately
                addresses BOTH directions (overconfidence + underconfidence). */}
          <div className="mt-3 rounded-lg bg-amber-100/70 border border-amber-300 px-3 py-2.5 text-[13px] text-amber-950 leading-relaxed">
            <div className="flex items-start gap-2">
              <Info size={14} className="mt-0.5 shrink-0" />
              <div className="space-y-1.5">
                <p>
                  <strong>This is an estimate of where a score like this typically lands — not your actual rank.</strong> Use the range as a benchmark, not a verdict.
                </p>
                <p>
                  <strong>If the number looks great:</strong> a strong mock doesn&apos;t guarantee a strong real rank. The actual paper&apos;s difficulty, section-wise normalization, and how this year&apos;s cohort performs can shift outcomes meaningfully in either direction. Stay sharp.
                </p>
                <p>
                  <strong>If it looks rough:</strong> a single mock is one data point. Ranks move quickly with focused, targeted practice — see the recommendations below for the highest-yield areas.
                </p>
              </div>
            </div>
          </div>

          {result.recommendations && result.recommendations.length > 0 && (
            <div className="mt-4">
              <div className="text-xs muted uppercase font-semibold mb-2 inline-flex items-center gap-1">
                <Lightbulb size={12} /> Where to gain marks fastest
              </div>
              <ul className="space-y-1.5 text-sm">
                {result.recommendations.map((r, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-600 text-white text-xs font-bold shrink-0">{i + 1}</span>
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ── Collapsible "How this is calculated" so curious students
                (and their parents) can see the actual model, what it
                assumes, and — equally important — what it does NOT model. */}
          <details className="mt-4 group">
            <summary className="cursor-pointer text-xs font-semibold text-amber-900 hover:text-amber-700 inline-flex items-center gap-1 list-none [&::-webkit-details-marker]:hidden">
              <Info size={12} /> How this number is calculated (and what it doesn&apos;t account for)
              <span className="ml-1 transition-transform group-open:rotate-90">›</span>
            </summary>
            <div className="mt-2 text-[13px] text-slate-700 leading-relaxed space-y-3">
              <div>
                <p className="font-semibold text-slate-900">The model</p>
                <p>
                  {result.model?.name || "Normal-CDF cohort approximation"}
                  {result.model?.version ? ` (v${result.model.version})` : ""}. We approximate the
                  cohort&apos;s score distribution as a bell curve, convert your score to a percentile,
                  then map that percentile against an assumed cohort size to get an AIR.
                </p>
                {result.score_margin_pp && (
                  <p className="mt-1">
                    For your test ({result.max_score} questions), the 95% band is roughly
                    ±{result.score_margin_pp.toFixed(1)} percentage points around your score
                    — combining sampling error from a finite test with a small allowance for
                    model drift.
                  </p>
                )}
              </div>

              <div>
                <p className="font-semibold text-slate-900">What we assume</p>
                {result.model?.assumptions ? (
                  <ul className="list-disc pl-5 space-y-0.5">
                    {result.model.assumptions.map((a, i) => <li key={i}>{a}</li>)}
                  </ul>
                ) : (
                  <p className="muted">Default cohort baselines for this exam type.</p>
                )}
              </div>

              <div>
                <p className="font-semibold text-slate-900">What this number does NOT account for</p>
                <ul className="list-disc pl-5 space-y-0.5">
                  <li>
                    <strong>Paper difficulty.</strong> A specific year&apos;s actual paper can be
                    materially harder or easier than average; cutoffs shift accordingly.
                  </li>
                  <li>
                    <strong>Section-wise normalization.</strong> Real exams (JEE Main, etc.) normalize
                    scores per section/shift before computing ranks — we treat the score as one number.
                  </li>
                  <li>
                    <strong>Negative marking & question weighting.</strong> Different exams penalise
                    wrong answers differently. We assume your raw score has already accounted for that.
                  </li>
                  <li>
                    <strong>Tie-breaking.</strong> When many candidates score the same, real exams use
                    secondary criteria (subject scores, age, application order) we can&apos;t see.
                  </li>
                  <li>
                    <strong>Cohort variance year-on-year.</strong> The total candidate pool and
                    average preparation level shift each year. We use a rough multi-year baseline.
                  </li>
                  <li>
                    <strong>Question quality of this specific test.</strong> If the mock&apos;s
                    questions are easier or harder than the real paper, the percentile is biased.
                  </li>
                  <li>
                    <strong>Your test-day form.</strong> One mock captures a sample — not your
                    ability ceiling, not your floor.
                  </li>
                </ul>
              </div>

              <p className="muted text-xs italic">
                Cohort baselines are rough order-of-magnitude figures, not official statistics.
                Predictions get more reliable as test length grows — a 200-question paper has a
                much narrower band than a 10-question quiz.
              </p>
            </div>
          </details>
        </div>
      )}

      <h2 className="h2 mt-10 mb-3 flex items-center gap-2">
        <History size={18} /> Past predictions
      </h2>
      {list.length === 0 ? (
        <div className="card text-center py-6 muted text-sm">No predictions yet — try one above.</div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase muted">
              <tr>
                <th className="px-4 py-3 text-left">Exam</th>
                <th className="px-4 py-3 text-left">Score</th>
                <th className="px-4 py-3 text-left">Percentile</th>
                <th className="px-4 py-3 text-left">AIR</th>
                <th className="px-4 py-3 text-left">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium">{EXAM_LABEL[p.exam_type]}</td>
                  <td className="px-4 py-3">{p.raw_score}/{p.max_score}</td>
                  <td className="px-4 py-3">{p.percentile.toFixed(1)}</td>
                  <td className="px-4 py-3 font-bold text-amber-700">~{p.predicted_air.toLocaleString()}</td>
                  <td className="px-4 py-3 muted">{new Date(p.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
