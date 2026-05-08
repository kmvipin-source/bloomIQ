// Adds a SECOND quiz to each of the two test classes, with attempts that
// are DRIFTED from the first attempt — so the new class-analytics
// "Trend" column shows real change-over-time (some kids improving, some
// declining, some flat). Without this, every student has 1 attempt and
// Trend is always "—".
//
// What it does:
//   1. Looks for "Grade 6 - Mathematics A" and "Grade 7 - Biology B"
//      under Test Academy.
//   2. For each class, if a second quiz hasn't been added yet, inserts a
//      topical second quiz, links it to the class via quiz_assignments.
//   3. For every student in each class who took the FIRST quiz, generates
//      a second attempt with score = clamp(firstScore + drift, 0%..100%)
//      where drift is roughly Normal(0, 12 pp). So:
//        - ~half drift up (+improvement),
//        - ~half drift down (decline),
//        - a few drift sideways (flat).
//      Submitted-at on the second attempt is 3-10 days AFTER the first
//      so it reads as a follow-up assessment.
//
// Idempotent: skip if a class already has its second quiz.
//
// Usage: node scripts/add-second-quiz-per-class.js
//
// Prereqs: setup-class-attempts-test.js and setup-second-class-test.js
// must have already run (so Class A and Class B exist with attempts).

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

function randomCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// Approximate Normal(mean, std) via Box-Muller.
function gauss(mean, std) {
  let u = 0; while (u === 0) u = Math.random();
  let v = 0; while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + z * std;
}

const SCHOOL_NAME = "Test Academy";

// Two follow-up quizzes — one per class. Same Bloom distribution as the
// originals so apples-to-apples comparison makes sense.
const QUIZ_A_NAME = "Cell Structure Quiz";
const QUIZ_A_TOPIC = "Cell biology";
const QUIZ_A_TEACHER_EMAIL = "mr.raj@testacademy.example.com";  // owner = same teacher who owns Photosynthesis
const QUIZ_A_QUESTIONS = [
  { bloom_level: "remember",   stem: "What organelle is known as the powerhouse of the cell?",                            options: ["Nucleus", "Mitochondrion", "Ribosome", "Lysosome"],                                 correct_index: 1, explanation: "Mitochondria generate ATP, the cell's main energy currency." },
  { bloom_level: "remember",   stem: "Which structure controls what enters and leaves the cell?",                          options: ["Cell membrane", "Cytoplasm", "Endoplasmic reticulum", "Cell wall"],                  correct_index: 0, explanation: "The semi-permeable cell membrane regulates molecular traffic." },
  { bloom_level: "understand", stem: "Why do plant cells have a cell wall but animal cells don't?",                        options: ["Plants need it for movement", "Cell walls provide structural rigidity that plants need to stand", "Animal cells move", "Plants don't photosynthesize"],   correct_index: 1, explanation: "Without skeletons, plants depend on cell walls for structure." },
  { bloom_level: "understand", stem: "What's the role of ribosomes?",                                                       options: ["DNA replication", "Protein synthesis", "Energy storage", "Waste removal"],            correct_index: 1, explanation: "Ribosomes translate mRNA into proteins." },
  { bloom_level: "apply",      stem: "If a cell's mitochondria stop working, the cell would primarily lose its ability to:", options: ["Synthesize DNA", "Produce ATP", "Make cell walls", "Sense light"],                  correct_index: 1, explanation: "Mitochondria are the main ATP producers via cellular respiration." },
  { bloom_level: "apply",      stem: "A scientist sees a cell with a large central vacuole and a cell wall. Most likely:",  options: ["Animal cell", "Plant cell", "Bacteria", "Virus"],                                    correct_index: 1, explanation: "Plant cells are the textbook combination of central vacuole + cell wall." },
  { bloom_level: "analyze",    stem: "Compare smooth and rough endoplasmic reticulum:",                                     options: ["Both have ribosomes", "Rough has ribosomes (protein synth) and smooth doesn't (lipid synth, detox)", "Both make lipids", "Smooth has ribosomes"], correct_index: 1, explanation: "Rough ER is dotted with ribosomes; smooth ER specializes in lipid metabolism." },
  { bloom_level: "analyze",    stem: "Why do red blood cells lack a nucleus?",                                              options: ["So they can divide faster", "To maximize hemoglobin/oxygen-carrying capacity", "Because they don't need DNA at all in life", "Random evolution"], correct_index: 1, explanation: "Removing the nucleus frees space for hemoglobin and lets RBCs flex through capillaries." },
  { bloom_level: "evaluate",   stem: "Judge: 'All cells have a nucleus.' Best response:",                                   options: ["Always true", "False — prokaryotes (bacteria) don't have a nucleus", "True only at night", "Only true for plants"], correct_index: 1, explanation: "Prokaryotic cells lack a true membrane-bound nucleus." },
  { bloom_level: "evaluate",   stem: "Critique: 'Mitochondria evolved from ancient bacteria.' Most accurate stance:",       options: ["Pure speculation", "Strongly supported (endosymbiotic theory) — mitochondria have their own DNA, ribosomes, double membrane", "Disproven", "Only for plants"], correct_index: 1, explanation: "Endosymbiosis is one of the best-supported origin theories in biology." },
  { bloom_level: "create",     stem: "Design an experiment to confirm mitochondria contain their own DNA.",                 options: ["Look at a plant", "Stain isolated mitochondria with a DNA-specific dye and image", "Weigh the cell", "Watch the cell divide"], correct_index: 1, explanation: "Direct DNA staining of isolated mitochondria visually confirms their genetic material." },
  { bloom_level: "create",     stem: "Propose a method to determine which cells in a tissue are most metabolically active.", options: ["Look at color", "Stain for mitochondrial density / activity (e.g., MitoTracker) and quantify", "Count nuclei only", "Measure cell volume only"], correct_index: 1, explanation: "Mitochondrial activity stains correlate well with metabolic demand." },
];

