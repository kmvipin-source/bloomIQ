// Seed a complete BloomIQ org tree for manual testing.
//
// Creates, in order:
//   1) A school ("Test Academy")
//   2) A school admin (super_teacher) tied to that school
//   3) A primary teacher tied to a class as primary
//   4) A co-teacher tied to the same class as co
//   5) Three school students enrolled in that class
//   6) Two independent students (no school)
//
// Idempotent: pass --reset to wipe any prior run before recreating.
// All accounts skip Supabase email confirmation (email_confirm: true), so
// you can sign in immediately at /login.
//
// Usage (from project root):
//   node scripts/seed-test-users.js
//   node scripts/seed-test-users.js --reset
//
// Defaults can be overridden with env vars at invocation time:
//   SEED_PASSWORD=MyPass123 node scripts/seed-test-users.js
//   SEED_SCHOOL_NAME="Demo High" node scripts/seed-test-users.js
//
// Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

// ─── env loader (same pattern as the other scripts) ──────────────────────────
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

// 6-character uppercase alphanumeric (matches the look-and-feel of the rest of the app)
function randomCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to reduce ambiguity
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ─── config ──────────────────────────────────────────────────────────────────
const PASSWORD = process.env.SEED_PASSWORD || "TestPass123!";
const SCHOOL_NAME = process.env.SEED_SCHOOL_NAME || "Test Academy";
const SCHOOL_DOMAIN = "bloomiq.invalid"; // synthetic domain for school-student emails (matches login page)

// All emails the script will manage — listed here so --reset knows what to wipe.
const TEST_USERS = {
  // BloomIQ internal staff. Logs in at /staff (the hidden platform-admin
  // route), not the public /login. profile.platform_admin = true.
  platformAdmin: {
    email: "ops@bloomiq.example.com",
    fullName: "Ops Anand",
    role: "teacher",          // role is irrelevant for platform_admin gating;
    isSchoolStudent: false,   //   we just need any non-null role for the trigger.
  },
  schoolAdmin: {
    email: "principal@testacademy.example.com",
    fullName: "Principal Patel",
    role: "super_teacher",
    isSchoolStudent: false,
  },
  // Pre-promoted Deputy Admin Head (added after migration 47). Same school
  // as the primary admin; role flips to super_teacher post-seed so the user
  // can immediately log in as a Deputy and exercise the promote/demote +
  // acting-cover flows without having to click through the UI first.
  deputyAdmin: {
    email: "deputy@testacademy.example.com",
    fullName: "Deputy Devika",
    role: "super_teacher",
    isSchoolStudent: false,
  },
  primaryTeacher: {
    email: "ms.priya@testacademy.example.com",
    fullName: "Ms. Priya Sharma",
    role: "teacher",
    isSchoolStudent: false,
  },
  coTeacher: {
    email: "mr.raj@testacademy.example.com",
    fullName: "Mr. Raj Kumar",
    role: "teacher",
    isSchoolStudent: false,
  },
  schoolStudents: [
    { username: "ananya", fullName: "Ananya Iyer" },
    { username: "kabir",  fullName: "Kabir Singh" },
    { username: "diya",   fullName: "Diya Menon"  },
  ].map((s) => ({
    ...s,
    email: `${s.username}@${SCHOOL_DOMAIN}`,
    role: "student",
    isSchoolStudent: true,
  })),
  independentStudents: [
    { email: "indie.alice@example.com", fullName: "Alice Independent", planSlug: null },
    { email: "indie.bob@example.com",   fullName: "Bob Independent",   planSlug: null },
    // Paid-tier test accounts. planSlug is looked up at seed-time to find the
    // currently-active plan row; the new-user trigger creates a free
    // subscription for these (since is_school_student=false), and we then
    // upgrade that subscription to point at the chosen plan.
    {
      email: "premium.student@example.com",
      fullName: "Premium Student",
      planSlug: "premium_monthly", // tier='premium'
    },
    {
      email: "premiumplus.student@example.com",
      fullName: "Premium Plus Student",
      planSlug: "premium_plus_monthly", // tier='premium_plus'
    },
  ].map((s) => ({ ...s, role: "student", isSchoolStudent: false })),
};

// Class definition — primary + co teachers + school students all enrolled here.
const CLASS_DEF = {
  name: "Grade 6 - Mathematics A",
  grade: "6",
  subject: "Mathematics",
  section: "A",
};

// ─── helpers ─────────────────────────────────────────────────────────────────
async function findUserByEmail(sb, email) {
  // listUsers paginates; for a test seed, 1000 is plenty.
  const { data, error } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  return data.users.find((u) => (u.email || "").toLowerCase() === email.toLowerCase()) || null;
}

