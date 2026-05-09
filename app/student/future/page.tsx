"use client";

// =============================================================================
// app/student/future/page.tsx
// -----------------------------------------------------------------------------
// "Future You" reveal — the dramatic post-calibration moment.
//
// Shows three things in sequence:
//
//   1. A large count-up animation from 300 to the student's actual score.
//      The animation manufactures anticipation; the brain treats a counter
//      that climbs the same way it treats a slot-machine wheel.
//
//   2. The predicted exam-day rank + 3 named target colleges (or a
//      percentile band fallback for exam goals we don't have cutoff
//      tables for).
//
//   3. A side-by-side "Best You" card showing the lifted rank + colleges
//      they'd hit if they fixed their top 3 weakest Bloom levels —
//      explicitly named ("Apply, Analyze, Create"). This delta is the
//      single most important pixel on the screen — it's the hope.
//
// Direct-navigation safe: if there's no fresh sessionStorage payload from
// the just-finished calibration, the page falls back to fetching
// /api/student/score.
// =============================================================================

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  Sparkles, TrendingUp, Trophy, Target, ArrowRight, RefreshCw,
  Share2, Lock,
} from "lucide-react";
import { BLOOM_LABEL } from "@/lib/bloomiqScore";
import {
  computeSignature,
  computeStrength,
  computeConcern,
  computeTimeToBestYou,
  computeUpgradeNarrative,
  topicForGoal,
  type UpgradeAction,
} from "@/lib/bloomiqInsights";
import type { BloomLevel } from "@/lib/bloom";
import { useFeatureAccess } from "@/lib/featureAccess";
import { CheckCircle2, AlertTriangle, Clock, Zap, Award, PlayCircle, Crown } from "lucide-react";

type College = { name: string; band: string };
type Reveal = {
  ok: true;
  score: number;
  percentile: number;
  bloom_breakdown: Record<string, number>;
  weakest_bloom_levels: string[];
  prediction: {
    predicted_rank: number | null;
    rank_label: string;
    colleges: College[];
  };
  best_you: {
    score: number;
    prediction: {
      predicted_rank: number | null;
      rank_label: string;
      colleges: College[];
    };
    lifted_levels: string[];
  };
  /** True when profiles.exam_goal differs from the calibration's exam_goal
   *  (student switched goal after calibrating). Drives the "Re-calibrate"
   *  banner above the score hero. */
  is_stale?: boolean;
  /** Friendly label of the user's current goal — used in the banner copy. */
  current_exam_goal?: string | null;
  calibration_exam_goal?: string | null;
};

type ScoreFallback = {
  ok: true;
  has_calibration: boolean;
  score: number | null;
  percentile: number | null;
  predicted_rank: number | null;
  rank_label: string | null;
  colleges?: College[];
  bloom_breakdown: Record<string, number>;
  calibration: {
    exam_goal: string | null;
    initial_score: number;
    best_you_score: number | null;
    best_you_predicted_rank: number | null;
    weakest_bloom_levels: string[];
    completed_at: string;
  } | null;
  current_exam_goal?: string | null;
  is_stale?: boolean;
};

