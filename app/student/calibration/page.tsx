"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Gauge, ArrowLeft, Lightbulb, Sparkles } from "lucide-react";

// =============================================================================
// CONFIDENCE CALIBRATION PROFILE — read-only aggregate of the events logged
// from Speed-Accuracy sessions (and, in future, the regular quiz UI).
//
// For each confidence band we compute:
//   - sample size (n)
//   - actual accuracy %
//   - "calibration gap" — the distance between the student's stated confidence
//     and reality. Students with high gap are over- or under-confident.
//
// We then translate this into a concrete negative-marking strategy ("On a
// JEE Main -1/+4 paper, attempt only Sure picks").
// =============================================================================

type Event = {
  confidence: number;
  was_correct: boolean;
  bloom_level: string | null;
  topic: string | null;
  created_at: string;
};

const BANDS = [
  { conf: 4, label: "Sure",        color: "bg-emerald-500" },
  { conf: 3, label: "Probably",    color: "bg-sky-500" },
  { conf: 2, label: "Probably not",color: "bg-amber-500" },
  { conf: 1, label: "Guess",       color: "bg-rose-500" },
] as const;

// Each confidence level corresponds to a stated mental probability the student
// has of being right. We use these as the calibration anchors.
const STATED_PROB: Record<number, number> = {
  4: 95,
  3: 75,
  2: 50,
  1: 25,
};

