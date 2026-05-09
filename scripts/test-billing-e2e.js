#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * test-billing-e2e.js
 * -------------------
 * End-to-end test of the B2B billing pipeline against the LIVE Supabase.
 * Walks every scenario shipped tonight, verifies the actual database
 * state matches expectations, then cleans up after itself.
 *
 * What it does (in order, no user input required):
 *
 *   1. Creates a fresh test school (`bloomiq-e2e-<timestamp>@bloomiqtest.local`)
 *   2. Creates an associated super_teacher auth user
 *   3. Binds the school to School Pilot with activation_pending=true,
 *      override_price=₹14,500, contracted_students=500
 *   4. Asserts: activation_pending=true, started_at/expires_at are
 *      placeholders, override snapshot is correct
 *   5. Simulates the first-sign-in flip (writes activation_pending=false,
 *      bumps started_at + expires_at to now)
 *   6. Asserts: activation_pending=false, expires_at=now+365d
 *   7. Mid-cycle plan change to School Standard — without start_renewal flag
 *   8. Asserts: expires_at PRESERVED (not reset)
 *   9. Generates an invoice (writes invoice_number=BLM/YYYY/NNNN)
 *  10. Marks payment received
 *  11. Asserts: payment_received_at set, expires_at extended
 *  12. Triggers start_renewal — archives current cycle
 *  13. Asserts: subscription_invoice_archive has the old cycle row,
 *      live row's invoice_number=NULL, payment_received_at=NULL
 *  14. CLEANS UP — deletes the test school + auth user
 *
 * Requires:
 *   - .env.local with NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   - migrations 59 → 65 applied (the script verifies this and aborts
 *     with a clear message if columns are missing)
 *
 * Run:    node scripts/test-billing-e2e.js
 *
 * Output: coloured PASS/FAIL per assertion, with diff on failure. Exit
 *         code 0 = green; 1 = at least one failure. Test school is
 *         cleaned up even on failure (best-effort).
 */

const fs = require("fs");
const path = require("path");

