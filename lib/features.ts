/**
 * lib/features.ts
 *
 * Single source of truth for every gateable feature in ZCORIQ.
 *
 * Each entry has:
 *   - `key`: stable string used in plans.features jsonb arrays and in
 *     useFeatureAccess() checks throughout the app. NEVER rename without
 *     a migration to update existing plan rows.
 *   - `label`: shown in the platform-admin plan editor checkbox grid.
 *   - `category`: groups checkboxes in the editor UI.
 *   - `description`: tooltip text for the editor.
 *
 * Adding a new gateable feature?
 *   1. Add a row here.
 *   2. The platform-admin plan editor grid auto-renders it.
 *   3. Wherever the feature surfaces, wrap with useFeatureAccess(KEY) /
 *      requireFeature(KEY) so it gets gated.
 *
 * Removing a feature key from existing plans WITHOUT removing the row
 * here is fine — the registry tolerates orphan keys in plan.features
 * but only surfaces keys present here in the editor UI.
 */

export type FeatureCategory =
  | "core_assessment"   // Practice tests, scoring, basic analytics
  | "metacognition"     // Teach-Back, Misconception, Calibration — ZCORIQ's USP
  | "exam_prep"         // Sprint, Speed, Trap, Rank
  | "ai_tutoring"       // Tutor, Voice, Visualizer
  | "memory_retention"  // Memory (SRS), Knowledge Graph
  | "school_admin"      // Bloom Pulse, Coach, Digest (super_teacher only)
  | "limits"            // Daily attempt cap, single-device, etc.
  | "support";          // Priority support, dedicated CSM, etc.

export const FEATURE_CATEGORY_LABELS: Record<FeatureCategory, string> = {
  core_assessment: "Core assessment",
  metacognition: "Metacognitive layer",
  exam_prep: "Exam preparation",
  ai_tutoring: "AI tutoring",
  memory_retention: "Memory & retention",
  school_admin: "School admin",
  limits: "Caps & limits",
  support: "Support",
};

/**
 * Stable display order for the category sections in the plan editor.
 * Mirrors the order in the FeatureCategory union above. Keep in sync if
 * a new category is added.
 */
export const FEATURE_CATEGORY_ORDER: FeatureCategory[] = [
  "core_assessment",
  "metacognition",
  "exam_prep",
  "ai_tutoring",
  "memory_retention",
  "school_admin",
  "limits",
  "support",
];

export type FeatureDef = {
  key: string;
  label: string;
  category: FeatureCategory;
  description: string;
};

export const FEATURES: FeatureDef[] = [
  // ---------- core_assessment ----------
  {
    key: "practice_tests_unlimited",
    label: "Unlimited practice tests",
    category: "core_assessment",
    description: "No daily cap on test generation or submissions.",
  },
  {
    key: "bloom_report_full",
    label: "Full Bloom mastery report",
    category: "core_assessment",
    description: "Per-level percentage, trend, topic breakdown.",
  },
  {
    key: "report_pdf_export",
    label: "PDF / Excel report export",
    category: "core_assessment",
    description: "Download mastery + attempt reports.",
  },

  // ---------- metacognition ----------
  {
    key: "teach_back",
    label: "Teach-Back",
    category: "metacognition",
    description: "Feynman-style explain-the-topic grader.",
  },
  {
    key: "misconceptions",
    label: "Misconception Detective",
    category: "metacognition",
    description: "Names the specific mental error behind wrong answers + targeted drills.",
  },
  {
    key: "calibration",
    // Renamed 2026-05-13: "Confidence Calibration" → "Confidence Insights"
    // to disambiguate from Speed-Accuracy Trainer. The OLD name read like
    // an interactive feature; users opening it expected to "do" calibration
    // but actually landed on a read-only chart. New name reads as a
    // dashboard, which is what it actually is. URL `/student/calibration`
    // kept for back-compat — see app/student/calibration/page.tsx.
    label: "Confidence Insights",
    category: "metacognition",
    description: "Read-only dashboard of your stated-vs-actual confidence per band. Builds from Speed Trainer ratings — defeats negative marking.",
  },
  {
    key: "cohort_benchmarks",
    label: "Cohort pacing benchmarks",
    category: "metacognition",
    description:
      "Per-question median time across other students who attempted the same question, with fast / on-pace / slow indicators.",
  },

  // ---------- exam_prep ----------
  {
    key: "exam_sprint",
    label: "Exam Sprint Mode",
    category: "exam_prep",
    description: "Daily 3-task mission tuned to days-to-exam.",
  },
  {
    key: "speed_trainer",
    label: "Speed-Accuracy Trainer",
    category: "exam_prep",
    description: "Bloom-tuned target times per question.",
  },
  {
    key: "trap_detector",
    label: "Distractor Trap Detector",
    category: "exam_prep",
    description: "Examiner-trap pattern classification.",
  },
  {
    key: "rank_predictor",
    label: "Mock Rank Predictor",
    category: "exam_prep",
    description: "AIR estimate against JEE/NEET/CAT cohorts.",
  },
  {
    key: "past_paper_xray",
    label: "Past-Paper X-Ray",
    category: "exam_prep",
    description: "Bloom-tag every question on a past paper + 5 study targets.",
  },

  // ---------- ai_tutoring ----------
  {
    key: "ai_tutor_text",
    label: "Doubt-Clearing AI Tutor (text)",
    category: "ai_tutoring",
    description: "24/7 Socratic chat tutor.",
  },
  {
    key: "voice_tutor",
    label: "Voice AI Teacher",
    category: "ai_tutoring",
    description: "Speak your doubt, hear the answer back.",
  },
  {
    key: "concept_visualizer",
    label: "Concept Visualizer",
    category: "ai_tutoring",
    description: "Animated, narrated explainer slideshows.",
  },

  // ---------- memory_retention ----------
  {
    key: "memory_srs",
    label: "Memory Tune-Up (SRS)",
    category: "memory_retention",
    description: "Spaced repetition for wrong answers.",
  },
  {
    key: "knowledge_graph",
    label: "Knowledge Graph",
    category: "memory_retention",
    description: "Visual map of practiced topics with prerequisite arrows.",
  },

  // ---------- school_admin ----------
  {
    key: "bloom_pulse",
    label: "Bloom Pulse",
    category: "school_admin",
    description: "School-wide Bloom mastery report (PDF + Excel).",
  },
  {
    key: "principal_coach",
    label: "Principal Coach",
    category: "school_admin",
    description: "AI chat over the school's data.",
  },
  {
    key: "weekly_digest",
    label: "Weekly digest email",
    category: "school_admin",
    description: "Auto-summarised weekly briefing for admin / teacher / student.",
  },

  // ---------- limits ----------
  {
    key: "single_device",
    label: "Single-device session",
    category: "limits",
    description: "Block multi-device sign-in (free-tier credential-share friction).",
  },

  // ---------- support ----------
  {
    key: "priority_support",
    label: "Priority email support",
    category: "support",
    description: "Reply within 1 business day.",
  },
  {
    key: "dedicated_csm",
    label: "Dedicated customer success",
    category: "support",
    description: "Named contact + onboarding session (school plans).",
  },
];

export const FEATURES_BY_KEY: Record<string, FeatureDef> = Object.fromEntries(
  FEATURES.map((f) => [f.key, f])
);

export const FEATURES_BY_CATEGORY: Record<FeatureCategory, FeatureDef[]> = (() => {
  const out = {} as Record<FeatureCategory, FeatureDef[]>;
  for (const f of FEATURES) {
    (out[f.category] ||= []).push(f);
  }
  return out;
})();
