// Create a school-student test account on any school plan.
//
// Why: features like Concept Visualizer and Voice AI Teacher are gated by
// plan tier. To exercise the gated UX as a school student you need (a) a
// school row, (b) an active subscriptions row tying that school to the
// chosen plan, and (c) a student profile with is_school_student=true and
// school_id pointing at that school. This script wires all three
// idempotently.
//
// Plan options (--plan):
//   --plan school_plus      (default; unlocks everything incl. visualizer + voice)
//   --plan school_standard  (most features unlocked, NO visualizer / voice)
//   --plan school_pilot     (basic tier, NO visualizer / voice / etc.)
//
// What it produces (per plan):
//   - School:       "School Pilot/Standard/Plus Test Academy"
//   - Subscription: school_id=<school>, plan_id=<chosen plan>, status=active,
//                   expires_at = now + 365 days
//   - Student:      pilotstudent / standardstudent / splusstudent @bloomiq.invalid
//                   password = TestPass123!
//                   role=student, is_school_student=true, school_id=<school>
//
// Usage (from project root):
//   node scripts/create-school-plus-test-student.js
//   node scripts/create-school-plus-test-student.js --reset
//   node scripts/create-school-plus-test-student.js --plan school_pilot
//   node scripts/create-school-plus-test-student.js --plan school_standard --reset
//   node scripts/create-school-plus-test-student.js myhandle MyPass123 "Test Kid"
//
// First positional arg is the USERNAME (not email) — school students sign
// in at /login/school by typing just the username; the login page builds
// the email as `<username>@bloomiq.invalid` for them. We follow the same
// convention here. The username cannot contain '@'.
//
// Re-run with --reset to wipe and recreate the student (and the school's
// subscription) so you can test the full upgrade flow from scratch.
//
// Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

// ───────────────────────────────────────────────────────────────────────────
// .env.local loader (matches the pattern used by the other scripts).
// ───────────────────────────────────────────────────────────────────────────
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

function randomCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function findUserByEmail(sb, email) {
  const { data, error } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  return data.users.find((u) => (u.email || "").toLowerCase() === email.toLowerCase()) || null;
}

