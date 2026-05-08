// Diagnostic: print the entire feature-gating chain for a single user.
// Mirrors what lib/featureAccess.server.ts does (and what the dashboard
// hook does on the browser), but run via service role and prints every
// step so you can see where the chain breaks.
//
// Usage (from project root):
//   node scripts/diagnose-feature-access.js splusstudent
//   node scripts/diagnose-feature-access.js splusstudent@bloomiq.invalid
//   node scripts/diagnose-feature-access.js splusstudent concept_visualizer
//
// First arg: username OR email of the user to diagnose.
// Second arg (optional): feature key to check (default 'concept_visualizer').

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
  if (!args[0]) {
    console.error('Usage: node scripts/diagnose-feature-access.js <username|email> [featureKey]');
    process.exit(1);
  }
  const handle = args[0];
  const featureKey = args[1] || "concept_visualizer";
  const email = handle.includes("@") ? handle : `${handle.toLowerCase()}@bloomiq.invalid`;

  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`\n🔍 Feature-gate diagnostic for ${email} / "${featureKey}"`);
  console.log("─".repeat(72));

  // 1) Auth user
  const { data: list } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const u = list.users.find((u) => (u.email || "").toLowerCase() === email.toLowerCase());
  if (!u) {
    console.log("❌ No auth user with that email.");
    process.exit(1);
  }
  console.log("[1] AUTH USER");
  console.log(`     id              ${u.id}`);
  console.log(`     email           ${u.email}`);
  console.log(`     email_confirmed ${u.email_confirmed_at ? "yes" : "NO"}`);
  console.log(`     metadata        ${JSON.stringify(u.user_metadata)}`);

  // 2) Profile row
  const { data: prof, error: profErr } = await sb
    .from("profiles")
    .select("id, role, full_name, is_school_student, school_id, platform_admin, learner_profile, exam_goal")
    .eq("id", u.id)
    .maybeSingle();
  if (profErr) {
    console.log(`❌ profiles read error: ${profErr.message}`);
    process.exit(1);
  }
  if (!prof) {
    console.log("❌ No profile row — handle_new_user trigger may not have fired.");
    process.exit(1);
  }
  console.log("\n[2] PROFILE");
  console.log(`     role               ${prof.role}`);
  console.log(`     full_name          ${prof.full_name}`);
  console.log(`     is_school_student  ${prof.is_school_student}`);
  console.log(`     school_id          ${prof.school_id}`);
  console.log(`     platform_admin     ${prof.platform_admin}`);
  console.log(`     learner_profile    ${prof.learner_profile || "(unset — defaults to k12)"}`);
  console.log(`     exam_goal          ${prof.exam_goal || "(unset)"}`);

  // 3) ALL subscriptions touching this user (by user_id) AND by their school
  console.log("\n[3] SUBSCRIPTIONS (any row mentioning this user or school)");
  const { data: bySelf } = await sb
    .from("subscriptions")
    .select("id, user_id, school_id, tier, plan_id, status, started_at, expires_at, price_paid_paise")
    .eq("user_id", u.id);
  const { data: bySchool } = prof.school_id
    ? await sb
        .from("subscriptions")
        .select("id, user_id, school_id, tier, plan_id, status, started_at, expires_at, price_paid_paise")
        .eq("school_id", prof.school_id)
    : { data: [] };
  const all = [...(bySelf || []), ...(bySchool || [])];
  // De-dupe by id (a row could have both user_id and school_id set in theory).
  const seen = new Set();
  const subs = all.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  if (subs.length === 0) {
    console.log("     (none — neither personal nor school sub exists)");
  } else {
    for (const s of subs) {
      console.log(`     - id=${s.id}`);
      console.log(`         user_id=${s.user_id} school_id=${s.school_id}`);
      console.log(`         tier=${s.tier} plan_id=${s.plan_id} status=${s.status}`);
      console.log(`         started=${s.started_at} expires=${s.expires_at}`);
    }
  }

  // 4) Apply the same resolution lib/featureAccess does:
  //    school student + school_id → school sub takes precedence.
  console.log("\n[4] RESOLUTION (mirrors lib/featureAccess)");
  let activeSub = null;
  let source = "none";
  if (prof.is_school_student && prof.school_id) {
    const { data: schoolSub } = await sb
      .from("subscriptions")
      .select("id, plan_id, status, expires_at")
      .eq("school_id", prof.school_id)
      .eq("status", "active")
      .maybeSingle();
    if (schoolSub) {
      activeSub = schoolSub;
      source = "school";
    } else {
      console.log("     ⚠ is_school_student=true and school_id is set, but");
      console.log("       no row in subscriptions has school_id=<yours> AND status='active'.");
    }
  }
  if (!activeSub) {
    const { data: personal } = await sb
      .from("subscriptions")
      .select("id, plan_id, status, expires_at")
      .eq("user_id", u.id)
      .maybeSingle();
    if (personal) {
      activeSub = personal;
      source = "personal";
    }
  }
  console.log(`     source: ${source}`);
  if (!activeSub) {
    console.log("     ❌ No active subscription resolves for this user.");
    process.exit(0);
  }
  console.log(`     active sub id   ${activeSub.id}`);
  console.log(`     plan_id         ${activeSub.plan_id}`);
  console.log(`     status          ${activeSub.status}`);
  console.log(`     expires_at      ${activeSub.expires_at}`);

  // 5) Plan row
  const { data: plan, error: planErr } = await sb
    .from("plans")
    .select("id, slug, tier, label, status, features")
    .eq("id", activeSub.plan_id)
    .maybeSingle();
  if (planErr) {
    console.log(`     ❌ plans read error: ${planErr.message}`);
    process.exit(1);
  }
  if (!plan) {
    console.log("     ❌ No plan row found for the subscription's plan_id.");
    process.exit(1);
  }
  console.log("\n[5] PLAN");
  console.log(`     id              ${plan.id}`);
  console.log(`     slug            ${plan.slug}`);
  console.log(`     tier            ${plan.tier}`);
  console.log(`     label           ${plan.label}`);
  console.log(`     status          ${plan.status}`);
  const features = Array.isArray(plan.features) ? plan.features : [];
  console.log(`     features (${features.length}): ${features.join(", ") || "(empty)"}`);

  // 6) Final answer
  const allowed = features.includes(featureKey);
  const expiresAtMs = activeSub.expires_at ? Date.parse(activeSub.expires_at) : null;
  const isExpired = expiresAtMs !== null && expiresAtMs < Date.now();
  console.log("\n[6] VERDICT");
  console.log(`     feature key checked: "${featureKey}"`);
  console.log(`     present in plan.features?  ${allowed ? "YES" : "NO"}`);
  console.log(`     subscription expired?      ${isExpired ? "YES" : "no"}`);
  if (allowed && !isExpired) {
    console.log(`     ✅ User SHOULD see "${featureKey}" unlocked.`);
  } else if (!allowed) {
    console.log(`     ❌ Plan "${plan.slug}" does not include "${featureKey}".`);
    console.log(`        Either pick a higher-tier plan, or add the key to`);
    console.log(`        plans.features for this plan row.`);
  } else if (isExpired) {
    console.log(`     ❌ Subscription has expired — feature treated as locked.`);
  }
  console.log("");
}

main().catch((e) => {
  console.error("\n❌ Unexpected error:", e.message || e);
  process.exit(1);
});
