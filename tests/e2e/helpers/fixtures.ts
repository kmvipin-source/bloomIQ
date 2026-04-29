/**
 * Shared test fixture identifiers.
 *
 * All test data is prefixed with `test_` so the cleanup script can find and
 * delete it. Anything else stays untouched.
 *
 * Two schools (A and B) are created so we can verify cross-school isolation.
 *
 * Naming conventions:
 *  - emails:    test_<role>@bloomiq-e2e.local   (real-looking but unique domain)
 *  - usernames: test_<role>_<n>                  (school-student style)
 *  - schools:   test_school_a / test_school_b
 *  - classes:   test_class_<n>
 *  - quizzes:   test_quiz_<n>
 *  - papers:    test_paper_<n>
 */

export const TEST_DOMAIN = "bloomiq-e2e.local";
export const TEST_PASSWORD = "TestPass123!";

export const TEST_PREFIX = "test_";

export const FIXTURES = {
  superTeacherA: {
    email: `test_super_a@${TEST_DOMAIN}`,
    password: TEST_PASSWORD,
    fullName: "test_Super A",
    role: "super_teacher" as const,
    schoolName: "test_school_a",
    schoolKey: "A",
  },
  superTeacherB: {
    email: `test_super_b@${TEST_DOMAIN}`,
    password: TEST_PASSWORD,
    fullName: "test_Super B",
    role: "super_teacher" as const,
    schoolName: "test_school_b",
    schoolKey: "B",
  },
  teacherA: {
    email: `test_teacher_a@${TEST_DOMAIN}`,
    password: TEST_PASSWORD,
    fullName: "test_Teacher A",
    role: "teacher" as const,
    schoolKey: "A",
  },
  teacherA2: {
    email: `test_teacher_a2@${TEST_DOMAIN}`,
    password: TEST_PASSWORD,
    fullName: "test_Teacher A2",
    role: "teacher" as const,
    schoolKey: "A",
  },
  teacherB: {
    email: `test_teacher_b@${TEST_DOMAIN}`,
    password: TEST_PASSWORD,
    fullName: "test_Teacher B",
    role: "teacher" as const,
    schoolKey: "B",
  },
  studentA1: {
    username: "test_student_a1",
    password: TEST_PASSWORD,
    fullName: "test_Student A1",
    role: "student" as const,
    isSchoolStudent: true,
    schoolKey: "A",
  },
  studentA2: {
    username: "test_student_a2",
    password: TEST_PASSWORD,
    fullName: "test_Student A2",
    role: "student" as const,
    isSchoolStudent: true,
    schoolKey: "A",
  },
  studentB1: {
    username: "test_student_b1",
    password: TEST_PASSWORD,
    fullName: "test_Student B1",
    role: "student" as const,
    isSchoolStudent: true,
    schoolKey: "B",
  },
  independentStudent: {
    email: `test_indep_student@${TEST_DOMAIN}`,
    password: TEST_PASSWORD,
    fullName: "test_Independent Student",
    role: "student" as const,
    isSchoolStudent: false,
  },
} as const;

export type FixtureKey = keyof typeof FIXTURES;

export const TEST_CLASS_A1 = "test_class_a1"; // owned by teacherA in school A
export const TEST_CLASS_A2 = "test_class_a2"; // owned by teacherA2 in school A
export const TEST_CLASS_B1 = "test_class_b1"; // owned by teacherB in school B

export const TEST_QUIZ_A = "test_quiz_a"; // teacherA's
export const TEST_QUIZ_B = "test_quiz_b"; // teacherB's

/**
 * For a username like "test_student_a1", produce the synthetic email the app
 * uses internally: `test_student_a1@bloomiq.invalid`. This matches the
 * SCHOOL_STUDENT_DOMAIN constant in lib/supabase/server.ts.
 */
export function usernameToEmail(username: string): string {
  return `${username.toLowerCase()}@bloomiq.invalid`;
}
