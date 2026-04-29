"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { ArrowLeft } from "lucide-react";

type Role = "teacher" | "student" | "super_teacher";

const ROLE_TILES: { id: Role; emoji: string; label: string; sub: string }[] = [
  { id: "teacher",       emoji: "👩‍🏫", label: "Teacher",            sub: "Create classes, generate quizzes, track how your students think." },
  { id: "student",       emoji: "🎓",   label: "Independent student", sub: "Self-study with your own subscription. Practise tests, watch your scores climb." },
  { id: "super_teacher", emoji: "🏫",   label: "Admin Head",          sub: "Run a school as its Admin Head (typically the Principal). Invite teachers, see analytics across every classroom. The role can be transferred later." },
];

function asRole(s: string | null): Role | null {
  if (s === "teacher" || s === "student" || s === "super_teacher") return s;
  return null;
}

function SignupInner() {
  const search = useSearchParams();
  const role = asRole(search.get("role"));

  return (
    <main className="min-h-screen grid place-items-center px-6 py-10 bg-gradient-to-br from-emerald-50 via-white to-sky-50">
      <div className="w-full max-w-md">
        <Link href="/" className="flex items-center gap-2 justify-center mb-6">
          <span className="text-3xl">🌱</span>
          <span className="text-xl font-bold">BloomIQ</span>
        </Link>

        {role ? <SignupForm role={role} /> : <RolePicker />}

        <div className="mt-5 text-sm text-center text-slate-600">
          Already have an account?{" "}
          <Link href="/login" className="text-emerald-700 font-semibold">Sign in</Link>
        </div>
      </div>
    </main>
  );
}

function RolePicker() {
  return (
    <div className="card">
      <h1 className="text-xl font-bold mb-1">Create your account</h1>
      <p className="text-sm text-slate-600 mb-5">First, tell us who you are.</p>

      <div className="grid gap-2">
        {ROLE_TILES.map((r) => (
          <Link
            key={r.id}
            href={`/signup?role=${r.id}`}
            className="flex items-start gap-3 p-3 rounded-lg border border-slate-200 hover:border-emerald-500 hover:bg-emerald-50/40 transition"
          >
            <span className="text-2xl shrink-0">{r.emoji}</span>
            <span className="flex-1">
              <span className="font-semibold text-sm block">{r.label}</span>
              <span className="text-xs text-slate-600 block mt-0.5">{r.sub}</span>
            </span>
          </Link>
        ))}
      </div>

      <div className="text-xs text-slate-500 mt-5 leading-relaxed border-t border-slate-100 pt-4" suppressHydrationWarning>
        <strong className="text-slate-700">School student?</strong> Your teacher creates your account.{" "}
        <Link href="/login" className="text-emerald-700 font-semibold">Sign in here.</Link>
      </div>
    </div>
  );
}

function SignupForm({ role }: { role: Role }) {
  const router = useRouter();
  const search = useSearchParams();
  const tile = ROLE_TILES.find((t) => t.id === role)!;

  // Optional purchase-intent params, set when the visitor clicks "Get Pro" on
  // /pricing while logged out. After successful signup we bounce to
  // /pricing?autostart=<plan>, which auto-launches the Razorpay modal so the
  // visitor's friend-recommended pay-and-go flow stays one continuous click.
  const intent = search.get("intent"); // "pro" | null
  const planParam = search.get("plan"); // "individual_monthly" | "individual_yearly" | null

  const [fullName, setFullName] = useState("");
  const [school, setSchool] = useState("");
  const [grade, setGrade] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  function landingPageFor(r: Role): string {
    if (r === "teacher") return "/teacher";
    if (r === "super_teacher") return "/school";
    return "/student";
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setInfo(null); setBusy(true);
    const sb = supabaseBrowser();

    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { data: { role, full_name: fullName } },
    });
    if (error) { setErr(error.message); setBusy(false); return; }
    if (!data.user) { setErr("Signup failed."); setBusy(false); return; }

    const { error: pErr } = await sb.from("profiles").upsert({
      id: data.user.id,
      role,
      full_name: fullName,
      school: school || null,
      grade: role === "student" ? grade || null : null,
    });
    if (pErr) {
      setInfo("Account created. If your Supabase project requires email confirmation, please confirm via the email we sent — then sign in.");
      setBusy(false);
      return;
    }

    // If the visitor clicked "Get Pro" on /pricing while logged out, bounce
    // them back with autostart so Razorpay opens immediately. Otherwise go to
    // their normal role landing page.
    if (
      role === "student" &&
      intent === "pro" &&
      (planParam === "individual_monthly" || planParam === "individual_yearly")
    ) {
      router.push(`/pricing?autostart=${planParam}`);
      return;
    }
    router.push(landingPageFor(role));
  }

  return (
    <>
      {/* Breadcrumb showing the chosen role */}
      <div className="mb-3 flex items-center gap-3 p-3 rounded-lg bg-emerald-50 border border-emerald-200">
        <span className="text-2xl shrink-0">{tile.emoji}</span>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wide font-semibold text-emerald-700">Creating account as</div>
          <div className="text-sm font-bold text-emerald-900">{tile.label}</div>
        </div>
        <Link href="/signup" className="text-xs text-emerald-700 hover:underline font-semibold whitespace-nowrap inline-flex items-center gap-1">
          <ArrowLeft size={12} /> Change
        </Link>
      </div>

      <div className="card">
        <h1 className="text-xl font-bold mb-1">Your details</h1>
        <p className="text-sm text-slate-600 mb-5">Less than a minute.</p>

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="label">Full name</label>
            <input className="input" required value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          {role !== "super_teacher" && (
            <div>
              <label className="label">School <span className="muted text-xs">(optional)</span></label>
              <input className="input" value={school} onChange={(e) => setSchool(e.target.value)} />
            </div>
          )}
          {role === "student" && (
            <div>
              <label className="label">Grade / Class</label>
              <input className="input" placeholder="e.g. 8B" value={grade} onChange={(e) => setGrade(e.target.value)} />
            </div>
          )}
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label className="label">Password</label>
            <input className="input" type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
            <p className="text-xs muted mt-1">At least 6 characters.</p>
          </div>

          {role === "super_teacher" && (
            <div className="text-xs text-emerald-900 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded-lg">
              <strong>Next step:</strong> after signup you&apos;ll name your school and invite teachers.
            </div>
          )}

          {err && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>}
          {info && <div className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded-lg">{info}</div>}

          <button className="btn btn-primary w-full" disabled={busy}>
            {busy && <span className="spinner" />} Create {tile.label.toLowerCase()} account
          </button>
        </form>
      </div>
    </>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={<div className="min-h-screen grid place-items-center"><div className="spinner" /></div>}>
      <SignupInner />
    </Suspense>
  );
}
