/**
 * Seed *content* (questions, quizzes, attempts) on top of the user/class
 * seed. Splitting them keeps the basic seed (used by Playwright globalSetup)
 * fast, and lets the manual-exploration seed produce dashboards with real
 * data — top students, Bloom breakdowns, recent attempts, etc.
 *
 * What this creates (all `test_` prefixed):
 *
 *   - 10 question_bank rows owned by test_teacher_a, status='approved',
 *     5 Bloom levels x 2 topics (Photosynthesis, Algebra).
 *   - 2 quizzes:
 *       test_quiz_photosynthesis (5 photosynthesis questions)
 *       test_quiz_algebra        (5 algebra questions)
 *     Both with code prefixed `TEST-` so they're easy to spot.
 *   - quiz_assignments linking each quiz to class A1.
 *   - quiz_attempts with realistic scores:
 *       studentA1 → photo 5/5, algebra 4/5      (top student)
 *       studentA2 → photo 3/5, algebra 2/5
 *   - attempt_answers per question that match the score (so per-Bloom and
 *     per-question stats line up with the totals).
 *
 * Cleanup is automatic: all rows have a foreign key chain back to the test
 * users/schools, so deleting the auth users (the existing cleanup script)
 * cascades these away too.
 */

import { admin } from "./supabase-admin";
import { FIXTURES, TEST_CLASS_A1 } from "./fixtures";

type BloomLevel = "remember" | "understand" | "apply" | "analyze" | "evaluate" | "create";

type SeedQ = {
  topic: string;
  bloom_level: BloomLevel;
  stem: string;
  options: [string, string, string, string];
  correct_index: 0 | 1 | 2 | 3;
  explanation: string;
};

const QUESTIONS_PHOTO: SeedQ[] = [
  {
    topic: "Photosynthesis",
    bloom_level: "remember",
    stem: "Which pigment is primarily responsible for absorbing light during photosynthesis?",
    options: ["Hemoglobin", "Chlorophyll", "Melanin", "Keratin"],
    correct_index: 1,
    explanation: "Chlorophyll absorbs red and blue light; that's why leaves look green.",
  },
  {
    topic: "Photosynthesis",
    bloom_level: "understand",
    stem: "What is the overall input-to-output relationship of photosynthesis?",
    options: [
      "Glucose + oxygen → carbon dioxide + water",
      "Carbon dioxide + water → glucose + oxygen",
      "Water + oxygen → glucose + carbon dioxide",
      "Glucose + carbon dioxide → water + oxygen",
    ],
    correct_index: 1,
    explanation: "Light energy converts CO2 and H2O into glucose, releasing O2 as a byproduct.",
  },
  {
    topic: "Photosynthesis",
    bloom_level: "apply",
    stem: "A plant kept in dim light produces 4 mL of oxygen per hour. If the same plant is moved into bright light and the rate doubles, how much oxygen is produced in 3 hours?",
    options: ["12 mL", "16 mL", "24 mL", "32 mL"],
    correct_index: 2,
    explanation: "New rate is 8 mL/hr × 3 hr = 24 mL.",
  },
  {
    topic: "Photosynthesis",
    bloom_level: "analyze",
    stem: "If you measure CO2 levels in a sealed chamber holding a healthy plant, what pattern do you expect over a 24-hour day-night cycle?",
    options: [
      "Steady decrease throughout",
      "Steady increase throughout",
      "Decrease in daylight, increase at night",
      "Increase in daylight, decrease at night",
    ],
    correct_index: 2,
    explanation: "Photosynthesis consumes CO2 in light; respiration produces it continuously, dominating at night.",
  },
  {
    topic: "Photosynthesis",
    bloom_level: "evaluate",
    stem: "A researcher claims tropical rainforests are the planet's main 'lungs'. Which counterargument is best supported?",
    options: [
      "Rainforests don't produce any oxygen",
      "Phytoplankton in oceans contribute roughly half of global O2 production",
      "Trees only photosynthesize at night",
      "Photosynthesis is a minor process compared to volcanic activity",
    ],
    correct_index: 1,
    explanation: "Marine phytoplankton account for an estimated 50–70% of Earth's oxygen output.",
  },
];

