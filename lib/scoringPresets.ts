/**
 * lib/scoringPresets.ts
 *
 * The seven canned marking-scheme presets. Each preset has:
 *
 *   - correct       → marks awarded for a correct answer
 *   - wrong         → marks deducted for a wrong answer (a negative number,
 *                     or 0 when negative marking is disabled)
 *   - unattempted   → marks for skipping (almost always 0)
 *   - negative_default → whether this preset typically uses negative marks
 *                        (informs the UI's default toggle position)
 *
 * Picking a preset with negative marking turned OFF gives that preset's
 * `correct` value but with `wrong` clamped to 0 — that's how a teacher
 * can run a JEE-style +4 weighting without the −1 penalty for a no-
 * pressure diagnostic.
 *
 * Adding a new preset: add a new key here, then surface it in the
 * UI pickers (teacher quiz builder + student generate flow). The
 * scoring engine in lib/scoring.ts reads from this dictionary, so no
 * other changes are needed.
 *
 * NOTE: "BOARDS" is identical to "PRACTICE" numerically. It exists as
 * a distinct label so analytics can later distinguish "practice quiz"
 * from "boards-style mock" without parsing the test name.
 */

export type ScoringPresetKey =
  | "PRACTICE"
  | "BOARDS"
  | "JEE_MAIN"
  | "JEE_ADV"
  | "NEET"
  | "CAT"
  | "CUSTOM";

export type MarkingRule = {
  correct: number;
  wrong: number;
  unattempted: number;
};

export type ScoringPreset = {
  key: ScoringPresetKey;
  label: string;
  description: string;
  rule: MarkingRule;
  /**
   * Whether the canonical real-world version of this scheme uses negative
   * marks. The "Apply negative marking" toggle in the UI defaults ON for
   * presets where this is true. Users can flip the toggle either way for
   * any preset.
   */
  negative_default: boolean;
};

export const SCORING_PRESETS: Record<ScoringPresetKey, ScoringPreset> = {
  PRACTICE: {
    key: "PRACTICE",
    label: "Practice (+1 / 0)",
    description:
      "Simple +1 per correct answer, no penalty for wrong. Recommended for everyday practice tests.",
    rule: { correct: 1, wrong: 0, unattempted: 0 },
    negative_default: false,
  },
  BOARDS: {
    key: "BOARDS",
    label: "Boards (+1 / 0)",
    description:
      "Class 10/12 board pattern — full credit for correct, no negative. Same numbers as Practice but labelled for board-style mocks.",
    rule: { correct: 1, wrong: 0, unattempted: 0 },
    negative_default: false,
  },
  JEE_MAIN: {
    key: "JEE_MAIN",
    label: "JEE Main (+4 / −1)",
    description:
      "Indian JEE Main pattern. 4 marks for correct, 1 mark deducted for wrong. Skipping is safe.",
    rule: { correct: 4, wrong: -1, unattempted: 0 },
    negative_default: true,
  },
  JEE_ADV: {
    key: "JEE_ADV",
    label: "JEE Advanced (+3 / −1)",
    description:
      "JEE Advanced MCQ pattern. 3 marks correct, 1 mark negative. (Numerical-answer sections in real JEE Adv have no negative — pick CUSTOM for those.)",
    rule: { correct: 3, wrong: -1, unattempted: 0 },
    negative_default: true,
  },
  NEET: {
    key: "NEET",
    label: "NEET (+4 / −1)",
    description:
      "National Eligibility cum Entrance Test (medical). Standard +4 correct, −1 wrong.",
    rule: { correct: 4, wrong: -1, unattempted: 0 },
    negative_default: true,
  },
  CAT: {
    key: "CAT",
    label: "CAT (+3 / −1)",
    description:
      "Common Admission Test (management). +3 correct, −1 wrong. Non-MCQ TITA questions in real CAT have no negative — pick CUSTOM for those.",
    rule: { correct: 3, wrong: -1, unattempted: 0 },
    negative_default: true,
  },
  CUSTOM: {
    key: "CUSTOM",
    label: "Custom",
    description:
      "Define your own marks per correct, wrong, and unattempted answer.",
    rule: { correct: 1, wrong: 0, unattempted: 0 },
    negative_default: false,
  },
};

/**
 * Resolve a preset key into its rule, applying the "negative marks
 * enabled" toggle. Used by the UI when building a marking_scheme to
 * persist, and by lib/scoring.ts when computing scores from a NULL
 * scheme (which always resolves to PRACTICE).
 */
export function resolveRule(
  preset: ScoringPresetKey,
  negativeEnabled: boolean,
  custom?: Partial<MarkingRule>,
): MarkingRule {
  const base = SCORING_PRESETS[preset].rule;
  if (preset === "CUSTOM") {
    return {
      correct: custom?.correct ?? base.correct,
      wrong: negativeEnabled ? (custom?.wrong ?? base.wrong) : 0,
      unattempted: custom?.unattempted ?? base.unattempted,
    };
  }
  return {
    correct: base.correct,
    wrong: negativeEnabled ? base.wrong : 0,
    unattempted: base.unattempted,
  };
}

/**
 * The implicit default applied when a quiz has NULL marking_scheme.
 * Every legacy quiz behaves as if it had this scheme. Identical math to
 * the +1/0 hardcoded loop in the old submission handler — exact byte
 * compatibility with pre-migration scoring.
 */
export const DEFAULT_PRESET: ScoringPresetKey = "PRACTICE";

/**
 * Auto-suggest a preset based on a student's exam goal. The UI shows a
 * one-line banner — "Practising for JEE? Switch to JEE Main." — when
 * the suggested preset differs from PRACTICE. Falls back to PRACTICE
 * for unknown / null goals.
 */
export function suggestPresetForGoal(examGoal: string | null | undefined): ScoringPresetKey {
  if (!examGoal) return "PRACTICE";
  const g = examGoal.toLowerCase();
  if (g.includes("jee_advanced") || g === "jee_adv") return "JEE_ADV";
  if (g.includes("jee")) return "JEE_MAIN";
  if (g.includes("neet")) return "NEET";
  if (g.includes("cat")) return "CAT";
  if (g.includes("boards") || g.includes("class_10") || g.includes("class_12")) return "BOARDS";
  return "PRACTICE";
}
