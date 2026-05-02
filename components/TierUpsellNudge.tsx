"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sparkles, X, ArrowRight } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";

const AUTO_DISMISS_MS = 9000;
const DASHBOARD_PREFIXES = ["/student", "/teacher", "/school", "/admin", "/parent", "/settings"];

// Hierarchy lives client-side so the component can decide what to show
// without an extra round-trip. Add a slug here when a new plan ships.
const INDIVIDUAL_LADDER = [
  null,                   // unsubscribed / free
  "free",
  "premium_monthly",
  "premium_quarterly",    // shown if you happened to have it; rare
  "premium_annual",
  "premium_plus_monthly",
  "premium_plus_annual",  // top — no nudge
];
const SCHOOL_LADDER = [
  "school_pilot",
  "school_standard",
  "school_plus",          // top — no nudge
];

type Plan = {
  slug: string;
  label: string;
  blurb: string | null;
  feature_summary: string[];
  price_paise: number;
  per_student_price_paise: number | null;
  pricing_model: "fixed" | "per_student" | null;
  period_days: number;
};

export default function TierUpsellNudge() {
  const pathname = usePathname() || "";
  const [next, setNext] = useState<Plan | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const onDashboard = DASHBOARD_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));

  useEffect(() => {
    if (!onDashboard) return;
    let cancelled = false;
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { user } } = await sb.auth.getUser();
        if (!user || cancelled) return;

        const { data: prof } = await sb
          .from("profiles")
          .select("role, is_school_student")
          .eq("id", user.id)
          .maybeSingle();
        if (!prof) return;
        // Skip rules.
        if (prof.role === "platform_admin") return;
        if (prof.is_school_student) return;
        if (prof.role === "teacher") return; // regular teachers — only super_teacher gets school upsell

        // Once-per-day cap.
        const dayKey = `bloomiq_upsell_last_${user.id}`;
        const today = new Date().toISOString().slice(0, 10);
        if (localStorage.getItem(dayKey) === today) return;

        // Current plan slug from subscriptions → plans.
        const { data: sub } = await sb
          .from("subscriptions")
          .select("plan_id, status, expires_at")
          .eq("user_id", user.id)
          .maybeSingle();

        let currentSlug: string | null = null;
        if (sub?.plan_id) {
          const { data: pl } = await sb
            .from("plans")
            .select("slug")
            .eq("id", sub.plan_id)
            .maybeSingle();
          currentSlug = pl?.slug ?? null;
          // Treat expired subs as unsubscribed.
          if (sub.expires_at && new Date(sub.expires_at) < new Date()) currentSlug = null;
          if (sub.status && sub.status !== "active") currentSlug = null;
        }

        // Pick the next slug on the ladder for this user's role.
        let nextSlug: string | null = null;
        if (prof.role === "super_teacher") {
          const idx = currentSlug ? SCHOOL_LADDER.indexOf(currentSlug) : -1;
          if (idx === -1) nextSlug = "school_pilot";
          else if (idx < SCHOOL_LADDER.length - 1) nextSlug = SCHOOL_LADDER[idx + 1];
        } else {
          const idx = INDIVIDUAL_LADDER.indexOf(currentSlug);
          if (idx === -1) nextSlug = "premium_monthly"; // unrecognised → push monthly
          else if (idx < INDIVIDUAL_LADDER.length - 1) nextSlug = INDIVIDUAL_LADDER[idx + 1];
        }
        if (!nextSlug) return; // already at top

        // Fetch the target plan from the live catalogue.
        const r = await fetch("/api/pricing/active-plans", { cache: "no-store" });
        const j = await r.json();
        const plan = (j.plans as Plan[] | undefined)?.find((p) => p.slug === nextSlug);
        if (!plan || cancelled) return;

        setUserId(user.id);
        setNext(plan);

        // Auto-dismiss after a short window — long enough to read, short
        // enough not to annoy.
        setTimeout(() => {
          if (cancelled) return;
          dismissInternal(user.id);
        }, AUTO_DISMISS_MS);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [onDashboard]);

  if (!onDashboard) return null;

  function dismissInternal(uid: string) {
    localStorage.setItem(
      `bloomiq_upsell_last_${uid}`,
      new Date().toISOString().slice(0, 10),
    );
    setNext(null);
  }

  function dismiss() {
    if (userId) dismissInternal(userId);
    else setNext(null);
  }

  if (!next) return null;

  const isPerStudent = next.pricing_model === "per_student";
  const priceLine = isPerStudent
    ? `₹${((next.per_student_price_paise || 0) / 100).toLocaleString("en-IN")}/student/yr`
    : next.price_paise > 0
      ? `₹${(next.price_paise / 100).toLocaleString("en-IN")}/${next.period_days >= 360 ? "yr" : next.period_days >= 60 ? "qtr" : "mo"}`
      : "Free";
  const topFeatures = (next.feature_summary || []).slice(0, 3);

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[90] max-w-md w-[calc(100%-2rem)]">
      <div
        className="rounded-xl shadow-lg border-l-4 px-4 py-3 animate-fade-in flex items-start gap-3"
        style={{
          background: "linear-gradient(135deg, #ecfdf5 0%, #f0fdf4 100%)",
          borderLeftColor: "#10b981",
          borderTop: "1px solid #d1fae5",
          borderRight: "1px solid #d1fae5",
          borderBottom: "1px solid #d1fae5",
        }}
      >
        <div className="shrink-0 w-9 h-9 rounded-full grid place-items-center bg-emerald-600 text-white">
          <Sparkles size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-bold text-sm text-emerald-900">Unlock {next.label}</span>
            <span className="text-xs text-emerald-700 font-semibold">{priceLine}</span>
          </div>
          {topFeatures.length > 0 && (
            <ul className="mt-1.5 text-[11px] text-slate-700 space-y-0.5">
              {topFeatures.map((f) => (
                <li key={f} className="flex items-start gap-1.5">
                  <span className="text-emerald-600 mt-0.5">✓</span>
                  <span className="truncate">{f}</span>
                </li>
              ))}
            </ul>
          )}
          <Link
            href="/pricing"
            onClick={dismiss}
            className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:text-emerald-800 mt-2"
          >
            View plan <ArrowRight size={12} />
          </Link>
        </div>
        <button
          onClick={dismiss}
          aria-label="Dismiss"
          className="shrink-0 p-1 rounded hover:bg-emerald-100 text-emerald-700"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
