// lib/teachingContext.ts
// =============================================================================
// Teaching-context validation. Single source of truth for the cross-field
// checks on /teacher/generate (and later /teacher/quizzes/new).
//
// Design tenets:
//   1. Vocabulary lives ONCE — re-uses the category slug system from
//      lib/questionCategory.ts (categoryLabel, categoryBucket, etc.) so a
//      slug change there flows here without surgery.
//   2. Pure functions. No React, no Supabase. Import from /app OR /api.
//   3. The validator is severity-graded so the UI can render the right tone
//      (clean / amber tip / red banner with override).
//   4. Rules use teacher-friendly language. We're talking to working
//      teachers under time pressure, not engineers.
// =============================================================================

import { BLOOM_META, type BloomLevel } from "@/lib/bloom";
import {
  categoryBucket,
  categoryLabel,
  categoryRank,
  classGradeToCategory,
  validateGenerationFit,
} from "@/lib/questionCategory";

// =============================================================================
// Dropdown vocabulary — the menu the teacher sees
// =============================================================================

/** One option in the teaching-context dropdown. `value` is the category slug
 *  (same vocabulary as questionCategory.ts / profiles.exam_goal). */
export type TeachingContextOption = {
  value: string;
  label: string;
  group:
    | "K-12 curriculum"
    | "Engineering entrance"
    | "Medical entrance"
    | "Management entrance"
    | "Government / civil services"
    | "Law / language / other entrances"
    | "Other";
};

export const TEACHING_CONTEXT_OPTIONS: ReadonlyArray<TeachingContextOption> = [
  // K-12
  { value: "class5_8",         label: "Class 5-8",            group: "K-12 curriculum" },
  { value: "class_9",          label: "Class 9",              group: "K-12 curriculum" },
  { value: "class_10_boards",  label: "Class 10 (boards)",    group: "K-12 curriculum" },
  { value: "class_12_boards",  label: "Class 12 (boards)",    group: "K-12 curriculum" },
  // Engineering
  { value: "jee_main",         label: "JEE Main",             group: "Engineering entrance" },
  { value: "jee_advanced",     label: "JEE Advanced",         group: "Engineering entrance" },
  { value: "bitsat",           label: "BITSAT",               group: "Engineering entrance" },
  { value: "gate",             label: "GATE",                 group: "Engineering entrance" },
  // Medical
  { value: "neet",             label: "NEET",                 group: "Medical entrance" },
  // Management
  { value: "cat",              label: "CAT",                  group: "Management entrance" },
  { value: "gmat",             label: "GMAT",                 group: "Management entrance" },
  { value: "gre",              label: "GRE",                  group: "Management entrance" },
  // Government / civil services
  { value: "upsc",             label: "UPSC",                 group: "Government / civil services" },
  { value: "nda",              label: "NDA",                  group: "Government / civil services" },
  { value: "bank_exams",       label: "Bank exams",           group: "Government / civil services" },
  // Law / language / other entrances
  { value: "clat",             label: "CLAT",                 group: "Law / language / other entrances" },
  { value: "ielts",            label: "IELTS",                group: "Law / language / other entrances" },
  { value: "sat",              label: "SAT",                  group: "Law / language / other entrances" },
  { value: "cuet",             label: "CUET",                 group: "Law / language / other entrances" },
  // Other
  { value: "corporate",        label: "Professional / training", group: "Other" },
  { value: "other",            label: "Other / custom",       group: "Other" },
];

export const TEACHING_CONTEXT_VALID_SLUGS: ReadonlySet<string> = new Set(
  TEACHING_CONTEXT_OPTIONS.map((o) => o.value),
);

/** Group the options for an <optgroup>-based <select>. Stable ordering. */
export function groupedTeachingContextOptions(): Array<{
  group: string;
  options: TeachingContextOption[];
}> {
  const order: TeachingContextOption["group"][] = [
    "K-12 curriculum",
    "Engineering entrance",
    "Medical entrance",
    "Management entrance",
    "Government / civil services",
    "Law / language / other entrances",
    "Other",
  ];
  return order.map((g) => ({
    group: g,
    options: TEACHING_CONTEXT_OPTIONS.filter((o) => o.group === g),
  }));
}

// =============================================================================
// Intent vocabulary (preset chips on the form)
// =============================================================================

