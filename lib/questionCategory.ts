// lib/questionCategory.ts
// =============================================================================
// Shared helpers for the question_bank.category column (migration 90).
// -----------------------------------------------------------------------------
// Why this exists
// ---------------
// Multiple surfaces need to display + reason about the category slug a
// question was generated for:
//   - /teacher/quizzes/new    — badge on every card + filter dropdown
//   - /teacher/review         — badge on every pending question
//   - /teacher/papers/new     — same composer pattern
//   - /api/teacher/class-fit  — server-side mismatch detection
// Without a single helper, each surface re-implements the slug→label map and
// they drift. One module keeps it honest.
// =============================================================================

/** What we show when category is NULL on a question (legacy rows). */
export const NO_CATEGORY_LABEL = "Uncategorized";

/**
 * Pretty human label for a category slug. Slug vocabulary mirrors
 * profiles.exam_goal (same column students set their goal in). Unknown
 * slugs fall back to title-cased text — better than dropping them.
 */
export function categoryLabel(slug: string | null | undefined): string {
  if (!slug) return NO_CATEGORY_LABEL;
  const g = slug.toLowerCase().trim();
  if (g === "class5_8" || g === "class_5_8") return "Class 5-8";
  if (g === "class_9" || g === "class9") return "Class 9";
  if (g === "class_10_boards" || g === "class10_boards") return "Class 10 boards";
  if (g === "class_12_boards" || g === "class12_boards") return "Class 12 boards";
  if (g.startsWith("jee")) return "JEE";
  if (g.startsWith("neet")) return "NEET";
  if (g === "cat" || g === "cat_prep" || g === "cat_coaching") return "CAT";
  if (g === "upsc" || g === "upsc_prep" || g === "upsc_coaching") return "UPSC";
  if (g === "gmat" || g === "gmat_prep") return "GMAT";
  if (g === "gre" || g === "gre_prep") return "GRE";
  if (g === "gate" || g === "gate_prep" || g === "gate_coaching") return "GATE";
  if (g === "clat" || g === "clat_prep") return "CLAT";
  if (g === "bitsat" || g === "bitsat_prep") return "BITSAT";
  if (g === "sat" || g === "sat_prep") return "SAT";
  if (g === "nda" || g === "nda_prep") return "NDA";
  if (g === "cuet" || g === "cuet_prep") return "CUET";
  if (g === "corporate") return "Corporate / professional";
  if (g === "bank_exams" || g === "bank_prep") return "Bank exams";
  if (g === "other") return "Custom";
  // Fallback: title-case the slug.
  return slug.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

/**
 * Coarse difficulty / cohort bucket for a category slug. Used by
 * /teacher/quizzes/new to detect dangerous mismatches when a teacher tries
 * to assign a "JEE-difficulty" question to a Class-8 cohort.
 *
 *   primary      Class 5-8
 *   middle       Class 9
 *   senior_board Class 10 + Class 12 boards
 *   competitive  JEE / NEET / CAT / UPSC / GATE / GMAT / GRE / etc.
 *   corporate    Corporate training
 *   unknown      "other", NULL, or anything else
 *
 * The order here is the difficulty progression — `categoryRank(a) < categoryRank(b)`
 * means category `a` is for a younger / less advanced cohort than `b`.
 */
export type CategoryBucket =
  | "primary"
  | "middle"
  | "senior_board"
  | "competitive"
  | "corporate"
  | "unknown";

export function categoryBucket(slug: string | null | undefined): CategoryBucket {
  if (!slug) return "unknown";
  const g = slug.toLowerCase().trim();
  if (g === "class5_8" || g === "class_5_8") return "primary";
  if (g === "class_9" || g === "class9") return "middle";
  if (g === "class_10_boards" || g === "class10_boards") return "senior_board";
  if (g === "class_12_boards" || g === "class12_boards") return "senior_board";
  if (g === "corporate") return "corporate";
  if (g === "other") return "unknown";
  // Everything else in our slug vocabulary is competitive.
  return "competitive";
}

/** Rank used for "is bucket A harder than bucket B" comparisons. Higher = harder. */
export function categoryRank(b: CategoryBucket): number {
  switch (b) {
    case "primary":      return 1;
    case "middle":       return 2;
    case "senior_board": return 3;
    case "competitive":  return 4;
    case "corporate":    return 4; // adult cohort, treated similar to competitive
    case "unknown":      return 0;
  }
}

/**
 * Map a class grade string (from class.grade — typically "8", "Class 10",
 * "XII", etc.) to the category slug the class most likely teaches.
 * Returns null when the grade is missing or unparseable.
 *
 * Used to compute "this Class-8 cohort is being given JEE questions —
 * are you sure?" warnings in the assign flow.
 */
export function classGradeToCategory(grade: string | null | undefined): string | null {
  if (!grade) return null;
  const g = grade.trim().toLowerCase().replace(/\s+/g, "");
  // Roman numerals + arabic forms — class teachers use both casually.
  const m = g.match(/^(?:class|grade|std\.?)?(\d{1,2}|xii|xi|x|ix|viii|vii|vi|v)$/);
  if (!m) return null;
  const raw = m[1];
  const n = (() => {
    const arabic = Number(raw);
    if (Number.isFinite(arabic)) return arabic;
    const roman: Record<string, number> = {
      v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12,
    };
    return roman[raw] || null;
  })();
  if (n === null) return null;
  if (n >= 5 && n <= 8) return "class5_8";
  if (n === 9) return "class_9";
  if (n === 10) return "class_10_boards";
  if (n === 11 || n === 12) return "class_12_boards";
  return null;
}

/**
 * Decide if assigning a quiz built from `questionCategories` to a class with
 * `classCategory` is risky. Returns a single warning string (or null).
 *
 * Heuristic:
 *   - If the class is younger/easier than any of the question categories by
 *     ≥2 rank steps, that's a strong mismatch (e.g. Class 5-8 ← JEE).
 *   - Single-step mismatch is fine (Class 10 board class ← JEE question is
 *     ambitious but legitimate practice).
 *   - Unknown categories are ignored (NULL legacy rows / "other" slug).
 */
export function classQuestionMismatchWarning(
  classCategory: string | null,
  questionCategories: Array<string | null | undefined>,
): string | null {
  const classBucket = categoryBucket(classCategory);
  if (classBucket === "unknown" || classBucket === "corporate") return null;
  const classR = categoryRank(classBucket);
  const offendingLabels = new Set<string>();
  for (const qc of questionCategories) {
    const qb = categoryBucket(qc);
    if (qb === "unknown") continue;
    const qr = categoryRank(qb);
    if (qr - classR >= 2) {
      offendingLabels.add(categoryLabel(qc));
    }
  }
  if (offendingLabels.size === 0) return null;
  const offenders = Array.from(offendingLabels).join(", ");
  const classLabel = categoryLabel(classCategory);
  return `${offenders} questions are typically too difficult for a ${classLabel} cohort — they were generated for a higher / competitive-exam audience. Either drop those questions, swap them for class-appropriate ones, or proceed only if you're using them as a stretch challenge.`;
}

// =============================================================================
// Generate-time difficulty mismatch (added 2026-05-16 per Vipin).
// -----------------------------------------------------------------------------
// classQuestionMismatchWarning() above fires AT ASSIGN TIME — after the AI
// has already produced the questions. That's wasteful: we burn ~₹2 of
// tokens, then tell the teacher "actually, this doesn't fit your class".
//
// validateGenerationFit() fires BEFORE the AI call:
//   - Teacher picks a class (Class 5-8) and asks for JEE-difficulty quiz →
//     immediate amber "this is two cohorts above your class" with a clear
//     proceed-anyway path (stretch challenge is legitimate practice).
//   - Teacher picks a class (Class 12 boards) and asks for Class 5-8 quiz →
//     "this is below your class — students may find it trivial" (this is
//     a quality concern too — busywork hurts engagement).
//
// Return shape is intentionally severity-graded so the UI can render the
// right tone (none → silent; soft → amber tip; hard → amber banner with
// dismiss; block → only fires if we ever want a hard stop, currently never).
//
// Server posture: we WARN, we do not block. Teachers are professionals and
// stretch challenges are a real use case (a Class 8 teacher prepping a
// gifted student for the Olympiad, for example).
// =============================================================================

export type GenerationFitSeverity = "none" | "soft" | "hard" | "block";

export type GenerationFitResult = {
  severity: GenerationFitSeverity;
  /** Headline shown to the teacher. Empty when severity === "none". */
  message: string;
  /** Optional one-line explainer the UI can render under the headline. */
  detail?: string;
  /** Signed rank gap = targetRank - classRank. Positive = generating
   *  ABOVE the class level (the common case); negative = BELOW. Useful
   *  for telemetry and for the UI to phrase the warning. */
  rankGap: number;
  /** Pretty labels for the banner. */
  classLabel: string;
  targetLabel: string;
};

/**
 * Validate that the difficulty / audience of a generation request is
 * appropriate for the cohort the teacher is generating FOR.
 *
 * @param classCategory     Slug of the class/cohort the teacher is
 *                          generating for (e.g. 'class5_8'). Derive from
 *                          the class.grade column via classGradeToCategory()
 *                          if you only have the grade string.
 * @param targetCategory    Slug of the exam/cohort whose difficulty the
 *                          teacher wants the questions to match
 *                          (e.g. 'jee_main', 'class_10_boards').
 *
 * Both arguments are nullable. If either is null/unknown, the result is
 * { severity: "none" } — we don't fire on missing data because that would
 * spam teachers whose classes haven't filled in a grade yet.
 */
export function validateGenerationFit(
  classCategory: string | null | undefined,
  targetCategory: string | null | undefined,
): GenerationFitResult {
  const classBucket = categoryBucket(classCategory ?? null);
  const targetBucket = categoryBucket(targetCategory ?? null);

  const classLabel = categoryLabel(classCategory ?? null);
  const targetLabel = categoryLabel(targetCategory ?? null);

  // Unknown anywhere → no warning (don't pester teachers about missing data).
  if (classBucket === "unknown" || targetBucket === "unknown") {
    return { severity: "none", message: "", rankGap: 0, classLabel, targetLabel };
  }

  // Corporate cohort is adult and goal-agnostic — never warn.
  if (classBucket === "corporate" || targetBucket === "corporate") {
    return { severity: "none", message: "", rankGap: 0, classLabel, targetLabel };
  }

  const classR = categoryRank(classBucket);
  const targetR = categoryRank(targetBucket);
  const rankGap = targetR - classR;

  // No mismatch.
  if (rankGap === 0) {
    return { severity: "none", message: "", rankGap, classLabel, targetLabel };
  }

  // Target is HARDER than the class (the most common and most concerning
  // failure mode — generating JEE for Class 5-8).
  if (rankGap >= 2) {
    return {
      severity: "hard",
      message: `${targetLabel}-difficulty questions are typically beyond a ${classLabel} cohort's capacity.`,
      detail: `Students may not be able to engage productively. Use only as deliberate stretch practice for advanced learners, or pick a difficulty closer to ${classLabel}.`,
      rankGap,
      classLabel,
      targetLabel,
    };
  }
  if (rankGap === 1) {
    return {
      severity: "soft",
      message: `${targetLabel} difficulty is one tier above ${classLabel}.`,
      detail: "Ambitious but legitimate — many board-prep teachers stretch their students one tier up.",
      rankGap,
      classLabel,
      targetLabel,
    };
  }

  // Target is EASIER than the class (less common, less concerning, but
  // worth flagging because it usually means the teacher mis-clicked).
  if (rankGap <= -2) {
    return {
      severity: "hard",
      message: `${targetLabel}-level questions may be too easy for a ${classLabel} cohort.`,
      detail: "Students often find significantly-below-level material disengaging. Consider matching the class tier or moving one tier above for productive practice.",
      rankGap,
      classLabel,
      targetLabel,
    };
  }
  // rankGap === -1
  return {
    severity: "soft",
    message: `${targetLabel} is one tier below ${classLabel}.`,
    detail: "Fine for revision or confidence-building; for fresh practice, consider matching the class tier.",
    rankGap,
    classLabel,
    targetLabel,
  };
}

/**
 * Sugar for callers who only have a raw grade string. Converts grade → slug
 * via classGradeToCategory, then runs validateGenerationFit.
 */
export function validateGenerationFitForGrade(
  classGrade: string | null | undefined,
  targetCategory: string | null | undefined,
): GenerationFitResult {
  const classCategory = classGradeToCategory(classGrade ?? null);
  return validateGenerationFit(classCategory, targetCategory ?? null);
}
