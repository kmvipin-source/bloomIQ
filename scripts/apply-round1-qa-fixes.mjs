// Round-1 QA fixes for app/teacher/generate/page.tsx.
// Applies 5 findings atomically in one pass — written this way because
// individual surgical edits via the conversation Edit tool were truncating
// the file. This is the "one file, one atomic write" version.
//
// Findings addressed:
//   #1 CRITICAL TDZ on `validation` (misplaced H5 useEffect) — moved.
//   #2 CRITICAL `countFor is not defined` in generate() post-API block — defined.
//   #3 HIGH    Cannot clear teaching-context picker — pickerInitialized + one-shot effect.
//   #4 MEDIUM  Orphaned active intent on teaching-context change — cleanup effect.
//   #5 MEDIUM  validationOverride leaks across class switch with same issue codes — deps broadened.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "app/teacher/generate/page.tsx");

let src = fs.readFileSync(TARGET, "utf8");
const before = src;

// ---------------------------------------------------------------------------
// FIX #3 (state): add pickerInitialized flag right after savedLastContext.
// ---------------------------------------------------------------------------
{
  const find = `  const [savedLastContext, setSavedLastContext] = useState<string | null>(null);\n  // Override flag: teacher acknowledges a blocking warning. Resets to false`;
  const replace = `  const [savedLastContext, setSavedLastContext] = useState<string | null>(null);
  // One-shot picker-seed flag (H3 fix, Finding #3). Once we've seeded the
  // teaching-context picker from saved last-context or class.grade, this
  // flips true and the seed useEffect no longer re-fires. This is what
  // lets the teacher deliberately clear the picker via "Pick a context..."
  // without it bouncing back to the seeded value on the very next render.
  const [pickerInitialized, setPickerInitialized] = useState<boolean>(false);
  // Override flag: teacher acknowledges a blocking warning. Resets to false`;
  if (!src.includes(find)) throw new Error("FIX#3-state: anchor not found");
  src = src.replace(find, replace);
}

// ---------------------------------------------------------------------------
// FIX #1 (TDZ): REMOVE the misplaced H5 useEffect (sits above `validation`).
// Replace with a one-line breadcrumb pointing at the new location.
// ---------------------------------------------------------------------------
{
  const find = `  // H5 fix: clear override whenever the set of validation issues changes,
  // so a teacher who acknowledged an old block cannot accidentally skip a NEW
  // block that appeared after a field change.
  useEffect(() => {
    setValidationOverride(false);
  }, [validation.issues.map((i) => i.code).join(",")]);

  // Auto-set Numerical-% when the teacher picks a competitive-exam context.`;
  const replace = `  // (H5 useEffect was here — moved BELOW the \`validation\` useMemo to fix
  // a TDZ ReferenceError. See the combined H3/H4/H5 effects block right
  // after the validation useMemo. Findings #1 and #5.)

  // Auto-set Numerical-% when the teacher picks a competitive-exam context.`;
  if (!src.includes(find)) throw new Error("FIX#1: TDZ H5 anchor not found");
  src = src.replace(find, replace);
}

// ---------------------------------------------------------------------------
// FIX #1+#3+#4+#5 (effects): insert the three new useEffects RIGHT AFTER the
// `validation` useMemo's closing `}, [..deps..]);` line.
// ---------------------------------------------------------------------------
{
  const find = `  }, [teacherClasses, targetClassId, activeIntentId, mode, pickedLevels, teachingContext, examDefault, numericalPercent]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return;
        const r = await fetch("/api/teacher/classes", {`;
  const replace = `  }, [teacherClasses, targetClassId, activeIntentId, mode, pickedLevels, teachingContext, examDefault, numericalPercent]);

  // ── H5 relocated + broadened (Findings #1 + #5) ───────────────────────
  // Clear validationOverride when (a) the set of validation issue codes
  // changes, OR (b) the target class changes, OR (c) the teaching context
  // changes. This honors the documented behavior at validationOverride's
  // declaration: "Resets to false whenever the picker or class changes."
  // The earlier H5 effect (i) lived ABOVE this useMemo so it crashed at
  // runtime with TDZ, and (ii) only watched issue codes — so changing
  // Class 5 → Class 6 with the same Bloom×exam mismatch silently kept the
  // override live.
  useEffect(() => {
    setValidationOverride(false);
  }, [validation.issues.map((i) => i.code).join(","), targetClassId, teachingContext]);

  // ── H3 one-shot picker seed (Finding #3) ──────────────────────────────
  // Replaces the IIFE-in-render that auto-re-seeded teachingContext on every
  // render where it was null — which made the picker impossible to clear.
  // Once seeded (or once we know there's no seed material), pickerInitialized
  // flips true and this effect no longer fires.
  useEffect(() => {
    if (pickerInitialized) return;
    const cls = teacherClasses.find((c) => c.id === targetClassId) || null;
    const seed = defaultTeachingContext({
      savedLastContext,
      classGrade: cls?.grade ?? null,
    });
    if (seed) {
      setTeachingContext(seed);
      setPickerInitialized(true);
    } else if (savedLastContext !== null || teacherClasses.length > 0) {
      // Both seed inputs have finished loading and there's nothing to seed
      // from. Lock initialization so we don't keep retrying every render.
      setPickerInitialized(true);
    }
  }, [pickerInitialized, savedLastContext, teacherClasses, targetClassId]);

  // ── H4 orphaned-intent cleanup (Finding #4) ───────────────────────────
  // When teaching context changes such that the previously-chosen intent
  // is no longer in the current \`intents\` list, clear activeIntentId so
  // the chip indicator + "Why this setup" rationale match the active set.
  // Blueprint values the teacher already accepted (mode/levels/perLevel)
  // stay applied — the teacher can re-pick an intent if they want.
  useEffect(() => {
    if (activeIntentId && !intents.some((i) => i.id === activeIntentId)) {
      setActiveIntentId(null);
    }
  }, [intents, activeIntentId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sb = supabaseBrowser();
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return;
        const r = await fetch("/api/teacher/classes", {`;
  if (!src.includes(find)) throw new Error("FIX#1+3+4+5: effects anchor not found");
  src = src.replace(find, replace);
}

