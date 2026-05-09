"use client";

// =============================================================================
// components/BloomIQScoreBadge.tsx
// -----------------------------------------------------------------------------
// Persistent top-right score chip for the student layout. Shows the 3-digit
// BloomIQ Score plus the day-over-day delta arrow, or a "Get your BloomIQ"
// CTA when the user hasn't calibrated yet. Tapping it opens /student/future
// (the reveal screen) when calibrated, or /student/bloom-score (the
// calibration intro) when not.
//
// The fetch is fire-and-forget on mount and cached in a module-level
// variable for the rest of the session — the badge sits in the layout, so
// every navigation re-mounts it; without this cache the GET would fire on
// every page change. Refreshes when the window regains focus (so a quiz
// completion in another tab updates the badge).
// =============================================================================

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sparkles, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";

type ScoreState = {
  has_calibration: boolean;
  score: number | null;
  rank_label: string | null;
  delta: number;
};

let cached: ScoreState | null = null;
let cachedAt: number = 0;
const CACHE_MS = 60_000; // 1 minute — short enough that score moves feel live

async function fetchScore(): Promise<ScoreState | null> {
  const sb = supabaseBrowser();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return null;
  const r = await fetch("/api/student/score", {
    headers: { Authorization: `Bearer ${session.access_token}` },
    cache: "no-store",
  });
  if (!r.ok) return null;
  const data = await r.json() as {
    ok: boolean;
    has_calibration: boolean;
    score: number | null;
    rank_label: string | null;
    trend?: { delta: number };
  };
  if (!data?.ok) return null;
  return {
    has_calibration: !!data.has_calibration,
    score: typeof data.score === "number" ? data.score : null,
    rank_label: data.rank_label || null,
    delta: typeof data.trend?.delta === "number" ? data.trend.delta : 0,
  };
}

export default function BloomIQScoreBadge() {
  const [state, setState] = useState<ScoreState | null>(cached);
  const [loading, setLoading] = useState<boolean>(!cached);

  useEffect(() => {
    let live = true;
    async function load(force = false) {
      if (!force && cached && Date.now() - cachedAt < CACHE_MS) {
        if (live) setState(cached);
        return;
      }
      const next = await fetchScore();
      if (!live) return;
      if (next) {
        cached = next;
        cachedAt = Date.now();
        setState(next);
      }
      setLoading(false);
    }
    void load();

    function onFocus() { void load(true); }
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (loading) {
    return (
      <div className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs"
           style={{ background: "rgba(0,0,0,0.04)" }}>
        <div className="w-3 h-3 rounded-full" style={{ background: "rgba(0,0,0,0.15)" }} />
        <span className="opacity-50">BloomIQ</span>
      </div>
    );
  }

  if (!state) return null;

  if (!state.has_calibration || state.score == null) {
    return (
      <Link
        href="/student/bloom-score"
        className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold transition-all hover:scale-[1.03]"
        style={{
          background: "linear-gradient(135deg, rgba(16,185,129,0.12) 0%, rgba(99,102,241,0.12) 100%)",
          color: "#6366f1",
          border: "1px solid rgba(99,102,241,0.3)",
        }}
      >
        <Sparkles size={12} /> Get your BloomIQ →
      </Link>
    );
  }

  const TrendIcon =
    state.delta > 0 ? TrendingUp : state.delta < 0 ? TrendingDown : Minus;
  const trendColor =
    state.delta > 0 ? "#10b981" : state.delta < 0 ? "#ef4444" : "rgba(0,0,0,0.4)";

  return (
    <Link
      href="/student/future"
      className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold transition-all hover:scale-[1.03]"
      style={{
        background: "linear-gradient(135deg, rgba(16,185,129,0.10) 0%, rgba(99,102,241,0.10) 100%)",
        border: "1px solid rgba(99,102,241,0.25)",
      }}
      title={state.rank_label ? `Predicted: ${state.rank_label}` : undefined}
    >
      <span className="opacity-60">BloomIQ</span>
      <span className="font-bold text-sm" style={{ color: "#6366f1" }}>
        {state.score}
      </span>
      <TrendIcon size={12} style={{ color: trendColor }} />
      {state.delta !== 0 ? (
        <span style={{ color: trendColor }}>
          {state.delta > 0 ? "+" : ""}{state.delta}
        </span>
      ) : null}
    </Link>
  );
}
