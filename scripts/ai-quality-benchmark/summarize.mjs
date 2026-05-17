#!/usr/bin/env node
// =============================================================================
// ai-quality-benchmark/summarize.mjs
//
// Reads the graded CSVs from a completed run and emits a pass/fail report
// with rates per dimension and per category. Compares against the 85%
// pass bar from the UAT pre-pilot conditions.
//
// Usage:
//   node scripts/ai-quality-benchmark/summarize.mjs <run-id>
//
// Output: out/<run-id>/SUMMARY.md (human-readable) +
//         out/<run-id>/SUMMARY.json (machine-readable for CI gates).
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runId = process.argv[2];
if (!runId) {
  console.error("Usage: node summarize.mjs <run-id>");
  process.exit(1);
}

const outDir = path.join(__dirname, "out", runId);
const qCsv = path.join(outDir, "grading.questions.csv");
const cCsv = path.join(outDir, "grading.coverage.csv");
for (const p of [qCsv, cCsv]) {
  if (!fs.existsSync(p)) {
    console.error(`[FATAL] ${p} not found. Run grade.mjs first, then fill the GRADE_ columns.`);
    process.exit(1);
  }
}

// Tiny CSV parser sufficient for our shape (quoted, "" escapes inner quote)
function parseCsv(text) {
  const rows = [];
  let cur = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { cur.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        cur.push(field); rows.push(cur); cur = []; field = "";
      } else field += c;
    }
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

const qRows = parseCsv(fs.readFileSync(qCsv, "utf8"));
const cRows = parseCsv(fs.readFileSync(cCsv, "utf8"));
const qHeader = qRows.shift();
const cHeader = cRows.shift();
const qi = (n) => qHeader.indexOf(n);
const ci = (n) => cHeader.indexOf(n);

const isYes = (v) => /^y$|^yes$|^true$|^1$/i.test(String(v ?? "").trim());

// --- Per-question dimensions ---
const dims = [
  "GRADE_bloom_ok",
  "GRADE_factually_correct",
  "GRADE_distractors_ok",
  "GRADE_answer_leak",     // graded as Y = "no leak" — the column name is "answer_leak" but Y=clean
  "GRADE_register_ok",
];
const accept = "GRADE_accept";
const totals = { graded: 0 };
for (const d of dims) totals[d] = 0;
totals[accept] = 0;

const byCat = new Map();

for (const r of qRows) {
  // skip rows where accept is blank (not yet graded)
  if (String(r[qi(accept)] || "").trim() === "") continue;
  totals.graded++;
  for (const d of dims) if (isYes(r[qi(d)])) totals[d]++;
  if (isYes(r[qi(accept)])) totals[accept]++;

  const cat = r[qi("category")] || "(none)";
  if (!byCat.has(cat)) byCat.set(cat, { graded: 0, accepted: 0 });
  const b = byCat.get(cat);
  b.graded++;
  if (isYes(r[qi(accept)])) b.accepted++;
}

// --- Per-prompt overall ---
const overall = { graded: 0, accepted: 0 };
for (const r of cRows) {
  const v = r[ci("GRADE_overall_accept")];
  if (String(v || "").trim() === "") continue;
  overall.graded++;
  if (isYes(v)) overall.accepted++;
}

// --- Coverage stats from coverage.csv (delivered vs requested) ---
let totReq = 0, totDel = 0, shortfall = 0;
for (const r of cRows) {
  const req = Number(r[ci("total_requested")] || 0);
  const del = Number(r[ci("total_delivered")] || 0);
  if (!Number.isNaN(req)) totReq += req;
  if (!Number.isNaN(del)) totDel += del;
  if (del < req) shortfall++;
}

const pct = (n, d) => d > 0 ? Math.round((n / d) * 100) : 0;
const passBar = 85;

const lines = [];
lines.push(`# ZCORIQ AI Quality Benchmark — run ${runId}`);
lines.push(``);
lines.push(`**Pass bar:** ${passBar}% across dimensions, ${passBar}% overall acceptance.`);
lines.push(``);
lines.push(`## Coverage`);
lines.push(``);
lines.push(`| Metric | Value |`);
lines.push(`|---|---|`);
lines.push(`| Total prompts (in coverage sheet) | ${cRows.length} |`);
lines.push(`| Total questions requested | ${totReq} |`);
lines.push(`| Total questions delivered | ${totDel} |`);
lines.push(`| Delivered / Requested | ${pct(totDel, totReq)}% |`);
lines.push(`| Prompts with shortfall (delivered < requested) | ${shortfall} |`);
lines.push(``);

lines.push(`## Per-question dimension acceptance (graded set: ${totals.graded})`);
lines.push(``);
lines.push(`| Dimension | Pass | Rate | vs ${passBar}% bar |`);
lines.push(`|---|---|---|---|`);
for (const d of dims) {
  const rate = pct(totals[d], totals.graded);
  lines.push(`| ${d.replace("GRADE_", "")} | ${totals[d]}/${totals.graded} | ${rate}% | ${rate >= passBar ? "✅" : "❌"} |`);
}
const overallRate = pct(totals[accept], totals.graded);
lines.push(`| **accept** | **${totals[accept]}/${totals.graded}** | **${overallRate}%** | ${overallRate >= passBar ? "✅" : "❌"} |`);
lines.push(``);

lines.push(`## Per-category acceptance`);
lines.push(``);
lines.push(`| Category | Accepted | Graded | Rate |`);
lines.push(`|---|---|---|---|`);
const cats = Array.from(byCat.entries()).sort((a, b) => a[0].localeCompare(b[0]));
for (const [cat, b] of cats) {
  lines.push(`| ${cat} | ${b.accepted} | ${b.graded} | ${pct(b.accepted, b.graded)}% |`);
}
lines.push(``);

if (overall.graded > 0) {
  const rate = pct(overall.accepted, overall.graded);
  lines.push(`## Prompt-level overall acceptance (from coverage sheet)`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Prompts overall-accepted | ${overall.accepted} / ${overall.graded} (${rate}%) |`);
  lines.push(``);
}

lines.push(`## Verdict`);
lines.push(``);
const minDim = Math.min(...dims.map((d) => pct(totals[d], totals.graded)));
const overallPass = overallRate >= passBar && minDim >= passBar;
lines.push(`**${overallPass ? "✅ PASS" : "❌ FAIL"}** — minimum dimension rate: ${minDim}%, overall acceptance: ${overallRate}%, bar: ${passBar}%.`);
lines.push(``);
if (!overallPass) {
  lines.push(`### Failed dimensions:`);
  for (const d of dims) {
    const r = pct(totals[d], totals.graded);
    if (r < passBar) lines.push(`  - ${d.replace("GRADE_", "")} — ${r}% (need ${passBar}%)`);
  }
  if (overallRate < passBar) lines.push(`  - overall accept — ${overallRate}% (need ${passBar}%)`);
}

const md = lines.join("\n");
fs.writeFileSync(path.join(outDir, "SUMMARY.md"), md);
fs.writeFileSync(path.join(outDir, "SUMMARY.json"), JSON.stringify({
  runId,
  passBar,
  totals,
  overall,
  byCat: Object.fromEntries(byCat),
  coverage: { totReq, totDel, shortfall },
  verdict: overallPass ? "PASS" : "FAIL",
  overallRate,
  minDimRate: minDim,
}, null, 2));

console.log(md);
console.log(`\nSUMMARY.md and SUMMARY.json written to ${outDir}`);
process.exit(overallPass ? 0 : 2);
