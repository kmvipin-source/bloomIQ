/**
 * lib/learnerProfileFromGoal.ts
 *
 * Single source of truth for the exam_goal → learner_profile derivation.
 *
 * Background:
 *   - profile.exam_goal is the GRANULAR field captured by StudentGoalPicker
 *     ("jee_main", "neet_prep", "cat_prep", "class10_boards", etc.).
 *   - profile.learner_profile is the COARSE field used by topic-skill
 *     detection ("k12" | "competitive_exam" | "corporate"). It used to be
 *     captured separately via the inline LearnerProfilePrompt on the
 *     generate pages — a redundant capture point that confused users.
 *
 * We now derive learner_profile from exam_goal at the moment exam_goal
 * is written. The two fields stay in sync without the user managing both,
 * and the inline pill on the generate pages can go away.
 *
 * Where this runs:
 *   - Wherever profile.exam_goal is updated (StudentGoalPicker save +
 *     the master settings page) we also call this helper and write the
 *     derived value into profile.learner_profile.
 *
 * Edge cases:
 *   - "exploring" (default for users who haven't decided yet) → k12.
 *     k12 is the most conservative default; topic-skill detection is
 *     off for k12 so we don't try to detect "Java" as a skill for a
 *     curious student noodling on photosynthesis.
 *   - Anything unrecognised → k12 (same rationale).
 */

import type { LearnerProfile } from "@/components/LearnerProfilePrompt";

/**
 * Map every exam_goal slug to its corresponding learner_profile. Kept
 * deliberately exhaustive — adding a new goal in StudentGoalPicker should
 * also add an entry here so the mapping is reviewed.
 */
const GOAL_TO_PROFILE: Record<string, LearnerProfile> = {
  // ── Competitive exams ──
  jee_main:    "competitive_exam",
  jee_prep:    "competitive_exam",
  neet_prep:   "competitive_exam",
  cat_prep:    "competitive_exam",
  upsc_prep:   "competitive_exam",
  bank_exams:  "competitive_exam",

  // ── K-12 / school ──
  class5_8:        "k12",
  class_5_8:       "k12",
  class_9:         "k12",
  class9:          "k12",
  class10_boards:  "k12",
  class_10_boards: "k12",
  class12_boards:  "k12",
  class_12_boards: "k12",

  // ── Corporate / professional ──
  corporate: "corporate",

  // ── Exploration / unknown ──
  exploring: "k12",
};

/**
 * Derive the coarse learner_profile from a granular exam_goal slug.
 *
 * @param examGoal The exam_goal value from profiles.exam_goal. May be null
 *                 when the user hasn't picked one yet.
 * @returns        The derived learner_profile. Defaults to "k12" for null
 *                 or unrecognised input.
 */
export function learnerProfileFromGoal(examGoal: string | null | undefined): LearnerProfile {
  if (!examGoal) return "k12";
  const slug = String(examGoal).toLowerCase().trim();
  return GOAL_TO_PROFILE[slug] ?? "k12";
}
