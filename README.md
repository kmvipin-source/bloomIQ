# 🌱 BloomIQ

**Assess _how_ students think — not just what they recall.**

BloomIQ is an end-to-end Bloom's Taxonomy-driven assessment platform. Three role tiers (school principals, teachers, students), two student modes (school-managed vs independent subscription), AI-generated content from five sources, Bloom-level analytics, printable exam papers, and reporting suites.

---

## ⚠️ Important — Next.js 16

This project uses **Next.js 16** with breaking changes — APIs, conventions, and file structure may differ from older Next.js docs / training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing routing/data-fetching code. Heed deprecation notices.

---

## 🚀 Quick start

```bash
# 1. Clone
git clone https://github.com/kmvipin-source/bloomIQ.git
cd bloomIQ

# 2. Create .env.local (see Environment section)

# 3. Install
npm install

# 4. Apply Supabase migrations (in Supabase SQL Editor, in order)
#    schema.sql → migrations/01_*.sql ... 28_*.sql
#    Run `notify pgrst, 'reload schema';` after.

# 5. Run
npm run dev
```

App at `http://localhost:3000`. Pull-before-run rhythm: `git fetch origin && git status` → `git pull origin main` if behind → `npm install` if `package-lock.json` changed → `npm run dev`.

---

## 📦 Tech stack

| Part | Tool |
|------|------|
| Framework | Next.js 16 App Router (**webpack — Turbopack disabled**), React 19, TypeScript |
| Styling | Tailwind CSS v4 |
| Database + Auth | Supabase (Postgres, RLS, email/password) |
| AI text | Groq SDK — Llama 3.3 70B versatile |
| AI vision | Groq — Llama 4 Scout multimodal (past-paper / image generation) |
| Charts | Recharts |
| Excel | SheetJS (xlsx) |
| PDFs (per-student reports) | jsPDF + jspdf-autotable |
| PDFs (exam papers) | Browser print → Save as PDF |
| OCR (image past-papers) | tesseract.js |
| Email | Nodemailer (Gmail SMTP) |
| Payments | Razorpay (orders + HMAC verify, INR / UPI / cards / netbanking) |
| Tests | Playwright e2e |

---

## 🔐 Environment variables (`.env.local`)

```
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJh...
NEXT_PUBLIC_GROQ_API_KEY=gsk_...
SUPABASE_SERVICE_ROLE_KEY=eyJh...      # service-role — admin ops, server-side only
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
CRON_SECRET=<random_string>            # guards /api/cron/expire-subscriptions
```

Optional — weekly digest emails:
```
EMAIL=youraccount@gmail.com
PASS=your_gmail_app_password
DIGEST_FROM=BloomIQ <youraccount@gmail.com>
```

`SUPABASE_SERVICE_ROLE_KEY` is required for Add Student / Reset Password / Co-teacher invite / Platform Admin flows. Get from Supabase Dashboard → Settings → API → service_role.

---

## 🛠️ Commands

```bash
npm run dev            # Next 16 dev server (webpack — Turbopack disabled)
npm run build          # production build
npm run start          # serve production build
npm run lint           # eslint

# Playwright e2e
npm run test:e2e             # run all
npm run test:e2e:ui          # UI runner
npm run test:e2e:headed      # headed browser
npm run test:e2e:list        # list specs
npm run test:e2e:report      # show last HTML report
npx playwright test tests/e2e/03-teacher.spec.ts             # single file
npx playwright test -g "name fragment"                       # by test name

# E2E fixtures (require SUPABASE_SERVICE_ROLE_KEY)
npm run test:e2e:seed        # seed minimal
npm run test:e2e:seed:full   # seed full fixture set
npm run test:e2e:verify      # verify login works
npm run test:e2e:cleanup     # delete all test_* rows
```

There is no `typecheck` npm script — invoke directly: `npx tsc --noEmit -p tsconfig.check.json`. `Sidebar.tsx` has 4 known JSX errors that predate the current codebase; project still compiles via SWC.

---

## 🏛️ Architecture

### Roles + student modes

```
profiles.role:
  ├── teacher              — manages classes, generates quizzes, grades
  ├── super_teacher        — Admin Head (typically Principal); sees everyone in their school
  └── student
       ├── is_school_student=true  — created by a teacher; logs in with USERNAME (no email needed)
       └── is_school_student=false — independent learner with a subscription; logs in with EMAIL
```

> Internal role name stays `super_teacher` for backwards compatibility, but the user-facing label everywhere in the UI is **Admin Head**. One school has exactly one Admin Head (enforced by partial unique index on `schools.super_teacher_id`); ownership transfers via `/api/admin/school/transfer`.

Plus `profiles.platform_admin` boolean — BloomIQ staff (separate from `super_teacher`). Bootstrap first platform admin via SQL; afterwards self-serve from `/admin/team`.

```sql
update public.profiles
set platform_admin = true
where id = (select id from auth.users where email = 'YOUR@email.com');
```

**Routes by role on login:**
- `teacher → /teacher`
- `super_teacher → /school`
- `student → /student` (page detects `is_school_student` and shows different UI)
- platform admin → `/admin/*`
- anyone (incl. logged-out visitors) → `/pricing`

**School student auth:** synthetic email `<username>@bloomiq.invalid` (RFC reserved, never deliverable). The login page auto-detects: any input without `@` is treated as a username and synthesised before being sent to Supabase.

**Single-session enforcement** applies only to **independent students** (teachers, Admin Heads, and school students stay multi-device).

