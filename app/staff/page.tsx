"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Eye, EyeOff, ShieldCheck, KeyRound, AlertCircle } from "lucide-react";

const TOS_VERSION = "2026-04-30";

/**
 * /staff — internal BloomIQ-staff sign-in.
 *
 * Why this page exists:
 *   The public /login intentionally hides the Platform tab so casual
 *   visitors never see a "Platform" option. Until BloomIQ has a company
 *   intranet with SSO, internal staff need a clean, dedicated entry
 *   point. This is it.
 *
 * Visibility / discoverability:
 *   - Path is non-obvious and never linked anywhere on the public site
 *     (not in nav, not in footer, not in the public sitemap). Staff
 *     bookmark it after the /admin/team invite email gives them the URL.
 *   - When the company intranet ships, redirect /staff to the intranet
 *     SSO entry point.
 *
 * Auth behaviour:
 *   Calls the same supabase.auth.signInWithPassword as /login, but
 *   gates on profiles.platform_admin = true after sign-in. A non-admin
 *   account that somehow lands here is signed out immediately with
 *   "incorrect credentials" — the page does NOT leak whether the email
 *   exists or whether it's just not staff.
 *
 *   2FA: if the user has a verified TOTP factor, the second-factor
 *   challenge is required before redirect. (See same logic in /login.)
 *
 *   ToS acceptance reuses /login's TOS_VERSION constant.
 */

