"use client";
// F120 note (QA): if this badge supports a "dismiss" affordance for the
// calibration prompt, the dismissal should remember itself for ~7 days
// (localStorage key bloomiq:calib_dismissed_at). Today's behavior tends
// to re-prompt on every page load, which trains students to ignore it.
// Audit + adjust when the calibration UX is next touched.

// =============================================================================
// components/ZcoriqBloomScoreBadge.tsx
// -----------------------------------------------------------------------------
// Persistent top-right score chip for the student layout. Shows the 3-digit
// ZCORIQ Bloom Score plus the day-over-day delta arrow, or a "Get your ZCORIQ"
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

// User-keyed cache. Previously this was a single module-scope cache
// without a user id, so a sign-out → sign-in on the same tab briefly
// showed the previous user's score (and predicted rank tooltip) until
// the TTL expired. Keying by user id ensures the badge always reflects
// the currently-signed-in identity, and an auth state change clears
// stale entries.
const cacheByUser = new Map<string, { state: ScoreState; at: number }>();
const CACHE_MS = 60_000; // 1 minute — short enough that score moves feel live

async function fetchScore(): Promise<{ userId: string; state: ScoreState } | null> {
  const sb = supabaseBrowser();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return null;
  const userId = session.user?.id;
  if (!userId) return null;
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
    userId,
    state: {
      has_calibration: !!data.has_calibration,
      score: typeof data.score === "number" ? data.score : null,
      rank_label: data.rank_label || null,
      delta: typeof data.trend?.delta === "number" ? data.trend.delta : 0,
    },
  };
}

export default function ZcoriqBloomScoreBadge() {
  const [state, setState] = useState<ScoreState | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let live = true;
    let activeUserId: string | null = null;
    async function load(force = false) {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      const userId = session?.user?.id ?? null;
      activeUserId = userId;
      if (!userId) {
        if (live) { setState(null); setLoading(false); }
        return;
      }
      const hit = cacheByUser.get(userId);
      if (!force && hit && Date.now() - hit.at < CACHE_MS) {
        if (live) { setState(hit.state); setLoading(false); }
        return;
      }
      const next = await fetchScore();
      if (!live) return;
      // Discard the response if the active user changed mid-flight
      // (sign-in/out raced the fetch). Without this guard the badge
      // could surface a score belonging to whoever just signed out.
      if (next && next.userId === activeUserId) {
        cacheByUser.set(next.userId, { state: next.state, at: Date.now() });
        setState(next.state);
      }
      setLoading(false);
    }
    void load();

    function onFocus() { void load(true); }
    window.addEventListener("focus", onFocus);

    // Clear cache + state on sign-out so the next session starts clean.
    const sb = supabaseBrowser();
    const { data: authSub } = sb.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        cacheByUser.clear();
        if (live) { setState(null); setLoading(true); }
      } else if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        void load(true);
      }
    });

    return () => {
      live = false;
      window.removeEventListener("focus", onFocus);
      authSub?.subscription?.unsubscribe?.();
    };
  }, []);

  if (loading) {
    return (
      <div className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs"
           style={{ background: "rgba(0,0,0,0.04)" }}>
        <div className="w-3 h-3 rounded-full" style={{ background: "rgba(0,0,0,0.15)" }} />
        <span className="opacity-50">ZCORIQ</span>
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
        <Sparkles size={12} /> Get your ZCORIQ →
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
      <span className="opacity-60">ZCORIQ</span>
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