### Supabase clients (`lib/supabase/`)

- `client.ts` → `supabaseBrowser()` browser singleton.
- `server.ts` → `supabaseServer(token?)` token-scoped server client (RLS applies); `supabaseAdmin()` service-role client (bypasses RLS — use carefully); `getBearer(req)` parses bearer; `usernameToSyntheticEmail()` for school-student auth.

API-route auth pattern: `getBearer(req) → supabaseServer(token) → auth.getUser()`. Use `supabaseAdmin()` only when RLS gaps would otherwise block legitimate cross-tenant ops (school-admin reads, parent-token data, school-join-code lookup) and re-verify scope in JS.

### AI generation (`lib/groq.ts` + `lib/qgen.ts`)

`groqJSON()` and `groqJSONVision()` are the only entry points to Groq. Every MCQ-emitting route (`/api/generate`, `/api/student/quick-test`, `/api/papers/generate`) goes through `lib/qgen.ts` which:

1. Mines `attempt_answers` for misconception-grounded distractor seeds (`findMisconceptionDistractors`).
2. Re-solves each generated question via a second Groq call (`verifyAnswerKey`); mismatch triggers one regeneration.

Once a question has ≥20 attempts, `lib/calibration.ts` computes empirical difficulty + point-biserial discrimination. UI badges (Easy/Medium/Hard, Good/Weak/Broken) come from `lib/calibrationView.ts`.

### Plan-Admin + feature gating

`plans` is versioned (slug + status: draft / pending_review / active / archived). `subscriptions.plan_id` FKs a specific version → grandfathering survives catalogue edits. Approving a draft auto-archives the prior active version of the same slug. **Two-eyes principle**: approver ≠ proposer (enforced at API + DB).

`lib/features.ts` is the single source of truth for the 21 gateable feature keys. `lib/featureAccess.ts` exposes `useFeatureAccess()` hook (client) and `requireFeature(userId, key)` (server). For `is_school_student=true` users, the hook reads the **school's** active subscription, not personal. Expiry checks use `subscriptions.expires_at`; the cron `/api/cron/expire-subscriptions` flips status, but the dashboard checks expiry directly so the cron is mostly cosmetic.

`StudentFeatureTile` renders dimmed + opens `PaywallModal` when feature key not in `allowed`.

Per-student school pricing: `plans.pricing_model = 'fixed' | 'per_student'`. Per-student plans store `per_student_price_paise`, `min_students`, `max_students`. School plans seeded in migration 28.

### Live class quiz

Kahoot-style at `/teacher/live/[code]/host` + `/student/live/[code]`. Lobby → running → ended. 6-char join code via `lib/exam/code.ts`. Time-decayed scoring (1000 max). 2s polling (no WebSocket — Supabase realtime is an open follow-up).

### Parent dashboard

`/parent/[token]` is read-only and **deliberately does not touch auth**. Token IS the credential, validated server-side via `parent_invites`. `/api/parent/data` uses `supabaseAdmin()` and explicitly filters every query by the resolved `student_id`.

---

## 📝 Naming convention (Test / Quiz / Practice)

User-facing copy must use these three terms with the exact meanings below. DB column names (`quizzes`, `quiz_attempts`, `exam_papers`) stay as-is to avoid migration cost — only UI labels change.

### Test (formal, graded)
- High-stakes assessment, structured in sections, marked, possibly timed.
- Two delivery modes:
  1. **Printable Test** — `/teacher/papers/*` flow, exported as PDF.
  2. **Online Test** — student takes the same paper digitally (`/student/exam/[code]`).
- Backed by `exam_papers` and (planned) `exam_attempts` tables.
- UI labels: "Test", "Tests", "Create test", "My tests".

### Quiz (interactive, low-stakes)
- Quick MCQ session students take online for instant feedback.
- Auto-graded as a percentage. Used for class formative checks.
- Backed by `quizzes`, `quiz_questions`, `quiz_attempts`.
- UI labels: "Quiz", "Quizzes", "Create quiz", "Take a quiz", "Quiz code".

### Practice (ungraded, self-paced)
- Questions a student generates for themselves; never goes into a teacher's gradebook.
- Includes adaptive practice (`/student/practice`), generate-your-own (`/student/generate`), and saved practice quizzes.
- UI labels: "Practice", "Practice questions", "Generate practice", "Adaptive practice".

### Rules of thumb
- **Never** call a printable paper a "quiz". It's a Test.
- **Never** call an interactive online MCQ session a "test" in copy. It's a Quiz.
- If the student made it themselves and it doesn't go to the teacher's gradebook → it's Practice.
- The student-facing route `/student/tests` is legacy; new student surfaces should use `/student/quizzes` for quizzes or `/student/practice` for practice.

### Examples

| Situation | Correct term |
|---|---|
| Teacher creates a 90-minute board-pattern paper | Test |
| Student writes that paper at home, online | Test (online mock exam mode) |
| Teacher creates a 10-question MCQ for class warm-up | Quiz |
| Student types "Photosynthesis" and AI generates 5 MCQs to drill | Practice |
| Student takes the Coach-recommended adaptive set | Practice |

### DB → UI mapping cheat sheet

