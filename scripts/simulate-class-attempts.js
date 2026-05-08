// Simulate a class taking a quiz — for end-to-end report testing.
//
// Why: teacher / admin reports only become interesting once you've got
// ~10+ student attempts with varied scores. Doing that by clicking
// through 10 different student logins is an hour of mechanical work.
// This script writes the attempt + attempt_answers rows directly via
// the service-role client, so you get a realistic dataset in 5 seconds.
//
// What it does (idempotent — re-running just adds more attempts):
//   1. Finds the quiz by code.
//   2. Resolves the class assigned to that quiz (the quiz_assignments
//      row whose class_id matches Grade 6 - Mathematics A or whatever
//      you ran assign-to-class on).
//   3. Optionally creates N new school students and adds them to the
//      class roster (so the class has 10+ members total).
//   4. For every member of that class, inserts a quiz_attempts row
//      with a randomised but realistic score (30%-95%), then fills
//      attempt_answers with one row per question — selected_index
//      and is_correct set to match the target score.
//
// Usage (from project root):
//   node scripts/simulate-class-attempts.js <quiz_code>
//   node scripts/simulate-class-attempts.js 72GP2X
//   node scripts/simulate-class-attempts.js 72GP2X 12      // add 12 extra synthetic students
//   node scripts/simulate-class-attempts.js 72GP2X 0       // only simulate attempts for existing members
//
// Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.

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

const SCHOOL_DOMAIN = "bloomiq.invalid";
const PASSWORD = process.env.SEED_PASSWORD || "TestPass123!";

// 12 first names → predictable usernames for repeat runs. We pad with
// a digit suffix if the script is run more than once for the same class.
const POOL_NAMES = [
  ["aarav",   "Aarav Mehta"],
  ["ishaan",  "Ishaan Khan"],
  ["riya",    "Riya Patel"],
  ["zara",    "Zara Sheikh"],
  ["aditya",  "Aditya Rao"],
  ["myra",    "Myra Krishnan"],
  ["rohan",   "Rohan Joshi"],
  ["sara",    "Sara D'Souza"],
  ["kavya",   "Kavya Nair"],
  ["arjun",   "Arjun Verma"],
  ["priya",   "Priya Mishra"],
  ["dev",     "Dev Kapoor"],
  ["ira",     "Ira Banerjee"],
  ["vihaan",  "Vihaan Gupta"],
  ["aria",    "Aria Pillai"],
];

function pickAnswerIndex(targetCorrect) {
  // Returns 0-3. If targetCorrect, returns the correct one; otherwise a wrong one.
  // The caller passes correct_index — we just decide whether to match it.
  // (Caller does the actual rewrite.)
  return Math.floor(Math.random() * 4);
}

