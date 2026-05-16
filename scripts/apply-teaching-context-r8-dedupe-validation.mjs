// scripts/apply-teaching-context-r8-dedupe-validation.mjs
// =============================================================================
// Fix the duplicate `const validation = useMemo(...)` declaration that
// appeared because r3's remove-step skipped while its insert-step succeeded.
//
// The file now has TWO identical validation blocks back-to-back. This script
// deletes the second one. Idempotent: if only one exists, the script skips.
//
// Run:  node scripts/apply-teaching-context-r8-dedupe-validation.mjs
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const DUPLICATE_BLOCK = `  // Live cross-field validation. Cheap (pure functions). Re-runs when any
  // input changes. See lib/teachingContext.validateGenerationRequest for the
  // full rule set (Rules 1-11). Placed AFTER teacherClasses + examDefault are
  // declared (TDZ-safe).
  const validation = useMemo(() => {
    const cls = teacherClasses.find((c) => c.id === targetClassId) || null;
    const effLevels: BloomLevel[] = mode === "all" ? BLOOM_LEVELS.slice() : pickedLevels;
    const intentMap: Record<string, TCIntentId> = {
      "quick_check": "quick_check",
      "pulse": "post_class_pulse",
      "post_class_pulse": "post_class_pulse",
      "chapter_end": "chapter_end",
      "balanced_summary": "chapter_end",
      "diagnostic": "diagnostic",
      "mock_paper": "mock_paper",
      "mock": "mock_paper",
      "homework": "homework",
      "remediation": "remediation",
      "re_teach": "remediation",
    };
    const mappedIntent: TCIntentId | null = activeIntentId ? (intentMap[activeIntentId] ?? null) : null;
    const detectedSlug: string | null = examDefault
      ? examDefault.displayName.toLowerCase().replace(/\\s+/g, "_")
      : null;
    return validateGenerationRequest({
      classGrade: cls?.grade ?? null,
      intent: mappedIntent,
      bloomLevels: effLevels,
      teachingContext,
      topicDetectedExam: detectedSlug,
      numericalPercent,
      attemptingGenerate: false,
    });
  }, [teacherClasses, targetClassId, activeIntentId, mode, pickedLevels, teachingContext, examDefault, numericalPercent]);`;

// The find pattern: end of FIRST block (its closing line) + blank + start of
// SECOND block (its comment) + entire second block + closing. The entire
// match is just-the-second-block-plus-a-blank-line; we replace with empty
// to delete it.

const findPattern =
  `}, [teacherClasses, targetClassId, activeIntentId, mode, pickedLevels, teachingContext, examDefault, numericalPercent]);\n\n` +
  DUPLICATE_BLOCK +
  `\n`;

// Replace with just the original closer (keeping ONE validation). The blank
// line after stays so the next declaration (useEffect at line 579) keeps its
// breathing room.

const replacePattern =
  `}, [teacherClasses, targetClassId, activeIntentId, mode, pickedLevels, teachingContext, examDefault, numericalPercent]);\n`;

const FIXES = [
  {
    tag: "dedupe_validation",
    file: "app/teacher/generate/page.tsx",
    description: "Delete the duplicate validation useMemo block",
    find: findPattern,
    replace: replacePattern,
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
    skipped.push({ tag: fx.tag, reason: "find pattern not present (no duplicate — already fine?)" });
    continue;
  }
  if (before.indexOf(fx.find) !== before.lastIndexOf(fx.find)) {
    skipped.push({ tag: fx.tag, reason: "find pattern not unique - cowardly refusing" });
    continue;
  }
  fs.writeFileSync(abs, before.replace(fx.find, fx.replace), "utf8");
  applied.push(fx.tag);
}

console.log(`\n=== r8 (dedupe validation) summary ===`);
console.log(`Applied: ${applied.length}  ->  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
if (applied.length > 0) {
  console.log(``);
  console.log(`Verify exactly ONE validation declaration remains:`);
  console.log(`  grep -c "const validation = useMemo" app/teacher/generate/page.tsx`);
  console.log(`(should print "1")`);
}
