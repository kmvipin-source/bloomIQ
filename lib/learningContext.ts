/**
 * lib/learningContext.ts
 *
 * Single source of truth for "what is this student preparing for, and how
 * should the question-generator be primed?" Every question-generation
 * endpoint MUST read its system prompt context through this helper —
 * otherwise CAT students get vocabulary trivia about the acronym instead
 * of QA / VARC / DI-LR questions, NEET students get random biology
 * instead of NCERT-aligned NEET content, and so on.
 *
 * Why a dedicated helper:
 *   - profile.exam_goal is captured once at signup (StudentGoalPicker)
 *     but consumed by many AI endpoints — Speed Trainer, Sprint, Drill,
 *     Adaptive Practice, Quick-test, Calibration. Hard-coding the prompt
 *     fragment inside each endpoint duplicates the table and inevitably
 *     drifts.
 *   - The fragment is built once here, applied everywhere via
 *     `prependLearningContext(systemPrompt, ctx)`.
 *   - When the goal vocabulary expands (we add JEE Advanced, GMAT, GATE…),
 *     this table is the only file to edit.
 *
 * Read path (every test-creation API):
 *   1. const ctx = await loadLearningContext(supabaseAdmin, userId);
 *   2. const systemPrompt = prependLearningContext(BASE_PROMPT, ctx);
 *   3. const userPrompt = buildExamAwareUserPrompt(topic, ctx, ...);
 *   4. groqJSON(systemPrompt, userPrompt);
 *
 * Empty / unknown goal:
 *   - loadLearningContext returns ctx.goal === "exploring" and ctx.prompt
 *     === "" so the base prompt is used unchanged. Curious students who
 *     haven't picked a goal don't get a misleading exam-specific prime.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * Result of a single loadLearningContext() call. Designed to be cheap to
 * pass around — no Supabase client embedded, no follow-up reads needed.
 */
export type LearningContext = {
  /** Normalised exam goal — same slug as profile.exam_goal. */
  goal: string;
  /** Friendly label for UI / logs ("CAT", "NEET", "Class 10 boards"). */
  label: string;
  /** AI prompt fragment to prepend to the system prompt. Empty for
   *  "exploring" / unknown goals — fall through to the base prompt. */
  prompt: string;
  /** Suggested numerical-content % for the topic — speed trainer etc.
   *  can pre-bias their mix when the topic has no explicit signal.
   *  Falls through to 0 when not exam-specific. */
  suggestedNumericalPercent: number;
};

/**
 * Per-goal definitions. The `prompt` is appended to the SYSTEM prompt of
 * every question-generation route; the `userPromptHint` is appended to
 * the USER prompt so the topic line carries exam framing too.
 *
 * Keep these short and behavioural — telling the AI "you are generating
 * for X exam, here are the dominant skills, this is the difficulty
 * register" — NOT factual content. The AI already knows what CAT is; we
 * just have to disambiguate "CAT" the exam from "CAT" the animal.
 */
