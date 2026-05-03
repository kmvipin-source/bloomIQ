"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Eye, EyeOff, GraduationCap, BookOpen, Building2, ShieldCheck, KeyRound } from "lucide-react";

const SCHOOL_DOMAIN = "bloomiq.invalid";
const TOS_VERSION = "2026-04-30";

type RoleTab = "student" | "teacher" | "school" | "admin";
type StudentMode = "school" | "independent";

type TabMeta = {
  label: string;
  heading: string;
  identifierLabel: string;
  identifierPlaceholder: string;
  hint: string;
  Icon: React.ComponentType<{ size?: number }>;
};

// Auth call is identical for every tab + mode — these strings only customise
// heading, identifier label, and hints so users know which account type they
// are signing in with.
const ROLE_TABS: Record<RoleTab, TabMeta> = {
  student: {
    label: "Student",
    heading: "Student sign in",
    identifierLabel: "Email or username",
    identifierPlaceholder: "your.email@example.com or your.username",
    hint: "Pick School student if your teacher gave you a username, or Independent if you signed up yourself with email.",
    Icon: GraduationCap,
  },
  teacher: {
    label: "Teacher",
    heading: "Teacher sign in",
    identifierLabel: "Work email",
    identifierPlaceholder: "you@school.edu",
    hint: "Teachers sign in with the email you used at signup.",
    Icon: BookOpen,
  },
  school: {
    label: "Admin",
    heading: "Admin Head (Principal) sign in",
    identifierLabel: "Work email",
    identifierPlaceholder: "principal@school.edu",
    hint: "School Admin Heads / Principals — sign in with the email BloomIQ invited.",
    Icon: Building2,
  },
  admin: {
    label: "Platform",
    heading: "Platform Admin sign in",
    identifierLabel: "Email",
    identifierPlaceholder: "you@bloomiq.example",
    hint: "BloomIQ staff only.",
    Icon: ShieldCheck,
  },
};

