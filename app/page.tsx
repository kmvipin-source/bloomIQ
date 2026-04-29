import Link from "next/link";
import { ArrowRight } from "lucide-react";

export default function LandingPage() {
  return (
    <main className="min-h-screen">
      {/* Top nav — gives visitors a clear path to pricing and sign-in without
          having to dig through the page. Mirrors the /pricing top bar so the
          two pages feel like one site. */}
      <header className="border-b border-slate-200/60 bg-white/70 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-2xl">🌱</span>
            <span className="font-bold tracking-tight">BloomIQ</span>
          </Link>
          <nav className="flex items-center gap-2 sm:gap-4">
            <Link href="/pricing" className="text-sm font-semibold text-slate-700 hover:text-emerald-700 px-2 py-1">
              Pricing
            </Link>
            <Link href="/login" className="text-sm font-semibold text-slate-700 hover:text-emerald-700 px-2 py-1">
              Sign in
            </Link>
            <Link href="/signup" className="btn btn-primary text-sm">
              Create account
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-emerald-50 via-white to-sky-50" />
        <div className="relative max-w-4xl mx-auto px-6 pt-20 pb-16 text-center">
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-slate-900 leading-tight">
            Assess <span className="text-emerald-600">how students think</span>,
            <br className="hidden sm:block" /> not just what they recall.
          </h1>
          <p className="mt-6 text-lg text-slate-600 max-w-2xl mx-auto">
            AI-generated multiple-choice questions tagged by Bloom&apos;s Taxonomy. See exactly which thinking levels are strong, and which need work.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row gap-3 items-center justify-center">
            <Link href="/signup" className="btn btn-primary text-base px-8 py-3 inline-flex items-center gap-2">
              Get started free <ArrowRight size={18} />
            </Link>
            <Link href="/pricing" className="text-sm text-slate-600 hover:text-emerald-700 font-medium px-4 py-2">
              See plans &amp; pricing →
            </Link>
          </div>
        </div>
      </section>

      {/* Bloom levels visualization */}
      <section className="max-w-3xl mx-auto px-6 py-20">
        <div className="text-center mb-10">
          <h2 className="text-2xl md:text-3xl font-bold">Six levels. One clear picture.</h2>
          <p className="mt-3 text-slate-600">
            Every question is tagged. Every answer reveals which level of thinking is solid — and which needs more practice.
          </p>
        </div>
        <div className="grid gap-2">
          {[
            { l: "Create",     d: "Design something new",         c: "bg-violet-100 text-violet-900",   w: "100%" },
            { l: "Evaluate",   d: "Justify a decision",           c: "bg-pink-100 text-pink-900",       w: "88%"  },
            { l: "Analyze",    d: "Compare and contrast",         c: "bg-orange-100 text-orange-900",   w: "76%"  },
            { l: "Apply",      d: "Use what you know",            c: "bg-amber-100 text-amber-900",     w: "64%"  },
            { l: "Understand", d: "Explain in your own words",    c: "bg-emerald-100 text-emerald-900", w: "52%"  },
            { l: "Remember",   d: "Recall facts and definitions", c: "bg-sky-100 text-sky-900",         w: "40%"  },
          ].map((r) => (
            <div key={r.l} className="flex items-center justify-center">
              <div className={`${r.c} rounded-md px-4 py-3 text-center`} style={{ width: r.w }}>
                <span className="font-semibold">{r.l}</span>
                <span className="text-slate-600 text-sm ml-2">— {r.d}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Three features */}
      <section className="bg-white border-y border-slate-200">
        <div className="max-w-5xl mx-auto px-6 py-16 grid md:grid-cols-3 gap-6">
          {[
            { i: "✨", t: "AI-generated MCQs",        d: "From notes, an image, a topic — questions tagged by Bloom level, ready to review." },
            { i: "⏱️", t: "Live timed quizzes",       d: "Share a code, students join from any device, auto-submit on time-up." },
            { i: "📊", t: "Thinking-level analytics", d: "Per-class and per-student progress across topics and Bloom levels — over time." },
          ].map((f) => (
            <div key={f.t} className="card card-hover">
              <div className="text-3xl mb-3">{f.i}</div>
              <h3 className="font-bold text-lg">{f.t}</h3>
              <p className="text-slate-600 mt-2 text-sm">{f.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="max-w-3xl mx-auto px-6 py-16 text-center">
        <h2 className="text-2xl font-bold mb-2">Ready to try it?</h2>
        <p className="text-slate-600 mb-6">Free forever for 3 practice tests a day. Upgrade anytime.</p>
        <div className="flex flex-col sm:flex-row gap-3 items-center justify-center">
          <Link href="/signup" className="btn btn-primary text-base px-8 py-3 inline-flex items-center gap-2">
            Get started free <ArrowRight size={18} />
          </Link>
          <Link href="/pricing" className="text-sm text-slate-600 hover:text-emerald-700 font-medium px-4 py-2">
            Compare plans →
          </Link>
        </div>
      </section>

      <footer className="max-w-6xl mx-auto px-6 py-8 text-center text-sm text-slate-500 border-t border-slate-200">
        Built for teachers and learners who care about <em>how</em> the thinking happens. © BloomIQ
      </footer>
    </main>
  );
}
