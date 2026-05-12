"use client";

// D7 — School-admin billing dashboard.
//
// Read-only mirror of the per-school admin page, restricted to commercial
// info the super_teacher should know about themselves:
//
//   - Plan name + status + expiry (with days-remaining or grace status)
//   - Contracted seats + actual student count
//   - Negotiated price (if any) — schools see what they're paying
//   - Current invoice number + PO number + payment status
//   - Archive of past billing cycles
//
// What's deliberately NOT here:
//   - Admin uuids (who clicked Mark Paid)
//   - Plan-picker / negotiated-price edit controls
//   - Start-renewal button (a platform-admin operation)
//
// Source: GET /api/school/billing
//
// If the school is on Free / no plan, we show a friendly placeholder and
// link to the pricing page so the super_teacher can request an upgrade.

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Calendar, FileText, History, CheckCircle2, AlertCircle, Building2, Users,
  CreditCard, IndianRupee,
} from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";

type BillingData = {
  school: {
    id: string;
    name: string;
    join_code: string | null;
    state: string | null;
    gstin: string | null;
  };
  subscription: null | {
    id: string;
    plan_id: string | null;
    tier: string | null;
    status: string | null;
    started_at: string | null;
    expires_at: string | null;
    override_price_paise: number | null;
    override_reason: string | null;
    override_reason_type: string | null;
    invoice_number: string | null;
    payment_method: string | null;
    payment_received_at: string | null;
    po_number: string | null;
    contracted_students: number | null;
    contract_years: number | null;
    activation_pending: boolean | null;
    grace_period_days: number | null;
    suspended_at: string | null;
    suspended_reason: string | null;
  };
  plan: null | {
    id: string;
    slug: string | null;
    label: string | null;
    per_student_price_paise: number | null;
    period_days: number | null;
  };
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

export default function SchoolBillingPage() {
  const [data, setData] = useState<BillingData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabaseBrowser().auth.getSession();
      const t = session?.access_token;
      if (!t) { setErr("Sign in required."); return; }
      const r = await fetch("/api/school/billing", {
        headers: { Authorization: `Bearer ${t}` },
        cache: "no-store",
      });
      const j = await r.json();
      if (!r.ok) { setErr(j.error || "Failed to load billing"); return; }
      setData(j);
    })();
  }, []);

  if (!data && !err) {
    return <div className="grid place-items-center py-20"><div className="spinner" /></div>;
  }
  if (err) {
    return <div className="card max-w-2xl mx-auto mt-8 text-red-700 bg-red-50 border border-red-200">{err}</div>;
  }
  if (!data) return null;

  const sub = data.subscription;
  const days = daysUntil(sub?.expires_at ?? null);
  const grace = sub?.grace_period_days ?? 14;
  const inGrace = days != null && days < 0 && days >= -grace;
  const expired = days != null && days < -grace;

  // Active price = override (if locked) else plan list price × contracted seats.
  const ratePaise = data.plan?.per_student_price_paise ?? 0;
  const seats = sub?.contracted_students ?? null;
  const listPaise = ratePaise * (seats ?? 0);
  const activePaise = sub?.override_price_paise ?? listPaise;

  // Expiry status badge. Suspended trumps the rest.
  const expiryStatus =
    sub?.status === "suspended" ? { label: "Suspended",            tone: "red"     } as const :
    !sub?.expires_at        ? { label: "No subscription",         tone: "slate"   } as const :
    expired                 ? { label: "Expired",                  tone: "red"     } as const :
    inGrace                 ? { label: `In grace (${grace + (days ?? 0)}d left)`, tone: "red"   } as const :
    days != null && days <= 30 ? { label: `Renew in ${days}d`,    tone: "amber"   } as const :
                              { label: "Active",                   tone: "emerald" } as const;
  const toneBg = {
    slate:   "bg-slate-100 text-slate-700 border-slate-200",
    red:     "bg-red-100 text-red-800 border-red-200",
    amber:   "bg-amber-100 text-amber-900 border-amber-300",
    emerald: "bg-emerald-100 text-emerald-800 border-emerald-300",
  } as const;

  // No plan / Free → friendly placeholder.
  if (!sub || !data.plan) {
    return (
      <div className="max-w-4xl mx-auto fade-in p-4">
        <h1 className="h1">Billing</h1>
        <p className="muted text-sm mb-4">View your school&apos;s plan, invoices, and payment history.</p>
        <div className="card text-center py-10">
          <CreditCard size={36} className="mx-auto text-slate-400" />
          <h2 className="h2 mt-4 mb-1">No active subscription</h2>
          <p className="muted text-sm mb-4 max-w-md mx-auto">
            Your school doesn&apos;t have a paid plan yet. Reach out to your BloomIQ contact, or browse the available plans.
          </p>
          <Link href="/pricing" className="btn btn-primary"><IndianRupee size={14} /> See plans</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto fade-in p-4">
      <h1 className="h1">Billing</h1>
      <p className="muted text-sm mb-4">
        Your school&apos;s plan, current invoice, and past billing cycles. For changes to the plan or
        pricing, please contact your BloomIQ account manager.
      </p>

      {/* Suspended banner — visible explanation of why features are locked.
          Hidden when not suspended. Data preservation is called out
          explicitly so the school doesn't worry about lost work. */}
      {sub.status === "suspended" && (
        <div className="card mt-3 border-red-300 bg-red-50 text-red-900 text-sm flex items-start gap-3">
          <AlertCircle size={18} className="mt-0.5 shrink-0 text-red-700" />
          <div>
            <div className="font-semibold">Subscription suspended</div>
            <div className="text-xs text-red-800/90 mt-1">
              {sub.suspended_reason || "Your subscription is currently inactive."}
              {sub.suspended_at && (
                <> &middot; since {formatDate(sub.suspended_at)}</>
              )}
              {" "}Your classes, students, and past test data are <strong>all preserved</strong>
              {" "}exactly as they were. Once payment is recorded, full access returns instantly.
              Please reach out to your BloomIQ account manager to clear the balance.
            </div>
          </div>
        </div>
      )}

      {/* ============ HEADER ============ */}
      <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 px-5 py-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="h2 mb-0">{data.plan.label}</h2>
              <span className={`inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wide rounded-full px-2.5 py-0.5 border ${toneBg[expiryStatus.tone]}`}>
                {expiryStatus.label}
              </span>
            </div>
            <div className="text-xs muted mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1"><Building2 size={11} /> {data.school.name}</span>
              {seats != null && (
                <span className="inline-flex items-center gap-1"><Users size={11} /> {seats} contracted seats</span>
              )}
              {sub.contract_years && sub.contract_years > 1 && (
                <span className="inline-flex items-center gap-1 text-emerald-800">{sub.contract_years}-year contract</span>
              )}
            </div>
          </div>
        </div>
        <div className="grid sm:grid-cols-3 gap-3 mt-4 text-sm">
          <div className="px-3 py-2 rounded-lg bg-white border border-slate-200">
            <div className="text-[10px] uppercase tracking-wide muted font-semibold flex items-center gap-1">
              <Calendar size={10} /> Started
            </div>
            <div className="font-semibold mt-0.5">{formatDate(sub.started_at)}</div>
          </div>
          <div className="px-3 py-2 rounded-lg bg-white border border-slate-200">
            <div className="text-[10px] uppercase tracking-wide muted font-semibold flex items-center gap-1">
              <Calendar size={10} /> Expires
            </div>
            <div className="font-semibold mt-0.5">
              {formatDate(sub.expires_at)}
              {days != null && days >= 0 && <span className="muted text-xs ml-1">({days}d)</span>}
            </div>
          </div>
          <div className="px-3 py-2 rounded-lg bg-white border border-slate-200">
            <div className="text-[10px] uppercase tracking-wide muted font-semibold">Active price</div>
            <div className="font-semibold mt-0.5">
              {activePaise > 0 ? formatINR(activePaise) : "—"}
              {sub.override_price_paise != null && (
                <span className="text-[10px] ml-1 muted">(negotiated)</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ============ CURRENT INVOICE ============ */}
      <div className="card mt-6">
        <h2 className="h2 mb-1">Current invoice</h2>
        <p className="text-xs muted mb-4">
          Issued for this billing cycle. If you&apos;ve already paid and the status below still says
          &ldquo;awaiting payment&rdquo;, please share the bank reference with your BloomIQ contact.
        </p>
        <div className="grid sm:grid-cols-2 gap-3 text-sm">
          <div className="px-3 py-2 rounded-lg bg-slate-50 border border-slate-200">
            <div className="text-[10px] muted uppercase tracking-wide font-semibold">Invoice number</div>
            <div className="font-semibold mt-0.5">
              {sub.invoice_number ?? <span className="muted">— (not yet issued)</span>}
            </div>
          </div>
          <div className="px-3 py-2 rounded-lg bg-slate-50 border border-slate-200">
            <div className="text-[10px] muted uppercase tracking-wide font-semibold">PO number</div>
            <div className="font-semibold mt-0.5">
              {sub.po_number ?? <span className="muted">—</span>}
            </div>
          </div>
          <div className="px-3 py-2 rounded-lg bg-slate-50 border border-slate-200">
            <div className="text-[10px] muted uppercase tracking-wide font-semibold">Payment status</div>
            <div className="font-semibold mt-0.5">
              {sub.payment_received_at
                ? <span className="text-emerald-700 inline-flex items-center gap-1"><CheckCircle2 size={12} /> Received {formatDate(sub.payment_received_at)}</span>
                : <span className="text-amber-700 inline-flex items-center gap-1"><AlertCircle size={12} /> Awaiting payment</span>}
            </div>
            {sub.payment_method && sub.payment_received_at && (
              <div className="text-[10px] muted mt-1">via {sub.payment_method}</div>
            )}
          </div>
          <div className="px-3 py-2 rounded-lg bg-slate-50 border border-slate-200">
            <div className="text-[10px] muted uppercase tracking-wide font-semibold">GST place-of-supply</div>
            <div className="font-semibold mt-0.5">
              {data.school.state ?? <span className="muted">— state not set</span>}
            </div>
            {data.school.gstin && (
              <div className="text-[10px] muted mt-1 font-mono">GSTIN {data.school.gstin}</div>
            )}
          </div>
        </div>

        {sub.invoice_number && sub.id && (
          <div className="mt-4">
            <Link
              href={`/admin/subscriptions/${sub.id}/invoice`}
              className="btn btn-secondary"
            >
              <FileText size={14} /> View invoice PDF
            </Link>
            <p className="text-[11px] muted mt-2">
              Opens the same tax-invoice PDF the platform admin emails to your finance team.
            </p>
          </div>
        )}
      </div>

      {/* ============ PAST INVOICES ============ */}
      {data.past_invoices && data.past_invoices.length > 0 && (
        <div className="card mt-6">
          <h2 className="h2 mb-1 flex items-center gap-2"><History size={20} /> Past billing cycles</h2>
          <p className="text-xs muted mb-4">
            Closed cycles, most recent first. Kept for your finance audit trail.
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
