/**
 * lib/studentGoalTiles.ts
 *
 * Goal-aware tile prioritisation for the independent-student dashboard.
 *
 * Each of the 8 student goals (set during onboarding via StudentGoalPicker)
 * maps to:
 *   - `primary`: 4–5 tile keys shown above the fold ("Recommended for you")
 *   - `secondary`: the remaining tile keys, hidden under a collapsed
 *     "More tools" expandable section
 *
 * The same 14 features always exist; only the *order* and *grouping*
 * change. No feature is ever removed, just deprioritised. This is the
 * "regroup, don't remove" pattern from the 2026-04-30 strategy session.
 *
 * Tile content (icon name, label, description, href, color) is centralised
 * here so /student/page.tsx becomes data-driven — adding a future tile is
 * a one-row change instead of a JSX edit.
 *
 * Reasoning per goal (intuition; refine with real usage data):
 *   - JEE / NEET: exam-prep first — Sprint, Speed, Trap, Rank, X-Ray.
 *   - CAT: aptitude / time-pressure first — Speed, Sprint, Rank, Tutor.
 *   - UPSC: long-form / retention first — Sprint, Tutor, X-Ray, Memory.
 *   - Bank exams: speed-based, rank-driven — Speed, Sprint, Trap, Rank.
 *   - Class 10 / 12 boards: depth of understanding first — Teach-Back,
 *     Misconception, Memory, Visualizer.
 *   - Just exploring: curiosity-led — Teach-Back, Misconception,
 *     Visualizer, Tutor.
 */

import type { StudentGoalId } from "@/components/StudentGoalPicker";

// Stable keys for every feature tile on /student.
// Adding a new feature? Add its key here, add its meta to TILE_META below,
// then slot it into the GOAL_MAP layouts.
export type StudentTileKey =
  | "teach_back"
  | "misconceptions"
  | "xray"
  | "sprint"
  | "speed"
  | "traps"
  | "rank"
  | "tutor"
  | "visualizer"
  | "memory"
  | "calibration"
  | "voice_teacher"
  | "knowledge_graph"
  | "parent_share";

export const ALL_STUDENT_TILES: StudentTileKey[] = [
  "teach_back",
  "misconceptions",
  "xray",
  "sprint",
  "speed",
  "traps",
  "rank",
  "tutor",
  "visualizer",
  "memory",
  "calibration",
  "voice_teacher",
  "knowledge_graph",
  "parent_share",
];

// Single source of truth for tile presentation. Icons are referenced by
// lucide-react name (the renderer maps the name back to the imported
// component) so this file stays free of JSX.
export type TileMeta = {
  href: string;
  iconName:
    | "GraduationCap" | "Search" | "ScanSearch" | "CalendarDays" | "Timer"
    | "Crosshair" | "Trophy" | "Bot" | "Film" | "Brain" | "Gauge" | "Mic"
    | "Network" | "Users";
  label: string;
  description: string;
  // Tailwind colour pair: bg-* for the icon chip background, text-* for the
  // icon foreground. Same conventions the original /student/page.tsx used.
  color: { bg: string; fg: string };
  // The goal-prep tiles deserve a small "Sprint" highlight visually; this
  // flag turns on the emerald border on /student/sprint specifically.
  highlight?: boolean;
  // Feature key from lib/features.ts that this tile gates against. When
  // null, the tile is always-on (e.g. "Share with parent"). When set, the
  // dashboard checks the user's plan and renders the tile locked-but-
  // visible if the plan doesn't include this key. See lib/featureAccess.ts.
  featureKey?: string;
  // Verb category for the Phase 3 (#2) "Test / Train / Diagnose" mental
  // model. Drives the section grouping on /student so a new visitor can
  // tell at a glance whether a tile gives them a SCORE (test), a SKILL
  // (train), or an INSIGHT (diagnose). 'share' covers the parent-share
  // tile which doesn't fit any of those three.
  category: TileCategory;
};

export type TileCategory = "test" | "train" | "diagnose" | "share";

