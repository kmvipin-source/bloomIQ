# BloomIQ — session notes

Updated: 2026-04-29 (Wednesday). This is the resume point for next session.

---

## 1. What landed this session

### Major new features

| Area | Files | What's new |
|---|---|---|
| **Playwright e2e suite** | `playwright.config.ts`, `tests/e2e/**/*` | 130 tests across 6 spec files covering public/auth, super_teacher, teacher, student, parent, and cross-role isolation. Seed/cleanup helpers, fixtures, and `test:e2e:*` npm scripts. Uses bash heredoc for seed data; safe `test_` prefix on every row. |
| **Admin / Principal AI** | `lib/schoolContext.ts`, `app/api/school/coach`, `app/api/school/digest`, `app/school/coach`, `app/school/digest` | Principal Coach (chat with school data via Groq), Weekly Brief (auto-generated digest). Both gated to `super_teacher`. |
| **Admin reports tabs** | `app/school/reports/page.tsx`, `components/AtRiskWatchlist.tsx`, `components/ClassComparisonHeatmap.tsx`, `components/EngagementTrends.tsx`, `lib/bloomReports.ts` | Tab bar on /school/reports: Overview / At-risk / Compare / Engagement. URL-driven tab state. |
| **Teacher Coach + Brief** | `lib/teacherContext.ts`, `app/api/teacher/coach`, `app/api/teacher/digest`, `app/teacher/coach`, `app/teacher/digest` | Same architecture as Principal but scoped to teacher's classes (primary + co-teacher). |
| **Student Coach + Brief** | `lib/studentContext.ts`, `app/api/student/coach`, `app/api/student/digest`, `app/student/coach`, `app/student/digest` | Performance coach (separate from existing /student/tutor). Tracks bloom_trend_14d, weakest/strongest topics, class rank for school students. |
| **Misconception-aware distractors + answer-key verification** | `lib/qgen.ts`, modifications to `/api/generate`, `/api/student/quick-test`, `/api/papers/generate` | Mines real wrong-answer patterns from past attempts to seed distractors. Re-solves each question via second Groq call to verify answer key. |
| **Empirical difficulty + discrimination (light IRT)** | `lib/calibration.ts`, `lib/calibrationView.ts`, `app/api/qbank/calibrate`, badges in `app/teacher/quizzes/new/page.tsx` | Computes calibrated_difficulty + calibrated_discrimination per question once ≥20 attempts. Easy/Medium/Hard + Good/Weak/Broken badges. |
| **Adaptive personalised practice** | `app/api/student/adaptive-practice`, `app/student/practice` | Picks weakest Bloom level from student's last 30d, generates 5 questions there, redirects to /student/quiz/[code]. |
| **Daily smart drill + SRS** | `app/api/student/daily-drill`, `app/api/student/srs-due`, `app/student/drill` | 5-question morning drill: 2-3 from yesterday's misses + 2-3 from weakest Bloom levels. SRS due count surfaced on /student home. |
| **Question variants generator** | `app/api/qbank/[id]/variants`, `app/api/qbank/[id]/variants/save`, modal in `app/teacher/quizzes/new` | One-click → AI generates 3 isomorphic variants of any question, verified, candidate-list for teacher to pick from. |
| **Worked solutions** | `app/api/qbank/[id]/solution` | Step-by-step solution generator (Groq text). In-memory cache. |
| **Live class quiz mode (Kahoot-style)** | `app/api/live/*` (7 routes), `app/teacher/live/page.tsx`, `app/teacher/live/[code]/host`, `app/student/live/[code]` | Lobby → running → ended. 6-char code, students join, host advances per question. Time-decayed scoring (1000 max). 2s polling. |
| **CONVENTIONS.md** | `CONVENTIONS.md` | Test = formal graded, Quiz = quick interactive online MCQ, Practice = ungraded self-paced. UI labels follow this; DB column names stay. |
| **`/student/tests` rename** | `app/student/tests/page.tsx` | Renamed UI labels from "Tests" to "Practice" (route stays for backward compat). |

### Audit / docs

- **`RLS_AUDIT.md`** at project root — comprehensive Supabase Row Level Security audit. **4 HIGH-severity findings** (profiles read-all-auth, quizzes read-by-code, quiz_questions read-auth, question_bank read-approved) where any authenticated user can enumerate cross-tenant data. Fix sketches included. Fix before deployment.

---

## 2. Database migrations to run (in order)

These were created this session and **must** be applied to Supabase before the matching features will work:

