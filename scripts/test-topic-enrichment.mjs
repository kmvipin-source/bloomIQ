// Tests for lib/topicEnrichment — co-equal sub-area model (2026-05-13 late).
import { applyAdditionalFocus, smartTopicPlaceholder, validateFocusForTopic } from "../lib/topicEnrichment.ts";

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; process.stdout.write("  PASS " + name + "\n"); }
  else { fail++; fails.push({name, detail}); process.stdout.write("  FAIL " + name + (detail ? " - " + detail : "") + "\n"); }
}

console.log("\napplyAdditionalFocus — empty inputs\n");
check("empty base returns empty", applyAdditionalFocus("", "", []) === "");
check("base only", applyAdditionalFocus("Photosynthesis", "", []) === "Photosynthesis");

console.log("\napplyAdditionalFocus — chips only\n");
const r1 = applyAdditionalFocus("Mainframe", "", ["JCL"]);
check("single chip → 'Focus the questions on this sub-area'",
  r1.includes("Focus the questions on this sub-area WITHIN THE MAIN TOPIC: JCL"), r1);
check("single chip → 'WITHIN THE MAIN TOPIC'", r1.includes("WITHIN THE MAIN TOPIC"), r1);

const r2 = applyAdditionalFocus("Mainframe", "", ["JCL", "COBOL", "CICS"]);
check("multi-chip → 'distribute EQUALLY across these 3 sub-areas'",
  r2.includes("distribute") && r2.includes("EQUALLY") && r2.includes("3 sub-areas"), r2);
check("multi-chip → all chips named", r2.includes("JCL") && r2.includes("COBOL") && r2.includes("CICS"), r2);
check("multi-chip → forbids clustering", r2.includes("Do NOT cluster"), r2);

console.log("\napplyAdditionalFocus — textbox only (treated as single sub-area)\n");
const r3 = applyAdditionalFocus("ISO 8583", "POS Entry Mode DE22", []);
check("textbox-only → 'Focus the questions on this sub-area'",
  r3.includes("Focus the questions on this sub-area"), r3);
check("textbox-only → quoted angle is the sub-area",
  r3.includes('"POS Entry Mode DE22"'), r3);

console.log("\napplyAdditionalFocus — BOTH (textbox is CO-EQUAL sub-area)\n");
const r4 = applyAdditionalFocus("Mainframe", "batch processing", ["JCL", "COBOL", "CICS"]);
check("BOTH multi → bucket count is N+1 (4 sub-areas)",
  r4.includes("4 sub-areas"), r4);
check("BOTH multi → 'distribute EQUALLY' wording",
  r4.includes("distribute") && r4.includes("EQUALLY"), r4);
check("BOTH multi → all chips named",
  r4.includes("JCL") && r4.includes("COBOL") && r4.includes("CICS"), r4);
check("BOTH multi → textbox quoted as a sub-area",
  r4.includes('"batch processing"'), r4);
check("BOTH multi → NOT the old 'EXACTLY ONE' wording",
  !r4.includes("EXACTLY ONE") && !r4.includes("standalone question"), r4);
check("BOTH multi → 'Each sub-area must get at least one question'",
  r4.includes("Each sub-area must get at least one question"), r4);

const r5 = applyAdditionalFocus("Mainframe", "RACF security", ["JCL"]);
check("BOTH single chip → bucket count is 2 sub-areas",
  r5.includes("2 sub-areas"), r5);
check("BOTH single chip → both areas listed (chip + textbox)",
  r5.includes("JCL") && r5.includes('"RACF security"'), r5);

console.log("\nScale check — at 120 questions, 4 buckets get ~30 each (not 1 + 119)\n");
// The prompt itself doesn't say "30" — that's per-Bloom-batch math the LLM
// handles. We just verify the prompt structure is "distribute across N+1
// equal buckets" and that count doesn't degrade.
const r6 = applyAdditionalFocus("Mainframe", "batch", ["JCL", "COBOL", "CICS"]);
check("scale → still 'N+1 sub-areas' structure regardless of question count",
  r6.includes("4 sub-areas") && r6.includes("distribute"), r6);
check("scale → no '+1 slot' / 'exactly one' degenerate wording",
  !r6.includes("EXACTLY ONE") && !r6.includes("standalone") && !r6.includes("+1"), r6);

console.log("\nvalidateFocusForTopic\n");
check("Mainframe + batch processing → related",
  validateFocusForTopic("Mainframe", "batch processing", []).ok === true);
const off = validateFocusForTopic("Mainframe", "Krebs cycle", []);
check("Mainframe + Krebs cycle → UNRELATED",
  off.ok === false, JSON.stringify(off));
check("Photosynthesis + Calvin cycle → related",
  validateFocusForTopic("Photosynthesis", "Calvin cycle", []).ok === true);
check("empty focus → ok",
  validateFocusForTopic("Mainframe", "", []).ok === true);

console.log("\nsmartTopicPlaceholder\n");
for (const [t, must] of [
  ["Mainframe", "JCL"],
  ["ISO 8583", "data elements"],
  ["COBOL", "PERFORM"],
]) {
  check(`"${t}" → "${must}"`, smartTopicPlaceholder(t).includes(must));
}
check("unknown → generic", smartTopicPlaceholder("random thoughts").startsWith("e.g."));

console.log("\nDone: " + pass + " passed, " + fail + " failed.");
if (fail > 0) {
  console.error("\nFAILED TESTS:");
  for (const f of fails) console.error(" - " + f.name + (f.detail ? " - " + f.detail : ""));
  process.exit(1);
}
process.exit(0);
