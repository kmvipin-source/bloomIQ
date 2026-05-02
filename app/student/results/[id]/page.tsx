"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { BLOOM_LEVELS, BLOOM_META, blankBloomCounts, type BloomLevel } from "@/lib/bloom";
import { BloomRadar } from "@/components/BloomChart";
import type { QuizAttempt } from "@/lib/types";
import { pct, formatSeconds } from "@/lib/utils";
import { Sparkles, Search, AlertOctagon, Crosshair, Trophy, Brain, Clock, Lock, Settings as SettingsIcon } from "lucide-react";

type Detail = QuizAttempt & { quiz: { name: string; code: string } | null };

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
  const [rank, setRank] = useState<{ exam_type: string; percentile: number; predicted_air: number; total_candidates: number; recommendations: string[] } | null>(null);
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

  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: a } = await sb
        .from("quiz_attempts")
        .select("*, quiz:quizzes(name, code)")
        .eq("id", id)
        .single();
      setAttempt(a as Detail);
      const { data: ans } = await sb.from("attempt_answers").select("is_correct, bloom_level").eq("attempt_id", id);
      const counts = { ...blankBloomCounts() } as Record<BloomLevel, number>;
      const tot = { ...blankBloomCounts() } as Record<BloomLevel, number>;
      (ans || []).forEach((x: { bloom_level: BloomLevel; is_correct: boolean | null }) => {
        tot[x.bloom_level] += 1; if (x.is_correct) counts[x.bloom_level] += 1;
      });
      const next = {} as Record<BloomLevel, { c: number; t: number }>;
      BLOOM_LEVELS.forEach((l) => next[l] = { c: counts[l], t: tot[l] });
      setByLevel(next);

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
      });
    } catch (e) {
      setRankErr(e instanceof Error ? e.message : "Rank prediction failed");
    } finally {
      setRankBusy(false);
    }
  }

  if (!attempt) return <div className="grid place-items-center py-20"><div className="spinner" /></div>;

  const percent = pct(attempt.score, attempt.total);
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
            <div className="muted">{attempt.score} of {attempt.total} correct · {attempt.time_taken_seconds ? formatSeconds(attempt.time_taken_seconds) : "—"}</div>
          </div>
          <div className="text-6xl">
            {percent >= 80 ? "🌟" : percent >= 60 ? "👍" : percent >= 40 ? "💪" : "📚"}
          </div>
        </div>
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
                {benchData.questions.map((row) => {
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
                      <td className="py-2 pr-3 font-medium">Q{row.position || "—"}</td>
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
          <button className="btn btn-primary" onClick={getRecs} disabled={loadingRecs}>
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
              <button className="btn btn-primary" onClick={diagnose} disabled={diagBusy}>
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
              <button className="btn btn-primary" onClick={enqueueMistakes} disabled={srsBusy}>
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
              <button className="btn btn-primary" onClick={diagnoseTraps} disabled={trapBusy}>
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

      {/* ============ MOCK RANK PREDICTOR ============
          Pure UX layer that converts your raw score into a competitive-exam
          AIR estimate. Sits at the bottom of the page so it feels like the
          finishing flourish on a mock test. */}
      {attempt.submitted_at && (
        <div className="card mt-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-2">
              <Trophy size={20} className="text-amber-700 mt-1 shrink-0" />
              <div>
                <h3 className="h2">Predict my rank</h3>
                <p className="text-sm muted mt-1 max-w-md">
                  See an estimated All-India Rank for this score against a JEE Main, NEET, or CAT-sized cohort.
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
              <button className="btn btn-primary" onClick={predictRank} disabled={rankBusy}>
                {rankBusy ? <><span className="spinner" /> Calculating…</> : <><Trophy size={16} /> Predict rank</>}
              </button>
            </div>
          </div>

          {rankErr && (
            <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{rankErr}</div>
          )}

          {rank && (
            <div className="mt-4 grid sm:grid-cols-3 gap-3">
              <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-3">
                <div className="text-xs muted uppercase font-semibold">Percentile</div>
                <div className="text-2xl font-bold mt-0.5">{rank.percentile.toFixed(1)}</div>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-3">
                <div className="text-xs muted uppercase font-semibold">Predicted AIR</div>
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
      )}
    </div>
  );
}
