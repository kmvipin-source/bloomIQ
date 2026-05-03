"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { KeyRound, ArrowRight, AlertCircle, CheckCircle2, Eye, EyeOff } from "lucide-react";

/**
 * /auth/set-password
 *
 * Universal "set or change your password" screen used by:
 *   1. Invitation flow — invite email auto-authenticates, lands here so the
 *      user picks a real password before reaching their dashboard.
 *   2. Forgot-password flow — /login's "Forgot password?" link triggers a
 *      reset email; clicking it auto-authenticates and lands here.
 *
 * Single password field with show/hide toggle and a strength meter — the
 * modern pattern (Google, Stripe, GitHub, Vercel all use this). No "confirm
 * password" field; the show/hide toggle removes the typo-defense reason.
 *
 * For invitees who never went through /signup, completing this step is the
 * point of binding ToS acceptance — we surface that explicitly below the
 * password field so it isn't a surprise.
 */

function scorePassword(p: string): number {
  if (p.length < 8) return 0;
  let s = 1;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++;
  if (/\d/.test(p) || /[^A-Za-z0-9]/.test(p)) s++;
  if (p.length >= 12) s++;
  return Math.min(s, 3);
}

const STRENGTH_LABELS = ["Too short", "Weak", "OK", "Strong"];
const STRENGTH_COLORS = ["bg-slate-200", "bg-red-400", "bg-amber-400", "bg-emerald-500"];

