"use client";

import Link from "next/link";
import { Sparkles, TrendingUp, AlertCircle, ArrowRight, Trophy, Target } from "lucide-react";
import { BLOOM_LEVELS, BLOOM_META, type BloomLevel } from "@/lib/bloom";

/**
 * BloomHero
 *
 * The visual anchor at the top of the independent-student dashboard.
 * Polished horizontal-bar list, sorted strongest → weakest, with a
 * tier-coloured fill per row, count precision (X of Y), and a percentage
 * chip. Below: a strongest-level callout in green and a weakest-level
 * callout in amber with a "5 minutes on this drill could lift it" CTA
 * that routes to Misconception Detective.
 *
 * Why horizontal bars (not radar / pyramid / sunburst):
 *   - Bars are the most-readable comparison format for ordinal data.
 *     Radar requires the viewer to mentally reconstruct the shape;
 *     bars don't.
 *   - Sorting by mastery (instead of Bloom order) puts the weak levels
 *     at the bottom — exactly where the eye expects "things to fix" in
 *     a list.
 *   - The Bloom progression (Remember → Create) is shown via the
 *     callout band below, where it actually matters for the action.
 *
 * Empty state: render the six labelled rows with empty bars and "—"
 * percentages so the canvas teaches what BloomIQ is even before any
 * data exists — paired with a "Take a practice test" CTA below.
 */

type Mastery = Record<string, { correct: number; total: number }>;

// Tier-based colour palette. Sophisticated multi-stop gradients for a
// world-class look — not flat colour blocks. The bar fill, dot, and chip
// share a tier so the eye lands on weak rows before reading the number.
function tierFor(pct: number): {
  dot: string;
  text: string;
  chip: string;
  bar: string;
  glow: string;
} {
  if (pct >= 70) return {
    // Mastered — deep teal-emerald gradient, the "you've got this" tier.
    dot: "bg-emerald-500",
    text: "text-emerald-700",
    chip: "text-emerald-900",
    bar: "linear-gradient(90deg, #14b8a6 0%, #10b981 50%, #059669 100%)",
    glow: "rgba(16, 185, 129, 0.25)",
  };
  if (pct >= 50) return {
    // Working on it — warm amber-orange, neutral-positive.
    dot: "bg-amber-500",
    text: "text-amber-700",
    chip: "text-amber-900",
    bar: "linear-gradient(90deg, #fbbf24 0%, #f59e0b 50%, #d97706 100%)",
    glow: "rgba(245, 158, 11, 0.25)",
  };
  if (pct > 0)   return {
    // Needs work — rose-red, urgent but not aggressive.
    dot: "bg-rose-500",
    text: "text-rose-700",
    chip: "text-rose-900",
    bar: "linear-gradient(90deg, #fb7185 0%, #f43f5e 50%, #e11d48 100%)",
    glow: "rgba(244, 63, 94, 0.25)",
  };
  return {
    dot: "bg-slate-300",
    text: "text-slate-500",
    chip: "text-slate-500",
    bar: "linear-gradient(90deg, #cbd5e1 0%, #94a3b8 100%)",
    glow: "transparent",
  };
}

type LevelRow = {
  level: BloomLevel;
  label: string;
  pct: number;
  total: number;
  hasData: boolean;
};

function rowsFromMastery(mastery: Mastery): LevelRow[] {
  return BLOOM_LEVELS.map((lvl) => {
    const d = mastery[lvl];
    const total = d?.total || 0;
    const correct = d?.correct || 0;
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
    return {
      level: lvl,
      label: BLOOM_META[lvl].label,
      pct,
      total,
      hasData: total > 0,
    };
  });
}

