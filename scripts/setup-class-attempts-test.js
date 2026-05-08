// Full setup for end-to-end teacher-report testing.
//
// Builds a complete dataset in one shot — no UI clicking needed:
//   1. Inserts 18 canned Photosynthesis questions (one per Bloom level
//      × 3) into question_bank, owned by Mr. Raj (or whichever teacher
//      you specify).
//   2. Creates a quiz "Photosynthesis Class Quiz" linking those questions.
//   3. Assigns the quiz to Grade 6 - Mathematics A (Test Academy).
//   4. Adds 12 synthetic students to that class roster (so total ≥ 15).
//   5. Inserts a realistic, score-varied quiz_attempt + attempt_answers
//      for every class member.
//
// Idempotent on re-run: existing students stay, existing class quizzes
// gain another attempt per student. Drop and rerun seed-test-users.js
// --plan school_standard --reset for a clean slate first.
//
// Usage (from project root):
//   node scripts/setup-class-attempts-test.js
//   node scripts/setup-class-attempts-test.js 12      // 12 extra synthetic students (default)
//   node scripts/setup-class-attempts-test.js 0       // only existing students take it
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
const SCHOOL_NAME = process.env.SEED_SCHOOL_NAME || "Test Academy";
const CLASS_NAME = "Grade 6 - Mathematics A";
const TEACHER_EMAIL = "mr.raj@testacademy.example.com";
const QUIZ_NAME = "Photosynthesis Class Quiz";

function randomCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

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