| DB / route | UI term |
|---|---|
| `quizzes` table | Quiz |
| `quiz_attempts` table | Quiz attempt (or "attempt") |
| `exam_papers` table | Test |
| `exam_attempts` table (planned) | Test attempt |
| `/teacher/quizzes` | "My quizzes" |
| `/teacher/papers` | "My tests" |
| `/student/quiz/[code]` | "Take quiz" |
| `/student/exam/[code]` | "Take test" |
| `/student/practice` | "Adaptive practice" |
| `/student/generate` | "Practice generator" |
| `/student/tests` (legacy) | "My practice" |

---

## 🗄️ Database migrations

All migrations live in `supabase/migrations/`. Run each in **Supabase SQL Editor**. Additive and idempotent — re-running is safe. **Run in order.**

| File | What it adds |
|---|---|
| `supabase/schema.sql` | Original tables: profiles, question_bank, quizzes, quiz_questions, quiz_attempts, attempt_answers, alerts |
| `01_classes_and_assignments.sql` | classes, class_members, quiz_assignments + RLS |
| `02_student_modes_and_subs.sql` | profiles.username, is_school_student, parent_email; subscriptions table; handle_new_user trigger |
| `03_governance_and_audit.sql` | student_logins, student_password_resets, attempt IP/UA columns |
| `04_multi_teacher_classes.sql` | class_teachers (primary + co-teacher), helpers, RLS rewrite |
| `05_topic_family.sql` | quizzes.topic_family for similar-topic grouping |
| `06_class_naming_and_school.sql` | classes.subject + section, schools table, profiles.school_id, super_teacher role + RLS |
| `07_school_join_code.sql` | schools.join_code |
| `08_exam_papers.sql` | exam_papers + exam_paper_questions (printable, multi-type) |
| `09_teacher_invites.sql` | class_teacher_invites; trigger auto-claims invites by email match on signup |
| `10_subscription_limits.sql` | subscription_limits; check_attempt_quota trigger (3 quizzes/24h on free); attempts_remaining_today RPC |
| `11_school_subscriptions.sql` | subscriptions.school_id; **partial unique indexes** + `subs_owner_xor` CHECK |
| `12_killer_features.sql` | teach_back_sessions, misconceptions, bloom_climber_state, bloom_climber_streaks, past_paper_xrays, past_paper_xray_questions |
| `13_competitive_exam_features.sql` | speed_sessions, distractor_traps, mock_rank_predictions |
| `14_exam_sprint.sql` | exam_sprint_settings (countdown + adaptive mission) |
| `15_visualizer_srs_calibration.sql` | concept_animations, srs_reviews (SM-2), confidence_calibrations |
| `16_parent_links_and_graph.sql` | parent_invites (token-only auth), knowledge_graphs |
| `17_xray_answers_and_quiz_time.sql` | xray_questions.answer + .explanation; quizzes.recommended_minutes |
| `18_question_calibration.sql` | empirical difficulty/discrimination per question (≥20 attempts) |
| `20_daily_drill_attempts.sql` | daily_drill_attempts |
| `21_live_quiz_sessions.sql` | live_sessions, live_session_players, live_session_answers |
| `22_platform_admin_and_invite.sql` | profiles.platform_admin; schools.invited_admin_email/invited_at/onboarded_by; is_platform_admin() helper + RLS |
| `23_platform_admin_provenance.sql` | platform_admin_granted_at + granted_by audit |
| `24_student_exam_goal.sql` | profiles.exam_goal (drives goal-based dashboard) |
| `25_plans_and_audit.sql` | plans (versioned), plan_audit, subscriptions.plan_id |
| `26_seed_initial_plans.sql` | Seed Free / Premium Monthly / Annual / Plus Monthly / Plus Annual; backfill subscriptions.plan_id |
| `27_per_student_pricing.sql` | plans.pricing_model + per_student_price_paise + min/max_students |
| `28_seed_school_plans.sql` | School Pilot / Standard / Plus per-student plans |

> Migration 19 (mock exam mode + photo upload) was reverted mid-2026-04-29 session. Feature removed.

After migrations: `notify pgrst, 'reload schema';` to refresh API cache.

> **`RESET_AND_REBUILD.sql` is stale** — only inlines through migration 11. The live deployed schema is `schema.sql` + `migrations/01..28`. Don't trust it as a rebuild target until regenerated.

### ⚠️ Partial-index ON CONFLICT trap

Migration 11 makes `subscriptions.user_id` and `subscriptions.school_id` partial unique (`where user_id is not null` / `where school_id is not null`). Postgres can't match a partial index from bare `ON CONFLICT (user_id)` → query aborts with:
```
there is no unique or exclusion constraint matching the ON CONFLICT specification
```
which Supabase Auth re-surfaces as the misleading `Database error saving new user`.

**Rule for any writer to `subscriptions`, `misconceptions`, `srs_reviews`, `parent_invites`, or any other table with a partial unique:** use SELECT → UPDATE/INSERT pattern, NOT `.upsert(...)` / `onConflict`. Already followed in `handle_new_user` trigger, `/api/checkout/verify`, `/api/misconception/diagnose`, `/api/srs/enqueue`, `/api/sprint/save`. Follow the same pattern when adding new writers.

---

## 🛡️ RLS audit (open HIGH findings)

BloomIQ's RLS layer is correctly enabled on every table inspected, but several SELECT policies are too permissive. The most serious are in `supabase/schema.sql`: `profiles`, `quizzes`, `quiz_questions`, and `question_bank` all have `for select to authenticated using (true)` policies that were never narrowed by later migrations. **Fix before going to production with multi-school traffic.**

