# BloomIQ naming conventions

User-facing copy must use these three terms with the exact meanings below.
DB column names (`quizzes`, `quiz_attempts`, `exam_papers`) stay as-is to
avoid migration cost — only UI labels change.

## The three concepts

### Test (formal, graded)
- A high-stakes assessment, structured in sections, marked, possibly timed.
- Two delivery modes:
  1. **Printable Test** — the existing `/teacher/papers/*` flow, exported as PDF.
  2. **Online Test** — student takes the same paper digitally with strict
     timing in the new "mock exam mode" at `/student/exam/[code]`.
- Backed by the `exam_papers` and (new) `exam_attempts` tables.
- UI labels: "Test", "Tests", "Create test", "My tests".
- Where you'll see it: `/teacher/papers` (rename label to "Tests"),
  `/student/exam/*`.

### Quiz (interactive, low-stakes)
- A quick MCQ session students take online for instant feedback.
- Auto-graded, scored as a percentage. Used for class formative checks.
- Backed by the `quizzes`, `quiz_questions`, `quiz_attempts` tables.
- UI labels: "Quiz", "Quizzes", "Create quiz", "Take a quiz", "Quiz code".
- Where you'll see it: `/teacher/quizzes/*`, `/student/quiz/[code]`.

### Practice (ungraded, self-paced)
- Questions a student generates for themselves to study; never goes into
  a teacher's gradebook.
- Includes the adaptive practice surface (`/student/practice`),
  the generate-your-own surface (`/student/generate`), and any saved
  practice quizzes a student keeps for later.
- UI labels: "Practice", "Practice questions", "Generate practice",
  "Adaptive practice".
- Where you'll see it: `/student/practice`, `/student/generate`,
  `/student/tests` (legacy route — page is the student's saved practice).

## Rules of thumb when writing new copy

- **Never** call a printable paper a "quiz". It's a Test.
- **Never** call an interactive online MCQ session a "test" in copy.
  It's a Quiz.
- If the student made it themselves and it doesn't go to the teacher's
  gradebook → it's Practice, regardless of the underlying table.
- The student-facing route `/student/tests` is legacy; new student
  surfaces should use `/student/quizzes` for quizzes or
  `/student/practice` for practice. Don't add new copy that says "tests"
  there.

## Examples

| Situation | Correct term |
|---|---|
| Teacher creates a 90-minute board-pattern paper | Test |
| Student writes that paper at home, online | Test (online mock exam mode) |
| Teacher creates a 10-question MCQ for class warm-up | Quiz |
| Student types "Photosynthesis" and AI generates 5 MCQs to drill | Practice |
| Student takes the Coach-recommended adaptive set | Practice |

## DB → UI mapping cheat sheet

| DB / route | UI term |
|---|---|
| `quizzes` table | Quiz |
| `quiz_attempts` table | Quiz attempt (or just "attempt") |
| `exam_papers` table | Test |
| `exam_attempts` table (new) | Test attempt |
| `/teacher/quizzes` | "My quizzes" |
| `/teacher/papers` | "My tests" |
| `/student/quiz/[code]` | "Take quiz" |
| `/student/exam/[code]` | "Take test" |
| `/student/practice` | "Adaptive practice" |
| `/student/generate` | "Practice generator" |
| `/student/tests` (legacy) | "My practice" |
