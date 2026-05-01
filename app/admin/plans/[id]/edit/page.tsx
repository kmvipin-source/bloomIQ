"use client";

import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { ArrowLeft, Save, Trash2, AlertCircle, CheckCircle2, Users } from "lucide-react";
import {
  FEATURES_BY_CATEGORY,
  FEATURE_CATEGORY_ORDER,
  FEATURE_CATEGORY_LABELS,
} from "@/lib/features";
import type { Plan } from "@/lib/types";

/**
 * /admin/plans/[id]/edit
 *
 * Edit a SKU in place. Post-migration-30 there's no draft/submit/approve
 * workflow — the catalogue is flat and edits are immediate. The page is
 * deliberately simple:
 *   - one form
 *   - one Save button (writes the change live)
 *   - one Delete button (only allowed if no subs point at this SKU)
 *
 * Saving applies right away:
 *   - new signups + renewals see the new price
 *   - existing subscribers keep their locked price till expires_at
 *   - existing subscribers see the new features immediately (live)
 *
 * The "active subscriber count" is shown so the admin sees blast-radius
 * before saving.
 */

type PageProps = { params: Promise<{ id: string }> };

export default function EditPlanPage(props: PageProps) {
  const { id } = usePromise(props.params);
  const router = useRouter();

  const [plan, setPlan] = useState<Plan | null>(null);
  const [subscriberCount, setSubscriberCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Editable fields
  const [label, setLabel] = useState("");
  const [blurb, setBlurb] = useState("");
  const [pricePaise, setPricePaise] = useState(0);
  const [periodDays, setPeriodDays] = useState(30);
  const [features, setFeatures] = useState<Set<string>>(new Set());

  const [pricingModel, setPricingModel] = useState<"fixed" | "per_student">("fixed");
  const [perStudentRupees, setPerStudentRupees] = useState(0);
  const [minStudents, setMinStudents] = useState(0);
  const [maxStudents, setMaxStudents] = useState<number | null>(null);

  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const r = await fetch(`/api/admin/plans/${id}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Could not load plan.");
      const p: Plan = j.plan;
      setPlan(p);
      setLabel(p.label);
      setBlurb(p.blurb || "");
      setPricePaise(p.price_paise);
      setPeriodDays(p.period_days);
      setFeatures(new Set(p.features || []));
      setPricingModel((p.pricing_model as "fixed" | "per_student") || "fixed");
      setPerStudentRupees((p.per_student_price_paise || 0) / 100);
      setMinStudents(p.min_students || 0);
      setMaxStudents(p.max_students ?? null);

      // Get subscriber count from the list endpoint (cheap; cached).
      const r2 = await fetch("/api/admin/plans", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const j2 = await r2.json();
      if (r2.ok) {
        const me = (j2.plans || []).find((x: { id: string; active_subscriber_count?: number }) => x.id === id);
        if (me) setSubscriberCount(me.active_subscriber_count || 0);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load plan.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleFeature(key: string) {
    setFeatures((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function save() {
    if (!plan) return;
    if (pricingModel === "per_student" && perStudentRupees <= 0) {
      setErr("Per-student rate must be greater than ₹0.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const body: Record<string, unknown> = {
        label,
        blurb,
        price_paise: pricePaise,
        period_days: periodDays,
        features: Array.from(features),
        pricing_model: pricingModel,
      };
      if (pricingModel === "per_student") {
        body.per_student_price_paise = Math.round(perStudentRupees * 100);
        body.min_students = minStudents;
        body.max_students = maxStudents;
      }
      const r = await fetch(`/api/admin/plans/${id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Save failed.");
      setSavedAt(new Date().toLocaleTimeString());
      setTimeout(() => setSavedAt(null), 3000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function del() {
    if (!plan) return;
    if (!confirm(
      `Delete "${plan.label}"? ` +
      `This is permanent. ${subscriberCount > 0 ? `\n\nThis SKU has ${subscriberCount} active subscriber(s) — the API will refuse the delete.` : ""}`
    )) return;
    setDeleting(true);
    setErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const r = await fetch(`/api/admin/plans/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Delete failed.");
      router.push("/admin/plans");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed.");
      setDeleting(false);
    }
  }

  if (loading) return <div className="card text-center py-8"><span className="spinner" /></div>;
  if (err && !plan) return (
    <div className="card text-sm text-red-700 bg-red-50 border-red-200 flex items-start gap-2">
      <AlertCircle size={16} className="mt-0.5 shrink-0" /> {err}
    </div>
  );
  if (!plan) return null;

  const isSchool = plan.tier.startsWith("school_");

  return (
    <div className="fade-in space-y-6 max-w-3xl">
      <div>
        <Link
          href="/admin/plans"
          className="inline-flex items-center gap-1.5 text-sm font-medium muted hover:underline"
        >
          <ArrowLeft size={14} /> Back to catalogue
        </Link>
      </div>

      <header className="card">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="text-[11px] muted font-mono">{plan.slug}</div>
            <h1 className="h1 mt-1">{plan.label}</h1>
            <div className="text-xs muted mt-1 capitalize">tier: {plan.tier.replace(/_/g, " ")}</div>
          </div>
          <div
            className="inline-flex items-center gap-1.5 text-xs rounded-full px-3 py-1"
            style={{
              background: "var(--color-bg-soft)",
              color: "var(--color-fg-soft)",
              border: "1px solid var(--color-border)",
            }}
          >
            <Users size={12} /> {subscriberCount} active subscriber{subscriberCount === 1 ? "" : "s"}
          </div>
        </div>

        {subscriberCount > 0 && (
          <div
            className="mt-3 px-3 py-2 rounded-lg text-xs flex items-start gap-2"
            style={{
              background: "var(--color-warn-soft)",
              color: "var(--color-warn)",
              border: "1px solid var(--color-border)",
            }}
          >
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <div>
              <strong>Heads up:</strong> {subscriberCount} subscriber{subscriberCount === 1 ? "" : "s"} are live on this SKU.
              Adding features = free upgrade for them. Removing features = they lose access immediately.
              Price changes only affect new signups + renewals.
            </div>
          </div>
        )}
      </header>

      {/* PRICING ----------------------------------------------------------- */}
      <section className="card space-y-4">
        <h2 className="h3">Pricing</h2>

        {isSchool && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPricingModel("fixed")}
              className={`flex-1 px-3 py-2 rounded-lg text-sm font-semibold border transition`}
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
              className={`flex-1 px-3 py-2 rounded-lg text-sm font-semibold border transition`}
              style={
                pricingModel === "per_student"
                  ? { background: "var(--color-accent-soft)", color: "var(--color-on-accent-soft)", borderColor: "var(--brand-300)" }
                  : { background: "var(--color-surface-1)", color: "var(--color-fg-soft)", borderColor: "var(--color-border)" }
              }
            >
              Per student
            </button>
          </div>
        )}

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
              <div className="text-[11px] muted mt-1">Stored as {pricePaise} paise.</div>
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
              <div className="text-[11px] muted mt-1">30 = monthly · 365 = annual · 0 = free</div>
            </div>
          </div>
        ) : (
          <div className="grid sm:grid-cols-3 gap-3">
            <div>
              <label className="label">Per student / year (₹)</label>
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
              <label className="label">Max students <span className="text-xs muted font-normal">(blank = ∞)</span></label>
              <input
                className="input tabular-nums"
                type="number"
                min={0}
                value={maxStudents ?? ""}
                onChange={(e) => setMaxStudents(e.target.value === "" ? null : Number(e.target.value))}
              />
            </div>
          </div>
        )}
      </section>

      {/* COPY ------------------------------------------------------------- */}
      <section className="card space-y-3">
        <h2 className="h3">Display copy</h2>
        <div>
          <label className="label">Label</label>
          <input
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Premium Annual"
          />
        </div>
        <div>
          <label className="label">Blurb <span className="text-xs muted font-normal">(short tagline shown on /pricing)</span></label>
          <input
            className="input"
            value={blurb}
            onChange={(e) => setBlurb(e.target.value)}
            placeholder="e.g. Save 20% vs monthly"
          />
        </div>
      </section>

      {/* FEATURES --------------------------------------------------------- */}
      <section className="card space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="h3">Features</h2>
          <div className="text-xs muted">{features.size} selected</div>
        </div>

        <div className="space-y-4">
          {FEATURE_CATEGORY_ORDER.map((cat) => {
            const list = FEATURES_BY_CATEGORY[cat] || [];
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
                          <div className="font-semibold" style={{ color: on ? "var(--color-on-accent-soft)" : "var(--color-fg)" }}>
                            {f.label}
                          </div>
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

      {err && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {err}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap sticky bottom-4 z-10">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="btn btn-primary"
        >
          {saving ? <><span className="spinner" /> Saving…</> : <><Save size={14} /> Save changes</>}
        </button>
        {savedAt && (
          <span className="inline-flex items-center gap-1 text-xs" style={{ color: "var(--color-success)" }}>
            <CheckCircle2 size={14} /> Saved at {savedAt}
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={del}
          disabled={deleting || subscriberCount > 0}
          className="btn btn-ghost text-red-700 hover:bg-red-50 disabled:opacity-40"
          title={subscriberCount > 0 ? "Cannot delete — active subscribers point at this SKU" : "Delete this SKU"}
        >
          {deleting ? <span className="spinner" /> : <><Trash2 size={14} /> Delete SKU</>}
        </button>
      </div>
    </div>
  );
}
