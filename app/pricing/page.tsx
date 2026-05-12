"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Check, Crown, Sparkles, Mail, ArrowRight, PartyPopper, Receipt } from "lucide-react";
import { track } from "@/lib/posthog";

// =============================================================================
// PUBLIC-FIRST PRICING PAGE
// -----------------------------------------------------------------------------
// Anyone can land here from a friend's link, an ad, or search — no auth wall.
// CTAs adapt to login state:
//   - Logged out → "Get Pro" sends to /signup?role=student&intent=pro&plan=<id>
//     and after signup the user is bounced back here with ?autostart=<id>, which
//     immediately opens the Razorpay modal. Net effect: friend → click → signup
//     → pay → dashboard, all in one continuous flow.
//   - Logged in → "Get Pro" opens Razorpay directly.
// =============================================================================

type RazorpayCheckout = { open: () => void };
type RazorpayResponse = {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
};
type RazorpayOptions = {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill?: { email?: string; name?: string };
  theme?: { color?: string };
  handler: (resp: RazorpayResponse) => void;
  modal?: { ondismiss?: () => void };
};
type RazorpayConstructor = new (opts: RazorpayOptions) => RazorpayCheckout;
declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

function loadRazorpaySdk(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return reject(new Error("no window"));
    if (window.Razorpay) return resolve();
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load the Razorpay checkout script."));
    document.head.appendChild(s);
  });
}

// Plan id used by upgrade() — accepts both legacy hardcoded ids and any
// slug from the live DB-driven plan catalogue (e.g. "premium_monthly",
// "premium_plus_annual"). Widened to string to keep the type system out
// of the way of dynamically-loaded plans.
type PlanId = string;
type Plan = {
  id: PlanId;
  label: string;
  priceLine: string;
  blurb: string;
  features: string[];
  highlight?: boolean;
};
const STUDENT_PLANS: Plan[] = [
  {
    id: "individual_monthly",
    label: "Monthly",
    priceLine: "₹99",
    blurb: "Per month. Cancel anytime.",
    features: [
      "Unlimited practice tests",
      "Full Bloom-level mastery report",
      "AI-generated flashcards on focus areas",
      "Past-paper retention drills",
    ],
  },
  {
    id: "individual_yearly",
    label: "Annual",
    priceLine: "₹999",
    blurb: "Per year. Save ₹189 vs monthly.",
    features: [
      "Everything in Monthly",
      "Priority access to new features",
      "Yearly progress recap PDF",
      "Best deal for one-shot exam prep",
    ],
    highlight: true,
  },
];

type Me = {
  id: string;
  email: string | null;
  full_name: string | null;
  tier: string | null;
};

