// Round-5 follow-up: close the remaining errors that strict-TS surfaced
// after the Round-5 main patch. None of these are new bugs in the audit
// sense — they were always there, hidden by strict:false +
// ignoreBuildErrors:true. Now that both invariants are permanent, the
// tree has to be clean.
//
// Findings:
//   #32 CRITICAL api/student/adaptive-practice: token used, not destructured
//   #33 CRITICAL api/student/quick-test:        same pattern
//   #34 MEDIUM   recharts Formatter signature drift in school/reports and
//                student/progress pages (the user's own next.config.ts
//                comment called these out pre-existing). Apply narrow
//                `as any` casts at the call sites so strict stays on.
//   #35 MEDIUM   regression I introduced in Round 1: countFor type mismatch
//                where BLOOM_LEVELS widens to `readonly string[]`.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function patchNorm(file, find, replace, tag) {
  const abs = path.join(ROOT, file);
  const raw = fs.readFileSync(abs, "utf8");
  const crlf = raw.includes("\r\n");
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.includes(find)) throw new Error(`${tag}: anchor not found in ${file}`);
  if (text.indexOf(find) !== text.lastIndexOf(find)) throw new Error(`${tag}: anchor non-unique in ${file}`);
  const next = text.replace(find, replace);
  fs.writeFileSync(abs, crlf ? next.replace(/\n/g, "\r\n") : next, "utf8");
  console.log(`  ${tag}: applied`);
}

// ---------------------------------------------------------------------------
// #32 / #33: add token to destructure in two more routes.
// ---------------------------------------------------------------------------
patchNorm(
  "app/api/student/adaptive-practice/route.ts",
  `    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;`,
  `    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    // Finding #32 fix: token used by findMisconceptionDistractors downstream
    // but missing from the destructure (same shape as #29/#30).
    const { user, sb, token } = auth;`,
  "FIX#32 adaptive-practice token",
);

patchNorm(
  "app/api/student/quick-test/route.ts",
  `    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;`,
  `    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    // Finding #33 fix: same shape as #29/#30/#32.
    const { user, sb, token } = auth;`,
  "FIX#33 quick-test token",
);

// ---------------------------------------------------------------------------
// #35: my Round 1 countFor regression. BLOOM_LEVELS is readonly so
// targetLevels in "all" mode widens to readonly string[]. The reduce's
// element type clashes with countFor's BloomLevel parameter. Narrow at
// the call site with a slice() + assertion.
// ---------------------------------------------------------------------------
patchNorm(
  "app/teacher/generate/page.tsx",
  `      const countFor = (l: BloomLevel): number =>
        mode === "custom" ? (perLevelCustom[l] ?? perLevel) : perLevel;
      const targetLevels = mode === "all" ? BLOOM_LEVELS : pickedLevels;
      const requestedTotal = targetLevels.reduce((sum, l) => sum + countFor(l), 0);`,
  `      const countFor = (l: BloomLevel): number =>
        mode === "custom" ? (perLevelCustom[l] ?? perLevel) : perLevel;
      // Finding #35 fix (my own Round 1 regression): BLOOM_LEVELS is
      // declared readonly so the union with pickedLevels (BloomLevel[])
      // widens to a readonly string[] under strict TS. Slice + cast to
      // BloomLevel[] before reducing.
      const targetLevels: BloomLevel[] = mode === "all" ? (BLOOM_LEVELS as readonly BloomLevel[]).slice() : pickedLevels;
      const requestedTotal = targetLevels.reduce((sum: number, l: BloomLevel) => sum + countFor(l), 0);`,
  "FIX#35 countFor type",
);

// (Finding #34 recharts handled inline via bash since each call site is
// unique enough that the cleanest approach is a per-site cast.)

console.log("Round 5b base fixes applied OK.");
