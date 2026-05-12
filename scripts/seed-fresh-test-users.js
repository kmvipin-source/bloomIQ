// Seed a SECOND, parallel set of BloomIQ test accounts for manual testing.
// Doesn't touch the existing "Test Academy" tree at all — uses brand-new
// emails, school name, class name, and student usernames. Run alongside
// seed-test-users.js without --reset and you'll have BOTH sets live.
//
// Creates:
//   1) A new school ("Sunrise High")
//   2) A new platform admin
//   3) A new school admin (super_teacher) tied to "Sunrise High"
//   4) A new deputy admin
//   5) A new primary teacher + co-teacher, both on a new class
//   6) Three new school students enrolled in that class
//   7) Four new independent students: 2 free, 1 premium, 1 premium-plus
//
// Idempotent: pass --reset to wipe ONLY this script's accounts/school
// before recreating. The original seed-test-users.js tree is untouched.
// All accounts skip Supabase email confirmation.
//
// Usage (from project root):
//   node scripts/seed-fresh-test-users.js
//   node scripts/seed-fresh-test-users.js --reset
//   node scripts/seed-fresh-test-users.js --plan school_plus
//   node scripts/seed-fresh-test-users.js --plan school_standard --reset
//
// --plan binds the new school to the named plan with an active 365-day
// subscription. Without --plan, the school stays "Not subscribed".
//
// Defaults can be overridden with env vars:
//   SEED_PASSWORD=MyPass123 node scripts/seed-fresh-test-users.js
//
// Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

// ─── env loader ──────────────────────────────────────────────────────────────
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

// ─── config (everything below uses fresh names, no overlap with seed-test-users.js) ──
const PASSWORD = process.env.SEED_PASSWORD || "FreshPass123!";
const SCHOOL_NAME = process.env.FRESH_SCHOOL_NAME || "Sunrise High";
const SCHOOL_DOMAIN = "bloomiq.invalid"; // synthetic domain matches the school-student login page

const TEST_USERS = {
  platformAdmin: {
    email: "vipin.qa@bloomiq.example.com",
    fullName: "Vipin QA",
    role: "teacher",
    isSchoolStudent: false,
  },
  schoolAdmin: {
    email: "head.hema@sunrise.example.com",
    fullName: "Head Hema",
    role: "super_teacher",
    isSchoolStudent: false,
  },
  deputyAdmin: {
    email: "vice.vihaan@sunrise.example.com",
    fullName: "Vice Vihaan",
    role: "super_teacher",
    isSchoolStudent: false,
  },
  primaryTeacher: {
    email: "mr.dev@sunrise.example.com",
    fullName: "Mr. Dev Patel",
    role: "teacher",
    isSchoolStudent: false,
  },
  coTeacher: {
    email: "ms.tara@sunrise.example.com",
    fullName: "Ms. Tara Khan",
    role: "teacher",
    isSchoolStudent: false,
  },
  schoolStudents: [
    { username: "ravi",   fullName: "Ravi Sharma"  },
    { username: "sneha",  fullName: "Sneha Reddy"  },
    { username: "amir",   fullName: "Amir Hussain" },
  ].map((s) => ({
    ...s,
    email: `${s.username}@${SCHOOL_DOMAIN}`,
    role: "student",
    isSchoolStudent: true,
  })),
  independentStudents: [
    { email: "free.zoya@example.com",  fullName: "Zoya (Free)",         planSlug: null },
    { email: "free.aarav@example.com", fullName: "Aarav (Free)",        planSlug: null },
    { email: "premium.neha@example.com", fullName: "Neha (Premium)",    planSlug: "premium_monthly" },
    { email: "pplus.arjun@example.com",  fullName: "Arjun (Premium+)",  planSlug: "premium_plus_monthly" },
  ].map((s) => ({ ...s, role: "student", isSchoolStudent: false })),
};

const CLASS_DEF = {
  name: "Grade 7 - Science",
  grade: "7",
  subject: "Science",
  section: "A",
};

