"use client";

/**
 * <CurrentGoalChip />
 *
 * A small persistent pill that shows the student's current exam_goal
 * with a one-tap link to /student/settings/goal so they can change it
 * from anywhere. The chip is the "easier navigation back to the master
 * screen" called for during the goal-consolidation pass — every feature
 * page (Speed Trainer, Sprint, Drill, Practice, Generate, dashboard)
 * embeds one so context is always visible and editable.
 *
 * Visual contract:
 *   🎯 CAT prep · change
 *
 * Behaviour:
 *   - For independent students: clickable link → /student/settings/goal.
 *   - For school students: rendered without the "change" affordance and
 *     with a small lock icon, because their goal is set by the class
 *     they're enrolled in, not self-selection.
 *   - When the user has no goal yet (exam_goal === null): renders a
 *     "Set your goal →" call-to-action that links to the dashboard
 *     (which surfaces the StudentGoalPicker for first-time setup).
 *   - When loading or no profile data is available: renders nothing
 *     (chip is decorative, never blocks the page).
 *
 * Why client-side fetch (not props):
 *   - The chip is dropped on many surfaces. Asking every parent to
 *     pass props quickly drifts. A single self-contained fetch keeps
 *     usage trivial: `<CurrentGoalChip />` and we're done.
 *   - Cheap query (one row, two columns) and Supabase client caches
 *     the auth session across components on the same page.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Lock, Pencil } from "lucide-react";
import { STUDENT_GOALS } from "@/components/StudentGoalPicker";

type Props = {
  /** Optional extra className for layout tweaks at the call site. */
  className?: string;
};

export default function CurrentGoalChip({ className }: Props) {
  const [examGoal, setExamGoal] = useState<string | null>(null);
  const [isSchoolStudent, setIsSchoolStudent] = useState<boolean | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) return;
        const { data: prof } = await sb
          .from("profiles")
          .select("exam_goal, is_school_student")
          .eq("id", user.id)
          .maybeSingle();
        const row = prof as { exam_goal: string | null; is_school_student: boolean | null } | null;
        setExamGoal(row?.exam_goal ?? null);
        setIsSchoolStudent(!!row?.is_school_student);
      } catch { /* silent — chip just stays hidden */ }
      finally {
        setLoaded(true);
      }
    })();
  }, []);

  if (!loaded) return null;

  // School student with no goal yet — render nothing. School students
  // can't self-pick a goal (it's set by the class their teacher enrols
  // them in), so the amber "Set your goal" CTA below would route them
  // to a screen where they can't actually take action. The chip stays
  // silent until the class context flows through and surfaces the goal
  // automatically. Vipin caught this on 2026-05-12 (Ravi was seeing the
  // CTA on /student/generate which is wrong).
  if (!examGoal && isSchoolStudent) return null;

  // First-time / not-yet-set case for INDEPENDENT students — gentle CTA.
  if (!examGoal) {
    return (
      <Link
        href="/student"
        className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-amber-900 hover:bg-amber-100 transition ${className || ""}`}
      >
        <Pencil size={11} />
        <span><strong>Set your goal</strong> · tunes every test</span>
      </Link>
    );
  }

  const meta = STUDENT_GOALS.find((g) => g.id === examGoal);
  if (!meta) return null;

  // School student — read-only chip with lock icon. No edit link
  // because the class context dictates the goal.
  if (isSchoolStudent) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-900 ${className || ""}`}
        title="Set by your school"
      >
        <span>{meta.emoji}</span>
        <span><strong>{meta.label}</strong></span>
        <Lock size={11} className="opacity-60" />
      </span>
    );
  }

  // Independent student — clickable chip that routes to the master
  // settings screen. "change" is a soft affordance, not a hard CTA.
  return (
    <Link
      href="/student/settings/goal"
      className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-900 hover:bg-emerald-100 transition ${className || ""}`}
      title="Change your learning goal"
    >
      <span>{meta.emoji}</span>
      <span><strong>{meta.label}</strong></span>
      <span className="text-emerald-700 opacity-70">·</span>
      <span className="text-emerald-700 font-semibold">change</span>
    </Link>
  );
}
