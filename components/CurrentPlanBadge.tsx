"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Crown, Sparkles, GraduationCap, ArrowRight } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";

type PlanInfo = {
  label: string;
  tier: string;
  source: "self" | "school";
  school_name?: string | null;
  // Plan expiry — populated for the "school" path so Admin Heads and
  // deputies see when their school's plan needs to be renewed. Independent
  // students get expiry surfaced through RenewBanner instead.
  expires_at?: string | null;
};

/**
 * "Currently on" badge shown on dashboards.
 *
 * Visibility:
 *   - Independent students → their own subscription's plan.
 *   - School students      → the school's subscription plan.
 *   - Teachers in a school → the school's subscription plan.
 *   - super_teacher        → the school's subscription plan.
 *   - platform_admin / unaffiliated regular teacher → no badge.
 */
export default function CurrentPlanBadge() {
  const [info, setInfo] = useState<PlanInfo | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const sb = supabaseBrowser();
        // Resolve role + school_id via the service-role /api/auth/me
        // endpoint. Reading profiles via the user-token client races RLS
        // and was returning a stale school_id even after the row was
        // nulled, leaving the badge stuck on the old school name.
        const { data: { session } } = await sb.auth.getSession();
        const token = session?.access_token;
        if (!token) return;
        const meRes = await fetch("/api/auth/me", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (!meRes.ok) return;
        const me = await meRes.json() as {
          uid: string;
          role: string | null;
          is_school_student: boolean;
          school_id: string | null;
          platform_admin: boolean;
        };
        if (me.platform_admin) return;
        const user = { id: me.uid };
        const prof = {
          role: me.role,
          is_school_student: me.is_school_student,
          school_id: me.school_id,
          platform_admin: me.platform_admin,
        };

        // Determine which subscription to read.
        const inSchool = !!prof.school_id;
        const useSchool =
          inSchool && (prof.role === "super_teacher" || prof.role === "teacher" || !!prof.is_school_student);

        if (useSchool && prof.school_id) {
          const { data: schoolRow } = await sb
            .from("schools")
            .select("name")
            .eq("id", prof.school_id)
            .maybeSingle();
          const { data: sub } = await sb
            .from("subscriptions")
            .select("plan_id, status, expires_at, tier")
            .eq("school_id", prof.school_id)
            .maybeSingle();
          const plan = sub?.plan_id
            ? (await sb.from("plans").select("label, tier").eq("id", sub.plan_id).maybeSingle()).data
            : null;
          setInfo({
            label: plan?.label || (sub?.tier ? prettyTier(sub.tier) : "Not subscribed"),
            tier: plan?.tier || sub?.tier || "free",
            source: "school",
            school_name: (schoolRow as { name?: string } | null)?.name || null,
            expires_at: sub?.expires_at ?? null,
          });
          return;
        }

        // Self path: independent student.
        if (prof.role === "student" && !inSchool) {
          const { data: sub } = await sb
            .from("subscriptions")
            .select("plan_id, status, expires_at, tier, grace_period_days")
            .eq("user_id", user.id)
            .maybeSingle();
          let label = "Free";
          let tier = "free";
          if (sub?.plan_id) {
            const { data: plan } = await sb.from("plans").select("label, tier").eq("id", sub.plan_id).maybeSingle();
            if (plan) { label = plan.label; tier = plan.tier; }
            else if (sub.tier) { label = prettyTier(sub.tier); tier = sub.tier; }
            // Treat expired / inactive as free — but honour the grace
            // period so the badge stays in sync with useFeatureAccess.
            // Without this, a student inside grace would see "Plan: Free"
            // on the badge while their pro features were still on.
            if (sub.status && sub.status !== "active") { label = "Free"; tier = "free"; }
            if (sub.expires_at) {
              const expiresMs = new Date(sub.expires_at).getTime();
              const graceDays = (sub as { grace_period_days?: number | null }).grace_period_days ?? 14;
              const hardCutoffMs = expiresMs + graceDays * 24 * 60 * 60 * 1000;
              if (Date.now() > hardCutoffMs) { label = "Free"; tier = "free"; }
            }
          }
          setInfo({ label, tier, source: "self" });
        }
      } catch { /* silent */ }
    })();
  }, []);

  if (!info) return null;

  const tone = toneFor(info.tier);
  const Icon = info.tier.startsWith("school_") ? GraduationCap : info.tier === "free" ? Sparkles : Crown;
  const showUpsell = info.source === "self" && (info.tier === "free" || info.tier === "premium");

  // Expiry tail: only for the school source — independent students already
  // get a clear expiry signal from RenewBanner above the fold. Format as
  // "renews 12 Aug 2026" (active) or "expired 12 Aug 2026" (past). Days-
  // until is omitted; RenewBanner is responsible for the "X days left"
  // urgency call-out.
  let expiryTail: string | null = null;
  if (info.source === "school" && info.expires_at) {
    const t = new Date(info.expires_at);
    if (!Number.isNaN(t.getTime())) {
      const formatted = t.toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" });
      // Date.now() in render is technically impure, but the only
      // observable effect is the badge label flipping from "renews"
      // to "expired" the first render after midnight UTC — exactly
      // what we want.
      // eslint-disable-next-line react-hooks/purity
      expiryTail = t.getTime() < Date.now() ? `expired ${formatted}` : `renews ${formatted}`;
    }
  }

  return (
    <div
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold"
      style={{ background: tone.bg, color: tone.fg, border: `1px solid ${tone.border}` }}
    >
      <Icon size={14} />
      <span className="opacity-70">{info.source === "school" ? `${info.school_name || "School"}:` : "Plan:"}</span>
      <span>{info.label}</span>
      {expiryTail && (
        <span className="opacity-60 font-normal">· {expiryTail}</span>
      )}
      {showUpsell && (
        <Link href="/pricing" className="ml-1 inline-flex items-center gap-0.5 hover:underline opacity-90">
          Upgrade <ArrowRight size={11} />
        </Link>
      )}
    </div>
  );
}

function prettyTier(tier: string): string {
  return tier.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function toneFor(tier: string): { bg: string; fg: string; border: string } {
  if (tier.startsWith("school_plus")) return { bg: "#ede9fe", fg: "#5b21b6", border: "#c4b5fd" };
  if (tier.startsWith("school_")) return { bg: "#e0f2fe", fg: "#075985", border: "#7dd3fc" };
  if (tier === "premium_plus") return { bg: "#ede9fe", fg: "#5b21b6", border: "#c4b5fd" };
  if (tier === "premium" || tier === "individual") return { bg: "#d1fae5", fg: "#065f46", border: "#6ee7b7" };
  return { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" };
}
