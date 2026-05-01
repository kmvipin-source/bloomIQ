"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Layers, Users, AlertCircle, CheckCircle2, Pencil } from "lucide-react";
import type { Plan } from "@/lib/types";
import { FEATURES_BY_KEY } from "@/lib/features";

/**
 * /admin/plans
 *
 * Flat catalogue of every SKU. Post-migration-30 there are exactly as
 * many rows as there are products you sell — no versions, no drafts,
 * no archived snapshots. The seeded set is 8: Free + Premium Monthly /
 * Annual + Premium Plus Monthly / Annual + 3 school tiers.
 *
 * Click any card → /admin/plans/[id]/edit, where you change price /
 * features / blurb in place. Saving immediately:
 *   - shows the new price + features at /pricing for new signups
 *   - gives existing subscribers the new features (live, no migration)
 *   - keeps existing subscribers' price locked at what they paid for
 *     this term (subscriptions.price_paid_paise stays put till renewal)
 *
 * If you ever genuinely need a brand-new SKU (e.g., adding a Quarterly
 * billing period), use the "+ New SKU" button — but the bar is high.
 * Most "I want to change something" cases are EDITS to the 8 stable
 * rows, not new ones.
 */

type PlanRow = Plan & { active_subscriber_count: number };

function rupees(paise: number): string {
  if (paise === 0) return "₹0";
  if (paise % 100 === 0) return `₹${(paise / 100).toLocaleString("en-IN")}`;
  return `₹${(paise / 100).toFixed(2)}`;
}

function periodLabel(days: number): string {
  if (days === 0) return "free";
  if (days <= 31) return "/month";
  if (days >= 360 && days <= 366) return "/year";
  return ` /${days}d`;
}

const TIER_META: Record<string, { label: string; tagline: string }> = {
  free:             { label: "Free",          tagline: "Anonymous + lightly-engaged users" },
  premium:          { label: "Premium",       tagline: "Individual paying subscribers" },
  premium_plus:     { label: "Premium Plus",  tagline: "Premium + competitive-exam toolkit" },
  school_pilot:     { label: "School Pilot",  tagline: "Small schools, ₹49/student/yr" },
  school_standard:  { label: "School Standard", tagline: "Mid-size schools, ₹39/student/yr" },
  school_plus:      { label: "School Plus",   tagline: "Large schools, ₹29/student/yr" },
};

const TIER_ORDER = ["free", "premium", "premium_plus", "school_pilot", "school_standard", "school_plus"];

