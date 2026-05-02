"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShieldCheck, X } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";

const DASHBOARD_PREFIXES = ["/student", "/teacher", "/school", "/admin", "/parent", "/settings"];

const MAX_NUDGES = 2;

/**
 * Floating "Enable 2FA" prompt shown after login.
 *
 * - Skipped for school students (no 2FA flow for them).
 * - Skipped if the user already has a verified TOTP factor.
 * - Capped at MAX_NUDGES dismissals per user (localStorage). After that the
 *   prompt never reappears unless localStorage is cleared.
 */
export default function TwoFactorNudge() {
  const pathname = usePathname() || "";
  const [show, setShow] = useState(false);
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
          .select("is_school_student")
          .eq("id", user.id)
          .maybeSingle();
        if (prof?.is_school_student) return;

        const { data: factors } = await sb.auth.mfa.listFactors();
        const hasVerifiedTotp = !!factors?.totp?.some((f) => f.status === "verified");
        if (hasVerifiedTotp) return;

        const key = `bloomiq_2fa_nudge_count_${user.id}`;
        const count = Number(localStorage.getItem(key) || "0");
        if (count >= MAX_NUDGES) return;

        setUserId(user.id);
        setShow(true);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [onDashboard]);

  if (!onDashboard) return null;

  function dismiss() {
    if (userId) {
      const key = `bloomiq_2fa_nudge_count_${userId}`;
      const count = Number(localStorage.getItem(key) || "0");
      localStorage.setItem(key, String(count + 1));
    }
    setShow(false);
  }

  if (!show) return null;
  return (
    <div
      role="dialog"
      aria-label="Enable two-factor authentication"
      className="fixed bottom-4 right-4 z-50 max-w-sm rounded-xl border shadow-lg p-4 animate-fade-in"
      style={{
        background: "var(--color-card, #fff)",
        borderColor: "var(--color-border, #e2e8f0)",
      }}
    >
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="absolute top-2 right-2 p-1 rounded hover:bg-slate-100"
      >
        <X size={14} />
      </button>
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-9 h-9 rounded-full grid place-items-center bg-emerald-100">
          <ShieldCheck size={18} className="text-emerald-700" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm">Secure your account with 2FA</div>
          <p className="text-xs text-slate-600 mt-1">
            Add an authenticator app so a leaked password alone can&apos;t unlock your BloomIQ account.
          </p>
          <div className="flex gap-2 mt-3">
            <Link
              href="/settings/security"
              onClick={dismiss}
              className="btn btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1.5"
            >
              <ShieldCheck size={12} /> Enable 2FA
            </Link>
            <button
              onClick={dismiss}
              className="btn btn-secondary text-xs px-3 py-1.5"
            >
              Maybe later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
