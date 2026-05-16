// scripts/apply-teaching-context-r9-mock-paper-copy.mjs
// =============================================================================
// Update the "Mock paper" intent copy now that Teaching Context is explicit.
//
// Before:
//   label:        "Mock paper (competitive exam)"
//   description:  "Detects CAT/JEE/NEET/etc. from topic"      <- outdated
//   rationale:    "...Type the exam name in Topic and the form auto-tunes."
//
// After:
//   label:        "Full mock paper"
//   description:  "Exam-style paper aligned to your teaching context"
//   rationale:    "...The teaching-context picker above tells the AI which
//                  exam style to mimic; this intent biases toward the deep
//                  Bloom levels real exams test."
//
// Idempotent. Run:  node scripts/apply-teaching-context-r9-mock-paper-copy.mjs
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  // ─── 1. Update label + description + rationale on the mock_paper intent ─
  {
    tag: "mock_paper_copy",
    file: "app/teacher/generate/page.tsx",
    description: "Revise mock_paper intent copy to match explicit-context flow",
    find: `  { id: "mock_paper", label: "Mock paper (competitive exam)", description: "Detects CAT/JEE/NEET/etc. from topic", icon: <Trophy size={16} />,
    blueprint: { mode: "custom", pickedLevels: ["apply", "analyze", "evaluate"], perLevel: 5,
      rationale: "Exam-style depth: Apply / Analyze / Evaluate. Type the exam name (CAT, JEE, NEET) in Topic and the form auto-tunes." } },`,
    replace: `  { id: "mock_paper", label: "Full mock paper", description: "Exam-style paper aligned to your teaching context", icon: <Trophy size={16} />,
    blueprint: { mode: "custom", pickedLevels: ["apply", "analyze", "evaluate"], perLevel: 5,
      rationale: "Exam-style depth: Apply / Analyze / Evaluate. The teaching-context picker above tells the AI which exam style to mimic — this intent biases toward the deep Bloom levels real entrance exams test." } },`,
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
    skipped.push({ tag: fx.tag, reason: "find pattern not present (already applied or copy already changed?)" });
    continue;
  }
  if (before.indexOf(fx.find) !== before.lastIndexOf(fx.find)) {
    skipped.push({ tag: fx.tag, reason: "find pattern not unique - cowardly refusing" });
    continue;
  }
  fs.writeFileSync(abs, before.replace(fx.find, fx.replace), "utf8");
  applied.push(fx.tag);
}

console.log(`\n=== r9 (mock_paper copy revisit) summary ===`);
console.log(`Applied: ${applied.length}  ->  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