export default function StaffLoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [tosOk, setTosOk] = useState(false);

  // 2FA challenge phase. After password validates, if a TOTP factor exists,
  // we pause for the 6-digit code before redirecting.
  const [mfaPhase, setMfaPhase] = useState<"idle" | "needs_code">("idle");
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null);
  const [mfaChallengeId, setMfaChallengeId] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaBusy, setMfaBusy] = useState(false);

  async function finalizeSignIn() {
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) {
      setErr("Signed in but session is empty. Try again.");
      return;
    }
    // Stamp ToS acceptance into user_metadata so /admin pages can
    // re-confirm later.
    try {
      await sb.auth.updateUser({
        data: { tos_accepted_at: new Date().toISOString(), tos_version: TOS_VERSION },
      });
    } catch { /* non-fatal */ }
    // Single-session policy — revoke other refresh tokens AND stamp
    // current JWT iat so older access tokens on other devices fail
    // /api/auth/me's iat check.
    try { await sb.auth.signOut({ scope: "others" }); } catch { /* ignore */ }
    try {
      const fresh = await sb.auth.getSession();
      const tk = fresh.data.session?.access_token;
      if (tk) {
        await fetch("/api/auth/claim-session", {
          method: "POST",
          headers: { Authorization: `Bearer ${tk}` },
        });
      }
    } catch { /* ignore */ }
    // Canonical post-login destination for platform admins is the
    // dashboard. The previous redirect to /admin/onboard-school
    // bypassed the rollup view and forced operators through the
    // onboarding form even when they were just signing in.
    router.push("/admin/dashboard");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!tosOk) {
      setErr("Please tick the box to accept the Terms of Service and Privacy Policy.");
      return;
    }
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const raw = email.trim();
      if (!raw || !raw.includes("@")) throw new Error("Enter your BloomIQ staff email.");

      const { error } = await sb.auth.signInWithPassword({ email: raw, password });
      if (error) {
        // Ambiguous error — does NOT leak whether the email exists.
        throw new Error("Incorrect credentials.");
      }

      // Verify platform_admin AFTER auth succeeds. Read via the
      // service-role /api/auth/me endpoint — the user-token profiles
      // select raced RLS on the edge and returned null for valid staff
      // accounts, which then surfaced as "Incorrect credentials". A
      // non-staff account that somehow tries here gets signed out and
      // sees the same generic message — no information leak about
      // whether the email is staff or not.
      const { data: { session: fresh } } = await sb.auth.getSession();
      const tk = fresh?.access_token;
      if (!tk) throw new Error("Signed in but session is empty.");
      let isPlatformAdmin = false;
      try {
        const r = await fetch("/api/auth/me", {
          headers: { Authorization: `Bearer ${tk}` },
          cache: "no-store",
        });
        if (r.ok) {
          const j = await r.json() as { platform_admin?: boolean };
          isPlatformAdmin = !!j.platform_admin;
        }
      } catch { /* fall through — treated as non-admin below */ }
      if (!isPlatformAdmin) {
        try { await sb.auth.signOut(); } catch { /* ignore */ }
        throw new Error("Incorrect credentials.");
      }

      // 2FA challenge if enrolled. Same handler shape as /login.
      try {
        const { data: factors } = await sb.auth.mfa.listFactors();
        const totp = (factors?.totp || []).find((f) => f.status === "verified");
        if (totp) {
          const { data: challenge, error: chErr } = await sb.auth.mfa.challenge({ factorId: totp.id });
          if (chErr || !challenge) throw new Error(chErr?.message || "Could not start 2FA challenge.");
          setMfaFactorId(totp.id);
          setMfaChallengeId(challenge.id);
          setMfaPhase("needs_code");
          setBusy(false);
          return; // wait for verifyMfa
        }
      } catch (mfaProbeErr) {
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.warn("[staff/mfa] probe failed; proceeding without 2FA", mfaProbeErr);
        }
      }

      await finalizeSignIn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyMfa() {
    setErr(null);
    if (!mfaFactorId || !mfaChallengeId) return;
    if (!/^\d{6}$/.test(mfaCode.trim())) {
      setErr("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setMfaBusy(true);
    try {
      const sb = supabaseBrowser();
      const { error } = await sb.auth.mfa.verify({
        factorId: mfaFactorId,
        challengeId: mfaChallengeId,
        code: mfaCode.trim(),
      });
      if (error) throw new Error(error.message || "Invalid code. Try again.");
      await finalizeSignIn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "2FA verification failed.");
    } finally {
      setMfaBusy(false);
    }
  }

  return (
    <main className="min-h-screen grid place-items-center px-6 py-10 bg-gradient-to-br from-slate-50 via-white to-slate-100">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 justify-center mb-6">
          <span className="text-3xl">🌱</span>
          <span className="text-xl font-bold">BloomIQ</span>
        </div>

        <div className="card">
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck size={18} style={{ color: "var(--brand-700, #047857)" }} />
            <h1 className="text-lg font-bold">BloomIQ staff sign in</h1>
          </div>
          <p className="muted text-xs mb-5">
            Internal-only entry point. If you reached this page by mistake,{" "}
            <Link href="/login" className="font-semibold underline">go to the public sign-in</Link>.
          </p>

          {mfaPhase === "idle" && (
            <form onSubmit={submit} className="space-y-3">
              <div>
                <label className="label">Email</label>
                <input
                  className="input"
                  type="email"
                  required
                  autoFocus
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@bloomiq.example"
                  suppressHydrationWarning
                />
              </div>

              <div>
                <label className="label">Password</label>
                <div className="relative">
                  <input
                    className="input pr-10"
                    type={showPwd ? "text" : "password"}
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    suppressHydrationWarning
                  />
                  <button
                    type="button"
                    onClick={() => setShowPwd((v) => !v)}
                    className="absolute inset-y-0 right-2 my-auto text-slate-500 hover:text-slate-700 p-1"
                    aria-label={showPwd ? "Hide password" : "Show password"}
                    tabIndex={-1}
                    suppressHydrationWarning
                  >
                    {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <label className="flex items-start gap-2 text-xs muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={tosOk}
                  onChange={(e) => setTosOk(e.target.checked)}
                  className="mt-0.5"
                  suppressHydrationWarning
                />
                <span>
                  I agree to BloomIQ&apos;s{" "}
                  <Link href="/terms" target="_blank" className="text-emerald-700 hover:underline">Terms of Service</Link>{" "}
                  and{" "}
                  <Link href="/privacy" target="_blank" className="text-emerald-700 hover:underline">Privacy Policy</Link>.
                </span>
              </label>

              {err && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-start gap-2">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" /> {err}
                </div>
              )}

              <button
                type="submit"
                className="btn btn-primary w-full"
                disabled={busy || !tosOk}
                suppressHydrationWarning
              >
                {busy ? <span className="spinner" /> : <ShieldCheck size={14} />} Sign in
              </button>
            </form>
          )}

          {/* 2FA challenge phase */}
          {mfaPhase === "needs_code" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <KeyRound size={16} style={{ color: "var(--brand-700)" }} />
                <p className="text-sm">
                  Enter the 6-digit code from your authenticator app.
                </p>
              </div>
              <input
                className="input tabular-nums text-center text-lg tracking-[0.5em] font-bold"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                autoFocus
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                suppressHydrationWarning
              />
              {err && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-start gap-2">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" /> {err}
                </div>
              )}
              <button
                type="button"
                onClick={verifyMfa}
                disabled={mfaBusy || mfaCode.length !== 6}
                className="btn btn-primary w-full"
              >
                {mfaBusy ? <span className="spinner" /> : <KeyRound size={14} />} Verify code
              </button>
              <button
                type="button"
                onClick={() => { setMfaPhase("idle"); setMfaCode(""); setErr(null); }}
                className="text-xs muted hover:underline w-full text-center"
              >
                Cancel and start over
              </button>
            </div>
          )}
        </div>

        <p className="text-[11px] muted text-center mt-4">
          BloomIQ staff only. Public users — please use{" "}
          <Link href="/login" className="font-semibold underline">/login</Link>.
        </p>
      </div>
    </main>
  );
}