async function main() {
  const env = loadEnvLocal();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("❌ Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }

  // Parse argv. Boolean flags (--reset, --reset-school) go in `flags`.
  // Value flags (--plan school_pilot, --plan=school_pilot) are extracted
  // separately so positional args don't get confused with them.
  const rawArgv = process.argv.slice(2);
  const flags = new Set();
  const positional = [];
  let planFlag = null;
  for (let i = 0; i < rawArgv.length; i++) {
    const tok = rawArgv[i];
    if (tok === "--plan") {
      planFlag = (rawArgv[++i] || "").toLowerCase();
    } else if (tok.startsWith("--plan=")) {
      planFlag = tok.slice("--plan=".length).toLowerCase();
    } else if (tok.startsWith("--")) {
      flags.add(tok);
    } else {
      positional.push(tok);
    }
  }

  // Validate plan slug. school_plus is the default (preserves the
  // script's original behaviour) so existing test scripts and CI calls
  // keep working without changes.
  const ALLOWED_PLANS = ["school_pilot", "school_standard", "school_plus"];
  const planSlug = planFlag || "school_plus";
  if (!ALLOWED_PLANS.includes(planSlug)) {
    console.error(`❌ Invalid --plan "${planSlug}". Allowed: ${ALLOWED_PLANS.join(", ")}.`);
    process.exit(1);
  }

  // Per-plan defaults so each plan gets its own school + a memorable
  // username — keeps test setups for different plans from colliding when
  // run side-by-side. Override via positional args 1/2/3.
  const PLAN_DEFAULTS = {
    school_pilot:    { username: "pilotstudent",    fullName: "Test School-Pilot Student",    schoolName: "School Pilot Test Academy" },
    school_standard: { username: "standardstudent", fullName: "Test School-Standard Student", schoolName: "School Standard Test Academy" },
    school_plus:     { username: "splusstudent",    fullName: "Test School-Plus Student",     schoolName: "School Plus Test Academy" },
  };
  const planDefaults = PLAN_DEFAULTS[planSlug];

  // School students log in by username only — the login page synthesizes
  // the email as `<username>@bloomiq.invalid`. Default to a short, clean
  // handle so the test sign-in is easy to type. Reject usernames that
  // contain '@' so the failure is at script-time, not at login-time.
  const SCHOOL_DOMAIN = "bloomiq.invalid";
  const username = (positional[0] || planDefaults.username).toLowerCase();
  if (username.includes("@")) {
    console.error('❌ First arg must be a USERNAME (no "@"). The script builds the email as <username>@bloomiq.invalid.');
    process.exit(1);
  }
  const email = `${username}@${SCHOOL_DOMAIN}`;
  const password = positional[1] || "TestPass123!";
  const fullName = positional[2] || planDefaults.fullName;
  // Per-plan env override kept for the school_plus default to not break
  // callers that already set SEED_SCHOOL_PLUS_NAME. New callers should
  // pass --plan and let the default school name match the plan.
  const SCHOOL_NAME =
    (planSlug === "school_plus" && process.env.SEED_SCHOOL_PLUS_NAME) ||
    process.env.SEED_SCHOOL_NAME ||
    planDefaults.schoolName;

  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`\n🌱 Creating school-student test account on ${planSlug} plan...`);
  console.log(`   School:   ${SCHOOL_NAME}`);
  console.log(`   Plan:     ${planSlug}`);
  console.log(`   Username: ${username}    ← this is what you type at /login/school`);
  console.log(`   Email:    ${email}    ← internal only, derived from username`);
  console.log(`   Password: ${password}`);
  console.log(`   Name:     ${fullName}\n`);

  // ─────────────────────────────────────────────────────────────────────────
  // Optional reset: delete the student account (the school + its subscription
  // are kept so re-runs converge cheaply, but --reset-school wipes those too).
  // ─────────────────────────────────────────────────────────────────────────
  if (flags.has("--reset")) {
    console.log("--reset: removing existing student account if present...");
    const existing = await findUserByEmail(sb, email);
    if (existing) {
      const { error: delErr } = await sb.auth.admin.deleteUser(existing.id);
      if (delErr) throw new Error(`delete existing user: ${delErr.message}`);
      console.log(`   removed user ${email}`);
    } else {
      console.log("   (no prior account to remove)");
    }
  }

  if (flags.has("--reset-school")) {
    console.log("--reset-school: wiping the test school + subscription...");
    const { data: existingSchools } = await sb
      .from("schools")
      .select("id")
      .eq("name", SCHOOL_NAME);
    for (const s of existingSchools || []) {
      // Subscriptions FK cascades on school delete in some schemas, but to
      // be safe we explicitly clear the school's subs row first.
      await sb.from("subscriptions").delete().eq("school_id", s.id);
      await sb.from("schools").delete().eq("id", s.id);
    }
    console.log("   school + subscription cleared.");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1) Find or create the school. The seed-test-users.js script ties a
  //    super_teacher to each school; for a single-purpose visualizer test,
  //    we don't need one — schools.super_teacher_id is nullable. If you
  //    want a clean dashboard later, run scripts/seed-test-users.js first
  //    to get a Principal Patel + class structure too.
  // ─────────────────────────────────────────────────────────────────────────
  let school;
  {
    const { data: found } = await sb
      .from("schools")
      .select("id, name, join_code")
      .eq("name", SCHOOL_NAME)
      .maybeSingle();
    if (found) {
      school = found;
      console.log(`[1/4] School: reusing existing "${school.name}" (id=${school.id}).`);
    } else {
      const { data: created, error: schoolErr } = await sb
        .from("schools")
        .insert({ name: SCHOOL_NAME, join_code: randomCode(6) })
        .select("id, name, join_code")
        .single();
      if (schoolErr) throw new Error(`insert school: ${schoolErr.message}`);
      school = created;
      console.log(`[1/4] School: created "${school.name}" (id=${school.id}).`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2) Look up the active plan row for the requested slug. If migrations
  //    26+28 weren't applied (or the slug was edited away), we fail fast
  //    with a clear hint.
  // ─────────────────────────────────────────────────────────────────────────
  console.log(`[2/4] ${planSlug} plan...`);
  const { data: plan, error: planErr } = await sb
    .from("plans")
    .select("id, slug, tier, label, period_days, price_paise, per_student_price_paise")
    .eq("slug", planSlug)
    .eq("status", "active")
    .maybeSingle();
  if (planErr) throw new Error(`fetch ${planSlug} plan: ${planErr.message}`);
  if (!plan) {
    throw new Error(
      `No active plan with slug="${planSlug}". Apply supabase/migrations/28_seed_school_plans.sql first.`
    );
  }
  console.log(`   ✓ plan_id=${plan.id} tier=${plan.tier} label="${plan.label}"`);

  // ─────────────────────────────────────────────────────────────────────────
  // 3) Bind the school to school_plus via subscriptions. Update the existing
  //    row if there is one, otherwise insert. We keep school_id but null
  //    user_id (post-migration-11 the table allows that for school subs).
  //    expires_at is set 365 days out so the test session never expires
  //    mid-flow; override via SEED_PAID_DAYS.
  // ─────────────────────────────────────────────────────────────────────────
  console.log(`[3/4] School subscription (active, ${planSlug})...`);
  const days = Number(process.env.SEED_PAID_DAYS) || 365;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  // The subscriptions.tier column has a CHECK constraint that only allows
  // 'free' | 'individual' | 'premium' | 'premium_plus' (per migration 34).
  // School-tier plans go in via the legacy mapping used by
  // /api/admin/schools/[id]/set-plan: school_plus → premium_plus,
  // school_pilot / school_standard → premium. plan_id is the authoritative
  // source for feature gating; tier is just kept for legacy code paths
  // that haven't migrated to plan_id yet.
  const legacyTier =
    plan.tier === "school_plus" ? "premium_plus"
    : plan.tier.startsWith("school_") ? "premium"
    : plan.tier;

  const subPayload = {
    school_id: school.id,
    user_id: null,
    tier: legacyTier,
    plan_id: plan.id,
    status: "active",
    started_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    // Per-student plans store price on the plan row, not the subscription.
    // We log a non-zero "paid" amount so the row looks realistic — pick
    // a 200-student bracket × per_student_price_paise as a stand-in.
    price_paid_paise: (plan.per_student_price_paise || 0) * 200,
  };

  const { data: existingSub } = await sb
    .from("subscriptions")
    .select("id")
    .eq("school_id", school.id)
    .maybeSingle();
  if (existingSub?.id) {
    const { error: updErr } = await sb
      .from("subscriptions")
      .update(subPayload)
      .eq("id", existingSub.id);
    if (updErr) throw new Error(`update school subscription: ${updErr.message}`);
    console.log(`   ✓ updated existing subscription → ${plan.slug} (expires ${expiresAt.toISOString().slice(0, 10)})`);
  } else {
    const { error: insErr } = await sb.from("subscriptions").insert(subPayload);
    if (insErr) throw new Error(`insert school subscription: ${insErr.message}`);
    console.log(`   ✓ inserted subscription → ${plan.slug} (expires ${expiresAt.toISOString().slice(0, 10)})`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4) Create the student account (idempotent — bail with a clear hint if
  //    the email is already taken and --reset wasn't passed).
  // ─────────────────────────────────────────────────────────────────────────
  console.log(`[4/4] Student account...`);
  let userId;
  {
    const existing = await findUserByEmail(sb, email);
    if (existing && !flags.has("--reset")) {
      // Reuse the existing account — just patch the profile to match.
      userId = existing.id;
      console.log(`   ✓ reusing existing auth user ${email} (id=${userId})`);
      console.log(`     (pass --reset to wipe + recreate, e.g. to test the password again)`);
    } else {
      const { data, error } = await sb.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          role: "student",
          full_name: fullName,
          is_school_student: true,
        },
      });
      if (error) throw new Error(`createUser: ${error.message}`);
      userId = data.user?.id;
      console.log(`   ✓ created auth user ${email} (id=${userId})`);
    }
  }

  if (!userId) throw new Error("no user id after create — aborting profile patch");

  // The handle_new_user trigger creates a default profile row. We patch it
  // with the authoritative values, including the school_id binding that
  // makes featureAccess resolve the school's subscription instead of the
  // user's (which would be a personal Free row).
  {
    const { error: profErr } = await sb.from("profiles").upsert(
      {
        id: userId,
        role: "student",
        full_name: fullName,
        is_school_student: true,
        school_id: school.id,
      },
      { onConflict: "id" }
    );
    if (profErr) throw new Error(`upsertProfile: ${profErr.message}`);
  }
  console.log(`   ✓ profile bound to school (is_school_student=true, school_id=${school.id})`);

  console.log("\n──────────────────────────────────────────────────────────────");
  console.log(`✅ ${plan.label} test student is ready.`);
  console.log("──────────────────────────────────────────────────────────────");
  console.log(`  Username:  ${username}    ← type this in the username field`);
  console.log(`  Password:  ${password}`);
  console.log(`  Email:     ${email}    (internal — derived from username)`);
  console.log(`  School:    ${school.name} (id=${school.id})`);
  console.log(`  Plan:      ${plan.label} (slug=${plan.slug}, expires ${expiresAt.toISOString().slice(0, 10)})`);
  console.log("──────────────────────────────────────────────────────────────");
  console.log("\n📝 How to sign in (school students use a different surface):");
  console.log("   1. Go to http://localhost:3000/login/school");
  console.log(`   2. Username field: ${username}    (NOT the full email)`);
  console.log(`   3. Password field: ${password}`);
  // Per-plan capability hint — tells the tester what they SHOULD see
  // unlocked on this account so the test pass/fail is unambiguous.
  if (planSlug === "school_plus") {
    console.log("\nConcept Visualizer + Voice AI Teacher should be UNLOCKED.\n");
  } else {
    console.log("\nConcept Visualizer + Voice AI Teacher should be HIDDEN (only");
    console.log(`unlocked on School Plus; the ${planSlug} plan does not include them).\n`);
  }
}

main().catch((e) => {
  console.error("\n❌ Unexpected error:", e.message || e);
  process.exit(1);
});
