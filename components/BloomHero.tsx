"use client";

import Link from "next/link";
import { Sparkles, TrendingUp, AlertCircle, ArrowRight } from "lucide-react";
import { BLOOM_LEVELS, BLOOM_META, type BloomLevel } from "@/lib/bloom";

/**
 * BloomHero
 *
 * The visual anchor at the top of the independent-student dashboard.
 * Six horizontal bars (one per Bloom level), each coloured by mastery %,
 * plus a strongest-level callout in green and a weakest-level callout in
 * amber that links to a relevant drill action. Replaces the "you have N
 * tests, X% average" stats card as the primary above-the-fold object.
 *
 * Empty state: if the student has no submitted attempts yet, we still
 * render the six labelled bars in grey with a single CTA — "Take a
 * practice test to see your thinking profile." This keeps the visual
 * present (so it teaches them what BloomIQ is) without faking data.
 *
 * Why bars and not a radar chart? Bars sort and rank cleanly, parents
 * understand them at a glance, and they don't need a chart library. The
 * radar chart still lives in components/BloomChart.tsx and gets used
 * inside /student/progress for the deep-dive view.
 */

type Mastery = Record<string, { correct: number; total: number }>;

function colorFor(pct: number): { bg: string; text: string; bar: string } {
  if (pct >= 70) return { bg: "bg-emerald-50",  text: "text-emerald-900", bar: "bg-emerald-500" };
  if (pct >= 50) return { bg: "bg-amber-50",    text: "text-amber-900",   bar: "bg-amber-500"   };
  if (pct > 0)   return { bg: "bg-red-50",      text: "text-red-900",     bar: "bg-red-500"     };
  // Untouched levels render in muted slate so they read as "no data yet"
  // rather than "you scored 0".
  return { bg: "bg-slate-50", text: "text-slate-500", bar: "bg-slate-300" };
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

  return (
    <section className="card mt-4">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <div>
          <div className="text-[10px] uppercase tracking-wider font-bold text-emerald-700 flex items-center gap-1">
            <Sparkles size={12} /> Your thinking right now
          </div>
          <h2 className="text-lg font-bold mt-0.5">Bloom-level mastery</h2>
        </div>
        <Link
          href="/student/progress"
          className="text-xs text-emerald-700 hover:underline font-semibold inline-flex items-center gap-1"
        >
          See full breakdown <ArrowRight size={12} />
        </Link>
      </div>

      <div className="space-y-2">
        {rows.map((r) => {
          const c = colorFor(r.hasData ? r.pct : 0);
          return (
            <div key={r.level} className="flex items-center gap-3">
              <div className={`text-xs font-semibold w-20 shrink-0 ${c.text}`}>
                {r.label}
              </div>
              <div className="relative flex-1 h-5 rounded-full bg-slate-100 overflow-hidden">
                {r.hasData && (
                  <div
                    className={`absolute inset-y-0 left-0 ${c.bar} rounded-full transition-all`}
                    style={{ width: `${r.pct}%` }}
                  />
                )}
              </div>
              <div className={`text-xs font-mono w-16 text-right shrink-0 ${c.text}`}>
                {r.hasData ? `${r.pct}%` : "—"}
              </div>
            </div>
          );
        })}
      </div>

      {/* Callout band — strongest in green, weakest in amber, with a CTA. */}
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
    </section>
  );
}
