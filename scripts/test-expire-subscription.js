// Test helper: backdate a user's subscription expiry to yesterday so the
// app's "expired" UX (renew banner, locked tiles, plan label "Free
// (expired)") can be exercised end-to-end. Run again with `--restore`
// to push the expiry back out by 365 days for normal use.
//
// Usage:
//   node scripts/test-expire-subscription.js premium.student@example.com
//   node scripts/test-expire-subscription.js premium.student@example.com --restore

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

(async () => {
  const env = loadEnvLocal();
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const args = process.argv.slice(2);
  const email = args.find((a) => !a.startsWith("--"));
  const restore = args.includes("--restore");
  if (!email) {
    console.error("Usage: node scripts/test-expire-subscription.js <email> [--restore]");
    process.exit(1);
  }
  const { data: list } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const u = list.users.find((u) => (u.email || "").toLowerCase() === email.toLowerCase());
  if (!u) { console.error(`No user with email ${email}`); process.exit(1); }
  const days = restore ? 365 : -1;
  const newExpires = new Date(Date.now() + days * 86400000).toISOString();
  const { error, data } = await sb.from("subscriptions")
    .update({ expires_at: newExpires })
    .eq("user_id", u.id)
    .select("id, expires_at");
  if (error) { console.error(error.message); process.exit(1); }
  console.log(`✓ Updated ${data?.length || 0} sub for ${email}: expires_at = ${newExpires} (${restore ? "restored 365 days out" : "BACKDATED to yesterday"})`);
})().catch((e) => { console.error(e); process.exit(1); });
