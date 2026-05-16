// scripts/apply-teaching-context-r3-tdz-fix.mjs
// =============================================================================
// Fix: r2 placed the `validation` useMemo BEFORE `teacherClasses` is declared,
// causing a temporal-dead-zone runtime error:
//   "Cannot access 'teacherClasses' before initialization" at the useMemo line.
//
// Root cause: r2's anchor was `const [activeIntentId, setActiveIntentId] = ...`
// which sits ~80 lines above the teacherClasses useState. The validation
// useMemo reads teacherClasses + examDefault in its closure AND deps, so it
// must live below both.
//
// This codemod:
//   1. REMOVES the misplaced validation useMemo (the block r2 inserted
//      right after activeIntentId).
//   2. INSERTS it immediately after the sticky-default useEffect that r2
//      added right after teacherClasses + targetClassId — that point is
//      below all dependencies and a stable, unique anchor.
//
// Idempotent: if the misplaced block is already gone, step 1 is skipped.
//             if the correctly-placed block is already there, step 2 is skipped.
//
// Run:    node scripts/apply-teaching-context-r3-tdz-fix.mjs
// Verify: npx tsc --noEmit --skipLibCheck && npm run dev
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// The exact validation useMemo block that r2 inserted in the wrong place.
// Must match byte-for-byte for the removal step to fire.
const VALIDATION_BLOCK = `

  // Live cross-field validation. Cheap (pure functions). Re-runs when any
  // input changes. See lib/teachingContext.validateGenerationRequest for the
  // full rule set (Rules 1-11).
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
    // Topic-detection: use existing detectExamFromTopic if available; otherwise null.
    // examDefault is already computed elsewhere on this page so we surface its slug.
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

const FIXES = [
  // ─── 1. REMOVE misplaced block ───────────────────────────────────────────
  {
    tag: "remove_misplaced",
    file: "app/teacher/generate/page.tsx",
    description: "Remove validation useMemo from after activeIntentId (TDZ source)",
    find: `  const [activeIntentId, setActiveIntentId] = useState<string | null>(null);` + VALIDATION_BLOCK,
    replace: `  const [activeIntentId, setActiveIntentId] = useState<string | null>(null);`,
  },

  // ─── 2. INSERT correctly-placed block ────────────────────────────────────
  // Anchor: the END of the sticky-default useEffect r2 added. That useEffect's
  // closing line is `  }, []);` followed by a blank line. To make the match
  // unique (there are many `}, []);` in the file), we anchor on the full
  // useEffect body so the replace lands in exactly one spot.
  {
    tag: "insert_correctly",
    file: "app/teacher/generate/page.tsx",
    description: "Insert validation useMemo after teacherClasses + sticky-default useEffect",
    find: `  // Load the teacher's saved last_teaching_context on mount. Fire-and-forget;
  // any failure leaves savedLastContext null and the picker stays unseeded.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) return;
        const { data } = await sb
          .from("profiles")
          .select("last_teaching_context")
          .eq("id", user.id)
          .maybeSingle();
        if (cancelled) return;
        const saved = (data?.last_teaching_context as string | null) ?? null;
        if (saved) setSavedLastContext(saved);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, []);`,
    replace: `  // Load the teacher's saved last_teaching_context on mount. Fire-and-forget;
  // any failure leaves savedLastContext null and the picker stays unseeded.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) return;
        const { data } = await sb
          .from("profiles")
          .select("last_teaching_context")
          .eq("id", user.id)
          .maybeSingle();
        if (cancelled) return;
        const saved = (data?.last_teaching_context as string | null) ?? null;
        if (saved) setSavedLastContext(saved);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Live cross-field validation. Cheap (pure functions). Re-runs when any
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
  }, [teacherClasses, targetClassId, activeIntentId, mode, pickedLevels, teachingContext, examDefault, numericalPercent]);`,
  },
];

// =============================================================================
// Apply
// =============================================================================

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

console.log(`\n=== Teaching-Context r3 (TDZ fix) summary ===`);
console.log(`Applied: ${applied.length}  ->  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
console.log(``);
console.log(`Verify:`);
console.log(`  git diff app/teacher/generate/page.tsx   # eyeball the move`);
console.log(`  npx tsc --noEmit --skipLibCheck          # must be clean`);
console.log(`  npm run dev                              # reload /teacher/generate`);
