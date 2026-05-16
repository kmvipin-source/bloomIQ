"use client";

import { useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { AlertCircle, Clock, ArrowRight } from "lucide-react";

/**
 * RenewBanner
 *
 * Renders one of three states based on a paid subscription's expires_at:
 *
 *   1. Hidden — when more than 7 days remain, when no paid subscription
 *      exists, or while still loading.
 *   2. Amber "expires in N days" — when within the 7-day warning window
 *      but not yet expired.
 *   3. Red "expired N days ago" — past expires_at.
 *
 * Two render modes, picked by the `schoolName` prop:
 *
 *   - Personal mode (default; schoolName not passed): a Renew now button
 *     that opens the Razorpay flow via /api/checkout. On verify success
 *     the page reloads, useFeatureAccess re-reads, and the banner
 *     disappears. This is what an independent paying student sees.
 *
 *   - School-admin mode (schoolName passed): no Razorpay button — school
 *     plans are billed offline by the ZCORIQ team — instead a mailto:
 *     CTA pre-filled with the school name so the super-teacher can ask
 *     us to renew. School STUDENTS still don't see the banner (they
 *     have nothing to do about it); only the super_teacher does, and
 *     only on the /school home page.
 *
 * School students don't see this banner — their school renews via the
 * platform admin (offline contract). Hidden by passing source !== "personal"
 * AND schoolName not provided.
 */


function loadRazorpaySdk(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return reject(new Error("no window"));
    if (window.Razorpay) return resolve();
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load the Razorpay checkout script."));
    document.head.appendChild(s);
  });
}

