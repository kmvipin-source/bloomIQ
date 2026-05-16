// Create a test ZCORIQ account that bypasses Supabase email confirmation.
// Uses the service-role key to mark the email as already confirmed.
//
// Usage (from project root):
//   node scripts/create-test-account.js student
//   node scripts/create-test-account.js teacher
//   node scripts/create-test-account.js student my.test@example.com MyPass123 "Test Kid"
//
// Defaults if no args:
//   role     = student
//   email    = test.<role>@example.com
//   password = TestPass123!
//   name     = "Test <Role>"
//
// You can re-run with the same email and pass --reset to wipe + recreate:
//   node scripts/create-test-account.js student --reset

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

  const role = (args[0] || "student").toLowerCase();
  if (role !== "teacher" && role !== "student") {
    console.error('❌ First arg must be "teacher" or "student".');
    process.exit(1);
  }

  const email = args[1] || `test.${role}@example.com`;
  const password = args[2] || "TestPass123!";
  const fullName = args[3] || (role === "teacher" ? "Test Teacher" : "Test Student");

  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`\nCreating ${role} test account…`);
  console.log(`  email: ${email}`);
  console.log(`  name:  ${fullName}\n`);

  // Optional reset: delete any existing user with this email first
  if (flags.has("--reset")) {
    console.log("--reset: looking for existing user to remove…");
    const { data: list, error: listErr } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listErr) {
      console.error("listUsers failed:", listErr.message);
      process.exit(1);
    }
    const existing = list.users.find((u) => (u.email || "").toLowerCase() === email.toLowerCase());
    if (existing) {
      const { error: delErr } = await sb.auth.admin.deleteUser(existing.id);
      if (delErr) {
        console.error("Delete failed:", delErr.message);
        process.exit(1);
      }
      console.log("Existing user deleted.\n");
    } else {
      console.log("No existing user with that email.\n");
    }
  }

  const { data, error } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // ← key: skip the email verification flow
    user_metadata: {
      role,
      full_name: fullName,
      is_school_student: false,
    },
  });

  if (error) {
    console.error("❌", error.message);
    if (error.message.toLowerCase().includes("registered")) {
      console.error("   (Tip: re-run with --reset to wipe and recreate this account.)");
    }
    process.exit(1);
  }

  // The handle_new_user trigger should have created the profile + subscription.
  // Verify, and patch profile fields the trigger doesn't know about.
  const userId = data.user?.id;
  if (userId) {
    await sb.from("profiles").upsert({
      id: userId,
      role,
      full_name: fullName,
      is_school_student: false,
    }, { onConflict: "id" });
  }

  console.log("✅ Account ready.\n");
  console.log("───────────────────────────────────────");
  console.log(`  Email:    ${email}`);
  console.log(`  Password: ${password}`);
  console.log(`  Role:     ${role}`);
  console.log(`  User ID:  ${userId || "(not returned)"}`);
  console.log("───────────────────────────────────────");
  console.log("\nGo to http://localhost:3000/login and sign in with those credentials.");
  console.log("No email confirmation needed — it's already marked verified.\n");
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
