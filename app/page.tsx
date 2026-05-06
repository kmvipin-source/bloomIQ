import Link from "next/link";
import { ArrowRight, Sparkles, Timer, BarChart3, Brain, Target, Layers } from "lucide-react";
import PublicNav from "@/components/PublicNav";

/**
 * Home / Landing page
 * -------------------
 * Premium-clean aesthetic. Theme-aware (uses CSS vars for all colors so
 * the page picks up whichever theme the visitor has saved). Layered
 * gradient mesh in the hero, refined typography (Inter + tighter
 * letter-spacing on display text), card hover lift, and stat strip
 * to add credibility.
 */
export default function LandingPage() {
  return (
    <main className="min-h-screen bg-hero">
      {/* Sticky top nav. Translucent + backdrop blur for the modern feel. */}
      <header
        className="sticky top-0 z-20 backdrop-blur"
        style={{
          background: "color-mix(in oklab, var(--color-card) 75%, transparent)",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-2xl">🌱</span>
            <span className="font-bold tracking-tight text-lg">BloomIQ</span>
          </Link>
          <PublicNav />
        </div>
      </header>

      {/* HERO ------------------------------------------------------------ */}
      <section className="relative overflow-hidden">
        {/* Subtle decorative orbs — pure CSS, no images, theme-aware */}
        <div
          aria-hidden
          className="absolute -top-32 -right-32 w-[480px] h-[480px] rounded-full opacity-50 blur-3xl pointer-events-none"
          style={{ background: "var(--brand-300)" }}
        />
        <div
          aria-hidden
          className="absolute -bottom-32 -left-32 w-[420px] h-[420px] rounded-full opacity-40 blur-3xl pointer-events-none"
          style={{ background: "var(--brand-200)" }}
        />

        <div className="relative max-w-5xl mx-auto px-6 pt-20 pb-20 text-center">
          {/* Eyebrow chip */}
          <div
            className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold mb-6 fade-in"
            style={{
              background: "var(--color-accent-soft)",
              color: "var(--brand-700)",
              border: "1px solid var(--brand-200)",
            }}
          >
            <Sparkles size={12} /> AI tutor + Bloom-aligned assessments
          </div>

          <h1
            className="text-4xl md:text-6xl font-extrabold tracking-tight leading-[1.05] fade-in"
            style={{ color: "var(--color-fg)" }}
          >
            Assess <span className="text-gradient-brand">how students think</span>,
            <br className="hidden sm:block" /> not just what they recall.
          </h1>

          <p
            className="mt-6 text-lg max-w-2xl mx-auto leading-relaxed fade-in"
            style={{ color: "var(--color-fg-soft)" }}
          >
            AI-generated multiple-choice questions, every one tagged by Bloom&apos;s Taxonomy.
            See exactly which thinking levels are strong — and which need work.
          </p>

          <div className="mt-10 flex flex-col sm:flex-row gap-3 items-center justify-center fade-in">
            <Link
              href="/login"
              className="btn btn-primary text-base px-7 py-3 inline-flex items-center gap-2"
            >
              Get started free <ArrowRight size={18} />
            </Link>
            <Link
              href="/pricing"
              className="text-sm font-semibold px-4 py-2 rounded-lg transition"
              style={{ color: "var(--color-fg-soft)" }}
            >
              See plans &amp; pricing →
            </Link>
          </div>

          {/* Stat strip — adds credibility, theme-aware. */}
          <div className="mt-14 grid grid-cols-3 gap-4 max-w-2xl mx-auto">
            <Stat n="6" label="Bloom levels tagged" />
            <Stat n="21" label="Learning tools" />
            <Stat n="₹300/yr" label="Premium starts at" />
          </div>
        </div>
      </section>

      {/* BLOOM PYRAMID --------------------------------------------------- */}
      <section className="max-w-3xl mx-auto px-6 py-20">
        <div className="text-center mb-10">
          <h2 className="h1">Six levels. One clear picture.</h2>
          <p className="mt-3 muted max-w-xl mx-auto">
            Every question is tagged. Every answer reveals which level of thinking is solid —
            and which needs more practice.
          </p>
        </div>
        <div className="grid gap-2.5">
          {[
            { l: "Create",     d: "Design something new",         w: "100%", g: "linear-gradient(90deg, #ede9fe, #c4b5fd)", c: "#5b21b6" },
            { l: "Evaluate",   d: "Justify a decision",           w: "88%",  g: "linear-gradient(90deg, #fce7f3, #f9a8d4)", c: "#9d174d" },
            { l: "Analyze",    d: "Compare and contrast",         w: "76%",  g: "linear-gradient(90deg, #ffedd5, #fdba74)", c: "#9a3412" },
            { l: "Apply",      d: "Use what you know",            w: "64%",  g: "linear-gradient(90deg, #fef3c7, #fcd34d)", c: "#92400e" },
            { l: "Understand", d: "Explain in your own words",    w: "52%",  g: "linear-gradient(90deg, #d1fae5, #6ee7b7)", c: "#065f46" },
            { l: "Remember",   d: "Recall facts and definitions", w: "40%",  g: "linear-gradient(90deg, #dbeafe, #93c5fd)", c: "#1e40af" },
          ].map((r) => (
            <div key={r.l} className="flex items-center justify-center">
              <div
                className="rounded-xl px-4 py-3 text-center transition-transform hover:-translate-y-0.5"
                style={{
                  width: r.w,
                  background: r.g,
                  color: r.c,
                  boxShadow: "var(--shadow-sm)",
                }}
              >
                <span className="font-bold">{r.l}</span>
                <span className="text-sm ml-2 opacity-80">— {r.d}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* FEATURES -------------------------------------------------------- */}
      <section style={{ borderTop: "1px solid var(--color-border)", borderBottom: "1px solid var(--color-border)", background: "var(--color-card)" }}>
        <div className="max-w-5xl mx-auto px-6 py-20">
          <div className="text-center mb-12">
            <h2 className="h1">Everything you need, nothing you don&apos;t.</h2>
            <p className="mt-3 muted max-w-xl mx-auto">
              Built for teachers and serious students. No fluff, no celebrity-teacher fluff,
              no 90-minute lecture videos.
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-6">
            <FeatureCard
              icon={<Sparkles size={22} />}
              title="AI-generated MCQs"
              desc="From notes, an image, or a topic — questions tagged by Bloom level, ready to review."
            />
            <FeatureCard
              icon={<Timer size={22} />}
              title="Live timed quizzes"
              desc="Share a code, students join from any device, auto-submit on time-up."
            />
            <FeatureCard
              icon={<BarChart3 size={22} />}
              title="Thinking-level analytics"
              desc="Per-class and per-student progress across topics and Bloom levels — over time."
            />
            <FeatureCard
              icon={<Brain size={22} />}
              title="AI tutor + Coach"
              desc="A patient tutor who explains; a coach who calls out your slipping areas."
            />
            <FeatureCard
              icon={<Target size={22} />}
              title="Exam-prep tools"
              desc="JEE/NEET/CAT/UPSC mock-rank predictor, past-paper X-ray, trap detector."
            />
            <FeatureCard
              icon={<Layers size={22} />}
              title="School-grade plans"
              desc="Per-student pricing, teacher dashboards, class management, no per-seat fees."
            />
          </div>
        </div>
      </section>

      {/* BOTTOM CTA ------------------------------------------------------ */}
      <section className="max-w-3xl mx-auto px-6 py-20 text-center">
        <h2 className="h1">Ready to try it?</h2>
        <p className="mt-3 muted">
          Free forever for 3 practice tests a day. Upgrade anytime to unlock the full toolkit.
        </p>
        <div className="mt-8 flex flex-col sm:flex-row gap-3 items-center justify-center">
          <Link
            href="/login"
            className="btn btn-primary text-base px-7 py-3 inline-flex items-center gap-2"
          >
            Get started free <ArrowRight size={18} />
          </Link>
          <Link
            href="/pricing"
            className="text-sm font-semibold px-4 py-2 rounded-lg transition"
            style={{ color: "var(--color-fg-soft)" }}
          >
            Compare plans →
          </Link>
        </div>
      </section>

      <footer
        className="max-w-6xl mx-auto px-6 py-8 text-center text-sm space-y-2"
        style={{ color: "var(--color-muted)", borderTop: "1px solid var(--color-border)" }}
      >
        <div>
          Built for teachers and learners who care about <em>how</em> the thinking happens. © BloomIQ
        </div>
        <div className="text-xs">
          <Link href="/terms" className="hover:underline">Terms of Service</Link>
          <span className="mx-2">·</span>
          <Link href="/privacy" className="hover:underline">Privacy Policy</Link>
          <span className="mx-2">·</span>
          <Link href="/pricing" className="hover:underline">Pricing</Link>
          <span className="mx-2">·</span>
          <Link href="/settings/appearance" className="hover:underline">Appearance</Link>
        </div>
      </footer>
    </main>
  );
}

/* -------------------------------------------------------------------------- */

function Stat({ n, label }: { n: string; label: string }) {
  return (
    <div className="card text-center" style={{ padding: "1rem 0.75rem" }}>
      <div className="text-2xl font-extrabold text-gradient-brand">{n}</div>
      <div className="text-xs muted mt-1">{label}</div>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div className="card card-hover card-feature">
      <div
        className="w-11 h-11 rounded-xl flex items-center justify-center mb-4"
        style={{
          background: "var(--gradient-cta)",
          color: "#fff",
          boxShadow: "var(--shadow-brand)",
        }}
      >
        {icon}
      </div>
      <h3 className="font-bold text-lg" style={{ color: "var(--color-fg)" }}>{title}</h3>
      <p className="mt-2 text-sm muted leading-relaxed">{desc}</p>
    </div>
  );
}