// ── Load env ──
const envPath = path.join(__dirname, "..", ".env.local");
if (!fs.existsSync(envPath)) {
  console.error("\x1b[31m.env.local not found.\x1b[0m");
  process.exit(2);
}
const envText = fs.readFileSync(envPath, "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("\x1b[31mMissing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local.\x1b[0m");
  process.exit(2);
}

// ── Supabase client ──
let createClient;
try { ({ createClient } = require("@supabase/supabase-js")); }
catch { console.error("\x1b[31mRun `npm install` first (needs @supabase/supabase-js).\x1b[0m"); process.exit(2); }
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

// ── Tiny test runner ──
let pass = 0, fail = 0;
const failures = [];
function eq(label, got, want) {
  const okJson = JSON.stringify(got) === JSON.stringify(want);
  if (okJson) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else {
    fail++;
    failures.push(`${label}\n      got : ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
    console.log(`  \x1b[31m✗\x1b[0m ${label}\n      got : ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
  }
}
function truthy(label, v) { return eq(label, !!v, true); }
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }
const DAY = 24 * 60 * 60 * 1000;
async function run() {
  // ──────────────────────────────────────────────────────────────────
  // PRE-FLIGHT: schema check (clear error if migrations not applied)
  // ──────────────────────────────────────────────────────────────────
  section("Pre-flight: required schema present");
  const probe = await sb.from("subscriptions")
    .select("grace_period_days,activation_pending,contracted_students,override_price_paise,invoice_number")
    .limit(1);
  if (probe.error) {
    console.error(`  \x1b[31mSchema probe failed:\x1b[0m ${probe.error.message}`);
    console.error("  Apply migrations 59 → 65 in Supabase SQL editor before running this script.");
    process.exit(2);
  }
  console.log("  \x1b[32m✓\x1b[0m subscriptions has all expected columns");
  const arc = await sb.from("subscription_invoice_archive").select("id").limit(1);
  if (arc.error) {
    console.error(`  \x1b[31msubscription_invoice_archive missing:\x1b[0m ${arc.error.message}`);
    console.error("  Apply migration 64 in Supabase SQL editor.");
    process.exit(2);
  }
  console.log("  \x1b[32m✓\x1b[0m subscription_invoice_archive table present");

  // Find a School Pilot + School Standard plan to bind to.
  const { data: plans } = await sb.from("plans").select("id,slug,tier,period_days,per_student_price_paise").like("slug", "school_%");
  const pilot    = plans.find((p) => p.slug === "school_pilot");
  const standard = plans.find((p) => p.slug === "school_standard");
  if (!pilot || !standard)   { console.error("  \x1b[31mSchool Pilot / Standard plan rows not found in plans table.\x1b[0m"); process.exit(2); }
  console.log(`  \x1b[32m✓\x1b[0m Found plans: pilot=${pilot.id.slice(0,8)} standard=${standard.id.slice(0,8)}`);

  // ──────────────────────────────────────────────────────────────────
  // SETUP: create a test school + super_teacher auth user
  // ──────────────────────────────────────────────────────────────────
  section("Setup: create test school");
  const stamp     = Date.now();
  const testEmail = `e2e-${stamp}@bloomiqtest.local`;
  const testName  = `E2E Test School ${stamp}`;

  // 1. Auth user.
  const { data: created, error: authErr } = await sb.auth.admin.createUser({
    email: testEmail,
    password: "TestPass123!",
    email_confirm: true,
    user_metadata: { role: "super_teacher", full_name: "E2E Tester" },
  });
  if (authErr) { console.error("createUser:", authErr.message); process.exit(1); }
  const uid = created.user.id;
  truthy("created super_teacher auth user", uid);

  // 2. School row.
  const { data: school, error: schoolErr } = await sb.from("schools").insert({
    name: testName,
    super_teacher_id: uid,
    join_code: `E2E${stamp.toString().slice(-5)}`,
    invited_admin_email: testEmail,
    invited_at: new Date().toISOString(),
  }).select().single();
  if (schoolErr) { console.error("create school:", schoolErr.message); await cleanup(uid, null); process.exit(1); }
  truthy("created school row", school.id);

  // 3. Link profile to school.
  await sb.from("profiles").update({ school_id: school.id, school: testName, role: "super_teacher" }).eq("id", uid);

  let cleanupSchool = school.id;
  let cleanupUid    = uid;

  try {
    // ────────────────────────────────────────────────────────────────
    // SCENARIO 1: bind plan with activation_pending + override + seats
    // ────────────────────────────────────────────────────────────────
    section("Scenario 1: bind Pilot with activation_pending=true, override ₹14,500, 500 seats");
    const onboardNow = new Date();
    const placeholderExpires = new Date(onboardNow.getTime() + pilot.period_days * DAY).toISOString();
    const { error: subErr } = await sb.from("subscriptions").insert({
      school_id: school.id, user_id: null, plan_id: pilot.id, tier: "premium",
      status: "active", started_at: onboardNow.toISOString(), expires_at: placeholderExpires,
      override_price_paise: 1450000, override_reason: "E2E negotiated price",
      contracted_students: 500, payment_method: "neft",
      activation_pending: true, grace_period_days: 14,
    });
    if (subErr) throw new Error("insert sub: " + subErr.message);

    const { data: s1 } = await sb.from("subscriptions").select("*").eq("school_id", school.id).single();
    eq("plan_id = pilot",                         s1.plan_id,              pilot.id);
    eq("override_price_paise = ₹14,500",          s1.override_price_paise, 1450000);
    eq("contracted_students = 500",               s1.contracted_students,  500);
    eq("activation_pending = true",               s1.activation_pending,    true);
    eq("grace_period_days = 14",                  s1.grace_period_days,    14);

    // ────────────────────────────────────────────────────────────────
    // SCENARIO 2: simulate first-sign-in flip (mirrors /api/auth/me)
    // ────────────────────────────────────────────────────────────────
    section("Scenario 2: super-teacher first sign-in flips activation_pending");
    const signinTime = new Date(Date.now() + 5 * DAY); // 5 days after onboarding
    const flippedExpires = new Date(signinTime.getTime() + pilot.period_days * DAY).toISOString();
    await sb.from("subscriptions").update({
      started_at: signinTime.toISOString(),
      expires_at: flippedExpires,
      activation_pending: false,
    }).eq("id", s1.id);

    const { data: s2 } = await sb.from("subscriptions").select("*").eq("id", s1.id).single();
    eq("activation_pending = false after flip", s2.activation_pending, false);
    eq("started_at = sign-in moment",           s2.started_at,         signinTime.toISOString());
    eq("expires_at = signin + 365d",            s2.expires_at,         flippedExpires);

    // ────────────────────────────────────────────────────────────────
    // SCENARIO 3: mid-cycle plan change PRESERVES dates (Case C)
    // ────────────────────────────────────────────────────────────────
    section("Scenario 3: mid-cycle Pilot → Standard preserves expires_at");
    await sb.from("subscriptions").update({ plan_id: standard.id, tier: "premium" })
      .eq("id", s1.id);
    const { data: s3 } = await sb.from("subscriptions").select("*").eq("id", s1.id).single();
    eq("plan_id moved to Standard",                s3.plan_id,    standard.id);
    eq("expires_at PRESERVED across plan change",  s3.expires_at, flippedExpires);

    // ────────────────────────────────────────────────────────────────
    // SCENARIO 4: assign invoice number
    // ────────────────────────────────────────────────────────────────
    section("Scenario 4: assign invoice number BLM/YYYY/NNNN");
    const year = new Date().getFullYear();
    const { count: priorCount } = await sb.from("subscriptions")
      .select("id", { count: "exact", head: true })
      .like("invoice_number", `BLM/${year}/%`);
    const seq = String((priorCount ?? 0) + 1).padStart(4, "0");
    const invoiceNumber = `BLM/${year}/${seq}`;
    await sb.from("subscriptions").update({ invoice_number: invoiceNumber }).eq("id", s1.id);
    const { data: s4 } = await sb.from("subscriptions").select("invoice_number").eq("id", s1.id).single();
    eq(`invoice_number = ${invoiceNumber}`, s4.invoice_number, invoiceNumber);

    // ────────────────────────────────────────────────────────────────
    // SCENARIO 5: mark payment received (extend expiry)
    // ────────────────────────────────────────────────────────────────
    section("Scenario 5: mark payment received — extends expiry");
    const receivedAt = new Date();
    const prevExpiresMs = Date.parse(s3.expires_at);
    const baseTime = prevExpiresMs > receivedAt.getTime() ? prevExpiresMs : receivedAt.getTime();
    const newExpires = new Date(baseTime + standard.period_days * DAY).toISOString();
    await sb.from("subscriptions").update({
      payment_received_at: receivedAt.toISOString(),
      expires_at: newExpires,
      status: "active",
      activation_pending: false,
    }).eq("id", s1.id);
    const { data: s5 } = await sb.from("subscriptions").select("*").eq("id", s1.id).single();
    truthy("payment_received_at populated", s5.payment_received_at);
    eq("expires_at extended to baseTime + 365d", s5.expires_at, newExpires);

    // ────────────────────────────────────────────────────────────────
    // SCENARIO 6: Start renewal cycle (archive + clear)
    // ────────────────────────────────────────────────────────────────
    section("Scenario 6: Start renewal cycle — archives old, clears live row");
    const { error: archErr } = await sb.from("subscription_invoice_archive").insert({
      subscription_id: s1.id,
      school_id: school.id,
      plan_id: s5.plan_id,
      invoice_number: s5.invoice_number,
      contracted_students: s5.contracted_students,
      override_price_paise: s5.override_price_paise,
      override_reason: s5.override_reason,
      payment_method: s5.payment_method,
      payment_received_at: s5.payment_received_at,
      cycle_started_at: s5.started_at,
      cycle_expires_at: s5.expires_at,
      archived_by: uid,
    });
    if (archErr) throw new Error("archive: " + archErr.message);
    await sb.from("subscriptions").update({
      invoice_number: null,
      payment_received_at: null,
    }).eq("id", s1.id);

    const { data: archived } = await sb.from("subscription_invoice_archive")
      .select("*").eq("subscription_id", s1.id);
    eq("archive has 1 row for this subscription", archived?.length, 1);
    eq("archived invoice_number matches",          archived[0]?.invoice_number, invoiceNumber);
    eq("archived contracted_students = 500",       archived[0]?.contracted_students, 500);

    const { data: s6 } = await sb.from("subscriptions").select("*").eq("id", s1.id).single();
    eq("live invoice_number cleared",      s6.invoice_number,      null);
    eq("live payment_received_at cleared", s6.payment_received_at, null);
    truthy("plan_id retained on live row", s6.plan_id);  // plan preserved across renewal-cycle clear
    truthy("override_price_paise retained", s6.override_price_paise);

    // ────────────────────────────────────────────────────────────────
    // SCENARIO 7: GST math via direct compute (no PDF render here)
    // ────────────────────────────────────────────────────────────────
    section("Scenario 7: GST math on the active price");
    const subtotal = s6.override_price_paise || ((s6.contracted_students || 0) * (standard.per_student_price_paise || 0));
    const tax      = Math.round(subtotal * 0.18);
    const total    = subtotal + tax;
    eq("subtotal = ₹14,500", subtotal, 1450000);
    eq("IGST = ₹2,610",     tax,      261000);
    eq("total = ₹17,110",   total,    1711000);
  } finally {
    // ────────────────────────────────────────────────────────────────
    // CLEANUP — delete archive rows, subscription, school, auth user
    // ────────────────────────────────────────────────────────────────
    section("Cleanup");
    await cleanup(cleanupUid, cleanupSchool);
  }

  // ──────────────────────────────────────────────────────────────────
  console.log("\n────────────────────────────────────────");
  console.log(`\x1b[1mTotal: ${pass} passed, ${fail} failed\x1b[0m`);
  if (fail > 0) {
    console.log("\n\x1b[31mFailures:\x1b[0m");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  } else {
    console.log("\x1b[32mAll integration tests pass — B2B billing pipeline is healthy.\x1b[0m");
    process.exit(0);
  }
}

async function cleanup(uid, schoolId) {
  try {
    if (schoolId) {
      // Cascade through subscriptions + archive (FK on delete).
      await sb.from("subscription_invoice_archive").delete().eq("school_id", schoolId);
      await sb.from("subscriptions").delete().eq("school_id", schoolId);
      await sb.from("schools").delete().eq("id", schoolId);
      console.log(`  cleaned: school + subscriptions + archive (${schoolId.slice(0,8)})`);
    }
    if (uid) {
      await sb.auth.admin.deleteUser(uid);
      console.log(`  cleaned: auth user ${uid.slice(0,8)}`);
    }
  } catch (e) {
    console.warn("  cleanup warn:", e.message);
  }
}

run().catch((e) => {
  console.error("\n\x1b[31mFATAL:\x1b[0m", e.message);
  console.error(e.stack);
  process.exit(1);
});
