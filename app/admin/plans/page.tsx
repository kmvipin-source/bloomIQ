"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Layers, Users, AlertCircle, CheckCircle2, Clock, Archive, Tag } from "lucide-react";
import type { Plan, PlanStatus } from "@/lib/types";
import { FEATURES_BY_KEY } from "@/lib/features";

/**
 * /admin/plans
 *
 * Read-only catalogue of every subscription plan. This is the foundation
 * slice — the next session will add /admin/plans/new (create draft),
 * /admin/plans/[id]/edit, and the submit/approve workflow.
 *
 * Plans are grouped by tier, then within each tier shown in status order
 * (active → pending_review → draft → archived). Each card surfaces:
 *   - tier badge + status pill
 *   - label, slug, price, period
 *   - active subscriber count (only for status='active')
 *   - feature list (resolved against the registry in lib/features.ts)
 *   - audit metadata (created/approved at, by)
 */

type PlanRow = Plan & { active_subscriber_count: number };

const STATUS_BADGES: Record<PlanStatus, { label: string; class: string; Icon: typeof CheckCircle2 }> = {
  active: { label: "Active", class: "text-emerald-700 bg-emerald-50 border-emerald-200", Icon: CheckCircle2 },
  pending_review: { label: "Pending review", class: "text-amber-700 bg-amber-50 border-amber-200", Icon: Clock },
  draft: { label: "Draft", class: "text-slate-700 bg-slate-100 border-slate-200", Icon: Tag },
  archived: { label: "Archived", class: "text-slate-500 bg-slate-50 border-slate-200", Icon: Archive },
};

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

  // Group plans by tier so the page renders Free / Premium / Premium Plus
  // sections in a stable order.
  const tierOrder = ["free", "premium", "premium_plus", "school_pilot", "school_standard", "school_plus"];
  const grouped = tierOrder
    .map((t) => ({ tier: t, plans: plans.filter((p) => p.tier === t) }))
    .filter((g) => g.plans.length > 0);

  return (
    <div className="fade-in">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
        <h1 className="h1 flex items-center gap-2"><Layers size={28} /> Plans</h1>
        <a href="/admin/plans/new" className="btn btn-primary text-sm">+ New plan</a>
      </div>
      <p className="muted text-sm mb-6">
        Versioned plan catalogue. Existing subscribers stay on their grandfathered version;
        new subscribers from each plan&apos;s effective date forward bind to the latest active
        version of that slug. Click any plan to view, clone, or (if draft) edit.
      </p>

      {loading ? (
        <div className="card text-center py-8"><span className="spinner" /></div>
      ) : err ? (
        <div className="card text-sm text-red-700 bg-red-50 border-red-200 flex items-start gap-2">
          <AlertCircle size={16} className="mt-0.5 shrink-0" /> {err}
        </div>
      ) : plans.length === 0 ? (
        <div className="card text-center py-8 muted text-sm">
          No plans yet. Did you run migration 26? Check{" "}
          <code>supabase/migrations/26_seed_initial_plans.sql</code>.
        </div>
      ) : (
        <div className="space-y-8">
          {grouped.map((g) => (
            <section key={g.tier}>
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500 mb-3">
                {g.tier.replace(/_/g, " ")}
              </h2>
              <div className="grid lg:grid-cols-2 gap-3">
                {g.plans.map((p) => {
                  const badge = STATUS_BADGES[p.status];
                  const BadgeIcon = badge.Icon;
                  return (
                    <a
                      key={p.id}
                      href={`/admin/plans/${p.id}/edit`}
                      className="card card-hover block"
                    >
                      <header className="flex items-start justify-between gap-3 flex-wrap">
                        <div>
                          <div className="text-xs muted font-mono">{p.slug}</div>
                          <div className="text-lg font-bold">{p.label}</div>
                          {p.blurb && <div className="text-xs muted mt-0.5">{p.blurb}</div>}
                        </div>
                        <span className={`inline-flex items-center gap-1 text-[10px] uppercase font-bold rounded-full border px-2 py-0.5 ${badge.class}`}>
                          <BadgeIcon size={10} /> {badge.label}
                        </span>
                      </header>

                      <div className="flex items-baseline gap-2 mt-3">
                        <span className="text-2xl font-bold">{rupees(p.price_paise)}</span>
                        <span className="text-xs muted">{periodLabel(p.period_days)}</span>
                      </div>

                      {p.status === "active" && (
                        <div className="mt-2 inline-flex items-center gap-1.5 text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-full px-2 py-0.5">
                          <Users size={12} /> {p.active_subscriber_count} active subscriber{p.active_subscriber_count === 1 ? "" : "s"}
                        </div>
                      )}

                      <details
                        className="mt-4 group"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <summary className="cursor-pointer text-xs font-semibold text-slate-700">
                          {p.features.length} feature{p.features.length === 1 ? "" : "s"} included — click to expand
                        </summary>
                        <ul className="mt-2 space-y-1 text-xs">
                          {p.features.map((k) => {
                            const meta = FEATURES_BY_KEY[k];
                            return (
                              <li key={k} className="flex items-start gap-1.5">
                                <CheckCircle2 size={12} className="text-emerald-600 mt-0.5 shrink-0" />
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

                      <div className="mt-4 grid grid-cols-2 gap-2 text-[11px] muted">
                        <div>
                          Effective from:{" "}
                          {p.effective_from ? new Date(p.effective_from).toLocaleDateString() : "—"}
                        </div>
                        <div>
                          Effective to:{" "}
                          {p.effective_to ? new Date(p.effective_to).toLocaleDateString() : "—"}
                        </div>
                      </div>
                    </a>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      <div className="card mt-8 bg-slate-50 border-slate-200 text-xs muted leading-relaxed">
        <strong className="text-slate-800">Coming next session:</strong> create / edit / submit /
        approve workflow, /pricing page reading from this catalogue, and feature-access
        gating throughout the app. This view is read-only for now.
      </div>
    </div>
  );
}
