/**
 * lib/topicSuggestions.ts
 *
 * Exam-goal-aware topic placeholders + suggested topics. Replaces the
 * hardcoded "Kinematics" / "Photosynthesis" / "Java Streams" branches that
 * lived inside every test-creation page and embarrassed corporate learners
 * with physics topics on screen.
 *
 * Two surfaces per call site:
 *   - placeholderTopic(examGoal, learnerProfile)
 *       Single string for the input's HTML placeholder attribute.
 *   - suggestedTopics(examGoal, learnerProfile)
 *       Up to 6 short topic strings — designed to drive a chip / quick-pick
 *       row underneath the input so the student can tap one instead of typing.
 *
 * Resolution order:
 *   1. Exam goal first — it's the granular signal the student actually
 *      picked (CAT, JEE Main, Class 10 boards, corporate training, …).
 *   2. learner_profile second — coarse fallback when goal is "exploring"
 *      or unset.
 *   3. K-12 generic as last resort.
 *
 * Adding a new exam goal? Drop entries into TOPICS_BY_GOAL. Adding a new
 * learner_profile bucket? Drop into TOPICS_BY_PROFILE. Either way you
 * never touch a feature page.
 */

import type { LearnerProfile } from "@/components/LearnerProfilePrompt";

// ─── Topic tables keyed by exam goal (granular) ─────────────────────────

const TOPICS_BY_GOAL: Record<string, string[]> = {
  cat_prep: [
    "Quantitative Aptitude — Time, Speed & Distance",
    "Reading Comprehension — long passage",
    "Data Interpretation — caselet",
    "Logical Reasoning — arrangements",
    "Verbal Ability — para-jumbles",
    "Quant — Number System",
  ],

  jee_main: [
    "Kinematics — projectile motion",
    "Calculus — definite integrals",
    "Organic Chemistry — reaction mechanisms",
    "Coordinate Geometry — circles",
    "Modern Physics — atomic structure",
    "Algebra — quadratic equations",
  ],
  jee_prep: [
    "Kinematics — projectile motion",
    "Calculus — definite integrals",
    "Organic Chemistry — reaction mechanisms",
    "Modern Physics — atomic structure",
    "Coordinate Geometry — circles",
    "Vectors and 3D",
  ],

  neet_prep: [
    "Human Physiology — circulatory system",
    "Plant Physiology — photosynthesis",
    "Biomolecules",
    "Genetics — Mendel's laws",
    "Ecology — populations & communities",
    "Reproduction — angiosperms",
  ],

  upsc_prep: [
    "Indian Polity — Fundamental Rights",
    "Modern History — National Movement",
    "Geography — Indian climate",
    "Economy — fiscal policy",
    "Environment — biodiversity",
    "Current Affairs — last 6 months",
  ],

  bank_exams: [
    "Quantitative Aptitude — DI tables",
    "Reasoning — seating arrangements",
    "English Language — cloze test",
    "Banking Awareness — RBI policies",
    "Computer Awareness — basics",
    "Current Affairs — banking & finance",
  ],

  class10_boards: [
    "Real Numbers",
    "Quadratic Equations",
    "Light — Reflection & Refraction",
    "Carbon and its Compounds",
    "Life Processes",
    "Nationalism in India",
  ],
  class_10_boards: [
    "Real Numbers",
    "Quadratic Equations",
    "Light — Reflection & Refraction",
    "Carbon and its Compounds",
    "Life Processes",
    "Nationalism in India",
  ],

  class12_boards: [
    "Integrals",
    "Electrostatics",
    "Chemical Kinetics",
    "Genetics & Evolution",
    "Probability",
    "Electrochemistry",
  ],
  class_12_boards: [
    "Integrals",
    "Electrostatics",
    "Chemical Kinetics",
    "Genetics & Evolution",
    "Probability",
    "Electrochemistry",
  ],

  class_9: [
    "Number Systems",
    "Motion",
    "Atoms and Molecules",
    "Tissues",
    "Linear Equations in Two Variables",
    "The French Revolution",
  ],
  class9: [
    "Number Systems",
    "Motion",
    "Atoms and Molecules",
    "Tissues",
    "Linear Equations in Two Variables",
    "The French Revolution",
  ],

  class5_8: [
    "Fractions",
    "Photosynthesis",
    "Light, Shadows and Reflections",
    "Air Around Us",
    "Decimals",
    "Our Environment",
  ],
  class_5_8: [
    "Fractions",
    "Photosynthesis",
    "Light, Shadows and Reflections",
    "Air Around Us",
    "Decimals",
    "Our Environment",
  ],

  corporate: [
    "Kubernetes — pod scheduling",
    "Java Streams — collectors",
    "AWS Lambda — cold start optimisation",
    "SQL — window functions",
    "System Design — caching strategies",
    "Linux — process management",
  ],

  exploring: [
    "Photosynthesis",
    "World War II",
    "Newton's Laws of Motion",
    "Probability basics",
    "The water cycle",
    "Algebra — linear equations",
  ],
};

// ─── Fallback by learner_profile (coarse) ───────────────────────────────

const TOPICS_BY_PROFILE: Record<LearnerProfile, string[]> = {
  competitive_exam: [
    "Quantitative Aptitude",
    "Verbal Ability — RC",
    "Logical Reasoning",
    "Data Interpretation",
    "Quantitative — Time, Speed & Distance",
    "English Language",
  ],
  k12: [
    "Photosynthesis",
    "Newton's Laws of Motion",
    "Algebra — linear equations",
    "Cell Structure",
    "Light — reflection & refraction",
    "Civics — democracy",
  ],
  corporate: [
    "Kubernetes — pod scheduling",
    "Java Streams",
    "AWS Lambda",
    "SQL — window functions",
    "Linux — process management",
    "System Design — caching",
  ],
};

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Return up to 6 logical topic suggestions for the user, prioritised by
 * exam_goal, falling back to learner_profile, falling back to K-12 generic.
 */
export function suggestedTopics(
  examGoal: string | null | undefined,
  learnerProfile: LearnerProfile | null | undefined,
): string[] {
  const goalKey = examGoal ? String(examGoal).toLowerCase().trim() : "";
  if (goalKey && TOPICS_BY_GOAL[goalKey]) return TOPICS_BY_GOAL[goalKey];
  if (learnerProfile && TOPICS_BY_PROFILE[learnerProfile]) {
    return TOPICS_BY_PROFILE[learnerProfile];
  }
  return TOPICS_BY_PROFILE.k12;
}

/**
 * Single string for input placeholder attributes ("e.g. <topic>"). Picks
 * the first item from suggestedTopics so the example shown is consistent
 * with the chip list rendered nearby. Always prefixed with "e.g. ".
 */
export function placeholderTopic(
  examGoal: string | null | undefined,
  learnerProfile: LearnerProfile | null | undefined,
): string {
  const top = suggestedTopics(examGoal, learnerProfile)[0];
  return `e.g. ${top}`;
}