| Table | Risk | Issue |
|---|---|---|
| `profiles` | HIGH | "read all auth" — every authenticated user can read every other user's profile incl. `parent_email`, `parent_name`, `username`, `school_id`. |
| `quizzes` | HIGH | "read by code" — any authenticated user can list every teacher's quizzes (id, name, code, owner_id, subject, topic_family, time_limit_minutes). |
| `quiz_questions` | HIGH | "qq read auth" — any authenticated user can enumerate every quiz→question pairing across schools. |
| `question_bank` | HIGH | "qb read approved" — every authenticated user can read every approved question stem across schools. |
| `schools` | MEDIUM | "read by code" exposes every school + `join_code`. |
| `classes` | MEDIUM | "read by code" exposes every class + `join_code`. |
| `alerts` | MEDIUM | No policy grants the student themselves access to their own alerts. |
| `exam_papers` / `exam_paper_questions` | MEDIUM | Owner-only — school admin / co-primary cannot view a teacher's papers. |

### Fix sketches (turn into a future `rls_hardening.sql`)

```sql
-- profiles
drop policy if exists "profiles read all auth" on public.profiles;
create policy "profiles read same school" on public.profiles
  for select using (
    auth.uid() = id
    or public.is_super_for_user(id)
    or (school_id is not null and school_id in (
          select school_id from public.profiles where id = auth.uid()))
  );

-- quizzes
drop policy if exists "quizzes read by code" on public.quizzes;
create policy "quizzes read for assigned" on public.quizzes
  for select using (
    owner_id = auth.uid()
    or public.is_super_for_user(owner_id)
    or exists (
      select 1 from public.quiz_assignments qa
      left join public.class_members m on m.class_id = qa.class_id
      where qa.quiz_id = quizzes.id
        and (qa.student_id = auth.uid() or m.student_id = auth.uid())
    )
  );

-- quiz_questions (after tightening quizzes, this inherits)
drop policy if exists "qq read auth" on public.quiz_questions;
create policy "qq read by quiz reader" on public.quiz_questions
  for select using (
    exists (select 1 from public.quizzes q where q.id = quiz_id)
  );

-- question_bank
drop policy if exists "qb read approved" on public.question_bank;
create policy "qb read approved via quiz" on public.question_bank
  for select using (
    status = 'approved' and exists (
      select 1 from public.quiz_questions qq
      join public.quizzes q on q.id = qq.quiz_id
      where qq.question_id = question_bank.id
    )
  );

-- alerts (additive)
create policy "alerts student own" on public.alerts
  for select using (auth.uid() = student_id);

-- exam_papers (additive school-admin read)
create policy "papers super read" on public.exam_papers
  for select using (public.is_super_for_user(owner_id));
create policy "epq super read" on public.exam_paper_questions
  for select using (
    exists (select 1 from public.exam_papers p
            where p.id = paper_id and public.is_super_for_user(p.owner_id))
  );
```

### When adding new tables
Scope SELECT policies to `auth.uid() = user_id` or via `is_super_for_user()` / `is_class_teacher()` helpers — **never `using (true)`**.

---

## ✅ Features (what's built)

### Authentication
- Single-input login (email or username, auto-detected)
- Three-role signup with role picker (`/signup` → pick → `/signup?role=X`)
- `?intent=pro&plan=<id>` flow so logged-out visitor on `/pricing` can pay-and-go
- School-student accounts created by teacher (no email)
- Login audit (IP + UA), best-effort, never blocks signin
- `student_logins.user_id` FK → `auth.users(id)` (resilient to profile-creation order)
- Single-session for independent students only
- Password-reset by primary teacher for school students
- `/auth/set-password` — universal screen for invites + password resets
- AuthHealer clears stale tokens automatically (`components/AuthHealer.tsx`)

### Payments & subscriptions
- Public `/pricing` — sticky top bar, hero, plan cards, school block, FAQ
- Cold-visitor pay flow → `/signup?intent=pro&plan=<id>` → Razorpay autostart → success screen
- Logged-in upgrade flow on the same page
- `POST /api/checkout` — server-side Razorpay order creation, plan catalog, INR paise conversion
- `POST /api/checkout/verify` — HMAC-SHA256 signature check + order-notes cross-check + SELECT→UPDATE/INSERT into `subscriptions`
- Free-tier daily cap (3 distinct quizzes / 24h) for independent students via `check_attempt_quota` trigger
- Plan-Admin module (`/admin/plans`) — versioned, two-eyes review, grandfathering
- Per-student school pricing (School Pilot ₹49 / Standard ₹39 / Plus ₹29)
- Path A renewals: expiry enforced + `RenewBanner` (7-day warning, red post-expiry) + `/api/cron/expire-subscriptions`

### Platform Admin
- `/admin/onboard-school` — provision a paying school by inviting Admin Head (calls `supabase.auth.admin.inviteUserByEmail`)
- `/admin/team` — manage `platform_admin` flag (grant by email, auto-invite, prevent self/last-admin revoke)
- `/admin/plans` — list, edit, draft → submit-for-review → approve/reject; auto-archives prior active version

