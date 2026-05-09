/**
 * scripts/create-3-free-students.js
 *
 * Creates 3 independent-learner Free-plan test students for E2E.
 *
 * Each account:
 *   - Email confirmed (no inbox-clicking required to sign in)
 *   - role = "student"
 *   - is_school_student = false
 *   - school_id = null
 *   - Free plan (no subscription row → falls through to free in featureAccess)
 *   - Pre-set exam_goal so they each test a different goal flow:
 *       1. Class 12 boards
 *       2. NEET prep
 *       3. Class 5-8 (primary/middle)
 *
 * Usage (from project root):
 *   node scripts/create-3-free-students.js
 *
 * Re-run: passing --reset wipes any existing accounts at these emails first.
 *   node scripts/create-3-free-students.js --reset
 */

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

function loadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) {
    console.error("❌ .env.local not found at", envPath);
    process.exit(1);
  }
  const env = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[m[1]] = v;
  }
  return env;
}

const ACCOUNTS = [
  {
    email: "free.student.1@bloomiq-test.local",
    password: "TestPass123!",
    full_name: "Riya Sharma",
    exam_goal: "class_12_boards",
    exam_goal_label: "Class 12 boards",
  },
  {
    email: "free.student.2@bloomiq-test.local",
    password: "TestPass123!",
    full_name: "Aarav Kumar",
    exam_goal: "neet_prep",
    exam_goal_label: "NEET prep",
  },
  {
    email: "free.student.3@bloomiq-test.local",
    password: "TestPass123!",
    full_name: "Meera Patel",
    exam_goal: "class_5_8",
    exam_goal_label: "Class 5–8 (primary/middle)",
  },
];

async function ensureAccount(admin, account, reset) {
  const { email, password, full_name, exam_goal } = account;

  // If --reset was passed, find any existing user with this email and delete
  // them first. Note: listUsers paginates; for our small test space one page
  // is plenty.
  if (reset) {
    const { data: list, error: listErr } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    if (listErr) throw listErr;
    const existing = (list.users || []).find(
      (u) => (u.email || "").toLowerCase() === email.toLowerCase()
    );
    if (existing) {
      await admin.auth.admin.deleteUser(existing.id);
      console.log(`   ↪ deleted existing user ${email} (${existing.id})`);
    }
  }

  // Create the user with email already confirmed.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      role: "student",
      full_name,
    },
  });

  if (createErr) {
    // Idempotent path — if the user already exists and we didn't --reset, we
    // still want to ensure their profile is clean. So we look them up by email.
    if (/already.*registered|already.*exists/i.test(createErr.message)) {
      const { data: list } = await admin.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      });
      const existing = (list.users || []).find(
        (u) => (u.email || "").toLowerCase() === email.toLowerCase()
      );
      if (!existing) throw createErr;
      console.log(`   ↪ user ${email} already exists, will refresh profile`);
      await refreshProfile(admin, existing.id, account);
      return { id: existing.id, isNew: false };
    }
    throw createErr;
  }

  // Wait briefly for the auth-trigger to insert the profile row, then
  // refresh it with our desired student-flavoured defaults.
  await new Promise((r) => setTimeout(r, 400));
  await refreshProfile(admin, created.user.id, account);
  return { id: created.user.id, isNew: true };
}

async function refreshProfile(admin, userId, account) {
  // Upsert the profile row to ensure it reflects an independent free
  // student with the desired exam_goal. The trigger from migration 02
  // creates the row on auth signup; we just patch the columns we care
  // about.
  const { error: profErr } = await admin
    .from("profiles")
    .upsert(
      {
        id: userId,
        full_name: account.full_name,
        role: "student",
        is_school_student: false,
        school_id: null,
        exam_goal: account.exam_goal,
        exam_goal_set_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );
  if (profErr) {
    // Some installs do not have all columns yet; degrade gracefully.
    console.warn(`   ⚠ profile upsert had a non-fatal warning: ${profErr.message}`);
  }

  // Defensive: if a stale subscription row is attached to this user from a
  // previous run, clear it so they're truly on the free tier.
  const { error: subErr } = await admin
    .from("subscriptions")
    .delete()
    .eq("user_id", userId);
  if (subErr) {
    // Ignore — most accounts won't have a row at all.
  }
}

async function main() {
  const env = loadEnvLocal();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("❌ Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }
  const reset = process.argv.includes("--reset");

  const admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`\n🌱 Creating ${ACCOUNTS.length} free-plan independent students…`);
  if (reset) console.log("   (--reset: existing accounts at these emails will be deleted first)");
  console.log("");

  const summary = [];
  for (const account of ACCOUNTS) {
    process.stdout.write(`• ${account.email}  …  `);
    try {
      const { id, isNew } = await ensureAccount(admin, account, reset);
      console.log(isNew ? `created (id ${id.slice(0, 8)}…)` : `refreshed (id ${id.slice(0, 8)}…)`);
      summary.push({ ...account, id, isNew });
    } catch (e) {
      console.log(`❌ FAILED: ${e.message || e}`);
    }
  }

  console.log("\n========== Test accounts ready ==========");
  for (const s of summary) {
    console.log(
      `\n  Name:     ${s.full_name}\n` +
      `  Email:    ${s.email}\n` +
      `  Password: ${s.password}\n` +
      `  Goal:     ${s.exam_goal_label}\n` +
      `  Plan:     Free`
    );
  }
  console.log("\n  Sign-in URL: http://localhost:3000/login/student");
  console.log("\n  All three are confirmed (no inbox click needed) and on the");
  console.log("  Free plan (no subscription row). They have an exam_goal already");
  console.log("  set, so the goal-picker is skipped and they land straight on");
  console.log("  the Discover BloomIQ Score discovery hero.");
  console.log("\n  Tip: pass --reset to wipe + recreate next time.");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