/** The six intent presets. Keep in sync with the `intents` array on the form. */
export type IntentId =
  | "quick_check"        // Quick formative check / 5-min pulse
  | "post_class_pulse"   // (alias)
  | "chapter_end"        // Chapter-end test / Balanced summary
  | "diagnostic"         // Diagnostic - find weak spots
  | "mock_paper"         // Mock paper (competitive exam)
  | "homework"           // Homework set
  | "remediation";       // Re-teach / remediation

// =============================================================================
// Bloom level fit per class bucket
// =============================================================================

const BLOOM_BY_BUCKET: Record<string, BloomLevel[]> = {
  primary:      ["remember", "understand", "apply"],
  middle:       ["remember", "understand", "apply", "analyze"],
  senior_board: ["remember", "understand", "apply", "analyze", "evaluate", "create"],
  competitive:  ["remember", "understand", "apply", "analyze", "evaluate", "create"],
  corporate:    ["remember", "understand", "apply", "analyze", "evaluate", "create"],
  unknown:      ["remember", "understand", "apply", "analyze", "evaluate", "create"],
};

// =============================================================================
// Validation result shape
// =============================================================================

export type ValidationIssueCode =
  | "context_far_above_class"
  | "context_above_class"
  | "context_far_below_class"
  | "mock_paper_for_school_class"
  | "bloom_too_high_primary"
  | "bloom_too_high_middle"
  | "cat_doesnt_test_remember"
  | "numerical_for_verbal_exam"
  | "topic_context_mismatch"
  | "no_context_picked";

export type ValidationIssue = {
  code: ValidationIssueCode;
  severity: "soft" | "hard" | "block";
  message: string;
  detail?: string;
};

export type ValidationResult = {
  ok: boolean;
  blocking: boolean;
  issues: ValidationIssue[];
};

// =============================================================================
// The validator
// =============================================================================

export type ValidateInput = {
  /** Raw class.grade string ("8", "Class 10", "XII"). Null = no class picked. */
  classGrade: string | null;
  /** Active intent ID (or null). */
  intent: IntentId | null;
  /** Currently selected Bloom levels. */
  bloomLevels: readonly BloomLevel[];
  /** Teaching context slug the teacher picked from the dropdown. Null if unpicked. */
  teachingContext: string | null;
  /** Slug auto-detected from the topic text, if any (e.g. "jee_main"). Null = nothing detected. */
  topicDetectedExam: string | null;
  /** Numerical question % the teacher set (0-100). */
  numericalPercent: number;
  /** Whether the teacher has actually clicked Generate. Some rules (no_context_picked) only fire then. */
  attemptingGenerate?: boolean;
};

/** Exam slugs that are predominantly verbal / non-numerical. */
const VERBAL_EXAMS: ReadonlySet<string> = new Set([
  "clat", "ielts", "upsc", "cuet",
]);

