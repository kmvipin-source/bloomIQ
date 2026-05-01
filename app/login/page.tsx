"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Eye, EyeOff } from "lucide-react";

const SCHOOL_DOMAIN = "bloomiq.invalid";

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
          <h1 className="text-2xl font-bold mb-6">Sign in</h1>

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="label">Email or username</label>
              <input
                className="input"
                type="text"
                required
                autoFocus
                autoComplete="username"
                value={identifier}
                onChange={(e) => { setIdentifier(e.target.value); setForgotMsg(null); }}
                placeholder="your.email@example.com"
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
          School student? Use the username your teacher gave you.
        </p>
      </div>
    </main>
  );
}
