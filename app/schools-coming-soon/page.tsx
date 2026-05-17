"use client";

/**
 * /schools-coming-soon
 *
 * Public-facing waitlist landing page reached when school onboarding is
 * gated off (school_signup_enabled=false). Three jobs:
 *
 *   1. Tell the visitor schools are coming, not gone forever.
 *   2. Capture their email so we can notify them when we open up.
 *   3. Keep existing school users out of harm's way — if they try to sign
 *      in here we point them at /login/school which still works for
 *      already-onboarded schools.
 *
 * Email capture posts to /api/waitlist/schools (TODO when we wire it).
 * Until that endpoint exists, the form does an opportunistic mailto:
 * fallback so the lead never gets dropped.
 */

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Building2, CheckCircle2, Mail } from "lucide-react";

export default function SchoolsComingSoonPage() {
  const [email, setEmail] = useState("");
  const [schoolName, setSchoolName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("That email doesn't look right.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/waitlist/schools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, school_name: schoolName }),
      });
      // F2 fix: only flip to "done" on a real success. If the endpoint
      // returns an error we show it AND offer a manual-email fallback,
      // instead of silently telling the user "you're on the list" while
      // dropping their lead. Duplicate signups are treated as success
      // by the API (already_on_list:true) so the friendly path covers
      // the common case.
      if (!res.ok) {
        let serverMsg = `Server responded ${res.status}.`;
        try {
          const j = await res.json();
          if (j?.error) serverMsg = j.error;
        } catch {
          /* non-JSON body — keep generic message */
        }
        setError(serverMsg);
        return;
      }
      setDone(true);
    } catch (err) {
      // Network error — be honest about it. No fake success.
      setError(
        err instanceof Error
          ? `Could not reach the server: ${err.message}`
          : "Could not reach the server. Please try again."
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft size={14} /> Back to home
        </Link>

        <div className="mt-8 flex items-start gap-4">
          <div className="rounded-xl bg-emerald-100 p-3 text-emerald-700">
            <Building2 size={28} />
          </div>
          <div>
            <h1 className="text-3xl font-semibold text-slate-900">
              ZCORIQ for schools — coming soon
            </h1>
            <p className="mt-2 text-slate-600">
              We&apos;re launching for independent learners first and rolling out
              to schools in carefully-paced waves. If you&apos;d like your
              school to be in the next wave, leave your details below and
              we&apos;ll be in touch.
            </p>
          </div>
        </div>

        {done ? (
          <div className="mt-10 rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-emerald-900">
            <div className="flex items-center gap-2 text-lg font-semibold">
              <CheckCircle2 size={20} />
              You&apos;re on the list.
            </div>
            <p className="mt-2 text-sm">
              We&apos;ll email you the moment school onboarding opens for your
              region. In the meantime, if you have questions, write to{" "}
              <a
                href="mailto:hello@bloomiq.app"
                className="underline underline-offset-2"
              >
                hello@bloomiq.app
              </a>
              .
            </p>
          </div>
        ) : (
          <form
            onSubmit={submit}
            className="mt-10 space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
          >
            <div>
              <label className="block text-sm font-medium text-slate-700">
                Work email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="principal@school.edu"
                required
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">
                School name <span className="text-slate-400">(optional)</span>
              </label>
              <input
                type="text"
                value={schoolName}
                onChange={(e) => setSchoolName(e.target.value)}
                placeholder="Greenfield International School"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
              />
            </div>

            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                <div>{error}</div>
                {/* Manual escape hatch — if the server is unreachable we
                    don't want a real lead to bounce off into nothing. */}
                <a
                  href={`mailto:hello@bloomiq.app?subject=${encodeURIComponent(
                    "ZCORIQ school waitlist"
                  )}&body=${encodeURIComponent(
                    `Email: ${email}\nSchool: ${schoolName || "(not provided)"}`
                  )}`}
                  className="mt-1 inline-block underline underline-offset-2 hover:text-red-900"
                >
                  Email us directly instead
                </a>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
            >
              <Mail size={16} />
              {submitting ? "Submitting…" : "Join the school waitlist"}
            </button>

            <p className="text-xs text-slate-500">
              Already onboarded? Sign in at{" "}
              <Link href="/login/school" className="underline">
                /login/school
              </Link>
              . Existing schools and their teachers / students keep working
              normally.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
