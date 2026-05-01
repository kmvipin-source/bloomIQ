"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { ArrowLeft, ArrowRight, AlertCircle, Info } from "lucide-react";

/**
 * /admin/plans/new — create a brand-new SKU.
 *
 * Post-migration-30 the catalogue is meant to stay stable. The seeded 8
 * SKUs (Free + Premium Monthly/Annual + Premium Plus Monthly/Annual +
 * 3 school tiers) cover most cases. You should only land here when you
 * genuinely need a new SKU — e.g., adding a Quarterly billing period or
 * a new School tier. Day-to-day price/feature tweaks happen on the
 * Edit page, in place.
 *
 * Form is minimal: slug + tier + label. After save we redirect to the
 * full editor where you set price + features.
 */
export default function NewPlanPage() {
  const router = useRouter();

  const [slug, setSlug] = useState("");
  const [tier, setTier] = useState<string>("premium");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Could not create SKU.");
      router.push(`/admin/plans/${j.plan.id}/edit`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create SKU.");
      setBusy(false);
    }
  }

  return (
    <div className="max-w-xl fade-in">
      <Link
        href="/admin/plans"
        className="inline-flex items-center gap-1.5 text-sm font-medium muted hover:underline mb-4"
      >
        <ArrowLeft size={14} /> Back to catalogue
      </Link>

      <h1 className="h1 mb-1">New SKU</h1>
      <p className="muted text-sm mb-6">
        Add a brand-new product tier or billing period. For routine price
        or feature tweaks, edit one of the 8 existing SKUs in place instead.
      </p>

      <div
        className="px-3 py-2 rounded-lg text-xs flex items-start gap-2 mb-4"
        style={{
          background: "var(--color-info-soft)",
          color: "var(--color-info)",
          border: "1px solid var(--color-border)",
        }}
      >
        <Info size={13} className="mt-0.5 shrink-0" />
        <div>
          <strong>Slug must be unique.</strong> Use the existing convention:
          {" "}
          <code>premium_quarterly</code>, <code>school_enterprise</code>, etc.
          Once created, slug is permanent.
        </div>
      </div>

      <form onSubmit={submit} className="card space-y-4">
        <div>
          <label className="label">Slug</label>
          <input
            className="input font-mono"
            required
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
            placeholder="premium_quarterly"
          />
          <p className="text-xs muted mt-1">
            Lowercase, underscores, no spaces. Used in API calls + checkout.
          </p>
        </div>

        <div>
          <label className="label">Tier</label>
          <select
            className="select"
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
            placeholder="Premium Quarterly"
          />
        </div>

        {err && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 shrink-0" /> {err}
          </div>
        )}

        <button type="submit" className="btn btn-primary w-full" disabled={busy}>
          {busy ? <><span className="spinner" /> Creating…</> : <>Create SKU <ArrowRight size={14} /></>}
        </button>
      </form>
    </div>
  );
}