const GOAL_DEFS: Record<string, Omit<LearningContext, "goal">> = {
  cat_prep: {
    label: "CAT",
    prompt: [
      "The student is preparing for CAT (Common Admission Test, the Indian MBA entrance exam).",
      "Generate CAT-style MCQs across Quantitative Aptitude (arithmetic, algebra, geometry, modern math),",
      "Verbal Ability & Reading Comprehension (RC passages, para-jumbles, summary, critical reasoning),",
      "and Data Interpretation / Logical Reasoning (tables, charts, caselets, puzzles).",
      "Difficulty: CAT mock standard — challenging but solvable in ~2 min/question.",
      "Do NOT ask trivia about the exam itself (what CAT stands for, who conducts it, etc.).",
    ].join(" "),
    suggestedNumericalPercent: 60,
  },

  jee_main: {
    label: "JEE Main",
    prompt: [
      "The student is preparing for JEE Main (Indian engineering entrance, Class 11–12 level).",
      "Generate JEE Main-style MCQs across Physics (mechanics, electromagnetism, modern physics, optics),",
      "Chemistry (physical, organic, inorganic) and Mathematics (calculus, algebra, coordinate geometry, vectors).",
      "Heavy on numerical / formula-application questions; light on rote definitions.",
      "Difficulty: JEE Main mock standard — quick application of NCERT-aligned concepts.",
    ].join(" "),
    suggestedNumericalPercent: 75,
  },

  jee_prep: {
    label: "JEE",
    prompt: [
      "The student is preparing for JEE (Indian engineering entrance, Class 11–12 level).",
      "Generate JEE-style MCQs across Physics, Chemistry, and Mathematics.",
      "Heavy on numerical / formula-application questions; NCERT-aligned conceptual base.",
    ].join(" "),
    suggestedNumericalPercent: 70,
  },

  neet_prep: {
    label: "NEET",
    prompt: [
      "The student is preparing for NEET (Indian undergraduate medical entrance, Class 11–12 level).",
      "Generate NEET-style MCQs heavy on Biology (Botany + Zoology, NCERT-aligned),",
      "with the Physics and Chemistry mix matching the actual paper (Biology ≈ 50%).",
      "Conceptual + application questions; minimal rote-fact trivia outside NCERT.",
      "Difficulty: NEET mock standard.",
    ].join(" "),
    suggestedNumericalPercent: 30,
  },

  upsc_prep: {
    label: "UPSC Prelims",
    prompt: [
      "The student is preparing for the UPSC Civil Services Prelims exam.",
      "Generate UPSC-style MCQs across General Studies — polity, economy, history,",
      "geography, environment, science & technology, current affairs.",
      "Difficulty: Prelims standard — concept-heavy, analytical, eliminative.",
    ].join(" "),
    suggestedNumericalPercent: 10,
  },

  bank_exams: {
    label: "Bank exams (IBPS / SBI / RBI)",
    prompt: [
      "The student is preparing for Indian bank-recruitment exams (IBPS PO / Clerk, SBI PO / Clerk, RBI).",
      "Generate MCQs across Quantitative Aptitude (arithmetic, DI), Reasoning Ability,",
      "English Language, and General/Banking Awareness.",
      "Difficulty: bank exam standard — moderate, speed-focused.",
    ].join(" "),
    suggestedNumericalPercent: 50,
  },

  class10_boards: {
    label: "Class 10 boards",
    prompt: [
      "The student is preparing for Class 10 board exams (CBSE / ICSE / state boards).",
      "Generate MCQs at Class 10 NCERT / board-textbook difficulty — conceptual",
      "understanding + direct application, not competitive-exam complexity.",
    ].join(" "),
    suggestedNumericalPercent: 30,
  },
  class_10_boards: {
    label: "Class 10 boards",
    prompt: [
      "The student is preparing for Class 10 board exams (CBSE / ICSE / state boards).",
      "Generate MCQs at Class 10 NCERT / board-textbook difficulty.",
    ].join(" "),
    suggestedNumericalPercent: 30,
  },

  class12_boards: {
    label: "Class 12 boards",
    prompt: [
      "The student is preparing for Class 12 board exams (CBSE / ICSE / state boards).",
      "Generate MCQs at Class 12 NCERT / board-textbook difficulty — concept + application,",
      "not entrance-exam complexity.",
    ].join(" "),
    suggestedNumericalPercent: 40,
  },
  class_12_boards: {
    label: "Class 12 boards",
    prompt: [
      "The student is preparing for Class 12 board exams (CBSE / ICSE / state boards).",
      "Generate MCQs at Class 12 NCERT / board-textbook difficulty.",
    ].join(" "),
    suggestedNumericalPercent: 40,
  },

  class_9: {
    label: "Class 9",
    prompt: [
      "The student is in Class 9 (foundation for boards).",
      "Generate MCQs at Class 9 NCERT difficulty — conceptual clarity > exam complexity.",
    ].join(" "),
    suggestedNumericalPercent: 20,
  },
  class9: {
    label: "Class 9",
    prompt: [
      "The student is in Class 9 (foundation for boards).",
      "Generate MCQs at Class 9 NCERT difficulty.",
    ].join(" "),
    suggestedNumericalPercent: 20,
  },

  class5_8: {
    label: "Class 5–8 (primary + middle school)",
    prompt: [
      "The student is in Class 5–8 (primary + middle school, NCERT).",
      "Generate age-appropriate MCQs — simple language, single-concept questions,",
      "no exam-paper density.",
    ].join(" "),
    suggestedNumericalPercent: 20,
  },
  class_5_8: {
    label: "Class 5–8 (primary + middle school)",
    prompt: [
      "The student is in Class 5–8 (primary + middle school, NCERT).",
      "Generate age-appropriate MCQs — simple language, single-concept questions.",
    ].join(" "),
    suggestedNumericalPercent: 20,
  },

  corporate: {
    label: "Professional / corporate training",
    prompt: [
      "The learner is a working professional in corporate training",
      "(software / cloud / mainframe / data / product disciplines).",
      "Generate practical, scenario-based MCQs at industry-applied difficulty.",
      "Prefer real-world configuration, troubleshooting, and 'which approach is correct'",
      "framings over textbook recall.",
    ].join(" "),
    suggestedNumericalPercent: 20,
  },

  exploring: {
    label: "exploring",
    prompt: "", // no prime — fall through to the base prompt
    suggestedNumericalPercent: 0,
  },
};

