"use client";

/**
 * /student/settings/goal
 *
 * Master "change my learning context" screen. Single destination for
 * the persistent CurrentGoalChip on every feature page. Renders the
 * same StudentGoalPicker used on first-time onboarding — wraps it in
 * a "your current goal" header + a back link to the dashboard.
 *
 * Why a dedicated route (instead of overlaying an inline editor):
 *   - The chip lives in many places (dashboard, Speed Trainer, Sprint,
 *     Drill, Practice, Generate). All of them point here → one URL
 *     to remember, one save flow, one source of truth.
 *   - Users sometimes land here directly (bookmark, deep link). A
 *     full page renders predictably; an overlay needs context to host.
 *   - Easier to add audit / undo / coach copy in one place over time.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import StudentGoalPicker, { STUDENT_GOALS, type StudentGoalId } from "@/components/StudentGoalPicker";
import { ArrowLeft, Lock } from "lucide-react";

export default function ChangeGoalPage() {
  const router = useRouter();
  const [currentGoal, setCurrentGoal] = useState<string | null>(null);
  const [isSchoolStudent, setIsSchoolStudent] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) {
          router.replace("/login?next=/student/settings/goal");
          return;
        }
        const { data: prof } = await sb
          .from("profiles")
          .select("exam_goal, is_school_student")
          .eq("id", user.id)
          .maybeSingle();
        const row = prof as { exam_goal: string | null; is_school_student: boolean | null } | null;
        setCurrentGoal(row?.exam_goal ?? null);
        setIsSchoolStudent(!!row?.is_school_student);
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto pt-20 text-center">
        <div className="spinner mx-auto" />
      </div>
    );
  }

  const currentMeta = currentGoal
    ? STUDENT_GOALS.find((g) => g.id === currentGoal)
    : null;

  // School students see the picker in read-only / informational mode.
  // Their goal is dictated by class context, not self-selection — the
  // teacher / admin head decides the curriculum context for the class.
  if (isSchoolStudent) {
    return (
      <div className="max-w-2xl mx-auto fade-in">
        <Link
          href="/student"
          className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-emerald-700 mb-4"
        >
          <ArrowLeft size={14} /> Back to dashboard
        </Link>
        <div className="card">
          <div className="flex items-center gap-2 mb-3">
            <Lock size={18} className="text-amber-700" />
            <h1 className="text-xl font-bold">Learning context — set by your school</h1>
          </div>
          {currentMeta ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4 flex items-center gap-3">
              <span className="text-2xl">{currentMeta.emoji}</span>
              <div>
                <div className="font-semibold">{currentMeta.label}</div>
                <div className="text-xs text-slate-600">{currentMeta.sub}</div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-600">
              Your school hasn&apos;t set a curriculum context yet. Please reach out
              to your teacher.
            </p>
          )}
          <p className="text-sm text-slate-600 mt-4">
            Because your account is linked to a school, the learning context is
            dictated by the class you&apos;re enrolled in. To change it, please
            speak with your teacher or admin head.
          </p>
        </div>
      </div>
    );
  }

  // Independent student — full picker, can change anytime.
  return (
    <div className="max-w-2xl mx-auto fade-in">
      <Link
        href="/student"
        className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-emerald-700 mb-4"
      >
        <ArrowLeft size={14} /> Back to dashboard
      </Link>

      {currentMeta && (
        <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3 flex items-center gap-3">
          <span className="text-xs uppercase tracking-wide font-semibold text-slate-500">Currently:</span>
          <span className="text-xl">{currentMeta.emoji}</span>
          <span className="font-semibold text-sm">{currentMeta.label}</span>
          <span className="text-xs text-slate-600">{currentMeta.sub}</span>
        </div>
      )}

      <StudentGoalPicker
        onPicked={(_goal: StudentGoalId) => {
          // StudentGoalPicker already persisted both exam_goal and
          // learner_profile via its internal pick() handler. Route back
          // to the dashboard so the user sees the updated chip and
          // tile prioritisation immediately.
          router.replace("/student");
        }}
      />
    </div>
  );
}