// 18 canned Photosynthesis questions: 3 per Bloom level, balanced.
// Format matches the question_bank schema.
const CANNED_QUESTIONS = [
  // Remember (3)
  { bloom_level: "remember", stem: "What is the green pigment in plants that absorbs light energy?", options: ["Carotene", "Chlorophyll", "Xanthophyll", "Anthocyanin"], correct_index: 1, explanation: "Chlorophyll is the primary pigment that absorbs light for photosynthesis." },
  { bloom_level: "remember", stem: "In which organelle does photosynthesis primarily occur in plant cells?", options: ["Nucleus", "Mitochondrion", "Chloroplast", "Ribosome"], correct_index: 2, explanation: "Chloroplasts contain the thylakoid membranes where photosynthesis occurs." },
  { bloom_level: "remember", stem: "What gas is produced as a byproduct of photosynthesis?", options: ["Carbon dioxide", "Nitrogen", "Oxygen", "Hydrogen"], correct_index: 2, explanation: "Photosynthesis releases oxygen as a byproduct of splitting water." },
  // Understand (3)
  { bloom_level: "understand", stem: "Why do plants need sunlight for photosynthesis?", options: ["To stay warm", "To provide energy to convert CO2 and water into glucose", "To attract pollinators", "To release water vapor"], correct_index: 1, explanation: "Light energy drives the reactions that convert CO2 and water into glucose." },
  { bloom_level: "understand", stem: "Which of the following best explains the role of chlorophyll?", options: ["It stores starch", "It absorbs light energy and transfers it to other molecules", "It releases water", "It produces seeds"], correct_index: 1, explanation: "Chlorophyll absorbs light and channels that energy into the photosynthetic chain." },
  { bloom_level: "understand", stem: "Why are leaves typically green?", options: ["They reflect green light", "They absorb only green light", "They have no pigment", "They emit green light"], correct_index: 0, explanation: "Chlorophyll absorbs red and blue light but reflects green, which is why leaves appear green." },
  // Apply (3)
  { bloom_level: "apply", stem: "A farmer wants to maximize crop yield by boosting photosynthesis. Which factor should they prioritize?", options: ["More fertilizer alone", "More sunlight and CO2 availability", "Cooler night temperatures only", "Less water"], correct_index: 1, explanation: "Photosynthesis is rate-limited by light and CO2 in many practical settings." },
  { bloom_level: "apply", stem: "If a plant is moved into a dark room, what would happen to its glucose production?", options: ["Increase", "Stay the same", "Decrease to nearly zero", "Double"], correct_index: 2, explanation: "Without light, the light-dependent reactions stop and glucose production halts." },
  { bloom_level: "apply", stem: "Which experiment best tests whether CO2 is required for photosynthesis?", options: ["Vary the light intensity", "Place a plant in a sealed jar with NaOH (which absorbs CO2)", "Change the soil pH", "Add more nitrogen fertilizer"], correct_index: 1, explanation: "NaOH removes CO2; if photosynthesis stops, CO2 is shown to be required." },
  // Analyze (3)
  { bloom_level: "analyze", stem: "Compare light-dependent reactions and the Calvin cycle in terms of where they occur:", options: ["Both in the cytoplasm", "Light-dependent in thylakoid membrane; Calvin cycle in stroma", "Both in mitochondria", "Light-dependent in stroma; Calvin cycle in nucleus"], correct_index: 1, explanation: "The two stages of photosynthesis are spatially separated within the chloroplast." },
  { bloom_level: "analyze", stem: "Why does the rate of photosynthesis plateau at very high light intensities?", options: ["Plants stop producing chlorophyll", "Other factors (e.g., CO2, enzymes) become limiting", "Water becomes the byproduct", "The plant goes dormant"], correct_index: 1, explanation: "Once light is no longer the bottleneck, another factor (CO2 supply, enzyme rate) limits the reaction." },
  { bloom_level: "analyze", stem: "How does the structure of a leaf relate to its function in photosynthesis?", options: ["Thick cuticle blocks all light", "Stomata allow gas exchange; mesophyll cells maximize chloroplast surface area", "Roots produce most of the chlorophyll", "Veins absorb sunlight"], correct_index: 1, explanation: "Leaf anatomy is optimized for both light capture and gas exchange." },
  // Evaluate (3)
  { bloom_level: "evaluate", stem: "Which conclusion is best supported by an experiment showing increased plant growth at 1000 ppm CO2 vs 400 ppm?", options: ["CO2 is irrelevant to plant growth", "CO2 enrichment can increase photosynthetic rate up to a saturation point", "Plants only need water and light", "Higher CO2 always damages plants"], correct_index: 1, explanation: "The data supports CO2 as a limiting factor up to a saturation level." },
  { bloom_level: "evaluate", stem: "Judge the claim: 'All photosynthesis releases oxygen.' Which is most accurate?", options: ["True for all forms of photosynthesis", "True only for oxygenic photosynthesis (most plants and algae)", "False — no photosynthesis releases oxygen", "True only at night"], correct_index: 1, explanation: "Anoxygenic photosynthetic bacteria do photosynthesis without releasing O2." },
  { bloom_level: "evaluate", stem: "Critique: 'Plants make their own food using only soil nutrients.' What's the flaw?", options: ["Plants don't make food", "The claim ignores the central role of light, CO2, and water in synthesis", "Soil nutrients aren't real", "Plants only eat insects"], correct_index: 1, explanation: "Photosynthesis converts CO2 and water using light energy; soil nutrients support but don't drive the synthesis." },
  // Create (3)
  { bloom_level: "create", stem: "Design an experiment to determine the effect of light wavelength on photosynthesis rate. Which design is most rigorous?", options: ["Compare two plants in different windows", "Use identical plants under monochromatic LEDs (red, blue, green) at equal intensity, measure O2 production", "Measure plant height once a week", "Smell the leaves"], correct_index: 1, explanation: "Equal-intensity monochromatic exposure with O2 measurement isolates wavelength as the variable." },
  { bloom_level: "create", stem: "Propose a way to demonstrate that water is split during photosynthesis.", options: ["Weigh the plant", "Use isotopically labeled H2O (with 18O) and detect 18O2 in the released oxygen", "Put a thermometer in the leaf", "Watch the plant grow"], correct_index: 1, explanation: "Isotope labeling tracks oxygen origin; 18O appearing in O2 confirms water as the source." },
  { bloom_level: "create", stem: "Design a closed terrarium that maintains plant life for months. Which factor is most critical to balance?", options: ["The size of the rocks", "The CO2 / O2 cycle between plants and any soil microbes (or animals)", "The color of the glass", "The plant species name"], correct_index: 1, explanation: "Long-term sealed systems require biological gas balance; without it CO2 or O2 will deplete." },
];

