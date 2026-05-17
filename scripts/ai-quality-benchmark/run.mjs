#!/usr/bin/env node
// =============================================================================
// ai-quality-benchmark/run.mjs
//
// Sends every prompt from prompts.json through /api/generate against a running
// ZCORIQ instance (defaults to localhost:3000). Captures the raw question JSON
// and the response timing into ./out/<run-id>/<prompt-id>.json.
//
// Usage:
//   1. Run the dev server: `npm run dev` (or point at staging via BASE_URL=...)
//   2. Sign in as a teacher in the browser, open DevTools, paste the JWT from
//      sb-<project>-auth-token cookie into a file:
//        echo "<jwt>" > scripts/ai-quality-benchmark/.token
//   3. Run:
//        node scripts/ai-quality-benchmark/run.mjs
//   4. Outputs land in scripts/ai-quality-benchmark/out/<timestamp>/
//
// Notes:
//  - We deliberately go through the live API instead of calling Groq directly,
//    so we exercise the FULL pipeline: SYSTEM prompt + topic grounding + Bloom
//    verifier + dedup + answer-leak detection + acronym disambiguation.
//  - Each prompt runs in series with a 2s gap to avoid hitting the
//    per-user 5-burst/10-per-hour rate limit.
//  - Failures are captured to <prompt-id>.error.txt and the run continues.
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const TOKEN_PATH = path.join(__dirname, ".token");
const PROMPTS_PATH = path.join(__dirname, "prompts.json");

if (!fs.existsSync(TOKEN_PATH)) {
  console.error(`[FATAL] ${TOKEN_PATH} not found.`);
  console.error("Create it by copying your teacher JWT from the sb-* auth cookie:");
  console.error('  echo "<your-jwt>" > scripts/ai-quality-benchmark/.token');
  process.exit(1);
}
const TOKEN = fs.readFileSync(TOKEN_PATH, "utf8").trim();

const { prompts, version } = JSON.parse(fs.readFileSync(PROMPTS_PATH, "utf8"));
console.log(`Loaded ${prompts.length} prompts from ${PROMPTS_PATH} (version ${version}).`);
console.log(`Target: ${BASE_URL}`);

const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = path.join(__dirname, "out", runId);
fs.mkdirSync(outDir, { recursive: true });
console.log(`Output: ${outDir}\n`);

let pass = 0, fail = 0, skipped = 0;
const startWall = Date.now();

for (let i = 0; i < prompts.length; i++) {
  const p = prompts[i];
  const tag = `[${i + 1}/${prompts.length}] ${p.id}`;

  // Build request body matching /api/generate expectations.
  const body = {
    source: p.source || "topic_only",
    topic: p.topic,
    levels: p.bloom_levels,
    perLevel: p.per_level,
    numericalPercent: p.numerical_percent ?? 0,
    audience_level: p.audience_level ?? null,
    sub_topics: p.sub_topics ?? [],
    additional_focus: p.additional_focus ?? "",
    teaching_context: p.teaching_context ?? null,
  };
  if (p.source === "topic_syllabus") {
    body.className = p.className || "";
    body.syllabus = p.syllabus || "";
  }
  if (p.source === "notes") {
    body.content = p.content || "";
  }

  const t0 = Date.now();
  let res, text;
  try {
    res = await fetch(`${BASE_URL}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(body),
    });
    text = await res.text();
  } catch (e) {
    console.log(`${tag}  NETWORK ERR  ${e.message}`);
    fs.writeFileSync(path.join(outDir, `${p.id}.error.txt`), `network: ${e.message}\n`);
    fail++;
    continue;
  }
  const elapsedMs = Date.now() - t0;

  let json;
  try { json = JSON.parse(text); } catch { json = null; }

  const out = {
    prompt: p,
    request_body: body,
    response_status: res.status,
    response_elapsed_ms: elapsedMs,
    response_body: json ?? text,
  };
  const fname = path.join(outDir, `${p.id}.json`);
  fs.writeFileSync(fname, JSON.stringify(out, null, 2));

  if (res.ok && json?.ok) {
    const count = (json?.summary ? Object.values(json.summary).reduce((a, b) => a + Number(b), 0) : 0);
    console.log(`${tag}  HTTP ${res.status}  ${elapsedMs}ms  ${count} questions`);
    pass++;
  } else if (res.status === 429) {
    console.log(`${tag}  RATE LIMITED — pausing 30s and retrying...`);
    await sleep(30_000);
    i--; // retry
    skipped++;
    continue;
  } else {
    console.log(`${tag}  HTTP ${res.status}  ${elapsedMs}ms  FAILED — ${json?.error || text.slice(0, 120)}`);
    fail++;
  }

  // 2s pause between prompts (5-burst, 10/hr rate limit)
  if (i < prompts.length - 1) await sleep(2_000);
}

const totalMin = ((Date.now() - startWall) / 60_000).toFixed(1);
console.log(`\n========================================`);
console.log(`Run ${runId} complete in ${totalMin} min`);
console.log(`  Pass:    ${pass}`);
console.log(`  Fail:    ${fail}`);
console.log(`  Retried: ${skipped}`);
console.log(`========================================\n`);
console.log(`Next step: run grade.mjs to generate the grading sheet:`);
console.log(`  node scripts/ai-quality-benchmark/grade.mjs ${runId}`);
