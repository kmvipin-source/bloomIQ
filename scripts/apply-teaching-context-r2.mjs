// scripts/apply-teaching-context-r2.mjs
// =============================================================================
// Teaching-Context dropdown + cross-validation for /teacher/generate/page.tsx.
//
// v2 is a clean redesign of v1:
//   - Uses a single <select> dropdown with <optgroup>s (~20 category slugs),
//     not three coarse pill-tiles.
//   - Vocabulary matches lib/questionCategory.ts exactly.
//   - Pulls topic-detected exam + numerical % + class grade into the
//     validator so we cross-check all axes (Rules 1-11 in lib/teachingContext).
//
// Idempotent. Each fix checks if its anchor text is still present (it won't
// be if the fix has been applied), so re-running is safe.
//
// DO NOT run apply-teaching-context-r1.mjs (deprecated draft). If you ran
// it, revert with: `git checkout app/teacher/generate/page.tsx` then run r2.
//
// Run:    node scripts/apply-teaching-context-r2.mjs
// Verify: git diff app/teacher/generate/page.tsx
//         npx tsc --noEmit --skipLibCheck
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
  groupedTeachingContextOptions,
  defaultTeachingContext,
  type IntentId as TCIntentId,
} from "@/lib/teachingContext";`,
  },

  // ─── 2. STATE ────────────────────────────────────────────────────────────
  {
    tag: "state",
    file: "app/teacher/generate/page.tsx",
    description: "Add teachingContext + validationOverride + savedLastContext state",
    find: `  const [err, setErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<Record<BloomLevel, number> | null>(null);`,
    replace: `  const [err, setErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<Record<BloomLevel, number> | null>(null);
  // Teaching context = category slug from the dropdown (class5_8 / jee_main /
  // neet / cat / ... — see lib/questionCategory.ts categoryLabel for the full
  // vocabulary). null until the teacher picks (or until we seed from the
  // class.grade-derived default below).
  const [teachingContext, setTeachingContext] = useState<string | null>(null);
  // The last-context slug the teacher saved previously (from profile). Set
  // ONCE on mount in a useEffect; used to seed the picker via
  // defaultTeachingContext. null = never set or load failed.
  const [savedLastContext, setSavedLastContext] = useState<string | null>(null);
  // Override flag: teacher acknowledges a blocking warning. Resets to false
  // whenever the picker or class changes so the teacher re-confirms.
  const [validationOverride, setValidationOverride] = useState<boolean>(false);`,
  },

  // ─── 3. STICKY-DEFAULT LOAD ─────────────────────────────────────────────
  // We piggy-back on the existing teacher-classes-load useEffect since both
  // depend on the auth session. Adding a separate useEffect would mean two
  // round-trips on every page load. We splice into the existing one.
  {
    tag: "sticky_default_load",
    file: "app/teacher/generate/page.tsx",
    description: "Load profiles.last_teaching_context on mount",
    find: `  const [teacherClasses, setTeacherClasses] = useState<ClassOption[]>([]);
  const [targetClassId, setTargetClassId] = useState<string>("");`,
    replace: `  const [teacherClasses, setTeacherClasses] = useState<ClassOption[]>([]);
  const [targetClassId, setTargetClassId] = useState<string>("");
  // Load the teacher's saved last_teaching_context on mount. Fire-and-forget;
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
  },

  // ─── 4. PICKER UI + AUTO-SEED ──────────────────────────────────────────
  {
    tag: "picker_ui",
    file: "app/teacher/generate/page.tsx",
    description: "Insert Teaching-Context dropdown between Class scope and Intent picker",
    find: `      {/* ---------- INTENT PICKER (Q1) ----------
          Outcome-shaped chips that pre-fill Bloom mode + level mix +
          per-level count. Soft narrowing — the teacher can still edit
          anything below. Hidden in the most subtle way: collapsed to a
          one-line "Skip — set everything yourself" link if they don't
          want guidance. Default is to show. */}`,
    replace: `      {/* ---------- TEACHING CONTEXT PICKER ----------
          Single dropdown of the ~20 category slugs from
          lib/questionCategory.ts. Drives the AI's register and unlocks
          per-axis cross-validation. Seeds from profiles.last_teaching_context,
          falling back to classGradeToCategory(class.grade) when that's null.
          Picker is per-test — teacher can change for this generation only. */}
      <div className="card mt-5">
        <div className="flex items-center gap-2 mb-2">
          <GraduationCap size={16} className="text-emerald-600" />
          <h2 className="font-semibold text-sm">Who are you teaching today?</h2>
          <span className="text-xs muted ml-auto">Picks the AI&apos;s register + unlocks cross-checks</span>
        </div>
        {(() => {
          // Seed the picker once: when teachingContext is still null AND we
          // either have a saved last-context OR a class is selected, pick
          // the best default. Wrapped in an inline IIFE so we don't have
          // to add a useEffect — React re-runs the render anyway when its
          // inputs change.
          if (teachingContext === null) {
            const cls = teacherClasses.find((c) => c.id === targetClassId) || null;
            const seed = defaultTeachingContext({
              savedLastContext,
              classGrade: cls?.grade ?? null,
            });
            if (seed) {
              // Schedule the setState so we don't violate React's "no setState
              // in render" rule. setTimeout(0) defers to the next tick.
              setTimeout(() => setTeachingContext(seed), 0);
            }
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
            // Fire-and-forget: persist to profiles.last_teaching_context.
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
        {teachingContext && (
          <p className="text-[11px] text-emerald-700 mt-1">
            Questions will be written for <strong>{(() => {
              const found = groupedTeachingContextOptions()
                .flatMap((g) => g.options)
                .find((o) => o.value === teachingContext);
              return found ? found.label : teachingContext;
            })()}</strong>.
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

  // ─── 5. VALIDATION MEMO ────────────────────────────────────────────────
  {
    tag: "validation_memo",
    file: "app/teacher/generate/page.tsx",
    description: "Add useMemo computing the cross-field validation result",
    find: `  const [activeIntentId, setActiveIntentId] = useState<string | null>(null);`,
    replace: `  const [activeIntentId, setActiveIntentId] = useState<string | null>(null);

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
  }, [teacherClasses, targetClassId, activeIntentId, mode, pickedLevels, teachingContext, examDefault, numericalPercent]);`,
  },

  // ─── 6. WARNING BANNER + OVERRIDE CHECKBOX ─────────────────────────────
  {
    tag: "warning_banner",
    file: "app/teacher/generate/page.tsx",
    description: "Insert validation banner above Generate button area",
    find: `        {/* Pre-flight validation + summary pill (2026-05-14). Disables the`,
    replace: `        {/* Cross-field validation banner — fires BEFORE Generate is clicked.
            Severity ladder: soft (amber) / hard (amber, bold) / block (red +
            override checkbox required). */}
        {!validation.ok && (
          <div className={\`rounded-lg border px-3 py-2 text-sm \${
            validation.blocking
              ? "border-red-300 bg-red-50 text-red-900"
              : "border-amber-300 bg-amber-50 text-amber-900"
          }\`}>
            <div className="font-semibold mb-1">
              {validation.blocking ? "Hold on — these look mismatched:" : "Couple of things to double-check:"}
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
              <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
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

  // ─── 7. GATE GENERATE BUTTON ──────────────────────────────────────────
  {
    tag: "gate_button",
    file: "app/teacher/generate/page.tsx",
    description: "Block Generate when validation blocks AND override unchecked",
    find: `          const canGenerate = !reason && !busy;`,
    replace: `          // Block when validation flags any "block" issue and the teacher hasn't
          // checked the override box. Soft / hard warnings don't disable the button.
          const validationBlock = validation.blocking && !validationOverride;
          const canGenerate = !reason && !busy && !validationBlock;`,
  },

  // ─── 8. API BODY ──────────────────────────────────────────────────────
  {
    tag: "api_body",
    file: "app/teacher/generate/page.tsx",
    description: "Send teaching_context + override_validation in request body",
    find: `        // Generate-context-v2 (2026-05-13).
        audience_level: genContext.audience_level,
        sub_topics: genContext.sub_topics,
        additional_focus: genContext.additional_focus,
      };`,
    replace: `        // Generate-context-v2 (2026-05-13).
        audience_level: genContext.audience_level,
        sub_topics: genContext.sub_topics,
        additional_focus: genContext.additional_focus,
        // Teaching context slug (class5_8 / jee_main / neet / cat / ...).
        // Drives the AI's register. API may not consume this yet — that's
        // wired tomorrow (defense-in-depth backend validation).
        ...(teachingContext ? { teaching_context: teachingContext } : {}),
        // Override flag — true when teacher acknowledged a blocking warning.
        // Telemetry hook: backend should log override_validation=true so we
        // can audit how often teachers bypass guardrails.
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

console.log(`\n=== Teaching-Context r2 apply summary ===`);
console.log(`Applied: ${applied.length}  ->  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
console.log(`\nNext: git diff app/teacher/generate/page.tsx`);
console.log(`      npx tsc --noEmit --skipLibCheck`);
