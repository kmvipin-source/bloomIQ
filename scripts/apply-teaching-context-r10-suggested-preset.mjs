// scripts/apply-teaching-context-r10-suggested-preset.mjs
// =============================================================================
// Wire the teaching-context picker on /teacher/quizzes/new to drive the
// suggested marking-scheme preset. Picking "JEE Main" -> suggests JEE_MAIN
// scoring. Picking "NEET" -> NEET. Etc.
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  {
    tag: "context_to_preset",
    file: "app/teacher/quizzes/new/page.tsx",
    description: "Re-suggest marking-scheme preset when teachingContext changes",
    find: `  // Load saved last_teaching_context. Fire-and-forget — failure leaves saved=null.
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
    replace: `  // Load saved last_teaching_context. Fire-and-forget — failure leaves saved=null.
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
  }, []);

  // When the teacher picks a teaching context, re-derive the suggested
  // marking-scheme preset. The picker is the most precise signal we have
  // about the test's intent (more reliable than teacher's own exam_goal
  // since a teacher can run different contexts in the same week).
  useEffect(() => {
    if (!teachingContext) return;
    setSuggestedPreset(suggestPresetForGoal(teachingContext));
  }, [teachingContext]);`,
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
console.log(`\n=== r10 (context -> suggested preset) summary ===`);
console.log(`Applied: ${applied.length}  ->  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