export const CATEGORY_META: Record<TileCategory, { label: string; intro: string }> = {
  test: {
    label: "Take a test",
    intro: "Practice tests give you a real Bloom score. Past papers tag every question by Bloom level. Daily drills target your weak spots.",
  },
  train: {
    label: "Train your skills",
    intro: "Skill-builders that don't produce a score — explain things, train pace, build memory, beat exam-day nerves.",
  },
  diagnose: {
    label: "Diagnose a weakness",
    intro: "Analytical lenses on what you've already done. Find the specific mental errors, the trap patterns, the prerequisite gaps.",
  },
  share: {
    label: "Share with someone",
    intro: "Show a parent, tutor, or counsellor your progress without making them sign up.",
  },
};

export const TILE_META: Record<StudentTileKey, TileMeta> = {
  teach_back: {
    href: "/student/teach-back",
    iconName: "GraduationCap",
    label: "Teach-Back",
    description: "Explain a topic in your own words. We grade you on Bloom's rubric and ask one sharp follow-up.",
    color: { bg: "bg-emerald-100", fg: "text-emerald-700" },
    featureKey: "teach_back",
    category: "train",
  },
  misconceptions: {
    href: "/student/misconceptions",
    iconName: "Search",
    label: "Misconception Detective",
    description: "Find the *specific* mental error behind each wrong answer, then drill it away.",
    color: { bg: "bg-amber-100", fg: "text-amber-700" },
    featureKey: "misconceptions",
    category: "diagnose",
  },
  xray: {
    href: "/student/xray",
    iconName: "ScanSearch",
    label: "Past-Paper X-Ray",
    description: "Upload last year's paper. We tag every question by Bloom level + topic and give you 5 study targets.",
    color: { bg: "bg-sky-100", fg: "text-sky-700" },
    featureKey: "past_paper_xray",
    category: "diagnose",
  },
  sprint: {
    href: "/student/sprint",
    iconName: "CalendarDays",
    label: "Exam Sprint Mode",
    description: "Set your exam date. Get a daily 3-task mission tuned to how far out it is — foundation now, sprint as it nears, revision-only in the final week.",
    color: { bg: "bg-emerald-100", fg: "text-emerald-700" },
    highlight: true,
    featureKey: "exam_sprint",
    category: "train",
  },
  speed: {
    href: "/student/speed",
    iconName: "Timer",
    label: "Speed-Accuracy Trainer",
    description: "Each question gets a target time based on its Bloom level. Fast+right is exam-ready; slow+right means you need pace work.",
    color: { bg: "bg-orange-100", fg: "text-orange-700" },
    featureKey: "speed_trainer",
    category: "train",
  },
  traps: {
    href: "/student/traps",
    iconName: "Crosshair",
    label: "Distractor Trap Detector",
    description: "Find which examiner-trap patterns you fall for most — unit confusion, sign errors, NOT-misreads, off-by-one, and more.",
    color: { bg: "bg-rose-100", fg: "text-rose-700" },
    featureKey: "trap_detector",
    category: "diagnose",
  },
  rank: {
    href: "/student/rank",
    iconName: "Trophy",
    label: "Mock Rank Predictor",
    description: "Convert any score into an AIR estimate against JEE/NEET/CAT-sized cohorts. See exactly where to gain marks.",
    color: { bg: "bg-amber-100", fg: "text-amber-700" },
    featureKey: "rank_predictor",
    category: "diagnose",
  },
  tutor: {
    href: "/student/tutor",
    iconName: "Bot",
    label: "Doubt-Clearing AI Tutor",
    description: "A 24/7 Socratic tutor. Type your doubt, get walked through it step by step — no answer dumps.",
    color: { bg: "bg-indigo-100", fg: "text-indigo-700" },
    featureKey: "ai_tutor_text",
    category: "train",
  },
  visualizer: {
    href: "/student/visualizer",
    iconName: "Film",
    label: "Concept Visualizer",
    description: "Type any concept — get an animated, narrated explainer. Best for the things that don't click from words.",
    color: { bg: "bg-fuchsia-100", fg: "text-fuchsia-700" },
    featureKey: "concept_visualizer",
    category: "train",
  },
  memory: {
    href: "/student/memory",
    iconName: "Brain",
    label: "Memory Tune-Up",
    description: "Spaced repetition for your wrong answers. 5 minutes a day, the forgetting curve never wins.",
    color: { bg: "bg-cyan-100", fg: "text-cyan-700" },
    featureKey: "memory_srs",
    category: "train",
  },
  calibration: {
    href: "/student/calibration",
    iconName: "Gauge",
    label: "Confidence Calibration",
    description: "When you say “Sure”, are you actually right? Train the metacognitive skill that beats negative marking.",
    color: { bg: "bg-teal-100", fg: "text-teal-700" },
    featureKey: "calibration",
    category: "train",
  },
  voice_teacher: {
    href: "/student/voice-teacher",
    iconName: "Mic",
    label: "Voice AI Teacher",
    description: "Speak your doubt, hear the answer back, optionally see the animation. Hands-free study.",
    color: { bg: "bg-violet-100", fg: "text-violet-700" },
    featureKey: "voice_tutor",
    category: "train",
  },
  knowledge_graph: {
    href: "/student/graph",
    iconName: "Network",
    label: "Knowledge Graph",
    description: "A visual map of every topic you've practiced, with prerequisite arrows. Find the foundation gap.",
    color: { bg: "bg-blue-100", fg: "text-blue-700" },
    featureKey: "knowledge_graph",
    category: "diagnose",
  },
  parent_share: {
    href: "/student/parent",
    iconName: "Users",
    label: "Share with a parent",
    description: "Generate a link to share via WhatsApp. Parents see your progress read-only — no signup needed.",
    color: { bg: "bg-pink-100", fg: "text-pink-700" },
    // No featureKey — sharing-with-parent is always free.
    category: "share",
  },
};

