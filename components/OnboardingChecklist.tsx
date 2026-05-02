"use client";

import Link from "next/link";
import { CheckCircle2, Circle, ArrowRight, Sparkles } from "lucide-react";

/**
 * <OnboardingChecklist>
 *
 * Activation gate at the top of /student/page.tsx. Two modes:
 *
 * mode='independent' (3 steps):
 *   - Pick exam goal → take first practice test → see Bloom breakdown
 *   - Goal step is usually pre-completed because StudentGoalPicker is a
 *     forced upstream gate.
 *
 * mode='school' (2 steps):
 *   - Take first assigned quiz → see Bloom breakdown
 *   - Goal step doesn't apply: school students inherit context from
 *     their class, not a self-selected goal.
 *   - The "first quiz" CTA points at /student/join (where they enter a
 *     class code) since school students don't generate their own tests
 *     — they take what their teacher assigns.
 *
 * Auto-hides once all steps are done so power users don't see it after
 * activation.
 *
 * Why this exists:
 *   The dashboard otherwise has 20+ interactive surfaces. New users
 *   freeze. This collapses the first session into one thing-to-do at a
 *   time, then gets out of the way once activation is complete.
 */

export type OnboardingStepState = {
  // For mode='independent'. Ignored for mode='school'.
  goalDone?: boolean;
  attemptDone: boolean;
  breakdownSeen: boolean;
  mode?: "independent" | "school";
};

export default function OnboardingChecklist({
  goalDone = true,
  attemptDone,
  breakdownSeen,
  mode = "independent",
}: OnboardingStepState) {
  type Step = {
    id: string;
    title: string;
    desc: string;
    done: boolean;
    cta: { label: string; href: string } | null;
  };
  const steps: Step[] = mode === "school"
    ? [
        {
          id: "attempt",
          title: "Take your first assigned quiz",
          desc: "Your teacher's quizzes are listed below. The first one you submit unlocks your Bloom scorecard.",
          done: attemptDone,
          // No CTA button — the assigned-quizzes section sits directly
          // below the checklist; pointing at it from a button would be
          // visual noise.
          cta: null,
        },
        {
          id: "breakdown",
          title: "See your strongest and weakest thinking levels",
          desc: "After your first quiz, the Bloom mastery chart lights up. We'll call out which level to drill next.",
          done: breakdownSeen,
          cta: null,
        },
      ]
    : [
        {
          id: "goal",
          title: "Pick what you're studying for",
          desc: "Your exam goal personalises every recommendation on this dashboard.",
          done: goalDone,
          cta: null,
        },
        {
          id: "attempt",
          title: "Take your first practice test",
          desc: "Five minutes. Gives you a real Bloom score to learn from — without it, every other tile on this page is guessing.",
          done: attemptDone,
          cta: attemptDone ? null : { label: "Generate a test", href: "/student/generate" },
        },
        {
          id: "breakdown",
          title: "See your strongest and weakest thinking levels",
          desc: "After your first test, the Bloom mastery chart lights up. We'll call out which level to drill next.",
          done: breakdownSeen,
          cta: null,
        },
      ];

  const completed = steps.filter((s) => s.done).length;
  const allDone = completed === steps.length;

  // Auto-hide once everything's done. No collapsed badge, no nag — the
  // dashboard simply reveals.
  if (allDone) return null;

  return (
    <div
      className="card mb-6 fade-in"
      style={{
        background: "color-mix(in oklab, var(--brand-100, #d1fae5) 35%, var(--color-card, #fff))",
        borderColor: "var(--brand-300, #6ee7b7)",
      }}
    >
      <header className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Sparkles size={18} style={{ color: "var(--brand-700, #047857)" }} />
          <h2 className="text-base font-bold">Get set up</h2>
        </div>
        <div className="text-xs font-semibold" style={{ color: "var(--brand-700, #047857)" }}>
          {completed} of {steps.length} done
        </div>
      </header>

      <p className="text-xs muted mb-4 leading-relaxed">
        {steps.length === 2 ? "Two" : "Three"} quick step{steps.length === 1 ? "" : "s"} and
        the rest of this page becomes useful. Skipping is fine — but everything
        below just guesses without your first score.
      </p>

      <ol className="space-y-2">
        {steps.map((step, idx) => (
          <li
            key={step.id}
            className="flex items-start gap-3 p-3 rounded-lg"
            style={{
              background: step.done
                ? "color-mix(in oklab, var(--brand-100) 25%, transparent)"
                : "var(--color-card, #fff)",
              border: "1px solid var(--color-border)",
              opacity: step.done ? 0.7 : 1,
            }}
          >
            <div className="shrink-0 mt-0.5">
              {step.done ? (
                <CheckCircle2 size={18} style={{ color: "var(--brand-600, #059669)" }} />
              ) : (
                <Circle size={18} className="muted" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div
                className="text-sm font-semibold"
                style={{
                  textDecoration: step.done ? "line-through" : "none",
                  color: step.done ? "var(--color-fg-soft)" : "var(--color-fg)",
                }}
              >
                {idx + 1}. {step.title}
              </div>
              <div
                className="text-xs leading-relaxed mt-0.5"
                style={{ color: "var(--color-fg-soft)" }}
              >
                {step.desc}
              </div>
            </div>
            {step.cta && !step.done && (
              <Link
                href={step.cta.href}
                className="btn btn-primary text-xs shrink-0 self-center"
              >
                {step.cta.label} <ArrowRight size={12} />
              </Link>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
