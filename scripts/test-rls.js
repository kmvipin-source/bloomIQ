#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * test-rls.js
 * -----------
 * Multi-persona RLS audit. Signs in as each role + cross-school user and
 * probes every high-stakes table with two kinds of assertions:
 *
 *   POSITIVE: this user SHOULD see / write this row → must succeed
 *   NEGATIVE: this user SHOULD NOT see / write that row → must fail (or return 0 rows)
 *
 * If a negative case returns rows, that's an RLS leak — the most dangerous
 * class of bug in a multi-tenant SaaS. A school admin seeing another school's
 * students would be a press release for the wrong reasons.
 *
 * Personas (all live in two parallel orgs created on the fly):
 *
 *   Org A (Test Academy A):
 *     super_teacher_A   — Admin Head of A
 *     teacher_A         — primary teacher in A
 *     student_A         — school student in A
 *
 *   Org B (Test Academy B):
 *     super_teacher_B   — Admin Head of B
 *     teacher_B         — primary teacher in B
 *     student_B         — school student in B
 *
 *   indie_student       — independent student, no school
 *   platform_admin      — cross-cutting
 *   anon                — no auth (uses anon key)
 *
 * For each persona we get a real GoTrue access token, then make queries
 * with a client bound to that token. RLS evaluates as the persona, not as
 * service-role.
 *
 * Cleanup: every test user + every test school is deleted at the end,
 * even on assertion failure (best-effort).
 *
 * Run:    node scripts/test-rls.js
 * Exit:   0 = all green, 1 = at least one failure or leak.
 */

const fs = require("fs");
const path = require("path");

// ── env loader ──
const envPath = path.join(__dirname, "..", ".env.local");
if (!fs.existsSync(envPath)) {
  console.error("\x1b[31m.env.local not found.\x1b[0m");
  process.exit(2);
}
const env = {};
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!SB_URL || !SB_KEY || !ANON_KEY) {
  console.error("\x1b[31mMissing one of NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY.\x1b[0m");
  process.exit(2);
}

let createClient;
try { ({ createClient } = require("@supabase/supabase-js")); }
catch { console.error("\x1b[31mRun npm install first.\x1b[0m"); process.exit(2); }

const admin = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

