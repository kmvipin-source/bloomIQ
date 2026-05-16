// scripts/apply-teaching-context-r4-intent-filter.mjs
// =============================================================================
// Make the intent chips ("Quick formative check / Mock paper / ...") adapt to
// the teaching context. JEE intents shouldn't show for Class 5-8.
//
// What it does:
//   - Replaces the `intents = useMemo(() => intentsForProfile(learnerProfile), ...)`
//     with one that dispatches on teachingContext (per-test picker) AND filters
//     out competitive-only intents (mock_paper) when the context is K-12
//     primary/middle.
//
// Result on the form:
//   - teachingContext = class5_8 / class_9          -> K-12 intents minus mock_paper
//   - teachingContext = class_10_boards / class_12_boards -> all K-12 intents
//   - teachingContext = jee_main / neet / cat / ... -> competitive intents
//   - teachingContext = corporate                   -> corporate intents
//   - teachingContext = null                        -> learner-profile fallback
//                                                     (today's behavior, no break)
//
// Idempotent. Run:  node scripts/apply-teaching-context-r4-intent-filter.mjs
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  // ─── 1. Add categoryBucket + intentsForContext imports ─────────────────
  {
    tag: "imports_for_filter",
    file: "app/teacher/generate/page.tsx",
    description: "Import categoryBucket helper for slug→bucket mapping",
    find: `import {
  validateGenerationRequest,
  groupedTeachingContextOptions,
  defaultTeachingContext,
  type IntentId as TCIntentId,
} from "@/lib/teachingContext";`,
    replace: `import {
  validateGenerationRequest,
  groupedTeachingContextOptions,
  defaultTeachingContext,
  type IntentId as TCIntentId,
} from "@/lib/teachingContext";
import { categoryBucket } from "@/lib/questionCategory";`,
  },

  // ─── 2. Replace the intents memo with context-aware version ────────────
  {
    tag: "intents_memo_context_aware",
    file: "app/teacher/generate/page.tsx",
    description: "Re-key intents on teachingContext + filter age-inappropriate intents",
    find: `  const intents = useMemo(() => intentsForProfile(learnerProfile), [learnerProfile]);`,
    replace: `  const intents = useMemo(() => {
    // Pick the intent set from teachingContext FIRST (per-test picker).
    // Fall back to the teacher's own learnerProfile when context is unset
    // — preserves today's behavior for teachers who haven't picked yet.
    let base: Intent[];
    if (teachingContext) {
      const bkt = categoryBucket(teachingContext);
      if (bkt === "competitive") base = intentsForProfile("competitive_exam");
      else if (bkt === "corporate") base = intentsForProfile("corporate");
      else base = intentsForProfile("k12"); // primary / middle / senior_board / unknown
    } else {
      base = intentsForProfile(learnerProfile);
    }
    // Filter age-inappropriate intents:
    //   - mock_paper hides for K-12 primary/middle classes (Class 5-9). Only
    //     show it when the cohort is plausibly preparing for an actual exam
    //     paper (senior_board+ class, or competitive context).
    const ctxBucket = teachingContext ? categoryBucket(teachingContext) : "unknown";
    const hideMockPaper = ctxBucket === "primary" || ctxBucket === "middle";
    return hideMockPaper ? base.filter((i) => i.id !== "mock_paper") : base;
  }, [teachingContext, learnerProfile]);`,
  },
];

const applied = [];
const skipped = [];
for (const fx of FIXES) {
  const abs = path.join(ROOT, fx.file);
  if (!fs.existsSync(abs)) {
    skipped.push({ tag: fx.tag, reason: `file not found: ${fx.file}` });
    continue;
  }
  const before = fs.readFileSync(abs, "utf8");
  if (!before.includes(fx.find)) {
    skipped.push({ tag: fx.tag, reason: "find pattern not present (already applied?)" });
    continue;
  }
  if (before.indexOf(fx.find) !== before.lastIndexOf(fx.find)) {
    skipped.push({ tag: fx.tag, reason: "find pattern not unique - cowardly refusing" });
    continue;
  }
  fs.writeFileSync(abs, before.replace(fx.find, fx.replace), "utf8");
  applied.push(fx.tag);
}

console.log(`\n=== r4 (intent filter by teaching context) summary ===`);
console.log(`Applied: ${applied.length}  ->  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
