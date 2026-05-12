// Backdates a Free user's subscription so they hit the day-8 trial lockout
// immediately. Useful for demoing / testing the /student/expired flow without
// waiting 8 real days.
//
// Usage:
//   node scripts/expire-free-trial.js <email>
//   node scripts/expire-free-trial.js free.zoya@example.com
//
// Idempotent: if no subscription row exists yet for the user, it creates one;
// otherwise it updates the existing row. Always sets:
//   tier='free', is_trial=true, status='active',
//   expires_at = now() - 1 day  (so the lockout fires on next page load)
//
// To restore the user back to a fresh trial:
//   node scripts/expire-free-trial.js <email> --reset

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

function loadEnvLocal() {
  const env = {};
  for (const line of fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

async function main() {
  const args = process.argv.slice(2);
  const reset = args.includes("--reset");
  const email = args.find((a) => !a.startsWith("--"));
  if (!email) {
    console.error("Usage: node scripts/expire-free-trial.js <email> [--reset]");
    process.exit(1);
  }

  const env = loadEnvLocal();
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Find the user.
  const { data: ulist, error: uerr } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (uerr) throw uerr;
  const user = ulist.users.find((u) => (u.email || "").toLowerCase() === email.toLowerCase());
  if (!user) {
    console.error(`No user found for email: ${email}`);
    process.exit(1);
  }
  console.log(`User: ${user.email}  uid=${user.id}`);

  const now = new Date();
  const targetExpiry = reset
    ? new Date(now.getTime() + 7 * 24 * 3600 * 1000)  // 7 days from now
    : new Date(now.getTime() - 1 * 24 * 3600 * 1000); // 1 day ago

  const payload = {
    user_id: user.id,
    tier: "free",
    status: "active",
    is_trial: true,
    started_at: new Date(now.getTime() - 8 * 24 * 3600 * 1000).toISOString(),
    expires_at: targetExpiry.toISOString(),
  };

  // Try update first; insert if missing.
  const { data: existing } = await sb
    .from("subscriptions")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (existing) {
    const { error } = await sb
      .from("subscriptions")
      .update({
        tier: payload.tier,
        status: payload.status,
        is_trial: payload.is_trial,
        expires_at: payload.expires_at,
      })
      .eq("user_id", user.id);
    if (error) throw error;
    console.log(`  ${reset ? "reset" : "expired"} existing subscription row.`);
  } else {
    const { error } = await sb.from("subscriptions").insert(payload);
    if (error) throw error;
    console.log(`  inserted new subscription row.`);
  }

  console.log(`  tier=${payload.tier}, is_trial=${payload.is_trial}, expires_at=${payload.expires_at}`);

  // On --reset, also wipe today's daily counters and ALL lifetime touches so
  // the user genuinely starts fresh. Without this, a previously-tested user
  // (e.g. tutor turn used=5/5 today) stays capped even after the trial reset.
  if (reset) {
    const wipeDaily = await sb.from("daily_ai_usage").delete().eq("user_id", user.id);
    const wipeLife = await sb.from("lifetime_feature_usage").delete().eq("user_id", user.id);
    if (wipeDaily.error) console.warn(`  ! couldn't wipe daily_ai_usage: ${wipeDaily.error.message}`);
    if (wipeLife.error) console.warn(`  ! couldn't wipe lifetime_feature_usage: ${wipeLife.error.message}`);
    console.log("  wiped today's daily counters + all lifetime feature touches.");
  }

  if (reset) {
    console.log("\nDONE. Refresh the browser — user has a fresh 7-day trial.");
  } else {
    console.log("\nDONE. Refresh the browser — user should be redirected to /student/expired.");
  }
}

main().catch((e) => {
  console.error("Failed:", e.message || e);
  process.exit(1);
});
