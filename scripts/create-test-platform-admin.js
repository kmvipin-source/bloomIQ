// Create a second platform-admin account for testing the two-eyes flow.
//
// You're (Vipin) the bootstrap platform admin today. With only one admin,
// `plans_two_eyes` blocks normal approval and the proposal queue runs in
// "bootstrap mode" — fine for smoke testing, but you can't exercise real
// approver-edits / cross-admin reject flows. Run this script once, sign in
// as the test admin in another browser/incognito, and you have two-eyes.
//
// Usage (defaults shown):
//   node scripts/create-test-platform-admin.js
//   node scripts/create-test-platform-admin.js test_admin@bloomiq.local TestAdmin123! "Test Platform Admin"
//   node scripts/create-test-platform-admin.js --reset           (wipe & recreate first)
//
// Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.
// Service role bypasses RLS — never run in production with a real admin email.

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
  const email = args[0] || "test_admin@bloomiq.local";
  const password = args[1] || "TestAdmin123!";
  const fullName = args[2] || "Test Platform Admin";

  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`\nCreating test platform_admin: ${email}\n`);

  // ---- Optional: wipe an existing user with this email so the script is
  // idempotent. Without --reset we keep the existing row and just re-apply
  // the platform_admin flag (so re-running is also safe).
  const { data: list } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const existing = list.users.find((u) => (u.email || "").toLowerCase() === email.toLowerCase());

  if (existing && flags.has("--reset")) {
    await sb.auth.admin.deleteUser(existing.id);
    console.log("Existing user deleted (--reset).\n");
  }

  // ---- Find the current bootstrap admin's id so we can set
  // platform_admin_granted_by on the new admin's profile. The DB has a
  // CHECK that approved_by != created_by on plans rows; that doesn't apply
  // to profiles, but stamping granted_by correctly keeps the audit honest.
  // Picks the OLDEST existing platform admin (the bootstrap one).
  const { data: bootstrap } = await sb
    .from("profiles")
    .select("id")
    .eq("platform_admin", true)
    .order("platform_admin_granted_at", { ascending: true, nullsFirst: true })
    .limit(1)
    .maybeSingle();
  const bootstrapId = bootstrap?.id || null;

  let userId;

  if (existing && !flags.has("--reset")) {
    console.log("User already exists — reusing and (re-)applying platform_admin flag.\n");
    userId = existing.id;
  } else {
    const { data, error } = await sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        // The handle_new_user trigger reads `role` from user_metadata into
        // profiles.role. We use 'teacher' here because (a) platform_admin
        // is a separate flag, not a role, and (b) 'teacher' avoids the
        // independent-student auto-subscription path the trigger runs for
        // role='student' (we don't want to seed a free sub for a test admin).
        role: "teacher",
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
    userId = data.user?.id;
    if (!userId) {
      console.error("❌ admin.createUser returned no user id");
      process.exit(1);
    }
  }

  // ---- Promote the profile to platform_admin. Belt-and-braces upsert in
  // case the trigger somehow didn't fire. If the profile already exists
  // (existing user being re-flagged), this is a no-op merge.
  const profileUpdate = {
    id: userId,
    role: "teacher",
    full_name: fullName,
    is_school_student: false,
    platform_admin: true,
    platform_admin_granted_at: new Date().toISOString(),
    platform_admin_granted_by: bootstrapId,
  };

  const { error: upErr } = await sb
    .from("profiles")
    .upsert(profileUpdate, { onConflict: "id" });
  if (upErr) {
    console.error("❌ profile upsert failed:", upErr.message);
    process.exit(1);
  }

  // ---- Verify it stuck.
  const { data: verify } = await sb
    .from("profiles")
    .select("id, role, platform_admin, platform_admin_granted_by")
    .eq("id", userId)
    .single();

  if (!verify?.platform_admin) {
    console.error("❌ platform_admin flag did not persist. Check RLS / trigger ordering.");
    process.exit(1);
  }

  console.log("✅ Test platform admin ready.\n");
  console.log("─".repeat(40));
  console.log(`  Email:        ${email}`);
  console.log(`  Password:     ${password}`);
  console.log(`  User ID:      ${userId}`);
  console.log(`  Granted by:   ${bootstrapId || "(none — bootstrap unknown)"}`);
  console.log("─".repeat(40));
  console.log(
    "\nNow open an incognito window, go to /login → Platform tab,",
  );
  console.log(
    "sign in with the credentials above. Two-eyes is now active —",
  );
  console.log(
    "the bootstrap-self-approve flag will no longer apply to your real",
  );
  console.log(
    "admin's proposals.\n",
  );
  console.log(
    "When you're done testing, delete with:",
  );
  console.log(`  node scripts/create-test-platform-admin.js ${email} ${password} --reset\n`);
  console.log(
    "(or just toggle platform_admin = false in /admin/team).",
  );
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
