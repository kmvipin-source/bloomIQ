#!/usr/bin/env node
// =============================================================================
// ai-quality-benchmark/grade.mjs
//
// Reads a completed run's output and produces:
//   1. A CSV grading sheet (questions.csv) — one row per generated question,
//      with empty columns for a subject-matter educator to fill in:
//        bloom_ok | factually_correct | distractors_ok | answer_leak |
//        register_ok | accept
//   2. A coverage sheet (coverage.csv) — one row per prompt summarising
//      delivered-vs-requested counts + verifier disputes + the prompt's
//      "verify" hint.
//
// Usage:
//   node scripts/ai-quality-benchmark/grade.mjs <run-id>
//
// Output lives alongside the run at out/<run-id>/grading.questions.csv
// and out/<run-id>/grading.coverage.csv.
//
// Open the CSV in Excel / Numbers / LibreOffice, fill in the columns, save,
// then run summarize.mjs to compute pass rates.
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runId = process.argv[2];
if (!runId) {
  console.error("Usage: node grade.mjs <run-id>");
  console.error("Example run-ids:");
  for (const d of fs.readdirSync(path.join(__dirname, "out"))) {
    console.error(`  ${d}`);
  }
  process.exit(1);
}

const outDir = path.join(__dirname, "out", runId);
if (!fs.existsSync(outDir)) {
  console.error(`[FATAL] ${outDir} not found.`);
  process.exit(1);
}

const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".json"));
console.log(`Found ${files.length} prompt result files in ${outDir}`);

const csvEscape = (s) => {
  if (s == null) return "";
  const str = String(s).replace(/"/g, '""');
  return `"${str}"`;
};

// --- Questions grading sheet ---
const qRows = [
  [
    "prompt_id", "category", "topic", "bloom_requested", "question_index",
    "stem", "option_A", "option_B", "option_C", "option_D",
    "correct_index", "explanation", "verifier_actual_bloom", "verifier_disputed",
    "GRADE_bloom_ok", "GRADE_factually_correct", "GRADE_distractors_ok",
    "GRADE_answer_leak", "GRADE_register_ok", "GRADE_accept", "GRADE_notes",
  ],
];

// --- Coverage summary sheet ---
const cRows = [
  [
    "prompt_id", "category", "topic", "exam_goal", "teaching_context",
    "bloom_levels_requested", "per_level_requested", "total_requested",
    "total_delivered", "elapsed_ms", "http_status", "verify_hint",
    "GRADE_overall_accept", "GRADE_overall_notes",
  ],
];

for (const f of files) {
  const data = JSON.parse(fs.readFileSync(path.join(outDir, f), "utf8"));
  const { prompt, response_status, response_elapsed_ms, response_body } = data;
  const summary = response_body?.summary || {};
  const totalDelivered = Object.values(summary).reduce((a, b) => a + Number(b), 0);
  const totalRequested = (prompt.bloom_levels || []).length * (prompt.per_level || 0);
  const questions = response_body?.questions || response_body?.rows || [];

  cRows.push([
    prompt.id,
    prompt.category,
    prompt.topic,
    prompt.exam_goal ?? "",
    prompt.teaching_context ?? "",
    (prompt.bloom_levels || []).join("|"),
    prompt.per_level,
    totalRequested,
    totalDelivered,
    response_elapsed_ms,
    response_status,
    prompt.verify ?? "",
    "",  // GRADE_overall_accept
    "",  // GRADE_overall_notes
  ].map(csvEscape).join(","));

  questions.forEach((q, qi) => {
    const opts = q.options || [];
    qRows.push([
      prompt.id,
      prompt.category,
      prompt.topic,
      q.bloom_level || "(unset)",
      qi + 1,
      q.stem || "",
      opts[0] || "", opts[1] || "", opts[2] || "", opts[3] || "",
      q.correct_index ?? "",
      q.explanation || "",
      q.quality?.actual_bloom ?? "",
      q.quality?.disputed ?? "",
      "",  // bloom_ok
      "",  // factually_correct
      "",  // distractors_ok
      "",  // answer_leak
      "",  // register_ok
      "",  // accept (Y/N)
      "",  // notes
    ].map(csvEscape).join(","));
  });
}

const qPath = path.join(outDir, "grading.questions.csv");
const cPath = path.join(outDir, "grading.coverage.csv");
fs.writeFileSync(qPath, qRows.map((r) => Array.isArray(r) ? r.map(csvEscape).join(",") : r).join("\n"));
// (note: the header row was already passed as an Array; subsequent rows are pre-joined strings.)
// Simpler rewrite:
fs.writeFileSync(qPath, [qRows[0].map(csvEscape).join(",")].concat(qRows.slice(1)).join("\n"));
fs.writeFileSync(cPath, [cRows[0].map(csvEscape).join(",")].concat(cRows.slice(1)).join("\n"));

console.log(`\nGrading sheets written:`);
console.log(`  ${qPath}`);
console.log(`  ${cPath}`);
console.log(`\nNext steps:`);
console.log(`  1. Open both CSVs in Excel / LibreOffice / Numbers.`);
console.log(`  2. Have a subject-matter educator fill the GRADE_ columns:`);
console.log(`       bloom_ok          — Y if Bloom level matches the question's cognitive demand`);
console.log(`       factually_correct — Y if the stem + options + explanation are factually correct`);
console.log(`       distractors_ok    — Y if the wrong options are plausible (not obviously wrong)`);
console.log(`       answer_leak       — Y if the correct option's key terms are NOT in the stem (leakage = N)`);
console.log(`       register_ok       — Y if the language/difficulty matches the audience`);
console.log(`       accept            — Y if a teacher would use this question without modification`);
console.log(`  3. Save the CSVs (keep .csv format).`);
console.log(`  4. Run: node scripts/ai-quality-benchmark/summarize.mjs ${runId}`);