### Teacher
- `/teacher` — quick stats, recent quizzes, school-membership card with join-by-code
- `/teacher/generate` — 4-source question generation (Topic / Topic+Syllabus / Notes / Image), Bloom level picker, questions-per-level, numerical %
- `/teacher/review` — edit / approve / reject, bulk select
- `/teacher/quizzes` + `/new` (Composer) + `/[id]` (assignments)
- `/teacher/classes` — list with role pills, structured naming, duplicate prevention
- `/teacher/classes/[id]` — manage roster, primary-only Add Student with duplicate-detection panel, **Bulk-add students** (paste names → preview with auto-generated usernames + passwords, dup-check, CSV/print/copy)
- Soft-remove students (`class_members` row only); Undo banner + restore endpoint
- `/teacher/analytics` — quiz dropdown, action items, problem questions, score distribution, time analysis, expandable per-student rows
- `/teacher/reports` — period + class filters; **By quiz** (Excel + per-student PDFs), **Term-wide** (6-sheet workbook), **Communications** (weekly digest)
- `/teacher/papers` — Exam Paper Generator (separate from quizzes); template-driven; six question types; danger-zone delete; print-ready
- `/teacher/coach` + `/teacher/digest` — AI chat + auto-summarised weekly digest (`lib/teacherContext.ts`)
- `/teacher/live` + `/teacher/live/[code]/host` — Kahoot-style live class quiz host

### Admin Head (super_teacher / Principal)
- `/school` — setup, school-wide stats, per-teacher activity, classes table, **inline rename** + **Transfer Admin Head card** (atomic via `/api/admin/school/transfer`)
- `/school/teachers` — invite by email OR share school code
- `/school/classes` — Admin Head creates classes here; standardised `Grade {N} · Section {X}`; optional primary teacher by email (auto-claims invite on later signup)
- `/school/students` — top performers, at-risk, full searchable list
- `/school/reports` — **Bloom Pulse**: tabs Overview / At-risk / Compare / Engagement; URL-driven tab state; PDF / Excel / Copy export
- `/school/coach` + `/school/digest` — Principal Coach + Weekly Brief (`lib/schoolContext.ts`)

### School student
- `/student` — assigned-quiz list (urgency-coloured: red overdue, amber due-soon, slate normal); same 14-tile feature catalogue gated by school's plan
- `/student/join` — quiz code; `/student/classes` — join classes, leave class
- `/student/quiz/[code]` — distraction-free quiz interface

### Independent student — base
- `/student` — goal picker (8 options) drives priority tile layout; Bloom heat-map hero (`components/BloomHero.tsx`); 14-tile feature catalogue gated by personal subscription
- `/student/generate` — same 4 sources as teacher PLUS 5th Past-question-paper tile
- `/student/tests` — self-generated tests (label: "My practice")
- `/student/progress` — radar chart of Bloom mastery, focus-area pills, per-topic bars, timeline
- `/student/flashcards` — AI-generated flashcards on weak Bloom levels / topics
- `/student/coach` + `/student/digest` — Performance Coach + Weekly Brief (`lib/studentContext.ts`)

### Independent student — killer features
| Feature | Route | Purpose |
|---|---|---|
| **Teach-Back** | `/student/teach-back` | Feynman-style explain-back; AI grades on Bloom rubric (0–5/level) + Socratic follow-up |
| **Misconception Detective** | `/student/misconceptions` | Diagnoses each wrong answer into specific mental error; logs strikes; one-click "Drill this" generates 3-question micro-quiz |
| **Bloom Climber** *(merged into Memory Tune-Up)* | `/student/climber` (redirect) | 5-min daily streak; 3 questions at one Bloom level on one topic; nail 2/3 to master |
| **Past-Paper X-Ray** | `/student/xray`, `/[id]` | Upload paper text/image; AI tags by Bloom + topic; heatmap + 5 study targets |

### Independent student — competitive-exam features
| Feature | Route | Purpose |
|---|---|---|
| **Speed-Accuracy Trainer** | `/student/speed` | Bloom-level target times; 4-quadrant verdict (Fast+Right / Slow+Right / Fast+Wrong / Slow+Wrong) |
| **Distractor Trap Detector** | `/student/traps` | Classifies wrong picks into 9 examiner-trap types |
| **Mock Rank Predictor** | `/student/rank` | Score → percentile → AIR estimate (JEE/NEET/CAT/Custom); independent-only |
| **Doubt-Clearing AI Tutor** | `/student/tutor` | Stateless Socratic chat; optional `?question_id=` deep-link |
| **Exam Sprint Mode** | `/student/sprint` | Countdown + adaptive 3-task daily mission by phase (Foundation / Practice / Sprint / Final week) |

### Independent student — retention features
| Feature | Route | Purpose |
|---|---|---|
| **Concept Visualizer** | `/student/visualizer` | Animated SVG-frame slideshow with embedded SMIL motion |
| **Memory Tune-Up** | `/student/memory` | SM-2 spaced repetition keyed on `question_id`; 4-button rating; absorbs Bloom Climber streak |
| **Confidence Calibration** | `/student/calibration` | Stated-vs-actual chart per band; negative-marking strategy |

### Independent student — commercial-unlock
| Feature | Route | Purpose |
|---|---|---|
| **Parent Dashboard** | `/parent/[token]` (read-only); `/student/parent` (manager) | Token-based magic-link, no parent auth; revoke any link |
| **Voice AI Teacher** | `/student/voice-teacher` | Web Speech API voice in/out; reuses `/api/tutor/chat`; lazy-loads Concept Visualizer |
| **Concept Knowledge Graph** | `/student/graph` | Hand-rolled SVG layout (no graph library); mastery rings + AI-inferred prerequisite arrows; 24h cache |