const QUESTIONS_ALGEBRA: SeedQ[] = [
  {
    topic: "Algebra",
    bloom_level: "remember",
    stem: "What is the value of x in the equation x + 7 = 12?",
    options: ["3", "5", "7", "19"],
    correct_index: 1,
    explanation: "Subtract 7 from both sides: x = 12 − 7 = 5.",
  },
  {
    topic: "Algebra",
    bloom_level: "understand",
    stem: "Which expression is equivalent to 3(x + 4)?",
    options: ["3x + 4", "x + 12", "3x + 12", "3x − 12"],
    correct_index: 2,
    explanation: "Distribute: 3·x + 3·4 = 3x + 12.",
  },
  {
    topic: "Algebra",
    bloom_level: "apply",
    stem: "Solve for y: 2y − 5 = 11.",
    options: ["3", "6", "8", "16"],
    correct_index: 2,
    explanation: "Add 5: 2y = 16. Divide by 2: y = 8.",
  },
  {
    topic: "Algebra",
    bloom_level: "analyze",
    stem: "A function f satisfies f(2)=5 and f(5)=14. Which simple linear formula matches both?",
    options: ["f(x) = x + 3", "f(x) = 3x − 1", "f(x) = 2x + 1", "f(x) = x² + 1"],
    correct_index: 1,
    explanation: "f(2)=3·2−1=5 and f(5)=3·5−1=14. The slope is (14−5)/(5−2)=3 and intercept is −1.",
  },
  {
    topic: "Algebra",
    bloom_level: "create",
    stem: "Construct a word problem whose solution requires solving the equation 4x − 3 = 17.",
    options: [
      "I have 4 apples and 3 oranges; how many fruits in total?",
      "Four times a number minus 3 equals 17; what is the number?",
      "Add 4 and 17; what is the result?",
      "What is the difference between 4 and 17?",
    ],
    correct_index: 1,
    explanation: "Translating 'four times a number minus 3 equals 17' gives 4x − 3 = 17.",
  },
];