export default function FutureYouPage() {
  const router = useRouter();
  const search = useSearchParams();
  const isFresh = search.get("fresh") === "1";

  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasCalibration, setHasCalibration] = useState<boolean>(true);

  useEffect(() => {
    (async () => {
      // Hot path: fresh from calibration, payload already in sessionStorage.
      if (isFresh) {
        try {
          const raw = sessionStorage.getItem("bloomiq:lastReveal");
          if (raw) {
            const parsed = JSON.parse(raw) as Reveal;
            if (parsed?.ok && typeof parsed.score === "number") {
              setReveal(parsed);
              setLoading(false);
              return;
            }
          }
        } catch { /* fall through to fetch */ }
      }

      // Cold path: fetch from /api/student/score and reconstruct enough
      // for the reveal screen.
      try {
        const sb = supabaseBrowser();
        const { data: { session } } = await sb.auth.getSession();
        if (!session) {
          router.replace("/login?next=/student/future");
          return;
        }
        const r = await fetch("/api/student/score", {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: "no-store",
        });
        const data = (await r.json()) as ScoreFallback;
        if (!r.ok || !data.ok) throw new Error("Failed to load score");
        if (!data.has_calibration || data.score == null || !data.calibration) {
          setHasCalibration(false);
          setLoading(false);
          return;
        }
        const reconstructed: Reveal = {
          ok: true,
          score: data.score,
          percentile: data.percentile ?? 50,
          bloom_breakdown: data.bloom_breakdown,
          weakest_bloom_levels: data.calibration.weakest_bloom_levels,
          prediction: {
            predicted_rank: data.predicted_rank,
            rank_label: data.rank_label || "—",
            colleges: data.colleges || [],
          },
          best_you: {
            score: data.calibration.best_you_score ?? data.score,
            prediction: {
              predicted_rank: data.calibration.best_you_predicted_rank,
              rank_label: data.calibration.best_you_predicted_rank
                ? `AIR ~${data.calibration.best_you_predicted_rank.toLocaleString("en-IN")}`
                : "—",
              colleges: [], // not in score payload — they'll re-compute on next calibration
            },
            lifted_levels: data.calibration.weakest_bloom_levels,
          },
          is_stale: !!data.is_stale,
          current_exam_goal: data.current_exam_goal ?? null,
          calibration_exam_goal: data.calibration.exam_goal,
        };
        setReveal(reconstructed);
      } catch {
        setHasCalibration(false);
      } finally {
        setLoading(false);
      }
    })();
  }, [isFresh, router]);

  if (loading) {
    return (
      <div className="max-w-xl mx-auto pt-20 text-center">
        <div className="spinner mx-auto" />
        <p className="mt-4 opacity-70">Loading your Future You…</p>
      </div>
    );
  }

  if (!hasCalibration || !reveal) {
    return (
      <div className="max-w-xl mx-auto pt-20">
        <div className="card p-8 text-center">
          <Sparkles size={32} className="mx-auto mb-3 opacity-60" />
          <h1 className="text-xl font-bold">No calibration yet</h1>
          <p className="mt-2 opacity-70">
            Take the 7-minute calibration to discover your BloomIQ Score and your
            predicted exam-day rank.
          </p>
          <Link
            href="/student/bloom-score"
            className="btn btn-primary mt-5 inline-flex items-center gap-2"
          >
            Start calibration <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    );
  }

  return <Reveal data={reveal} animate={isFresh} />;
}

// ─────────────────────────────────────────────────────────────────────────────