function PricingInner() {
  const router = useRouter();
  const search = useSearchParams();
  const autostart = search.get("autostart");

  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Structured success state — drives the full "you're in" screen so the user
  // has a crystal-clear next step (start practicing) instead of being left
  // staring at a small green toast on the pricing page.
  const [success, setSuccess] = useState<{ tier: string; expiresAt: string } | null>(null);
  const autoFiredRef = useRef(false);

  // Guest-checkout modal: shown when a logged-out visitor clicks a paid plan.
  // Captures the minimum we need (email + name + password) so we can
  // create the account, mint a session, and open Razorpay in one flow.
  const [guestPlan, setGuestPlan] = useState<{ slug: string; label: string; priceLine: string } | null>(null);
  const [guestEmail, setGuestEmail] = useState("");
  const [guestName, setGuestName] = useState("");
  const [guestPwd, setGuestPwd] = useState("");
  const [guestAcceptedTerms, setGuestAcceptedTerms] = useState(false);

  // Plans loaded live from the platform-admin catalogue (active rows only).
  // Falls back to the hardcoded STUDENT_PLANS constant below if the fetch
  // fails for any reason — so a misconfigured DB can't take pricing offline.
  type DbPlan = {
    id: string;
    slug: string;
    tier: string;
    label: string;
    blurb: string | null;
    feature_summary: string[];
    price_paise: number;
    currency: string;
    period_days: number;
    pricing_model?: "fixed" | "per_student";
    per_student_price_paise?: number;
    min_students?: number;
    max_students?: number | null;
  };
  const [dbPlans, setDbPlans] = useState<DbPlan[]>([]);
  const [plansLoaded, setPlansLoaded] = useState(false);
  // Interactive headcount input for the per-student calculator on the
  // For-schools section. Defaults to a sensible mid-range school size.
  const [schoolHeadcount, setSchoolHeadcount] = useState(200);
  useEffect(() => {
    (async () => {
      try {
        // Let the browser/CDN cache kick in — plans change rarely and the
        // route sets Cache-Control: s-maxage=60, stale-while-revalidate=600.
        const r = await fetch("/api/pricing/active-plans");
        const j = await r.json();
        if (r.ok && Array.isArray(j.plans)) setDbPlans(j.plans);
      } catch { /* silent — fall back to hardcoded plans */ }
      finally { setPlansLoaded(true); }
    })();
  }, []);

  // Load current user (if any). profile + subscription run in parallel so
  // the CTA copy resolves in one round-trip instead of two sequential ones.
  // Note: getSession() reads the locally-stored token (no network); only
  // the two DB selects after it touch the network.
  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      const user = session?.user;
      if (!user) { setLoading(false); return; }
      const [{ data: prof }, { data: sub }] = await Promise.all([
        sb.from("profiles").select("full_name").eq("id", user.id).single(),
        sb.from("subscriptions").select("tier, status, expires_at").eq("user_id", user.id).maybeSingle(),
      ]);
      setMe({
        id: user.id,
        email: user.email || null,
        full_name: prof?.full_name || null,
        tier: (sub as { tier?: string } | null)?.tier || "free",
      });
      setLoading(false);
    })();
  }, []);

  // ?autostart=<plan> — auto-launch Razorpay right after signup completes.
  // Guarded by a ref so dismissing the modal doesn't re-open it on re-render.
  useEffect(() => {
    if (loading || autoFiredRef.current) return;
    if (!autostart) return;
    // Accept any plan id — legacy hardcoded ones AND DB-driven slugs.
    if (typeof autostart !== "string" || !autostart) return;
    if (!me) return; // can't pay without a session; visitor can click manually
    autoFiredRef.current = true;
    upgrade(autostart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autostart, me, loading]);

  async function upgrade(planId: PlanId) {
    setErr(null);
    setSuccess(null);

    // Logged out: open the guest-checkout modal — collects email/name/password,
    // /api/signup-and-pay creates the account + mints a session + creates the
    // Razorpay order, then this page calls setSession() and opens Razorpay.
    if (!me) {
      const live = dbPlans.find((p) => p.slug === planId);
      const fallback = STUDENT_PLANS.find((p) => p.id === planId);
      const slugMap: Record<string, string> = {
        individual_monthly: "premium_monthly",
        individual_yearly: "premium_annual",
      };
      const slug = slugMap[planId] ?? planId;
      const label = live?.label || fallback?.label || slug;
      const priceLine = live
        ? `₹${(live.price_paise / 100).toLocaleString("en-IN")}`
        : (fallback?.priceLine || "");
      setGuestPlan({ slug, label, priceLine });
      return;
    }

    setBusy(planId);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Your session expired. Please sign in again.");

      // Map the legacy hardcoded plan id to the new plan slug. The new
      // checkout API accepts both keys, so this is a safety net during
      // the transition; once /pricing renders only DB plans we'll send
      // plan_slug exclusively.
      const slugMap: Record<string, string> = {
        individual_monthly: "premium_monthly",
        individual_yearly: "premium_annual",
      };
      const planSlug = slugMap[planId] ?? planId;
      const orderRes = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ plan_slug: planSlug, plan: planId }),
      });
      const order = await orderRes.json();
      if (!orderRes.ok) throw new Error(order?.error || "Checkout failed");

      await loadRazorpaySdk();
      const Razorpay = window.Razorpay;
      if (!Razorpay) throw new Error("Razorpay didn’t load. Disable any ad blocker and try again.");

      const rzp = new Razorpay({
        key: order.key_id,
        order_id: order.order_id,
        amount: order.amount_paise,
        currency: order.currency,
        name: "BloomIQ",
        description: order.plan?.label || "Subscription",
        prefill: { email: me.email || undefined, name: me.full_name || undefined },
        theme: { color: "#10b981" },
        handler: async (resp) => {
          try {
            const v = await fetch("/api/checkout/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
              body: JSON.stringify(resp),
            });
            const j = await v.json();
            if (!v.ok) throw new Error(j?.error || "Verify failed");
            setSuccess({ tier: j.tier as string, expiresAt: j.expires_at as string });
            setMe((m) => m ? { ...m, tier: j.tier } : m);
            track("subscription_paid", {
              tier: j.tier,
              amount_paise: order.amount_paise,
              plan_label: order.plan?.label || null,
              flow: "logged_in",
            });
            // Drop the autostart query so a refresh doesn't re-fire.
            router.replace("/pricing");
          } catch (e) {
            setErr(e instanceof Error ? e.message : "Verify failed");
          } finally {
            setBusy(null);
          }
        },
        modal: { ondismiss: () => setBusy(null) },
      });
      rzp.open();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start checkout");
      setBusy(null);
    }
  }

  async function guestUpgrade() {
    if (!guestPlan) return;
    setErr(null);
    if (!guestAcceptedTerms) {
      setErr("Please accept the Terms of Service and Privacy Policy.");
      return;
    }
    if (guestPwd.length < 8) {
      setErr("Password must be at least 8 characters.");
      return;
    }
    if (!/[a-z]/.test(guestPwd) || !/[A-Z]/.test(guestPwd) || !/\d/.test(guestPwd)) {
      setErr("Password needs at least one lowercase letter, one uppercase letter, and one number.");
      return;
    }
    setBusy(guestPlan.slug);
    try {
      const r = await fetch("/api/signup-and-pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: guestEmail,
          full_name: guestName,
          password: guestPwd,
          plan_slug: guestPlan.slug,
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        if (j?.code === "email_exists") {
          setErr("An account with this email already exists. Sign in, then return to /pricing.");
        } else {
          setErr(j?.error || "Could not create account.");
        }
        setBusy(null);
        return;
      }

      const sb = supabaseBrowser();
      await sb.auth.setSession({
        access_token: j.access_token,
        refresh_token: j.refresh_token,
      });
      setMe({
        id: j.user.id,
        email: j.user.email,
        full_name: j.user.full_name,
        tier: "free",
      });

      await loadRazorpaySdk();
      const Razorpay = window.Razorpay;
      if (!Razorpay) throw new Error("Razorpay didn’t load. Disable any ad blocker and try again.");

      const rzp = new Razorpay({
        key: j.key_id,
        order_id: j.order_id,
        amount: j.amount_paise,
        currency: j.currency,
        name: "BloomIQ",
        description: j.plan?.label || "Subscription",
        prefill: { email: j.user.email, name: j.user.full_name },
        theme: { color: "#10b981" },
        handler: async (resp) => {
          try {
            const v = await fetch("/api/checkout/verify", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${j.access_token}`,
              },
              body: JSON.stringify(resp),
            });
            const vj = await v.json();
            if (!v.ok) throw new Error(vj?.error || "Verify failed");
            setSuccess({ tier: vj.tier as string, expiresAt: vj.expires_at as string });
            setMe((m) => m ? { ...m, tier: vj.tier } : m);
            track("subscription_paid", {
              tier: vj.tier,
              amount_paise: j.amount_paise,
              plan_label: j.plan?.label || null,
              flow: "guest_signup",
            });
            setGuestPlan(null);
            setGuestEmail(""); setGuestName(""); setGuestPwd(""); setGuestAcceptedTerms(false);
          } catch (e) {
            setErr(e instanceof Error ? e.message : "Verify failed");
          } finally {
            setBusy(null);
          }
        },
        modal: { ondismiss: () => setBusy(null) },
      });
      rzp.open();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start checkout");
      setBusy(null);
    }
  }

  // Choose the right CTA copy based on auth state and the user's current tier.
  function ctaFor(planId: PlanId): { text: string; disabled: boolean; primary: boolean } {
    if (busy === planId) return { text: "Opening checkout…", disabled: true, primary: true };
    if (!me) return { text: "Go to Payment", disabled: false, primary: true };
    if (planId === "individual_yearly" && me.tier === "premium")    return { text: "Current plan", disabled: true, primary: false };
    if (planId === "individual_monthly" && me.tier === "individual") return { text: "Current plan", disabled: true, primary: false };
    return { text: "Upgrade", disabled: busy !== null, primary: true };
  }

  // ============ Post-payment "you're in" screen ============
  // Replaces the tiny green toast with a full celebratory state so the user
  // has a clear next step (start practicing) instead of being left on the
  // pricing page wondering what to do.
  if (success && me) {
    const tierLabel =
      success.tier === "premium" ? "BloomIQ Annual"
      : success.tier === "individual" ? "BloomIQ Monthly"
      : "BloomIQ";
    const dashboardHref = "/student";
    return (
      <main className="min-h-screen bg-gradient-to-br from-emerald-50 via-white to-sky-50 grid place-items-center px-6 py-10">
        <div className="w-full max-w-md fade-in">
          <Link href="/" className="flex items-center gap-2 justify-center mb-8">
            <span className="text-3xl">🌱</span>
            <span className="text-xl font-bold">BloomIQ</span>
          </Link>

          <div className="card text-center">
            <div className="mx-auto w-16 h-16 rounded-full bg-emerald-100 grid place-items-center mb-4">
              <PartyPopper size={32} className="text-emerald-700" />
            </div>
            <h1 className="text-2xl font-bold">You&apos;re all set, {me.full_name?.split(" ")[0] || "there"}!</h1>
            <p className="mt-2 text-slate-600">
              Welcome to <strong>{tierLabel}</strong>. Your account is ready and your subscription is active until{" "}
              <strong>{new Date(success.expiresAt).toLocaleDateString()}</strong>.
            </p>

            {/* Account-at-a-glance — confirms the email they're signed in with
                so there's no doubt that account creation already happened. */}
            <div className="mt-5 text-left bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm">
              <div className="flex items-center gap-2 text-slate-700">
                <Receipt size={14} className="text-emerald-700" />
                <span>Receipt sent to <strong className="break-all">{me.email}</strong></span>
              </div>
              <div className="flex items-center gap-2 mt-1.5 text-slate-700">
                <Crown size={14} className="text-emerald-700" />
                <span>Signed in as <strong>{me.full_name || me.email}</strong></span>
              </div>
            </div>

            {/* Clear next-step CTA. */}
            <Link
              href={dashboardHref}
              className="btn btn-primary w-full mt-5 inline-flex items-center justify-center gap-2"
            >
              Start practicing <ArrowRight size={16} />
            </Link>

            <button
              className="text-xs text-slate-500 hover:text-slate-700 mt-3"
              onClick={() => setSuccess(null)}
            >
              Stay on pricing page
            </button>
          </div>

          <p className="text-xs text-slate-500 text-center mt-4">
            You can manage or cancel your subscription from your account at any time.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-emerald-50 via-white to-sky-50">
      {/* ============ Top bar ============ */}
      <header className="border-b border-slate-200/60 bg-white/70 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-2xl">🌱</span>
            <span className="font-bold tracking-tight">BloomIQ</span>
          </Link>
          <nav className="flex items-center gap-2 sm:gap-4">
            {loading ? (
              <span className="spinner" />
            ) : me ? (
              <Link
                href={
                  me.tier === "free" || !me.tier
                    ? "/student"
                    : "/student"
                }
                className="text-sm font-semibold text-emerald-700 hover:underline"
              >
                Go to dashboard
              </Link>
            ) : (
              <>
                <Link href="/login" className="text-sm font-semibold text-slate-700 hover:text-emerald-700 px-2 py-1">
                  Sign in
                </Link>
                <Link href="/signup" className="btn btn-primary text-sm">
                  Create account
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 pt-12 pb-16 fade-in">
        {/* ============ Hero ============ */}
        <div className="text-center max-w-2xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-100 text-emerald-800 text-xs font-semibold mb-4">
            <Crown size={14} /> BloomIQ Plans
          </div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-slate-900">
            Pricing that grows <span className="text-emerald-600">with you</span>
          </h1>
          <p className="mt-4 text-slate-600 text-lg">
            Start free with 3 practice tests a day. Upgrade for unlimited practice, full Bloom mastery analytics, and AI flashcards on what you struggle with.
          </p>
          {me && (
            <div className="mt-5 inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-full bg-slate-100 border border-slate-200 text-slate-700">
              Currently on <strong className="capitalize">{me.tier || "free"}</strong>
            </div>
          )}
        </div>

        {/* ============ For independent students ============ */}
        <section className="mt-12">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-4">For independent students</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Free card */}
            <div className="card flex flex-col">
              <div className="font-bold text-lg">Free</div>
              <div className="text-3xl font-bold mt-2">₹0<span className="text-base font-normal muted"> /mo</span></div>
              <p className="muted text-xs mt-1">Try BloomIQ. No card needed.</p>
              <ul className="mt-4 space-y-1.5 text-sm flex-1">
                <li className="flex items-start gap-2"><Check size={14} className="text-emerald-600 mt-0.5 shrink-0" /> 3 quizzes a day + 1 Daily Drill</li>
                <li className="flex items-start gap-2"><Check size={14} className="text-emerald-600 mt-0.5 shrink-0" /> BloomIQ Score &amp; basic Bloom report</li>
                <li className="flex items-start gap-2"><Check size={14} className="text-emerald-600 mt-0.5 shrink-0" /> AI Tutor (5 turns/day) + Performance Coach (5/day)</li>
                <li className="flex items-start gap-2"><Check size={14} className="text-emerald-600 mt-0.5 shrink-0" /> 1 Speed-Accuracy session &amp; 1 Teach-Back / day</li>
                <li className="flex items-start gap-2"><Check size={14} className="text-emerald-600 mt-0.5 shrink-0" /> One free taste of X-Ray, Trap Detector, Rank Predictor, Visualizer, Voice Teacher &amp; Knowledge Graph</li>
                <li className="flex items-start gap-2"><Check size={14} className="text-emerald-600 mt-0.5 shrink-0" /> Memory Tune-Up: review your existing cards</li>
              </ul>
              {!me ? (
                <Link href="/signup?role=student" className="btn btn-secondary w-full mt-5 inline-flex items-center justify-center gap-2">
                  Sign up free <ArrowRight size={14} />
                </Link>
              ) : (
                <button className="btn btn-secondary w-full mt-5" disabled>
                  {me.tier === "free" || !me.tier ? "Current plan" : "Already upgraded"}
                </button>
              )}
            </div>

            {/* Premium tier — sourced live from the platform-admin catalogue
                (lib/featureAccess.ts + /api/pricing/active-plans). When the
                fetch hasn't returned yet OR returns nothing, we fall back
                to the hardcoded STUDENT_PLANS so the page still renders. */}
            {(() => {
              // While the live fetch is in flight, render skeleton placeholders
              // instead of the hardcoded STUDENT_PLANS — otherwise the page
              // briefly shows stale prices then snaps to the live values.
              if (!plansLoaded) {
                return [0, 1, 2].map((i) => (
                  <div key={`sk-${i}`} className="card flex flex-col animate-pulse">
                    <div className="h-5 w-24 bg-slate-200 rounded" />
                    <div className="h-9 w-28 bg-slate-200 rounded mt-3" />
                    <div className="h-3 w-40 bg-slate-100 rounded mt-2" />
                    <div className="space-y-2 mt-4 flex-1">
                      <div className="h-3 w-full bg-slate-100 rounded" />
                      <div className="h-3 w-5/6 bg-slate-100 rounded" />
                      <div className="h-3 w-4/6 bg-slate-100 rounded" />
                    </div>
                    <div className="h-10 w-full bg-slate-200 rounded mt-5" />
                  </div>
                ));
              }
              const livePremium = dbPlans
                .filter((p) => p.tier === "premium")
                .sort((a, b) => a.period_days - b.period_days);
              if (livePremium.length === 0) {
                // Fallback path — render hardcoded STUDENT_PLANS as before.
                return STUDENT_PLANS.map((p) => {
                  const cta = ctaFor(p.id);
                  return (
                    <div key={p.id} className={`card flex flex-col ${p.highlight ? "border-emerald-500 ring-2 ring-emerald-500/30 relative" : ""}`}>
                      {p.highlight && (
                        <span className="absolute -top-3 right-4 text-[10px] uppercase tracking-wide font-bold text-white bg-emerald-600 rounded-full px-2 py-0.5 shadow">
                          Best value
                        </span>
                      )}
                      <div className="font-bold text-lg">{p.label}</div>
                      <div className="text-3xl font-bold mt-2">
                        {p.priceLine}
                        <span className="text-base font-normal muted"> /{p.id === "individual_monthly" ? "mo" : "yr"}</span>
                      </div>
                      <p className="muted text-xs mt-1">{p.blurb}</p>
                      <ul className="mt-4 space-y-1.5 text-sm flex-1">
                        {p.features.map((f) => (
                          <li key={f} className="flex items-start gap-2"><Check size={14} className="text-emerald-600 mt-0.5 shrink-0" /> {f}</li>
                        ))}
                      </ul>
                      <button
                        className={`btn w-full mt-5 ${cta.primary ? "btn-primary" : "btn-secondary"}`}
                        onClick={() => upgrade(p.id)}
                        disabled={cta.disabled}
                      >
                        {busy === p.id ? <><span className="spinner" /> {cta.text}</> : <><Sparkles size={14} /> {cta.text}</>}
                      </button>
                    </div>
                  );
                });
              }
              // Live DB-driven render — annual gets the "Best value" highlight.
              return livePremium.map((p) => {
                const isAnnual = p.period_days >= 360;
                const periodSuffix = p.period_days >= 360 ? "yr" : p.period_days >= 60 ? `${Math.round(p.period_days / 30)}mo` : "mo";
                const isCurrent = me?.tier === (isAnnual ? "premium" : "individual");
                const cta = busy === p.slug
                  ? { text: "Opening checkout…", disabled: true, primary: true }
                  : !me ? { text: "Go to Payment", disabled: false, primary: true }
                  : isCurrent ? { text: "Current plan", disabled: true, primary: false }
                  : { text: "Upgrade", disabled: busy !== null, primary: true };
                return (
                  <div key={p.slug} className={`card flex flex-col ${isAnnual ? "border-emerald-500 ring-2 ring-emerald-500/30 relative" : ""}`}>
                    {isAnnual && (
                      <span className="absolute -top-3 right-4 text-[10px] uppercase tracking-wide font-bold text-white bg-emerald-600 rounded-full px-2 py-0.5 shadow">
                        Best value
                      </span>
                    )}
                    <div className="font-bold text-lg">{p.label}</div>
                    <div className="text-3xl font-bold mt-2">
                      ₹{(p.price_paise / 100).toLocaleString("en-IN")}
                      <span className="text-base font-normal muted"> /{periodSuffix}</span>
                    </div>
                    {p.blurb && <p className="muted text-xs mt-1">{p.blurb}</p>}
                    <ul className="mt-4 space-y-1.5 text-sm flex-1">
                      {p.feature_summary.map((f) => (
                        <li key={f} className="flex items-start gap-2"><Check size={14} className="text-emerald-600 mt-0.5 shrink-0" /> {f}</li>
                      ))}
                    </ul>
                    <button
                      className={`btn w-full mt-5 ${cta.primary ? "btn-primary" : "btn-secondary"}`}
                      onClick={() => upgrade(p.slug as PlanId)}
                      disabled={cta.disabled}
                    >
                      {busy === p.slug ? <><span className="spinner" /> {cta.text}</> : <><Sparkles size={14} /> {cta.text}</>}
                    </button>
                  </div>
                );
              });
            })()}
          </div>

          {/* Premium Plus tier — only renders when the platform admin has
              published one or more active plans in this tier. */}
          {(() => {
            const livePlus = dbPlans
              .filter((p) => p.tier === "premium_plus")
              .sort((a, b) => a.period_days - b.period_days);
            if (livePlus.length === 0) return null;
            return (
              <div className="mt-10">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-4">
                  Premium Plus — voice tutor, concept visualizer, and priority access
                </h2>
                <div className="grid sm:grid-cols-2 gap-4">
                  {livePlus.map((p) => {
                    const isAnnual = p.period_days >= 360;
                    const isCurrent = me?.tier === "premium_plus";
                    const cta = busy === p.slug
                      ? { text: "Opening checkout…", disabled: true, primary: true }
                      : !me ? { text: "Go to Payment", disabled: false, primary: true }
                      : isCurrent ? { text: "Current plan", disabled: true, primary: false }
                      : { text: "Upgrade", disabled: busy !== null, primary: true };
                    return (
                      <div key={p.slug} className={`card flex flex-col ${isAnnual ? "border-violet-500 ring-2 ring-violet-500/30 relative" : ""}`}>
                        {isAnnual && (
                          <span className="absolute -top-3 right-4 text-[10px] uppercase tracking-wide font-bold text-white bg-violet-600 rounded-full px-2 py-0.5 shadow">
                            Best Plus value
                          </span>
                        )}
                        <div className="font-bold text-lg">{p.label}</div>
                        <div className="text-3xl font-bold mt-2">
                          ₹{(p.price_paise / 100).toLocaleString("en-IN")}
                          <span className="text-base font-normal muted"> /{isAnnual ? "yr" : "mo"}</span>
                        </div>
                        {p.blurb && <p className="muted text-xs mt-1">{p.blurb}</p>}
                        <ul className="mt-4 space-y-1.5 text-sm flex-1">
                          {p.feature_summary.map((f) => (
                            <li key={f} className="flex items-start gap-2"><Check size={14} className="text-violet-600 mt-0.5 shrink-0" /> {f}</li>
                          ))}
                        </ul>
                        <button
                          className={`btn w-full mt-5 ${cta.primary ? "btn-primary" : "btn-secondary"}`}
                          onClick={() => upgrade(p.slug as PlanId)}
                          disabled={cta.disabled}
                        >
                          {busy === p.slug ? <><span className="spinner" /> {cta.text}</> : <><Sparkles size={14} /> {cta.text}</>}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {err && (
            <div className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
              {err}
            </div>
          )}
        </section>

        {/* ============ For schools ============
            Live-rendered from active school plans (tier starts with
            school_*). Each plan shows its per-student rate + headcount
            bracket. The calculator below the cards lets the visitor
            type their student count and see the projected annual cost
            against the right tier.
            Falls back to the static "Talk to us" card when no school
            plans are active in the DB. */}
        <section className="mt-12">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-4">For schools</h2>

          {(() => {
            if (!plansLoaded) {
              return (
                <div className="grid sm:grid-cols-3 gap-3">
                  {[0, 1, 2].map((i) => (
                    <div key={`sk-s-${i}`} className="card flex flex-col animate-pulse">
                      <div className="h-5 w-32 bg-slate-200 rounded" />
                      <div className="h-3 w-40 bg-slate-100 rounded mt-2" />
                      <div className="h-7 w-28 bg-slate-200 rounded mt-3" />
                      <div className="space-y-2 mt-3 flex-1">
                        <div className="h-3 w-full bg-slate-100 rounded" />
                        <div className="h-3 w-5/6 bg-slate-100 rounded" />
                      </div>
                      <div className="h-9 w-full bg-slate-200 rounded mt-4" />
                    </div>
                  ))}
                </div>
              );
            }
            const liveSchool = dbPlans
              .filter((p) => p.tier.startsWith("school_"))
              .sort((a, b) => (a.min_students ?? 0) - (b.min_students ?? 0));
            if (liveSchool.length === 0) {
              return (
                <div className="card bg-gradient-to-br from-sky-50 to-emerald-50 border-emerald-200">
                  <div className="flex items-start gap-4 flex-wrap">
                    <div className="flex-1 min-w-[280px]">
                      <div className="font-bold text-lg flex items-center gap-2"><Crown size={18} className="text-emerald-700" /> School plans</div>
                      <p className="text-sm text-slate-700 mt-2">
                        Per-student-per-year billing. No teacher limit. GST invoicing, Bloom Pulse report,
                        and a dedicated onboarding session included.
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-2xl font-bold">Custom</div>
                      <a
                        href="mailto:hello@bloomiq.app?subject=BloomIQ%20school%20pricing"
                        className="btn btn-primary mt-3"
                      >
                        <Mail size={14} /> Talk to us
                      </a>
                    </div>
                  </div>
                </div>
              );
            }

            // Helper — pretty-render a per-student bracket like "20–100"
            // or "500+ (no upper limit)".
            const bracket = (p: DbPlan) => {
              const min = p.min_students ?? 0;
              const max = p.max_students ?? null;
              if (max === null) return `${min}+ students`;
              return `${min}–${max} students`;
            };

            // Cheapest matching plan for the entered headcount drives the
            // calculator's quoted total. If headcount is below the smallest
            // plan's min, we still display the smallest tier with a note.
            const matching = liveSchool.find((p) =>
              schoolHeadcount >= (p.min_students ?? 0)
              && (p.max_students === null || p.max_students === undefined || schoolHeadcount <= p.max_students)
            ) || liveSchool[0];
            const matchRate = (matching.per_student_price_paise ?? 0) / 100;
            const matchPeriodLabel = matching.period_days >= 360 ? "year" : matching.period_days <= 31 ? "month" : `${matching.period_days}d`;
            const matchTotal = matchRate * schoolHeadcount;

            return (
              <>
                <div className="grid sm:grid-cols-3 gap-3">
                  {liveSchool.map((p) => {
                    const rate = (p.per_student_price_paise ?? 0) / 100;
                    const periodLabel = p.period_days >= 360 ? "yr" : p.period_days <= 31 ? "mo" : `${p.period_days}d`;
                    const isFixed = (p.pricing_model || "fixed") === "fixed";
                    return (
                      <div key={p.slug} className="card flex flex-col bg-gradient-to-br from-sky-50/50 to-emerald-50/50 border-emerald-200">
                        <div className="font-bold text-lg flex items-center gap-2"><Crown size={16} className="text-emerald-700" /> {p.label}</div>
                        <div className="text-xs muted mt-0.5">{bracket(p)} · unlimited teachers</div>
                        <div className="text-2xl font-bold mt-3">
                          {isFixed
                            ? <>₹{(p.price_paise / 100).toLocaleString("en-IN")}<span className="text-base font-normal muted"> /{periodLabel}</span></>
                            : <>₹{rate.toLocaleString("en-IN")}<span className="text-base font-normal muted"> /student/{periodLabel}</span></>
                          }
                        </div>
                        {p.blurb && <p className="text-xs muted mt-1">{p.blurb}</p>}
                        <ul className="mt-3 space-y-1.5 text-xs flex-1">
                          {p.feature_summary.map((f) => (
                            <li key={f} className="flex items-start gap-2"><Check size={12} className="text-emerald-600 mt-0.5 shrink-0" /> {f}</li>
                          ))}
                        </ul>
                        <a
                          href={`mailto:hello@bloomiq.app?subject=BloomIQ%20-%20${encodeURIComponent(p.label)}`}
                          className="btn btn-secondary text-sm mt-4 inline-flex items-center justify-center gap-1.5"
                        >
                          <Mail size={12} /> Get a quote
                        </a>
                      </div>
                    );
                  })}
                </div>

                {/* Per-student calculator. Only meaningful when at least one
                    per-student plan is visible. */}
                {liveSchool.some((p) => (p.pricing_model || "fixed") === "per_student") && (
                  <div className="card mt-4 bg-slate-50 border-slate-200">
                    <div className="flex items-center gap-3 flex-wrap">
                      <label className="text-sm">
                        <span className="font-semibold">My school has</span>{" "}
                        <input
                          className="input inline-block w-24 mx-1"
                          type="number"
                          min={1}
                          step={10}
                          value={schoolHeadcount}
                          onChange={(e) => setSchoolHeadcount(Math.max(1, Number(e.target.value || 0)))}
                        />{" "}
                        <span className="muted">students.</span>
                      </label>
                      <div className="text-sm">
                        <span className="muted">Falls under</span>{" "}
                        <strong>{matching.label}</strong>
                        <span className="muted"> at ₹{matchRate.toLocaleString("en-IN")}/student/{matchPeriodLabel} →</span>{" "}
                        <strong className="text-emerald-700">
                          ₹{matchTotal.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                        </strong>
                        <span className="muted"> per {matchPeriodLabel}.</span>
                      </div>
                    </div>
                    {schoolHeadcount < (matching.min_students ?? 0) && (
                      <p className="text-xs text-amber-700 mt-2">
                        Note: minimum {matching.min_students} students for this tier.
                      </p>
                    )}
                  </div>
                )}
              </>
            );
          })()}
        </section>

        {/* ============ FAQ ============ */}
        <section className="mt-14">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-4">Common questions</h2>
          <div className="grid md:grid-cols-2 gap-4">
            {[
              {
                q: "Can I try BloomIQ before paying?",
                a: "Yes — the Free plan gives you 3 practice tests per day forever. No card required.",
              },
              {
                q: "How do I cancel?",
                a: "Cancel anytime from your account page. You keep access until the end of the billing period.",
              },
              {
                q: "Is my payment safe?",
                a: "Yes. Razorpay processes every payment. We never see or store your card details.",
              },
              {
                q: "Do you offer student discounts?",
                a: "The Annual plan is already priced as a student deal — about ₹83 a month, less than a coaching textbook.",
              },
            ].map((f) => (
              <div key={f.q} className="card">
                <div className="font-semibold text-sm">{f.q}</div>
                <p className="text-sm text-slate-600 mt-1">{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ============ Guest checkout modal ============ */}
        {guestPlan && (
          <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 backdrop-blur-sm px-4">
            <div className="w-full max-w-md card bg-white">
              <h2 className="text-xl font-bold">Quick details</h2>
              <p className="text-sm text-slate-600 mt-1">
                Pay for <strong>{guestPlan.label}</strong>{guestPlan.priceLine && <> — {guestPlan.priceLine}</>}. We&apos;ll create your BloomIQ account and open Razorpay.
              </p>
              <form
                className="space-y-3 mt-4"
                onSubmit={(e) => { e.preventDefault(); void guestUpgrade(); }}
              >
                <div>
                  <label className="label">Full name</label>
                  <input className="input" required value={guestName} onChange={(e) => setGuestName(e.target.value)} />
                </div>
                <div>
                  <label className="label">Email</label>
                  <input className="input" type="email" required value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} />
                </div>
                <div>
                  <label className="label">Password <span className="muted text-xs">(8+ chars, one lower + upper + number)</span></label>
                  <input className="input" type="password" required minLength={8} value={guestPwd} onChange={(e) => setGuestPwd(e.target.value)} />
                </div>
                <label className="flex items-start gap-2 text-xs text-slate-700 select-none">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={guestAcceptedTerms}
                    onChange={(e) => setGuestAcceptedTerms(e.target.checked)}
                  />
                  <span>
                    I accept the{" "}
                    <Link href="/terms" target="_blank" className="text-emerald-700 hover:underline">Terms of Service</Link>{" "}
                    and{" "}
                    <Link href="/privacy" target="_blank" className="text-emerald-700 hover:underline">Privacy Policy</Link>.
                  </span>
                </label>
                {err && (
                  <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
                    {err}
                  </div>
                )}
                <div className="flex gap-2 mt-2">
                  <button
                    type="button"
                    className="btn btn-secondary flex-1"
                    onClick={() => { setGuestPlan(null); setErr(null); }}
                    disabled={busy === guestPlan.slug}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary flex-1 inline-flex items-center justify-center gap-1.5"
                    disabled={busy === guestPlan.slug || !guestAcceptedTerms}
                  >
                    {busy === guestPlan.slug ? <><span className="spinner" /> Opening…</> : <><Sparkles size={14} /> Go to Payment</>}
                  </button>
                </div>
                <p className="text-[11px] text-slate-500 mt-2">
                  Already have an account? <Link href="/login" className="text-emerald-700 hover:underline">Sign in</Link> first, then return to this page.
                </p>
              </form>
            </div>
          </div>
        )}

        <p className="text-xs muted mt-10 text-center">
          Razorpay processes all payments. We never see or store your card details.
        </p>

        <div className="text-xs text-slate-500 text-center mt-4 border-t border-slate-200 pt-6">
          <Link href="/terms" className="hover:text-emerald-700">Terms of Service</Link>
          <span className="mx-2">·</span>
          <Link href="/privacy" className="hover:text-emerald-700">Privacy Policy</Link>
        </div>
      </div>
    </main>
  );
}

export default function PricingPage() {
  return (
    <Suspense fallback={<div className="min-h-screen grid place-items-center"><div className="spinner" /></div>}>
      <PricingInner />
    </Suspense>
  );
}
