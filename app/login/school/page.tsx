"use client";

// =============================================================================
// /login/school — sign-in for school accounts (Admin Head / Teacher / School
// student)
// =============================================================================
// Three tabs because the same school has three audiences with three different
// identifiers and three different landing pages, but they share one auth
// surface (one Supabase signInWithPassword call). Tabs only customise:
//   - heading copy
//   - identifier label (Email vs Username)
//   - role gate after sign-in (super_teacher / teacher / school student)
//
// Independent students live at /login/student. Platform admins live at /staff.
// =============================================================================

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Eye, EyeOff, GraduationCap, BookOpen, Building2, KeyRound, ArrowLeft } from "lucide-react";

const SCHOOL_DOMAIN = "bloomiq.invalid";
const TOS_VERSION = "2026-04-30";

type SchoolTab = "admin" | "teacher" | "student";

type TabMeta = {
  label: string;
  heading: string;
  identifierLabel: string;
  identifierPlaceholder: string;
  hint: string;
  Icon: React.ComponentType<{ size?: number }>;
};

const TABS: Record<SchoolTab, TabMeta> = {
  admin: {
    label: "Admin Head",
    heading: "Admin Head sign in",
    identifierLabel: "Work email",
    identifierPlaceholder: "principal@school.edu",
    hint: "Principals — sign in with the email BloomIQ invited. Deputies sign in here too.",
    Icon: Building2,
  },
  teacher: {
    label: "Teacher",
    heading: "Teacher sign in",
    identifierLabel: "Work email",
    identifierPlaceholder: "you@school.edu",
    hint: "Teachers sign in with the email you used at signup or in your invite.",
    Icon: BookOpen,
  },
  student: {
    label: "School student",
    heading: "School student sign in",
    identifierLabel: "Username",
    identifierPlaceholder: "the username your teacher gave you",
    hint: "Created by your teacher. No email needed — just the username and password they shared.",
    Icon: GraduationCap,
  },
};

function readNextParam(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get("next");
  } catch {
    return null;
  }
}
function readReasonParam(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get("reason");
  } catch {
    return null;
  }
}
function readSignedupParam(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get("signedup");
  } catch {
    return null;
  }
}