async function deleteUserIfExists(sb, email) {
  const u = await findUserByEmail(sb, email);
  if (u) {
    await sb.auth.admin.deleteUser(u.id);
    return true;
  }
  return false;
}

async function createAuthUser(sb, { email, password, role, fullName, isSchoolStudent }) {
  const { data, error } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // skip confirmation flow — ready to log in immediately
    user_metadata: {
      role,
      full_name: fullName,
      is_school_student: isSchoolStudent,
    },
  });
  if (error) throw new Error(`createUser(${email}): ${error.message}`);
  return data.user;
}

async function upsertProfile(sb, userId, { role, fullName, isSchoolStudent, schoolId = null }) {
  // The handle_new_user trigger may have created a default profile already.
  // Patch it with our authoritative values.
  const row = {
    id: userId,
    role,
    full_name: fullName,
    is_school_student: isSchoolStudent,
  };
  if (schoolId !== null) row.school_id = schoolId;
  const { error } = await sb.from("profiles").upsert(row, { onConflict: "id" });
  if (error) throw new Error(`upsertProfile(${userId}): ${error.message}`);
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  const env = loadEnvLocal();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("❌ Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }

  const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
  const reset = flags.has("--reset");

  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Collect every email this script manages, for --reset.
  const allEmails = [
    TEST_USERS.platformAdmin.email,
    TEST_USERS.schoolAdmin.email,
    TEST_USERS.deputyAdmin.email,
    TEST_USERS.primaryTeacher.email,
    TEST_USERS.coTeacher.email,
    ...TEST_USERS.schoolStudents.map((s) => s.email),
    ...TEST_USERS.independentStudents.map((s) => s.email),
  ];

  if (reset) {
    console.log("\n🧹 --reset: wiping prior test users + their school...");
    // Delete users first (cascades wipe their profiles + class memberships).
    for (const email of allEmails) {
      const removed = await deleteUserIfExists(sb, email);
      if (removed) console.log(`   - removed ${email}`);
    }
    // Then wipe schools created with our test name (just in case).
    const { error: schoolDelErr } = await sb.from("schools").delete().eq("name", SCHOOL_NAME);
    if (schoolDelErr) console.warn(`   ⚠ school delete warning: ${schoolDelErr.message}`);
    else console.log(`   - removed school "${SCHOOL_NAME}"`);
    // And classes by name (school FK cascades, but in case schools were already gone).
    await sb.from("classes").delete().eq("name", CLASS_DEF.name);
    console.log(`   - removed class "${CLASS_DEF.name}"`);
    console.log("✅ Reset done.\n");
  }

  console.log(`🌱 Seeding "${SCHOOL_NAME}" + test users...`);

  // 0) Platform admin — BloomIQ internal staff. Must exist before anything
  //    else in production (this is the user who runs /admin/onboard-school
  //    to invite the Admin Head). For seed purposes we create it standalone:
  //    no school, no class, no plan.
  console.log("\n[0/8] Platform admin (BloomIQ staff)...");
  const pa = TEST_USERS.platformAdmin;
  const paUser = await createAuthUser(sb, { ...pa, password: PASSWORD });
  await upsertProfile(sb, paUser.id, {
    role: pa.role,
    fullName: pa.fullName,
    isSchoolStudent: pa.isSchoolStudent,
  });
  // Flip the platform_admin bit. The /staff login route gates on this,
  // not on profiles.role. Profiles.role stays whatever it was (typically
  // "teacher") — platform admins have an exclusive surface at /admin/*.
  {
    const { error: paErr } = await sb
      .from("profiles")
      .update({ platform_admin: true })
      .eq("id", paUser.id);
    if (paErr) throw new Error(`set platform_admin for ${pa.email}: ${paErr.message}`);
  }
  console.log(`   ✓ ${pa.email} (logs in at /staff, not /login)`);

  // 1) School admin (super_teacher) — created BEFORE the school so we have an admin ID to bind.
  console.log("[1/8] School admin (super_teacher) — the Admin HEAD...");
  const sa = TEST_USERS.schoolAdmin;
  const saUser = await createAuthUser(sb, { ...sa, password: PASSWORD });
  await upsertProfile(sb, saUser.id, {
    role: sa.role,
    fullName: sa.fullName,
    isSchoolStudent: sa.isSchoolStudent,
  });
  console.log(`   ✓ ${sa.email}`);

  // 2) School row, owned by the admin.
  console.log("[2/6] School row...");
  const { data: school, error: schoolErr } = await sb
    .from("schools")
    .insert({
      name: SCHOOL_NAME,
      super_teacher_id: saUser.id,
      join_code: randomCode(6),
    })
    .select()
    .single();
  if (schoolErr) throw new Error(`insert school: ${schoolErr.message}`);
  console.log(`   ✓ ${school.name} (id=${school.id}, join_code=${school.join_code})`);
  // Link admin's profile to the school.
  await sb.from("profiles").update({ school_id: school.id }).eq("id", saUser.id);

  // 2.5) Deputy Admin Head — pre-promoted to super_teacher on the same
  //      school. They appear as "Deputy" on /school/teachers because
  //      schools.super_teacher_id != them but their role IS super_teacher.
  console.log("[2.5/8] Deputy Admin Head (pre-promoted)...");
  const da = TEST_USERS.deputyAdmin;
  const daUser = await createAuthUser(sb, { ...da, password: PASSWORD });
  await upsertProfile(sb, daUser.id, {
    role: da.role,
    fullName: da.fullName,
    isSchoolStudent: da.isSchoolStudent,
    schoolId: school.id,
  });
  console.log(`   ✓ ${da.email} (logs in same as Admin Head, sees same dashboard, can\'t transfer the Head role)`);

  // 3) Primary + co teachers.
  console.log("[3/8] Primary + co-teacher accounts...");
  const pt = TEST_USERS.primaryTeacher;
  const ct = TEST_USERS.coTeacher;
  const ptUser = await createAuthUser(sb, { ...pt, password: PASSWORD });
  await upsertProfile(sb, ptUser.id, {
    role: pt.role,
    fullName: pt.fullName,
    isSchoolStudent: pt.isSchoolStudent,
    schoolId: school.id,
  });
  console.log(`   ✓ ${pt.email} (will be PRIMARY)`);
  const ctUser = await createAuthUser(sb, { ...ct, password: PASSWORD });
  await upsertProfile(sb, ctUser.id, {
    role: ct.role,
    fullName: ct.fullName,
    isSchoolStudent: ct.isSchoolStudent,
    schoolId: school.id,
  });
  console.log(`   ✓ ${ct.email} (will be CO)`);

  // 4) Class, owned by the primary teacher.
  console.log("[4/8] Class + teacher assignments...");
  const { data: klass, error: classErr } = await sb
    .from("classes")
    .insert({
      ...CLASS_DEF,
      owner_id: ptUser.id,
      school_id: school.id,
      join_code: randomCode(6),
    })
    .select()
    .single();
  if (classErr) throw new Error(`insert class: ${classErr.message}`);
  console.log(`   ✓ ${klass.name} (id=${klass.id}, join_code=${klass.join_code})`);
  // class_teachers rows for primary + co. Use upsert: a DB trigger likely
  // auto-creates the primary row from classes.owner_id, so a plain insert
  // would hit a duplicate-key error on the (class_id, teacher_id) primary key.
  const { error: ctInsertErr } = await sb
    .from("class_teachers")
    .upsert(
      [
        { class_id: klass.id, teacher_id: ptUser.id, role: "primary", subject: CLASS_DEF.subject },
        { class_id: klass.id, teacher_id: ctUser.id, role: "co",      subject: CLASS_DEF.subject },
      ],
      { onConflict: "class_id,teacher_id" }
    );
  if (ctInsertErr) throw new Error(`upsert class_teachers: ${ctInsertErr.message}`);
  console.log(`   ✓ class_teachers: 1 primary + 1 co`);

  // 5) School students enrolled in the class.
  console.log("[5/8] School students (enrolled in the class)...");
  for (const s of TEST_USERS.schoolStudents) {
    const u = await createAuthUser(sb, { ...s, password: PASSWORD });
    await upsertProfile(sb, u.id, {
      role: s.role,
      fullName: s.fullName,
      isSchoolStudent: s.isSchoolStudent,
      schoolId: school.id,
    });
    const { error: memErr } = await sb
      .from("class_members")
      .insert({ class_id: klass.id, student_id: u.id });
    if (memErr) throw new Error(`enroll ${s.email}: ${memErr.message}`);
    console.log(`   ✓ ${s.username} (sign-in: just type "${s.username}", no @-domain)`);
  }

  // 6) Independent students (no school, no class). Paid-tier ones get their
  //    auto-created free subscription upgraded to the requested plan.
  console.log("[6/8] Independent students (no school)...");

  // Pre-fetch the active plan rows for any planSlug we'll need, so we fail
  // fast with a clear error if the plans seed never ran.
  const neededSlugs = [...new Set(
    TEST_USERS.independentStudents.map((s) => s.planSlug).filter(Boolean)
  )];
  const planBySlug = new Map();
  if (neededSlugs.length > 0) {
    const { data: plansRows, error: plansErr } = await sb
      .from("plans")
      .select("id, slug, tier, period_days, price_paise")
      .in("slug", neededSlugs)
      .eq("status", "active");
    if (plansErr) throw new Error(`fetch plans: ${plansErr.message}`);
    for (const p of plansRows || []) planBySlug.set(p.slug, p);
    for (const slug of neededSlugs) {
      if (!planBySlug.has(slug)) {
        throw new Error(
          `No active plan with slug="${slug}". ` +
          `Run migrations/seed (26_seed_initial_plans.sql) before seeding paid users.`
        );
      }
    }
  }

  for (const s of TEST_USERS.independentStudents) {
    const u = await createAuthUser(sb, { ...s, password: PASSWORD });
    await upsertProfile(sb, u.id, {
      role: s.role,
      fullName: s.fullName,
      isSchoolStudent: s.isSchoolStudent,
    });

    if (s.planSlug) {
      // Upgrade the trigger-created free subscription to the paid plan.
      // We don't use upsert here because PostgREST can't always see the
      // inline UNIQUE on subscriptions.user_id and rejects ON CONFLICT.
      // The handle_new_user trigger guarantees a row already exists for
      // independent students (role=student, is_school_student=false), so
      // a plain update suffices. Fall back to insert if it didn't (e.g.
      // trigger was bypassed for some reason).
      const plan = planBySlug.get(s.planSlug);
      const now = new Date();
      // Use 365 days for testing convenience even if period_days is 30, so
      // the test user doesn't expire mid-test session. Override via env if
      // you want to actually test renewals.
      const days = Number(process.env.SEED_PAID_DAYS) || Math.max(plan.period_days, 365);
      const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      const tierForSubs = plan.tier; // 'premium' or 'premium_plus'
      const subPayload = {
        tier: tierForSubs,
        status: "active",
        plan_id: plan.id,
        started_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        price_paid_paise: plan.price_paise || 0,
      };

      // Try UPDATE first.
      const { data: updated, error: updErr } = await sb
        .from("subscriptions")
        .update(subPayload)
        .eq("user_id", u.id)
        .select("id");
      if (updErr) throw new Error(`update subscription for ${s.email}: ${updErr.message}`);

      // If the trigger didn't create a row (defensive), insert one.
      if (!updated || updated.length === 0) {
        const { error: insErr } = await sb
          .from("subscriptions")
          .insert({ user_id: u.id, ...subPayload });
        if (insErr) throw new Error(`insert subscription for ${s.email}: ${insErr.message}`);
      }

      console.log(`   ✓ ${s.email}  →  ${plan.slug} (tier=${plan.tier}, expires ${expiresAt.toISOString().slice(0, 10)})`);
    } else {
      console.log(`   ✓ ${s.email}  (free)`);
    }
  }

  // ─── credentials table ─────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(78));
  console.log("✅ Seed complete. All accounts use password:  " + PASSWORD);
  console.log("═".repeat(78));
  const rows = [
    ["Role",              "Login (sign-in surface)",                  "Goes to"],
    ["Platform Admin",    TEST_USERS.platformAdmin.email + "  → /staff",  "/admin/onboard-school"],
    ["Admin Head",        TEST_USERS.schoolAdmin.email,               "/school"],
    ["Deputy Admin",      TEST_USERS.deputyAdmin.email,               "/school"],
    ["Primary Teacher",   TEST_USERS.primaryTeacher.email,            "/teacher"],
    ["Co-Teacher",        TEST_USERS.coTeacher.email,                 "/teacher"],
    ...TEST_USERS.schoolStudents.map((s, i) => [
      `School Student ${i + 1}`, s.username + "  (just username)", "/student",
    ]),
    ...TEST_USERS.independentStudents.map((s, i) => {
      const tier = s.planSlug
        ? (s.planSlug.includes("plus") ? "Premium Plus" : "Premium")
        : "Free";
      return [`Indie Student (${tier})`, s.email, "/student"];
    }),
  ];
  // Pretty-print as a fixed-width table.
  const widths = [0, 0, 0];
  for (const r of rows) for (let i = 0; i < 3; i++) widths[i] = Math.max(widths[i], r[i].length);
  for (const r of rows) {
    console.log(
      "  " +
        r[0].padEnd(widths[0]) + "  │  " +
        r[1].padEnd(widths[1]) + "  │  " +
        r[2].padEnd(widths[2])
    );
  }
  console.log("═".repeat(78));
  console.log(`\nSchool join code:  ${school.join_code}`);
  console.log(`Class join code:   ${klass.join_code}`);
  console.log("\nGo to http://localhost:3000/login and try them out.\n");
}

main().catch((e) => {
  console.error("\n❌ Seed failed:", e.message || e);
  console.error("   Tip: re-run with --reset to clear prior partial state.\n");
  process.exit(1);
});
