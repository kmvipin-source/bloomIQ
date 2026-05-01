"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Eye, EyeOff, GraduationCap, BookOpen, Building2, ShieldCheck } from "lucide-react";

const SCHOOL_DOMAIN = "bloomiq.invalid";

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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);

    try {
      const sb = supabaseBrowser();
      const raw = identifier.trim();
      if (!raw) throw new Error("Enter your email or username.");

      const email = raw.includes("@") ? raw : `${raw.toLowerCase()}@${SCHOOL_DOMAIN}`;

      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw new Error("Email/username or password is incorrect.");

      const { data: { user } } = await sb.auth.getUser();
      if (!user) throw new Error("Signed in but session is empty. Please try again.");

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
      // platform_admin is exclusive: regardless of profiles.role, send the
      // user to the admin dashboard. No hybrid student/teacher/school home.
      const home =
        prof?.platform_admin ? "/admin/onboard-school" :
        prof?.role === "teacher" ? "/teacher" :
        prof?.role === "super_teacher" ? "/school" :
        "/student";
      router.push(next || home);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Sign in failed.");
    } finally {
      setBusy(false);
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
          <div
            className="grid grid-cols-4 gap-2 mb-5 p-1.5 rounded-xl"
            style={{ background: "var(--color-bg-soft, #f1f5f9)" }}
            role="tablist"
            aria-label="Sign in as"
          >
            {(Object.keys(ROLE_TABS) as RoleTab[]).map((k) => {
              const t = ROLE_TABS[k];
              const active = k === roleTab;
              return (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={active}
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
            ) : (
              <button className="btn btn-primary w-full" disabled={busy} suppressHydrationWarning>
                {busy && <span className="spinner" />} Sign in
              </button>
            )}
          </form>

          <div className="mt-6 text-sm text-center text-slate-600">
            New here?{" "}
            <Link href="/signup" className="text-emerald-700 font-semibold">Create an account</Link>
          </div>

          {/* Implicit-acceptance legal note. Reinforces continued ToS
              acceptance for returning users so we can update Terms with
              notice and rely on continued sign-in as renewed acceptance. */}
          <p className="mt-4 text-[11px] text-slate-500 text-center leading-relaxed">
            By signing in, you agree to our{" "}
            <Link href="/terms" className="text-emerald-700 hover:underline">Terms of Service</Link>{" "}
            and{" "}
            <Link href="/privacy" className="text-emerald-700 hover:underline">Privacy Policy</Link>.
          </p>
        </div>

        <p className="text-xs text-slate-500 text-center mt-4">
          {tab.hint}
        </p>
      </div>
    </main>
  );
}
