"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Wrench } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import StudentFeatureTile from "@/components/StudentFeatureTile";
import PaywallModal from "@/components/PaywallModal";
import {
  TILE_META,
  tilesByCategoryForGoal,
  CATEGORY_META,
} from "@/lib/studentGoalTiles";
import {
  useFeatureAccess,
  findUnlockingTier,
} from "@/lib/featureAccess";
import { STUDENT_GOALS } from "@/components/StudentGoalPicker";
import type { PlanTier } from "@/lib/types";

/**
 * /student/train — Train your skills index page
 *
 * Sidebar destination for the "Train your skills" verb in the new
 * Test / Train / Diagnose taxonomy. Shows every train-category tile
 * (Sprint, Speed, Tutor, Visualizer, Memory, Calibration, Voice
 * Teacher, Teach-Back) sorted by the active goal's primary→secondary
 * priority. Same lock-aware behaviour as the dashboard tiles —
 * locked tiles open the paywall modal instead of navigating.
 *
 * For school students (is_school_student = true) we pass null to
 * tilesByCategoryForGoal so the order matches the school-side
 * dashboard render. Goal personalisation only applies to
 * independent students.
 */
export default function TrainIndexPage() {
  const [examGoal, setExamGoal] = useState<string | null>(null);
  const [isSchoolStudent, setIsSchoolStudent] = useState<boolean | null>(null);
  const access = useFeatureAccess();

  // Mirror dashboard: pre-resolve which tier unlocks each locked tile so
  // the badge label is accurate.
  const [unlockMap, setUnlockMap] = useState<
    Record<string, { tier: PlanTier; label: string }>
  >({});
  const [paywall, setPaywall] = useState<{ key: string; tier: PlanTier | null }>({
    key: "",
    tier: null,
  });

  useEffect(() => {
    (async () => {
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;
      const { data } = await sb
        .from("profiles")
        .select("exam_goal, is_school_student")
        .eq("id", user.id)
        .single();
      const prof = data as { exam_goal?: string | null; is_school_student?: boolean } | null;
      setIsSchoolStudent(!!prof?.is_school_student);
      setExamGoal(prof?.exam_goal || null);
    })();
  }, []);

  useEffect(() => {
    if (access.isLoading) return;
    (async () => {
      const out: Record<string, { tier: PlanTier; label: string }> = {};
      const keys = Object.values(TILE_META)
        .map((m) => m.featureKey)
        .filter(Boolean) as string[];
      for (const k of keys) {
        if (access.allowed.has(k)) continue;
        const tier = await findUnlockingTier(k, isSchoolStudent ? "school" : "personal");
        if (tier) out[k] = { tier: tier.tier, label: tier.label };
      }
      setUnlockMap(out);
    })();
  }, [access.isLoading, access.allowed, isSchoolStudent]);

  function openPaywall(key: string | undefined) {
    if (!key) return;
    setPaywall({ key, tier: unlockMap[key]?.tier || null });
  }

  // School students don't get goal-based reordering — their dashboard
  // passes null, so this page does too.
  const goal = isSchoolStudent ? null : examGoal;
  const buckets = tilesByCategoryForGoal(goal);
  const trainKeys = buckets.train;
  const goalMeta = goal ? STUDENT_GOALS.find((g) => g.id === goal) : null;

  return (
    <main className="px-6 py-8 max-w-6xl mx-auto">
      <Link
        href="/student"
        className="inline-flex items-center gap-1 text-xs muted hover:underline mb-3"
      >
        <ArrowLeft size={12} /> Back to dashboard
      </Link>

      <div className="flex items-center gap-3 mb-1">
        <div className="rounded-lg bg-emerald-100 text-emerald-700 p-2">
          <Wrench size={20} />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">
          {CATEGORY_META.train.label}
        </h1>
        {goalMeta && (
          <span className="text-[10px] uppercase tracking-wide font-bold text-emerald-700 bg-emerald-100 rounded-full px-2 py-0.5">
            Sorted for {goalMeta.label}
          </span>
        )}
        {isSchoolStudent && (
          <span className="text-[10px] uppercase tracking-wide font-bold text-emerald-700 bg-emerald-100 rounded-full px-2 py-0.5">
            Your school&apos;s plan
          </span>
        )}
      </div>
      <p className="text-sm muted mb-6 max-w-2xl">
        {CATEGORY_META.train.intro}
      </p>

      {trainKeys.length === 0 ? (
        <div className="card text-center py-10 muted text-sm">
          Loading skill-builders…
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {trainKeys.map((key) => {
            const meta = TILE_META[key];
            const fk = meta.featureKey;
            const locked = !access.isLoading && !!fk && !access.allowed.has(fk);
            return (
              <StudentFeatureTile
                key={key}
                meta={meta}
                fullWidth={key === "sprint"}
                locked={locked}
                lockedTierLabel={fk ? unlockMap[fk]?.label : undefined}
                onLockedClick={openPaywall}
              />
            );
          })}
        </div>
      )}

      <PaywallModal
        open={!!paywall.key}
        onClose={() => setPaywall({ key: "", tier: null })}
        featureKey={paywall.key || null}
        unlockingTier={paywall.tier}
        currentTier={access.planTier}
        isSchoolStudent={isSchoolStudent || false}
      />
    </main>
  );
}
