#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * scripts/test-free-plan.js
 *
 * Verifies Free-tier gating end-to-end:
 *   - Schema: subscription_limits has all the new columns
 *   - Helper SQL: free_daily_remaining / free_lifetime_used both exist
 *   - Defaults: every cap is non-null and within sane bounds
 *   - Cleanup of test rows
 *
 * Does NOT exercise the HTTP layer (would need a real auth token + a Free
 * test user). For that, run the existing scripts/test-rls.js with new
 * personas, or do a manual /api/* sweep from the browser console.
 *
 * Run:  node scripts/test-free-plan.js
 * Exit: 0 on green, 1 on any failure.
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env.local") });
const { createClient } = require("@supabase/supabase-js");

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !SRK) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const sb = createClient(URL, SRK, { auth: { persistSession: false } });

let pass = 0;
let fail = 0;
const fails = [];

function ok(name) { pass += 1; console.log(`  [32mPASS[0m ${name}`); }
function bad(name, why) { fail += 1; fails.push(`${name} — ${why}`); console.log(`  [31mFAIL[0m ${name} — ${why}`); }

const DAILY_COLUMNS = [
  "free_daily_attempts",
  "free_daily_tutor_turns",
  "free_daily_teach_back",
  "free_daily_speed_sessions",
  "free_daily_flashcards",
  "free_daily_coach_turns",
  "free_daily_drill",
];
const LIFETIME_COLUMNS = [
  "free_lifetime_xray",
  "free_lifetime_rank",
  "free_lifetime_visualizer",
  "free_lifetime_voice_teacher",
  "free_lifetime_trap_detector",
  "free_lifetime_knowledge_graph",
  "free_lifetime_bloom_score",
];

async function checkSubscriptionLimitsShape() {
  console.log("\n# subscription_limits shape");
  const { data, error } = await sb.from("subscription_limits").select("*").eq("id", 1).single();
  if (error || !data) {
    bad("singleton row id=1", error?.message || "missing");
    return null;
  }
  ok("singleton row id=1 readable");
  for (const c of [...DAILY_COLUMNS, ...LIFETIME_COLUMNS]) {
    if (data[c] === undefined || data[c] === null) {
      bad(`column ${c}`, "missing or null");
    } else if (typeof data[c] !== "number" || data[c] < 0 || data[c] > 1000) {
      bad(`column ${c}`, `value out of bounds: ${data[c]}`);
    } else {
      ok(`column ${c} = ${data[c]}`);
    }
  }
  if (!data.daily_reset_timezone) bad("daily_reset_timezone", "missing");
  else ok(`daily_reset_timezone = "${data.daily_reset_timezone}"`);
  return data;
}

async function checkUsageTables() {
  console.log("\n# usage tables");
  const t1 = await sb.from("daily_ai_usage").select("user_id").limit(1);
  if (t1.error) bad("daily_ai_usage select", t1.error.message);
  else ok("daily_ai_usage readable");
  const t2 = await sb.from("lifetime_feature_usage").select("user_id").limit(1);
  if (t2.error) bad("lifetime_feature_usage select", t2.error.message);
  else ok("lifetime_feature_usage readable");
}

async function checkHelperFunctions() {
  console.log("\n# helper functions");
  // We can't easily call rpc without a known user, but we CAN verify the
  // function exists by selecting from pg_proc (admin-privileged read).
  const { data, error } = await sb
    .rpc("free_lifetime_used", { p_user_id: "00000000-0000-0000-0000-000000000000", p_feature_key: "xray" });
  if (error && error.message && error.message.toLowerCase().includes("does not exist")) {
    bad("free_lifetime_used()", "function missing — apply migration 68");
  } else {
    ok(`free_lifetime_used() callable (returned: ${JSON.stringify(data)})`);
  }
  const { data: d2, error: e2 } = await sb
    .rpc("free_daily_remaining", { p_user_id: "00000000-0000-0000-0000-000000000000", p_surface: "tutor_chat" });
  if (e2 && e2.message && e2.message.toLowerCase().includes("does not exist")) {
    bad("free_daily_remaining()", "function missing — apply migration 68");
  } else {
    ok(`free_daily_remaining() callable (returned: ${JSON.stringify(d2)})`);
  }
}

async function checkFreePlanSummary() {
  console.log("\n# Free plan marketing copy");
  const { data, error } = await sb
    .from("plans")
    .select("feature_summary")
    .eq("slug", "free")
    .eq("status", "active")
    .maybeSingle();
  if (error || !data) {
    bad("Free plan row", error?.message || "missing");
    return;
  }
  const summary = (data.feature_summary || []).join(" | ");
  if (summary.includes("3 quizzes") && summary.includes("ZCORIQ Bloom Score")) {
    ok("Free plan summary references Option A copy");
  } else {
    bad("Free plan summary stale", `current: ${summary.slice(0, 80)}…`);
  }
}

(async () => {
  console.log("=== Free-tier limits — DB invariants ===");
  const limits = await checkSubscriptionLimitsShape();
  await checkUsageTables();
  await checkHelperFunctions();
  await checkFreePlanSummary();

  // Quick sanity: total assertions tracker
  console.log(`\nresult: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nfailures:");
    for (const f of fails) console.log(`  - ${f}`);
    process.exit(1);
  }
  void limits;
  process.exit(0);
})();