// ─── helpers ─────────────────────────────────────────────────────────────────
async function findUserByEmail(sb, email) {
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
    email_confirm: true,
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

  const rawArgv = process.argv.slice(2);
  const flags = new Set();
  let planFlag = null;
  for (let i = 0; i < rawArgv.length; i++) {
    const tok = rawArgv[i];
    if (tok === "--plan") planFlag = (rawArgv[++i] || "").toLowerCase();
    else if (tok.startsWith("--plan=")) planFlag = tok.slice("--plan=".length).toLowerCase();
    else if (tok.startsWith("--")) flags.add(tok);
  }
  const reset = flags.has("--reset");

  const ALLOWED_SCHOOL_PLANS = ["school_pilot", "school_standard", "school_plus"];
  if (planFlag && !ALLOWED_SCHOOL_PLANS.includes(planFlag)) {
    console.error(`❌ Invalid --plan "${planFlag}". Allowed: ${ALLOWED_SCHOOL_PLANS.join(", ")}.`);
    process.exit(1);
  }

  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

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
    console.log(`\n🧹 --reset: wiping ONLY this script's accounts + "${SCHOOL_NAME}"...`);
    console.log(`   (the original "Test Academy" tree is left alone)`);
    for (const email of allEmails) {
      const removed = await deleteUserIfExists(sb, email);
      if (removed) console.log(`   - removed ${email}`);
    }
    {
      const { data: prior } = await sb.from("schools").select("id").eq("name", SCHOOL_NAME);
      for (const s of prior || []) {
        await sb.from("subscriptions").delete().eq("school_id", s.id);
      }
    }
    const { error: schoolDelErr } = await sb.from("schools").delete().eq("name", SCHOOL_NAME);
    if (schoolDelErr) console.warn(`   ⚠ school delete warning: ${schoolDelErr.message}`);
    else console.log(`   - removed school "${SCHOOL_NAME}" (and any subscription row)`);
    await sb.from("classes").delete().eq("name", CLASS_DEF.name);
    console.log(`   - removed class "${CLASS_DEF.name}"`);
    console.log("✅ Reset done.\n");
  }

  console.log(`🌱 Seeding fresh "${SCHOOL_NAME}" tree + new test users...`);

  // 0) Platform admin
  console.log("\n[0/7] Platform admin (BloomIQ staff)...");
  const pa = TEST_USERS.platformAdmin;
  const paUser = await createAuthUser(sb, { ...pa, password: PASSWORD });
  await upsertProfile(sb, paUser.id, {
    role: pa.role,
    fullName: pa.fullName,
    isSchoolStudent: pa.isSchoolStudent,
  });
  {
    const { error: paErr } = await sb
      .from("profiles")
      .update({ platform_admin: true })
      .eq("id", paUser.id);
    if (paErr) throw new Error(`set platform_admin for ${pa.email}: ${paErr.message}`);
  }
  console.log(`   ✓ ${pa.email} (logs in at /staff, not /login)`);

  // 1) School admin
  console.log("[1/7] School admin (super_teacher) — the Admin HEAD...");
  const sa = TEST_USERS.schoolAdmin;
  const saUser = await createAuthUser(sb, { ...sa, password: PASSWORD });
  await upsertProfile(sb, saUser.id, {
    role: sa.role,
    fullName: sa.fullName,
    isSchoolStudent: sa.isSchoolStudent,
  });
  console.log(`   ✓ ${sa.email}`);

  // 2) School row
  console.log("[2/7] School row...");
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
  await sb.from("profiles").update({ school_id: school.id }).eq("id", saUser.id);

  // 2.1) Optional plan binding
  if (planFlag) {
    console.log(`[2.1/7] Binding "${school.name}" to plan ${planFlag}...`);
    const { data: plan, error: planErr } = await sb
      .from("plans")
      .select("id, slug, tier, label, period_days, per_student_price_paise")
      .eq("slug", planFlag)
      .eq("status", "active")
      .maybeSingle();
    if (planErr) throw new Error(`fetch plan ${planFlag}: ${planErr.message}`);
    if (!plan) {
      throw new Error(`No active plan with slug="${planFlag}". Apply migrations/28_seed_school_plans.sql first.`);
    }
    const legacyTier =
      plan.tier === "school_plus" ? "premium_plus"
      : plan.tier.startsWith("school_") ? "premium"
      : plan.tier;
    const subDays = Number(process.env.SEED_PAID_DAYS) || 365;
    const subExpiresAt = new Date(Date.now() + subDays * 86400000).toISOString();
    const { error: subErr } = await sb.from("subscriptions").insert({
      school_id: school.id,
      user_id: null,
      tier: legacyTier,
      plan_id: plan.id,
      status: "active",
      started_at: new Date().toISOString(),
      expires_at: subExpiresAt,
      price_paid_paise: (plan.per_student_price_paise || 0) * 200,
    });
    if (subErr) throw new Error(`insert school subscription: ${subErr.message}`);
    console.log(`   ✓ subscription active (plan_id=${plan.id}, expires ${subExpiresAt.slice(0, 10)})`);
  } else {
    console.log(`[2.1/7] Plan: (none — pass --plan school_pilot/standard/plus to bind one)`);
  }

  // 2.5) Deputy
  console.log("[2.5/7] Deputy Admin Head (pre-promoted)...");
  const da = TEST_USERS.deputyAdmin;
  const daUser = await createAuthUser(sb, { ...da, password: PASSWORD });
  await upsertProfile(sb, daUser.id, {
    role: da.role,
    fullName: da.fullName,
    isSchoolStudent: da.isSchoolStudent,
    schoolId: school.id,
  });
  console.log(`   ✓ ${da.email} (logs in same as Admin Head, sees same dashboard)`);

  // 3) Primary + co teachers
  console.log("[3/7] Primary + co-teacher accounts...");
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

  // 4) Class
  console.log("[4/7] Class + teacher assignments...");
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

  // 5) School students
  console.log("[5/7] School students (enrolled in the class)...");
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

  // 6) Independent students
  console.log("[6/7] Independent students (no school)...");
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
          `No active plan with slug="${slug}". Run 26_seed_initial_plans.sql first.`
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
      const plan = planBySlug.get(s.planSlug);
      const now = new Date();
      const days = Number(process.env.SEED_PAID_DAYS) || Math.max(plan.period_days, 365);
      const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      const tierForSubs = plan.tier;
      const subPayload = {
        tier: tierForSubs,
        status: "active",
        plan_id: plan.id,
        started_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        price_paid_paise: plan.price_paise || 0,
      };
      const { data: updated, error: updErr } = await sb
        .from("subscriptions")
        .update(subPayload)
        .eq("user_id", u.id)
        .select("id");
      if (updErr) throw new Error(`update subscription for ${s.email}: ${updErr.message}`);
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
  console.log("✅ Fresh seed complete. All accounts use password:  " + PASSWORD);
  console.log("═".repeat(78));
  const rows = [
    ["Role",              "Login (sign-in surface)",                          "Goes to"],
    ["Platform Admin",    TEST_USERS.platformAdmin.email + "  → /staff",      "/admin/onboard-school"],
    ["Admin Head",        TEST_USERS.schoolAdmin.email,                       "/school"],
    ["Deputy Admin",      TEST_USERS.deputyAdmin.email,                       "/school"],
    ["Primary Teacher",   TEST_USERS.primaryTeacher.email,                    "/teacher"],
    ["Co-Teacher",        TEST_USERS.coTeacher.email,                         "/teacher"],
    ...TEST_USERS.schoolStudents.map((s, i) => [
      `School Student ${i + 1}`, s.username + "  (just username)", "/student",
    ]),
    ...TEST_USERS.independentStudents.map((s) => {
      const tier = s.planSlug
        ? (s.planSlug.includes("plus") ? "Premium Plus" : "Premium")
        : "Free";
      return [`Indie Student (${tier})`, s.email, "/student"];
    }),
  ];
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
  console.error("\n❌ Fresh seed failed:", e.message || e);
  console.error("   Tip: re-run with --reset to clear partial state from this script (existing 'Test Academy' tree is untouched).\n");
  process.exit(1);
});
