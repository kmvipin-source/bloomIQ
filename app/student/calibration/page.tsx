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

      {/* Banner: this URL is the legacy "confidence calibration" view,
          NOT the new BloomIQ Score calibration that drives the score badge
          and Future You reveal. Point users at the right page so docs /
          old links don't strand them on the wrong screen. */}
      <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-sm text-emerald-900 flex items-center justify-between gap-3 flex-wrap">
        <span>
          Looking for the <strong>BloomIQ Score</strong> calibration (the 7-minute Future-You reveal)?
        </span>
        <Link href="/student/bloom-score" className="font-semibold inline-flex items-center gap-1 hover:underline">
          Go to BloomIQ Score →
        </Link>
      </div>

      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-teal-100 text-teal-700 p-3 shrink-0">
          <Gauge size={22} />
        </div>
        <div className="flex-1">
          <h1 className="h1">Confidence Insights</h1>
          <p className="muted mt-1">
            When you said &quot;I&apos;m sure about this one&quot; — were you actually right? This page quietly tracks that.
            It fills itself in as you tap <em>Sure / Probably / Probably not / Guess</em> in the Speed Trainer.
            No quiz to take here. Once enough data lands, it&apos;ll tell you which of your hunches you can trust
            in a real exam, and which ones cost you marks.
          </p>
        </div>
      </div>

      {/* Top stat strip */}
      <div className="grid sm:grid-cols-3 gap-3 mt-6">
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Hunches recorded</div>
          <div className="text-3xl font-bold">{totalN}</div>
          <div className="text-[11px] muted mt-0.5">Tap a confidence button in Speed Trainer to add more.</div>
        </div>
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">How off your hunches are</div>
          <div className="text-3xl font-bold">{overallCalibrationGap === null ? "—" : `${overallCalibrationGap}%`}</div>
          <div className="text-[11px] muted mt-0.5">{overallCalibrationGap === null ? "Need more data" : overallCalibrationGap < 10 ? "You read yourself well" : overallCalibrationGap < 20 ? "Roughly in line with reality" : "Quite off — see the bars below"}</div>
        </div>
        <div className="card">
          <div className="text-xs muted uppercase font-semibold">Confidence levels with data</div>
          <div className="text-3xl font-bold">{stats.filter((s) => s.n > 0).length} <span className="text-base muted">/ 4</span></div>
          <div className="text-[11px] muted mt-0.5">We need ratings across Sure, Probably, Probably not, Guess.</div>
        </div>
      </div>

      {loading ? (
        <div className="grid place-items-center py-10"><div className="spinner" /></div>
      ) : totalN === 0 ? (
        <div className="card mt-6 text-center py-10">
          <Sparkles size={20} className="mx-auto text-teal-500 mb-2" />
          <h2 className="font-semibold">Your insights will appear here</h2>
          <p className="text-sm muted mt-1 max-w-md mx-auto">
            This dashboard builds itself automatically. Every time you rate a question
            <strong> Sure / Probably / Probably not / Guess</strong> in Speed Trainer, a new row
            lands here. Class quizzes will add to it in a later release. There&apos;s nothing
            to take here — it just watches your hunches and tells you whether to trust them.
          </p>
          <Link href="/student/speed" className="btn btn-secondary mt-4">
            Source: Speed Trainer →
          </Link>
        </div>
      ) : (
        <>
          {/* Stated vs actual chart */}
          <div className="card mt-6">
            <h2 className="font-semibold mb-1">What you said vs what actually happened</h2>
            <p className="text-xs muted mb-3">
              For each confidence level, the grey pin shows roughly how often you <em>thought</em> you&apos;d be
              right. The coloured bar shows how often you <em>actually</em> were.
            </p>
            <div className="space-y-3">
              {stats.map((s) => (
                <div key={s.conf}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="font-medium">
                      {s.label}
                      <span className="muted text-xs ml-2">({s.n} {s.n === 1 ? "rating" : "ratings"})</span>
                    </span>
                    <span className="muted text-xs">
                      You felt ~{s.stated}% sure · really got {s.n > 0 ? `${Math.round(s.accuracy)}%` : "—"} right
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
              <strong>Bar ends before the pin?</strong> You&apos;re a bit overconfident — you thought you&apos;d do better than you did.
              <br />
              <strong>Bar goes past the pin?</strong> You&apos;re actually <em>better</em> than you think — trust those answers more.
            </p>
          </div>

          {/* Strategy panel */}
          <div className="card mt-4 bg-emerald-50/40 border-emerald-200">
            <h2 className="font-semibold inline-flex items-center gap-2"><Lightbulb size={18} className="text-emerald-700" /> Should you answer, or leave it blank?</h2>
            <p className="text-sm muted mt-1">
              Many entrance exams (like JEE Main and NEET) take <strong>1 mark off</strong> for a wrong answer
              and give <strong>4 marks</strong> for a right one. Blank answers get zero — no gain, no loss.
              Looking at how often you&apos;re actually right in each confidence band, here&apos;s the safe call:
            </p>
            <div className="mt-3 grid sm:grid-cols-2 gap-3">
              <div className="rounded-lg border border-emerald-200 bg-white p-3">
                <div className="text-xs uppercase tracking-wide font-semibold text-emerald-800 mb-1">Worth answering</div>
                <div className="text-sm font-medium">
                  {strategy.ok.length > 0 ? strategy.ok.join(", ") : "Need more data first"}
                </div>
                <div className="text-[11px] muted mt-1">You get these right often enough that the +4 outweighs the risk of −1.</div>
              </div>
              <div className="rounded-lg border border-amber-200 bg-white p-3">
                <div className="text-xs uppercase tracking-wide font-semibold text-amber-800 mb-1">Better to leave blank</div>
                <div className="text-sm font-medium">
                  {strategy.skip.length > 0 ? strategy.skip.join(", ") : "—"}
                </div>
                <div className="text-[11px] muted mt-1">You get these wrong too often — guessing will cost more marks than it earns.</div>
              </div>
            </div>
            <p className="text-xs muted mt-3">
              This list updates as you practise more. Check back every week — bands you&apos;re currently &quot;leaving blank&quot; can move to &quot;worth answering&quot; once your accuracy improves.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