| Migration | Required for |
|---|---|
| `supabase/migrations/18_question_calibration.sql` | Empirical difficulty/discrimination badges. |
| `supabase/migrations/20_daily_drill_attempts.sql` | Daily-drill analytics (the drill works without it but doesn't log results). |
| `supabase/migrations/21_live_quiz_sessions.sql` | Live class quiz mode (host/join/answer all need these tables). |

All three are **idempotent** (`if not exists`, `drop policy if exists`). Paste into Supabase SQL editor.

> Migration 19 (mock exam mode + photo upload) **was reverted** mid-session. The feature was removed; if you ever applied that migration locally, run the cleanup snippet noted in the revert response.

---

## 3. Reverted (ignore)

- **Online mock exam mode** + **photo-upload auto-grading** — built then reverted at user request (descriptive exams stay physical). All 14 files deleted; `lib/types.ts` and `app/teacher/papers/[id]/page.tsx` restored to pre-feature state.

---

## 4. Test fixture credentials (for manual exploration)

After running `npm run test:e2e:seed:full`, these accounts exist. **Password for all: `TestPass123!`**

| Role | Identifier (paste into login form) | Lands on |
|---|---|---|
| Admin Head — School A | `test_super_a@bloomiq-e2e.local` | `/school` |
| Admin Head — School B | `test_super_b@bloomiq-e2e.local` | `/school` |
| Primary Teacher (class A1) | `test_teacher_a@bloomiq-e2e.local` | `/teacher` |
| Co-Teacher (co on A1, primary on A2) | `test_teacher_a2@bloomiq-e2e.local` | `/teacher` |
| Teacher in school B | `test_teacher_b@bloomiq-e2e.local` | `/teacher` |
| School student A1 | `test_student_a1` *(username only)* | `/student` |
| School student A2 | `test_student_a2` | `/student` |
| School student B1 | `test_student_b1` | `/student` |
| Independent student | `test_indep_student@bloomiq-e2e.local` | `/student` |

`tests/e2e/CREDENTIALS.md` has the full reference + smoke walkthroughs.

`npm run test:e2e:cleanup` removes everything `test_*` when done.

---

## 5. Pending work for next session

### Critical pre-deployment

1. **Apply migrations 18, 20, 21** to Supabase.
2. **Fix the 4 HIGH-severity RLS findings** from `RLS_AUDIT.md`. Currently any authenticated user can read every profile, every quiz, every quiz_question, and every approved question-bank item across the platform. The fix migrations are sketched in the audit doc — turn them into a real `22_rls_hardening.sql`.

### Followups from features built this session

- Live class quiz mode: WebSocket / Supabase realtime channels instead of 2s polling (UX upgrade).
- Worked-solution cache → DB persistence (currently in-memory per Node process).
- Variants generator: feed misconception seeds (today it doesn't).
- Empirical-difficulty: re-calibrate jobs on a schedule rather than only on-demand.

### Original audit list — still to resume

1. Clean up the seven legacy `.js` stubs: `app/student/{myresults,practice,test}/page.js`, `app/teacher/{dashboard,myquizzes,quiz,upload}/page.js`. (Note: `/student/practice` now has a real `.tsx`; the `.js` stub may be stale.)
2. Extract a shared API helper (`lib/api.ts`) for `req.json().catch()` + auth + error responses across ~50 routes.
3. Tests for AI-heavy routes — currently they're page-render smoke tests only.
4. Write a real `CLAUDE.md` / `DEVELOPMENT.md` (the current `CLAUDE.md` is one line).

---

## 6. Notes on the Edit-tool truncation bug

The Edit tool truncates files mid-write at ~38–40 KB on this codebase. Symptoms: file ends mid-tag, mid-string, or mid-comment. Affected files this session: `app/teacher/page.tsx`, `app/student/page.tsx`, `app/school/page.tsx`, `app/school/reports/page.tsx`, `app/teacher/quizzes/new/page.tsx`, `package.json`, plus all 6 test specs and `tests/e2e/helpers/auth.ts` + `seed.ts`. All recovered via bash heredoc.

**For future sessions: prefer `cat > file <<'TAG'` for any rewrite of a file > ~30 KB. Edit tool is fine for small changes (< 5 KB diffs).**

---

## 7. Files added this session

```
# core helpers
lib/teacherContext.ts
lib/studentContext.ts
lib/schoolContext.ts
lib/bloomReports.ts
lib/qgen.ts
lib/calibration.ts
lib/calibrationView.ts

# admin reports
components/AtRiskWatchlist.tsx
components/ClassComparisonHeatmap.tsx
components/EngagementTrends.tsx

# coach + brief routes (3 roles)
app/api/{school,teacher,student}/coach/route.ts
app/api/{school,teacher,student}/digest/route.ts
app/{school,teacher,student}/coach/page.tsx
app/{school,teacher,student}/digest/page.tsx

# question features
app/api/qbank/calibrate/route.ts
app/api/qbank/[id]/variants/route.ts
app/api/qbank/[id]/variants/save/route.ts
app/api/qbank/[id]/solution/route.ts

# practice features
app/api/student/adaptive-practice/route.ts
app/api/student/daily-drill/route.ts
app/api/student/daily-drill/submit/route.ts
app/api/student/srs-due/route.ts
app/student/practice/page.tsx
app/student/drill/page.tsx

# live class quiz
app/api/live/start/route.ts
app/api/live/[code]/{state,join,next,start-running,answer,leaderboard}/route.ts
app/teacher/live/page.tsx
app/teacher/live/[code]/host/page.tsx
app/student/live/[code]/page.tsx

# tests
playwright.config.ts
tests/e2e/{01..06}-*.spec.ts
tests/e2e/helpers/{fixtures,supabase-admin,seed,cleanup,auth,global-setup,global-teardown,run-cleanup,run-seed,run-seed-full,run-verify-login,seed-quiz-data}.ts
tests/e2e/README.md
tests/e2e/CREDENTIALS.md

# migrations
supabase/migrations/18_question_calibration.sql
supabase/migrations/20_daily_drill_attempts.sql
supabase/migrations/21_live_quiz_sessions.sql

# docs
CONVENTIONS.md
RLS_AUDIT.md
SESSION_NOTES.md  ← this file
.env.test.example
```

## 8. Files modified this session

```
app/teacher/page.tsx              (+ Coach/Brief/Live cards)
app/student/page.tsx              (+ Coach/Brief/Practice/Drill cards)
app/school/page.tsx               (+ Principal AI section)
app/school/reports/page.tsx       (tab bar + 3 new tab views)
app/teacher/quizzes/new/page.tsx  (calibration badges + variants modal)
app/api/generate/route.ts         (misconception distractors + verify)
app/api/student/quick-test/route.ts  (same)
app/api/papers/generate/route.ts  (same)
app/student/tests/page.tsx        (renamed labels Tests → Practice)
lib/types.ts                      (no functional changes; restored after revert)
package.json                      (test:e2e:* scripts + dev deps)
.gitignore                        (playwright outputs)
```