(async () => {
  const env = loadEnvLocal();
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const args = process.argv.slice(2);
  const numExtra = args[0] != null ? parseInt(args[0], 10) : 12;

  console.log(`\n🎲 Setting up end-to-end teacher-report test dataset...\n`);

  // Resolve teacher
  const { data: usersList } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const teacherUser = usersList.users.find((u) => (u.email || "").toLowerCase() === TEACHER_EMAIL);
  if (!teacherUser) {
    console.error(`❌ Teacher ${TEACHER_EMAIL} not found. Run seed-test-users.js --plan school_standard --reset first.`);
    process.exit(1);
  }
  const teacherId = teacherUser.id;
  console.log(`[1] Teacher: ${TEACHER_EMAIL} (id=${teacherId.slice(0, 8)}…)`);

  // Resolve school + class
  const { data: school } = await sb.from("schools").select("id").eq("name", SCHOOL_NAME).maybeSingle();
  if (!school) { console.error(`❌ School "${SCHOOL_NAME}" not found.`); process.exit(1); }
  const { data: klass } = await sb.from("classes").select("id, name, school_id, join_code").eq("name", CLASS_NAME).eq("school_id", school.id).maybeSingle();
  if (!klass) { console.error(`❌ Class "${CLASS_NAME}" not found.`); process.exit(1); }
  console.log(`[2] Class: ${klass.name} (id=${klass.id.slice(0, 8)}…)`);

  // Insert canned questions (idempotent: skip if a quiz with QUIZ_NAME already exists for this owner)
  const { data: existingQuiz } = await sb.from("quizzes")
    .select("id, code, name").eq("owner_id", teacherId).eq("name", QUIZ_NAME).maybeSingle();

  let quizId, quizCode;
  if (existingQuiz) {
    quizId = existingQuiz.id;
    quizCode = existingQuiz.code;
    console.log(`[3] Quiz: reusing existing "${QUIZ_NAME}" (code=${quizCode})`);
  } else {
    // Insert questions
    const questionRows = CANNED_QUESTIONS.map((q) => ({
      owner_id: teacherId,
      topic: "Photosynthesis",
      bloom_level: q.bloom_level,
      stem: q.stem,
      options: q.options,
      correct_index: q.correct_index,
      explanation: q.explanation,
      status: "approved",
    }));
    const { data: insertedQs, error: qInsErr } = await sb.from("question_bank").insert(questionRows).select("id, bloom_level");
    if (qInsErr) throw new Error(`question_bank insert: ${qInsErr.message}`);
    console.log(`[3] Questions: ${insertedQs.length} canned questions inserted`);

    // Create quiz with unique code
    let code = randomCode(6);
    for (let i = 0; i < 4; i++) {
      const { data: clash } = await sb.from("quizzes").select("id").eq("code", code).maybeSingle();
      if (!clash) break;
      code = randomCode(6);
    }
    const totalMinutes = Math.max(15, insertedQs.length * 1.4);
    const { data: quiz, error: qErr } = await sb.from("quizzes").insert({
      owner_id: teacherId,
      name: QUIZ_NAME,
      code,
      time_limit_minutes: Math.round(totalMinutes),
      bloom_filter: ["remember", "understand", "apply", "analyze", "evaluate", "create"],
      subject: "Science",
      topic_family: "Photosynthesis",
    }).select("id, code").single();
    if (qErr) throw new Error(`quiz insert: ${qErr.message}`);
    quizId = quiz.id;
    quizCode = quiz.code;
    console.log(`    quiz created (code=${quizCode}, time_limit=${Math.round(totalMinutes)} min)`);

    // Link questions to quiz in order
    const linkRows = insertedQs.map((q, i) => ({ quiz_id: quizId, question_id: q.id, position: i }));
    const { error: linkErr } = await sb.from("quiz_questions").insert(linkRows);
    if (linkErr) throw new Error(`quiz_questions insert: ${linkErr.message}`);

    // Assign to class with a future due date
    const dueAt = new Date(Date.now() + 7 * 86400000).toISOString();
    const { error: asgErr } = await sb.from("quiz_assignments").insert({
      quiz_id: quizId, class_id: klass.id, student_id: null, assigned_by: teacherId, due_at: dueAt,
    });
    if (asgErr) throw new Error(`quiz_assignments insert: ${asgErr.message}`);
    console.log(`    quiz assigned to ${klass.name} (due ${dueAt.slice(0, 10)})`);
  }

  // Add synthetic students
  if (numExtra > 0) {
    console.log(`\n[4] Synthetic students (up to ${numExtra})...`);
    let added = 0;
    for (let i = 0; i < numExtra && i < POOL_NAMES.length; i++) {
      const [base, fullName] = POOL_NAMES[i];
      const email = `${base}@${SCHOOL_DOMAIN}`;
      const existing = usersList.users.find((u) => (u.email || "").toLowerCase() === email);
      let userId = existing?.id;
      if (!userId) {
        const { data: created, error: cErr } = await sb.auth.admin.createUser({
          email, password: PASSWORD, email_confirm: true,
          user_metadata: { role: "student", full_name: fullName, is_school_student: true },
        });
        if (cErr) { console.warn(`   ⚠ skip ${email}: ${cErr.message}`); continue; }
        userId = created.user.id;
        await sb.from("profiles").upsert(
          { id: userId, role: "student", full_name: fullName, is_school_student: true, school_id: school.id },
          { onConflict: "id" },
        );
      }
      await sb.from("class_members")
        .upsert({ class_id: klass.id, student_id: userId }, { onConflict: "class_id,student_id" });
      added++;
    }
    console.log(`   ✓ ensured ${added} synthetic students enrolled`);
  }

  // Pull canonical question list (for attempt_answers)
  const { data: linkRows } = await sb.from("quiz_questions").select("question_id, position").eq("quiz_id", quizId).order("position");
  const qIds = linkRows.map((r) => r.question_id);
  const { data: qBank } = await sb.from("question_bank").select("id, correct_index, bloom_level").in("id", qIds);
  const qById = new Map(qBank.map((q) => [q.id, q]));
  const orderedQs = qIds.map((id) => qById.get(id)).filter(Boolean);
  const total = orderedQs.length;

  // Pull class roster
  const { data: members } = await sb.from("class_members")
    .select("student_id, profiles!class_members_student_id_fkey(full_name)")
    .eq("class_id", klass.id);

  console.log(`\n[5] Inserting attempts for ${members.length} students...`);
  const startedAt = new Date(Date.now() - 30 * 60 * 1000);
  let attemptsAdded = 0;

  for (const m of members) {
    const studentId = m.student_id;
    const studentName = m.profiles?.full_name || studentId.slice(0, 8);

    // Skip if a submitted attempt already exists for this student+quiz
    const { data: existing } = await sb.from("quiz_attempts")
      .select("id").eq("quiz_id", quizId).eq("student_id", studentId)
      .not("submitted_at", "is", null).limit(1).maybeSingle();
    if (existing) { console.log(`   • ${studentName}: already attempted, skipping`); continue; }

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
      return {
        attempt_id: attempt.id, question_id: q.id,
        selected_index: selected, is_correct: isCorrect, bloom_level: q.bloom_level,
      };
    });
    const { error: ansErr } = await sb.from("attempt_answers").insert(answerRows);
    if (ansErr) { console.warn(`   ⚠ ${studentName}: answers: ${ansErr.message}`); continue; }

    attemptsAdded++;
    console.log(`   ✓ ${studentName}: ${correctCount}/${total} (${Math.round(targetPct)}%) in ${Math.round(timeTakenSeconds / 60)}m`);
  }

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`✅ Setup complete.`);
  console.log(`──────────────────────────────────────────────`);
  console.log(`  Quiz:       ${QUIZ_NAME} (code=${quizCode})`);
  console.log(`  Class:      ${klass.name}`);
  console.log(`  Attempts:   ${attemptsAdded} new (existing kept as-is)`);
  console.log(`──────────────────────────────────────────────`);
  console.log(`Sign in as ms.priya@testacademy.example.com OR mr.raj@testacademy.example.com`);
  console.log(`(password ${PASSWORD}) at /login/school -> Teacher tab to view reports.\n`);
})().catch((e) => {
  console.error("\n❌ Unexpected error:", e.message || e);
  process.exit(1);
});