const STUDENT_MODES: Record<StudentMode, TabMeta> = {
  school: {
    label: "School student",
    heading: "School student sign in",
    identifierLabel: "Username",
    identifierPlaceholder: "the username your teacher gave you",
    hint: "Created by your teacher. No email needed — just the username and password they shared.",
    Icon: GraduationCap,
  },
  independent: {
    label: "Independent student",
    heading: "Independent student sign in",
    identifierLabel: "Email",
    identifierPlaceholder: "you@example.com",
    hint: "Self-signup learner with a personal subscription. Sign in with the email you used at signup.",
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

export default function LoginPage() {
  const router = useRouter();

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [forgotMode, setForgotMode] = useState(false);
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotMsg, setForgotMsg] = useState<string | null>(null);

  const [tosOk, setTosOk] = useState(false);

  // Adaptive bot deterrent. Set true the moment we hit FAIL_THRESHOLD on
  // this identifier; user must solve a one-shot math puzzle to re-enable.

  // 2FA state. After password succeeds, if the user has a verified TOTP
  // factor, we pause and ask for the 6-digit code.
  const [mfaPhase, setMfaPhase] = useState<"idle" | "needs_code">("idle");
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null);
  const [mfaChallengeId, setMfaChallengeId] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaBusy, setMfaBusy] = useState(false);

  const [roleTab, setRoleTab] = useState<RoleTab>("student");
  const [studentMode, setStudentMode] = useState<StudentMode>("school");
  // When the Student tab is active, the sub-mode (school vs independent)
  // overrides the generic Student labels with the more specific ones.
  const tab: TabMeta = roleTab === "student" ? STUDENT_MODES[studentMode] : ROLE_TABS[roleTab];

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

    const meta = (user.user_metadata || {}) as { tos_version?: string };
    if (meta.tos_version !== TOS_VERSION) {
      try {
        await sb.auth.updateUser({
          data: { tos_accepted_at: new Date().toISOString(), tos_version: TOS_VERSION },
        });
      } catch { /* ignore */ }
    }

    const { data: prof } = await sb
      .from("profiles")
      .select("role, is_school_student, platform_admin")
      .eq("id", user.id)
      .single();

    const { data: { session } } = await sb.auth.getSession();
    if (session) audit(session.access_token);

    const isIndependentStudent =
      prof?.role === "student" && !prof?.is_school_student;
    if (isIndependentStudent) {
      try { await sb.auth.signOut({ scope: "others" }); } catch { /* ignore */ }
    }

    const next = readNextParam();
    const home =
      prof?.platform_admin ? "/admin/onboard-school" :
      prof?.role === "teacher" ? "/teacher" :
      prof?.role === "super_teacher" ? "/school" :
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

      const email = raw.includes("@") ? raw : `${raw.toLowerCase()}@${SCHOOL_DOMAIN}`;

      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) {
        throw new Error("Email/username or password is incorrect.");
      }

      // Determine MFA requirement. School students are skipped — many are
      // kids without authenticator apps; their teacher manages credentials
      // already. Everyone else who has a verified TOTP factor must clear
      // the second challenge before we redirect.
      const { data: { user } } = await sb.auth.getUser();
      if (!user) throw new Error("Signed in but session is empty.");

      const { data: prof, error: profErr } = await sb
        .from("profiles")
        .select("role, is_school_student, platform_admin")
        .eq("id", user.id)
        .maybeSingle();

      // ===== Role-tab gate =====
      // Each tab only authenticates accounts of its own role. The Admin
      // Head tab additionally accepts platform_admin so a single ops
      // login surface works for both school principals AND BloomIQ staff.
      // If the profile row hasn't materialised yet (fresh signup whose
      // on_auth_user_created trigger races the next sign-in), fall back
      // to the role stamped into auth.users.user_metadata so the user
      // doesn't get stuck on "This sign-in is for X only".
      const metaRole = String((user.user_metadata as { role?: string } | undefined)?.role || "");
      const role = prof?.role || metaRole || "";
      const isSchoolStudent = !!prof?.is_school_student;
      const isPlatformAdmin = !!prof?.platform_admin;
      if (profErr && process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[login] profile lookup failed; falling back to user_metadata", profErr);
      }
      let allowed = false;
      let expectedTabLabel = "";
      if (roleTab === "student" && studentMode === "independent") {
        allowed = role === "student" && !isSchoolStudent;
        expectedTabLabel = "Student → Independent";
      } else if (roleTab === "student" && studentMode === "school") {
        allowed = role === "student" && isSchoolStudent;
        expectedTabLabel = "Student → School student";
      } else if (roleTab === "teacher") {
        allowed = role === "teacher";
        expectedTabLabel = "Teacher";
      } else if (roleTab === "school") {
        // Admin Head tab is school principals only. Platform admins must
        // use /staff so the public surface never authenticates a staff
        // account.
        allowed = role === "super_teacher";
        expectedTabLabel = "Admin Head (Principal)";
      } else if (roleTab === "platform") {
        allowed = isPlatformAdmin;
        expectedTabLabel = "Platform Admin";
      }
      if (!allowed) {
        try { await sb.auth.signOut(); } catch { /* ignore */ }
        throw new Error(
          `This sign-in is for ${expectedTabLabel} only. Other role logins are not accepted here.`
        );
      }

      const skipMfa = isSchoolStudent;

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
            return; // wait for verifyMfa()
          }
        } catch (mfaProbeErr) {
          // If MFA isn't enabled at the project level, listFactors errors.
          // That's OK — proceed without MFA.
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

        <div className="card">
          {/* Role tabs — purely informational. The same Supabase signin call
              fires regardless of the active tab; tabs only re-label fields
              and the heading so users know which kind of account they're
              signing in with. */}
          {/* Platform Admin is intentionally hidden from /login — staff use
              the same form (auth is single-endpoint) but the tab is private,
              so casual visitors don't see a 'Platform' option. */}
          <div
            className="grid grid-cols-3 gap-2 mb-5 p-1.5 rounded-xl"
            style={{ background: "var(--color-bg-soft, #f1f5f9)" }}
            role="tablist"
            aria-label="Sign in as"
          >
            {(["student", "teacher", "school"] as RoleTab[]).map((k) => {
              const t = ROLE_TABS[k];
              const active = k === roleTab;
              return (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  suppressHydrationWarning
                  onClick={() => setRoleTab(k)}
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

          {/* Student sub-mode pill — only visible when the Student tab is
              active. Explicit because the school-vs-independent distinction
              is the most common confusion at /login. */}
          {roleTab === "student" && (
            <div
              className="inline-flex p-1 rounded-full mb-4 text-xs font-semibold"
              style={{ background: "var(--color-bg-soft, #f1f5f9)" }}
              role="radiogroup"
              aria-label="Student type"
            >
              {(Object.keys(STUDENT_MODES) as StudentMode[]).map((m) => {
                const active = m === studentMode;
                return (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    suppressHydrationWarning
                    onClick={() => setStudentMode(m)}
                    className="px-3 py-1.5 rounded-full transition"
                    style={{
                      background: active ? "var(--color-card, #fff)" : "transparent",
                      color: active ? "var(--brand-700, #047857)" : "var(--color-fg-soft, #475569)",
                      boxShadow: active ? "0 1px 3px rgba(0,0,0,0.08)" : undefined,
                    }}
                  >
                    {STUDENT_MODES[m].label}
                  </button>
                );
              })}
            </div>
          )}

          <h1 className="text-2xl font-bold mb-6 flex items-center gap-2">
            <tab.Icon size={22} /> {tab.heading}
          </h1>

          {readReasonParam() === "idle" && (
            <div className="mb-4 text-xs px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-900">
              You were signed out automatically after 30 minutes of inactivity. Please sign in again.
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="label">{tab.identifierLabel}</label>
              <input
                className="input"
                type="text"
                required
                autoFocus
                autoComplete="username"
                value={identifier}
                onChange={(e) => { setIdentifier(e.target.value); setForgotMsg(null); }}
                placeholder={tab.identifierPlaceholder}
                suppressHydrationWarning
              />
            </div>
            <div>
              <label className="label flex items-center justify-between">
                <span>Password</span>
                <button
                  type="button"
                  className="text-xs text-emerald-700 hover:underline font-semibold"
                  onClick={() => { setForgotMode((v) => !v); setForgotMsg(null); setErr(null); }}
                  suppressHydrationWarning
                >
                  {forgotMode ? "Cancel" : "Forgot password?"}
                </button>
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
            {/* Explicit click-wrap. Required on every sign-in so consent is
                refreshed each session and we can re-stamp tos_version onto
                user_metadata when Terms are updated. */}
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

            {/* 2FA challenge — only renders after the password step succeeds
                AND the user has a verified TOTP factor. */}
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

          <div className="mt-6 text-sm text-center text-slate-600">
            New here?{" "}
            <Link href="/signup" className="text-emerald-700 font-semibold">Create an account</Link>
          </div>
        </div>

        <p className="text-xs text-slate-500 text-center mt-4">
          {tab.hint}
        </p>
      </div>
    </main>
  );
}
