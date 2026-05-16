"use client";

import Link from "next/link";
import { Lock, Sparkles, X, ArrowRight } from "lucide-react";
import type { PlanTier } from "@/lib/types";
import { tierLabel } from "@/lib/featureAccess";
import { FEATURES_BY_KEY } from "@/lib/features";

/**
 * PaywallModal
 *
 * Shows when a free user clicks a Premium-locked tile (or a Premium user
 * clicks a Premium Plus-locked tile). Explains what the feature does,
 * what tier unlocks it, and offers an "Upgrade" CTA that routes to
 * /pricing.
 *
 * Controlled component — parent owns the `open` state. Closes on:
 *   - X button
 *   - ESC (handled by the underlying div onKeyDown)
 *   - clicking the dim overlay outside the card
 */

export type PaywallProps = {
  open: boolean;
  onClose: () => void;
  // The feature key the user tried to use (e.g. "voice_tutor").
  featureKey: string | null;
  // The lowest tier that unlocks this feature, or null if unknown.
  unlockingTier: PlanTier | null;
  // The user's current tier (for "you're on Premium → upgrade to Plus").
  currentTier: PlanTier | "anon";
  // School-student variant — they can't self-upgrade since the school
  // owns the subscription. Swaps "See plans" CTA for an "Ask your school
  // admin" message + mailto link to the Admin Head.
  isSchoolStudent?: boolean;
};

export default function PaywallModal({
  open,
  onClose,
  featureKey,
  unlockingTier,
  currentTier,
  isSchoolStudent = false,
}: PaywallProps) {
  if (!open || !featureKey) return null;
  const feat = FEATURES_BY_KEY[featureKey];
  const target = unlockingTier ? tierLabel(unlockingTier) : "Premium";
  const here = tierLabel(currentTier);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 backdrop-blur-sm p-4"
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="card max-w-md w-full fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 text-emerald-700">
            <Sparkles size={18} />
            <span className="text-[10px] uppercase tracking-wider font-bold">
              Available on {target}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <h2 className="text-xl font-bold mt-2 flex items-center gap-2">
          <Lock size={18} className="text-amber-600" /> {feat?.label || "Locked feature"}
        </h2>
        {feat && (
          <p className="text-sm text-slate-600 mt-2">{feat.description}</p>
        )}

        <div className="mt-5 grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="muted uppercase tracking-wide font-bold text-[10px]">You&apos;re on</div>
            <div className="font-semibold mt-0.5">{here}</div>
          </div>
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
            <div className="muted uppercase tracking-wide font-bold text-[10px]">Unlock with</div>
            <div className="font-semibold mt-0.5 text-emerald-900">{target}</div>
          </div>
        </div>

        {isSchoolStudent ? (
          <>
            <p className="text-xs text-slate-700 mt-5 leading-relaxed">
              Your school&apos;s plan doesn&apos;t include this feature yet. Ask your
              school&apos;s Admin Head to upgrade so the whole class can use it —
              individual students can&apos;t change the school subscription.
            </p>
            <a
              href={`mailto:?subject=${encodeURIComponent(`Please enable ${feat?.label || "a feature"} on ZCORIQ`)}&body=${encodeURIComponent(
                `Hi,\n\nCan we upgrade ZCORIQ to a plan that includes ${feat?.label || "this feature"}? It would help me with ${feat?.description || "my studies"}.\n\nThanks!`
              )}`}
              className="btn btn-primary w-full mt-3 inline-flex items-center justify-center gap-2"
            >
              Email my Admin Head <ArrowRight size={14} />
            </a>
          </>
        ) : (
          <Link
            href="/pricing"
            className="btn btn-primary w-full mt-5 inline-flex items-center justify-center gap-2"
          >
            See plans <ArrowRight size={14} />
          </Link>
        )}
        <button
          type="button"
          onClick={onClose}
          className="block w-full text-center text-xs text-slate-500 hover:text-slate-700 mt-3"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