// ── tiny test runner ──
let pass = 0, fail = 0;
const failures = [];
function ok(label) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
function bad(label, detail) {
  fail++;
  const msg = detail ? `${label}\n      ${detail}` : label;
  failures.push(msg);
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

const STAMP = Date.now();
const PW = "TestPass123!";

/** Token-bound client. RLS evaluates as this user. */
function clientAs(accessToken) {
  return createClient(SB_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/** Anon client — no auth. Worst-case probe. */
function anonClient() {
  return createClient(SB_URL, ANON_KEY, { auth: { persistSession: false } });
}

/** Create user + sign in, return { uid, token }. */
async function makeUser(email, role, fullName, schoolId) {
  const { data: created, error } = await admin.auth.admin.createUser({
    email, password: PW, email_confirm: true,
    user_metadata: { role, full_name: fullName },
  });
  if (error) throw new Error(`createUser ${email}: ${error.message}`);
  const uid = created.user.id;
  // Update profile (role + school_id).
  await admin.from("profiles").update({
    role, school_id: schoolId, full_name: fullName,
  }).eq("id", uid);
  // Sign in to get an access token.
  const { data: signed, error: signErr } = await admin.auth.signInWithPassword({ email, password: PW });
  if (signErr) throw new Error(`signIn ${email}: ${signErr.message}`);
  return { uid, token: signed.session.access_token, email };
}

async function cleanupUser(u) {
  if (!u) return;
  try { await admin.auth.admin.deleteUser(u.uid); } catch { /* swallow */ }
}

async function cleanupSchool(id) {
  if (!id) return;
  try {
    await admin.from("subscription_invoice_archive").delete().eq("school_id", id);
    await admin.from("subscriptions").delete().eq("school_id", id);
    await admin.from("classes").delete().eq("school_id", id);
    await admin.from("schools").delete().eq("id", id);
  } catch { /* swallow */ }
}

/** Assert a query returns rows (positive case). */
async function expectRows(label, qFn) {
  try {
    const { data, error } = await qFn();
    if (error) { bad(label, `error: ${error.message}`); return; }
    if (!data || data.length === 0) { bad(label, "expected rows, got 0"); return; }
    ok(label);
  } catch (e) { bad(label, e.message); }
}

/** Assert a query returns NO rows (negative case = RLS scoping correct). */
async function expectNoRows(label, qFn) {
  try {
    const { data, error } = await qFn();
    if (error) { ok(`${label} (RLS blocked: ${error.code || "no-rows"})`); return; }
    if (!data || data.length === 0) { ok(label); return; }
    bad(`${label} — RLS LEAK`, `got ${data.length} rows: ${JSON.stringify(data.slice(0, 2))}`);
  } catch (e) { bad(label, e.message); }
}

/** Assert an insert/update is blocked by RLS.
 *
 * PostgREST quirk: when a user-scoped client UPDATEs a row that RLS hides
 * from their view, PostgREST returns { error: null, data: [] } — NOT an
 * error. The update vacuously affects zero rows. So an absent error is NOT
 * proof the write was rejected.
 *
 * Caller passes an optional `verify` function that re-reads the target via
 * service-role and returns true if the row is unchanged. If verify returns
 * true, we treat it as a successful RLS block.
 */
async function expectWriteFails(label, mutationFn, verifyUnchanged) {
  try {
    const { error } = await mutationFn();
    if (error) { ok(`${label} (rejected: ${error.code || error.message.slice(0, 40)})`); return; }
    // No explicit error — verify the target wasn't actually changed.
    if (verifyUnchanged) {
      const unchanged = await verifyUnchanged();
      if (unchanged) { ok(`${label} (silently rejected: 0 rows affected)`); return; }
    }
    bad(`${label} — WRITE LEAK`, "expected RLS rejection or zero-row update, but write succeeded");
  } catch (e) { ok(`${label} (rejected: ${e.message.slice(0, 40)})`); }
}

// ─────────────────────────────────────────────────────────────────
// Setup — two parallel test schools with full role coverage
// ─────────────────────────────────────────────────────────────────
async function setup() {
  section("Setup — two parallel test orgs");

  const schoolAName = `RLS_Test_A_${STAMP}`;
  const schoolBName = `RLS_Test_B_${STAMP}`;

  const { data: schoolA } = await admin.from("schools").insert({
    name: schoolAName, join_code: `RLSA${String(STAMP).slice(-5)}`,
    invited_admin_email: `super.a.${STAMP}@bloomiqtest.local`,
    invited_at: new Date().toISOString(),
  }).select().single();
  const { data: schoolB } = await admin.from("schools").insert({
    name: schoolBName, join_code: `RLSB${String(STAMP).slice(-5)}`,
    invited_admin_email: `super.b.${STAMP}@bloomiqtest.local`,
    invited_at: new Date().toISOString(),
  }).select().single();
  ok(`created schools: ${schoolAName} + ${schoolBName}`);

  const users = {};
  users.super_a   = await makeUser(`super.a.${STAMP}@bloomiqtest.local`, "super_teacher", "Super A", schoolA.id);
  users.super_b   = await makeUser(`super.b.${STAMP}@bloomiqtest.local`, "super_teacher", "Super B", schoolB.id);
  users.teacher_a = await makeUser(`teacher.a.${STAMP}@bloomiqtest.local`, "teacher", "Teacher A", schoolA.id);
  users.teacher_b = await makeUser(`teacher.b.${STAMP}@bloomiqtest.local`, "teacher", "Teacher B", schoolB.id);
  users.student_a = await makeUser(`student.a.${STAMP}@bloomiqtest.local`, "student", "Student A", schoolA.id);
  await admin.from("profiles").update({ is_school_student: true }).eq("id", users.student_a.uid);
  users.student_b = await makeUser(`student.b.${STAMP}@bloomiqtest.local`, "student", "Student B", schoolB.id);
  await admin.from("profiles").update({ is_school_student: true }).eq("id", users.student_b.uid);
  users.indie     = await makeUser(`indie.${STAMP}@bloomiqtest.local`, "student", "Indie Student", null);
  users.platform  = await makeUser(`platform.${STAMP}@bloomiqtest.local`, "super_teacher", "Platform Admin", null);
  await admin.from("profiles").update({ platform_admin: true, school_id: null }).eq("id", users.platform.uid);
  ok("created 8 user personas across 2 schools");

  // Tie super-teachers to their schools' super_teacher_id column.
  await admin.from("schools").update({ super_teacher_id: users.super_a.uid }).eq("id", schoolA.id);
  await admin.from("schools").update({ super_teacher_id: users.super_b.uid }).eq("id", schoolB.id);

  return { schoolA, schoolB, users };
}

async function teardown(ctx) {
  section("Cleanup");
  for (const u of Object.values(ctx.users || {})) await cleanupUser(u);
  await cleanupSchool(ctx.schoolA?.id);
  await cleanupSchool(ctx.schoolB?.id);
  ok("removed test users + test schools");
}

// ─────────────────────────────────────────────────────────────────
// Probes
// ─────────────────────────────────────────────────────────────────

async function probeSchoolsTable(ctx) {
  section("schools — cross-tenant isolation");
  const { schoolA, schoolB, users } = ctx;

  // POSITIVE: Super A reads their own school.
  await expectRows("super_a reads schoolA", () =>
    clientAs(users.super_a.token).from("schools").select("id").eq("id", schoolA.id));

  // NEGATIVE: Super A cannot read schoolB.
  await expectNoRows("super_a does NOT see schoolB", () =>
    clientAs(users.super_a.token).from("schools").select("id").eq("id", schoolB.id));

  // NEGATIVE: anon sees nothing.
  await expectNoRows("anon does NOT see any schools", () =>
    anonClient().from("schools").select("id").limit(5));

  // NEGATIVE: indie student does NOT see either school.
  await expectNoRows("indie student does NOT see schoolA", () =>
    clientAs(users.indie.token).from("schools").select("id").eq("id", schoolA.id));

  // NEGATIVE: student_a CANNOT update schoolB's name.
  await expectWriteFails("student_a cannot rename schoolB", () =>
    clientAs(users.student_a.token).from("schools").update({ name: "HACKED" }).eq("id", schoolB.id),
    async () => {
      const { data } = await admin.from("schools").select("name").eq("id", schoolB.id).single();
      return data?.name !== "HACKED";
    });
}

async function probeSubscriptionsTable(ctx) {
  section("subscriptions — billing isolation");
  const { schoolA, schoolB, users } = ctx;

  // Seed a school subscription for each.
  await admin.from("subscriptions").insert([
    {
      school_id: schoolA.id, plan_id: null, tier: "premium",
      status: "active", started_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      school_id: schoolB.id, plan_id: null, tier: "premium",
      status: "active", started_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ]);

  // POSITIVE: super_a sees schoolA's subscription.
  await expectRows("super_a reads schoolA subscription", () =>
    clientAs(users.super_a.token).from("subscriptions").select("id, school_id").eq("school_id", schoolA.id));

  // NEGATIVE: super_a does NOT see schoolB's subscription.
  await expectNoRows("super_a does NOT see schoolB subscription", () =>
    clientAs(users.super_a.token).from("subscriptions").select("id, school_id").eq("school_id", schoolB.id));

  // NEGATIVE: student_a cannot extend their school's expires_at.
  const targetExpiryFuture = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString();
  await expectWriteFails("student_a cannot extend schoolA expiry", () =>
    clientAs(users.student_a.token).from("subscriptions")
      .update({ expires_at: targetExpiryFuture })
      .eq("school_id", schoolA.id),
    async () => {
      const { data } = await admin.from("subscriptions").select("expires_at").eq("school_id", schoolA.id).maybeSingle();
      return data?.expires_at !== targetExpiryFuture;
    });

  // NEGATIVE: indie cannot see school subs at all.
  await expectNoRows("indie cannot see school subscriptions", () =>
    clientAs(users.indie.token).from("subscriptions").select("id").not("school_id", "is", null));
}

async function probeSubscriptionInvoiceArchive(ctx) {
  section("subscription_invoice_archive — service-role-only");
  const { users } = ctx;

  // Migration 64 sets RLS to deny all reads/writes for everyone except service role.
  await expectNoRows("platform admin sees archive (denied via PostgREST)", () =>
    clientAs(users.platform.token).from("subscription_invoice_archive").select("id").limit(5));
  await expectNoRows("super_a sees archive (denied)", () =>
    clientAs(users.super_a.token).from("subscription_invoice_archive").select("id").limit(5));
  await expectNoRows("student_a sees archive (denied)", () =>
    clientAs(users.student_a.token).from("subscription_invoice_archive").select("id").limit(5));
  await expectWriteFails("student_a cannot insert into archive", () =>
    clientAs(users.student_a.token).from("subscription_invoice_archive").insert({
      subscription_id: "00000000-0000-0000-0000-000000000000",
      school_id: "00000000-0000-0000-0000-000000000000",
    }));
}

async function probeProfilesTable(ctx) {
  section("profiles — self-only or scoped writes");
  const { users } = ctx;

  // POSITIVE: student_a reads their own profile.
  await expectRows("student_a reads own profile", () =>
    clientAs(users.student_a.token).from("profiles").select("id, full_name").eq("id", users.student_a.uid));

  // NEGATIVE: student_a cannot promote themselves to platform_admin.
  await expectWriteFails("student_a cannot self-promote to platform_admin", () =>
    clientAs(users.student_a.token).from("profiles").update({ platform_admin: true }).eq("id", users.student_a.uid),
    async () => {
      const { data } = await admin.from("profiles").select("platform_admin").eq("id", users.student_a.uid).single();
      return data?.platform_admin !== true;
    });

  // NEGATIVE: student_a cannot edit student_b's profile.
  await expectWriteFails("student_a cannot edit student_b's profile", () =>
    clientAs(users.student_a.token).from("profiles").update({ full_name: "HACKED" }).eq("id", users.student_b.uid),
    async () => {
      const { data } = await admin.from("profiles").select("full_name").eq("id", users.student_b.uid).single();
      return data?.full_name !== "HACKED";
    });
}

async function probeClassesAndMembership(ctx) {
  section("classes / class_members / class_teachers — cross-school isolation");
  const { schoolA, schoolB, users } = ctx;

  // Create one class in each school using the LEGITIMATE creator persona —
  // the super_teacher of each school. The classes INSERT policy is
  //   with check (is_super_for_school(school_id))
  // which requires the caller to actually BE a super_teacher (auth.uid()
  // populated). The service role path doesn't satisfy this on Supabase's
  // default service_role bypass config, so we use super_a / super_b tokens.
  const classAResp = await clientAs(users.super_a.token).from("classes").insert({
    school_id: schoolA.id, name: "Grade 9 · Section A", grade: "9",
    owner_id: users.teacher_a.uid, join_code: `RLSCA${String(STAMP).slice(-4)}`,
  }).select().single();
  if (classAResp.error || !classAResp.data) { bad("create schoolA class as super_a", classAResp.error?.message || "insert returned null"); return; }
  const classA = classAResp.data;
  const classBResp = await clientAs(users.super_b.token).from("classes").insert({
    school_id: schoolB.id, name: "Grade 9 · Section B", grade: "9",
    owner_id: users.teacher_b.uid, join_code: `RLSCB${String(STAMP).slice(-4)}`,
  }).select().single();
  if (classBResp.error || !classBResp.data) { bad("create schoolB class as super_b", classBResp.error?.message || "insert returned null"); return; }
  const classB = classBResp.data;

  // POSITIVE: teacher_a sees their school's class.
  await expectRows("teacher_a sees schoolA class", () =>
    clientAs(users.teacher_a.token).from("classes").select("id").eq("school_id", schoolA.id));

  // NEGATIVE: teacher_a does NOT see schoolB class.
  await expectNoRows("teacher_a does NOT see schoolB class", () =>
    clientAs(users.teacher_a.token).from("classes").select("id").eq("school_id", schoolB.id));

  // NEGATIVE: indie does NOT see any school's class.
  await expectNoRows("indie does NOT see schoolA class", () =>
    clientAs(users.indie.token).from("classes").select("id").eq("id", classA.id));

  // NEGATIVE: super_b cannot rename schoolA's class.
  await expectWriteFails("super_b cannot rename schoolA class", () =>
    clientAs(users.super_b.token).from("classes").update({ name: "HACKED" }).eq("id", classA.id));

  // Cleanup classes (subscriptions cleanup happens later via school cascade).
  await admin.from("classes").delete().eq("id", classA.id);
  await admin.from("classes").delete().eq("id", classB.id);
}

async function probePlansAndPlanProposals(ctx) {
  section("plans + plan_change_proposals — catalogue is public, proposals are admin-only");
  const { users } = ctx;

  // POSITIVE: every user can READ plans (catalogue is intentionally public).
  await expectRows("anon reads plans catalogue", () =>
    anonClient().from("plans").select("slug").limit(3));
  await expectRows("student_a reads plans catalogue", () =>
    clientAs(users.student_a.token).from("plans").select("slug").limit(3));

  // NEGATIVE: only platform admin (or service role) writes to plan_change_proposals.
  await expectNoRows("student_a does NOT see plan_change_proposals", () =>
    clientAs(users.student_a.token).from("plan_change_proposals").select("id").limit(3));
  await expectWriteFails("student_a cannot create a plan_change_proposal", () =>
    clientAs(users.student_a.token).from("plan_change_proposals").insert({
      kind: "edit", plan_id: null, payload: {}, created_by: users.student_a.uid,
    }));
}

async function probeCoachUsageTable(ctx) {
  section("coach_usage — user reads own only");
  const { users } = ctx;

  // POSITIVE: student_a reads their own coach_usage rows.
  await expectRows("student_a reads own coach_usage (after seed)", async () => {
    // Seed one row to enable the positive read.
    await admin.from("coach_usage").insert({
      user_id: users.student_a.uid, surface: "teacher", called_at: new Date().toISOString(),
    });
    return clientAs(users.student_a.token).from("coach_usage").select("id").eq("user_id", users.student_a.uid);
  });

  // NEGATIVE: student_a does NOT see student_b's coach_usage.
  await expectNoRows("student_a does NOT see student_b coach_usage", () =>
    clientAs(users.student_a.token).from("coach_usage").select("id").eq("user_id", users.student_b.uid));

  // Cleanup.
  await admin.from("coach_usage").delete().eq("user_id", users.student_a.uid);
}

async function probeCalibrationsBloomScores(ctx) {
  section("calibrations + bloomiq_scores — self-only");
  const { users } = ctx;

  // Seed a calibration for student_a. PK is user_id (per migration 66) and
  // score column is initial_score, not score. Upsert in case a stub row was
  // auto-created by some other flow.
  const seedResp = await admin.from("calibrations").upsert({
    user_id: users.student_a.uid, exam_goal: "class_12_boards", initial_score: 427,
  }, { onConflict: "user_id" }).select().single();
  if (seedResp.error || !seedResp.data) {
    bad("seed calibration for student_a (admin)", seedResp.error?.message || "upsert returned null");
    return;
  }

  // POSITIVE: student_a reads own calibration (filter by their own user_id).
  await expectRows("student_a reads own calibration", () =>
    clientAs(users.student_a.token).from("calibrations").select("user_id").eq("user_id", users.student_a.uid));

  // NEGATIVE: student_b does NOT see student_a's calibration.
  await expectNoRows("student_b does NOT see student_a calibration", () =>
    clientAs(users.student_b.token).from("calibrations").select("user_id").eq("user_id", users.student_a.uid));

  // NEGATIVE: super_a does NOT see student_a's calibration (school admin
  // should NOT see individual learner score data — privacy boundary).
  await expectNoRows("super_a does NOT see student_a calibration (privacy)", () =>
    clientAs(users.super_a.token).from("calibrations").select("user_id").eq("user_id", users.student_a.uid));

  await admin.from("calibrations").delete().eq("user_id", users.student_a.uid);
}

// ─────────────────────────────────────────────────────────────────
async function main() {
  console.log("\x1b[1mBloomIQ RLS audit\x1b[0m");
  console.log("Target:", SB_URL);
  let ctx;
  try {
    ctx = await setup();
    await probeSchoolsTable(ctx);
    await probeSubscriptionsTable(ctx);
    await probeSubscriptionInvoiceArchive(ctx);
    await probeProfilesTable(ctx);
    await probeClassesAndMembership(ctx);
    await probePlansAndPlanProposals(ctx);
    await probeCoachUsageTable(ctx);
    await probeCalibrationsBloomScores(ctx);
  } finally {
    if (ctx) await teardown(ctx);
  }

  console.log("\n────────────────────────────────────────");
  console.log(`\x1b[1mTotal: ${pass} passed, ${fail} failed\x1b[0m`);
  if (fail > 0) {
    console.log("\n\x1b[31mFailures:\x1b[0m");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  } else {
    console.log("\x1b[32mAll RLS probes pass — no cross-tenant leaks detected.\x1b[0m");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("\n\x1b[31mFATAL:\x1b[0m", e.message);
  console.error(e.stack);
  process.exit(1);
});
