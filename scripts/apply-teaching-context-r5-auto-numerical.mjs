// scripts/apply-teaching-context-r5-auto-numerical.mjs (revised)
// =============================================================================
// Auto-set Numerical-% slider from the teaching context (with teacher override).
// Now uses the full expanded EXAM_DEFAULTS table (CAT/JEE/NEET/GMAT/GRE/UPSC/
// IELTS/TOEFL/CLAT/BITSAT/SAT/GATE/NDA/CUET).
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  {
    tag: "auto_numerical_effect",
    file: "app/teacher/generate/page.tsx",
    description: "Auto-set Numerical-% from teachingContext via expanded EXAM_DEFAULTS",
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

  // Auto-set Numerical-% when the teacher picks a competitive-exam context.
  // Honors numericalManuallySet so it never clobbers a teacher-set value.
  // Mapping is comprehensive vs the expanded EXAM_DEFAULTS table.
  useEffect(() => {
    if (!teachingContext || numericalManuallySet) return;
    const slugToExamKey: Record<string, string> = {
      jee_main: "JEE", jee_advanced: "JEE",
      neet: "NEET",
      cat: "CAT",
      gmat: "GMAT", gre: "GRE",
      upsc: "UPSC",
      ielts: "IELTS",
      clat: "CLAT",
      bitsat: "BITSAT",
      sat: "SAT",
      gate: "GATE",
      nda: "NDA",
      cuet: "CUET",
    };
    const examKey = slugToExamKey[teachingContext];
    if (!examKey) return;
    const def = EXAM_DEFAULTS[examKey];
    if (!def) return;
    setNumericalPercent(def.defaultNumericalPercent);
  }, [teachingContext, numericalManuallySet]);`,
  },
];

const applied = [];
const skipped = [];
for (const fx of FIXES) {
  const abs = path.join(ROOT, fx.file);
  if (!fs.existsSync(abs)) { skipped.push({ tag: fx.tag, reason: `file not found` }); continue; }
  const before = fs.readFileSync(abs, "utf8");
  if (!before.includes(fx.find)) { skipped.push({ tag: fx.tag, reason: "find pattern not present" }); continue; }
  if (before.indexOf(fx.find) !== before.lastIndexOf(fx.find)) { skipped.push({ tag: fx.tag, reason: "non-unique" }); continue; }
  fs.writeFileSync(abs, before.replace(fx.find, fx.replace), "utf8");
  applied.push(fx.tag);
}
console.log(`\n=== r5 (auto-numerical, full exam table) summary ===`);
console.log(`Applied: ${applied.length}  ->  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
