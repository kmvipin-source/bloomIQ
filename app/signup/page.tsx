"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { ArrowLeft, ArrowRight, Eye, EyeOff } from "lucide-react";
import { track } from "@/lib/posthog";

// Admin Head (super_teacher) accounts are NOT self-serve. They are provisioned
// by ZCORIQ staff via /admin/onboard-school after the school's payment lands,
// which sends a Supabase invite email to the Admin Head. So /signup only
// exposes the two self-serve roles below.
type Role = "teacher" | "student";

const ROLE_TILES: { id: Role; emoji: string; label: string; sub: string }[] = [
  { id: "teacher", emoji: "👩‍🏫", label: "Teacher",            sub: "Create classes, generate quizzes, track how your students think." },
  { id: "student", emoji: "🎓",   label: "Independent student", sub: "Self-study with your own subscription. Practise tests, watch your scores climb." },
];

function asRole(s: string | null): Role | null {
  if (s === "teacher" || s === "student") return s;
  return null;
}

function scorePassword(p: string): number {
  if (p.length < 8) return 0;
  let s = 1;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++;
  if (/\d/.test(p) || /[^A-Za-z0-9]/.test(p)) s++;
  if (p.length >= 12) s++;
  return Math.min(s, 3);
}

const STRENGTH_LABELS = ["Too short", "Weak", "OK", "Strong"];
const STRENGTH_COLORS = [
  "bg-slate-200",
  "bg-red-400",
  "bg-amber-400",
  "bg-emerald-500",
];

