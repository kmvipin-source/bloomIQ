// scripts/apply-teaching-context-r11-block2-h2-upsc-slug.mjs
// Fix H2: validation rule 10 false-positives for UPSC teachers because
// EXAM_DEFAULTS["UPSC"].displayName = "UPSC Prelims" -> after lowercase+_ =
// "upsc_prelims" which never matches teachingContext "upsc".
//
// Solution: explicit displayName -> slug map instead of string-mangling.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  {
    tag: "explicit_examname_to_slug_map",
    file: "app/teacher/generate/page.tsx",
    description: "Replace string-mangling with explicit displayName->slug map",
    find: `    const detectedSlug: string | null = examDefault
      ? examDefault.displayName.toLowerCase().replace(/\\s+/g, "_")
      : null;`,
    replace: `    // Explicit displayName -> slug map. "UPSC Prelims" -> "upsc" etc.
    // Avoids the string-mangling bug where "UPSC Prelims" became "upsc_prelims"
    // and never matched the picker slug "upsc".
    const examDisplayToSlug: Record<string, string> = {
      CAT: "cat", JEE: "jee_main", NEET: "neet",
      GMAT: "gmat", GRE: "gre",
      "UPSC Prelims": "upsc",
      IELTS: "ielts", TOEFL: "ielts",
      CLAT: "clat", BITSAT: "bitsat", SAT: "sat",
      GATE: "gate", NDA: "nda", CUET: "cuet",
    };
    const detectedSlug: string | null = examDefault
      ? (examDisplayToSlug[examDefault.displayName] ?? null)
      : null;`,
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