export default function SchoolLoginPage() {
  const router = useRouter();

  // Initial tab can be hinted via ?tab= so the post-signup redirect for
  // a brand-new teacher lands them directly on the Teacher tab instead of
  // the (default) Admin Head tab. Falls back to "admin" for unknown values.
  function readInitialTab(): SchoolTab {
    if (typeof window === "undefined") return "admin";
    try {
      const t = new URLSearchParams(window.location.search).get("tab");
      if (t === "admin" || t === "teacher" || t === "student") return t;
    } catch { /* ignore */ }
    return "admin";
  }
  const [tab, setTab] = useState<SchoolTab>(readInitialTab());
  const meta: TabMeta = TABS[tab];

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [forgotMode, setForgotMode] = useState(false);
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotMsg, setForgotMsg] = useState<string | null>(null);

  const [tosOk, setTosOk] = useState(false);

  const [mfaPhase, setMfaPhase] = useState<"idle" | "needs_code">("idle");
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null);
  const [mfaChallengeId, setMfaChallengeId] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaBusy, setMfaBusy] = useState(false);

  async function sendReset() {
    setErr(null);
    setForgotMsg(null);
    const raw = identifier.trim();
    if (!raw || !raw.includes("@")) {
      setErr("Enter your email address (not username) to get a reset link.");
      return;
    }
    setForgotBusy(true);
    try {
      const sb = supabaseBrowser();
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const { error } = await sb.auth.resetPasswordForEmail(raw, {
        redirectTo: `${origin}/auth/set-password`,
      });
      if (error) throw error;
      setForgotMsg(
        `If ${raw} has a BloomIQ account, we've emailed a password reset link. Open it on this device to finish.`
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not send reset email.");
    } finally {
      setForgotBusy(false);
    }
  }

  async function audit(token: string) {
    try {
      await fetch("/api/login-audit", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch { /* best-effort */ }
  }

  async function finalizeSignIn(): Promise<void> {
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) throw new Error("Signed in but session is empty. Please try again.");

    const userMeta = (user.user_metadata || {}) as { tos_version?: string };
    if (userMeta.tos_version !== TOS_VERSION) {
      try {
        await sb.auth.updateUser({
          data: { tos_accepted_at: new Date().toISOString(), tos_version: TOS_VERSION },
        });
      } catch { /* ignore */ }
    }

    const { data: { session } } = await sb.auth.getSession();
    if (session) audit(session.access_token);

    let role = "";
    let isPlatformAdmin = false;
    if (session) {
      try {
        const meRes = await fetch("/api/auth/me", {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: "no-store",
        });
        if (meRes.ok) {
          const me = await meRes.json();
          role = String(me.role || "");
          isPlatformAdmin = !!me.platform_admin;
        }
      } catch { /* fall through */ }
    }
    if (!role) {
      role = String((user.user_metadata as { role?: string } | undefined)?.role || "");
    }

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

    const next = readNextParam();
    const home =
      isPlatformAdmin ? "/admin/onboard-school" :
      role === "teacher" ? "/teacher" :
      role === "super_teacher" ? "/school" :
      "/student";
    router.push(next || home);
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
      const raw = identifier.trim();
      if (!raw) throw new Error("Enter your email or username.");

      // School-student tab takes a username and we synthesize the email
      // domain. Admin Head / Teacher tabs require a real email.
      let email: string;
      if (tab === "student") {
        if (raw.includes("@")) {
          throw new Error("Type your username, not an email. Independent students sign in at /login/student.");
        }
        email = `${raw.toLowerCase()}@${SCHOOL_DOMAIN}`;
      } else {
        if (!raw.includes("@")) {
          throw new Error("Enter your work email.");
        }
        email = raw;
      }

      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) {
        throw new Error("Email/username or password is incorrect.");
      }

      const { data: { user } } = await sb.auth.getUser();
      if (!user) throw new Error("Signed in but session is empty.");

      // Role gate via /api/auth/me (service-role lookup, no RLS race).
      const { data: { session: gateSess } } = await sb.auth.getSession();
      let role = "";
      let isSchoolStudent = false;
      let isPlatformAdmin = false;
      if (gateSess) {
        try {
          const meRes = await fetch("/api/auth/me", {
            headers: { Authorization: `Bearer ${gateSess.access_token}` },
            cache: "no-store",
          });
          if (meRes.ok) {
            const me = await meRes.json();
            role = String(me.role || "");
            isSchoolStudent = !!me.is_school_student;
            isPlatformAdmin = !!me.platform_admin;
          }
        } catch { /* fall through to metadata fallback */ }
      }
      if (!role) {
        role = String((user.user_metadata as { role?: string } | undefined)?.role || "");
      }

      if (isPlatformAdmin) {
        try { await sb.auth.signOut(); } catch { /* ignore */ }
        throw new Error("This account belongs to BloomIQ staff. Please sign in via /staff.");
      }

      let allowed = false;
      let expectedTabLabel = "";
      if (tab === "admin") {
        // Admin Head + Deputies are both role='super_teacher'.
        allowed = role === "super_teacher";
        expectedTabLabel = "Admin Head";
      } else if (tab === "teacher") {
        allowed = role === "teacher";
        expectedTabLabel = "Teacher";
      } else if (tab === "student") {
        allowed = role === "student" && isSchoolStudent;
        expectedTabLabel = "School student";
      }
      if (!allowed) {
        try { await sb.auth.signOut(); } catch { /* ignore */ }
        if (role === "student" && !isSchoolStudent) {
          throw new Error("That looks like an independent-student account. Sign in at /login/student.");
        }
        throw new Error(`This sign-in is for ${expectedTabLabel} only. Pick the right tab above.`);
      }

      // School students skip MFA — many are kids without authenticator apps.
      const skipMfa = tab === "student";

      if (!skipMfa) {
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
            return;
          }
        } catch (mfaProbeErr) {
          if (process.env.NODE_ENV !== "production") {
            // eslint-disable-next-line no-console
            console.warn("[mfa] probe failed; proceeding without 2FA", mfaProbeErr);
          }
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
    <main className="min-h-screen grid place-items-center px-6 py-10 bg-gradient-to-br from-emerald-50 via-white to-sky-50">
      <div className="w-full max-w-sm">
        <Link href="/" className="flex items-center gap-2 justify-center mb-8">
          <span className="text-3xl">🌱</span>
          <span className="text-xl font-bold">BloomIQ</span>
        </Link>

        <Link
          href="/login"
          className="text-xs text-slate-500 hover:text-slate-800 inline-flex items-center gap-1 mb-3"
        >
          <ArrowLeft size={12} /> Other sign-in options
        </Link>

        <div className="card">
          {/* Three school-context tabs. Independent students use /login/student. */}
          <div
            className="grid grid-cols-3 gap-2 mb-5 p-1.5 rounded-xl"
            style={{ background: "var(--color-bg-soft, #f1f5f9)" }}
            role="tablist"
            aria-label="Sign in as"
          >
            {(["admin", "teacher", "student"] as SchoolTab[]).map((k) => {
              const t = TABS[k];
              const active = k === tab;
              return (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  suppressHydrationWarning
                  onClick={() => { setTab(k); setIdentifier(""); setErr(null); }}
                  className="inline-flex flex-col items-center justify-center gap-1 text-[11px] sm:text-xs font-semibold py-2.5 px-2 rounded-lg transition whitespace-nowrap"
                  style={{
                    background: active ? "var(--color-card, #fff)" : "transparent",
                    color: active ? "var(--brand-700, #047857)" : "var(--color-fg-soft, #475569)",
                    boxShadow: active ? "0 1px 3px rgba(0,0,0,0.08)" : undefined,
                  }}
                >
                  <t.Icon size={16} />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>

          <h1 className="text-2xl font-bold mb-6 flex items-center gap-2">
            <meta.Icon size={22} /> {meta.heading}
          </h1>

          {readReasonParam() === "idle" && (
            <div className="mb-4 text-xs px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-900">
              You were signed out automatically after 30 minutes of inactivity. Please sign in again.
            </div>
          )}
          {readReasonParam() === "elsewhere" && (
            <div className="mb-4 text-xs px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-900">
              Your session was signed out because this account signed in on another device.
            </div>
          )}
          {readSignedupParam() === "1" && (
            <div className="mb-4 text-xs px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-900">
              Account created. Please sign in to continue.
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="label">{meta.identifierLabel}</label>
              <input
                className="input"
                type="text"
                required
                autoFocus
                autoComplete="username"
                value={identifier}
                onChange={(e) => { setIdentifier(e.target.value); setForgotMsg(null); }}
                placeholder={meta.identifierPlaceholder}
                suppressHydrationWarning
              />
            </div>
            <div>
              <label className="label flex items-center justify-between">
                <span>Password</span>
                {tab !== "student" && (
                  <button
                    type="button"
                    className="text-xs text-emerald-700 hover:underline font-semibold"
                    onClick={() => { setForgotMode((v) => !v); setForgotMsg(null); setErr(null); }}
                    suppressHydrationWarning
                  >
                    {forgotMode ? "Cancel" : "Forgot password?"}
                  </button>
                )}
              </label>
              <div className="relative">
                <input
                  className="input pr-10"
                  type={showPwd ? "text" : "password"}
                  required={!forgotMode}
                  disabled={forgotMode}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  suppressHydrationWarning
                />
                <button
                  type="button"
                  onClick={() => setShowPwd((v) => !v)}
                  className="absolute inset-y-0 right-2 my-auto text-slate-500 hover:text-slate-700 p-1 disabled:opacity-30"
                  aria-label={showPwd ? "Hide password" : "Show password"}
                  disabled={forgotMode}
                  tabIndex={-1}
                  suppressHydrationWarning
                >
                  {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {forgotMode && (
                <p className="text-xs muted mt-1">
                  Type your email above, then click <strong>Send reset link</strong>.
                </p>
              )}
              {tab === "student" && (
                <p className="text-xs muted mt-1">
                  Forgot your password? Ask your teacher to reset it from the school dashboard.
                </p>
              )}
            </div>
            {err && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
                {err}
              </div>
            )}
            {forgotMsg && (
              <div className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded-lg">
                {forgotMsg}
              </div>
            )}
            {!forgotMode && mfaPhase === "idle" && (
              <label className="flex items-start gap-2 text-xs text-slate-700 leading-relaxed">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={tosOk}
                  onChange={(e) => setTosOk(e.target.checked)}
                  suppressHydrationWarning
                />
                <span>
                  I agree to BloomIQ&rsquo;s{" "}
                  <Link href="/terms" className="text-emerald-700 hover:underline font-semibold">Terms of Service</Link>{" "}
                  and{" "}
                  <Link href="/privacy" className="text-emerald-700 hover:underline font-semibold">Privacy Policy</Link>.
                </span>
              </label>
            )}

            {mfaPhase === "needs_code" && (
              <div className="rounded-lg border-2 border-emerald-300 bg-emerald-50 px-3 py-3 space-y-2">
                <div className="flex items-center gap-2 font-semibold text-emerald-900 text-sm">
                  <KeyRound size={16} /> Enter your 2FA code
                </div>
                <p className="text-xs text-emerald-900/80">
                  Open your authenticator app (Google Authenticator, 1Password, Authy, etc.) and enter the current 6-digit code for BloomIQ.
                </p>
                <input
                  className="input font-mono tracking-widest text-center"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="123456"
                  autoFocus
                  suppressHydrationWarning
                />
              </div>
            )}

            {forgotMode ? (
              <button
                type="button"
                className="btn btn-primary w-full"
                disabled={forgotBusy}
                onClick={sendReset}
                suppressHydrationWarning
              >
                {forgotBusy && <span className="spinner" />} Send reset link
              </button>
            ) : mfaPhase === "needs_code" ? (
              <button
                type="button"
                className="btn btn-primary w-full"
                disabled={mfaBusy || mfaCode.length !== 6}
                onClick={verifyMfa}
                suppressHydrationWarning
              >
                {mfaBusy && <span className="spinner" />} Verify code
              </button>
            ) : (
              <button
                className="btn btn-primary w-full"
                disabled={busy || !tosOk}
                suppressHydrationWarning
              >
                {busy && <span className="spinner" />} Sign in
              </button>
            )}
          </form>

          {/* Footer CTA — tab-aware. Admin Head accounts are invite-only,
              so we surface a "Talk to us" mailto. Teacher accounts can
              self-serve via /signup. School students don't sign up — their
              teacher creates them. */}
          {tab === "admin" ? (
            <div className="mt-6 text-sm text-center text-slate-600">
              Setting up a new school?{" "}
              <a
                href="mailto:hello@bloomiq.app?subject=BloomIQ%20school%20onboarding"
                className="text-emerald-700 font-semibold"
              >
                Talk to us
              </a>{" "}
              and we&apos;ll send you an invite. Admin Head accounts are
              provisioned by BloomIQ — there is no self-serve sign-up.
            </div>
          ) : tab === "teacher" ? (
            <div className="mt-6 text-sm text-center text-slate-600">
              New here?{" "}
              <Link href="/signup?role=teacher" className="text-emerald-700 font-semibold">Create a teacher account</Link>
            </div>
          ) : (
            <div className="mt-6 text-xs text-center text-slate-500">
              Your account is created by your teacher. If you don&apos;t have a username, ask them.
            </div>
          )}
        </div>

        <p className="text-xs text-slate-500 text-center mt-4">
          {meta.hint}
        </p>
      </div>
    </main>
  );
}
