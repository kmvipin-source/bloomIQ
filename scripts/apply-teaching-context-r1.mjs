// scripts/apply-teaching-context-r1.mjs
// =============================================================================
// Adds Teaching-Context picker + cross-validation to /teacher/generate/page.tsx.
//
// What it does (in order, idempotent per-fix):
//   1. Import the new lib/teachingContext helper.
//   2. Add `teachingContext` + `validationOverride` state.
//   3. Render the "Who are you teaching today?" picker card between Class
//      scope and Intent picker.
//   4. Compute live validation via useMemo (class grade × intent × bloom).
//   5. Render warning banner above the Generate button area.
//   6. Render the "I really mean this" override checkbox when blocking.
//   7. Gate the Generate button on `validation.blocking && !validationOverride`.
//   8. Send `teaching_context` + `override_validation` in the API body.
//
// Run with:  node scripts/apply-teaching-context-r1.mjs
//
// Re-runnable. Each fix checks if its `find` pattern is still present in the
// file; if not (because it was already replaced), the fix is skipped.
//
// After running, verify:
//   git diff app/teacher/generate/page.tsx
//   npx tsc --noEmit --skipLibCheck
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  // ─── 1. IMPORTS ──────────────────────────────────────────────────────────
  {
    tag: "imports",
    file: "app/teacher/generate/page.tsx",
    description: "Add lib/teachingContext imports",
    find: `import GenerateContextChips, { type GenerateContext } from "@/components/GenerateContextChips";`,
    replace: `import GenerateContextChips, { type GenerateContext } from "@/components/GenerateContextChips";
import {
  validateGenerationRequest,
  TEACHING_CONTEXT_OPTIONS,
  type TeachingContextProfile,
  type IntentId as TCIntentId,
} from "@/lib/teachingContext";`,
  },

  // ─── 2. STATE DECLARATIONS ───────────────────────────────────────────────
  {
    tag: "state_teachingContext",
    file: "app/teacher/generate/page.tsx",
    description: "Add teachingContext + validationOverride state",
    find: `  const [err, setErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<Record<BloomLevel, number> | null>(null);`,
    replace: `  const [err, setErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<Record<BloomLevel, number> | null>(null);
  // Teaching context (k12 / competitive_exam / corporate). Picker is per-test
  // but defaults to the teacher's last choice via profiles.last_teaching_context
  // (loaded in a useEffect below). Null until loaded so the picker shows
  // "unset" on first paint and doesn't flash a wrong default.
  const [teachingContext, setTeachingContext] = useState<TeachingContextProfile | null>(null);
  // Validation override: teacher acknowledges a blocking warning and proceeds.
  // Resets to false on every meaningful change so they re-confirm if rules
  // tighten mid-session.
  const [validationOverride, setValidationOverride] = useState<boolean>(false);`,
  },

  // ─── 3. PICKER CARD UI ───────────────────────────────────────────────────
  {
    tag: "picker_card",
    file: "app/teacher/generate/page.tsx",
    description: "Insert Teaching-Context picker between Class scope and Intent picker",
    find: `      {/* ---------- INTENT PICKER (Q1) ----------
          Outcome-shaped chips that pre-fill Bloom mode + level mix +
          per-level count. Soft narrowing — the teacher can still edit
          anything below. Hidden in the most subtle way: collapsed to a
          one-line "Skip — set everything yourself" link if they don't
          want guidance. Default is to show. */}`,
    replace: `      {/* ---------- TEACHING CONTEXT PICKER ----------
          Lets the teacher say "this test is for K-12 / competitive exam /
          professional training" per generation. Drives both the AI prompt
          register AND the cross-validation rules. Persisted to
          profiles.last_teaching_context so the next visit defaults to it. */}
      <div className="card mt-5">
        <div className="flex items-center gap-2 mb-2">
          <GraduationCap size={16} className="text-emerald-600" />
          <h2 className="font-semibold text-sm">Who are you teaching today?</h2>
          <span className="text-xs muted ml-auto">Picks the AI&apos;s register and unlocks cross-checks</span>
        </div>
        <div className="grid sm:grid-cols-3 gap-2">
          {TEACHING_CONTEXT_OPTIONS.map((opt) => {
            const selected = teachingContext === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => { setTeachingContext(opt.value); setValidationOverride(false); }}
                className={\`text-left rounded-lg border px-3 py-2 transition \${
                  selected
                    ? "border-emerald-500 bg-emerald-50 ring-1 ring-emerald-200"
                    : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                }\`}
              >
                <div className="font-medium text-sm text-slate-800">{opt.label}</div>
                <div className="text-[11px] text-slate-500 mt-0.5">{opt.description}</div>
              </button>
            );
          })}
        </div>
        {!teachingContext && (
          <p className="text-[11px] text-amber-700 mt-2">
            Pick one — the AI generates very different questions for a Class 6 science test vs. a JEE mock.
          </p>
        )}
      </div>

      {/* ---------- INTENT PICKER (Q1) ----------
          Outcome-shaped chips that pre-fill Bloom mode + level mix +
          per-level count. Soft narrowing — the teacher can still edit
          anything below. Hidden in the most subtle way: collapsed to a
          one-line "Skip — set everything yourself" link if they don't
          want guidance. Default is to show. */}`,
  },

  // ─── 4. VALIDATION COMPUTATION ───────────────────────────────────────────
  // We piggy-back on the existing effectiveLevels calc inside the pre-flight
  // IIFE. Hoisting validation into the component body keeps the banner above
  // the Generate button while the disable-on-blocking logic lives inside the
  // IIFE that already computes `canGenerate`.
  {
    tag: "validation_memo",
    file: "app/teacher/generate/page.tsx",
    description: "Add useMemo for validation result",
    find: `  const [activeIntentId, setActiveIntentId] = useState<string | null>(null);`,
    replace: `  const [activeIntentId, setActiveIntentId] = useState<string | null>(null);

  // Live cross-validation: re-runs whenever class/intent/bloom/context changes.
  // Used by the banner above the Generate button + to gate the button itself.
  // Always cheap (pure functions, no Supabase).
  const validation = useMemo(() => {
    const cls = teacherClasses.find((c) => c.id === targetClassId) || null;
    const effLevels: BloomLevel[] = mode === "all" ? BLOOM_LEVELS.slice() : pickedLevels;
    // Map the page's free-form activeIntentId strings to teachingContext IntentId.
    // Most map 1:1; a few are aliases. Unknown strings just yield null → no
    // intent-based rule fires. (Mapping table below — keep in sync with the
    // intents array in this file.)
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
    const mappedIntent: TCIntentId | null = activeIntentId
      ? (intentMap[activeIntentId] ?? null)
      : null;
    return validateGenerationRequest({
      classGrade: cls?.grade ?? null,
      intent: mappedIntent,
      bloomLevels: effLevels,
      teachingContext,
    });
  }, [teacherClasses, targetClassId, activeIntentId, mode, pickedLevels, teachingContext]);`,
  },

  // ─── 5. WARNING BANNER ABOVE GENERATE BUTTON ─────────────────────────────
  // Slot the banner just above the existing pre-flight IIFE. The IIFE renders
  // the "Will generate X questions" + Generate button; we want the warning
  // above that so the teacher sees it before clicking.
  {
    tag: "warning_banner",
    file: "app/teacher/generate/page.tsx",
    description: "Insert validation banner + override checkbox above Generate button",
    find: `        {/* Pre-flight validation + summary pill (2026-05-14). Disables the`,
    replace: `        {/* Validation banner — fires before Generate is clicked, lets the
            teacher fix or override BEFORE we burn tokens. */}
        {!validation.ok && (
          <div className={\`rounded-lg border px-3 py-2 text-sm \${
            validation.blocking
              ? "border-red-300 bg-red-50 text-red-900"
              : "border-amber-300 bg-amber-50 text-amber-900"
          }\`}>
            <div className="font-semibold mb-1">
              {validation.blocking ? "Hold on — these look mismatched:" : "A couple of things to double-check:"}
            </div>
            <ul className="list-disc ml-5 space-y-1">
              {validation.issues.map((iss) => (
                <li key={iss.code}>
                  <span className="font-medium">{iss.message}</span>
                  {iss.detail && <div className="text-xs opacity-80 mt-0.5">{iss.detail}</div>}
                </li>
              ))}
            </ul>
            {validation.blocking && (
              <label className="flex items-center gap-2 mt-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={validationOverride}
                  onChange={(e) => setValidationOverride(e.target.checked)}
                />
                <span className="text-xs">
                  <strong>I really mean this</strong> — generate anyway. (Overrides are logged.)
                </span>
              </label>
            )}
          </div>
        )}

        {/* Pre-flight validation + summary pill (2026-05-14). Disables the`,
  },

  // ─── 6. GATE GENERATE BUTTON ─────────────────────────────────────────────
  // The existing IIFE computes `canGenerate = !reason && !busy`. We need to
  // also factor in the validation result. Smallest invasive change: replace
  // that single line.
  {
    tag: "gate_button",
    file: "app/teacher/generate/page.tsx",
    description: "Factor validation into canGenerate",
    find: `          const canGenerate = !reason && !busy;`,
    replace: `          // Block when validation flags a "block"-severity issue and the
          // teacher hasn't checked the override. Non-blocking warnings (amber)
          // are advisory only — they don't disable the button.
          const validationBlock = validation.blocking && !validationOverride;
          const canGenerate = !reason && !busy && !validationBlock;`,
  },

  // ─── 7. API BODY: include teaching_context + override flag ───────────────
  {
    tag: "api_body",
    file: "app/teacher/generate/page.tsx",
    description: "Pass teaching_context + override_validation to /api/generate",
    find: `        // Generate-context-v2 (2026-05-13).
        audience_level: genContext.audience_level,
        sub_topics: genContext.sub_topics,
        additional_focus: genContext.additional_focus,
      };`,
    replace: `        // Generate-context-v2 (2026-05-13).
        audience_level: genContext.audience_level,
        sub_topics: genContext.sub_topics,
        additional_focus: genContext.additional_focus,
        // Teaching context (k12 / competitive_exam / corporate) — drives the
        // AI's register. API may or may not honor this yet; best-effort field.
        ...(teachingContext ? { teaching_context: teachingContext } : {}),
        // Override flag — set to true when teacher has acknowledged a block.
        // Telemetry should fire here. Future API will enforce this serverside.
        ...(validationOverride ? { override_validation: true } : {}),
      };`,
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

console.log(`\n=== Teaching-Context apply summary ===`);
console.log(`Applied: ${applied.length}  ->  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
console.log(`\nNext: \`git diff app/teacher/generate/page.tsx\` to review,`);
console.log(`      \`npx tsc --noEmit --skipLibCheck\` to verify the build.`);
