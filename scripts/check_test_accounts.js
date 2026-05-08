const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
function loadEnvLocal() {
  const env = {};
  for (const line of fs.readFileSync(path.join("/sessions/modest-epic-curie/mnt/bloomiq", ".env.local"), "utf8").split(/\r?\n/)) {
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
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const want = [
    "ops@bloomiq.example.com",
    "principal@testacademy.example.com",
    "deputy@testacademy.example.com",
    "ms.priya@testacademy.example.com",
    "mr.raj@testacademy.example.com",
    "ananya@bloomiq.invalid",
    "indie.alice@example.com",
    "indie.bob@example.com",
    "premium.student@example.com",
    "premiumplus.student@example.com",
    "splusstudent@bloomiq.invalid",
  ];
  const { data } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const have = new Set(data.users.map(u => (u.email || "").toLowerCase()));
  console.log("Account inventory:");
  for (const e of want) {
    console.log("  " + (have.has(e.toLowerCase()) ? "✓" : "✗") + "  " + e);
  }
})().catch(e => { console.error(e); process.exit(1); });
