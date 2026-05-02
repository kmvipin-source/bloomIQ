"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Search } from "lucide-react";
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
 * /student/diagnose — Diagnose a weakness index page
 *
 * Sidebar destination for the "Diagnose a weakness" verb in the new
 * Test / Train / Diagnose taxonomy. Shows every diagnose-category
 * tile (Misconception Detective, Past-Paper X-Ray, Trap Detector,
 * Rank Predictor, Knowledge Graph) sorted by the active goal's
 * primary→secondary priority.
 *
 * Lock-aware — locked tiles open the paywall modal instead of
 * navigating, with the lowest unlocking tier on the badge.
 */
export default function DiagnoseIndexPage() {
  const [examGoal, setExamGoal] = useState<string | null>(null);
  const [isSchoolStudent, setIsSchoolStudent] = useState<boolean | null>(null);
  const access = useFeatureAccess();

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

  const goal = isSchoolStudent ? null : examGoal;
  const buckets = tilesByCategoryForGoal(goal);
  const diagnoseKeys = buckets.diagnose;
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
        <div className="rounded-lg bg-amber-100 text-amber-700 p-2">
          <Search size={20} />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">
          {CATEGORY_META.diagnose.label}
        </h1>
        {goalMeta && (
          <span className="text-[10px] uppercase tracking-wide font-bold text-amber-700 bg-amber-100 rounded-full px-2 py-0.5">
            Sorted for {goalMeta.label}
          </span>
        )}
        {isSchoolStudent && (
          <span className="text-[10px] uppercase tracking-wide font-bold text-amber-700 bg-amber-100 rounded-full px-2 py-0.5">
            Your school&apos;s plan
          </span>
        )}
      </div>
      <p className="text-sm muted mb-6 max-w-2xl">
        {CATEGORY_META.diagnose.intro}
      </p>

      {diagnoseKeys.length === 0 ? (
        <div className="card text-center py-10 muted text-sm">
          Loading diagnostic lenses…
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {diagnoseKeys.map((key) => {
            const meta = TILE_META[key];
            const fk = meta.featureKey;
            const locked = !access.isLoading && !!fk && !access.allowed.has(fk);
            return (
              <StudentFeatureTile
                key={key}
                meta={meta}
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