// ---------------------------------------------------------------------------
// FIX #3 (JSX): remove the IIFE in the teaching-context picker that auto-
// re-seeded. The new H3 useEffect now owns seeding.
// ---------------------------------------------------------------------------
{
  const find = `        {(() => {
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
        })()}`;
  const replace = `        {/* H3 fix (Finding #3): auto-seed handled by the one-shot useEffect
            above the return statement. The previous IIFE re-seeded on every
            render where teachingContext was null, which made the picker
            impossible to clear deliberately. */}`;
  if (!src.includes(find)) throw new Error("FIX#3-iife: anchor not found");
  src = src.replace(find, replace);
}

// ---------------------------------------------------------------------------
// FIX #3 (onChange): mark pickerInitialized=true when the teacher interacts.
// ---------------------------------------------------------------------------
{
  const find = `          onChange={(e) => {
            const v = e.target.value || null;
            setTeachingContext(v);
            setValidationOverride(false);
            // Fire-and-forget: persist to profiles.last_teaching_context.`;
  const replace = `          onChange={(e) => {
            const v = e.target.value || null;
            setTeachingContext(v);
            setValidationOverride(false);
            // H3 fix (Finding #3): mark picker initialized so the auto-seed
            // useEffect does not re-fire on the next render. This is what
            // makes a deliberate "Pick a context..." selection actually stick.
            setPickerInitialized(true);
            // Fire-and-forget: persist to profiles.last_teaching_context.`;
  if (!src.includes(find)) throw new Error("FIX#3-onChange: anchor not found");
  src = src.replace(find, replace);
}

// ---------------------------------------------------------------------------
// FIX #2 (countFor): define the missing helper inside generate() before its
// only use site.
// ---------------------------------------------------------------------------
{
  const find = `      const deliveredTotal = Number(data.total ?? 0);
      // F122 fix: when the teacher uses the "Customize per-level counts"
      // path, the per-level overrides in perLevelCustom mean the actual
      // request total is the SUM of countFor(l), not perLevel × levelCount.
      // The old math produced nonsense "Generated 12 of 6" toasts.
      const targetLevels = mode === "all" ? BLOOM_LEVELS : pickedLevels;
      const requestedTotal = targetLevels.reduce((sum, l) => sum + countFor(l), 0);`;
  const replace = `      const deliveredTotal = Number(data.total ?? 0);
      // F122 fix (completed; Finding #2): when the teacher uses the
      // "Customize per-level counts" path, the per-level overrides in
      // perLevelCustom mean the actual request total is the SUM of
      // per-level counts, not perLevel × levelCount. Earlier scaffolding
      // referenced a helper named \`countFor\` that was never defined, which
      // made the entire post-API block throw \`ReferenceError: countFor is
      // not defined\` on every successful generation. Define it here,
      // mirroring the totalQs formula in the pre-flight section below.
      const countFor = (l: BloomLevel): number =>
        mode === "custom" ? (perLevelCustom[l] ?? perLevel) : perLevel;
      const targetLevels = mode === "all" ? BLOOM_LEVELS : pickedLevels;
      const requestedTotal = targetLevels.reduce((sum, l) => sum + countFor(l), 0);`;
  if (!src.includes(find)) throw new Error("FIX#2: countFor anchor not found");
  src = src.replace(find, replace);
}

if (src === before) throw new Error("nothing changed!");
fs.writeFileSync(TARGET, src, "utf8");

const beforeLines = before.split("\n").length;
const afterLines = src.split("\n").length;
console.log(`OK. ${beforeLines} -> ${afterLines} lines (${afterLines - beforeLines >= 0 ? "+" : ""}${afterLines - beforeLines}).`);
