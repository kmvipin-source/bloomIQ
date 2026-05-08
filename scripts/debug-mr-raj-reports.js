// Diagnoses why Mr. Raj's /teacher/reports shows 0 stats for Biology B.
//
// Compares what's actually in the DB (admin/service-role view, RLS-bypassed)
// vs what Mr. Raj's session sees (anon-key + JWT, RLS-applied). Tells us
// exactly which RLS step is blocking him.
//
// Usage:  node scripts/debug-mr-raj-reports.js

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
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !serviceKey || !anonKey) {
    console.error("Need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local");
    process.exit(1);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  console.log("\n🔍 What's actually in the DB (service-role, RLS-bypassed)\n");

  // Find Mr. Raj
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const raj = list.users.find((u) => (u.email || "").toLowerCase() === "mr.raj@testacademy.example.com");
  if (!raj) { console.error("❌ mr.raj user not found"); process.exit(1); }
  console.log(`[1] Mr. Raj id: ${raj.id}`);

  // Mr. Raj's class_teachers rows
  const { data: cts } = await admin.from("class_teachers")
    .select("class_id, role, classes(name)")
    .eq("teacher_id", raj.id);
  console.log(`\n[2] class_teachers rows for Mr. Raj (${cts?.length || 0}):`);
  for (const r of (cts || [])) {
    console.log(`     - class=${r.classes?.name}  role=${r.role}  class_id=${r.class_id.slice(0,8)}…`);
  }

  // quiz_assignments for those classes
  const classIds = (cts || []).map((r) => r.class_id);
  const { data: asgs } = await admin.from("quiz_assignments")
    .select("quiz_id, class_id, classes(name), quizzes(name, owner_id)")
    .in("class_id", classIds);
  console.log(`\n[3] quiz_assignments for those classes (${asgs?.length || 0}):`);
  for (const a of (asgs || [])) {
    console.log(`     - "${a.quizzes?.name}" → ${a.classes?.name}  (owner_id=${a.quizzes?.owner_id?.slice(0,8)}…)`);
  }

  // attempts on those quizzes
  const quizIds = Array.from(new Set((asgs || []).map((a) => a.quiz_id)));
  const { data: atts } = await admin.from("quiz_attempts")
    .select("id, quiz_id, student_id, score, total")
    .in("quiz_id", quizIds)
    .not("submitted_at", "is", null);
  console.log(`\n[4] submitted attempts on those quizzes: ${atts?.length || 0}`);

  // ───────────────────────────────────────────────────────────────
  // Now sign in as Mr. Raj and run THE SAME queries with his JWT
  // (RLS-applied) so we see what /teacher/reports actually gets back.
  // ───────────────────────────────────────────────────────────────
  console.log("\n🔍 What Mr. Raj's session sees (anon key + JWT, RLS-applied)\n");
  const rajSb = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signIn, error: siErr } = await rajSb.auth.signInWithPassword({
    email: "mr.raj@testacademy.example.com",
    password: process.env.SEED_PASSWORD || "TestPass123!",
  });
  if (siErr || !signIn.session) {
    console.error(`❌ couldn't sign in as Mr. Raj: ${siErr?.message}`);
    process.exit(1);
  }
  console.log(`[a] signed in as Mr. Raj`);

  // class_teachers as Mr. Raj
  const { data: ctsMR } = await rajSb.from("class_teachers")
    .select("class_id, role")
    .eq("teacher_id", raj.id);
  console.log(`\n[b] class_teachers rows visible to Mr. Raj: ${ctsMR?.length || 0}`);
  for (const r of (ctsMR || [])) console.log(`     - class_id=${r.class_id.slice(0,8)}… role=${r.role}`);

  // quiz_assignments as Mr. Raj — pull EVERYTHING he can see (not just
  // ones scoped to his class IDs) so visibility-by-assigner shows up.
  const { data: asgsMR } = await rajSb.from("quiz_assignments")
    .select("quiz_id, class_id, assigned_by");
  console.log(`\n[c] quiz_assignments visible to Mr. Raj (total): ${asgsMR?.length || 0}`);
  for (const a of (asgsMR || [])) {
    const tag = a.assigned_by === raj.id ? "by-me" : "by-other";
    console.log(`     - quiz_id=${a.quiz_id.slice(0,8)}… class_id=${(a.class_id || "").slice(0,8)}… (${tag})`);
  }

  // quizzes Mr. Raj can see (owned + assigned to his classes)
  const visibleQuizIds = Array.from(new Set((asgsMR || []).map((a) => a.quiz_id)));
  const { data: qzVis } = await rajSb.from("quizzes")
    .select("id, name, owner_id")
    .in("id", visibleQuizIds.length > 0 ? visibleQuizIds : ["00000000-0000-0000-0000-000000000000"]);
  console.log(`\n[d] quizzes Mr. Raj can read by id list (${qzVis?.length || 0}):`);
  for (const q of (qzVis || [])) console.log(`     - "${q.name}"  owner=${q.owner_id?.slice(0,8)}…`);

  // attempts as Mr. Raj
  const { data: attsMR } = await rajSb.from("quiz_attempts")
    .select("id, quiz_id")
    .in("quiz_id", visibleQuizIds.length > 0 ? visibleQuizIds : ["00000000-0000-0000-0000-000000000000"])
    .not("submitted_at", "is", null);
  console.log(`\n[e] quiz_attempts visible to Mr. Raj: ${attsMR?.length || 0}`);

  console.log("\n──────────────────────────────────────────────");
  console.log("If [b]/[c]/[e] are smaller than [2]/[3]/[4], RLS is still blocking.");
  console.log("──────────────────────────────────────────────\n");
})().catch((e) => { console.error(e); process.exit(1); });
