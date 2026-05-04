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
          });
          return;
        }

        // Self path: independent student.
        if (prof.role === "student" && !inSchool) {
          const { data: sub } = await sb
            .from("subscriptions")
            .select("plan_id, status, expires_at, tier")
            .eq("user_id", user.id)
            .maybeSingle();
          let label = "Free";
          let tier = "free";
          if (sub?.plan_id) {
            const { data: plan } = await sb.from("plans").select("label, tier").eq("id", sub.plan_id).maybeSingle();
            if (plan) { label = plan.label; tier = plan.tier; }
            else if (sub.tier) { label = prettyTier(sub.tier); tier = sub.tier; }
            // Treat expired / inactive as free.
            if (sub.status && sub.status !== "active") { label = "Free"; tier = "free"; }
            if (sub.expires_at && new Date(sub.expires_at) < new Date()) { label = "Free"; tier = "free"; }
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
  return (
    <div
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold"
      style={{ background: tone.bg, color: tone.fg, border: `1px solid ${tone.border}` }}
    >
      <Icon size={14} />
      <span className="opacity-70">{info.source === "school" ? `${info.school_name || "School"}:` : "Plan:"}</span>
      <span>{info.label}</span>
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