### Cross-cutting
- Topic-family classifier (`lib/classifier.ts`) — LLM-grounded with user's existing families
- Numerical-questions % slider (auto-ignored for non-numerical topics)
- Anti-abuse: login audit, IP/UA tracking, "3+ IPs in 7d" suspicious flag
- Class naming standards: `Grade {N} · Section {X}` with Other-specify; subject lives on `class_teachers` (per-teacher, not per-class)
- Past-paper handling: mixed format input collapses to MCQ output preserving topic + difficulty
- PWA manifest + service worker (installable on mobile; dev unregisters to avoid stale chunks)
- Self-verifying answer keys (every generated MCQ re-solved in second Groq call)
- Misconception-aware distractors (mines past `attempt_answers` to seed wrong options)
- Empirical difficulty + discrimination (light IRT) once ≥20 attempts; Easy/Medium/Hard + Good/Weak/Broken badges; "Calibrate now" button
- Adaptive personalised practice (`/student/practice`) — picks weakest Bloom level from last 30d, generates 5 questions
- Daily smart drill (`/student/drill`) — 5 questions: 2-3 yesterday's misses + 2-3 weakest Bloom levels (last 14d)
- Question variants generator (wand icon on every library question; AI generates 3 isomorphic variants, verified)
- Worked solutions on demand (`/api/qbank/[id]/solution`, in-memory cache)
- Live class quiz mode (Kahoot-style; 6-char code; 2s polling; time-decayed scoring)
- Terms of Service + Privacy Policy at `/terms` + `/privacy`; click-wrap at signup; ToS version stamped to `user_metadata.tos_accepted_at`

---

## 🐛 Known issues