async function findUserIdByEmail(email: string): Promise<string> {
  const sb = admin();
  let page = 1;
  for (let i = 0; i < 50; i++) {
    const { data: list, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    if (!list?.users?.length) break;
    const found = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (found) return found.id;
    if (list.users.length < 200) break;
    page++;
  }
  throw new Error(`User not found: ${email}`);
}

async function findClassIdByName(name: string): Promise<string> {
  const sb = admin();
  const { data, error } = await sb.from("classes").select("id").eq("name", name).single();
  if (error) throw error;
  return data!.id;
}

async function ensureBankQuestions(ownerId: string, qs: SeedQ[]): Promise<string[]> {
  const sb = admin();
  const ids: string[] = [];
  for (const q of qs) {
    // Idempotent: keyed on owner + stem.
    const { data: existing } = await sb
      .from("question_bank")
      .select("id")
      .eq("owner_id", ownerId)
      .eq("stem", q.stem)
      .maybeSingle();
    if (existing?.id) {
      ids.push(existing.id);
      continue;
    }
    const { data, error } = await sb
      .from("question_bank")
      .insert({
        owner_id: ownerId,
        topic: q.topic,
        bloom_level: q.bloom_level,
        stem: q.stem,
        options: q.options,
        correct_index: q.correct_index,
        explanation: q.explanation,
        status: "approved", // make them readable to students taking the quiz
      })
      .select("id")
      .single();
    if (error) throw error;
    ids.push(data!.id);
  }
  return ids;
}

async function ensureQuiz(opts: {
  ownerId: string;
  name: string;
  code: string;
  questionIds: string[];
  bloomFilter?: string[];
  timeLimit?: number;
}): Promise<string> {
  const sb = admin();
  const { data: existing } = await sb
    .from("quizzes")
    .select("id")
    .eq("owner_id", opts.ownerId)
    .eq("name", opts.name)
    .maybeSingle();
  let quizId: string;
  if (existing?.id) {
    quizId = existing.id;
  } else {
    const { data, error } = await sb
      .from("quizzes")
      .insert({
        owner_id: opts.ownerId,
        name: opts.name,
        code: opts.code,
        time_limit_minutes: opts.timeLimit ?? 10,
        bloom_filter: opts.bloomFilter ?? [],
        active: true,
      })
      .select("id")
      .single();
    if (error) throw error;
    quizId = data!.id;
  }

  // Refresh quiz_questions: clear and re-insert in order. Composite PK
  // (quiz_id, question_id) plus position field.
  await sb.from("quiz_questions").delete().eq("quiz_id", quizId);
  if (opts.questionIds.length) {
    const rows = opts.questionIds.map((qid, i) => ({
      quiz_id: quizId,
      question_id: qid,
      position: i,
    }));
    const { error } = await sb.from("quiz_questions").insert(rows);
    if (error) throw error;
  }
  return quizId;
}

async function ensureClassAssignment(quizId: string, classId: string, assignedBy: string) {
  const sb = admin();
  const { data: existing } = await sb
    .from("quiz_assignments")
    .select("id")
    .eq("quiz_id", quizId)
    .eq("class_id", classId)
    .maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await sb
    .from("quiz_assignments")
    .insert({
      quiz_id: quizId,
      class_id: classId,
      assigned_by: assignedBy,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id;
}

/**
 * Wipe and re-create one student's attempt + per-question answers for a quiz.
 * `correctnessMask` decides which questions they got right — index-aligned
 * with `questionIds`.
 */
async function ensureAttempt(opts: {
  quizId: string;
  studentId: string;
  questionIds: string[];
  questions: SeedQ[];
  correctnessMask: boolean[];
  daysAgo: number;
}): Promise<void> {
  const sb = admin();

  // Wipe any prior attempt by this student on this quiz so re-seeding gives
  // a clean, deterministic state. attempt_answers cascades.
  await sb.from("quiz_attempts").delete().eq("quiz_id", opts.quizId).eq("student_id", opts.studentId);

  const total = opts.questionIds.length;
  const score = opts.correctnessMask.filter(Boolean).length;
  const submittedAt = new Date(Date.now() - opts.daysAgo * 24 * 3600 * 1000);
  const startedAt = new Date(submittedAt.getTime() - 8 * 60 * 1000); // 8-min attempt

  const { data: attempt, error } = await sb
    .from("quiz_attempts")
    .insert({
      quiz_id: opts.quizId,
      student_id: opts.studentId,
      started_at: startedAt.toISOString(),
      submitted_at: submittedAt.toISOString(),
      score,
      total,
      time_taken_seconds: 8 * 60,
    })
    .select("id")
    .single();
  if (error) throw error;

  const answerRows = opts.questionIds.map((qid, i) => {
    const q = opts.questions[i];
    const correct = opts.correctnessMask[i];
    // For incorrect, pick a wrong index deterministically: (correct + 1) mod 4.
    const selected = correct ? q.correct_index : ((q.correct_index + 1) % 4);
    return {
      attempt_id: attempt!.id,
      question_id: qid,
      selected_index: selected,
      is_correct: correct,
      bloom_level: q.bloom_level,
    };
  });
  const { error: ansErr } = await sb.from("attempt_answers").insert(answerRows);
  if (ansErr) throw ansErr;
}

export async function seedQuizData() {
  console.log("[seed-quiz-data] starting...");

  const teacherAId = await findUserIdByEmail(FIXTURES.teacherA.email);
  const studentA1Id = await findUserIdByEmail(`${FIXTURES.studentA1.username}@bloomiq.invalid`);
  const studentA2Id = await findUserIdByEmail(`${FIXTURES.studentA2.username}@bloomiq.invalid`);
  const classA1Id = await findClassIdByName(TEST_CLASS_A1);

  // 1. Question bank
  const photoIds = await ensureBankQuestions(teacherAId, QUESTIONS_PHOTO);
  const algebraIds = await ensureBankQuestions(teacherAId, QUESTIONS_ALGEBRA);

  // 2. Quizzes
  const photoQuizId = await ensureQuiz({
    ownerId: teacherAId,
    name: "test_quiz_photosynthesis",
    code: "TEST-PHOTO",
    questionIds: photoIds,
    bloomFilter: [],
    timeLimit: 10,
  });
  const algebraQuizId = await ensureQuiz({
    ownerId: teacherAId,
    name: "test_quiz_algebra",
    code: "TEST-ALG",
    questionIds: algebraIds,
    bloomFilter: [],
    timeLimit: 10,
  });

  // 3. Assignments to class A1
  await ensureClassAssignment(photoQuizId, classA1Id, teacherAId);
  await ensureClassAssignment(algebraQuizId, classA1Id, teacherAId);

  // 4. Attempts spread across the last 30 days so the engagement-trends
  //    sparkline has activity on multiple days, the at-risk watchlist
  //    reflects a real declining pattern, and the heatmap has cells in
  //    multiple Bloom levels.
  //
  //    studentA1 = top performer (improving over time)
  //    studentA2 = at-risk (declining over time, low overall avg)
  //
  //    Note: ensureAttempt deletes prior rows for (quiz, student), so we
  //    can only seed ONE attempt per student per quiz. To get historical
  //    trends, we use both quizzes plus a re-attempt at older dates by
  //    reusing the same quiz at different `daysAgo` values is not possible
  //    (it overwrites). Instead we spread the four canonical attempts
  //    across 4 different days.

  await ensureAttempt({
    quizId: photoQuizId,
    studentId: studentA1Id,
    questionIds: photoIds,
    questions: QUESTIONS_PHOTO,
    correctnessMask: [true, true, true, true, true], // 5/5 — top student
    daysAgo: 1,
  });
  await ensureAttempt({
    quizId: algebraQuizId,
    studentId: studentA1Id,
    questionIds: algebraIds,
    questions: QUESTIONS_ALGEBRA,
    correctnessMask: [true, true, true, false, true], // 4/5
    daysAgo: 6,
  });
  await ensureAttempt({
    quizId: photoQuizId,
    studentId: studentA2Id,
    questionIds: photoIds,
    questions: QUESTIONS_PHOTO,
    correctnessMask: [true, false, false, false, false], // 1/5 — at-risk
    daysAgo: 2,
  });
  await ensureAttempt({
    quizId: algebraQuizId,
    studentId: studentA2Id,
    questionIds: algebraIds,
    questions: QUESTIONS_ALGEBRA,
    correctnessMask: [true, false, false, false, false], // 1/5 — at-risk
    daysAgo: 12,
  });

  console.log(
    `[seed-quiz-data] done. ` +
      `bank=${photoIds.length + algebraIds.length}, quizzes=2, ` +
      `assignments=2, attempts=4, answers=${4 * 5}`
  );
}