export function validateGenerationRequest(input: ValidateInput): ValidationResult {
  const {
    classGrade,
    intent,
    bloomLevels,
    teachingContext,
    topicDetectedExam,
    numericalPercent,
    attemptingGenerate,
  } = input;

  const issues: ValidationIssue[] = [];

  // ---------- Rule 11: no context picked ----------
  if (!teachingContext && attemptingGenerate) {
    issues.push({
      code: "no_context_picked",
      severity: "hard",
      message: "Pick a teaching context above before generating.",
      detail:
        "The AI generates very different questions for a Class 6 science test vs. a JEE Main mock. Picking the context lets it match the difficulty and style your students need.",
    });
  }

  // ---------- Rules 1-3: class grade vs picked context ----------
  if (classGrade && teachingContext) {
    const fit = validateGenerationFit(
      classGradeToCategory(classGrade),
      teachingContext,
    );
    if (fit.severity !== "none") {
      const severity: "soft" | "hard" | "block" =
        fit.severity === "hard" && Math.abs(fit.rankGap) >= 2
          ? "block"
          : fit.severity === "hard"
          ? "hard"
          : "soft";
      issues.push({
        code:
          fit.rankGap >= 2
            ? "context_far_above_class"
            : fit.rankGap === 1
            ? "context_above_class"
            : "context_far_below_class",
        severity,
        message: fit.message,
        detail: fit.detail,
      });
    }
  }

  // ---------- Rule 5: mock paper for K-12 school class ----------
  const ctxBucket = categoryBucket(teachingContext ?? null);
  if (intent === "mock_paper" && (ctxBucket === "primary" || ctxBucket === "middle")) {
    issues.push({
      code: "mock_paper_for_school_class",
      severity: "block",
      message: `"Mock paper (competitive exam)" doesn't fit a ${categoryLabel(teachingContext)} context.`,
      detail:
        "Competitive-exam mocks are written at JEE/NEET/CAT difficulty. Pick a competitive context above OR choose a different test type (Chapter-end test, Diagnostic, Homework set).",
    });
  }

  // ---------- Rules 6-7: Bloom too high for primary / middle ----------
  if (ctxBucket === "primary" || ctxBucket === "middle") {
    const allowed = BLOOM_BY_BUCKET[ctxBucket];
    const tooHigh = bloomLevels.filter((b) => !allowed.includes(b));
    if (tooHigh.length > 0) {
      const labels = tooHigh.map((b) => BLOOM_META[b].label).join(", ");
      const allowedLabels = allowed.map((b) => BLOOM_META[b].label).join(", ");
      const blockingPrimary =
        ctxBucket === "primary" &&
        (tooHigh.includes("evaluate") || tooHigh.includes("create"));
      issues.push({
        code: ctxBucket === "primary" ? "bloom_too_high_primary" : "bloom_too_high_middle",
        severity: blockingPrimary ? "block" : "hard",
        message: `${labels} questions are usually beyond ${categoryLabel(teachingContext)} cognitive range.`,
        detail: `Students at this level typically work at Bloom levels ${allowedLabels}. Drop the higher levels or check the override below for a documented stretch-challenge.`,
      });
    }
  }

  // ---------- Rule 8: CAT doesn't test Remember-level questions ----------
  if (teachingContext === "cat" && bloomLevels.includes("remember")) {
    issues.push({
      code: "cat_doesnt_test_remember",
      severity: "soft",
      message: 'CAT papers don’t test "Remember"-level questions.',
      detail:
        "CAT is reasoning-heavy (Apply / Analyze / Evaluate). Remember-level cards won't resemble the real paper.",
    });
  }

  // ---------- Rule 9: numerical % for verbal-heavy exam ----------
  if (teachingContext && VERBAL_EXAMS.has(teachingContext) && numericalPercent > 30) {
    issues.push({
      code: "numerical_for_verbal_exam",
      severity: "hard",
      message: `${categoryLabel(teachingContext)} is predominantly verbal — your numerical % is ${numericalPercent}%.`,
      detail:
        "Most questions on this exam test reading, reasoning, or general knowledge — not calculation. Drop numerical % below 20%.",
    });
  }

  // ---------- Rule 10: topic auto-detects to a different exam than picked context ----------
  if (
    topicDetectedExam &&
    teachingContext &&
    topicDetectedExam !== teachingContext &&
    // Only fire when both are real exams (not when teaching context is "other" / "corporate")
    categoryBucket(topicDetectedExam) === "competitive" &&
    categoryBucket(teachingContext) === "competitive"
  ) {
    issues.push({
      code: "topic_context_mismatch",
      severity: "hard",
      message: `Your topic looks like ${categoryLabel(topicDetectedExam)} but the teaching context is ${categoryLabel(teachingContext)}.`,
      detail:
        "Either switch the teaching context to match the topic, or rephrase the topic so it matches the context. Mismatched, the AI will guess and you'll likely get questions that don't feel right for either exam.",
    });
  }

  // ---------- Sort + summarize ----------
  const severityRank: Record<"soft" | "hard" | "block", number> = { block: 3, hard: 2, soft: 1 };
  issues.sort((a, b) => severityRank[b.severity] - severityRank[a.severity]);

  return {
    ok: issues.length === 0,
    blocking: issues.some((i) => i.severity === "block"),
    issues,
  };
}

// =============================================================================
// Sticky default helpers — UI calls this to figure out what to seed the
// picker with on first paint
// =============================================================================

/**
 * Pick the most reasonable default teaching-context slug given what we know
 * about the teacher's class and their prior last-choice. Priority:
 *   1. Their saved last_teaching_context (from profile)
 *   2. The slug derived from the currently-picked class.grade
 *   3. null (force the teacher to pick — better than guessing wrong)
 */
export function defaultTeachingContext(input: {
  savedLastContext: string | null;
  classGrade: string | null;
}): string | null {
  if (input.savedLastContext && TEACHING_CONTEXT_VALID_SLUGS.has(input.savedLastContext)) {
    return input.savedLastContext;
  }
  if (input.classGrade) {
    const slug = classGradeToCategory(input.classGrade);
    if (slug && TEACHING_CONTEXT_VALID_SLUGS.has(slug)) return slug;
  }
  return null;
}

// =============================================================================
// Re-export categoryRank in case the form needs it (silences a future lint
// warning if validation rules grow)
// =============================================================================
export { categoryRank };
