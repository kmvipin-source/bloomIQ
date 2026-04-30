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
 *      but not yet expired. Includes a Renew now button.
 *   3. Red "expired N days ago" — past expires_at. Same Renew now button,
 *      but the empty allowed-features set means everything paid is
 *      already locked.
 *
 * Renew button calls the existing /api/checkout flow with the user's
 * current plan_slug. On success, /api/checkout/verify writes a fresh
 * started_at + expires_at and useFeatureAccess re-reads on next mount,
 * so this banner disappears.
 *
 * School students don't see this banner — their school renews via the
 * platform admin (offline contract). Hidden by passing source !== "personal".
 */

declare global {
  interface Window {
    Razorpay?: new (opts: Record<string, unknown>) => { open: () => void };
  }
}

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
  planSlug,
  source,
}: {
  expiresAt: string | null;
  isExpired: boolean;
  planSlug: string | null;
  // From useFeatureAccess. Banner only renders for personal subscriptions.
  source: "personal" | "school" | "none";
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Hide for school subscriptions (the school admin handles renewal),
  // for users with no paid plan, and while data is incomplete.
  if (source !== "personal" || !expiresAt || !planSlug) return null;

  const expiresAtMs = Date.parse(expiresAt);
  const daysLeft = Math.ceil((expiresAtMs - Date.now()) / 86400000);

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
        name: "BloomIQ",
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

  // ---------- Expired (red) ----------
  if (isExpired) {
    const daysAgo = Math.abs(daysLeft);
    return (
      <div className="card border-red-300 bg-red-50 mt-3 flex items-start gap-3 flex-wrap">
        <AlertCircle size={20} className="text-red-700 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-[240px]">
          <div className="font-semibold text-red-900">
            Your subscription expired {daysAgo === 0 ? "today" : `${daysAgo} day${daysAgo === 1 ? "" : "s"} ago`}.
          </div>
          <div className="text-xs text-red-800/80 mt-0.5">
            Premium features are paused until you renew. Your data is safe — nothing is deleted.
          </div>
          {err && <div className="text-xs text-red-900 mt-2">{err}</div>}
        </div>
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
      </div>
    );
  }

  // ---------- Expiring soon (amber, within 7 days) ----------
  return (
    <div className="card border-amber-300 bg-amber-50 mt-3 flex items-start gap-3 flex-wrap">
      <Clock size={20} className="text-amber-700 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-[240px]">
        <div className="font-semibold text-amber-900">
          Your subscription expires in {daysLeft} day{daysLeft === 1 ? "" : "s"}.
        </div>
        <div className="text-xs text-amber-800/80 mt-0.5">
          Renew now to avoid any break in access on{" "}
          {new Date(expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}.
        </div>
        {err && <div className="text-xs text-red-900 mt-2">{err}</div>}
      </div>
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
    </div>
  );
}