type Layout = { primary: StudentTileKey[]; secondary: StudentTileKey[] };

// Helper — pad `primary` from `ALL_STUDENT_TILES` so we always render
// every tile exactly once, even if a goal's map forgets one. Defensive.
function complete(primary: StudentTileKey[]): Layout {
  const seen = new Set(primary);
  const secondary = ALL_STUDENT_TILES.filter((k) => !seen.has(k));
  return { primary, secondary };
}

const GOAL_MAP: Record<StudentGoalId, Layout> = {
  jee_prep: complete(["sprint", "speed", "traps", "rank", "xray"]),
  neet_prep: complete(["sprint", "speed", "traps", "rank", "xray"]),
  cat_prep: complete(["speed", "sprint", "rank", "tutor", "xray"]),
  upsc_prep: complete(["sprint", "tutor", "xray", "memory", "visualizer"]),
  bank_exams: complete(["speed", "sprint", "traps", "rank", "tutor"]),
  class_10_boards: complete(["teach_back", "misconceptions", "memory", "visualizer", "tutor"]),
  class_12_boards: complete(["teach_back", "misconceptions", "xray", "memory", "tutor"]),
  exploring: complete(["teach_back", "misconceptions", "visualizer", "tutor"]),
};

// Default layout for users with a null exam_goal (school students, or
// independent students who pre-date the onboarding flow). Mirrors the
// "exploring" goal — generic, curiosity-led.
const DEFAULT_LAYOUT: Layout = complete([
  "teach_back",
  "misconceptions",
  "visualizer",
  "tutor",
]);

export function tileLayoutForGoal(goal: string | null): Layout {
  if (!goal) return DEFAULT_LAYOUT;
  return GOAL_MAP[goal as StudentGoalId] ?? DEFAULT_LAYOUT;
}

/**
 * Phase 3 (#2): group tiles by verb category, sorted within each group
 * by the active goal's primary→secondary priority. Use this on the
 * dashboard to render three sections (Train / Diagnose / Share) with
 * clear intros — replaces the "Recommended for you / More tools"
 * mental model with a verb-driven one.
 *
 * The 'test' bucket usually returns empty (no tile in TILE_META is
 * categorised as 'test' — testing happens via the dedicated "Generate
 * a practice test" CTA, past-paper upload, etc.). Render a CTA card
 * for that section instead of relying on this helper.
 */
export function tilesByCategoryForGoal(goal: string | null): Record<TileCategory, StudentTileKey[]> {
  const layout = tileLayoutForGoal(goal);
  // Within each category we want the goal-priority order: primary first,
  // then secondary. Compute a single ordered list and bucket by category.
  const ordered: StudentTileKey[] = [...layout.primary, ...layout.secondary];
  const buckets: Record<TileCategory, StudentTileKey[]> = {
    test: [],
    train: [],
    diagnose: [],
    share: [],
  };
  for (const k of ordered) {
    const cat = TILE_META[k].category;
    buckets[cat].push(k);
  }
  return buckets;
}
