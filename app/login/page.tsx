"use client";

// =============================================================================
// /login — the unified front door (Option B)
// =============================================================================
// One picker page handles BOTH sign-in and sign-up. Two audience cards:
//   - For schools          → sign in to /login/school, or "Talk to us"
//                            (Admin Head accounts are invite-only)
//   - For independent      → sign in to /login/student, or sign up at
//     learners               /signup?role=student
//
// The homepage's "Sign in" and "Get started free" CTAs both point here, so
// users only ever encounter ONE audience picker. Behind each card the flow
// branches by intent (existing user vs. new user) without making the user
// pick that distinction up front — they pick "I'm with a school" or
// "I'm a personal learner" first, then the appropriate action.
//
// Layout note: each card is a plain <div>; primary actions are <Link>s that
// don't nest. No <a>-in-<a> hydration warnings.
// =============================================================================

import Link from "next/link";
import { Building2, GraduationCap, ArrowRight, LogIn, UserPlus, Mail } from "lucide-react";

export default function LoginFrontDoor() {
  return (
    <main className="min-h-screen grid place-items-center px-6 py-10 bg-gradient-to-br from-emerald-50 via-white to-sky-50">
      <div className="w-full max-w-3xl">
        <Link href="/" className="flex items-center gap-2 justify-center mb-8">
          <span className="text-3xl">🌱</span>
          <span className="text-xl font-bold">ZCORIQ</span>
        </Link>

        <h1 className="text-2xl sm:text-3xl font-bold text-center mb-2">Welcome.</h1>
        <p className="text-sm text-slate-600 text-center mb-8">
          Pick the option that describes you. Existing users sign in;
          new users create an account from the same card.
        </p>

        <div className="grid sm:grid-cols-2 gap-4">
          {/* ============ For schools ============ */}
          <div className="card flex flex-col items-start gap-3">
            <div
              className="w-12 h-12 rounded-xl grid place-items-center"
              style={{
                background: "color-mix(in oklab, var(--brand-100, #d1fae5) 50%, transparent)",
                color: "var(--brand-700, #047857)",
              }}
            >
              <Building2 size={24} />
            </div>
            <h2 className="font-semibold text-base">For schools</h2>
            <p className="text-sm text-slate-600 leading-relaxed flex-1">
              Teachers, principals, and students at a school. Sign in with
              the credentials your school set up.
            </p>
            <Link
              href="/login/school"
              className="btn btn-primary w-full inline-flex items-center justify-center gap-1.5 mt-2 whitespace-nowrap"
            >
              <LogIn size={14} /> Sign in
            </Link>
            {/* New school onboarding is invite-only, not self-serve. The
                "sign up" slot on this card is therefore a mailto rather
                than a /signup link. */}
            <a
              href="mailto:hello@bloomiq.app?subject=ZCORIQ%20school%20onboarding"
              className="btn btn-secondary w-full inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
            >
              <Mail size={14} /> Talk to us
            </a>
            <span className="text-xs text-slate-500 mt-1">
              Admin Head accounts are provisioned by ZCORIQ — there is no
              self-serve sign-up.
            </span>
          </div>

          {/* ============ For independent learners ============ */}
          <div className="card flex flex-col items-start gap-3">
            <div
              className="w-12 h-12 rounded-xl grid place-items-center"
              style={{
                background: "color-mix(in oklab, var(--brand-100, #d1fae5) 50%, transparent)",
                color: "var(--brand-700, #047857)",
              }}
            >
              <GraduationCap size={24} />
            </div>
            <h2 className="font-semibold text-base">For independent learners</h2>
            <p className="text-sm text-slate-600 leading-relaxed flex-1">
              Self-study with your own subscription. Practise tests, track
              your Bloom-level mastery, build a study habit.
            </p>
            <Link
              href="/login/student"
              className="btn btn-primary w-full inline-flex items-center justify-center gap-1.5 mt-2 whitespace-nowrap"
            >
              <LogIn size={14} /> Sign in
            </Link>
            <Link
              href="/signup?role=student"
              className="btn btn-secondary w-full inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
            >
              <UserPlus size={14} /> Create account
            </Link>
            <span className="text-xs text-slate-500 mt-1">
              Free to start. Premium plans from ₹300 / year — see{" "}
              <Link href="/pricing" className="text-emerald-700 font-semibold hover:underline">
                pricing
              </Link>
              .
            </span>
          </div>
        </div>

        <div className="mt-8 text-center text-xs text-slate-500">
          Your school isn&apos;t on ZCORIQ yet?{" "}
          <a
            href="mailto:hello@bloomiq.app?subject=ZCORIQ%20school%20onboarding"
            className="text-emerald-700 font-semibold hover:underline"
          >
            Talk to us about onboarding <ArrowRight size={10} className="inline" />
          </a>
        </div>

        <p className="text-xs text-slate-500 text-center mt-3">
          ZCORIQ staff sign in via{" "}
          <Link href="/staff" className="text-emerald-700 font-semibold hover:underline">/staff</Link>.
        </p>
      </div>
    </main>
  );
}
