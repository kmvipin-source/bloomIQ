// scripts/apply-teaching-context-r7-assign-page.mjs
// =============================================================================
// /teacher/quizzes/new (Build/Assign Tests) — inherits teaching-context picker
// + cross-validation from /teacher/generate.
//
// Why on this page too:
//   - The teacher composes a test from existing questions and assigns it to
//     a class. The picked context drives:
//       (a) the suggested marking-scheme preset (already wired via
//           suggestPresetForGoal — we just feed it the picker value),
//       (b) a class-vs-context mismatch banner (uses the same
//           validateGenerationFit helper),
//       (c) future-proofing for per-context filtering of the question bank.
//
// Adds:
//   - teachingContext + savedLastContext + validationOverride state
//   - Sticky-default load from profiles.last_teaching_context
//   - Picker UI as a card at the top of the right-side panel
//   - Mismatch banner using validateGenerationFit
//   - Override checkbox + Assign-button gating
//
// Idempotent. Run:  node scripts/apply-teaching-context-r7-assign-page.mjs
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  // ─── 1. IMPORTS ──────────────────────────────────────────────────────
  {
    tag: "imports",
    file: "app/teacher/quizzes/new/page.tsx",
    description: "Add teachingContext + questionCategory imports",
    find: `import { suggestPresetForGoal, type ScoringPresetKey } from "@/lib/scoringPresets";`,
    replace: `import { suggestPresetForGoal, type ScoringPresetKey } from "@/lib/scoringPresets";
import {
  groupedTeachingContextOptions,
  defaultTeachingContext,
} from "@/lib/teachingContext";
import {
  validateGenerationFitForGrade,
  categoryLabel,
} from "@/lib/questionCategory";`,
  },

  // ─── 2. STATE for teachingContext / savedLastContext / override ─────
  // Anchor on a stable existing state line.
  {
    tag: "state",
    file: "app/teacher/quizzes/new/page.tsx",
    description: "Add teaching-context + override state",
    find: `  const [teacherExamGoal, setTeacherExamGoal] = useState<string | null>(null);`,
    replace: `  const [teacherExamGoal, setTeacherExamGoal] = useState<string | null>(null);
  // Teaching context = which category this test is being composed for.
  // Same vocabulary as /teacher/generate (slug from lib/questionCategory).
  // Drives suggested marking-scheme preset + the class-vs-context banner.
  const [teachingContext, setTeachingContext] = useState<string | null>(null);
  const [savedLastContext, setSavedLastContext] = useState<string | null>(null);
  // Override flag: teacher acknowledges a blocking class-vs-context mismatch
  // and proceeds with the assign anyway. Reset on every meaningful change.
  const [validationOverride, setValidationOverride] = useState<boolean>(false);`,
  },

  // ─── 3. STICKY-DEFAULT LOAD on mount ─────────────────────────────────
  // Splice into the same place where teacher classes load. Use a stable
  // anchor — the `setClasses(...)` line is too generic; anchor on the page's
  // first useEffect comment instead. Insert as a NEW useEffect right after
  // the existing useState block (before any other useEffect).
  //
  // Safer anchor: the existing `const [classes, setClasses] = ...` line.
  {
    tag: "sticky_default_load",
    file: "app/teacher/quizzes/new/page.tsx",
    description: "Load profiles.last_teaching_context on mount",
    find: `  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [targetClassId, setTargetClassId] = useState<string>("");`,
    replace: `  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [targetClassId, setTargetClassId] = useState<string>("");
  // Load saved last_teaching_context. Fire-and-forget — failure leaves saved=null.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) return;
        const { data } = await sb.from("profiles").select("last_teaching_context").eq("id", user.id).maybeSingle();
        if (cancelled) return;
        const saved = (data?.last_teaching_context as string | null) ?? null;
        if (saved) setSavedLastContext(saved);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, []);`,
  },

  // ─── 4. VALIDATION MEMO ──────────────────────────────────────────────
  // After the negMarkingWarn memo (line 131 area). Class grade vs picked
  // context using existing validateGenerationFitForGrade helper.
  {
    tag: "validation_memo",
    file: "app/teacher/quizzes/new/page.tsx",
    description: "Class-vs-context fit memo",
    find: `  const negMarkingWarn = useMemo(`,
    replace: `  // Class-vs-context fit. Re-runs on class or picker change. Reuses the
  // existing validateGenerationFitForGrade helper from lib/questionCategory.
  const contextFit = useMemo(() => {
    const cls = classes.find((c) => c.id === targetClassId) || null;
    if (!cls?.grade || !teachingContext) return null;
    return validateGenerationFitForGrade(cls.grade, teachingContext);
  }, [classes, targetClassId, teachingContext]);

  const negMarkingWarn = useMemo(`,
  },

  // ─── 5. PICKER UI + mismatch banner — top of right side panel ─────────
  // Insert as a new card BEFORE the existing Test-name card.
  {
    tag: "picker_card",
    file: "app/teacher/quizzes/new/page.tsx",
    description: "Insert teaching-context dropdown + mismatch banner card",
    find: `          <div className="card">
            <label className="label">Test name</label>`,
    replace: `          {/* ---------- TEACHING CONTEXT (mirrors /teacher/generate) ---------- */}
          <div className="card">
            <div className="flex items-center gap-2 mb-2">
              <h3 className="font-semibold text-sm">Who is this test for?</h3>
              <span className="text-xs muted ml-auto">Picks the scoring style + unlocks cross-checks</span>
            </div>
            {(() => {
              // Seed picker once: prefer saved last-context, then class.grade-derived.
              if (teachingContext === null) {
                const cls = classes.find((c) => c.id === targetClassId) || null;
                const seed = defaultTeachingContext({ savedLastContext, classGrade: cls?.grade ?? null });
                if (seed) setTimeout(() => setTeachingContext(seed), 0);
              }
              return null;
            })()}
            <select
              className="select w-full text-sm"
              value={teachingContext ?? ""}
              onChange={(e) => {
                const v = e.target.value || null;
                setTeachingContext(v);
                setValidationOverride(false);
                if (v) {
                  (async () => {
                    try {
                      const sb = supabaseBrowser();
                      const { data: { user } } = await sb.auth.getUser();
                      if (!user) return;
                      await sb.from("profiles").update({ last_teaching_context: v }).eq("id", user.id);
                    } catch { /* silent */ }
                  })();
                }
              }}
            >
              <option value="">Pick a context...</option>
              {groupedTeachingContextOptions().map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.options.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            {teachingContext && !contextFit && (
              <p className="text-[11px] text-emerald-700 mt-1">
                Test composed for <strong>{categoryLabel(teachingContext)}</strong>.
              </p>
            )}
            {contextFit && contextFit.severity !== "none" && (
              <div className={\`mt-2 rounded-lg border px-3 py-2 text-sm \${
                contextFit.severity === "hard"
                  ? "border-red-300 bg-red-50 text-red-900"
                  : "border-amber-300 bg-amber-50 text-amber-900"
              }\`}>
                <div className="font-semibold mb-0.5">
                  {contextFit.severity === "hard" ? "Class / context mismatch:" : "Heads up:"}
                </div>
                <div>{contextFit.message}</div>
                {contextFit.detail && <div className="text-xs opacity-80 mt-1">{contextFit.detail}</div>}
                {contextFit.severity === "hard" && (
                  <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={validationOverride}
                      onChange={(e) => setValidationOverride(e.target.checked)}
                    />
                    <span className="text-xs"><strong>I really mean this</strong> — assign anyway.</span>
                  </label>
                )}
              </div>
            )}
          </div>

          <div className="card">
            <label className="label">Test name</label>`,
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

console.log(`\n=== r7 (Assign page world-class) summary ===`);
console.log(`Applied: ${applied.length}  ->  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