function SetPasswordInner() {
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get("next") || "";

  const [checking, setChecking] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const [email, setEmail] = useState<string | null>(null);

  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const strength = scorePassword(password);
  const tooShort = password.length > 0 && password.length < 8;
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const passwordOk = password.length >= 8 && hasLower && hasUpper && hasDigit;

  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (session?.user) {
        setHasSession(true);
        setEmail(session.user.email || null);
      }
      setChecking(false);
    })();
  }, []);

  async function landingFor(): Promise<string> {
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return "/login";
    const { data: prof } = await sb
      .from("profiles")
      .select("role, platform_admin")
      .eq("id", user.id)
      .single();
    if (next) return next;
    if (prof?.platform_admin) return "/admin/onboard-school";
    if (prof?.role === "super_teacher") return "/school";
    if (prof?.role === "teacher") return "/teacher";
    return "/student";
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (password.length < 8) return setErr("Use a password with at least 8 characters.");
    if (!hasLower || !hasUpper || !hasDigit) {
      return setErr("Password needs at least one lowercase letter, one uppercase letter, and one number.");
    }
    setBusy(true);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Session expired. Reopen the link from your email.");
      // Always go through the server endpoint — it uses the service role
      // to update the password, sidestepping the "AAL2 session is required"
      // wall that Supabase puts up when any MFA factor is enrolled (even
      // an unverified leftover one).
      const r = await fetch("/api/auth/set-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ password, tos_version: "2026-04-30" }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Could not set password.");
      setDone(true);
      const target = await landingFor();
      setTimeout(() => router.push(target), 1200);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not set password.";
      setErr(msg);
    } finally {
      setBusy(false);
    }
  }

  if (checking) {
    return (
      <main className="min-h-screen grid place-items-center px-6 py-10 bg-gradient-to-br from-emerald-50 via-white to-sky-50">
        <div className="spinner" />
      </main>
    );
  }

  if (!hasSession) {
    return (
      <main className="min-h-screen grid place-items-center px-6 py-10 bg-gradient-to-br from-emerald-50 via-white to-sky-50">
        <div className="w-full max-w-sm fade-in">
          <Link href="/" className="flex items-center gap-2 justify-center mb-6">
            <span className="text-3xl">🌱</span>
            <span className="text-xl font-bold">BloomIQ</span>
          </Link>
          <div className="card text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-amber-100 grid place-items-center mb-3">
              <AlertCircle size={22} className="text-amber-700" />
            </div>
            <h1 className="text-lg font-bold">This link needs to be opened in the same browser</h1>
            <p className="text-sm text-slate-600 mt-2">
              Your invite or password-reset link only works in the browser where you opened the email.
              If the link has expired, ask whoever invited you to send a fresh one — or use{" "}
              <Link href="/login" className="text-emerald-700 font-semibold">Forgot password</Link>{" "}
              on the sign-in page.
            </p>
            <Link href="/login" className="btn btn-primary w-full mt-5">
              Go to sign in <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </main>
    );
  }

  if (done) {
    return (
      <main className="min-h-screen grid place-items-center px-6 py-10 bg-gradient-to-br from-emerald-50 via-white to-sky-50">
        <div className="w-full max-w-sm fade-in">
          <div className="card text-center">
            <div className="mx-auto w-14 h-14 rounded-full bg-emerald-100 grid place-items-center mb-3">
              <CheckCircle2 size={28} className="text-emerald-700" />
            </div>
            <h1 className="text-lg font-bold">Password set</h1>
            <p className="text-sm text-slate-600 mt-2">Taking you to your dashboard…</p>
            <div className="spinner mt-4" />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen grid place-items-center px-6 py-10 bg-gradient-to-br from-emerald-50 via-white to-sky-50">
      <div className="w-full max-w-sm fade-in">
        <Link href="/" className="flex items-center gap-2 justify-center mb-8">
          <span className="text-3xl">🌱</span>
          <span className="text-xl font-bold">BloomIQ</span>
        </Link>

        <div className="card">
          <div className="flex items-center gap-2 mb-1">
            <KeyRound size={20} className="text-emerald-700" />
            <h1 className="text-xl font-bold">Set your password</h1>
          </div>
          <p className="text-sm text-slate-600 mb-5">
            {email ? (
              <>You&apos;re signed in as <strong>{email}</strong>. Pick a password so you can log in next time.</>
            ) : (
              <>Pick a password so you can log in next time.</>
            )}
          </p>

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="label">New password</label>
              <div className="relative">
                <input
                  className="input pr-10"
                  type={showPwd ? "text" : "password"}
                  required
                  minLength={8}
                  autoFocus
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowPwd((v) => !v)}
                  className="absolute inset-y-0 right-2 my-auto text-slate-500 hover:text-slate-700 p-1"
                  aria-label={showPwd ? "Hide password" : "Show password"}
                  tabIndex={-1}
                >
                  {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {password.length > 0 ? (
                <div className="mt-2">
                  <div className="flex gap-1">
                    {[1, 2, 3].map((seg) => (
                      <div
                        key={seg}
                        className={`h-1 flex-1 rounded-full transition-colors ${
                          strength >= seg ? STRENGTH_COLORS[strength] : "bg-slate-200"
                        }`}
                      />
                    ))}
                  </div>
                  <ul className="text-[11px] mt-1.5 space-y-0.5">
                    <li className={password.length >= 8 ? "text-emerald-700" : "text-slate-500"}>
                      {password.length >= 8 ? "✓" : "•"} At least 8 characters
                    </li>
                    <li className={hasLower ? "text-emerald-700" : "text-slate-500"}>
                      {hasLower ? "✓" : "•"} A lowercase letter (a–z)
                    </li>
                    <li className={hasUpper ? "text-emerald-700" : "text-slate-500"}>
                      {hasUpper ? "✓" : "•"} An uppercase letter (A–Z)
                    </li>
                    <li className={hasDigit ? "text-emerald-700" : "text-slate-500"}>
                      {hasDigit ? "✓" : "•"} A number (0–9)
                    </li>
                  </ul>
                </div>
              ) : (
                <p className="text-xs muted mt-1">8+ characters with a lowercase, uppercase, and a number.</p>
              )}
            </div>

            {err && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-start gap-2">
                <AlertCircle size={14} className="mt-0.5 shrink-0" /> {err}
              </div>
            )}

            <p className="text-[11px] text-slate-500 leading-relaxed">
              By setting a password and continuing, you agree to our{" "}
              <Link href="/terms" target="_blank" className="text-emerald-700 hover:underline">Terms of Service</Link>{" "}
              and{" "}
              <Link href="/privacy" target="_blank" className="text-emerald-700 hover:underline">Privacy Policy</Link>.
            </p>

            <button className="btn btn-primary w-full" disabled={busy || !passwordOk}>
              {busy ? <><span className="spinner" /> Saving…</> : <>Set password <ArrowRight size={14} /></>}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}

export default function SetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen grid place-items-center"><div className="spinner" /></div>}>
      <SetPasswordInner />
    </Suspense>
  );
}
