// One-shot fix: my earlier setup-mr-raj-mixed-roles.js tagged Math A as
// "Biology B" by accident (heuristic was bad), so Raj ended up primary
// on Mathematics A. We want him primary on Biology B (where Ms. Priya
// assigned Digestive + Respiratory), so we can exercise the
// "primary sees all tests on their class regardless of who assigned"
// branch of the new visibility rule. Math A → Raj as co (he already
// has Photo + Cell Structure assignments on it via ownership).
//
// Run: node scripts/swap-raj-primary-to-biology.js

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
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) { console.error("Need URL/SERVICE_ROLE in .env.local"); process.exit(1); }
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const raj   = list.users.find((u) => (u.email || "").toLowerCase() === "mr.raj@testacademy.example.com");
  const priya = list.users.find((u) => (u.email || "").toLowerCase() === "ms.priya@testacademy.example.com");
  if (!raj)   { console.error("❌ mr.raj user not found");   process.exit(1); }
  if (!priya) { console.error("❌ ms.priya user not found"); process.exit(1); }
  console.log(`✓ Raj id:   ${raj.id}`);
  console.log(`✓ Priya id: ${priya.id}`);

  const { data: classes } = await admin.from("classes").select("id, name");
  const bio  = (classes || []).find((c) => /biology/i.test(c.name));
  const math = (classes || []).find((c) => /math/i.test(c.name));
  if (!bio)  { console.error("❌ couldn't find a class with 'biology' in the name"); process.exit(1); }
  if (!math) { console.error("❌ couldn't find a class with 'math' in the name");    process.exit(1); }
  console.log(`✓ Biology class: "${bio.name}"  (${bio.id.slice(0,8)}…)`);
  console.log(`✓ Math class:    "${math.name}" (${math.id.slice(0,8)}…)`);

  // Target state:
  //   bio:  Raj=primary, Priya=co
  //   math: Priya=primary, Raj=co
  //
  // The DB has a unique partial index "ct_one_primary_per_class" so we
  // demote first, promote second.
  const setRole = async (classId, teacherId, role) => {
    const { error } = await admin
      .from("class_teachers")
      .upsert({ class_id: classId, teacher_id: teacherId, role }, { onConflict: "class_id,teacher_id" });
    if (error) console.error(`  ✗ set ${teacherId.slice(0,8)}@${classId.slice(0,8)} → ${role}: ${error.message}`);
    else       console.log(`  ✓ set ${teacherId.slice(0,8)}@${classId.slice(0,8)} → ${role}`);
  };
  const ensureNoPrimaryExceptMe = async (classId, meId) => {
    const { data } = await admin
      .from("class_teachers")
      .select("teacher_id")
      .eq("class_id", classId)
      .eq("role", "primary");
    for (const r of data || []) {
      if (r.teacher_id !== meId) await setRole(classId, r.teacher_id, "co");
    }
  };
  const syncOwner = async (classId, ownerId) => {
    const { error } = await admin.from("classes").update({ owner_id: ownerId }).eq("id", classId);
    if (error) console.error(`  ✗ classes.owner_id sync @${classId.slice(0,8)}: ${error.message}`);
    else       console.log(`  ✓ classes.owner_id @${classId.slice(0,8)} → ${ownerId.slice(0,8)}…`);
  };

  console.log("\n[1] Biology class — Raj should be primary, Priya co");
  await ensureNoPrimaryExceptMe(bio.id, raj.id);
  await setRole(bio.id, raj.id,   "primary");
  await setRole(bio.id, priya.id, "co");
  await syncOwner(bio.id, raj.id);

  console.log("\n[2] Math class — Priya should be primary, Raj co");
  await ensureNoPrimaryExceptMe(math.id, priya.id);
  await setRole(math.id, priya.id, "primary");
  await setRole(math.id, raj.id,   "co");
  await syncOwner(math.id, priya.id);

  console.log("\n[3] Verification — Raj's class memberships:");
  const { data: ctsAfter } = await admin
    .from("class_teachers")
    .select("class_id, role, classes(name)")
    .eq("teacher_id", raj.id);
  for (const r of ctsAfter || []) console.log(`    ${r.classes?.name} → role=${r.role}`);

  console.log("\n✅ Done. Now re-run scripts/debug-mr-raj-reports.js — counts should be:");
  console.log("    [c] = 5  (Photo×2, Cell, Digestive, Respiratory — all visible now)");
  console.log("    [d] = 4  (Photo, Cell, Digestive, Respiratory)");
  console.log("    [e] = 46 (every submitted attempt)");
})().catch((e) => { console.error(e); process.exit(1); });