| Issue | Workaround | Permanent fix |
|---|---|---|
| Login fails after DB wipe — stale localStorage | Run `localStorage.clear(); location.reload();` in DevTools console | AuthHealer component (already added — verify it's in `app/layout.tsx`) |
| `Refresh Token Not Found` | Same as above | Same |
| `Could not find 'X' column in schema cache` | Run the relevant migration in Supabase SQL Editor + `notify pgrst, 'reload schema';` | One-time setup |
| `there is no unique or exclusion constraint matching the ON CONFLICT specification` | Use SELECT → UPDATE/INSERT or add `where user_id is not null` predicate | Trigger + verify endpoint already follow rule |
| `International cards are not supported` (Razorpay) | UPI ID `success@razorpay`, or domestic test card | Toggle "International payments" in Razorpay dashboard |
| Email-confirmation block on signup | Disable in Supabase: Auth → Providers → Email → uncheck "Confirm email" | Switch to real transactional email provider |
| Next.js dev "Rendering" / "Building" pill | `devIndicators: false` (already set; restart dev server) | Already fixed |
| Click-then-blank-then-loads in dev | Switched to **webpack** (`next dev --webpack`); React Compiler **off**; service worker proactively unregistered in dev | Already fixed |
| Sidebar.tsx 4 JSX errors in `tsc --noEmit` | None needed; SWC compiles fine | Future cleanup |

---

## ⚠️ Sidebar policy

`components/Sidebar.tsx` has historically caused login-side breakage. **Do not modify it for feature work** — features should reach pages via dashboard tiles (`StudentFeatureTile`). Edit `Sidebar.tsx` only when explicitly asked.

## ⚠️ Edit-tool truncation

The Edit tool has truncated files mid-write at ~38–40 KB on this codebase before. For files > 30 KB, prefer full-file `Write` (or bash heredoc) over a chain of `Edit` calls.

## ⚠️ Dev environment notes

- React Compiler is **off** (`reactCompiler: false` in `next.config.ts`) — flipping it on has caused chunk-load errors in dev.
- Service worker (`public/sw.js`) registers in production; `components/PWARegister.tsx` proactively unregisters in dev.
- Reset dev cleanly:
  ```powershell
  Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
  Remove-Item -Recurse -Force .next -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force node_modules\.cache -ErrorAction SilentlyContinue
  npm run dev
  ```

---

## 🧪 Test scripts

`scripts/` directory:

```bash
node scripts/create-test-account.js student   email   password   "Name"   [--reset]
node scripts/create-test-account.js teacher   email   password   "Name"   [--reset]
node scripts/create-super-teacher.js          email   password   "Name"   [--reset]
```

`--reset` deletes the existing user with that email before recreating. Accounts created this way bypass email confirmation (`email_confirm: true`).

### E2E fixtures

`npm run test:e2e:seed:full` creates `test_*`-prefixed accounts:

| Role | Identifier | Lands on |
|---|---|---|
| Admin Head — School A | `test_super_a@bloomiq-e2e.local` | `/school` |
| Admin Head — School B | `test_super_b@bloomiq-e2e.local` | `/school` |
| Primary Teacher (class A1) | `test_teacher_a@bloomiq-e2e.local` | `/teacher` |
| Co-Teacher (co A1, primary A2) | `test_teacher_a2@bloomiq-e2e.local` | `/teacher` |
| Teacher in school B | `test_teacher_b@bloomiq-e2e.local` | `/teacher` |
| School student A1 | `test_student_a1` (username) | `/student` |
| School student A2 | `test_student_a2` | `/student` |
| School student B1 | `test_student_b1` | `/student` |
| Independent student | `test_indep_student@bloomiq-e2e.local` | `/student` |

Password for all: `TestPass123!`. Full reference in `tests/e2e/CREDENTIALS.md`. `npm run test:e2e:cleanup` removes everything `test_*`.

---

## 🗑️ Wipe and start fresh

Supabase SQL Editor:

```sql
delete from auth.users;       -- cascades to almost everything
delete from public.schools;   -- super_teacher_id is SET NULL, not auto-deleted

-- Defensive sweep
delete from public.exam_paper_questions;
delete from public.exam_papers;
delete from public.quiz_assignments;
delete from public.attempt_answers;
delete from public.quiz_attempts;
delete from public.quiz_questions;
delete from public.quizzes;
delete from public.question_bank;
delete from public.alerts;
delete from public.class_members;
delete from public.class_teachers;
delete from public.classes;
delete from public.subscriptions;
delete from public.student_logins;
delete from public.student_password_resets;
delete from public.profiles;

notify pgrst, 'reload schema';
```

Then clear browser localStorage and recreate accounts via `scripts/create-test-account.js`.

---

## 📁 File map

```
app/
  page.tsx                  landing
  login/, signup/           auth (signup is two-state: role picker → form)
  auth/set-password/        universal set-password screen (invite + reset)
  pricing/                  public; Razorpay autostart on ?autostart=
  terms/, privacy/          public legal pages
  admin/                    BloomIQ staff (platform_admin only)
    onboard-school/         provision paying school
    team/                   manage platform_admin team
    plans/, plans/new, plans/[id]/edit/    plan catalogue admin
  parent/[studentId]/       public token-authed parent view
  teacher/
    page.tsx                home — stats, recent quizzes, school join card
    generate/, review/      paste/topic/syllabus/notes/image → questions
    quizzes/                list + new (Composer) + [id] (assignments)
    classes/                list + [id] (members + co-teachers)
    analytics/              action-items + problem questions
    reports/                Excel/PDF/digest
    papers/                 exam paper generator (template-driven, printable)
    coach/, digest/         AI chat + weekly brief
    live/, live/[code]/host live class quiz
  school/                   super_teacher (Admin Head) area
    page.tsx                home + setup
    teachers/, classes/, students/   management surfaces
    reports/                Bloom Pulse (4 tabs)
    coach/, digest/         Principal Coach + Brief
  student/
    page.tsx                branches by is_school_student; goal picker; tile catalogue
    classes/                school-student area
    join/                   enter quiz/class code
    generate/, tests/, progress/, flashcards/
    practice/, drill/                ★ adaptive + daily smart drill
    teach-back/, misconceptions/, climber/, xray/, xray/[id]/    ★ killer features
    speed/, traps/, rank/, tutor/, sprint/                       ★ competitive-exam
    visualizer/, memory/, calibration/                           ★ retention
    parent/, voice-teacher/, graph/                              ★ commercial-unlock
    coach/, digest/                  performance coach + brief
    quiz/[code]/                     test interface (also handles drill quizzes)
    live/[code]/                     live quiz player
    results/[id]/                    results; "Diagnose my mistakes" panel
  api/
    admin/                  platform admin RPCs (onboard-school, team, plans, schools, classes, students, school)
    teacher/                teacher RPCs (classes, coach, digest)
    student/                student RPCs (adaptive-practice, daily-drill, srs-due, coach, digest, quick-test)
    school/                 super_teacher RPCs (join, coach, digest)
    generate/, papers/generate/      AI question generation
    flashcards/, calibration/log/, recommendations/, commentary/, alerts/
    teach-back/, misconception/, climber/, xray/                 ★ killer endpoints
    speed/, traps/, rank/, tutor/, sprint/                       ★ competitive-exam
    visualizer/, srs/, graph/, parent/                           ★ retention + parent
    qbank/[id]/{solution,variants,variants/save}, qbank/calibrate
    quizzes/[id]/classify/  topic-family classifier endpoint
    live/{start, [code]/{state,join,start-running,next,answer,leaderboard}}
    checkout/, checkout/verify/      Razorpay flow
    pricing/active-plans/   public DB-driven plan list
    cron/expire-subscriptions/       guarded by CRON_SECRET
    login-audit/, report/[attemptId]/, digest/

components/
  Sidebar.tsx               role-aware nav incl. Platform Admin section
  PublicNav.tsx             auth-aware top nav for / and /pricing
  AuthHealer.tsx            clears stale tokens on app boot
  PWARegister.tsx           SW registration (prod) / unregister (dev)
  BloomBadge.tsx, BloomChart.tsx, BloomHero.tsx
  StudentFeatureTile.tsx, StudentGoalPicker.tsx, PaywallModal.tsx, RenewBanner.tsx
  BulkAddStudents.tsx
  AtRiskWatchlist.tsx, ClassComparisonHeatmap.tsx, EngagementTrends.tsx
  Empty.tsx

lib/
  supabase/{client,server}.ts       Supabase clients (incl. service-role admin)
  groq.ts                           Groq SDK + JSON + vision wrappers
  qgen.ts                           misconception-aware distractors + verify
  calibration.ts, calibrationView.ts   light-IRT (≥20 attempts)
  bloom.ts, bloomReports.ts, bloomScore.ts
  classifier.ts                     topic-family classifier
  features.ts, featureAccess.ts     gating registry + hook + server check
  studentGoalTiles.ts               goal-driven tile prioritisation
  schoolContext.ts, teacherContext.ts, studentContext.ts   coach/brief snapshots
  exam/{scoring,code}.ts            exam scoring + join-code helpers
  types.ts, utils.ts

supabase/
  schema.sql                        original schema (run first)
  migrations/01-28                  additive migrations (run in order; no 19)
  RESET_AND_REBUILD.sql             stale (only ≤11) — regenerate before trusting

scripts/
  create-test-account.js
  create-super-teacher.js

tests/e2e/                          Playwright tests (auth helpers + per-role specs)
```

---

## 🔮 Backlog

### Critical pre-deployment
1. **Fix the 4 HIGH-severity RLS findings** (see RLS audit section). Currently any authenticated user can read every profile, every quiz, every quiz_question, and every approved question-bank item across the platform.
2. Apply migrations 18, 20, 21, 22, 23, 24, 25, 26, 27, 28 to Supabase if not already.
3. Wire `/api/cron/expire-subscriptions` to Supabase pg_cron / Vercel Cron / GitHub Actions.

### Open follow-ups
- Server-side `requireFeature(userId, key)` enforcement on feature route handlers — closes curl-bypass on dashboard's paywall
- Per-subscription `extra_features` (give Alice a feature without raising her price)
- Email reminders before/at/after expiry (plug into cron once SMTP wired — Resend recommended)
- True auto-renewal via Razorpay Subscriptions API (Path B; Path A is buy-each-cycle)
- Audit-log UI on `/admin/plans/[id]` (data already captured)
- "Add only, never remove" enforcement on plan version transitions
- Subscription cancel / manage UI for the student
- School-plan purchase UI (today: "Talk to us" only on `/pricing`)
- Razorpay webhook at `/api/checkout/webhook` for resilience (same SELECT → UPDATE/INSERT rule, never `onConflict`)
- Branded receipt email via nodemailer in verify endpoint
- Live class quiz: Supabase realtime channels instead of 2s polling
- Worked-solution cache → DB persistence (currently in-memory per Node process)
- Variants generator: feed misconception seeds (today it doesn't)
- Empirical-difficulty: re-calibrate on schedule rather than only on-demand
- Voice mode for Teach-Back (record audio → Whisper-style transcribe → same grading endpoint)
- Auto-diagnose on quiz submit (background `/api/misconception/diagnose` after submit)
- Climber: weekly leaderboard for siblings/study buddies (cohort-scoped)
- X-Ray: multi-page PDF upload (current image path is one-image-at-a-time)
- Per-attempt IP capture on quiz submissions (schema ready: `quiz_attempts.ip` + `.user_agent`)
- Parent reports for independent students (`profiles.parent_email` ready)
- Cron-scheduled weekly digest (Vercel Cron)
- PDF export for exam papers (currently browser print only)
- Inline question edit from question bank (today: edit in Review only)
- Razorpay live-mode cutover (env-var swap; code is mode-agnostic)
- Re-invite button on `/admin/onboard-school` for stuck pending invites
- ToS acceptance backfill prompt for users created before 2026-04-30
- Regenerate `RESET_AND_REBUILD.sql` from current schema + migrations 1-28
- Clean up 7 legacy `.js` page stubs (`app/student/{myresults,practice,test}/page.js`, `app/teacher/{dashboard,myquizzes,quiz,upload}/page.js`)
- Extract a shared `lib/api.ts` helper (`req.json().catch()` + auth + error responses) across ~50 routes
- Tests for AI-heavy routes (currently page-render smoke only)
- Fix 4 JSX errors in `Sidebar.tsx` so `tsc --noEmit -p tsconfig.check.json` is green

---

## 🚨 Recovery — start here if dev is broken

### 1. Reset dev environment
```powershell
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item -Recurse -Force .next -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force node_modules\.cache -ErrorAction SilentlyContinue
npm run dev
```

### 2. Clear browser auth tokens
Open `http://localhost:3000` in incognito. Or normal window: F12 → Console → `localStorage.clear(); sessionStorage.clear(); location.reload();`. AuthHealer should also do this on app boot when it detects a stale refresh token.

### 3. Recreate test accounts (bypasses email confirmation)
```powershell
node scripts/create-test-account.js teacher    test.teacher@example.com    TestPass123! "Test Teacher"    --reset
node scripts/create-test-account.js student    test.student@example.com    TestPass123! "Test Student"    --reset
node scripts/create-super-teacher.js           test.principal@example.com  TestPass123! "Test Principal"  --reset
```

### 4. Diagnostic order if still broken
1. **Browser DevTools → Console** — look for red errors:
   - `Refresh Token Not Found` → run the localStorage snippet from step 2
   - `Could not find the 'X' column of 'Y' in the schema cache` → migration X not applied; run it + `notify pgrst, 'reload schema';`
2. **Dev-server terminal** — compile errors live here.
3. **Supabase → Authentication → Providers → Email** — make sure `Confirm email` is **OFF**.

---

## 🤝 Contributing

Private project. Follow the Sidebar policy + Edit-tool truncation rule + partial-index ON CONFLICT trap above when extending.

Naming convention is **mandatory** for user-facing copy (Test/Quiz/Practice section). Database column names stay; only UI labels follow the rule.

When adding a new gateable feature:
1. Add a key + metadata to `lib/features.ts`.
2. Use `useFeatureAccess()` (client) or `requireFeature()` (server) to gate.
3. Wire `StudentFeatureTile` so locked tiles render dimmed and open `PaywallModal`.

When adding a new table with per-user data:
1. Always `enable row level security`.
2. Scope SELECT to `auth.uid() = user_id` (or `is_super_for_user()` / `is_class_teacher()` helpers). Never `using (true)`.
3. If you need a partial unique index, write it as `where user_id is not null` and never use `.upsert(...)` / `onConflict` against it — use SELECT → UPDATE/INSERT.