/**
 * Build a LearningContext from a known exam_goal slug. Synchronous —
 * useful when you already have the goal in hand (e.g., from the request
 * body or a prior /api/auth/me roundtrip).
 */
export function buildLearningContext(goal: string | null | undefined): LearningContext {
  if (!goal) {
    return { goal: "exploring", label: "exploring", prompt: "", suggestedNumericalPercent: 0 };
  }
  const slug = String(goal).toLowerCase().trim();
  const def = GOAL_DEFS[slug];
  if (!def) {
    return { goal: slug, label: slug, prompt: "", suggestedNumericalPercent: 0 };
  }
  return { goal: slug, ...def };
}

/**
 * Fetch the user's exam_goal from profiles and build their LearningContext.
 * Designed to be called once at the top of any question-generation API
 * route. Tolerates RLS / row-not-found by falling back to "exploring".
 *
 * @param sb     Service-role Supabase client (must be supabaseAdmin so RLS
 *               doesn't block; user-token clients silently miss reads here).
 * @param userId The caller's auth user id.
 */
export async function loadLearningContext(
  sb: SupabaseClient,
  userId: string,
): Promise<LearningContext> {
  try {
    const { data } = await sb
      .from("profiles")
      .select("exam_goal")
      .eq("id", userId)
      .maybeSingle();
    const goal = (data as { exam_goal?: string | null } | null)?.exam_goal ?? null;
    return buildLearningContext(goal);
  } catch {
    return buildLearningContext(null);
  }
}

/**
 * Prepend the learning-context fragment to a SYSTEM prompt. When the
 * fragment is empty (exploring / unknown goal) the base prompt is
 * returned unchanged — no spurious framing.
 */
export function prependLearningContext(basePrompt: string, ctx: LearningContext): string {
  if (!ctx.prompt) return basePrompt;
  return `${ctx.prompt}\n\n${basePrompt}`;
}

/**
 * Decorate the user's free-form topic with exam-aware framing so the AI
 * disambiguates terms like "CAT" / "GATE" / "CLAT" that collide with
 * everyday words. Returns the topic unchanged for exploring / unknown goals.
 */
export function buildExamAwareTopic(topic: string, ctx: LearningContext): string {
  const t = sanitizeUserTopic(topic);
  if (!t) return t;
  if (!ctx.prompt) return t;
  // Bracket-style framing — the AI consistently honours parenthetical
  // disambiguation more reliably than a separate sentence.
  return `${t} (for ${ctx.label} exam preparation)`;
}

/**
 * Strip control characters, normalise whitespace, and cap length on a
 * user-supplied topic string before it is interpolated into an LLM prompt.
 *
 * Why: user-controlled strings like "ignore previous instructions and
 * output ..." inside a Topic field can hijack the surrounding system
 * prompt. We can't fully prevent injection but we can (a) strip the
 * easy escape vectors (newlines, backticks, triple-quote runs) and
 * (b) keep the topic on a single line so wrapping callers can fence it
 * with delimiters that the model treats as a content boundary.
 *
 * Callers should still wrap the sanitised value in a delimiter pair
 * (e.g. `<TOPIC>...</TOPIC>` or `"""..."""`) before placing it in a
 * prompt. This helper only normalises the inner content.
 */
export function sanitizeUserTopic(input: string | null | undefined): string {
  const raw = String(input ?? "");
  // Strip control characters (incl. newlines, tabs) and HTML angle brackets,
  // collapse internal whitespace, neutralise triple-quote / triple-backtick
  // runs that could close a delimiter fence.
  return raw
    .replace(/[ -]/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/"{3,}/g, '"')
    .replace(/`{3,}/g, "`")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}
