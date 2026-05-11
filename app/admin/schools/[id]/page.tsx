"use client";

// Platform-admin per-school page — the single screen the admin lands on
// to drive a B2B school deal end-to-end. Surfaces in priority order:
//
//   HEADER
//     School name + plan badge + EXPIRY (with status: active /
//     expiring-soon / expired) + actual student count + join code
//
//   PLAN & PRICING
//     Plan picker · contracted students input · auto-computed list price ·
//     negotiated price override · audit reason · payment method · Save
//
//   INVOICE & PAYMENT
//     Invoice number (auto-assigned on first download) ·
//     payment status · view/download invoice (bridge page) ·
//     mark NEFT received (extends expiry by one full plan period)
//
// All four actions hit existing admin APIs:
//   POST /api/admin/schools/[id]/set-plan
//   GET  /admin/subscriptions/[id]/invoice  (bridge page → API)
//   POST /api/admin/subscriptions/[id]/mark-paid
//
// Reads via GET /api/admin/schools/[id] (service-role on the server,
// since subscriptions RLS doesn't grant a platform_admin exception).

import { use as usePromise, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft, Save, FileText, CheckCircle2, AlertCircle, Calendar,
  Users, Building2, RotateCw, History,
} from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";

type SchoolDetail = {
  school: { id: string; name: string; join_code: string | null };
  subscription: null | {
    id: string;
    plan_id: string | null;
    tier: string | null;
    status: string | null;
    started_at: string | null;
    expires_at: string | null;
    override_price_paise: number | null;
    override_reason: string | null;
    override_set_by: string | null;
    override_set_at: string | null;
    invoice_number: string | null;
    payment_method: string | null;
    payment_received_at: string | null;
    contracted_students: number | null;
    activation_pending: boolean | null;
    grace_period_days: number | null;
  };
  plan: null | { id: string; slug: string | null; label: string | null; per_student_price_paise: number | null; period_days: number | null };
  student_count: number;
  school_plans: Array<{ id: string; slug: string | null; label: string | null; per_student_price_paise: number | null }>;
  // Past billing cycles archived by "Start renewal cycle". Most-recent first.
  past_invoices: Array<{
    id: string;
    invoice_number: string | null;
    contracted_students: number | null;
    override_price_paise: number | null;
    payment_method: string | null;
    payment_received_at: string | null;
    cycle_started_at: string | null;
    cycle_expires_at: string | null;
    archived_at: string;
  }>;
};

type PageProps = { params: Promise<{ id: string }> };

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  return Math.ceil((Date.parse(iso) - Date.now()) / (24 * 60 * 60 * 1000));
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function formatINR(paise: number): string {
  return "₹" + (paise / 100).toLocaleString("en-IN");
}

