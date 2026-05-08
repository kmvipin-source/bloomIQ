// Sets up Mr. Raj with mixed roles to exercise the new visibility rule:
//
//   * Biology B (Grade 7) → make Raj PRIMARY (demote previous primary to co)
//     so we can verify "primary sees all tests assigned to the class
//     regardless of who assigned them" (Photosynthesis + Digestive
//     are owned + assigned by Ms. Priya; Raj should see both).
//
//   * Math A (Grade 6) → leave Raj as CO, then have Raj personally
//     ASSIGN one test there. We do this by inserting a quiz_assignments
//     row with assigned_by=raj. Service-role insert here bypasses the
//     "only quiz owner can write to quiz_assignments" policy, which is
//     fine for a test-data setup. We pick "Photosynthesis Class Quiz"
//     (currently on Biology B) and cross-assign it to Math A. Result:
//     Raj should see Photosynthesis on Math A as well, even as co.
//
// Run: node scripts/setup-mr-raj-mixed-roles.js

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
  if (!url || !serviceKey) {
    console.error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // ── Find Mr. Raj ──────────────────────────────────────────────
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const raj = list.users.find((u) => (u.email || "").toLowerCase() === "mr.raj@testacademy.example.com");
  if (!raj) { console.error("❌ mr.raj user not found"); process.exit(1); }
  console.log(`✓ Mr. Raj id: ${raj.id}`);

  // ── Find the two classes Mr. Raj is on ────────────────────────
  // We don't hard-code "Math A" / "Biology B" because class names vary
  // per seed. Strategy:
  //   1. Pull Raj's class_teachers rows.
  //   2. Look up those classes by id.
  //   3. The class that has "Photosynthesis Class Quiz" assigned → the
  //      one we'll make him PRIMARY on (logic: Photosynthesis is the
  //      Biology test, so this is Biology B).
  //   4. The other class is where he stays as co + we add an assignment.
  const { data: rajCts } = await admin
    .from("class_teachers")
    .select("class_id, role")
    .eq("teacher_id", raj.id);
  if (!rajCts || rajCts.length === 0) {
    console.error("❌ Mr. Raj has no class_teachers rows. Run setup-second-class-test.js first.");
    process.exit(1);
  }
  console.log(`✓ Raj is on ${rajCts.length} class(es): ${rajCts.map((r) => `${r.class_id.slice(0,8)}…(${r.role})`).join(", ")}`);

  const { data: classes } = await admin
    .from("classes")
    .select("id, name, owner_id")
    .in("id", rajCts.map((r) => r.class_id));
  console.log(`  ${(classes || []).map((c) => `${c.id.slice(0,8)}… "${c.name}"`).join("\n  ")}`);

  // Find which one has Photosynthesis Class Quiz assigned to it. That's
  // the "primary candidate" because Raj should be primary on the class
  // where he's the subject lead, and Photosynthesis was assigned to
  // Biology B in the test setup.
  const { data: allAsg } = await admin
    .from("quiz_assignments")
    .select("class_id, quizzes:quiz_id(name)")
    .in("class_id", rajCts.map((r) => r.class_id));
  let biologyB = null, mathA = null;
  for (const a of allAsg || []) {
    if (/photosynthesis/i.test(a.quizzes?.name || "")) {
      biologyB = (classes || []).find((c) => c.id === a.class_id) || null;
    }
  }
  if (!biologyB) {
    // Fall back: pick the first class.
    biologyB = (classes || [])[0] || null;
    console.log(`  (no Photosynthesis assignment found — defaulting Biology B = "${biologyB?.name}")`);
  }
  mathA = (classes || []).find((c) => c.id !== biologyB?.id) || null;

  if (!biologyB) { console.error("❌ couldn't pick a Biology B class");  process.exit(1); }
  if (!mathA)    { console.error("❌ couldn't pick a Math A class (Raj only on one class)"); process.exit(1); }
  console.log(`\n✓ Biology B (will become PRIMARY for Raj): "${biologyB.name}"`);
  console.log(`✓ Math A    (will stay CO; Raj assigns one test): "${mathA.name}"`);

  // ── Promote Raj to primary on Biology B ───────────────────────
  // Demote any existing non-Raj primary on Biology B to 'co' first
  // (DB has a unique partial index allowing only one primary per class).
  console.log("\n[1] Promoting Mr. Raj to PRIMARY on Biology B");
  {
    const { data: existing } = await admin
      .from("class_teachers")
      .select("teacher_id, role")
      .eq("class_id", biologyB.id);
    for (const r of existing || []) {
      if (r.teacher_id !== raj.id && r.role === "primary") {
        const { error } = await admin
          .from("class_teachers")
          .update({ role: "co" })
          .eq("class_id", biologyB.id)
          .eq("teacher_id", r.teacher_id);
        if (error) { console.error(`    ✗ couldn't demote ${r.teacher_id.slice(0,8)}…: ${error.message}`); }
        else       { console.log(`    ✓ demoted previous primary ${r.teacher_id.slice(0,8)}… → co`); }
      }
    }
    // Upsert Raj as primary.
    const { error } = await admin
      .from("class_teachers")
      .upsert(
        { class_id: biologyB.id, teacher_id: raj.id, role: "primary" },
        { onConflict: "class_id,teacher_id" }
      );
    if (error) { console.error(`    ✗ promote failed: ${error.message}`); }
    else       { console.log(`    ✓ Raj is now primary on Biology B`); }

    // Sync classes.owner_id to match — keeps legacy code paths happy.
    const { error: oerr } = await admin.from("classes").update({ owner_id: raj.id }).eq("id", biologyB.id);
    if (oerr) console.error(`    ✗ classes.owner_id sync failed: ${oerr.message}`);
  }

  // ── Pick a quiz for Raj to assign to Math A as co ─────────────
  // Use Photosynthesis Class Quiz (on Biology B currently). Insert a
  // duplicate assignment row pointing at Math A with assigned_by=raj.
  console.log("\n[2] Adding an assignment Raj created on Math A (as co)");
  {
    const { data: photoAsg } = await admin
      .from("quiz_assignments")
      .select("quiz_id, quizzes:quiz_id(name)")
      .eq("class_id", biologyB.id);
    const photo = (photoAsg || []).find((a) => /photosynthesis/i.test(a.quizzes?.name || ""));
    if (!photo) {
      console.log("    (no Photosynthesis Quiz found on Biology B; skipping)");
    } else {
      // Avoid creating dupes if the script is re-run.
      const { data: already } = await admin
        .from("quiz_assignments")
        .select("id")
        .eq("class_id", mathA.id)
        .eq("quiz_id", photo.quiz_id)
        .eq("assigned_by", raj.id);
      if ((already || []).length > 0) {
        console.log(`    ✓ Raj's Math A assignment for "${photo.quizzes?.name}" already exists — leaving alone`);
      } else {
        const { error } = await admin
          .from("quiz_assignments")
          .insert({
            quiz_id: photo.quiz_id,
            class_id: mathA.id,
            assigned_by: raj.id,
          });
        if (error) console.error(`    ✗ insert failed: ${error.message}`);
        else       console.log(`    ✓ Raj assigned "${photo.quizzes?.name}" to Math A`);
      }
    }
  }

  // ── Verify ────────────────────────────────────────────────────
  console.log("\n[3] Verification");
  const { data: ctsAfter } = await admin
    .from("class_teachers")
    .select("class_id, role, classes(name)")
    .eq("teacher_id", raj.id);
  for (const r of ctsAfter || []) {
    console.log(`    Raj: ${r.classes?.name} → role=${r.role}`);
  }
  const { data: asgsByRaj } = await admin
    .from("quiz_assignments")
    .select("quiz_id, classes(name), quizzes(name)")
    .eq("assigned_by", raj.id);
  console.log(`    Assignments authored by Raj: ${(asgsByRaj || []).length}`);
  for (const a of asgsByRaj || []) {
    console.log(`      - "${a.quizzes?.name}" → ${a.classes?.name}`);
  }

  console.log("\n✅ Done. Re-run scripts/debug-mr-raj-reports.js to confirm what Raj's session can now see.");
})().catch((e) => { console.error(e); process.exit(1); });