export default function PlansPage() {
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { session } } = await sb.auth.getSession();
        if (!session) throw new Error("Not signed in.");
        const r = await fetch("/api/admin/plans", {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error || "Could not load plans.");
        setPlans(j.plans || []);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not load plans.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Group by tier in a stable order, so the page shows
  // Free / Premium / Premium Plus / school tiers from top to bottom
  // regardless of insert order in the DB.
  const grouped = TIER_ORDER
    .map((t) => ({ tier: t, plans: plans.filter((p) => p.tier === t) }))
    .filter((g) => g.plans.length > 0);

  return (
    <div className="fade-in">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
        <h1 className="h1 flex items-center gap-2"><Layers size={28} /> Plan catalogue</h1>
        <Link href="/admin/plans/new" className="btn btn-secondary text-sm">+ New SKU</Link>
      </div>
      <p className="muted text-sm mb-6 max-w-2xl">
        These are the SKUs you sell. <strong>Edit in place</strong> — saving updates
        the price + features immediately. Existing subscribers keep their{" "}
        <em>price</em> locked till their term renews, but they get any new{" "}
        <em>features</em> live.
      </p>

      {loading ? (
        <div className="card text-center py-8"><span className="spinner" /></div>
      ) : err ? (
        <div className="card text-sm text-red-700 bg-red-50 border-red-200 flex items-start gap-2">
          <AlertCircle size={16} className="mt-0.5 shrink-0" /> {err}
        </div>
      ) : plans.length === 0 ? (
        <div className="card text-center py-8 muted text-sm">
          No plans yet. Did you run migrations 26 and 28? Check{" "}
          <code>supabase/migrations/26_seed_initial_plans.sql</code>.
        </div>
      ) : (
        <div className="space-y-8">
          {grouped.map((g) => {
            const meta = TIER_META[g.tier] || { label: g.tier, tagline: "" };
            return (
              <section key={g.tier}>
                <header className="mb-3">
                  <h2 className="text-sm font-bold uppercase tracking-wide" style={{ color: "var(--color-fg-soft)" }}>
                    {meta.label}
                  </h2>
                  {meta.tagline && <p className="text-xs muted">{meta.tagline}</p>}
                </header>
                <div className="grid lg:grid-cols-2 gap-3">
                  {g.plans.map((p) => (
                    <Link
                      key={p.id}
                      href={`/admin/plans/${p.id}/edit`}
                      className="card card-hover block"
                    >
                      <header className="flex items-start justify-between gap-3 flex-wrap">
                        <div>
                          <div className="text-[11px] muted font-mono">{p.slug}</div>
                          <div className="text-lg font-bold">{p.label}</div>
                          {p.blurb && <div className="text-xs muted mt-0.5">{p.blurb}</div>}
                        </div>
                        <Pencil size={14} className="muted shrink-0 mt-1" />
                      </header>

                      <div className="flex items-baseline gap-2 mt-3">
                        {p.pricing_model === "per_student" ? (
                          <>
                            <span className="text-2xl font-bold tabular-nums">{rupees(p.per_student_price_paise || 0)}</span>
                            <span className="text-xs muted">/ student / year</span>
                          </>
                        ) : (
                          <>
                            <span className="text-2xl font-bold tabular-nums">{rupees(p.price_paise)}</span>
                            <span className="text-xs muted">{periodLabel(p.period_days)}</span>
                          </>
                        )}
                      </div>

                      <div className="mt-2 inline-flex items-center gap-1.5 text-xs rounded-full px-2 py-0.5"
                           style={{ background: "var(--color-bg-soft)", color: "var(--color-fg-soft)", border: "1px solid var(--color-border)" }}>
                        <Users size={12} /> {p.active_subscriber_count} active subscriber{p.active_subscriber_count === 1 ? "" : "s"}
                      </div>

                      <details
                        className="mt-4 group"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <summary className="cursor-pointer text-xs font-semibold" style={{ color: "var(--color-fg-soft)" }}>
                          {p.features.length} feature{p.features.length === 1 ? "" : "s"} — click to expand
                        </summary>
                        <ul className="mt-2 space-y-1 text-xs">
                          {p.features.map((k) => {
                            const meta = FEATURES_BY_KEY[k];
                            return (
                              <li key={k} className="flex items-start gap-1.5">
                                <CheckCircle2 size={12} style={{ color: "var(--brand-600)" }} className="mt-0.5 shrink-0" />
                                <span>
                                  {meta ? (
                                    <>
                                      <strong>{meta.label}</strong>
                                      <span className="muted"> — {meta.description}</span>
                                    </>
                                  ) : (
                                    <span className="muted">unknown key: {k}</span>
                                  )}
                                </span>
                              </li>
                            );
                          })}
                          {p.features.length === 0 && <li className="muted">No features.</li>}
                        </ul>
                      </details>
                    </Link>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <div className="card mt-8 text-xs muted leading-relaxed" style={{ background: "var(--color-bg-soft)" }}>
        <strong style={{ color: "var(--color-fg)" }}>How edits flow:</strong> price changes only affect
        new signups + renewals — existing subscribers keep their locked price till{" "}
        <code>expires_at</code>. Feature changes apply to <em>everyone</em> immediately, so adding a
        new feature is a free upgrade for current subscribers (loved by users; you can&apos;t take it
        back without complaints). Removing a feature is the dangerous direction — never do it without
        a clear migration plan.
      </div>
    </div>
  );
}