(async () => {
  const env = loadEnvLocal();
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const args = process.argv.slice(2);
  const quizCode = args[0];
  if (!quizCode) {
    console.error("Usage: node scripts/simulate-class-attempts.js <quiz_code> [num_extra_students]");
    process.exit(1);
  }
  const numExtra = args[1] != null ? parseInt(args[1], 10) : 12;
  if (Number.isNaN(numExtra) || numExtra < 0) {
    console.error("num_extra_students must be a non-negative integer");
    process.exit(1);
  }

  console.log(`\n🎲 Simulating attempts for quiz code "${quizCode}" with up to ${numExtra} extra students...\n`);

  // 1) Find the quiz + its assigned class
  const { data: quiz, error: quizErr } = await sb
    .from("quizzes")
    .select("id, code, name, owner_id, time_limit_minutes")
    .eq("code", quizCode)
    .maybeSingle();
  if (quizErr || !quiz) {
    console.error(`❌ No quiz with code ${quizCode}: ${quizErr?.message || "not found"}`);
    process.exit(1);
  }
  console.log(`[1] Quiz: ${quiz.name} (id=${quiz.id})`);

  // 2) Find the assignment → class
  const { data: assign } = await sb
    .from("quiz_assignments")
    .select("class_id")
    .eq("quiz_id", quiz.id)
    .not("class_id", "is", null)
    .limit(1)
    .maybeSingle();
  if (!assign?.class_id) {
    console.error(`❌ Quiz ${quizCode} is not assigned to any class. Use the teacher UI to assign first.`);
    process.exit(1);
  }
  const { data: klass } = await sb
    .from("classes")
    .select("id, name, school_id, join_code")
    .eq("id", assign.class_id)
    .maybeSingle();
  console.log(`[2] Class: ${klass.name} (id=${klass.id}, school_id=${klass.school_id})`);

  // 3) Pull the quiz's questions in display order — we need (id, correct_index, bloom_level)
  const { data: linkRows, error: linkErr } = await sb
    .from("quiz_questions")
    .select("question_id, position")
    .eq("quiz_id", quiz.id)
    .order("position", { ascending: true });
  if (linkErr) throw new Error(`fetch quiz_questions: ${linkErr.message}`);
  if (!linkRows || linkRows.length === 0) {
    console.error("❌ Quiz has no questions linked.");
    process.exit(1);
  }
  const qIds = linkRows.map((r) => r.question_id);
  const { data: qBank } = await sb
    .from("question_bank")
    .select("id, correct_index, bloom_level")
    .in("id", qIds);
  const qById = new Map(qBank.map((q) => [q.id, q]));
  const orderedQs = qIds.map((id) => qById.get(id)).filter(Boolean);
  console.log(`[3] Questions: ${orderedQs.length} loaded\n`);

  // 4) Optional: create extra synthetic students + add to class
  if (numExtra > 0) {
    console.log(`[4] Creating up to ${numExtra} synthetic school students...`);
    let added = 0;
    for (let i = 0; i < numExtra && i < POOL_NAMES.length; i++) {
      const [base, fullName] = POOL_NAMES[i];
      const username = base;
      const email = `${username}@${SCHOOL_DOMAIN}`;

      // Skip if already created
      const { data: list } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const existing = list.users.find((u) => (u.email || "").toLowerCase() === email);
      let userId = existing?.id;
      if (!userId) {
        const { data: created, error: cErr } = await sb.auth.admin.createUser({
          email,
          password: PASSWORD,
          email_confirm: true,
          user_metadata: { role: "student", full_name: fullName, is_school_student: true },
        });
        if (cErr) {
          console.warn(`   ⚠ skip ${email}: ${cErr.message}`);
          continue;
        }
        userId = created.user.id;
        await sb.from("profiles").upsert(
          { id: userId, role: "student", full_name: fullName, is_school_student: true, school_id: klass.school_id },
          { onConflict: "id" },
        );
      }
      // Enroll in class (idempotent)
      await sb.from("class_members")
        .upsert({ class_id: klass.id, student_id: userId }, { onConflict: "class_id,student_id" });
      added++;
    }
    console.log(`   ✓ ensured ${added} synthetic students enrolled in ${klass.name}`);
  }

  // 5) Pull current class roster
  const { data: members } = await sb
    .from("class_members")
    .select("student_id, profiles!class_members_student_id_fkey(full_name)")
    .eq("class_id", klass.id);
  if (!members || members.length === 0) {
    console.error("❌ No students in class.");
    process.exit(1);
  }
  console.log(`\n[5] Class roster: ${members.length} students\n`);

  // 6) Insert one attempt per student (skip students who already have an attempt for this quiz)
  console.log(`[6] Inserting attempts + answers...`);
  let attemptsAdded = 0;
  const total = orderedQs.length;
  const startedAt = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago

  for (const m of members) {
    const studentId = m.student_id;
    const studentName = m.profiles?.full_name || studentId.slice(0, 8);

    // Idempotency: skip if this student already has a submitted attempt for the quiz
    const { data: existing } = await sb
      .from("quiz_attempts")
      .select("id")
      .eq("quiz_id", quiz.id)
      .eq("student_id", studentId)
      .not("submitted_at", "is", null)
      .limit(1)
      .maybeSingle();
    if (existing) {
      console.log(`   • ${studentName}: already has an attempt, skipping`);
      continue;
    }

    // Pick a target score band. Distribute realistically:
    //   ~15% top performers (85-95%)
    //   ~50% middle (60-80%)
    //   ~25% struggling (35-55%)
    //   ~10% bottom (15-30%)
    const r = Math.random();
    const targetPct =
      r < 0.15 ? 85 + Math.random() * 10 :
      r < 0.65 ? 60 + Math.random() * 20 :
      r < 0.90 ? 35 + Math.random() * 20 :
                 15 + Math.random() * 15;
    const correctCount = Math.round((targetPct / 100) * total);

    // Build per-question correctness: shuffle which questions are correct
    const correctnessMask = Array(total).fill(false);
    for (let i = 0; i < correctCount; i++) correctnessMask[i] = true;
    for (let i = correctnessMask.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [correctnessMask[i], correctnessMask[j]] = [correctnessMask[j], correctnessMask[i]];
    }

    const submittedAt = new Date(startedAt.getTime() + Math.round((5 + Math.random() * 12) * 60 * 1000));
    const timeTakenSeconds = Math.round((submittedAt.getTime() - startedAt.getTime()) / 1000);

    // Insert attempt
    const { data: attempt, error: aErr } = await sb
      .from("quiz_attempts")
      .insert({
        quiz_id: quiz.id,
        student_id: studentId,
        started_at: startedAt.toISOString(),
        submitted_at: submittedAt.toISOString(),
        score: correctCount,
        total,
        time_taken_seconds: timeTakenSeconds,
      })
      .select("id")
      .single();
    if (aErr) {
      console.warn(`   ⚠ ${studentName}: attempt insert failed: ${aErr.message}`);
      continue;
    }

    // Build attempt_answers
    const answerRows = orderedQs.map((q, i) => {
      const isCorrect = correctnessMask[i];
      const correctIdx = q.correct_index;
      let selected;
      if (isCorrect) {
        selected = correctIdx;
      } else {
        // Pick a wrong index uniformly from the other 3
        const wrong = [0, 1, 2, 3].filter((k) => k !== correctIdx);
        selected = wrong[Math.floor(Math.random() * wrong.length)];
      }
      return {
        attempt_id: attempt.id,
        question_id: q.id,
        selected_index: selected,
        is_correct: isCorrect,
        bloom_level: q.bloom_level,
      };
    });
    const { error: ansErr } = await sb.from("attempt_answers").insert(answerRows);
    if (ansErr) {
      console.warn(`   ⚠ ${studentName}: answer insert failed: ${ansErr.message}`);
      continue;
    }

    attemptsAdded++;
    console.log(`   ✓ ${studentName}: ${correctCount}/${total} (${Math.round(targetPct)}%) in ${Math.round(timeTakenSeconds / 60)}m`);
  }

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`✅ Done. ${attemptsAdded} attempts added for "${quiz.name}".`);
  console.log(`──────────────────────────────────────────────`);
  console.log(`Now sign in as a teacher (e.g. ms.priya@testacademy.example.com or mr.raj@testacademy.example.com)`);
  console.log(`to view the populated reports / analytics.\n`);
})().catch((e) => {
  console.error("\n❌ Unexpected error:", e.message || e);
  process.exit(1);
});