const QUIZ_B_NAME = "Respiratory System Quiz";
const QUIZ_B_TOPIC = "Respiratory System";
const QUIZ_B_TEACHER_EMAIL = "ms.priya@testacademy.example.com";  // same owner as Digestive System Quiz
const QUIZ_B_QUESTIONS = [
  { bloom_level: "remember",   stem: "What's the primary muscle of breathing?",                                            options: ["Diaphragm", "Heart", "Biceps", "Quadriceps"],                                       correct_index: 0, explanation: "The diaphragm contracts to draw air into the lungs." },
  { bloom_level: "remember",   stem: "Where does gas exchange occur in the lungs?",                                        options: ["Bronchi", "Trachea", "Alveoli", "Pleura"],                                          correct_index: 2, explanation: "Alveoli are the tiny air sacs where O2 and CO2 cross the blood barrier." },
  { bloom_level: "understand", stem: "Why is the inside of the lungs moist?",                                              options: ["For taste", "Gases dissolve in water before crossing the alveolar membrane", "To trap dust", "For warmth"],            correct_index: 1, explanation: "Diffusion of gases across membranes requires a moist interface." },
  { bloom_level: "understand", stem: "What pulls oxygen into red blood cells?",                                            options: ["Heart muscle", "Hemoglobin's affinity for O2 / partial pressure gradient", "Iron crystals", "Sound waves"], correct_index: 1, explanation: "Hemoglobin binds O2 strongly where pO2 is high (alveoli) and releases it where pO2 is low (tissues)." },
  { bloom_level: "apply",      stem: "At high altitude, breathing rate increases primarily because:",                       options: ["Air is colder", "Lower O2 partial pressure means less O2 per breath", "Air is heavier", "Random"],         correct_index: 1, explanation: "Thinner air → less O2 → body compensates by breathing faster." },
  { bloom_level: "apply",      stem: "An athlete with chronic asthma should avoid:",                                       options: ["Cold dry air during intense exercise", "Drinking water", "Sleeping", "Eating"],     correct_index: 0, explanation: "Cold dry air can trigger bronchospasm in asthmatic lungs during exertion." },
  { bloom_level: "analyze",    stem: "Compare the structure of arteries and veins of the lungs:",                          options: ["Both carry oxygenated blood", "Pulmonary artery: deoxy blood (heart→lungs); pulmonary vein: oxy blood (lungs→heart) — REVERSED from systemic", "Same as systemic circulation", "Veins carry CO2 only"], correct_index: 1, explanation: "Pulmonary circulation reverses the usual oxygenation labels." },
  { bloom_level: "analyze",    stem: "Why do smokers' lungs lose elasticity over time?",                                  options: ["Genetic flip", "Smoke damages elastin in alveolar walls (emphysema), reducing recoil", "Breathing too fast", "Cold air"], correct_index: 1, explanation: "Elastin destruction is the structural hallmark of emphysema." },
  { bloom_level: "evaluate",   stem: "Judge: 'The diaphragm relaxes when you inhale.' Most accurate:",                     options: ["True for everyone", "False — diaphragm CONTRACTS on inhalation, expanding the chest", "True only at rest", "True only when sleeping"], correct_index: 1, explanation: "Inhalation requires diaphragm contraction; relaxation drives passive exhalation." },
  { bloom_level: "evaluate",   stem: "Best evidence that gas exchange depends on surface area:",                           options: ["Anecdotes", "Lung surface area is ~70 m² (tennis court) and emphysema (loss of alveoli) sharply reduces O2 capacity", "Pure theory", "Only seen in fish"], correct_index: 1, explanation: "Loss of alveolar surface area in disease directly reduces gas exchange." },
  { bloom_level: "create",     stem: "Design an experiment to measure how exercise intensity affects breathing rate.",     options: ["Read a book", "Have a participant rest and exercise at increasing intensities; record breaths/min and minute-volume at each level", "Take a single measurement at rest", "Watch a video"], correct_index: 1, explanation: "A within-subjects increasing-intensity protocol isolates exercise as the variable." },
  { bloom_level: "create",     stem: "Propose a way to compare healthy vs smoker lung function non-invasively.",            options: ["MRI of the brain", "Spirometry (FEV1 / FVC ratio) on healthy and smoker volunteers", "DNA test only", "Heart rate alone"], correct_index: 1, explanation: "Spirometry quantifies airflow obstruction characteristic of smoker lung disease." },
];

