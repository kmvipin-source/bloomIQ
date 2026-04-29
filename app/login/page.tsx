"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

const SCHOOL_DOMAIN = "bloomiq.invalid";

// Read ?next=... directly from window.location at submit time. We deliberately
// avoid `useSearchParams` here because it forces the page into a Suspense
// boundary, which in Next 16 dev mode can leave the user staring at a blank
// "Rendering" state if anything upstream is slow. Reading on demand keeps the
// page a plain, immediately-rendered client component.
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
        .select("role, is_school_student")
        .eq("id", user.id)
        .single();

      const { data: { session } } = await sb.auth.getSession();
      if (session) audit(session.access_token);

      // Single-session enforcement for INDEPENDENT students only.
      // Teachers, Admin Heads, and school students stay multi-device by design.
      // We invalidate any other active sessions for this user so the same
      // login can’t be used on two devices at once — a small but effective
      // friction against credential sharing on the free tier.
      const isIndependentStudent =
        prof?.role === "student" && !prof?.is_school_student;
      if (isIndependentStudent) {
        // `signOut({ scope: "others" })` keeps the current session alive while
        // killing every other refresh token tied to this user. Best-effort.
        try { await sb.auth.signOut({ scope: "others" }); } catch { /* ignore */ }
      }

      const next = readNextParam();
      const home =
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
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="your.email@example.com"
              />
            </div>
            <div>
              <label className="label">Password</label>
              <input
                className="input"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {err && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
                {err}
              </div>
            )}
            <button className="btn btn-primary w-full" disabled={busy}>
              {busy && <span className="spinner" />} Sign in
            </button>
          </form>

          <div className="mt-6 text-sm text-center text-slate-600">
            New here?{" "}
            <Link href="/signup" className="text-emerald-700 font-semibold">Create an account</Link>
          </div>
        </div>

        <p className="text-xs text-slate-500 text-center mt-4">
          School student? Use the username your teacher gave you.
        </p>
      </div>
    </main>
  );
}
