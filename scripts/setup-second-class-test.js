// Adds a SECOND class to Test Academy so we can test cross-class
// rollups for a teacher who's primary on one class and co on another.
//
// Layout after this runs:
//   Class A: "Grade 6 - Mathematics A"  (existing — Ms. Priya primary, Mr. Raj co)
//   Class B: "Grade 7 - Biology B"      (new)     — Ms. Priya primary, Mr. Raj co
//
// Plus:
//   - 8 students enrolled in Class B (some new, some shared with A)
//   - 12 canned biology questions inserted into the question bank,
//     owned by Ms. Priya (so we can verify cross-quiz reports work
//     when the class's tests come from a DIFFERENT teacher than Mr. Raj).
//   - A "Digestive System Quiz" built from those questions, assigned
//     to Class B with a future due date.
//   - Realistic attempts simulated for every member of Class B.
//
// Idempotent: re-runs add another attempt where there's no submission yet.
// Pair with seed-test-users.js --plan school_standard --reset for a clean
// slate first.
//
// Usage:  node scripts/setup-second-class-test.js
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
const SCHOOL_NAME = "Test Academy";
const CLASS_B_NAME = "Grade 7 - Biology B";
const PRIMARY_EMAIL = "ms.priya@testacademy.example.com";
const CO_EMAIL = "mr.raj@testacademy.example.com";
const QUIZ_NAME = "Digestive System Quiz";

function randomCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// Class B specifically uses NEW students so we can clearly see Mr. Raj has
// students he's never met before show up in his cross-class roster.
const NEW_STUDENT_NAMES = [
  ["leo",    "Leo Saxena"],
  ["maya",   "Maya Bhatt"],
  ["yash",   "Yash Reddy"],
  ["nora",   "Nora Iyer"],
  ["kiran",  "Kiran Bose"],
  ["aanya",  "Aanya Joshi"],
  ["veer",   "Veer Malhotra"],
  ["tara",   "Tara Singh"],
];

const BIO_QUESTIONS = [
  { bloom_level: "remember",   stem: "What is the primary organ of digestion?",                                                   options: ["Liver", "Stomach", "Large intestine", "Pancreas"],                                       correct_index: 1,  explanation: "Most chemical and mechanical digestion happens in the stomach." },
  { bloom_level: "remember",   stem: "Which enzyme begins starch digestion in the mouth?",                                        options: ["Amylase", "Pepsin", "Trypsin", "Lipase"],                                              correct_index: 0,  explanation: "Salivary amylase begins breaking down starch into simpler sugars." },
  { bloom_level: "remember",   stem: "Where does most nutrient absorption occur?",                                                options: ["Stomach", "Small intestine", "Large intestine", "Esophagus"],                          correct_index: 1,  explanation: "The villi of the small intestine maximize surface area for absorption." },
  { bloom_level: "understand", stem: "Why does the stomach produce hydrochloric acid?",                                           options: ["To make food taste salty", "To kill bacteria and activate pepsin", "To absorb glucose", "To release insulin"], correct_index: 1, explanation: "HCl creates an acidic environment for protein digestion and pathogen control." },
  { bloom_level: "understand", stem: "What's the role of bile in digestion?",                                                     options: ["Breaks down proteins", "Emulsifies fats", "Absorbs water", "Produces enzymes"],         correct_index: 1,  explanation: "Bile breaks fat globules into smaller droplets so lipases can act on them." },
  { bloom_level: "understand", stem: "Why are villi shaped the way they are?",                                                    options: ["For movement", "To increase absorptive surface area", "To produce hormones", "To filter blood"], correct_index: 1, explanation: "Finger-like villi multiply surface area for nutrient absorption." },
  { bloom_level: "apply",      stem: "A patient has their gallbladder removed. Which dietary advice helps most?",                  options: ["Eat more sugar", "Eat smaller, lower-fat meals", "Skip meals", "Drink less water"],     correct_index: 1,  explanation: "Without gallbladder storage, bile is released continuously; smaller fat loads digest better." },
  { bloom_level: "apply",      stem: "If amylase is blocked, which food becomes hardest to digest?",                              options: ["Steak", "Bread", "Olive oil", "Cheese"],                                                correct_index: 1,  explanation: "Amylase digests starch; bread is starch-rich and would be most affected." },
  { bloom_level: "analyze",    stem: "How does the structure of the small intestine reflect its function?",                       options: ["Short and wide for fast transit", "Long, folded, with villi for maximum absorption", "Smooth-walled for storage", "Muscular for grinding"],   correct_index: 1, explanation: "Length, folds, villi and microvilli all increase the absorptive surface area dramatically." },
  { bloom_level: "analyze",    stem: "Why might lactose intolerance NOT show until adulthood?",                                   options: ["Lactose appears in adult food only", "Lactase enzyme production typically declines after weaning in many populations", "The stomach grows", "Bile thickens"], correct_index: 1, explanation: "Lactase persistence is the exception, not the rule, across humans." },
  { bloom_level: "evaluate",   stem: "Judge this claim: 'You should always avoid carbohydrates for healthy digestion.' Best response:", options: ["True for everyone", "Misleading — complex carbs are a normal nutrient class; context matters", "Only true on Mondays", "Only true for fruits"], correct_index: 1, explanation: "Carbohydrate avoidance is not a generic health rule; nuance matters." },
  { bloom_level: "create",     stem: "Design an experiment to show that bile speeds up fat digestion.",                           options: ["Watch a person eat", "Compare fat-droplet size in two test tubes — one with bile, one without — over time", "Weigh the gallbladder", "Measure body temperature"], correct_index: 1, explanation: "Comparing droplet size with and without bile isolates emulsification as the variable." },
];

