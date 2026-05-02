"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { ArrowLeft, ArrowRight, AlertCircle, Info, GitBranch } from "lucide-react";
import {
  FEATURES_BY_CATEGORY,
  FEATURE_CATEGORY_ORDER,
  FEATURE_CATEGORY_LABELS,
} from "@/lib/features";
import type { Plan, PlanProposalPayload } from "@/lib/types";

/**
 * /admin/plans/new — propose a brand-new SKU.
 *
 * Submitting creates a kind='create' plan proposal (not a live plan row).
 * The proposal lands at /admin/plans/queue/[id] for review + approval.
 *
 * Two entry modes, distinguished by the `?clone=<plan_id>` query param:
 *
 *   - WITH clone= → "model from": fetch that plan and pre-fill every
 *     editable field. The user typically tweaks slug, period_days, and
 *     price_paise to spawn a new variant (e.g., "Premium Monthly" cloned
 *     into "Premium Quarterly" with period_days = 90 and a discounted
 *     price). The parent_plan_id is recorded on the proposal.
 *
 *   - WITHOUT clone= → "from scratch": all fields start at sensible
 *     defaults. parent_plan_id is null on the proposal.
 *
 * Slug + tier are immutable on the LIVE row post-creation (matching the
 * existing PUT route's behaviour) but the creator picks them here. The
 * approver can still tweak them via "edit and approve" before the row is
 * inserted.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/;

function NewPlanInner() {
  const router = useRouter();
  const search = useSearchParams();
  const cloneId = search.get("clone");

  const [parent, setParent] = useState<Plan | null>(null);
  const [loadingParent, setLoadingParent] = useState(!!cloneId);

  // Form state.
  const [slug, setSlug] = useState("");
  const [tier, setTier] = useState<PlanProposalPayload["tier"]>("premium");
  const [label, setLabel] = useState("");
  const [blurb, setBlurb] = useState("");
  const [featureSummary, setFeatureSummary] = useState<string[]>([]);
  const [pricePaise, setPricePaise] = useState(0);
  const [currency, setCurrency] = useState("INR");
  const [periodDays, setPeriodDays] = useState(30);
  const [features, setFeatures] = useState<Set<string>>(new Set());
  const [pricingModel, setPricingModel] = useState<"fixed" | "per_student">("fixed");
  const [perStudentRupees, setPerStudentRupees] = useState(0);
  const [minStudents, setMinStudents] = useState(0);
  const [maxStudents, setMaxStudents] = useState<number | null>(null);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Hydrate parent plan if cloning.
  useEffect(() => {
    if (!cloneId) return;
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { session } } = await sb.auth.getSession();
        if (!session) throw new Error("Not signed in.");
        const r = await fetch(`/api/admin/plans/${cloneId}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error || "Could not load template plan.");
        const p: Plan = j.plan;
        setParent(p);

        // Pre-fill from the parent. We deliberately DO NOT pre-fill `slug`
        // — the user must pick a new unique slug. We default `label` to a
        // hint reminding them this is a clone.
        setTier(p.tier as PlanProposalPayload["tier"]);
        setLabel(`${p.label} (variant)`);
        setBlurb(p.blurb || "");
        setFeatureSummary(p.feature_summary || []);
        setPricePaise(p.price_paise);
        setCurrency(p.currency);
        setPeriodDays(p.period_days);
        setFeatures(new Set(p.features || []));
        setPricingModel((p.pricing_model as "fixed" | "per_student") || "fixed");
        setPerStudentRupees((p.per_student_price_paise || 0) / 100);
        setMinStudents(p.min_students || 0);
        setMaxStudents(p.max_students ?? null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not load template.");
      } finally {
        setLoadingParent(false);
      }
    })();
  }, [cloneId]);

  function toggleFeature(key: string) {
    setFeatures((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);

    if (!slug.trim() || !SLUG_RE.test(slug.trim().toLowerCase())) {
      setErr("Slug must be lowercase letters, digits, hyphens, or underscores (2–64 chars).");
      return;
    }
    if (!label.trim()) {
      setErr("Display name is required.");
      return;
    }
    if (pricingModel === "per_student" && perStudentRupees <= 0) {
      setErr("Per-student rate must be greater than ₹0.");
      return;
    }

    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");

      const proposed: PlanProposalPayload = {
        slug: slug.trim().toLowerCase(),
        tier,
        label: label.trim(),
        blurb: blurb.trim() || null,
        feature_summary: featureSummary,
        price_paise: pricePaise,
        currency: currency.toUpperCase(),
        period_days: periodDays,
        features: Array.from(features),
        pricing_model: pricingModel,
        per_student_price_paise: Math.round(perStudentRupees * 100),
        min_students: minStudents,
        max_students: maxStudents,
        razorpay_plan_id: null,
      };

      const r = await fetch("/api/admin/plan-proposals", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          kind: "create",
          parent_plan_id: cloneId || null,
          proposed,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Could not submit proposal.");

      router.push(`/admin/plans/queue/${j.proposal.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Submit failed.");
      setBusy(false);
    }
  }

  if (loadingParent) {
    return <div className="card text-center py-8"><span className="spinner" /></div>;
  }

  return (
    <div className="max-w-3xl fade-in space-y-6">
      <Link
        href="/admin/plans"
        className="inline-flex items-center gap-1.5 text-sm font-medium muted hover:underline"
      >
        <ArrowLeft size={14} /> Back to catalogue
      </Link>

      <header>
        <h1 className="h1 mb-1">{parent ? "Clone SKU" : "New SKU"}</h1>
        {parent ? (
          <p className="muted text-sm flex items-center gap-2 flex-wrap">
            <GitBranch size={14} />
            Modeling from <strong>{parent.label}</strong>{" "}
            <code className="text-[11px]">{parent.slug}</code>. Adjust slug, period, and price as needed.
          </p>
        ) : (
          <p className="muted text-sm">
            Fill in the SKU details and submit for review. You can also clone an existing plan as a starting point — go back and click <em>Clone</em> on any card.
          </p>
        )}
      </header>

      <form onSubmit={submit} className="space-y-6">
        {/* IDENTITY ---------------------------------------------------- */}
        <section className="card space-y-4">
          <h2 className="h3">Identity</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Slug</label>
              <input
                className="input font-mono"
                required
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
                placeholder="premium_quarterly"
              />
              <p className="text-xs muted mt-1">Lowercase, digits, hyphen, or underscore. Permanent once created.</p>
            </div>
            <div>
              <label className="label">Tier</label>
              <select
                className="input"
                value={tier}
                onChange={(e) => setTier(e.target.value as PlanProposalPayload["tier"])}
              >
                <option value="free">Free</option>
                <option value="premium">Premium</option>
                <option value="premium_plus">Premium Plus</option>
                <option value="school_pilot">School Pilot</option>
                <option value="school_standard">School Standard</option>
                <option value="school_plus">School Plus</option>
              </select>
            </div>
          </div>
          <div>
            <label className="label">Display name</label>
            <input
              className="input"
              required
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Premium Quarterly"
            />
          </div>
          <div>
            <label className="label">Blurb <span className="text-xs muted font-normal">(short tagline shown on /pricing)</span></label>
            <input
              className="input"
              value={blurb}
              onChange={(e) => setBlurb(e.target.value)}
              placeholder="Save 25% vs monthly"
            />
          </div>
        </section>

        {/* PRICING ----------------------------------------------------- */}
        <section className="card space-y-4">
          <h2 className="h3">Pricing</h2>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPricingModel("fixed")}
              className="flex-1 px-3 py-2 rounded-lg text-sm font-semibold border transition"
              style={
                pricingModel === "fixed"
                  ? { background: "var(--color-accent-soft)", color: "var(--color-on-accent-soft)", borderColor: "var(--brand-300)" }
                  : { background: "var(--color-surface-1)", color: "var(--color-fg-soft)", borderColor: "var(--color-border)" }
              }
            >
              Fixed price
            </button>
            <button
              type="button"
              onClick={() => setPricingModel("per_student")}
              className="flex-1 px-3 py-2 rounded-lg text-sm font-semibold border transition"
              style={
                pricingModel === "per_student"
                  ? { background: "var(--color-accent-soft)", color: "var(--color-on-accent-soft)", borderColor: "var(--brand-300)" }
                  : { background: "var(--color-surface-1)", color: "var(--color-fg-soft)", borderColor: "var(--color-border)" }
              }
            >
              Per student
            </button>
          </div>

          {pricingModel === "fixed" ? (
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Price (₹)</label>
                <input
                  className="input tabular-nums"
                  type="number"
                  min={0}
                  value={pricePaise / 100}
                  onChange={(e) => setPricePaise(Math.round(Number(e.target.value || 0) * 100))}
                />
                <p className="text-[11px] muted mt-1">Stored as {pricePaise} paise.</p>
              </div>
              <div>
                <label className="label">Period (days)</label>
                <input
                  className="input tabular-nums"
                  type="number"
                  min={0}
                  value={periodDays}
                  onChange={(e) => setPeriodDays(Number(e.target.value || 0))}
                />
                <p className="text-[11px] muted mt-1">30 monthly · 90 quarterly · 180 6-month · 365 annual</p>
              </div>
            </div>
          ) : (
            <div className="grid sm:grid-cols-3 gap-3">
              <div>
                <label className="label">Per-student / year (₹)</label>
                <input
                  className="input tabular-nums"
                  type="number"
                  min={1}
                  value={perStudentRupees}
                  onChange={(e) => setPerStudentRupees(Number(e.target.value || 0))}
                />
              </div>
              <div>
                <label className="label">Min students</label>
                <input
                  className="input tabular-nums"
                  type="number"
                  min={0}
                  value={minStudents}
                  onChange={(e) => setMinStudents(Number(e.target.value || 0))}
                />
              </div>
              <div>
                <label className="label">Max students</label>
                <input
                  className="input tabular-nums"
                  type="number"
                  min={0}
                  value={maxStudents ?? ""}
                  onChange={(e) => setMaxStudents(e.target.value === "" ? null : Number(e.target.value))}
                  placeholder="no cap"
                />
              </div>
            </div>
          )}
        </section>

        {/* FEATURES ---------------------------------------------------- */}
        <section className="card space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="h3">Gated features</h2>
            <div className="text-xs muted">{features.size} selected</div>
          </div>
          <div className="space-y-4 max-h-[480px] overflow-y-auto pr-2">
            {FEATURE_CATEGORY_ORDER.map((cat) => {
              const list = FEATURES_BY_CATEGORY[cat] || [];
              if (list.length === 0) return null;
              return (
                <fieldset key={cat}>
                  <legend className="text-xs font-bold uppercase tracking-wide" style={{ color: "var(--color-fg-soft)" }}>
                    {FEATURE_CATEGORY_LABELS[cat]}
                  </legend>
                  <div className="grid sm:grid-cols-2 gap-2 mt-2">
                    {list.map((f) => {
                      const on = features.has(f.key);
                      return (
                        <label
                          key={f.key}
                          className="flex items-start gap-2 p-2 rounded-lg cursor-pointer transition"
                          style={
                            on
                              ? { background: "var(--color-accent-soft)", border: "1px solid var(--brand-300)" }
                              : { background: "var(--color-surface-1)", border: "1px solid var(--color-border)" }
                          }
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => toggleFeature(f.key)}
                            className="mt-0.5 shrink-0"
                          />
                          <div className="text-xs">
                            <div className="font-semibold">{f.label}</div>
                            <div className="muted">{f.description}</div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              );
            })}
          </div>
        </section>

        {/* INFO + ERROR */}
        <div
          className="px-3 py-2 rounded-lg text-xs flex items-start gap-2"
          style={{
            background: "var(--color-info-soft)",
            color: "var(--color-info)",
            border: "1px solid var(--color-border)",
          }}
        >
          <Info size={13} className="mt-0.5 shrink-0" />
          <div>
            Submitting creates a draft proposal. Nothing lands in the live catalogue until you (or another platform admin) approves it from the queue.
          </div>
        </div>

        {err && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 shrink-0" /> {err}
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <><span className="spinner" /> Submitting…</> : <>Submit for review <ArrowRight size={14} /></>}
          </button>
          <span className="text-xs muted">Goes to the queue — review &amp; approve from there.</span>
        </div>
      </form>
    </div>
  );
}

export default function NewPlanPage() {
  return (
    <Suspense fallback={<div className="card text-center py-8"><span className="spinner" /></div>}>
      <NewPlanInner />
    </Suspense>
  );
}
