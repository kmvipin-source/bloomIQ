"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Layers, Users, AlertCircle, CheckCircle2, Pencil, GitBranch, Copy, ShieldAlert, ArrowRight } from "lucide-react";
import type { Plan } from "@/lib/types";
import { FEATURES_BY_KEY } from "@/lib/features";

/**
 * /admin/plans
 *
 * Flat catalogue of every live SKU (status='active'). Post-migration-43,
 * every change goes through the proposal queue at /admin/plans/queue.
 *
 *   - Card click → /admin/plans/[id]/edit, which builds a kind='edit'
 *     proposal and routes the user to the queue detail page.
 *   - Each card has a "Clone" affordance → /admin/plans/new?clone=<id>
 *     to model a new variant (e.g., Monthly → Quarterly).
 *   - "+ New SKU" creates from scratch.
 *   - "View queue" surfaces pending proposals with a count badge.
 *
 * Existing-subscriber semantics (unchanged from the edit-in-place era,
 * still apply once a proposal is approved):
 *   - new signups + renewals see the new price + features
 *   - existing subscribers keep their locked price till expires_at
 *   - existing subscribers see the new features (live, no migration)
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
  // Per-student rates here are illustrative anchors only — the
  // authoritative price lives on each plan card (read from the DB).
  // We say "from ₹X" so the heading communicates positioning without
  // duplicating the SKU's actual price (which a platform admin can
  // edit via the proposal queue without anyone needing to chase
  // this hardcoded label). Updated post-migration-61 when the
  // pricing ladder was inverted from volume-based to feature-based.
  school_pilot:     { label: "School Pilot",    tagline: "Entry tier, basic features. From ₹29/student/yr" },
  school_standard:  { label: "School Standard", tagline: "Adds Coach, exports, weekly digest. From ₹49/student/yr" },
  school_plus:      { label: "School Plus",     tagline: "Premium AI suite + dedicated CSM. From ₹69/student/yr" },
};

const TIER_ORDER = ["free", "premium", "premium_plus", "school_pilot", "school_standard", "school_plus"];

export default function PlansPage() {
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [openProposalCount, setOpenProposalCount] = useState<number>(0);
  // Proposals specifically AWAITING the current admin's approval — i.e.,
  // status='open' and created by someone other than me. Drives the hero
  // banner so an admin lands on /admin/plans and immediately sees if
  // there's a queue to clear before doing catalogue work.
  const [forMeCount, setForMeCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { session } } = await sb.auth.getSession();
        if (!session) throw new Error("Not signed in.");
        const headers = { Authorization: `Bearer ${session.access_token}` };

        const [r, rOpen, rForMe] = await Promise.all([
          fetch("/api/admin/plans", { headers }),
          fetch("/api/admin/plan-proposals?status=open", { headers }),
          fetch("/api/admin/plan-proposals?scope=for_me", { headers }),
        ]);
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error || "Could not load plans.");
        setPlans(j.plans || []);

        if (rOpen.ok) {
          const jOpen = await rOpen.json();
          setOpenProposalCount((jOpen.proposals || []).length);
        }
        if (rForMe.ok) {
          const jForMe = await rForMe.json();
          setForMeCount((jForMe.proposals || []).length);
        }
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
      <FreeTrialSettings />

      <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
        <h1 className="h1 flex items-center gap-2"><Layers size={28} /> Plan catalogue</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            href="/admin/plans/queue"
            className="btn btn-secondary text-sm inline-flex items-center gap-2"
          >
            <GitBranch size={14} /> View queue
            {openProposalCount > 0 && (
              <span
                className="text-[10px] font-bold rounded-full px-1.5 py-0.5"
                style={{ background: "var(--brand-600)", color: "white" }}
              >
                {openProposalCount}
              </span>
            )}
          </Link>
          <Link href="/admin/plans/new" className="btn btn-secondary text-sm">+ New SKU</Link>
        </div>
      </div>
      <p className="muted text-sm mb-6 max-w-2xl">
        These are the live SKUs you sell. Every change — edit, clone, or new SKU — flows through
        the <Link href="/admin/plans/queue" className="font-semibold underline">proposal queue</Link>{" "}
        for two-eyes review before it lands.
      </p>

      {/* Pending-proposals hero — surfaces unfinished review work BEFORE
          the catalogue, so an admin lands here and sees the queue first.
          Three render states:
            - forMeCount > 0: amber-orange "N proposals awaiting you" with
              direct link to the Awaiting tab. The high-leverage default.
            - forMeCount === 0 && openProposalCount > 0: muted note about
              other admins' open drafts (we're not blocking them, but it's
              worth knowing).
            - both zero: hero hidden entirely (no clutter when the queue
              is empty).
          Phase 2 Item #5 — replicates the BloomHero "first-thing-seen"
          pattern from the student dashboard to the admin catalogue. */}
      {!loading && forMeCount > 0 && (
        <Link
          href="/admin/plans/queue?tab=for_me"
          className="card mb-6 flex items-center gap-3 hover:opacity-90 transition"
          style={{
            background: "color-mix(in oklab, #fef3c7 65%, transparent)",
            borderColor: "#f59e0b",
            borderLeft: "4px solid #f59e0b",
          }}
        >
          <ShieldAlert size={20} style={{ color: "#a07700" }} className="shrink-0" />
          <div className="flex-1">
            <div className="text-sm font-bold" style={{ color: "#7c5400" }}>
              {forMeCount} proposal{forMeCount === 1 ? "" : "s"} awaiting your approval
            </div>
            <div className="text-xs" style={{ color: "#a07700" }}>
              Two-eyes principle: another admin needs you to review their draft before it can land.
            </div>
          </div>
          <span className="text-sm font-semibold inline-flex items-center gap-1" style={{ color: "#7c5400" }}>
            Review now <ArrowRight size={14} />
          </span>
        </Link>
      )}
      {!loading && forMeCount === 0 && openProposalCount > 0 && (
        <div
          className="text-xs muted mb-6 inline-flex items-center gap-2 px-3 py-2 rounded-lg"
          style={{ background: "var(--color-bg-soft)", border: "1px solid var(--color-border)" }}
        >
          <GitBranch size={12} />
          <span>
            {openProposalCount} open proposal{openProposalCount === 1 ? "" : "s"} in the queue (none waiting on you).
          </span>
        </div>
      )}

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
                    <div
                      key={p.id}
                      className="card card-hover relative"
                    >
                      {/*
                        Edit + Clone are explicit buttons in the header.
                        Earlier this card used a stretched-link "click anywhere
                        to edit" pattern, but the link was z-0 and the content
                        z-10 so clicks landed on the higher-z content and
                        nothing navigated. Replaced with explicit text buttons
                        in 2026-05-10's polish pass. Each goes through the
                        proposal queue (kind='edit' or 'create') by way of the
                        target page.
                      */}
                      <header className="flex items-start justify-between gap-3 flex-wrap">
                        <div>
                          <div className="text-[11px] muted font-mono">{p.slug}</div>
                          <div className="text-lg font-bold">{p.label}</div>
                          {p.blurb && <div className="text-xs muted mt-0.5">{p.blurb}</div>}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Link
                            href={`/admin/plans/${p.id}/edit`}
                            className="text-xs font-semibold px-2.5 py-1 rounded inline-flex items-center gap-1"
                            style={{ color: "#fff", background: "var(--brand-700)", border: "1px solid var(--brand-700)" }}
                            title="Propose changes to this SKU (price, features, etc.)"
                          >
                            <Pencil size={11} /> Edit
                          </Link>
                          <Link
                            href={`/admin/plans/new?clone=${p.id}`}
                            className="text-xs font-semibold px-2 py-1 rounded inline-flex items-center gap-1"
                            style={{ color: "var(--brand-700)", background: "var(--color-bg-soft)", border: "1px solid var(--color-border)" }}
                            title="Clone this SKU as a starting point for a new variant"
                          >
                            <Copy size={11} /> Clone
                          </Link>
                        </div>
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
                        className="mt-4 group relative z-10"
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
                    </div>
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