(async () => {
  const env = loadEnvLocal();
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`\n🎒 Setting up second class "${CLASS_B_NAME}" for cross-class testing...\n`);

  // Resolve school + teachers
  const { data: school } = await sb.from("schools").select("id").eq("name", SCHOOL_NAME).maybeSingle();
  if (!school) { console.error(`❌ "${SCHOOL_NAME}" not found.`); process.exit(1); }
  const { data: usersList } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const primaryUser = usersList.users.find((u) => (u.email || "").toLowerCase() === PRIMARY_EMAIL);
  const coUser      = usersList.users.find((u) => (u.email || "").toLowerCase() === CO_EMAIL);
  if (!primaryUser || !coUser) { console.error(`❌ Teachers ${PRIMARY_EMAIL} / ${CO_EMAIL} must exist.`); process.exit(1); }
  const primaryId = primaryUser.id;
  const coId = coUser.id;
  console.log(`[1] Teachers: primary=${PRIMARY_EMAIL}, co=${CO_EMAIL}`);

  // Class B (find or create)
  let { data: classB } = await sb.from("classes").select("id, name, join_code").eq("school_id", school.id).eq("name", CLASS_B_NAME).maybeSingle();
  if (!classB) {
    const { data, error } = await sb.from("classes").insert({
      name: CLASS_B_NAME, grade: "7", subject: "Biology", section: "B",
      school_id: school.id, owner_id: primaryId, join_code: randomCode(6),
    }).select("id, name, join_code").single();
    if (error) throw new Error(`class insert: ${error.message}`);
    classB = data;
    console.log(`[2] Class B: created (id=${classB.id.slice(0,8)}…, join=${classB.join_code})`);
  } else {
    console.log(`[2] Class B: reusing existing (id=${classB.id.slice(0,8)}…)`);
  }

  // class_teachers: primary + co
  await sb.from("class_teachers").upsert(
    [
      { class_id: classB.id, teacher_id: primaryId, role: "primary", subject: "Biology" },
      { class_id: classB.id, teacher_id: coId,      role: "co",      subject: "Biology" },
    ],
    { onConflict: "class_id,teacher_id" },
  );
  console.log(`[3] class_teachers: primary + co linked`);

  // Roster — 8 new students
  console.log(`[4] Enrolling ${NEW_STUDENT_NAMES.length} students...`);
  for (const [base, fullName] of NEW_STUDENT_NAMES) {
    const email = `${base}@${SCHOOL_DOMAIN}`;
    const existing = usersList.users.find((u) => (u.email || "").toLowerCase() === email);
    let userId = existing?.id;
    if (!userId) {
      const { data: created, error: cErr } = await sb.auth.admin.createUser({
        email, password: PASSWORD, email_confirm: true,
        user_metadata: { role: "student", full_name: fullName, is_school_student: true },
      });
      if (cErr) { console.warn(`   ⚠ ${email}: ${cErr.message}`); continue; }
      userId = created.user.id;
      await sb.from("profiles").upsert(
        { id: userId, role: "student", full_name: fullName, is_school_student: true, school_id: school.id },
        { onConflict: "id" },
      );
    }
    await sb.from("class_members").upsert({ class_id: classB.id, student_id: userId }, { onConflict: "class_id,student_id" });
  }
  console.log(`   ✓ done`);

  // Quiz: insert questions owned by Ms. Priya
  let { data: existingQuiz } = await sb.from("quizzes")
    .select("id, code, name").eq("owner_id", primaryId).eq("name", QUIZ_NAME).maybeSingle();

  let quizId, quizCode;
  if (existingQuiz) {
    quizId = existingQuiz.id; quizCode = existingQuiz.code;
    console.log(`[5] Quiz: reusing "${QUIZ_NAME}" (code=${quizCode})`);
  } else {
    const qrows = BIO_QUESTIONS.map((q) => ({
      owner_id: primaryId, topic: "Digestive System",
      bloom_level: q.bloom_level, stem: q.stem, options: q.options,
      correct_index: q.correct_index, explanation: q.explanation, status: "approved",
    }));
    const { data: insertedQs, error: qInsErr } = await sb.from("question_bank").insert(qrows).select("id, bloom_level");
    if (qInsErr) throw new Error(`question_bank insert: ${qInsErr.message}`);

    let code = randomCode(6);
    for (let i = 0; i < 4; i++) {
      const { data: clash } = await sb.from("quizzes").select("id").eq("code", code).maybeSingle();
      if (!clash) break;
      code = randomCode(6);
    }
    const { data: quiz, error: qErr } = await sb.from("quizzes").insert({
      owner_id: primaryId, name: QUIZ_NAME, code,
      time_limit_minutes: 18, bloom_filter: ["remember", "understand", "apply", "analyze", "evaluate", "create"],
      subject: "Biology", topic_family: "Digestive System",
    }).select("id, code").single();
    if (qErr) throw new Error(`quiz insert: ${qErr.message}`);
    quizId = quiz.id; quizCode = quiz.code;

    const linkRows = insertedQs.map((q, i) => ({ quiz_id: quizId, question_id: q.id, position: i }));
    await sb.from("quiz_questions").insert(linkRows);

    const dueAt = new Date(Date.now() + 7 * 86400000).toISOString();
    await sb.from("quiz_assignments").insert({
      quiz_id: quizId, class_id: classB.id, student_id: null, assigned_by: primaryId, due_at: dueAt,
    });
    console.log(`[5] Quiz: created "${QUIZ_NAME}" (code=${quizCode}) and assigned to Class B`);
  }

  // Pull questions for attempt_answers
  const { data: linkRows } = await sb.from("quiz_questions").select("question_id, position").eq("quiz_id", quizId).order("position");
  const qIds = linkRows.map((r) => r.question_id);
  const { data: qBank } = await sb.from("question_bank").select("id, correct_index, bloom_level").in("id", qIds);
  const qById = new Map(qBank.map((q) => [q.id, q]));
  const orderedQs = qIds.map((id) => qById.get(id)).filter(Boolean);
  const total = orderedQs.length;

  // Attempts for every member
  const { data: members } = await sb.from("class_members")
    .select("student_id, profiles!class_members_student_id_fkey(full_name)")
    .eq("class_id", classB.id);

  console.log(`\n[6] Inserting attempts for ${members.length} students...`);
  // Spread "started" timestamps over the past 14 days so we get an
  // interesting trend line in the future Class Analytics page.
  let attemptsAdded = 0;
  for (const m of members) {
    const studentId = m.student_id;
    const studentName = m.profiles?.full_name || studentId.slice(0, 8);
    const { data: existing } = await sb.from("quiz_attempts")
      .select("id").eq("quiz_id", quizId).eq("student_id", studentId)
      .not("submitted_at", "is", null).limit(1).maybeSingle();
    if (existing) { console.log(`   • ${studentName}: already attempted`); continue; }

    const r = Math.random();
    const targetPct =
      r < 0.15 ? 85 + Math.random() * 10 :
      r < 0.65 ? 60 + Math.random() * 20 :
      r < 0.90 ? 35 + Math.random() * 20 :
                 15 + Math.random() * 15;
    const correctCount = Math.round((targetPct / 100) * total);
    const correctnessMask = Array(total).fill(false);
    for (let i = 0; i < correctCount; i++) correctnessMask[i] = true;
    for (let i = correctnessMask.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [correctnessMask[i], correctnessMask[j]] = [correctnessMask[j], correctnessMask[i]];
    }
    const daysAgo = Math.floor(Math.random() * 14);
    const startedAt = new Date(Date.now() - daysAgo * 86400000 - 30 * 60 * 1000);
    const submittedAt = new Date(startedAt.getTime() + Math.round((5 + Math.random() * 12) * 60 * 1000));
    const timeTakenSeconds = Math.round((submittedAt.getTime() - startedAt.getTime()) / 1000);

    const { data: attempt, error: aErr } = await sb.from("quiz_attempts").insert({
      quiz_id: quizId, student_id: studentId,
      started_at: startedAt.toISOString(), submitted_at: submittedAt.toISOString(),
      score: correctCount, total, time_taken_seconds: timeTakenSeconds,
    }).select("id").single();
    if (aErr) { console.warn(`   ⚠ ${studentName}: ${aErr.message}`); continue; }

    const answerRows = orderedQs.map((q, i) => {
      const isCorrect = correctnessMask[i];
      let selected;
      if (isCorrect) selected = q.correct_index;
      else {
        const wrong = [0, 1, 2, 3].filter((k) => k !== q.correct_index);
        selected = wrong[Math.floor(Math.random() * wrong.length)];
      }
      return { attempt_id: attempt.id, question_id: q.id, selected_index: selected, is_correct: isCorrect, bloom_level: q.bloom_level };
    });
    await sb.from("attempt_answers").insert(answerRows);
    attemptsAdded++;
    console.log(`   ✓ ${studentName}: ${correctCount}/${total} (${Math.round(targetPct)}%)`);
  }

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`✅ Class B is set up.`);
  console.log(`──────────────────────────────────────────────`);
  console.log(`  Class:     ${CLASS_B_NAME}`);
  console.log(`  Primary:   Ms. Priya Sharma`);
  console.log(`  Co-teacher: Mr. Raj Kumar`);
  console.log(`  Quiz:      ${QUIZ_NAME} (code=${quizCode})`);
  console.log(`  Attempts:  ${attemptsAdded} new`);
  console.log(`──────────────────────────────────────────────`);
  console.log(`Sign in as ${CO_EMAIL} to see cross-class data.\n`);
})().catch((e) => {
  console.error("\n❌ Unexpected error:", e.message || e);
  process.exit(1);
});