function Reveal({ data, animate }: { data: Reveal; animate: boolean }) {
  const target = data.score;
  const [displayed, setDisplayed] = useState<number>(animate ? 300 : target);
  const access = useFeatureAccess();
  const planTier = access.planTier;

  // #5: Weekly drill progress per Bloom level — fetched on mount and rendered
  // alongside each ActiveAction row to replace the decorative "Active" pill
  // with a real "X done this week" counter.
  const [weeklyProgress, setWeeklyProgress] = useState<Record<string, number>>({});
  useEffect(() => {
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return;
        const r = await fetch("/api/student/weekly-drill-progress", {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: "no-store",
        });
        if (!r.ok) return;
        const j = await r.json() as { ok?: boolean; by_bloom?: Record<string, number> };
        if (j?.ok && j.by_bloom) setWeeklyProgress(j.by_bloom);
      } catch { /* silent — progress dots will show 0 if fetch fails */ }
    })();
  }, []);

  // Weakest-topic resolution: pull the specific topic the student got WRONG
  // most often during calibration (filtered by their weakest Bloom level when
  // possible) and use it as the drill topic. This stops the drill from being
  // a generic "mix of subjects" — it targets the exact spot they actually
  // need work on. Falls back to topicForGoal only when calibration_responses
  // has no usable signal yet.
  const [weakestTopic, setWeakestTopic] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) return;
        const targetLevel = (data.weakest_bloom_levels && data.weakest_bloom_levels[0]) || null;
        // Try the precise filter first (wrong + at the targeted Bloom level).
        let { data: rows } = await sb
          .from("calibration_responses")
          .select("topic, bloom_level, is_correct")
          .eq("user_id", user.id)
          .eq("is_correct", false)
          .not("topic", "is", null)
          .limit(50);
        let pool: { topic?: string | null; bloom_level?: string }[] = rows || [];
        // Prefer rows at the targeted Bloom level when available.
        if (targetLevel) {
          const atLevel = pool.filter((r) => r.bloom_level === targetLevel);
          if (atLevel.length > 0) pool = atLevel;
        }
        // Pick the most-common topic among the wrong answers.
        const counts: Record<string, number> = {};
        for (const r of pool) {
          const tp = (r.topic || "").trim();
          if (tp.length >= 3) counts[tp] = (counts[tp] || 0) + 1;
        }
        const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        if (ranked.length > 0) {
          setWeakestTopic(ranked[0][0]);
        }
      } catch { /* silent — topicForGoal fallback kicks in */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.weakest_bloom_levels]);

  // Free-cap pre-flight — show how many drills the student has left today
  // RIGHT NEXT TO the "Try a free drill" button so they know before clicking
  // whether the cap is reached. attempts_remaining_today is a Supabase RPC
  // wired up in migration 10. We fetch it on mount; null = not capped (paid).
  const [freeRemaining, setFreeRemaining] = useState<number | null>(null);
  const [freeCap, setFreeCap] = useState<number | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return;
        const [{ data: remaining }, { data: limits }] = await Promise.all([
          sb.rpc("attempts_remaining_today"),
          sb.from("subscription_limits").select("free_daily_attempts").eq("id", 1).maybeSingle(),
        ]);
        if (typeof remaining === "number") setFreeRemaining(remaining);
        const cap = (limits as { free_daily_attempts?: number } | null)?.free_daily_attempts ?? null;
        if (typeof cap === "number") setFreeCap(cap);
      } catch { /* silent */ }
    })();
  }, []);

  // #7: When the student reaches (or nearly reaches) Best You, the original
  // calibration target stops being motivating. Show a "you’ve reached your
  // initial target — re-calibrate to set a new one" prompt.
  const reachedBestYou = data.score >= data.best_you.score - 5;

  // Build a one-tap drill URL pointing at the student's weakest measured Bloom
  // level (from the calibration). Used by every "Try one drill free" / "Drill
  // weakest level" / "Start this week's plan" CTA — they all want the same
  // thing: take the user straight into a Bloom-targeted quiz, not into an
  // empty topic-input form. The auto=1 flag tells the practice page to
  // auto-fire start() on mount.
  const weakestLevel = (data.weakest_bloom_levels && data.weakest_bloom_levels[0]) || null;
  // drillTopic resolution priority:
  //   1. weakestTopic (specific topic from calibration_responses where the
  //      student got it wrong) — most personalised, e.g. "Plant Physiology".
  //   2. topicForGoal (single-subject fallback per exam goal, e.g. "NEET
  //      Biology") — used when the user has no wrong-answer signal yet.
  const drillTopic = weakestTopic || topicForGoal(data.calibration_exam_goal || data.current_exam_goal);
  const drillHref = weakestLevel
    ? `/student/practice?bloom=${weakestLevel}&topic=${encodeURIComponent(drillTopic)}&auto=1`
    : `/student/practice?topic=${encodeURIComponent(drillTopic)}&auto=1`;

  useEffect(() => {
    if (!animate) { setDisplayed(target); return; }
    let frame = 0;
    const totalFrames = 50;
    const start = 300;
    const id = setInterval(() => {
      frame += 1;
      const t = frame / totalFrames;
      // Ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      const v = Math.round(start + (target - start) * eased);
      setDisplayed(v);
      if (frame >= totalFrames) clearInterval(id);
    }, 30);
    return () => clearInterval(id);
  }, [target, animate]);

  const delta = data.best_you.score - data.score;
  const liftedLevels = (data.weakest_bloom_levels as BloomLevel[])
    .map((l) => BLOOM_LABEL[l] ?? l)
    .filter(Boolean);

  const sortedBreakdown = useMemo(() => {
    return (Object.entries(data.bloom_breakdown) as Array<[string, number]>)
      .sort(([a], [b]) => {
        const order: Record<string, number> = {
          remember: 0, understand: 1, apply: 2, analyze: 3, evaluate: 4, create: 5,
        };
        return (order[a] ?? 99) - (order[b] ?? 99);
      });
  }, [data.bloom_breakdown]);

  function shareScreenshot() {
    // Best-effort share. Many browsers can't capture the page itself,
    // so we offer a copy-link shortcut and a guidance toast.
    if (navigator.share) {
      navigator.share({
        title: "My BloomIQ Score",
        text: `My BloomIQ Score is ${data.score}. Predicted ${data.prediction.rank_label}. Discover yours →`,
        url: window.location.origin + "/pricing",
      }).catch(() => { /* user cancelled */ });
    } else {
      navigator.clipboard?.writeText(
        `My BloomIQ Score is ${data.score}. Predicted ${data.prediction.rank_label}. Try it: ${window.location.origin}/signup`
      );
      alert("Copied to clipboard — paste into your story!");
    }
  }

  return (
    <div className="max-w-3xl mx-auto pt-6 pb-16">
      {data.is_stale ? (
        <div className="card mb-4 p-4 border-2"
             style={{ borderColor: "#f59e0b", background: "rgba(245,158,11,0.08)" }}>
          <div className="flex items-start gap-3 flex-wrap">
            <AlertTriangle size={18} style={{ color: "#f59e0b" }} className="flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sm">Your goal changed — your score is now stale</div>
              <p className="text-xs opacity-80 mt-1 leading-relaxed">
                You're preparing for <strong>{prettyGoal(data.current_exam_goal)}</strong> but
                your last calibration was for <strong>{prettyGoal(data.calibration_exam_goal)}</strong>.
                The Bloom mastery numbers below still apply, but the predicted rank, colleges,
                and Best You target are tuned to your old goal. Re-calibrate to refresh.
              </p>
            </div>
            <Link
              href="/student/bloom-score"
              className="btn btn-primary flex items-center gap-2 text-sm py-2 px-3"
              style={{ background: "#f59e0b", color: "white" }}
            >
              <RefreshCw size={14} /> Re-calibrate now
            </Link>
          </div>
        </div>
      ) : null}

      {reachedBestYou && data.best_you.score > data.score - 50 ? (
        <div className="card mb-4 p-4 border-2"
             style={{ borderColor: "#10b981", background: "rgba(16,185,129,0.10)" }}>
          <div className="flex items-start gap-3 flex-wrap">
            <Trophy size={18} style={{ color: "#10b981" }} className="flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sm" style={{ color: "#10b981" }}>
                You’ve hit your initial target
              </div>
              <p className="text-xs opacity-80 mt-1 leading-relaxed">
                Your score has climbed to or beyond the Best You target from your first
                calibration ({data.best_you.score}). Re-calibrate to set a fresh higher
                target tuned to where you are now.
              </p>
            </div>
            <Link
              href="/student/bloom-score"
              className="btn flex items-center gap-2 text-sm py-2 px-3 border-2"
              style={{ borderColor: "#10b981", color: "#10b981" }}
            >
              <RefreshCw size={14} /> Re-calibrate
            </Link>
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between mb-1">
        <div className="flex-1" />
        <div className="text-xs uppercase tracking-wider opacity-60 text-center flex-1">
          Your BloomIQ Score
        </div>
        <div className="flex-1 flex justify-end">
          <Link
            href="/student/bloom-score"
            className="text-xs opacity-70 hover:opacity-100 inline-flex items-center gap-1 transition"
            title="Change exam goal or re-take calibration"
          >
            <RefreshCw size={11} /> Change goal
          </Link>
        </div>
      </div>
      <div className="text-center text-xs opacity-60 mb-2">
        for <strong className="opacity-80">{prettyGoal(data.calibration_exam_goal || data.current_exam_goal)}</strong>
      </div>

      {/* SCORE HERO — dimmed when calibration is stale, since the rank label
          and college names below reflect the previous goal, not the current one. */}
      <div
        className={`card p-8 text-center ${data.is_stale ? "opacity-70" : ""}`}
        style={{
          background: "linear-gradient(135deg, rgba(16,185,129,0.08) 0%, rgba(99,102,241,0.08) 100%)",
          borderColor: "rgba(99,102,241,0.3)",
        }}
      >
        <div
          className="text-7xl md:text-8xl font-extrabold tracking-tight"
          style={{
            background: "linear-gradient(135deg, #10b981 0%, #6366f1 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}
        >
          {displayed}
        </div>
        <div className="text-xs opacity-50 mt-1">out of 900 · {data.percentile}th percentile</div>

        <div className="mt-6 inline-flex items-center gap-2 text-sm rounded-full px-4 py-1.5"
             style={{ background: "rgba(99,102,241,0.12)", color: "#6366f1" }}>
          <Target size={14} /> Predicted exam day: <strong>{data.prediction.rank_label}</strong>
        </div>

        {data.prediction.colleges.length > 0 ? (
          <div className="mt-5 grid sm:grid-cols-3 gap-2">
            {data.prediction.colleges.map((c, i) => (
              <CollegeChip key={i} c={c} />
            ))}
          </div>
        ) : null}
      </div>

      {/* BEST YOU */}
      <div className="mt-6 grid md:grid-cols-2 gap-4">
        <div className="card p-5">
          <div className="text-xs uppercase tracking-wider opacity-60 mb-1">Current you</div>
          <div className="text-3xl font-bold">{data.score}</div>
          <div className="text-sm opacity-70 mt-1">{data.prediction.rank_label}</div>
        </div>
        <div
          className="card p-5 border-2"
          style={{
            borderColor: "#10b981",
            background: "rgba(16,185,129,0.06)",
          }}
        >
          <div className="text-xs uppercase tracking-wider mb-1 flex items-center gap-1"
               style={{ color: "#10b981" }}>
            <TrendingUp size={12} /> Best you
          </div>
          <div className="text-3xl font-bold flex items-baseline gap-2">
            {data.best_you.score}
            {delta > 0 ? (
              <span className="text-sm font-semibold" style={{ color: "#10b981" }}>
                +{delta}
              </span>
            ) : null}
          </div>
          <div className="text-sm opacity-80 mt-1">{data.best_you.prediction.rank_label}</div>
          {data.best_you.prediction.colleges.length > 0 ? (
            <div className="mt-3 grid gap-1.5">
              {data.best_you.prediction.colleges.slice(0, 3).map((c, i) => (
                <div key={i} className="text-xs flex items-center gap-2">
                  <Trophy size={12} style={{ color: "#10b981" }} />
                  <span className="font-medium">{c.name}</span>
                  <span className="opacity-50">{c.band}</span>
                </div>
              ))}
            </div>
          ) : null}
          {liftedLevels.length > 0 ? (
            <div className="mt-3 text-xs opacity-80">
              Reachable by closing your top weak spots:{" "}
              <strong>{liftedLevels.join(", ")}</strong>
            </div>
          ) : null}
        </div>
      </div>

      {/* BLOOM BREAKDOWN */}
      <div className="card p-5 mt-6">
        <div className="text-xs uppercase tracking-wider opacity-60 mb-3">
          How you scored across Bloom&apos;s six levels
        </div>
        <div className="grid gap-2">
          {sortedBreakdown.map(([lvl, mastery]) => {
            const pct = Math.round((mastery as number) * 100);
            const isWeak = data.weakest_bloom_levels.includes(lvl);
            return (
              <div key={lvl} className="flex items-center gap-3 text-sm">
                <div className="w-24 capitalize opacity-80">{BLOOM_LABEL[lvl as BloomLevel] ?? lvl}</div>
                <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: "rgba(0,0,0,0.06)" }}>
                  <div
                    className="h-full"
                    style={{
                      width: `${pct}%`,
                      background: isWeak
                        ? "linear-gradient(90deg, #f59e0b 0%, #ef4444 100%)"
                        : "linear-gradient(90deg, #10b981 0%, #6366f1 100%)",
                    }}
                  />
                </div>
                <div className="w-12 text-right text-xs opacity-70 font-mono">{pct}%</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* WHAT THIS MEANS — interpretation card */}
      {(() => {
        const signature = computeSignature(data.bloom_breakdown);
        const strength = computeStrength(data.bloom_breakdown);
        const concern = computeConcern(data.bloom_breakdown);
        const time = computeTimeToBestYou(data.score, data.best_you.score, data.weakest_bloom_levels);
        return (
          <div className="card p-5 mt-6"
               style={{ background: "linear-gradient(180deg, rgba(99,102,241,0.04) 0%, transparent 100%)" }}>
            <div className="text-xs uppercase tracking-wider opacity-60 mb-3">
              What this score means for you
            </div>

            {/* Bloom signature — identity / personality label */}
            <div className="rounded-lg p-4 mb-3"
                 style={{ background: "linear-gradient(135deg, rgba(16,185,129,0.10) 0%, rgba(99,102,241,0.10) 100%)",
                          border: "1px solid rgba(99,102,241,0.25)" }}>
              <div className="flex items-center gap-2 mb-1">
                <Award size={16} style={{ color: "#6366f1" }} />
                <div className="text-xs uppercase tracking-wider font-semibold" style={{ color: "#6366f1" }}>
                  Your Bloom signature
                </div>
              </div>
              <div className="text-lg font-bold">{signature.label}</div>
              <p className="text-sm opacity-80 mt-1 leading-relaxed">{signature.tagline}</p>
            </div>

            {/* Strength + Concern — two callouts side by side */}
            <div className="grid md:grid-cols-2 gap-3">
              {strength ? (
                <div className="rounded-lg p-3 border"
                     style={{ background: "rgba(16,185,129,0.06)", borderColor: "rgba(16,185,129,0.30)" }}>
                  <div className="flex items-center gap-1.5 text-xs font-semibold mb-1"
                       style={{ color: "#10b981" }}>
                    <CheckCircle2 size={14} /> What is working
                  </div>
                  <div className="text-sm font-semibold">
                    {strength.label} {Math.round(strength.mastery * 100)}%
                  </div>
                  <p className="text-xs opacity-80 mt-1 leading-relaxed">{strength.takeaway}</p>
                </div>
              ) : null}
              {concern ? (
                <div className="rounded-lg p-3 border"
                     style={{ background: "rgba(239,68,68,0.06)", borderColor: "rgba(239,68,68,0.30)" }}>
                  <div className="flex items-center gap-1.5 text-xs font-semibold mb-1"
                       style={{ color: "#ef4444" }}>
                    <AlertTriangle size={14} /> What is costing marks
                  </div>
                  <div className="text-sm font-semibold">
                    {concern.label} {Math.round(concern.mastery * 100)}%
                  </div>
                  <p className="text-xs opacity-80 mt-1 leading-relaxed">{concern.takeaway}</p>
                </div>
              ) : null}
            </div>

            {/* Time to Best You — concrete timeline */}
            {data.best_you.score > data.score ? (
              <div className="mt-3 rounded-lg p-3 flex items-center gap-3 text-sm"
                   style={{ background: "rgba(0,0,0,0.03)" }}>
                <Clock size={16} className="opacity-60 flex-shrink-0" />
                <div className="leading-relaxed">
                  At <strong>{time.dailyMinutes} min/day of focused practice</strong>, you can lift your
                  score from <strong>{data.score}</strong> to <strong>{data.best_you.score}</strong> in
                  about <strong>{time.weeksMin}–{time.weeksMax} weeks</strong>{" "}
                  ({time.totalHours} hours of total practice).
                </div>
              </div>
            ) : null}
          </div>
        );
      })()}

      {/* TIER-AWARE BOTTOM SECTION
          Free / anon → personalised pitch (sales mode).
          Premium    → active-path tracker + small Plus nudge (retention mode).
          Premium Plus / school_plus → just the active-path tracker (no upsell). */}
      {(() => {
        const tier = planTier;
        const isPaid = tier === "premium" || tier === "premium_plus" ||
                       tier === "school_pilot" || tier === "school_standard" || tier === "school_plus";
        const pitch = computeUpgradeNarrative(
          data.score,
          data.best_you.score,
          data.weakest_bloom_levels as BloomLevel[]
        );

        if (!isPaid) {
          // ─── FREE / ANON: personalised pitch ───
          return (
            <div className="card p-6 mt-6 border-2"
                 style={{
                   borderColor: "#6366f1",
                   background: "linear-gradient(135deg, rgba(99,102,241,0.08) 0%, rgba(16,185,129,0.06) 100%)",
                 }}>
              <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
                <div>
                  <div className="text-xs uppercase tracking-wider font-semibold mb-1"
                       style={{ color: "#6366f1" }}>
                    Premium · Personalised for your Bloom profile
                  </div>
                  <h3 className="text-xl md:text-2xl font-bold leading-tight">{pitch.headline}</h3>
                  <p className="text-sm opacity-80 mt-1">{pitch.subhead}</p>
                  <p className="text-xs opacity-70 mt-2">
                    Free gets adaptive practice (3 drills/day). Premium unlocks
                    Bloom-targeted weekly habits, the active-path tracker, and
                    score-history insights.
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-2xl font-extrabold" style={{ color: "#6366f1" }}>
                    ₹{pitch.monthlyPriceInr}
                  </div>
                  <div className="text-xs opacity-60">per month</div>
                </div>
              </div>

              <div className="grid gap-2 mt-4">
                {pitch.actions.map((a: UpgradeAction, i: number) => (
                  <PitchAction key={i} action={a} />
                ))}
              </div>

              <div className="mt-4 flex items-center gap-2 text-xs opacity-70">
                <Clock size={12} /> {pitch.weeklyTimeTotal}
              </div>

              <div className="mt-5 grid sm:grid-cols-3 gap-3">
                <Link
                  href="/pricing"
                  className="btn btn-primary flex items-center justify-center gap-2 py-3 sm:col-span-2"
                  style={{ background: "#6366f1", color: "white" }}
                >
                  <Zap size={16} /> {pitch.cta}
                </Link>
                {freeRemaining === 0 ? (
                  <Link
                    href="/pricing"
                    className="btn flex items-center justify-center gap-2 py-3 border-2"
                    style={{ borderColor: "#ef4444", color: "#ef4444" }}
                  >
                    <Lock size={16} /> Free cap hit — unlock more
                  </Link>
                ) : (
                  <Link
                    href={drillHref}
                    className="btn flex items-center justify-center gap-2 py-3 border"
                  >
                    <Sparkles size={16} />
                    Try a free drill
                    {typeof freeRemaining === "number" && typeof freeCap === "number" ? (
                      <span className="text-xs opacity-70">({freeRemaining}/{freeCap} left today)</span>
                    ) : null}
                  </Link>
                )}
              </div>

              <p className="text-xs opacity-60 mt-2 leading-relaxed">
                Free plan includes 3 drills/day. Premium removes the cap and unlocks
                Bloom-targeted weekly habits.
              </p>
              <p className="text-xs opacity-60 mt-2 leading-relaxed">{pitch.guarantee}</p>
            </div>
          );
        }

        // ─── PAID (Premium / Premium Plus / school plans): active-path tracker ───
        const tierLabelText =
          tier === "premium_plus" ? "Premium Plus" :
          tier === "premium"      ? "Premium" :
          tier === "school_plus"  ? "School Plus" :
          tier === "school_standard" ? "School Standard" :
          tier === "school_pilot" ? "School Pilot" : "Premium";
        const showPlusNudge = tier === "premium"; // only for Premium, not Plus or school

        return (
          <div className="card p-6 mt-6 border-2"
               style={{
                 borderColor: "#10b981",
                 background: "linear-gradient(135deg, rgba(16,185,129,0.10) 0%, rgba(99,102,241,0.06) 100%)",
               }}>
            <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
              <div>
                <div className="text-xs uppercase tracking-wider font-semibold mb-1 flex items-center gap-1.5"
                     style={{ color: "#10b981" }}>
                  <Crown size={12} /> {tierLabelText} · your active path
                </div>
                <h3 className="text-xl md:text-2xl font-bold leading-tight">{pitch.headline}</h3>
                <p className="text-sm opacity-80 mt-1">
                  Three targeted weekly habits, calibrated to your weak spots. Tap any to start now.
                </p>
              </div>
              <div className="text-right flex-shrink-0 inline-flex items-center gap-1 text-xs font-semibold rounded-full px-3 py-1.5"
                   style={{ background: "rgba(16,185,129,0.15)", color: "#10b981" }}>
                <CheckCircle2 size={12} /> {weeklyTotalThisWeek(weeklyProgress)} drills this week
              </div>
            </div>

            <div className="grid gap-2 mt-4">
              {pitch.actions.map((a: UpgradeAction, i: number) => (
                <ActiveAction
                  key={i}
                  action={a}
                  actionTopic={drillTopic}
                  weekCount={weeklyProgress[a.level] ?? 0}
                />
              ))}
            </div>

            <div className="mt-4 flex items-center gap-2 text-xs opacity-70">
              <Clock size={12} /> {pitch.weeklyTimeTotal} · score updates after each drill
            </div>

            <div className="mt-5 grid sm:grid-cols-2 gap-3">
              <Link
                href={drillHref}
                className="btn btn-primary flex items-center justify-center gap-2 py-3"
                style={{ background: "#10b981", color: "white" }}
              >
                <PlayCircle size={16} /> Start this week's plan
              </Link>
              <Link
                href="/student/progress"
                className="btn flex items-center justify-center gap-2 py-3 border"
              >
                <TrendingUp size={16} /> See score history
              </Link>
            </div>

            {showPlusNudge ? (
              <div className="mt-5 rounded-lg p-3 flex items-start gap-3 text-xs"
                   style={{ background: "rgba(99,102,241,0.06)", border: "1px solid rgba(99,102,241,0.2)" }}>
                <Crown size={14} style={{ color: "#6366f1" }} className="flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div className="font-semibold" style={{ color: "#6366f1" }}>Going faster? Premium Plus unlocks unlimited AI Tutor + advanced drills.</div>
                  <div className="opacity-70 mt-0.5">Same money-back rule — cancel the day your score stops climbing.</div>
                </div>
                <Link href="/pricing" className="text-xs font-semibold whitespace-nowrap"
                      style={{ color: "#6366f1" }}>
                  Compare →
                </Link>
              </div>
            ) : null}
          </div>
        );
      })()}

      {/* SECONDARY ACTION — share. Drill button removed because the pitch /
          active-path card above already has the primary drill CTA, and a
          duplicate "Drill weakest" button next to it just confuses the eye. */}
      <div className="mt-4 flex justify-center">
        <button
          onClick={shareScreenshot}
          className="btn flex items-center justify-center gap-2 py-3 px-5 border"
        >
          <Share2 size={16} /> Share your score
        </button>
      </div>

      <p className="text-xs opacity-50 text-center mt-6">
        College predictions use public approximate cutoffs as anchors — not official
        admission predictions. Re-calibrate anytime to refresh.
      </p>

      <div className="text-center mt-3">
        <Link href="/student/bloom-score" className="text-xs opacity-60 hover:opacity-100 inline-flex items-center gap-1">
          <RefreshCw size={11} /> Re-take calibration
        </Link>
      </div>
    </div>
  );
}

function CollegeChip({ c }: { c: College }) {
  return (
    <div className="rounded-lg p-3 text-left"
         style={{ background: "rgba(255,255,255,0.6)", border: "1px solid rgba(0,0,0,0.06)" }}>
      <div className="text-sm font-semibold leading-tight">{c.name}</div>
      <div className="text-xs opacity-60 mt-0.5">{c.band}</div>
    </div>
  );
}

function prettyGoal(slug: string | null | undefined): string {
  if (!slug) return "your goal";
  const map: Record<string, string> = {
    neet_prep: "NEET",
    jee_prep: "JEE Main",
    cat_prep: "CAT",
    upsc_prep: "UPSC",
    bank_exams: "Bank exams",
    class10_boards: "Class 10 Boards",
    class_10_boards: "Class 10 Boards",
    class12_boards: "Class 12 Boards",
    class_12_boards: "Class 12 Boards",
    class5_8: "Class 5–8",
    class_5_8: "Class 5–8",
    class_9: "Class 9",
    exploring: "general study",
  };
  return map[slug] ?? slug;
}

function PitchAction({ action }: { action: UpgradeAction }) {
  return (
    <div className="rounded-lg p-3 flex items-start gap-3"
         style={{ background: "rgba(255,255,255,0.6)", border: "1px solid rgba(0,0,0,0.06)" }}>
      <div className="rounded-full px-2 py-0.5 text-xs font-semibold capitalize flex-shrink-0 mt-0.5"
           style={{ background: "rgba(99,102,241,0.12)", color: "#6366f1" }}>
        {BLOOM_LABEL[action.level] ?? action.level}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium leading-snug">{action.action}</div>
        <div className="text-xs opacity-60 mt-0.5">{action.weeklyTime}</div>
      </div>
      <div className="text-sm font-bold flex-shrink-0" style={{ color: "#10b981" }}>
        {action.scoreLift}
      </div>
    </div>
  );
}

/**
 * Same shape as PitchAction but with a per-row Start button — used in the
 * paid-tier active-path tracker. Routes to the practice page targeted at
 * the action's Bloom level via query string so the existing practice flow
 * picks it up.
 */
function ActiveAction({ action, actionTopic, weekCount }: {
  action: UpgradeAction;
  actionTopic: string;
  weekCount: number;
}) {
  // Visualise weekly progress with a row of 3 dots (each Bloom action targets
  // ~3 drills/week as a baseline — beyond that they’re overshooting).
  const dotsTarget = 3;
  const dotsFilled = Math.min(weekCount, dotsTarget);
  return (
    <Link
      href={`/student/practice?bloom=${action.level}&topic=${encodeURIComponent(actionTopic)}&auto=1`}
      className="rounded-lg p-3 flex items-start gap-3 transition-all hover:scale-[1.01]"
      style={{ background: "rgba(255,255,255,0.7)", border: "1px solid rgba(16,185,129,0.25)" }}
    >
      <div className="rounded-full px-2 py-0.5 text-xs font-semibold capitalize flex-shrink-0 mt-0.5"
           style={{ background: "rgba(16,185,129,0.12)", color: "#10b981" }}>
        {BLOOM_LABEL[action.level] ?? action.level}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium leading-snug">{action.action}</div>
        <div className="text-xs opacity-60 mt-0.5 flex items-center gap-2">
          <span>{action.weeklyTime} · {action.scoreLift}</span>
          <span className="inline-flex gap-0.5 ml-1">
            {Array.from({ length: dotsTarget }).map((_, i) => (
              <span
                key={i}
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: i < dotsFilled ? "#10b981" : "rgba(0,0,0,0.15)" }}
              />
            ))}
            <span className="ml-1 opacity-70">{weekCount}/{dotsTarget} this week</span>
          </span>
        </div>
      </div>
      <div className="flex-shrink-0 inline-flex items-center gap-1 text-xs font-semibold rounded-full px-2.5 py-1"
           style={{ background: "#10b981", color: "white" }}>
        <PlayCircle size={12} /> Start
      </div>
    </Link>
  );
}

function weeklyTotalThisWeek(byBloom: Record<string, number>): number {
  return Object.values(byBloom).reduce((a, b) => a + b, 0);
}