function SignupInner() {
  const router = useRouter();
  const search = useSearchParams();
  const role = asRole(search.get("role"));

  // Quietly bounce signed-in visitors to their dashboard so /signup doesn't
  // accidentally surface to people who already have an account.
  const [checkingSession, setCheckingSession] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) { setCheckingSession(false); return; }
        const { data: prof } = await sb
          .from("profiles")
          .select("role, platform_admin")
          .eq("id", user.id)
          .single();
        const home =
          prof?.platform_admin ? "/admin/onboard-school" :
          prof?.role === "super_teacher" ? "/school" :
          prof?.role === "teacher" ? "/teacher" :
          "/student";
        router.replace(home);
      } catch {
        setCheckingSession(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (checkingSession) {
    return (
      <main className="min-h-screen grid place-items-center bg-gradient-to-br from-emerald-50 via-white to-sky-50">
        <div className="spinner" />
      </main>
    );
  }

  return (
    <main className="min-h-screen grid place-items-center px-6 py-10 bg-gradient-to-br from-emerald-50 via-white to-sky-50">
      <div className="w-full max-w-md">
        <Link href="/" className="flex items-center gap-2 justify-center mb-6">
          <span className="text-3xl">🌱</span>
          <span className="text-xl font-bold">ZCORIQ</span>
        </Link>

        <div className="card bg-emerald-50/70 border-emerald-200 flex items-center justify-between gap-3 mb-4 py-3">
          <div className="text-sm text-emerald-900">
            <strong>Already have an account?</strong>
            <span className="text-emerald-800/80"> Sign in instead.</span>
          </div>
          <Link href="/login" className="btn btn-primary text-sm whitespace-nowrap">
            Sign in <ArrowRight size={14} />
          </Link>
        </div>

        {role ? <SignupForm role={role} /> : <RolePicker />}
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

      <div className="text-xs text-slate-500 mt-5 leading-relaxed border-t border-slate-100 pt-4 space-y-2" suppressHydrationWarning>
        <div>
          <strong className="text-slate-700">School student?</strong> Your teacher creates your account.{" "}
          <Link href="/login" className="text-emerald-700 font-semibold">Sign in here.</Link>
        </div>
        <div>
          <strong className="text-slate-700">Setting up a new school?</strong>{" "}
          <a href="mailto:hello@bloomiq.app?subject=ZCORIQ%20school%20onboarding" className="text-emerald-700 font-semibold">Talk to us</a>{" "}
          and we&apos;ll send the Admin Head an invite. (If you&apos;ve already been invited,{" "}
          <Link href="/login" className="text-emerald-700 font-semibold">sign in here</Link> instead.)
        </div>
      </div>
    </div>
  );
}

// F38 note (QA): no CAPTCHA on this form yet. Before opening school
// signups to the public, wire hCaptcha or Cloudflare Turnstile into
// the password block below — bots will find this surface fast.
function SignupForm({ role }: { role: Role }) {
  const router = useRouter();
  const search = useSearchParams();
  const tile = ROLE_TILES.find((t) => t.id === role)!;

  const intent = search.get("intent");
  const planParam = search.get("plan");

  const [fullName, setFullName] = useState("");
  const [school, setSchool] = useState("");
  const [grade, setGrade] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  // Required Terms / Privacy acknowledgement. Submit stays disabled until
  // the user explicitly checks this — the standard click-wrap pattern that
  // makes acceptance binding under most jurisdictions.
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const strength = scorePassword(password);
  const tooShort = password.length > 0 && password.length < 8;
  // Supabase project policy requires lower + upper + digit. Mirror it
  // client-side so users see the requirement BEFORE submit, instead of a
  // raw "Password should contain ..." server error.
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const missingChecks = password.length > 0 && (!hasLower || !hasUpper || !hasDigit);
  const passwordOk = password.length >= 8 && hasLower && hasUpper && hasDigit;

  function landingPageFor(r: Role): string {
    if (r === "teacher") return "/teacher";
    return "/student";
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setInfo(null);
    if (password.length < 8) {
      setErr("Use a password with at least 8 characters.");
      return;
    }
    if (!hasLower || !hasUpper || !hasDigit) {
      setErr("Password needs at least one lowercase letter, one uppercase letter, and one number.");
      return;
    }
    if (!acceptedTerms) {
      setErr("Please accept the Terms of Service and Privacy Policy to continue.");
      return;
    }
    setBusy(true);
    const sb = supabaseBrowser();

    // Stamp acceptance into Supabase user_metadata so we have a clean record
    // of WHEN each user agreed. Picks up the same way as full_name / role in
    // the on_auth_user_created trigger, which mirrors raw_user_meta_data into
    // profiles. We also include the version so we can require re-acceptance
    // when Terms change materially.
    const acceptedAt = new Date().toISOString();
    // Lowercase the email so a mixed-case retry of the same address
    // doesn't create a second auth.users row that then fails to sign
    // in via /login (login also doesn't lowercase). Trim too — pastes
    // sometimes include a trailing space.
    const normalizedEmail = email.trim().toLowerCase();
    const { data, error } = await sb.auth.signUp({
      email: normalizedEmail,
      password,
      options: {
        data: {
          role,
          full_name: fullName,
          tos_accepted_at: acceptedAt,
          tos_version: "2026-04-30",
        },
      },
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
      setInfo("Account created. If your Supabase project requires email confirmation, please confirm via the email we sent then sign in.");
      setBusy(false);
      return;
    }

    track("signup_completed", { role, has_school: !!school, intent: intent || null });

    if (
      role === "student" &&
      intent === "pro" &&
      (planParam === "individual_monthly" || planParam === "individual_yearly")
    ) {
      // F25 note (QA): autostart path bypasses the signOut+relogin gate
      // below, so a fresh signup → autostart never sees the login ToS
      // prompt. Acceptable today because the signup form captures
      // tos_accepted_at + tos_version inline; revisit if ToS revs land
      // more frequently and the race becomes meaningful.
      router.push(`/pricing?autostart=${planParam}`);
      return;
    }
    // After signup, sign the just-created session out and send the user
    // to /login with a friendly notice. Two reasons:
    //   1. Confirms the password they picked actually works.
    //   2. Forces a clean role-tab + ToS acceptance flow on first login,
    //      which the dashboard auth gate expects.
    try { await sb.auth.signOut(); } catch { /* ignore */ }
    // Route to the specialised login page that matches the role they
    // signed up as, so they don't land on the generic picker and have to
    // pick again. Teachers default to the Teacher tab on /login/school.
    const loginUrl =
      role === "teacher"
        ? `/login/school?signedup=1&tab=teacher`
        : `/login/student?signedup=1`;
    router.push(loginUrl);
  }

  return (
    <>
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
          <div>
            <label className="label">School <span className="muted text-xs">(optional)</span></label>
            <input className="input" value={school} onChange={(e) => setSchool(e.target.value)} />
          </div>
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
            <div className="relative">
              <input
                className="input pr-10"
                type={showPwd ? "text" : "password"}
                required
                minLength={8}
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

          {/* Terms + Privacy acceptance — required, click-wrap. The label is
              clickable so the whole row toggles the box. The two links open
              in a new tab so the user doesn't lose their form state. */}
          <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
              checked={acceptedTerms}
              onChange={(e) => setAcceptedTerms(e.target.checked)}
              required
            />
            <span>
              I agree to the{" "}
              <Link href="/terms" target="_blank" className="text-emerald-700 font-semibold underline">Terms of Service</Link>{" "}
              and{" "}
              <Link href="/privacy" target="_blank" className="text-emerald-700 font-semibold underline">Privacy Policy</Link>.
            </span>
          </label>

          {err && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>}
          {info && <div className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded-lg">{info}</div>}

          <button
            className="btn btn-primary w-full"
            disabled={busy}
          >
            {busy && <span className="spinner" />} Create {tile.label.toLowerCase()} account
          </button>
          {/* Subtle hint when the form would fail validation, so the user
              knows what's still missing without having to click first. The
              onSubmit handler still re-checks and shows the same message
              prominently when they click. */}
          {!busy && (!passwordOk || !acceptedTerms) && (
            <p className="text-xs text-amber-700 text-center">
              {!passwordOk
                ? "Your password needs 8+ characters with a lowercase letter, an uppercase letter, and a number."
                : "Tick the Terms & Privacy box above to enable Create account."}
            </p>
          )}
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
