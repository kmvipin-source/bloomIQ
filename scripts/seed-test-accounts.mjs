// =============================================================================
// scripts/seed-test-accounts.mjs
// -----------------------------------------------------------------------------
// Idempotent seed for the QA cohort. Creates four prod test accounts — one
// per public-facing role — and flips profiles.is_test_account = true so they
// don't pollute the platform dashboards.
//
// Run: node scripts/seed-test-accounts.mjs
//
// Env required (.env): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Re-run safe — existing users are skipped, only the test-account flag and
// role/full_name patch are reapplied.
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Load .env manually so this script doesn't need a separate dotenv install.
const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "..", ".env");
const envText = readFileSync(envPath, "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

// All accounts share one password to keep handoff simple — these are for
// internal QA only, never meant to look like real users. Rotate before
// shipping the credentials list externally.
const PASSWORD = "QATest@2026";

const SEEDS = [
  {
    email: "qa.indep.student@bloomiq.test",
    full_name: "QA Indep Student",
    role: "student",
    is_school_student: false,
  },
  {
    email: "qa.school.student@bloomiq.test",
    full_name: "QA School Student",
    role: "student",
    is_school_student: true, // School-managed flag; assignment to a school stays manual.
  },
  {
    email: "qa.teacher@bloomiq.test",
    full_name: "QA Teacher",
    role: "teacher",
    is_school_student: false,
  },
  {
    email: "qa.school.admin@bloomiq.test",
    full_name: "QA School Admin",
    role: "super_teacher",
    is_school_student: false,
  },
];

async function findUserByEmail(email) {
  // listUsers is paginated; for our handful of test seeds the first page
  // is plenty.
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  return data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) || null;
}

async function ensureSeed(seed) {
  const existing = await findUserByEmail(seed.email);
  let userId;
  if (existing) {
    userId = existing.id;
    console.log(`✓ exists  ${seed.email}`);
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      email: seed.email,
      password: PASSWORD,
      email_confirm: true, // auto-confirm so /login works without an email click
      user_metadata: { role: seed.role, full_name: seed.full_name },
    });
    if (error) {
      console.error(`✗ create  ${seed.email}: ${error.message}`);
      return;
    }
    userId = data.user.id;
    console.log(`+ created ${seed.email}`);
  }

  // Upsert the profile row (handle_new_user trigger may have created a
  // skeleton; we patch the fields we care about). Service role bypasses
  // RLS, so this works even if the row's policies wouldn't normally allow
  // it. is_test_account is the flag the dashboard filters on.
  const patch = {
    id: userId,
    role: seed.role,
    full_name: seed.full_name,
    is_school_student: seed.is_school_student,
    is_test_account: true,
  };
  const { error: upErr } = await admin
    .from("profiles")
    .upsert(patch, { onConflict: "id" });
  if (upErr) {
    console.error(`✗ profile ${seed.email}: ${upErr.message}`);
    return;
  }
  console.log(`  flagged is_test_account=true, role=${seed.role}`);
}

(async () => {
  console.log("Seeding QA test accounts on", url);
  console.log("Shared password:", PASSWORD);
  console.log("");
  for (const seed of SEEDS) {
    await ensureSeed(seed);
  }
  console.log("");
  console.log("Done. Sign-in URLs:");
  console.log("  Independent student → /login/student");
  console.log("  School student      → /login/school (link by school join code first)");
  console.log("  Teacher             → /login (Teacher tab)");
  console.log("  School admin        → /login (School Admin tab)");
  console.log("");
  console.log("Reminder: school student + school admin still need a school assignment.");
  console.log("Use /admin/onboard-school for the admin, then /school join code for the student.");
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