const TARGETS = [
  { className: "Grade 6 - Mathematics A", quiz: { name: QUIZ_A_NAME, topic: QUIZ_A_TOPIC, teacherEmail: QUIZ_A_TEACHER_EMAIL, questions: QUIZ_A_QUESTIONS } },
  { className: "Grade 7 - Biology B",     quiz: { name: QUIZ_B_NAME, topic: QUIZ_B_TOPIC, teacherEmail: QUIZ_B_TEACHER_EMAIL, questions: QUIZ_B_QUESTIONS } },
];

(async () => {
  const env = loadEnvLocal();
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`\n📈 Adding follow-up quizzes so the Trend column has real data...\n`);

  const { data: school } = await sb.from("schools").select("id").eq("name", SCHOOL_NAME).maybeSingle();
  if (!school) { console.error(`❌ "${SCHOOL_NAME}" not found.`); process.exit(1); }
  const { data: usersList } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });

  for (const target of TARGETS) {
    console.log(`──── ${target.className} ────`);

    const { data: klass } = await sb.from("classes")
      .select("id, name").eq("school_id", school.id).eq("name", target.className).maybeSingle();
    if (!klass) { console.warn(`   ⚠ class not found, skipping`); continue; }

    const teacher = usersList.users.find((u) => (u.email || "").toLowerCase() === target.quiz.teacherEmail);
    if (!teacher) { console.warn(`   ⚠ teacher ${target.quiz.teacherEmail} not found, skipping`); continue; }
    const teacherId = teacher.id;

    // Check if this follow-up quiz already exists for this teacher.
    const { data: existing } = await sb.from("quizzes")
      .select("id, code").eq("owner_id", teacherId).eq("name", target.quiz.name).maybeSingle();

    let quizId, quizCode;
    if (existing) {
      quizId = existing.id; quizCode = existing.code;
      console.log(`   • quiz "${target.quiz.name}" already exists (code=${quizCode})`);
    } else {
      const qrows = target.quiz.questions.map((q) => ({
        owner_id: teacherId, topic: target.quiz.topic,
        bloom_level: q.bloom_level, stem: q.stem, options: q.options,
        correct_index: q.correct_index, explanation: q.explanation, status: "approved",
      }));
      const { data: insertedQs, error: qErr } = await sb.from("question_bank").insert(qrows).select("id, bloom_level");
      if (qErr) { console.warn(`   ⚠ question_bank: ${qErr.message}`); continue; }

      let code = randomCode(6);
      for (let i = 0; i < 4; i++) {
        const { data: clash } = await sb.from("quizzes").select("id").eq("code", code).maybeSingle();
        if (!clash) break;
        code = randomCode(6);
      }
      const { data: quiz, error: zErr } = await sb.from("quizzes").insert({
        owner_id: teacherId, name: target.quiz.name, code,
        time_limit_minutes: 15,
        bloom_filter: ["remember", "understand", "apply", "analyze", "evaluate", "create"],
        subject: target.className.includes("Mathematics") ? "Science" : "Biology",
        topic_family: target.quiz.topic,
      }).select("id, code").single();
      if (zErr) { console.warn(`   ⚠ quiz insert: ${zErr.message}`); continue; }
      quizId = quiz.id; quizCode = quiz.code;

      const linkRows = insertedQs.map((q, i) => ({ quiz_id: quizId, question_id: q.id, position: i }));
      await sb.from("quiz_questions").insert(linkRows);

      const dueAt = new Date(Date.now() + 5 * 86400000).toISOString();
      await sb.from("quiz_assignments").insert({
        quiz_id: quizId, class_id: klass.id, student_id: null, assigned_by: teacherId, due_at: dueAt,
      });
      console.log(`   ✓ created "${target.quiz.name}" (code=${quizCode}) and assigned to class`);
    }

    // Pull questions for attempt_answers
    const { data: linkRows } = await sb.from("quiz_questions").select("question_id, position").eq("quiz_id", quizId).order("position");
    const qIds = linkRows.map((r) => r.question_id);
    const { data: qBank } = await sb.from("question_bank").select("id, correct_index, bloom_level").in("id", qIds);
    const qById = new Map(qBank.map((q) => [q.id, q]));
    const orderedQs = qIds.map((id) => qById.get(id)).filter(Boolean);
    const total = orderedQs.length;

    // Find first-quiz attempts per student in this class so we can drift
    // their score for the follow-up.
    const { data: members } = await sb.from("class_members")
      .select("student_id, profiles!class_members_student_id_fkey(full_name)")
      .eq("class_id", klass.id);
    const memberIds = (members || []).map((m) => m.student_id);

    // What was each student's score on their FIRST quiz in this class? We
    // ignore the new quiz itself when computing this; we want the original
    // (Photosynthesis / Digestive System) score.
    const { data: priorAtts } = await sb.from("quiz_attempts")
      .select("student_id, score, total")
      .neq("quiz_id", quizId)
      .in("student_id", memberIds)
      .not("submitted_at", "is", null);
    const priorPctByStudent = new Map();
    for (const a of (priorAtts || [])) {
      if (a.total > 0 && !priorPctByStudent.has(a.student_id)) {
        priorPctByStudent.set(a.student_id, (a.score / a.total) * 100);
      }
    }

    let attemptsAdded = 0;
    for (const m of members || []) {
      const studentId = m.student_id;
      const studentName = m.profiles?.full_name || studentId.slice(0, 8);

      // Skip if already has follow-up attempt
      const { data: ex } = await sb.from("quiz_attempts")
        .select("id").eq("quiz_id", quizId).eq("student_id", studentId)
        .not("submitted_at", "is", null).limit(1).maybeSingle();
      if (ex) { continue; }

      const priorPct = priorPctByStudent.get(studentId);
      let targetPct;
      if (priorPct === undefined) {
        // No first attempt — give them a baseline middle-band score
        targetPct = 50 + gauss(0, 15);
      } else {
        // Drift: gauss(0, 12) pp around prior. Bias slightly upward so
        // some kids show real improvement.
        targetPct = priorPct + gauss(2, 12);
      }
      targetPct = Math.max(5, Math.min(98, targetPct));
      const correctCount = Math.round((targetPct / 100) * total);
      const correctnessMask = Array(total).fill(false);
      for (let i = 0; i < correctCount; i++) correctnessMask[i] = true;
      for (let i = correctnessMask.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [correctnessMask[i], correctnessMask[j]] = [correctnessMask[j], correctnessMask[i]];
      }

      // Submitted 3-10 days AFTER the first attempt's general window.
      const daysAgo = Math.floor(Math.random() * 4); // 0-3 days ago
      const startedAt = new Date(Date.now() - daysAgo * 86400000 - 30 * 60 * 1000);
      const submittedAt = new Date(startedAt.getTime() + Math.round((4 + Math.random() * 10) * 60 * 1000));
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

      const drift = priorPct !== undefined
        ? Math.round(targetPct - priorPct)
        : null;
      const driftStr = drift === null ? "" : ` (drift ${drift >= 0 ? "+" : ""}${drift}pp from prior)`;
      console.log(`   ✓ ${studentName}: ${correctCount}/${total} (${Math.round(targetPct)}%)${driftStr}`);
    }

    console.log(`   → added ${attemptsAdded} follow-up attempts\n`);
  }

  console.log(`──────────────────────────────────────────────`);
  console.log(`✅ Done. Class analytics "Trend" column should now show:`);
  console.log(`   ↑ improvement / ↓ decline / − flat with pp delta per student.`);
  console.log(`──────────────────────────────────────────────\n`);
})().catch((e) => {
  console.error("\n❌ Unexpected error:", e.message || e);
  process.exit(1);
});
