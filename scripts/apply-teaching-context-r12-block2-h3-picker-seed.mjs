// Fix H3: picker auto-seed IIFE fires whenever teachingContext === null.
// Replace with one-shot useEffect gated by pickerInitialized flag.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  {
    tag: "add_pickerInitialized_state_generate",
    file: "app/teacher/generate/page.tsx",
    description: "Track picker seed completion to allow deliberate clear",
    find: '  const [savedLastContext, setSavedLastContext] = useState<string | null>(null);',
    replace: '  const [savedLastContext, setSavedLastContext] = useState<string | null>(null);\n  const [pickerInitialized, setPickerInitialized] = useState<boolean>(false);',
  },
  {
    tag: "replace_iife_with_effect_generate",
    file: "app/teacher/generate/page.tsx",
    description: "Replace setState-in-render IIFE with comment placeholder",
    find: `        {(() => {
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
        })()}`,
    replace: '        {/* Auto-seed handled by useEffect near top of component (no setState-in-render). */}',
  },
  {
    tag: "insert_seed_effect_generate",
    file: "app/teacher/generate/page.tsx",
    description: "useEffect that seeds picker once",
    find: `    return () => { cancelled = true; };
  }, []);

  // Auto-set Numerical-% when the teacher picks a competitive-exam context.`,
    replace: `    return () => { cancelled = true; };
  }, []);

  // One-shot picker seed (replaces IIFE-in-render anti-pattern).
  useEffect(() => {
    if (pickerInitialized) return;
    const cls = teacherClasses.find((c) => c.id === targetClassId) || null;
    const seed = defaultTeachingContext({ savedLastContext, classGrade: cls?.grade ?? null });
    if (seed) {
      setTeachingContext(seed);
      setPickerInitialized(true);
    } else if (savedLastContext !== null || cls !== null) {
      setPickerInitialized(true);
    }
  }, [pickerInitialized, savedLastContext, teacherClasses, targetClassId]);

  // Auto-set Numerical-% when the teacher picks a competitive-exam context.`,
  },
  {
    tag: "add_pickerInitialized_state_quizzes",
    file: "app/teacher/quizzes/new/page.tsx",
    description: "Track picker initialization on Build/Assign",
    find: '  const [savedLastContext, setSavedLastContext] = useState<string | null>(null);',
    replace: '  const [savedLastContext, setSavedLastContext] = useState<string | null>(null);\n  const [pickerInitialized, setPickerInitialized] = useState<boolean>(false);',
  },
  {
    tag: "replace_iife_with_effect_quizzes",
    file: "app/teacher/quizzes/new/page.tsx",
    description: "Replace IIFE on Build/Assign",
    find: `            {(() => {
              // Seed picker once: prefer saved last-context, then class.grade-derived.
              if (teachingContext === null) {
                const cls = classes.find((c) => c.id === targetClassId) || null;
                const seed = defaultTeachingContext({ savedLastContext, classGrade: cls?.grade ?? null });
                if (seed) setTimeout(() => setTeachingContext(seed), 0);
              }
              return null;
            })()}`,
    replace: '            {/* Auto-seed handled by useEffect near top of component. */}',
  },
  {
    tag: "insert_seed_effect_quizzes",
    file: "app/teacher/quizzes/new/page.tsx",
    description: "useEffect seed on Build/Assign",
    find: `  // When the teacher picks a teaching context, re-derive the suggested
  // marking-scheme preset.`,
    replace: `  // One-shot picker seed (replaces IIFE-in-render).
  useEffect(() => {
    if (pickerInitialized) return;
    const cls = classes.find((c) => c.id === targetClassId) || null;
    const seed = defaultTeachingContext({ savedLastContext, classGrade: cls?.grade ?? null });
    if (seed) {
      setTeachingContext(seed);
      setPickerInitialized(true);
    } else if (savedLastContext !== null || cls !== null) {
      setPickerInitialized(true);
    }
  }, [pickerInitialized, savedLastContext, classes, targetClassId]);

  // When the teacher picks a teaching context, re-derive the suggested
  // marking-scheme preset.`,
  },
];

const applied = [], skipped = [];
for (const fx of FIXES) {
  const abs = path.join(ROOT, fx.file);
  if (!fs.existsSync(abs)) { skipped.push({ tag: fx.tag, reason: "no file" }); continue; }
  const before = fs.readFileSync(abs, "utf8");
  if (!before.includes(fx.find)) { skipped.push({ tag: fx.tag, reason: "find not present" }); continue; }
  if (before.indexOf(fx.find) !== before.lastIndexOf(fx.find)) { skipped.push({ tag: fx.tag, reason: "non-unique" }); continue; }
  fs.writeFileSync(abs, before.replace(fx.find, fx.replace), "utf8");
  applied.push(fx.tag);
}
console.log(`Applied: ${applied.length}  ->  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
