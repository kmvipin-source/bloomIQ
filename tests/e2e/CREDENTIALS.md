# Test fixture credentials

These accounts exist only after you run `npm run test:e2e:seed` (or after a
Playwright suite kicks off, since `globalSetup` re-seeds them). They get
removed by `npm run test:e2e:cleanup` and by the suite's `globalTeardown`.

**Password for every account: `TestPass123!`**

## How to log in

Open the dev server (`npm run dev` if not already running) and visit
`/login`. The form has a single "Email or username" field — paste the
identifier from the table below, then the shared password.

| Role | What to type in the form | Lands on |
|---|---|---|
| **Admin Head — School A** (super_teacher) | `test_super_a@bloomiq-e2e.local` | `/school` |
| **Admin Head — School B** | `test_super_b@bloomiq-e2e.local` | `/school` |
| **Primary Teacher (class A1)** | `test_teacher_a@bloomiq-e2e.local` | `/teacher` |
| **Co-Teacher** (non-primary on class A1, primary on A2) | `test_teacher_a2@bloomiq-e2e.local` | `/teacher` |
| **Teacher in school B** | `test_teacher_b@bloomiq-e2e.local` | `/teacher` |
| **School Student A1** | `test_student_a1` (just the username) | `/student` |
| **School Student A2** | `test_student_a2` | `/student` |
| **School Student B1** | `test_student_b1` | `/student` |
| **Independent Student** (own subscription) | `test_indep_student@bloomiq-e2e.local` | `/student` |

> School students sign in with their **username**, not an email — the form
> appends `@bloomiq.invalid` internally. Don't paste the synthetic
> `test_student_a1@bloomiq.invalid` form; just `test_student_a1`.

## What's in the seeded data

**Schools**
- `test_school_a` — super_teacher: test_super_a — join code `TEST-TEST_SCHOOL_A`
- `test_school_b` — super_teacher: test_super_b — join code `TEST-TEST_SCHOOL_B`

**Classes**
| Class name | School | Primary teacher | Co-teachers | Students |
|---|---|---|---|---|
| `test_class_a1` | A | test_Teacher A | test_Teacher A2 (co) | studentA1, studentA2 |
| `test_class_a2` | A | test_Teacher A2 | — | — |
| `test_class_b1` | B | test_Teacher B | — | studentB1 |

The Independent Student is **not** in any class — they're for testing the
self-study / paid-tier flow.

## Quick smoke walkthroughs

**As Admin Head (test_super_a):**
1. Login → lands on `/school`.
2. Visit `/school/classes` — should list both A1 and A2 (A2 has 0 students yet).
3. `/school/teachers` — both Teacher A and Teacher A2 with their class counts.
4. `/school/students` — Student A1 and A2 only (no leakage of School B).

**As Primary Teacher (test_teacher_a):**
1. Login → lands on `/teacher`.
2. `/teacher/classes` — see class A1.
3. Click into A1 — see two students + Bulk-add button + co-teacher A2.

**As Co-Teacher (test_teacher_a2):**
1. Login → `/teacher`.
2. `/teacher/classes` — see BOTH class A1 (as co-teacher) AND class A2 (as primary).
3. Click into A1 — same roster as Teacher A sees, but you don't have primary controls.

**As School Student (test_student_a1):**
1. Login with username → `/student`.
2. Should show class A1 and zero attempts (no quizzes seeded yet).
3. Try `/student/visualizer`, `/student/xray`, etc. — all should render.

**As Independent Student (test_indep_student):**
1. Login with email → `/student`.
2. NOT in any class. Free-tier daily attempt cap UI should be visible
   (school students don't see this).

## Reset / clean up

```bash
# wipe everything test_*
npm run test:e2e:cleanup

# re-seed fresh
npm run test:e2e:seed
```

Both are idempotent — run them as many times as you like.
