"use client";

import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { ArrowLeft, Save, Send, CheckCircle2, XCircle, AlertCircle, Lock, Trash2 } from "lucide-react";
import { FEATURES, FEATURE_CATEGORY_LABELS, type FeatureCategory } from "@/lib/features";
import type { Plan } from "@/lib/types";

/**
 * /admin/plans/[id]/edit
 *
 * Two views in one page driven by plan.status:
 *
 *   draft           — full editor (price + features + submit-for-review)
 *   pending_review  — read-only with Approve / Reject buttons (only
 *                     visible to a different admin from the creator)
 *   active / archived — read-only summary + "Edit (creates new draft)"
 *                     button that clones into a new draft
 *
 * Feature picker uses the FEATURES_BY_CATEGORY grid from lib/features.ts
 * so adding a future feature to the registry auto-renders it here.
 */

type PageProps = { params: Promise<{ id: string }> };

export default function EditPlanPage(props: PageProps) {
  const { id } = usePromise(props.params);
  const router = useRouter();

  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [meId, setMeId] = useState<string | null>(null);

  // Local edit state — mirrors plan fields when status === 'draft'.
  const [label, setLabel] = useState("");
  const [blurb, setBlurb] = useState("");
  const [pricePaise, setPricePaise] = useState(0);
  const [periodDays, setPeriodDays] = useState(30);
  const [features, setFeatures] = useState<Set<string>>(new Set());
  // Per-student pricing fields. Only shown for school_* tiers; the
  // server still stores defaults of 'fixed'/0/0 for individual plans.
  const [pricingModel, setPricingModel] = useState<"fixed" | "per_student">("fixed");
  const [perStudentRupees, setPerStudentRupees] = useState(0);
  const [minStudents, setMinStudents] = useState(0);
  const [maxStudents, setMaxStudents] = useState<number | null>(null);

  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      setMeId(user?.id || null);
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
      setPricingModel(p.pricing_model || "fixed");
      setPerStudentRupees((p.per_student_price_paise || 0) / 100);
      setMinStudents(p.min_students || 0);
      setMaxStudents(p.max_students ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load plan.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [id]);

  function toggleFeature(key: string) {
    setFeatures((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function save() {
    if (!plan || plan.status !== "draft") return;
    // Client-side guard mirroring the DB check constraint
    // plans_per_student_price_required. Per-student plans must have a
    // positive per-student rate. Show a friendly inline error rather
    // than letting the raw constraint error bubble up.
    if (pricingModel === "per_student" && perStudentRupees <= 0) {
      setErr("Set a per-student rate above ₹0 before saving a per-student plan.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const r = await fetch(`/api/admin/plans/${id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          label,
          blurb: blurb || null,
          price_paise: pricePaise,
          period_days: periodDays,
          features: Array.from(features),
          pricing_model: pricingModel,
          per_student_price_paise: Math.round(perStudentRupees * 100),
          min_students: minStudents,
          max_students: maxStudents,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Save failed.");
      setSavedAt(new Date().toLocaleTimeString());
      setPlan(j.plan);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function transition(action: "submit" | "approve" | "reject") {
    setActionBusy(action);
    setErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const r = await fetch(`/api/admin/plans/${id}/transition`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ action }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `${action} failed.`);
      // Reload to reflect the new status.
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : `${action} failed.`);
    } finally {
      setActionBusy(null);
    }
  }

  async function deleteDraft() {
    if (!plan || plan.status !== "draft") return;
    if (!confirm("Delete this draft? This cannot be undone.")) return;
    setActionBusy("delete");
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
      setActionBusy(null);
    }
  }

  if (loading) return <div className="grid place-items-center py-20"><div className="spinner" /></div>;
  if (err && !plan) return <div className="card text-red-700 bg-red-50">{err}</div>;
  if (!plan) return null;

  const isDraft = plan.status === "draft";
  const isPending = plan.status === "pending_review";
  const isActive = plan.status === "active";
  const canApprove = isPending && plan.created_by !== meId;
  const isSelfPending = isPending && plan.created_by === meId;

  return (
    <div className="max-w-3xl fade-in">
      <Link href="/admin/plans" className="text-sm text-emerald-700 hover:underline inline-flex items-center gap-1 mb-4">
        <ArrowLeft size={14} /> Back to plans
      </Link>

      <div className="flex items-baseline gap-3 flex-wrap">
        <h1 className="h1">{plan.label}</h1>
        <span className="text-xs muted font-mono">{plan.slug}</span>
        <span className={`text-[10px] uppercase font-bold rounded-full border px-2 py-0.5 ${
          isActive ? "text-emerald-700 bg-emerald-50 border-emerald-200"
          : isPending ? "text-amber-700 bg-amber-50 border-amber-200"
          : isDraft ? "text-slate-700 bg-slate-100 border-slate-200"
          : "text-slate-500 bg-slate-50 border-slate-200"
        }`}>
          {plan.status.replace("_", " ")}
        </span>
      </div>

      {/* ---------- read-only banner for non-draft plans ---------- */}
      {!isDraft && (
        <div className="card mt-4 bg-slate-50 border-slate-200 text-sm">
          {isPending && (
            <div className="flex items-start gap-2">
              <Lock size={16} className="mt-0.5 shrink-0 text-amber-700" />
              <div>
                {isSelfPending ? (
                  <>You submitted this for review. Wait for a different platform admin to approve or reject. (Two-eyes principle.)</>
                ) : (
                  <>This plan is awaiting your review. Approve to make it the active version of <code>{plan.slug}</code> (the previous active version will be archived).</>
                )}
              </div>
            </div>
          )}
          {isActive && (
            <div className="flex items-start gap-2">
              <Lock size={16} className="mt-0.5 shrink-0 text-emerald-700" />
              <div>
                Active plans cannot be edited directly — that would break grandfathering for existing subscribers.
                Use <strong>Edit (creates new draft)</strong> below to start a new version.
              </div>
            </div>
          )}
          {plan.status === "archived" && (
            <div className="flex items-start gap-2">
              <Lock size={16} className="mt-0.5 shrink-0 text-slate-500" />
              <div>This plan version is archived. Subscribers who joined while it was active stay on it; clone it into a new draft to base a future version off it.</div>
            </div>
          )}
        </div>
      )}

      {/* ---------- editable form (draft only) ---------- */}
      <section className="card mt-6 space-y-4">
        <h2 className="font-semibold">Plan details</h2>
        <div>
          <label className="label">Display label</label>
          <input className="input" value={label} disabled={!isDraft} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div>
          <label className="label">Tagline / blurb <span className="muted text-xs">(optional)</span></label>
          <input className="input" value={blurb} disabled={!isDraft} onChange={(e) => setBlurb(e.target.value)} />
        </div>
        {/* Pricing model toggle — only relevant for school_* tiers. The
            individual tiers (free / premium / premium_plus) always stay
            on 'fixed'. */}
        {plan.tier.startsWith("school_") && (
          <div>
            <label className="label">Pricing model</label>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!isDraft}
                onClick={() => setPricingModel("per_student")}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm text-left transition ${
                  pricingModel === "per_student"
                    ? "border-emerald-500 bg-emerald-50 text-emerald-900"
                    : "border-slate-200 hover:border-slate-300"
                } ${!isDraft ? "opacity-70 cursor-default" : ""}`}
              >
                <div className="font-semibold">Per-student</div>
                <div className="text-xs muted">School pays ₹X × student count.</div>
              </button>
              <button
                type="button"
                disabled={!isDraft}
                onClick={() => setPricingModel("fixed")}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm text-left transition ${
                  pricingModel === "fixed"
                    ? "border-emerald-500 bg-emerald-50 text-emerald-900"
                    : "border-slate-200 hover:border-slate-300"
                } ${!isDraft ? "opacity-70 cursor-default" : ""}`}
              >
                <div className="font-semibold">Fixed</div>
                <div className="text-xs muted">Flat price regardless of headcount.</div>
              </button>
            </div>
          </div>
        )}

        {pricingModel === "per_student" ? (
          <div className="grid sm:grid-cols-3 gap-3">
            <div>
              <label className="label">Per student / period (₹)</label>
              <input
                className="input"
                type="number"
                min={0}
                step={1}
                disabled={!isDraft}
                value={perStudentRupees}
                onChange={(e) => setPerStudentRupees(Math.max(0, Number(e.target.value || 0)))}
              />
              <p className="text-xs muted mt-1">Per student per billing period.</p>
            </div>
            <div>
              <label className="label">Min students</label>
              <input
                className="input"
                type="number"
                min={0}
                step={1}
                disabled={!isDraft}
                value={minStudents}
                onChange={(e) => setMinStudents(Math.max(0, Number(e.target.value || 0)))}
              />
              <p className="text-xs muted mt-1">Floor headcount for this tier.</p>
            </div>
            <div>
              <label className="label">Max students <span className="muted text-xs">(blank = no cap)</span></label>
              <input
                className="input"
                type="number"
                min={1}
                step={1}
                disabled={!isDraft}
                value={maxStudents ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  setMaxStudents(v === "" ? null : Math.max(1, Number(v)));
                }}
              />
              <p className="text-xs muted mt-1">Schools above this need the next tier.</p>
            </div>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Price (₹)</label>
              <input
                className="input"
                type="number"
                min={0}
                step={1}
                disabled={!isDraft}
                value={pricePaise / 100}
                onChange={(e) => setPricePaise(Math.round(Number(e.target.value || 0) * 100))}
              />
              <p className="text-xs muted mt-1">Stored as paise. ₹{(pricePaise / 100).toLocaleString("en-IN")}.</p>
            </div>
            <div>
              <label className="label">Billing period (days)</label>
              <input
                className="input"
                type="number"
                min={0}
                step={1}
                disabled={!isDraft}
                value={periodDays}
                onChange={(e) => setPeriodDays(Math.max(0, Number(e.target.value || 0)))}
              />
              <p className="text-xs muted mt-1">30 = monthly · 365 = annual · 0 = free.</p>
            </div>
          </div>
        )}

        {/* Billing period stays editable for per-student plans too — it
            controls renewal cadence (annual is the typical school cycle). */}
        {pricingModel === "per_student" && (
          <div className="max-w-xs">
            <label className="label">Billing period (days)</label>
            <input
              className="input"
              type="number"
              min={0}
              step={1}
              disabled={!isDraft}
              value={periodDays}
              onChange={(e) => setPeriodDays(Math.max(0, Number(e.target.value || 0)))}
            />
            <p className="text-xs muted mt-1">365 = annual (most common for schools).</p>
          </div>
        )}
      </section>

      {/* ---------- feature picker grid ---------- */}
      <section className="card mt-6">
        <h2 className="font-semibold mb-1">Features included in this plan</h2>
        <p className="text-xs muted mb-4">
          Tick what subscribers on this plan can use. Anything unticked renders as a locked tile on the student dashboard with an upgrade CTA.
        </p>

        <div className="space-y-5">
          {(Object.entries(FEATURE_CATEGORY_LABELS) as [FeatureCategory, string][]).map(([cat, catLabel]) => {
            const inCat = FEATURES.filter((f) => f.category === cat);
            if (inCat.length === 0) return null;
            return (
              <div key={cat}>
                <div className="text-[10px] uppercase tracking-wide font-bold text-slate-500 mb-2">{catLabel}</div>
                <div className="grid sm:grid-cols-2 gap-2">
                  {inCat.map((f) => (
                    <label
                      key={f.key}
                      className={`flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer transition ${
                        features.has(f.key)
                          ? "border-emerald-300 bg-emerald-50/50"
                          : "border-slate-200 hover:border-slate-300"
                      } ${!isDraft ? "cursor-default opacity-80" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                        checked={features.has(f.key)}
                        disabled={!isDraft}
                        onChange={() => toggleFeature(f.key)}
                      />
                      <span className="flex-1 text-xs">
                        <span className="font-semibold block">{f.label}</span>
                        <span className="muted">{f.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {err && (
        <div className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {err}
        </div>
      )}

      {/* ---------- action bar ---------- */}
      <div className="mt-6 flex flex-wrap gap-2 items-center">
        {isDraft && (
          <>
            <button type="button" onClick={save} disabled={saving} className="btn btn-secondary">
              {saving ? <><span className="spinner" /> Saving…</> : <><Save size={14} /> Save draft</>}
            </button>
            <button
              type="button"
              onClick={() => transition("submit")}
              disabled={actionBusy !== null}
              className="btn btn-primary"
            >
              {actionBusy === "submit" ? <span className="spinner" /> : <><Send size={14} /> Submit for review</>}
            </button>
            <button
              type="button"
              onClick={deleteDraft}
              disabled={actionBusy !== null}
              className="btn btn-ghost text-red-700 hover:bg-red-50"
            >
              <Trash2 size={14} /> Delete draft
            </button>
            {savedAt && <span className="text-xs muted ml-2">Saved {savedAt}</span>}
          </>
        )}

        {canApprove && (
          <>
            <button
              type="button"
              onClick={() => transition("approve")}
              disabled={actionBusy !== null}
              className="btn btn-primary"
            >
              {actionBusy === "approve" ? <span className="spinner" /> : <><CheckCircle2 size={14} /> Approve & make active</>}
            </button>
            <button
              type="button"
              onClick={() => transition("reject")}
              disabled={actionBusy !== null}
              className="btn btn-ghost text-red-700 hover:bg-red-50"
            >
              {actionBusy === "reject" ? <span className="spinner" /> : <><XCircle size={14} /> Reject</>}
            </button>
          </>
        )}

        {!isDraft && plan.status !== "pending_review" && (
          <Link
            href={`/admin/plans/new?clone_from=${plan.id}`}
            className="btn btn-primary"
          >
            Edit (creates new draft) <ArrowLeft size={14} className="rotate-180" />
          </Link>
        )}
      </div>
    </div>
  );
}