// ─────────────────────────────────────────────────────────────────────────────
// Free trial duration setting — small admin-only control.
// Reads/writes subscription_limits.free_trial_days via /api/admin/free-trial-
// settings. Setting > 0 enables auto-granted Premium trials for every new
// independent student on first sign-in.
// ─────────────────────────────────────────────────────────────────────────────

function FreeTrialSettings() {
  const [days, setDays] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return;
        const r = await fetch("/api/admin/free-trial-settings", {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: "no-store",
        });
        if (!r.ok) return;
        const j = await r.json() as { ok?: boolean; free_trial_days?: number };
        if (j?.ok) setDays(j.free_trial_days ?? 0);
      } catch { /* silent — admin setting just stays hidden on failure */ }
    })();
  }, []);

  async function save() {
    if (days == null) return;
    if (!Number.isFinite(days) || days < 0 || days > 90) {
      setMsg("Must be an integer between 0 and 90.");
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const r = await fetch("/api/admin/free-trial-settings", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ free_trial_days: days }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Save failed");
      setMsg(days === 0 ? "Saved — Free plan is now permanent (no expiry)" : `Saved — new students get Free for ${days} days, then locked out until upgrade`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (days == null) return null;

  return (
    <div className="card mb-6 p-5"
         style={{ background: "rgba(99,102,241,0.04)", borderColor: "rgba(99,102,241,0.25)" }}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-xs uppercase tracking-wider font-semibold mb-1"
               style={{ color: "#6366f1" }}>
            Free plan validity — new student sign-ups
          </div>
          <h3 className="text-base font-bold">Auto-expire Free plan after N days</h3>
          <p className="text-xs opacity-80 mt-1 max-w-lg leading-relaxed">
            Every new independent student gets the Free plan (3 drills/day) for N days,
            then is locked out and prompted to upgrade. Set to 0 for permanent Free. Capped at 90 days.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <input
            type="number"
            min={0}
            max={90}
            value={days}
            onChange={(e) => setDays(Math.max(0, Math.min(90, parseInt(e.target.value || "0", 10) || 0)))}
            className="input w-24 text-center"
          />
          <span className="text-xs opacity-70">days</span>
          <button
            onClick={save}
            disabled={saving}
            className="btn btn-primary disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      {msg ? (
        <p className="text-xs mt-2 opacity-80">{msg}</p>
      ) : null}
    </div>
  );
}