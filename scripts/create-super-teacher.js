// Create a super_teacher test account that bypasses email confirmation.
//
// Usage:
//   node scripts/create-super-teacher.js
//   node scripts/create-super-teacher.js my.principal@school.edu MyPass123 "Principal Patel"
//
// Defaults:
//   email = principal@example.com
//   password = TestPass123!
//   name = "Test Principal"

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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

async function main() {
  const env = loadEnvLocal();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("❌ Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }

  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
  const email = args[0] || "principal@example.com";
  const password = args[1] || "TestPass123!";
  const fullName = args[2] || "Test Principal";

  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  console.log(`\nCreating super_teacher: ${email}\n`);

  if (flags.has("--reset")) {
    const { data: list } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const existing = list.users.find((u) => (u.email || "").toLowerCase() === email.toLowerCase());
    if (existing) {
      await sb.auth.admin.deleteUser(existing.id);
      console.log("Existing user deleted.\n");
    }
  }

  const { data, error } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      role: "super_teacher",
      full_name: fullName,
      is_school_student: false,
    },
  });
  if (error) {
    console.error("❌", error.message);
    if (error.message.toLowerCase().includes("registered")) {
      console.error("   (Tip: re-run with --reset to wipe and recreate.)");
    }
    process.exit(1);
  }

  // The new-user trigger defaults role to 'student' if metadata isn't honored;
  // patch the role explicitly to be safe.
  const userId = data.user?.id;
  if (userId) {
    await sb.from("profiles").upsert({
      id: userId,
      role: "super_teacher",
      full_name: fullName,
      is_school_student: false,
    }, { onConflict: "id" });
  }

  console.log("✅ Super-teacher account ready.\n");
  console.log("───────────────────────────────────────");
  console.log(`  Email:    ${email}`);
  console.log(`  Password: ${password}`);
  console.log(`  Role:     super_teacher`);
  console.log(`  User ID:  ${userId}`);
  console.log("───────────────────────────────────────");
  console.log("\nGo to /login. After sign-in you'll land on /school where you can name your school and invite teachers.\n");
}

main().catch((e) => { console.error("Unexpected error:", e); process.exit(1); });