export default function BloomHero({ mastery }: { mastery: Mastery }) {
  const rows = rowsFromMastery(mastery);
  const withData = rows.filter((r) => r.hasData);
  const hasAny = withData.length > 0;

  // Pick strongest + weakest only among levels that have actual data, so we
  // don't say "Your weakest is Create (0%)" when they've simply never taken
  // a Create-level question.
  const sorted = [...withData].sort((a, b) => b.pct - a.pct);
  const strongest = sorted[0] || null;
  const weakest = sorted[sorted.length - 1] || null;

  // Display order — strongest first when there's data so weak levels
  // sit at the bottom (where the eye expects "things to fix"), default
  // Bloom order when empty so the labels still teach the six levels.
  const displayRows = hasAny ? sorted : rows;

  return (
    <section
      className="relative mt-4 overflow-hidden rounded-2xl"
      style={{
        // Layered background: soft gradient mesh + crisp inner border
        // ring gives the card depth without a heavy shadow. CSS vars
        // respect dark / theme modes via the existing theme stack.
        background:
          "linear-gradient(135deg, color-mix(in oklab, var(--brand-100, #d1fae5) 35%, var(--color-card, #fff)) 0%, var(--color-card, #fff) 55%, color-mix(in oklab, #ede9fe 25%, var(--color-card, #fff)) 100%)",
        boxShadow:
          "0 1px 0 rgba(255,255,255,0.6) inset, 0 0 0 1px var(--color-border, #e2e8f0), 0 10px 30px -10px rgba(15,23,42,0.08)",
      }}
    >
      {/* Decorative gradient orb — top-right ambient color glow.
          Pure decoration; pointer-events disabled so it doesn't catch
          clicks. Adds the "premium dashboard" feel without competing
          for attention with the data. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-16 -right-16 w-56 h-56 rounded-full blur-3xl opacity-60"
        style={{
          background:
            "radial-gradient(closest-side, rgba(16,185,129,0.35), rgba(167,139,250,0.18) 60%, transparent 80%)",
        }}
      />
      {/* Second smaller orb — bottom-left, cooler tone — for depth. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-20 -left-10 w-48 h-48 rounded-full blur-3xl opacity-50"
        style={{
          background:
            "radial-gradient(closest-side, rgba(56,189,248,0.25), transparent 75%)",
        }}
      />

      <div className="relative p-6">
        {/* Header — eyebrow + title + subtitle on the left, "See full
            breakdown →" on the right. */}
        <div className="flex items-start justify-between gap-3 flex-wrap mb-5">
          <div>
            <div className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] font-bold px-2.5 py-1 rounded-full"
              style={{
                background: "color-mix(in oklab, var(--brand-100, #d1fae5) 70%, transparent)",
                color: "var(--brand-700, #047857)",
                border: "1px solid color-mix(in oklab, var(--brand-300, #6ee7b7) 60%, transparent)",
              }}
            >
              <Sparkles size={11} /> Your thinking right now
            </div>
            <h2 className="text-xl font-bold mt-2 tracking-tight">Bloom-level mastery</h2>
            <p className="text-xs muted mt-1 max-w-md">
              Sorted strongest to weakest. The bar shows how often you get that
              level of question right; the dotted line is the 70% mastery target.
            </p>
          </div>
          <Link
            href="/student/progress"
            className="text-xs hover:underline font-semibold inline-flex items-center gap-1 shrink-0 px-3 py-1.5 rounded-full transition"
            style={{
              color: "var(--brand-700, #047857)",
              background: "color-mix(in oklab, var(--color-card, #fff) 70%, transparent)",
              border: "1px solid var(--color-border, #e2e8f0)",
            }}
          >
            See full breakdown <ArrowRight size={12} />
          </Link>
        </div>

        {/* Bar list — each row a polished horizontal bar with gradient
            fill, glow on the strongest, and floating value chip. */}
        <div className="space-y-2.5">
          {displayRows.map((r, i) => {
            const t = tierFor(r.hasData ? r.pct : 0);
            const isTopRow = hasAny && i === 0;
            const isBottomRow = hasAny && i === displayRows.length - 1 && displayRows.length > 1;
            return (
              <div
                key={r.level}
                className="grid items-center gap-3 group transition"
                style={{ gridTemplateColumns: "auto 7.5rem 1fr auto auto" }}
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${t.dot}`} />

                <div className={`text-sm font-semibold flex items-center gap-1.5 ${t.text}`}>
                  {isTopRow && <Trophy size={13} className="text-emerald-600 shrink-0" />}
                  {isBottomRow && <Target size={13} className="text-rose-500 shrink-0" />}
                  <span className="truncate">{r.label}</span>
                </div>

                {/* Bar — translucent track with gradient fill on top.
                    Subtle inner shadow on the track gives a glassy feel
                    without being noisy. Glow ring on the strongest row. */}
                <div
                  className="relative h-3 rounded-full overflow-hidden"
                  style={{
                    background:
                      "color-mix(in oklab, var(--color-bg-soft, #f1f5f9) 80%, transparent)",
                    boxShadow:
                      "inset 0 1px 2px rgba(15,23,42,0.06), 0 0 0 1px rgba(15,23,42,0.04)",
                  }}
                >
                  {/* 70% target — dashed vertical guide */}
                  {hasAny && (
                    <div
                      className="absolute inset-y-0 w-px"
                      style={{
                        left: "70%",
                        background:
                          "repeating-linear-gradient(to bottom, rgba(15,23,42,0.25) 0 2px, transparent 2px 4px)",
                      }}
                      aria-hidden
                    />
                  )}
                  {r.hasData && (
                    <div
                      className="absolute inset-y-0 left-0 rounded-full transition-all duration-700 ease-out"
                      style={{
                        width: `${r.pct}%`,
                        background: t.bar,
                        boxShadow: isTopRow
                          ? `0 0 12px ${t.glow}, 0 1px 0 rgba(255,255,255,0.4) inset`
                          : "0 1px 0 rgba(255,255,255,0.4) inset",
                      }}
                      aria-hidden
                    />
                  )}
                </div>

                {/* X / Y precision count, hidden on narrow viewports. */}
                <span className="text-[10px] muted tabular-nums shrink-0 hidden sm:block">
                  {r.hasData ? `${Math.round((r.pct / 100) * r.total)}/${r.total}` : ""}
                </span>

                {/* Floating glass-styled percentage chip — the high-
                    contrast end of the row, where the eye lands. Uses
                    the chip text colour from tierFor; the background is
                    a translucent neutral so it works on any theme. */}
                <span
                  className={`text-xs font-bold tabular-nums px-2.5 py-0.5 rounded-full shrink-0 ${t.chip}`}
                  style={{
                    background: "color-mix(in oklab, var(--color-card, #fff) 80%, transparent)",
                    border: "1px solid var(--color-border, #e2e8f0)",
                    boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
                  }}
                >
                  {r.hasData ? `${r.pct}%` : "—"}
                </span>
              </div>
            );
          })}
        </div>

        {hasAny && (
          <div className="text-[10px] muted mt-3 flex items-center gap-1.5">
            <span
              className="inline-block w-3 h-px"
              style={{
                background:
                  "repeating-linear-gradient(to right, rgba(15,23,42,0.4) 0 2px, transparent 2px 4px)",
              }}
              aria-hidden
            />
            70% mastery target
          </div>
        )}

        {/* Callout band — strongest in green, weakest in amber, with a
            CTA. Lives INSIDE the p-6 wrapper so spacing matches the
            rest of the card content. */}
        {hasAny ? (
          <div className="mt-5 grid sm:grid-cols-2 gap-2">
            {strongest && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 flex items-center gap-2">
                <TrendingUp size={16} className="text-emerald-700 shrink-0" />
                <div className="text-xs">
                  <span className="text-emerald-900/70">Strongest:</span>{" "}
                  <strong className="text-emerald-900">{strongest.label}</strong>{" "}
                  <span className="text-emerald-900/70">({strongest.pct}%)</span>
                </div>
              </div>
            )}
            {weakest && weakest.level !== strongest?.level && (
              <Link
                href="/student/misconceptions"
                className="rounded-lg border border-amber-200 bg-amber-50 hover:bg-amber-100 transition px-3 py-2 flex items-center gap-2"
              >
                <AlertCircle size={16} className="text-amber-700 shrink-0" />
                <div className="text-xs flex-1">
                  <span className="text-amber-900/70">Weakest:</span>{" "}
                  <strong className="text-amber-900">{weakest.label}</strong>{" "}
                  <span className="text-amber-900/70">({weakest.pct}%)</span>
                  <div className="text-[11px] text-amber-900/70 mt-0.5 italic">
                    5 minutes on this drill could lift it.
                  </div>
                </div>
                <span className="text-xs text-amber-700 font-semibold inline-flex items-center gap-1">
                  Drill it <ArrowRight size={12} />
                </span>
              </Link>
            )}
          </div>
        ) : (
          // Empty state — six grey bars stay rendered above; this CTA is the
          // only call to action on the dashboard for a brand-new student.
          <Link
            href="/student/generate"
            className="mt-5 inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 transition px-4 py-2.5 text-sm font-semibold text-emerald-900"
          >
            Take your first practice test to see your profile <ArrowRight size={14} />
          </Link>
        )}
      </div>
    </section>
  );
}