export default function CalibrationPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { void load(); }, []);

  async function load() {
    setLoading(true);
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) { setLoading(false); return; }
    const { data } = await sb
      .from("confidence_calibrations")
      .select("confidence, was_correct, bloom_level, topic, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(2000);
    setEvents((data as unknown as Event[]) || []);
    setLoading(false);
  }

  const stats = useMemo(() => {
    const out = BANDS.map((b) => {
      const subset = events.filter((e) => e.confidence === b.conf);
      const n = subset.length;
      const correct = subset.filter((e) => e.was_correct).length;
      const accuracy = n > 0 ? (correct / n) * 100 : 0;
      return { ...b, n, correct, accuracy, stated: STATED_PROB[b.conf] };
    });
    return out;
  }, [events]);

  const totalN = events.length;
  const overallCalibrationGap = useMemo(() => {
    // Average absolute distance between stated confidence and actual accuracy,
    // weighted by sample size. Lower = better-calibrated.
    let sumW = 0;
    let sumGap = 0;
    for (const s of stats) {
      if (s.n === 0) continue;
      sumGap += s.n * Math.abs(s.stated - s.accuracy);
      sumW += s.n;
    }
    return sumW > 0 ? Math.round(sumGap / sumW) : null;
  }, [stats]);

  // Negative-marking strategy hint, per JEE Main / NEET (-1 / +4 style).
  // "Attempt only bands where accuracy * 4 > (1 - accuracy) * 1" i.e. EV > 0.
  const strategy = useMemo(() => {
    const ok: string[] = [];
    const skip: string[] = [];
    for (const s of stats) {
      if (s.n < 5) continue;  // not enough data
      const ev = (s.accuracy / 100) * 4 - (1 - s.accuracy / 100) * 1;
      if (ev > 0) ok.push(s.label);
      else skip.push(s.label);
    }
    return { ok, skip };
  }, [stats]);

  return (
    <div className="max-w-3xl mx-auto fade-in">
      <Link href="/student" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-emerald-700 mb-3">
        <ArrowLeft size={14} /> Back to dashboard
      </Link>

      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-teal-100 text-teal-700 p-3 shrink-0">
          <Gauge size={22} />
        </div>
        <div className="flex-1">
          <h1 className="h1">Confidence Calibration</h1>
          <p className="muted mt-1">
            Are your hunches actually right? When you mark a question as &quot;Sure&quot;, are you really getting it right?
            Knowing the difference between confident-and-correct vs confident-and-wrong is what separates
            AIR 500 from AIR 5000 on negative-marking exams.
          </p>
        </div>
      </div>

      {/* Top stat strip */}
      <div className="grid sm:grid-cols-3 gap-3 mt-6">
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Ratings logged</div>
          <div className="text-3xl font-bold">{totalN}</div>
        </div>
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Calibration gap</div>
          <div className="text-3xl font-bold">{overallCalibrationGap === null ? "—" : `${overallCalibrationGap}%`}</div>
          <div className="text-[11px] muted mt-0.5">{overallCalibrationGap === null ? "Need more data" : overallCalibrationGap < 10 ? "Well-calibrated" : overallCalibrationGap < 20 ? "Reasonable" : "Off — read the bars"}</div>
        </div>
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Bands w/ data</div>
          <div className="text-3xl font-bold">{stats.filter((s) => s.n > 0).length} <span className="text-base muted">/ 4</span></div>
        </div>
      </div>

      {loading ? (
        <div className="grid place-items-center py-10"><div className="spinner" /></div>
      ) : totalN === 0 ? (
        <div className="card mt-6 text-center py-10">
          <Sparkles size={20} className="mx-auto text-teal-500 mb-2" />
          <h2 className="font-semibold">No ratings yet</h2>
          <p className="text-sm muted mt-1 max-w-md mx-auto">
            Take a Speed-Accuracy session — each question now asks you to rate how confident you are right
            before you answer. Your profile builds itself from there.
          </p>
          <Link href="/student/speed" className="btn btn-primary mt-4">Open Speed Trainer →</Link>
        </div>
      ) : (
        <>
          {/* Stated vs actual chart */}
          <div className="card mt-6">
            <h2 className="font-semibold mb-3">Stated confidence vs actual accuracy</h2>
            <div className="space-y-3">
              {stats.map((s) => (
                <div key={s.conf}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="font-medium">
                      {s.label}
                      <span className="muted text-xs ml-2">({s.n} ratings)</span>
                    </span>
                    <span className="muted text-xs">
                      You said ~{s.stated}% · actually {s.n > 0 ? `${Math.round(s.accuracy)}%` : "—"}
                    </span>
                  </div>
                  <div className="relative h-3 bg-slate-100 rounded-full overflow-hidden">
                    {/* Stated band — light pin */}
                    <div className="absolute inset-y-0 w-0.5 bg-slate-400" style={{ left: `${s.stated}%` }} />
                    {/* Actual band — colored bar */}
                    <div className={`h-full ${s.color} transition-all`} style={{ width: `${s.n > 0 ? Math.round(s.accuracy) : 0}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs muted mt-3">
              The colored bar is your actual accuracy. The vertical pin marks where you <em>said</em> you were.
              Bar to the left of pin = overconfident. Bar to the right = underconfident.
            </p>
          </div>

          {/* Strategy panel */}
          <div className="card mt-4 bg-emerald-50/40 border-emerald-200">
            <h2 className="font-semibold inline-flex items-center gap-2"><Lightbulb size={18} className="text-emerald-700" /> Negative-marking strategy</h2>
            <p className="text-sm muted mt-1">
              On JEE Main / NEET-style papers (-1 wrong, +4 right), only attempt confidence bands where your
              accuracy × 4 beats your error rate × 1. With your current calibration:
            </p>
            <div className="mt-3 grid sm:grid-cols-2 gap-3">
              <div className="rounded-lg border border-emerald-200 bg-white p-3">
                <div className="text-xs uppercase tracking-wide font-semibold text-emerald-800 mb-1">Attempt these</div>
                <div className="text-sm font-medium">
                  {strategy.ok.length > 0 ? strategy.ok.join(", ") : "Need more data first"}
                </div>
              </div>
              <div className="rounded-lg border border-amber-200 bg-white p-3">
                <div className="text-xs uppercase tracking-wide font-semibold text-amber-800 mb-1">Skip these in the real exam</div>
                <div className="text-sm font-medium">
                  {strategy.skip.length > 0 ? strategy.skip.join(", ") : "—"}
                </div>
              </div>
            </div>
            <p className="text-xs muted mt-3">
              This rule shifts as you get better — re-check this page weekly.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