export default function RenewBanner({
  expiresAt,
  isExpired,
  isInGrace,
  graceRemainingDays,
  planSlug,
  source,
  schoolName,
  daysLeft: daysLeftProp,
}: {
  expiresAt: string | null;
  isExpired: boolean;
  // Past expires_at but still inside grace_period_days — features still
  // work, banner should show "renew within Xd" wording rather than full
  // lockout. Modern-SaaS expectation; default is 14 days.
  isInGrace?: boolean;
  graceRemainingDays?: number;
  planSlug: string | null;
  // From useFeatureAccess. Banner renders for personal subscriptions
  // by default; the super-teacher /school home opts into school-admin
  // mode by also passing `schoolName`.
  source: "personal" | "school" | "none";
  // Pass the school's display name on the super-teacher /school page
  // to enable school-admin mode (mailto CTA, "your school's plan" copy).
  // Leave undefined elsewhere to suppress the banner for school plans.
  schoolName?: string | null;
  // D17 — pre-computed daysLeft from useFeatureAccess. Optional so legacy
  // call sites that don't pass it still work (we fall back to a local
  // computation), but prefer to pass it through so dashboard tiles,
  // sidebar, and banner all read the same number.
  daysLeft?: number | null;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isSchoolAdminMode = source === "school" && !!schoolName;

  // Hide when there's no relevant paid subscription, no plan slug, or
  // we're in school mode without an opt-in (school students never see
  // this — only the super-teacher does, by passing schoolName).
  if (!expiresAt || !planSlug) return null;
  if (source === "school" && !isSchoolAdminMode) return null;
  if (source === "none") return null;

  const expiresAtMs = Date.parse(expiresAt);
  // D17 — prefer the value from useFeatureAccess (single source of truth)
  // so this banner can't disagree with a tile or sidebar pill that all
  // read from the same hook. Fall back to a local calc when the caller
  // didn't thread daysLeft through (a few older call sites still don't).
  // eslint-disable-next-line react-hooks/purity
  const daysLeft = typeof daysLeftProp === "number"
    ? daysLeftProp
    : Math.ceil((expiresAtMs - Date.now()) / 86400000);

  // Hide entirely when comfortably in the active window.
  if (!isExpired && daysLeft > 7) return null;

  async function renew() {
    setErr(null);
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Sign in to renew.");
      const { data: { user } } = await sb.auth.getUser();
      if (!user) throw new Error("Sign in to renew.");

      const orderRes = await fetch("/api/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ plan_slug: planSlug }),
      });
      const order = await orderRes.json();
      if (!orderRes.ok) throw new Error(order?.error || "Could not start checkout.");

      await loadRazorpaySdk();
      const Razorpay = window.Razorpay;
      if (!Razorpay) throw new Error("Razorpay didn't load. Disable any ad blocker and retry.");

      const rzp = new Razorpay({
        key: order.key_id,
        order_id: order.order_id,
        amount: order.amount_paise,
        currency: order.currency,
        name: "ZCORIQ",
        description: `Renewal — ${order.plan?.label || planSlug}`,
        prefill: { email: user.email || undefined },
        theme: { color: "#10b981" },
        handler: async (resp: Record<string, string>) => {
          try {
            const v = await fetch("/api/checkout/verify", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${session.access_token}`,
              },
              body: JSON.stringify(resp),
            });
            const j = await v.json();
            if (!v.ok) throw new Error(j?.error || "Verify failed.");
            // Reload the page so useFeatureAccess re-reads the fresh
            // expires_at and the banner disappears.
            window.location.reload();
          } catch (e) {
            setErr(e instanceof Error ? e.message : "Verify failed.");
            setBusy(false);
          }
        },
        modal: { ondismiss: () => setBusy(false) },
      });
      rzp.open();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start renewal.");
      setBusy(false);
    }
  }

  // School-admin mode uses an offline contact CTA instead of Razorpay.
  // The mailto subject embeds the school name so support can route fast.
  const mailtoSubject = isSchoolAdminMode
    ? `Renew school plan — ${schoolName}`
    : "";
  const mailtoBody = isSchoolAdminMode
    ? `Hi ZCORIQ team,\n\nPlease renew our school plan for ${schoolName}.\nOur current plan: ${planSlug}\nExpires: ${new Date(expiresAt).toLocaleDateString()}\n\nThanks!`
    : "";
  const mailtoHref = isSchoolAdminMode
    ? `mailto:support@bloomiq.app?subject=${encodeURIComponent(mailtoSubject)}&body=${encodeURIComponent(mailtoBody)}`
    : "";

  // ---------- In grace (red, but features still working) ----------
  // The school's plan expired but they're inside the configured
  // grace_period_days (default 14) — features keep working so a
  // payment-in-flight or still-being-signed renewal contract doesn't
  // freeze the school overnight. Banner is red and urgent, but the
  // copy makes it clear there's still a window to act.
  if (isInGrace && graceRemainingDays && graceRemainingDays > 0 && !isExpired) {
    const headline = isSchoolAdminMode
      ? `Your school's plan expired. ${graceRemainingDays} grace day${graceRemainingDays === 1 ? "" : "s"} remaining.`
      : `Your subscription expired. ${graceRemainingDays} grace day${graceRemainingDays === 1 ? "" : "s"} remaining.`;
    const subline = isSchoolAdminMode
      ? `Features are still active during this short grace window so your renewal can complete. Email us today to keep things uninterrupted.`
      : `Features are still active for a few more days. Renew now to avoid a break in access.`;
    return (
      <div className="card border-red-300 bg-red-50 mt-3 flex items-start gap-3 flex-wrap">
        <AlertCircle size={20} className="text-red-700 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-[240px]">
          <div className="font-semibold text-red-900">{headline}</div>
          <div className="text-xs text-red-800/80 mt-0.5">{subline}</div>
          {err && <div className="text-xs text-red-900 mt-2">{err}</div>}
        </div>
        {isSchoolAdminMode ? (
          <a href={mailtoHref} className="btn btn-primary text-sm shrink-0">
            Email support to renew <ArrowRight size={14} />
          </a>
        ) : (
          <button type="button" onClick={renew} disabled={busy} className="btn btn-primary text-sm shrink-0">
            {busy ? <><span className="spinner" /> Opening checkout…</> : <>Renew now <ArrowRight size={14} /></>}
          </button>
        )}
      </div>
    );
  }

  // ---------- Expired (red) ----------
  if (isExpired) {
    const daysAgo = Math.abs(daysLeft);
    const headline = isSchoolAdminMode
      ? `Your school's plan expired ${daysAgo === 0 ? "today" : `${daysAgo} day${daysAgo === 1 ? "" : "s"} ago`}.`
      : `Your subscription expired ${daysAgo === 0 ? "today" : `${daysAgo} day${daysAgo === 1 ? "" : "s"} ago`}.`;
    const subline = isSchoolAdminMode
      ? "Premium features for your teachers and students are paused until renewal. Email us to reactivate — your data is safe."
      : "Premium features are paused until you renew. Your data is safe — nothing is deleted.";
    return (
      <div className="card border-red-300 bg-red-50 mt-3 flex items-start gap-3 flex-wrap">
        <AlertCircle size={20} className="text-red-700 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-[240px]">
          <div className="font-semibold text-red-900">{headline}</div>
          <div className="text-xs text-red-800/80 mt-0.5">{subline}</div>
          {err && <div className="text-xs text-red-900 mt-2">{err}</div>}
        </div>
        {isSchoolAdminMode ? (
          <a
            href={mailtoHref}
            className="btn btn-primary text-sm shrink-0"
          >
            Email support to renew <ArrowRight size={14} />
          </a>
        ) : (
          <>
            <button
              type="button"
              onClick={renew}
              disabled={busy}
              className="btn btn-primary text-sm shrink-0"
            >
              {busy ? <><span className="spinner" /> Opening checkout…</> : <>Renew now <ArrowRight size={14} /></>}
            </button>
            <Link href="/pricing" className="text-xs text-red-700 hover:underline shrink-0 self-center">
              Switch plan
            </Link>
          </>
        )}
      </div>
    );
  }

  // ---------- Expiring soon (amber, within 7 days) ----------
  const amberHeadline = isSchoolAdminMode
    ? `Your school's plan expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`
    : `Your subscription expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`;
  const amberSubline = isSchoolAdminMode
    ? `Email us to renew before ${new Date(expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} so your teachers and students stay covered.`
    : `Renew now to avoid any break in access on ${new Date(expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}.`;
  return (
    <div className="card border-amber-300 bg-amber-50 mt-3 flex items-start gap-3 flex-wrap">
      <Clock size={20} className="text-amber-700 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-[240px]">
        <div className="font-semibold text-amber-900">{amberHeadline}</div>
        <div className="text-xs text-amber-800/80 mt-0.5">{amberSubline}</div>
        {err && <div className="text-xs text-red-900 mt-2">{err}</div>}
      </div>
      {isSchoolAdminMode ? (
        <a
          href={mailtoHref}
          className="btn btn-primary text-sm shrink-0"
        >
          Email support to renew <ArrowRight size={14} />
        </a>
      ) : (
        <>
          <button
            type="button"
            onClick={renew}
            disabled={busy}
            className="btn btn-primary text-sm shrink-0"
          >
            {busy ? <><span className="spinner" /> Opening checkout…</> : <>Renew now <ArrowRight size={14} /></>}
          </button>
          <Link href="/pricing" className="text-xs text-amber-800 hover:underline shrink-0 self-center">
            Switch plan
          </Link>
        </>
      )}
    </div>
  );
}
