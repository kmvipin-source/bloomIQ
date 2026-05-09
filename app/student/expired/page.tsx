"use client";

// =============================================================================
// app/student/expired/page.tsx
// -----------------------------------------------------------------------------
// Hard upgrade gate shown when a student's auto-granted Free-plan validity
// window (subscription_limits.free_trial_days) has elapsed. The student
// layout's auth-check intercepts is_free_expired=true and redirects every
// /student/* route here, so this page is the ONLY view they can access until
// they upgrade.
//
// Two doors out:
//   1. Upgrade — pick Premium or Premium Plus. Both routes lead to /pricing
//      with a tier hint so the checkout lands on the right plan card.
//   2. Sign out — for the rare case they want to abandon the account.
//
// Re-extending the Free trial is intentionally NOT offered as a self-serve
// option here. The platform admin controls the validity duration globally;
// extensions for individual users would require an admin tool.
// =============================================================================

import Link from "next/link";
import { Lock, Crown, Sparkles, ArrowRight, LogOut, Check } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

export default function ExpiredPage() {
  const router = useRouter();

  async function signOut() {
    try {
      const sb = supabaseBrowser();
      await sb.auth.signOut();
    } catch { /* ignore */ }
    router.replace("/login");
  }

  return (
    <div className="max-w-3xl mx-auto pt-12 pb-12 px-4">
      <div className="card p-6 sm:p-8"
           style={{
             background: "linear-gradient(135deg, rgba(99,102,241,0.06) 0%, rgba(245,158,11,0.06) 100%)",
             borderColor: "rgba(245,158,11,0.3)",
           }}>

        {/* Heading + lock icon — kept centered + tight to give the two
            tier cards below room to breathe. */}
        <div className="text-center">
          <div className="mx-auto w-14 h-14 grid place-items-center rounded-full mb-4"
               style={{ background: "rgba(245,158,11,0.15)" }}>
            <Lock size={26} style={{ color: "#f59e0b" }} />
          </div>
          <h1 className="text-2xl font-bold">Your free access has ended</h1>
          <p className="mt-3 text-sm opacity-80 leading-relaxed max-w-xl mx-auto">
            Pick the plan that fits how you study. Both unlock the full BloomIQ Score,
            calibration, drills, and the AI toolkit — Premium Plus adds the
            competitive-exam suite (past-paper X-ray, mock-rank predictor, and more).
          </p>
        </div>

        {/* Two-tier upgrade panel.
            - Premium  : individual paying subscribers, the everyday tier.
            - Premium+ : adds competitive-exam toolkit (past papers, mock rank).
            Each card has its own feature bullets and CTA; both deep-link to
            /pricing with a ?tier= hint so the page can highlight the right one
            (the pricing page can ignore it if it doesn't respect the param). */}
        <div className="mt-6 grid sm:grid-cols-2 gap-3">

          {/* ── Premium ── */}
          <div className="rounded-lg p-4 flex flex-col"
               style={{
                 background: "rgba(99,102,241,0.05)",
                 border: "1px solid rgba(99,102,241,0.25)",
               }}>
            <div className="flex items-center gap-2 font-semibold"
                 style={{ color: "#6366f1" }}>
              <Crown size={14} /> Premium
            </div>
            <div className="text-xs opacity-70 mt-0.5">Most learners pick this</div>
            <ul className="mt-3 space-y-1.5 text-sm opacity-90 flex-1">
              <li className="flex gap-1.5"><Check size={14} className="mt-0.5 shrink-0" style={{ color: "#10b981" }} /> Unlimited daily drills (no 3/day cap)</li>
              <li className="flex gap-1.5"><Check size={14} className="mt-0.5 shrink-0" style={{ color: "#10b981" }} /> Full BloomIQ Score + weekly active path</li>
              <li className="flex gap-1.5"><Check size={14} className="mt-0.5 shrink-0" style={{ color: "#10b981" }} /> AI tutor + Performance Coach</li>
              <li className="flex gap-1.5"><Check size={14} className="mt-0.5 shrink-0" style={{ color: "#10b981" }} /> Adaptive practice from your weakest topics</li>
            </ul>
            <Link
              href="/pricing?tier=premium"
              className="btn btn-primary mt-4 flex items-center justify-center gap-2 py-2.5"
              style={{ background: "#6366f1", color: "white" }}
            >
              Choose Premium <ArrowRight size={14} />
            </Link>
          </div>

          {/* ── Premium Plus ── */}
          <div className="rounded-lg p-4 flex flex-col relative overflow-hidden"
               style={{
                 background: "rgba(139,92,246,0.06)",
                 border: "1px solid rgba(139,92,246,0.35)",
               }}>
            {/* "Best for exam prep" ribbon — small visual cue that this
                tier is the upsell, not the entry point. */}
            <span className="absolute top-2 right-2 text-[10px] font-bold uppercase tracking-wider rounded-full px-2 py-0.5"
                  style={{ background: "rgba(139,92,246,0.18)", color: "#5b21b6" }}>
              Best for exam prep
            </span>
            <div className="flex items-center gap-2 font-semibold"
                 style={{ color: "#5b21b6" }}>
              <Sparkles size={14} /> Premium Plus
            </div>
            <div className="text-xs opacity-70 mt-0.5">Everything in Premium, plus the competitive-exam suite</div>
            <ul className="mt-3 space-y-1.5 text-sm opacity-90 flex-1">
              <li className="flex gap-1.5"><Check size={14} className="mt-0.5 shrink-0" style={{ color: "#10b981" }} /> Everything in Premium</li>
              <li className="flex gap-1.5"><Check size={14} className="mt-0.5 shrink-0" style={{ color: "#10b981" }} /> Past-paper X-ray + trap detector</li>
              <li className="flex gap-1.5"><Check size={14} className="mt-0.5 shrink-0" style={{ color: "#10b981" }} /> Mock-rank predictor (NEET/JEE/CAT)</li>
              <li className="flex gap-1.5"><Check size={14} className="mt-0.5 shrink-0" style={{ color: "#10b981" }} /> Voice teacher + concept animations</li>
            </ul>
            <Link
              href="/pricing?tier=premium_plus"
              className="btn mt-4 flex items-center justify-center gap-2 py-2.5"
              style={{ background: "#8b5cf6", color: "white", border: "1px solid #7c3aed" }}
            >
              Choose Premium Plus <ArrowRight size={14} />
            </Link>
          </div>
        </div>

        {/* Sign out + data-preserved reassurance kept below as the
            secondary actions. */}
        <div className="mt-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-xs opacity-60 leading-relaxed text-center sm:text-left max-w-md">
            Your data (calibration, score history, attempts) is preserved.
            Upgrading restores access to everything immediately.
          </p>
          <button
            onClick={signOut}
            className="btn flex items-center justify-center gap-2 py-2 px-3 text-sm border"
          >
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </div>

      {/* Quiet "Compare all plans" link below in case they want the full
          /pricing comparison before committing. */}
      <div className="text-center mt-4">
        <Link href="/pricing" className="text-xs muted hover:underline">
          Compare all plans side-by-side →
        </Link>
      </div>
    </div>
  );
}
