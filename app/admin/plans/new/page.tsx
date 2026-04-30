"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { ArrowLeft, ArrowRight, AlertCircle } from "lucide-react";

/**
 * /admin/plans/new
 *
 * Create a new draft plan. Two paths:
 *   1. From scratch (slug + tier + label, then redirect into the editor).
 *   2. ?clone_from=<plan_id> — copy an existing plan's fields into a new
 *      draft. Used by the "Edit (creates new draft)" button on the plan
 *      detail page since active plans are immutable.
 *
 * After creation, we redirect to /admin/plans/[id]/edit so the platform
 * admin can tweak features + price before submitting for review.
 */

function NewPlanInner() {
  const router = useRouter();
  const search = useSearchParams();
  const cloneFrom = search.get("clone_from");

  const [slug, setSlug] = useState("");
  const [tier, setTier] = useState<string>("premium");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cloningLabel, setCloningLabel] = useState<string | null>(null);

  // If we're cloning, fetch the source plan's slug + tier + label as
  // sensible defaults so the form pre-fills.
  useEffect(() => {
    if (!cloneFrom) return;
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return;
        const r = await fetch(`/api/admin/plans/${cloneFrom}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const j = await r.json();
        if (r.ok && j.plan) {
          setSlug(j.plan.slug);
          setTier(j.plan.tier);
          setLabel(j.plan.label);
          setCloningLabel(j.plan.label);
        }
      } catch { /* ignore */ }
    })();
  }, [cloneFrom]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const r = await fetch("/api/admin/plans", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          slug: slug.trim(),
          tier,
          label: label.trim(),
          clone_from: cloneFrom || undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Could not create draft.");
      router.push(`/admin/plans/${j.plan.id}/edit`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create draft.");
      setBusy(false);
    }
  }

  return (
    <div className="max-w-xl fade-in">
      <Link href="/admin/plans" className="text-sm text-emerald-700 hover:underline inline-flex items-center gap-1 mb-4">
        <ArrowLeft size={14} /> Back to plans
      </Link>
      <h1 className="h1 mb-1">New plan draft</h1>
      <p className="muted text-sm mb-6">
        {cloningLabel ? (
          <>Cloning <strong>{cloningLabel}</strong> into a new draft. Editing this draft does not affect the active plan; existing subscribers stay grandfathered until you approve this version.</>
        ) : (
          <>Create a new draft plan. After save you&apos;ll land on the editor where you can pick features, set price, and submit for review.</>
        )}
      </p>

      <form onSubmit={submit} className="card space-y-4">
        <div>
          <label className="label">Slug <span className="muted text-xs">(stable identifier, e.g. <code>premium_plus_monthly</code>)</span></label>
          <input
            className="input"
            required
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
            placeholder="premium_plus_monthly"
          />
          <p className="text-xs muted mt-1">
            New active versions of an existing slug will replace the prior active version (which gets archived) — that&apos;s how grandfathering works.
          </p>
        </div>

        <div>
          <label className="label">Tier</label>
          <select
            className="input"
            value={tier}
            onChange={(e) => setTier(e.target.value)}
          >
            <option value="free">Free</option>
            <option value="premium">Premium</option>
            <option value="premium_plus">Premium Plus</option>
            <option value="school_pilot">School Pilot</option>
            <option value="school_standard">School Standard</option>
            <option value="school_plus">School Plus</option>
          </select>
        </div>

        <div>
          <label className="label">Display label</label>
          <input
            className="input"
            required
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Premium Plus Monthly"
          />
        </div>

        {err && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 shrink-0" /> {err}
          </div>
        )}

        <button type="submit" className="btn btn-primary w-full" disabled={busy}>
          {busy ? <><span className="spinner" /> Creating draft…</> : <>Create draft <ArrowRight size={14} /></>}
        </button>
      </form>
    </div>
  );
}

export default function NewPlanPage() {
  return (
    <Suspense fallback={<div className="grid place-items-center py-20"><div className="spinner" /></div>}>
      <NewPlanInner />
    </Suspense>
  );
}