export default function SchoolAdminPage(props: PageProps) {
  const { id: schoolId } = usePromise(props.params);
  const [data, setData] = useState<SchoolDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Form state — initialised from server data on every load().
  const [planId, setPlanId] = useState<string>("");
  const [contractedStudents, setContractedStudents] = useState<string>("");
  const [overridePrice, setOverridePrice] = useState<string>("");
  const [overrideReason, setOverrideReason] = useState<string>("");
  const [paymentMethod, setPaymentMethod] = useState<string>("neft");
  // Modern-expiry knobs (see migration 65). All three are optional —
  // an operator who doesn't touch them gets sensible defaults: today's
  // activation, 14-day grace, no defer.
  const [activationDate, setActivationDate] = useState<string>("");      // YYYY-MM-DD; empty = today
  const [activationPending, setActivationPending] = useState<boolean>(false);
  const [gracePeriodDays, setGracePeriodDays] = useState<string>("");    // "" = use stored / 14 default

  const [savingPlan, setSavingPlan] = useState(false);
  const [savingPaid, setSavingPaid] = useState(false);

  async function getToken(): Promise<string | null> {
    const { data: { session } } = await supabaseBrowser().auth.getSession();
    return session?.access_token ?? null;
  }

  async function load() {
    setErr(null);
    const t = await getToken();
    if (!t) { setErr("Sign in required."); return; }
    // cache: "no-store" so post-save reloads get the freshly-written
    // subscription row instead of a stale cached body. Defect D2 from
    // the 2026-05-10 Chrome E2E run — without this the EXPIRES tile
    // could lag one render cycle after Save.
    const r = await fetch(`/api/admin/schools/${schoolId}`, {
      headers: { Authorization: `Bearer ${t}` },
      cache: "no-store",
    });
    const j = await r.json();
    if (!r.ok) { setErr(j.error || "Failed to load school"); return; }
    setData(j);
    setPlanId(j.subscription?.plan_id ?? "");
    setContractedStudents(j.subscription?.contracted_students != null ? String(j.subscription.contracted_students) : "");
    setOverridePrice(j.subscription?.override_price_paise != null ? String(j.subscription.override_price_paise / 100) : "");
    setOverrideReason(j.subscription?.override_reason ?? "");
    setPaymentMethod(j.subscription?.payment_method ?? "neft");
    // Hydrate modern-expiry fields. started_at comes back as full ISO; the
    // <input type="date"> wants YYYY-MM-DD. Use IST-local (en-CA returns
    // YYYY-MM-DD) so an operator who entered "1 Jun" in IST sees "1 Jun"
    // back, not "31 May" (the UTC date for the same instant). Defect D1
    // from the 2026-05-10 Chrome E2E run.
    setActivationDate(
      j.subscription?.started_at
        ? new Date(j.subscription.started_at).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })
        : "",
    );
    setActivationPending(j.subscription?.activation_pending === true);
    setGracePeriodDays(
      j.subscription?.grace_period_days != null
        ? String(j.subscription.grace_period_days)
        : "",
    );
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [schoolId]);

  async function savePlan(opts: { clearOverride?: boolean; clearContracted?: boolean } = {}) {
    setSavingPlan(true); setErr(null); setInfo(null);
    try {
      const t = await getToken();
      if (!t) throw new Error("Sign in required.");
      const body: Record<string, unknown> = { plan_id: planId || null, payment_method: paymentMethod };

      // Modern-expiry: explicit started_at (lets operator backdate or
      // future-date), defer-to-first-signin flag, and a grace window.
      if (activationDate) {
        // Treat as midnight India-local; encode as ISO so server stores
        // a stable instant. The 5h30 offset is intentional — IST is
        // BloomIQ's primary market.
        body.started_at = new Date(`${activationDate}T00:00:00+05:30`).toISOString();
      }
      body.activation_pending = activationPending;
      if (gracePeriodDays.trim()) {
        const g = Number(gracePeriodDays);
        if (!Number.isFinite(g) || g < 0) throw new Error("Grace period must be 0 or more days.");
        body.grace_period_days = Math.round(g);
      }

      if (opts.clearContracted) {
        body.clear_contracted_students = true;
      } else if (contractedStudents.trim()) {
        const n = Number(contractedStudents);
        if (!Number.isFinite(n) || n <= 0) throw new Error("Contracted students must be a positive number.");
        body.contracted_students = Math.round(n);
      }
      if (opts.clearOverride) {
        body.clear_override = true;
      } else if (overridePrice.trim()) {
        const n = Number(overridePrice);
        if (!Number.isFinite(n) || n <= 0) throw new Error("Negotiated price must be a positive number.");
        body.override_price_rupees = Math.round(n);
        body.override_reason = overrideReason.trim() || "Manually set by platform admin";
      }
      const r = await fetch(`/api/admin/schools/${schoolId}/set-plan`, {
        method: "POST",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Save failed");
      setInfo(opts.clearOverride ? "Negotiated price cleared." : opts.clearContracted ? "Contracted seat count cleared." : "Saved.");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingPlan(false);
    }
  }

  async function markPaid() {
    if (!data?.subscription?.id) return;
    // Compute renewal preview client-side for the confirm dialog so the
    // operator sees "extends from X → Y" before committing. Mirror the
    // server's "smart" extend logic (early renewal preserves remainder).
    // Pull period_days from the actual plan so the preview matches
    // what the server will commit. Falls back to 365 when the plan
    // hasn't been loaded yet (rare — the page won't render the
    // mark-paid button without subscription state anyway).
    const periodDays = data.plan?.period_days ?? 365;
    const prevExp = data.subscription.expires_at ? new Date(data.subscription.expires_at) : null;
    const now     = new Date();
    const baseTime = prevExp && prevExp.getTime() > now.getTime() ? prevExp.getTime() : now.getTime();
    const newExp   = new Date(baseTime + periodDays * 24 * 60 * 60 * 1000);
    const previewMsg =
      `Mark this subscription as paid?\n\n` +
      `Extends from ${prevExp ? formatDate(prevExp.toISOString()) : "—"} to approximately ${formatDate(newExp.toISOString())} ` +
      `(based on the plan's ${periodDays}-day period).\n\n` +
      `If renewing early, the unused remainder is preserved.`;
    if (!confirm(previewMsg)) return;
    setSavingPaid(true); setErr(null); setInfo(null);
    try {
      const t = await getToken();
      if (!t) throw new Error("Sign in required.");
      const r = await fetch(`/api/admin/subscriptions/${data.subscription.id}/mark-paid`, {
        method: "POST",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify({ payment_method: paymentMethod }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "mark-paid failed");
      setInfo(
        `Payment recorded. ` +
        (j.previous_expires_at
          ? `Extended from ${formatDate(j.previous_expires_at)} to ${formatDate(j.expires_at)}.`
          : `New expiry: ${formatDate(j.expires_at)}.`)
      );
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "mark-paid failed");
    } finally {
      setSavingPaid(false);
    }
  }

  // Renewal: archive the closing cycle (current invoice number + payment
  // record) into subscription_invoice_archive, then null out invoice_number
  // and payment_received_at on the live row. Net effect:
  //   • Past invoice + payment audit-trail preserved.
  //   • "View invoice" generates a fresh BLM/YYYY/NNNN number for the new
  //     cycle (GST compliance — each new financial cycle needs its own
  //     sequential number).
  //   • "Mark payment received" goes back to recording a NEW payment
  //     instead of "Re-record".
  // The platform admin then: (1) optionally adjusts plan / contracted
  // students / negotiated price for the new term, (2) downloads the
  // fresh invoice and emails it to the school, (3) clicks Mark payment
  // received once the NEFT lands.
  async function startRenewal() {
    if (!data?.subscription?.id) return;
    const prev = data.subscription.invoice_number ?? "—";
    if (!confirm(
      `Start a renewal cycle for ${data.school.name}?\n\n` +
      `This archives the current cycle (invoice ${prev}, paid via ` +
      `${data.subscription.payment_method ?? "—"}) and clears the live invoice/payment fields.\n\n` +
      `The next "View invoice" will generate a brand-new BLM/YYYY/NNNN number for the new term. ` +
      `Past invoices remain visible below.`,
    )) return;
    setSavingPlan(true); setErr(null); setInfo(null);
    try {
      const t = await getToken();
      if (!t) throw new Error("Sign in required.");
      const r = await fetch(`/api/admin/schools/${schoolId}/set-plan`, {
        method: "POST",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          plan_id: planId || null,
          payment_method: paymentMethod,
          start_renewal: true,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Renewal failed");
      setInfo("Renewal cycle started. Generate the new invoice and mark it paid when NEFT lands.");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Renewal failed");
    } finally {
      setSavingPlan(false);
    }
  }

  if (!data && !err) {
    return <div className="grid place-items-center py-20"><div className="spinner" /></div>;
  }
  if (err && !data) {
    return <div className="card max-w-2xl mx-auto mt-8 text-red-700 bg-red-50 border border-red-200">{err}</div>;
  }
  if (!data) return null;

  // Derived values for display.
  const sub = data.subscription;
  const ratePaise = data.plan?.per_student_price_paise ?? 0;
  const seatsForPricing =
    contractedStudents.trim() && Number(contractedStudents) > 0
      ? Math.round(Number(contractedStudents))
      : data.student_count;
  const seatLabel = contractedStudents.trim() ? "contracted" : "active";
  const computedListPaise = ratePaise * seatsForPricing;
  const activePaise = sub?.override_price_paise ?? computedListPaise;

  // Expiry status — drives the badge colour + headline text.
  const days = daysUntil(sub?.expires_at ?? null);
  const expiryStatus =
    !sub?.expires_at        ? { label: "No subscription",      tone: "slate"  } as const :
    days != null && days < 0  ? { label: "Expired",               tone: "red"    } as const :
    days != null && days <= 30 ? { label: `Expires in ${days}d`,  tone: "amber"  } as const :
                              { label: `Active`,                tone: "emerald" } as const;

  const toneBg = {
    slate:   "bg-slate-100 text-slate-700 border-slate-200",
    red:     "bg-red-100 text-red-800 border-red-200",
    amber:   "bg-amber-100 text-amber-900 border-amber-300",
    emerald: "bg-emerald-100 text-emerald-800 border-emerald-300",
  } as const;

  return (
    <div className="max-w-4xl mx-auto fade-in p-4">
      <Link href="/admin/onboard-school" className="text-sm text-emerald-700 inline-flex items-center gap-1">
        <ArrowLeft size={14} /> Back to schools
      </Link>

      {/* ============ HEADER ============ */}
      <div className="mt-3 rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 px-5 py-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="h1 mb-0">{data.school.name}</h1>
              <span className={`inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wide rounded-full px-2.5 py-0.5 border ${toneBg[expiryStatus.tone]}`}>
                {expiryStatus.label}
              </span>
            </div>
            <div className="text-xs muted mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1"><Building2 size={11} /> School ID <code className="text-[10px] px-1 py-0.5 bg-slate-100 rounded">{data.school.id.slice(0, 8)}…</code></span>
              {data.school.join_code && (
                <span className="inline-flex items-center gap-1">Join code <code className="text-[10px] px-1 py-0.5 bg-slate-100 rounded">{data.school.join_code}</code></span>
              )}
              <span className="inline-flex items-center gap-1"><Users size={11} /> {data.student_count} active student{data.student_count === 1 ? "" : "s"}</span>
              {sub?.contracted_students != null && (
                <span className="inline-flex items-center gap-1 text-emerald-800"><Users size={11} /> {sub.contracted_students} contracted seats</span>
              )}
            </div>
          </div>
        </div>
        <div className="grid sm:grid-cols-3 gap-3 mt-4 text-sm">
          <div className="px-3 py-2 rounded-lg bg-white border border-slate-200">
            <div className="text-[10px] uppercase tracking-wide muted font-semibold">Plan</div>
            <div className="font-semibold mt-0.5">{data.plan?.label ?? "— No plan —"}</div>
          </div>
          <div className="px-3 py-2 rounded-lg bg-white border border-slate-200">
            <div className="text-[10px] uppercase tracking-wide muted font-semibold flex items-center gap-1">
              <Calendar size={10} /> Expires
            </div>
            <div className="font-semibold mt-0.5">
              {formatDate(sub?.expires_at ?? null)}
              {days != null && days >= 0 && <span className="muted text-xs ml-1">({days}d)</span>}
            </div>
          </div>
          <div className="px-3 py-2 rounded-lg bg-white border border-slate-200">
            <div className="text-[10px] uppercase tracking-wide muted font-semibold">Active price</div>
            <div className="font-semibold mt-0.5">
              {ratePaise > 0 ? formatINR(activePaise) : "—"}
              {sub?.override_price_paise != null && <span className="text-[10px] ml-1 muted">(negotiated)</span>}
            </div>
          </div>
        </div>
      </div>

      {info && (
        <div className="card mt-4 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 flex items-center gap-2">
          <CheckCircle2 size={16} /> {info}
        </div>
      )}
      {err && (
        <div className="card mt-4 text-sm text-red-700 bg-red-50 border border-red-200 flex items-center gap-2">
          <AlertCircle size={16} /> {err}
        </div>
      )}

      {/* ============ PLAN & PRICING ============ */}
      <div className="card mt-6">
        <h2 className="h2 mb-1">Plan &amp; pricing</h2>
        <p className="text-xs muted mb-4">
          Pick the plan, set the contracted seat count, and (optionally) lock a negotiated rounded price.
          The list price below recalculates as you type.
        </p>

        <label className="label">Plan</label>
        <select className="select" value={planId} onChange={(e) => setPlanId(e.target.value)}>
          <option value="">— No plan (Free) —</option>
          {data.school_plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} (₹{(p.per_student_price_paise ?? 0) / 100} / student / yr)
            </option>
          ))}
        </select>

        <label className="label mt-4">Contracted students (seat count for this contract)</label>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            className="input flex-1 min-w-[160px]"
            type="number"
            min={1}
            placeholder={`e.g. 700  (currently ${data.student_count} actually signed in)`}
            value={contractedStudents}
            onChange={(e) => setContractedStudents(e.target.value)}
          />
          {sub?.contracted_students != null && (
            <button type="button" className="btn btn-ghost text-xs" onClick={() => savePlan({ clearContracted: true })} disabled={savingPlan}>
              Clear (use actual count)
            </button>
          )}
        </div>
        <p className="text-[11px] muted mt-1">
          The school may have signed up for {sub?.contracted_students ?? "N"} seats but only {data.student_count} kids are actually in the system right now. Pricing is based on the contracted number — leave empty to use the actual count instead.
        </p>

        <div className="mt-4 grid sm:grid-cols-2 gap-3 text-sm">
          <div className="px-3 py-2 rounded-lg bg-slate-50 border border-slate-200">
            <div className="text-[10px] muted uppercase tracking-wide font-semibold">Calculated list price</div>
            <div className="font-semibold mt-0.5">
              ₹{ratePaise / 100} × {seatsForPricing} {seatLabel} seats
            </div>
            <div className="text-emerald-800 font-bold text-lg">
              {formatINR(computedListPaise)}
            </div>
          </div>
          <div className={`px-3 py-2 rounded-lg border ${sub?.override_price_paise != null ? "bg-emerald-50 border-emerald-200" : "bg-slate-50 border-slate-200"}`}>
            <div className="text-[10px] muted uppercase tracking-wide font-semibold">Currently active price</div>
            <div className={`font-bold text-lg mt-0.5 ${sub?.override_price_paise != null ? "text-emerald-800" : ""}`}>
              {ratePaise > 0 ? formatINR(activePaise) : "—"}
            </div>
            <div className="text-[11px] muted">
              {sub?.override_price_paise != null
                ? "Negotiated — overrides the list price"
                : "Same as list price (no override)"}
            </div>
          </div>
        </div>

        <label className="label mt-4">Negotiated price (₹, optional)</label>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            className="input flex-1 min-w-[160px]"
            type="number"
            min={0}
            placeholder={`e.g. 35000  (list would be ₹${(computedListPaise / 100).toLocaleString("en-IN")})`}
            value={overridePrice}
            onChange={(e) => setOverridePrice(e.target.value)}
          />
          {sub?.override_price_paise != null && (
            <button type="button" className="btn btn-ghost text-xs" onClick={() => savePlan({ clearOverride: true })} disabled={savingPlan}>
              Clear negotiated price
            </button>
          )}
        </div>
        <p className="text-[11px] muted mt-1">
          Leave empty to use the calculated list price. Setting a value locks this subscription to the negotiated rate.
        </p>

        <label className="label mt-3">Reason / context (audit trail)</label>
        <input
          className="input"
          placeholder="e.g. Multi-year deal, 700 students, closed by Vipin"
          value={overrideReason}
          onChange={(e) => setOverrideReason(e.target.value)}
        />

        <label className="label mt-3">Payment method</label>
        <select className="select max-w-xs" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
          <option value="neft">NEFT / RTGS / wire</option>
          <option value="cheque">Cheque</option>
          <option value="razorpay">Razorpay (online)</option>
          <option value="manual">Manual / other</option>
        </select>

        {/* ─── Modern-expiry controls (post-migration-65) ───
            Three knobs, surfaced together so the operator sees them as
            one decision: when does the term actually start, and what
            grace do we give post-expiry. */}
        <div className="mt-5 p-3 rounded-lg border border-slate-200 bg-slate-50">
          <div className="text-xs uppercase tracking-wide font-semibold muted mb-2 flex items-center gap-1">
            <Calendar size={12} /> Activation & grace
          </div>
          <div className="grid sm:grid-cols-3 gap-3 text-sm">
            <div>
              <label className="label text-[11px]">Activation date</label>
              <input
                className="input"
                type="date"
                value={activationDate}
                disabled={activationPending}
                onChange={(e) => setActivationDate(e.target.value)}
              />
              <p className="text-[10px] muted mt-1">
                Term clock starts here. Future-date for academic-year deals (e.g. set to 1&nbsp;Jun for a school whose year starts in June).
              </p>
            </div>
            <div>
              <label className="label text-[11px] flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={activationPending}
                  onChange={(e) => setActivationPending(e.target.checked)}
                />
                Defer until first sign-in
              </label>
              <p className="text-[10px] muted mt-1">
                Term clock starts the moment the school&apos;s Admin Head first signs in. Use when onboarding ahead of when they&apos;re actually ready to use the app.
              </p>
            </div>
            <div>
              <label className="label text-[11px]">Grace period (days)</label>
              <input
                className="input"
                type="number"
                min={0}
                placeholder="14"
                value={gracePeriodDays}
                onChange={(e) => setGracePeriodDays(e.target.value)}
              />
              <p className="text-[10px] muted mt-1">
                After expires_at, features keep working for this many days while the school renews. Default 14.
              </p>
            </div>
          </div>
          {sub?.expires_at && (
            <div className="mt-3 text-xs muted">
              Current expiry: <strong>{formatDate(sub.expires_at)}</strong>
              {sub.activation_pending && (
                <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-900 text-[10px] font-bold">
                  <AlertCircle size={9} /> Placeholder — flips to actual on first sign-in
                </span>
              )}
            </div>
          )}
        </div>

        <div className="mt-4 flex gap-2 flex-wrap">
          <button type="button" className="btn btn-primary" onClick={() => savePlan()} disabled={savingPlan}>
            <Save size={14} /> {savingPlan ? "Saving…" : "Save plan & pricing"}
          </button>
        </div>

        {sub?.override_set_at && (
          <p className="text-[11px] muted mt-3">
            Override last set on {new Date(sub.override_set_at).toLocaleString()}
            {sub.override_reason && <> · &ldquo;{sub.override_reason}&rdquo;</>}
          </p>
        )}
      </div>

      {/* ============ INVOICE & PAYMENT ============ */}
      {sub?.id && (
        <div className="card mt-6">
          <h2 className="h2 mb-1">Invoice &amp; payment</h2>
          <p className="text-xs muted mb-4">
            Tax invoice (GST) for the <strong>current</strong> billing cycle. Workflow: download
            the invoice → email it to the school → school pays NEFT → click <em>Mark payment
            received</em> (extends expiry by one full plan period). For year-on-year renewals,
            click <em>Start renewal cycle</em> first so the new term gets a fresh invoice number.
          </p>

          <div className="grid sm:grid-cols-2 gap-3 text-sm">
            <div className="px-3 py-2 rounded-lg bg-slate-50 border border-slate-200">
              <div className="text-[10px] muted uppercase tracking-wide font-semibold">Invoice number</div>
              <div className="font-semibold mt-0.5">
                {sub.invoice_number ?? <span className="muted">— (auto-assigned on first download)</span>}
              </div>
            </div>
            <div className="px-3 py-2 rounded-lg bg-slate-50 border border-slate-200">
              <div className="text-[10px] muted uppercase tracking-wide font-semibold">Payment status</div>
              <div className="font-semibold mt-0.5">
                {sub.payment_received_at
                  ? <span className="text-emerald-700">Received {formatDate(sub.payment_received_at)} via {sub.payment_method ?? "—"}</span>
                  : <span className="text-amber-700">Awaiting payment</span>}
              </div>
            </div>
          </div>

          <div className="mt-4 flex gap-2 flex-wrap">
            <Link
              href={`/admin/subscriptions/${sub.id}/invoice`}
              className="btn btn-secondary"
            >
              <FileText size={14} /> View / download invoice
            </Link>
            <button
              type="button"
              className="btn btn-primary"
              onClick={markPaid}
              disabled={savingPaid}
            >
              <CheckCircle2 size={14} />
              {savingPaid ? "Recording…" : sub.payment_received_at ? "Re-record payment" : "Mark payment received"}
            </button>
            {/* Start renewal cycle: only meaningful when the current cycle
                has a recorded payment. Archives the current cycle to
                subscription_invoice_archive then clears invoice_number +
                payment_received_at on the live row so the new term gets a
                fresh BLM/YYYY/NNNN. */}
            {sub.payment_received_at && (
              <button
                type="button"
                className="btn btn-ghost text-emerald-700"
                onClick={startRenewal}
                disabled={savingPlan}
                title="Archive current cycle and start a fresh one with a new invoice number"
              >
                <RotateCw size={14} /> Start renewal cycle
              </button>
            )}
          </div>
        </div>
      )}

      {/* ============ PAST INVOICES ============ */}
      {data.past_invoices && data.past_invoices.length > 0 && (
        <div className="card mt-6">
          <h2 className="h2 mb-1 flex items-center gap-2"><History size={20} /> Past billing cycles</h2>
          <p className="text-xs muted mb-4">
            Closed cycles (archived when you started a renewal). Read-only — kept for finance
            audit trail. Most recent first.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left bg-slate-50 border-y border-slate-200">
                  <th className="px-3 py-2 font-semibold text-xs uppercase tracking-wider">Invoice #</th>
                  <th className="px-3 py-2 font-semibold text-xs uppercase tracking-wider">Cycle</th>
                  <th className="px-3 py-2 font-semibold text-xs uppercase tracking-wider">Seats</th>
                  <th className="px-3 py-2 font-semibold text-xs uppercase tracking-wider">Amount</th>
                  <th className="px-3 py-2 font-semibold text-xs uppercase tracking-wider">Paid</th>
                </tr>
              </thead>
              <tbody>
                {data.past_invoices.map((p) => (
                  <tr key={p.id} className="border-b border-slate-100">
                    <td className="px-3 py-2.5 font-mono text-xs">{p.invoice_number ?? "—"}</td>
                    <td className="px-3 py-2.5 text-xs">
                      {formatDate(p.cycle_started_at)}
                      <span className="muted"> → </span>
                      {formatDate(p.cycle_expires_at)}
                    </td>
                    <td className="px-3 py-2.5 text-xs">{p.contracted_students ?? "—"}</td>
                    <td className="px-3 py-2.5 text-xs">
                      {p.override_price_paise != null ? formatINR(p.override_price_paise) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {p.payment_received_at
                        ? <>{formatDate(p.payment_received_at)} <span className="muted">/ {p.payment_method ?? "—"}</span></>
                        : <span className="muted">Unpaid</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
