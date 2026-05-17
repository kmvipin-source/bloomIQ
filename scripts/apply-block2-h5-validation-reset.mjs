// Fix H5: validationOverride doesn't reset when validation issues change.
// Add useEffect that watches validation.issues code-set and clears override
// whenever the set changes -> teacher re-acknowledges new mismatches.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  {
    tag: "validation_override_reset_generate",
    file: "app/teacher/generate/page.tsx",
    description: "Reset validationOverride when validation issue codes change",
    find: "  // Auto-set Numerical-% when the teacher picks a competitive-exam context.",
    replace: "  // H5 fix: clear override whenever the set of validation issues changes,\n  // so a teacher who acknowledged an old block cannot accidentally skip a NEW\n  // block that appeared after a field change.\n  useEffect(() => {\n    setValidationOverride(false);\n  }, [validation.issues.map((i) => i.code).join(\",\")]);\n\n  // Auto-set Numerical-% when the teacher picks a competitive-exam context.",
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
console.log("Applied: " + applied.length + " -> " + applied.join(", "));
console.log("Skipped: " + skipped.length);
for (const s of skipped) console.log("  - " + s.tag + ": " + s.reason);
