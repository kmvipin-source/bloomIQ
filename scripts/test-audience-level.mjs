// Smoke tests for lib/audienceLevel.
// 2026-05-13 evening: chip is fully optional, resolve returns null when not picked.
import {
  parseAudienceLevel,
  audiencePromptFragment,
  resolveAudienceLevel,
} from "../lib/audienceLevel.ts";

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; process.stdout.write("  PASS " + name + "\n"); }
  else { fail++; fails.push({name, detail}); process.stdout.write("  FAIL " + name + (detail ? " - " + detail : "") + "\n"); }
}

console.log("\nparseAudienceLevel\n");
for (const v of ["beginner", "BEGINNER", "  Practitioner  ", "expert"]) {
  check("parses " + JSON.stringify(v), parseAudienceLevel(v) === v.trim().toLowerCase());
}
for (const v of ["intermediate", "", null, undefined, 0, {}, "advanced"]) {
  check("rejects " + JSON.stringify(v), parseAudienceLevel(v) === null);
}

console.log("\naudiencePromptFragment\n");
for (const l of ["beginner", "practitioner", "expert"]) {
  const f = audiencePromptFragment(l);
  check(l + " fragment non-empty", f.length > 20);
  check(l + " fragment mentions level", f.toUpperCase().includes(l.toUpperCase()));
}

console.log("\nresolveAudienceLevel — explicit wins, otherwise null + empty fragment\n");
const r1 = resolveAudienceLevel("expert", null, null);
check("explicit 'expert' → level=expert, fragment non-empty",
  r1.level === "expert" && r1.wasExplicit === true && r1.promptFragment.length > 0);

const r2 = resolveAudienceLevel(undefined, null, null);
check("missing → level=null, fragment EMPTY (no audience instruction sent)",
  r2.level === null && r2.wasExplicit === false && r2.promptFragment === "");

const r3 = resolveAudienceLevel("intermediate", null, null);
check("garbage input → level=null, fragment EMPTY",
  r3.level === null && r3.wasExplicit === false && r3.promptFragment === "");

const r4 = resolveAudienceLevel(null, null, null);
check("null input → level=null, fragment EMPTY",
  r4.level === null && r4.wasExplicit === false && r4.promptFragment === "");

const r5 = resolveAudienceLevel("BEGINNER", null, null);
check("case-insensitive explicit 'BEGINNER' → level=beginner",
  r5.level === "beginner" && r5.wasExplicit === true);

console.log("\nDone: " + pass + " passed, " + fail + " failed.");
if (fail > 0) {
  console.error("\nFAILED TESTS:");
  for (const f of fails) console.error(" - " + f.name + (f.detail ? " - " + f.detail : ""));
  process.exit(1);
}
process.exit(0);
