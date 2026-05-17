# ZCORIQ Platform — Features & Functional Documentation

**Version:** 2026-05-17
**Status:** Living document. Reflects the implementation as of this date. Anything not yet built is called out explicitly.
**Audience:** Founders, product, engineering, QA, schools, investors, implementation partners, future onboarding teams.

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [User Roles](#2-user-roles)
3. [Module-by-Module Feature Documentation](#3-module-by-module-feature-documentation)
   - 3.1 [Teacher Modules](#31-teacher-modules)
   - 3.2 [Student Modules](#32-student-modules)
   - 3.3 [School-Admin (Super-Teacher) Modules](#33-school-admin-super-teacher-modules)
   - 3.4 [Platform-Admin Modules](#34-platform-admin-modules)
   - 3.5 [Parent Module](#35-parent-module)
4. [Workflow Documentation](#4-workflow-documentation)
5. [AI Feature Documentation](#5-ai-feature-documentation)
6. [Functional Rules & Validations](#6-functional-rules--validations)
7. [Cross-Module Relationships](#7-cross-module-relationships)
8. [UX & Workflow Design Rationale](#8-ux--workflow-design-rationale)
9. [Error Handling & Fallbacks](#9-error-handling--fallbacks)
10. [Reports & Analytics](#10-reports--analytics)
11. [Technical Architecture Summary](#11-technical-architecture-summary)
12. [Production Readiness](#12-production-readiness)
13. [Feature Index](#13-feature-index)
14. [Recommended Documentation Gaps](#14-recommended-documentation-gaps)

---

## 1. Product Overview

### What ZCORIQ is

ZCORIQ is an AI-powered assessment platform for educators and learners. Teachers describe what they want to test in natural language and get rigorous, Bloom's-Taxonomy-aligned multiple-choice questions in seconds. Students learn from those tests, get a personalized readiness score, and see a predicted exam-day outcome they can train toward.

The product replaces three painful workflows at once:
1. Hand-writing tests for class evaluations or exam practice.
2. Stitching together past papers and worksheets from generic sources.
3. Guessing where each student is weakest, instead of knowing.

### Core platform vision

A single platform that:
- Generates **subject-aware, exam-style, taxonomy-mapped** questions for any topic in K-12 / competitive exam / corporate-training contexts.
- Surfaces **per-student weak Bloom levels** so teachers and learners know exactly what to practice.
- Predicts **exam-day rank** for competitive aspirants (JEE / NEET / CAT / others) using each student's calibrated readiness score.
- Lets schools run **paid B2B operations** (NEFT/cheque/Razorpay) with full invoice trails.
- Lets individual learners run a **time-boxed Free trial → paid Premium / Premium Plus** subscription cleanly.

### Primary use cases

| Use case | Who it serves |
|---|---|
| Quick formative quiz after a lesson | School teacher (5-min post-class pulse) |
| Chapter-end / unit-end test | Class teacher |
| Mock paper aligned to JEE / NEET / CAT / GMAT / etc. | Exam-prep teacher or independent learner |
| Personal daily practice | Independent learner |
| Diagnostic on weakest Bloom level | All students |
| Onboarding skill check | Corporate trainer (planned use case) |
| Live polling / live test | Teacher running a synchronous quiz |

### User types and personas

- **Independent learner** — typically Indian K-12 or competitive-exam aspirant. Pays per individual subscription. Has access to BloomIQ Score, Future-You rank prediction, and full practice library.
- **School student** — assigned to a class by their school's Admin Head. Plays the same product but sees their school's tests + teacher-assigned drills.
- **Teacher** — generates questions, builds tests, assigns them to classes, reviews student performance.
- **Super-teacher (School Admin Head)** — the school's principal/operator. Sees billing, runs school-wide reports, manages teachers and students, owns the school's classes.
- **Platform admin (ZCORIQ staff)** — internal operations. Onboards paying schools, manages plans, runs the plan-proposal two-eyes approval queue, manages users + team, manages feature flags.
- **Parent** — limited read-only access to a single child's results via an invite link.

### Key differentiators

1. **True Bloom's Taxonomy mapping** — every generated question is tagged Remember / Understand / Apply / Analyze / Evaluate / Create. A separate Bloom Verifier model re-classifies AI output and disputes mismatches.
2. **Cross-field validation** across the test-creation form: class × teaching-context × Bloom × numerical-% × intent are continuously checked so teachers can't accidentally ship a JEE-difficulty test for a Class-5-8 cohort.
3. **Real exam framing** — explicit exam metadata for CAT / JEE / NEET / GMAT / GRE / UPSC / IELTS / TOEFL / CLAT / BITSAT / SAT / GATE / NDA / CUET, with sample-question few-shots in the prompt so output matches paper style.
4. **3-digit BloomIQ Score (300-900)** + "Future You" rank prediction for competitive aspirants — a single number a student can train against.
5. **B2C and B2B in one product** — Razorpay-driven Premium plans for individuals, NEFT/cheque/manual invoicing for schools, both flowing through the same plans catalogue.
6. **Soft-warn, never-block UX** for cross-field issues — teachers can override after acknowledgement, with the override audit-logged.

---

## 2. User Roles

### 2.1 Independent learner (student, no school link)

**Sign in via:** `/login/student` (email + password) or `/signup` followed by an immediate Razorpay checkout via `/api/signup-and-pay`.

**Permissions:**
- Generate practice questions for any topic.
- Take quizzes from a code (shared by a teacher) or from personal generation.
- Take the ZCORIQ calibration once to unlock the BloomIQ Score.
- See their own Future-You prediction.
- Pay for Premium / Premium Plus via Razorpay.

**Restrictions:**
- Free-trial gate: when `subscription_limits.free_trial_days > 0` (set by platform admin), every new independent student gets a time-boxed Free plan. After expiry, hard-gated to `/student/expired` until they upgrade.
- Daily attempt cap on Free tier enforced by a Postgres trigger (`check_attempt_quota` from migration 10).

**Capabilities:**
- All `/student/*` features (see Module section).
- Cannot access teacher / school / admin surfaces.

### 2.2 School student

**Sign in via:** `/login/school` (school tab), enters a username (synthesized to `<username>@<schoolDomain>`). The Admin Head bulk-creates these accounts.

**Permissions:**
- Take tests assigned to their class.
- Take personal practice / drills (subject to plan rules).
- See their own results, BloomIQ Score, and parent-share QR code.

**Restrictions:**
- `is_school_student=true` AND `school_id` is non-null. They cannot pay individually — billing is at the school level.

### 2.3 Teacher

**Sign in via:** `/login/school` (teacher tab) with a work email. Onboarded by the Admin Head via class invites.

**Permissions:**
- Generate questions (the `/teacher/generate` form).
- Compose tests from the question bank (`/teacher/quizzes/new` — Build & Assign).
- Review pending AI-generated questions (`/teacher/review`).
- Generate full exam papers (`/teacher/papers`).
- View per-class and per-student analytics (`/teacher/analytics`, `/teacher/reports`).
- Run live tests (`/teacher/live`).
- Manage class question banks (`/teacher/bank`).

**Restrictions:**
- Scoped to classes they are a member of (`class_teachers` table; roles: primary / co / acting).
- Cannot see other schools' data.
- Cannot mutate the plans catalogue or school billing.

### 2.4 Super-teacher (School Admin Head)

**Sign in via:** `/login/school` (admin tab) with the email they were invited to via `/api/admin/onboard-school`.

**Permissions:**
- Manage classes, teachers, and students for their own school.
- See their school's billing details (read-only).
- Run school-wide reports.
- Bulk-create students.

**Restrictions:**
- Cannot edit the school's plan (a platform-admin operation).
- Cannot trigger a "Mark Paid" / "Start renewal" action.
- One super-teacher per school by default (transfer is a platform-admin tool).

### 2.5 Platform admin (ZCORIQ staff)

**Sign in via:** `/staff` (separate from public login).

**Permissions:**
- All admin features (`/admin/*`): onboard schools, manage plans, approve plan proposals, manage users + team, manage feature flags, run the dashboard.
- Service-role access to all data through the API.

**Restrictions:**
- `profiles.platform_admin = true` flag required.
- Bootstrap: first admin must be flipped via SQL once; subsequent admins onboarded via `/admin/team`.
- Plan changes go through the two-eyes proposal queue. Self-approval only allowed in bootstrap mode (1 admin total).

### 2.6 Parent

**Access:** time-limited magic link from `/api/parent/invite`. No password, no general account.

**Permissions:**
- View one specific child's recent results + BloomIQ Score trend at `/parent/[studentId]`.

**Restrictions:**
- Strictly read-only.
- Single-student scope. A parent of two children gets two invites.

### Role-permission matrix (quick reference)

| Capability | Student | School student | Teacher | Super-teacher | Platform admin | Parent |
|---|---|---|---|---|---|---|
| Generate questions | ✓ | ✓ | ✓ | ✓ (as teacher) | ✓ | — |
| Compose a test | — | — | ✓ | ✓ | ✓ | — |
| Review AI-generated questions | — | — | ✓ | ✓ | ✓ | — |
| Take a test | ✓ | ✓ | — | — | — | — |
| See BloomIQ Score | ✓ | ✓ | — | — | — | view-only |
| See class roster | — | — | ✓ | ✓ | ✓ | — |
| See billing details | own | — | — | school | all | — |
| Manage classes | — | — | partial | ✓ | ✓ | — |
| Onboard a school | — | — | — | — | ✓ | — |
| Approve a plan proposal | — | — | — | — | ✓ | — |
| Manage feature flags | — | — | — | — | ✓ | — |

---

## 3. Module-by-Module Feature Documentation

### 3.1 Teacher Modules

#### 3.1.1 Generate Questions (`/teacher/generate`)

**Purpose:** Single-button creation of high-quality MCQs for any topic, source, and Bloom mix.

**Business value:** Saves teachers ~30-60 minutes per test. Removes the cognitive load of writing rigorous distractors.

**User journey:**
1. Land on `/teacher/generate`. See a 5-step workflow header (Class › Context › Test type › Source & mix › Generate).
2. Pick a class (Step 1 — optional, focuses what we generate).
3. Pick the teaching context (Step 2 — drives the AI's register; e.g. "JEE Main", "Class 9-10 boards", "Corporate skill check").
4. Optionally pick an intent chip (Step 3 — "Quick formative check" / "Chapter-end test" / "Diagnostic" / "Full mock paper" / "Homework" / "Re-teach"). The chip pre-fills mode + Bloom mix + per-level count.
5. Pick a source (Step 4): notes / image / topic+class+syllabus / topic only. Source-specific inputs appear inline.
6. Choose Bloom levels (All 6 / Custom up to 5). Set default-per-level count. Optionally customize per-Bloom counts.
7. Inside the collapsible Advanced section: pick audience level, sub-topic chips, free-text "More instructions", numerical % slider.
8. Cross-field validation banner fires before Generate is clicked if any combination is suspect (e.g. JEE difficulty + Class 5-8).
9. Click Generate. Server runs the per-Bloom-level prompt pipeline. Questions land in the Review Pending queue.
10. Shortfall toast surfaces if delivered < requested (with per-level breakdown).

**Validations (cross-field):**
- Class grade × teaching context (e.g. "JEE Main" against "Class 5-8" is a soft-block — teacher must check "I really mean this" override).
- Bloom levels × exam-supported levels (e.g. CAT doesn't test "Remember" — auto-disable that chip with explanation).
- Numerical % × Bloom mix (numerical % slider disabled when no Apply/Analyze/Evaluate level picked).
- Per-level overrides total honored everywhere (top "Total" counter, pre-flight "Will generate", post-API shortfall).

**AI involvement:**
- Primary call to Groq (`llama-3.3-70b-versatile`) with the source-specific prompt builder (`notesPrompt` / `imagePrompt` / `syllabusPrompt` / `topicOnlyPrompt` / `examStylePrompt`).
- Bloom-verifier second pass that re-classifies each generated question and flags mismatches (disputed flag).
- Topic-grounding module (`lib/topicGrounding`) provides sub-area / real-world-anchor / common-misconception primers in the system prompt.
- Distractor seeds: mined from past student-misconception data to make wrong options more pedagogically meaningful.
- Topic disambiguation: SYSTEM prompt now defaults short acronyms (LCM, HCF, ROI, PI, AC, DC) to their primary/secondary-education meaning, not the exam-jargon meaning.

**Edge cases handled:**
- Page reload mid-session: the form state is in-memory only; reloading clears it. Generation is not resumable.
- AI shortfall (delivered < requested): persistent toast with per-Bloom-level counts + likely causes.
- Image upload >6 MB: pre-rejected with a friendly error.
- Image downscaled client-side to 1600 px max edge / 85% JPEG quality before vision call.
- 429 from Groq (daily token cap): `lib/aiClient` falls back to Gemini (post-Round 19 migration).

**Limitations / planned work:**
- No "save composition as template" for the Generate form (templates exist on Build & Assign).
- No "save draft" for the form fields; only the resulting questions persist.

#### 3.1.2 Build & Assign a Test (`/teacher/quizzes/new`)

**Purpose:** Compose a test by picking from already-approved questions in the teacher's bank, then configure marking, time, and assignment.

**Business value:** Teachers can reuse previously-vetted questions across multiple tests instead of re-generating.

**User journey:**
1. Land on `/teacher/quizzes/new`. Hero with workflow dots (Filter your bank › Select questions › Configure › Save & share).
2. Filter the bank by Bloom / topic / category / search. Active filters surface as pills with one-click clears.
3. Optionally turn on **Quick mode** — dims the right configure-rail until at least one question is selected, focusing attention on the bank.
4. Optionally click **Suggest a test** — modal opens; pick class / topic / depth (Broad/Mid/Deep) / count. Server picks a balanced Bloom mix from the bank with topic spread.
5. Optionally click **Templates** — apply a saved filter template, or save the current filter set as a new template (localStorage).
6. Click `+` next to any question to add it to the selection. Drag the `⋮⋮` handle on a selected question to reorder.
7. Click **Show selected only** to flip the bank view to your current picks.
8. Configure the test (right rail): name, subject, time limit, marking scheme. Cross-field warnings fire inline.
9. Click **Preview as student** to see the test in student-view (no answer keys).
10. Click **Save** — quiz row created, quiz_questions inserted in order, optionally assigned to a class.

**Validations (cross-field):**
- Quiz name family vs subject family (e.g. "Math Chapter 5" + subject="Science" → warning).
- Time limit × question count (< 45 s/q warns "students will rush"; > 300 s/q informs "generous").
- Marking-scheme negative-marks + ≥ 60% deep-Bloom selection → over-penalty warning.
- bloomFilter × teaching-context (e.g. "remember" filter under CAT — bank will be empty; warning).
- Mixed-topics confirm with per-topic counts when saving.

**AI involvement:** None inside the composer itself. The Suggest-a-test backend is a server-side diversity-aware sampler over the bank, **not an LLM call** (cost-zero, millisecond-fast).

**Edge cases handled:**
- Autosave: composer state persisted to localStorage every 600 ms.
- 24h draft restore: if the teacher reopens within 24h, a restore banner offers to reload the draft.
- Quiz-code uniqueness: 8-attempt retry on collision, then a clear error.
- Stale-edit detection: not relevant here (this is the creator's surface, not a multi-admin review).

**Limitations / planned work:**
- Templates are localStorage-only — don't follow the teacher across devices.
- Live preview shows the test linearly; no "shuffle preview" or "show as randomized order" toggle.

#### 3.1.3 Review (`/teacher/review`)

**Purpose:** Approve, edit, or reject AI-generated questions before they enter the active bank.

**Business value:** Quality gate — nothing the AI produces hits a student until a human signs off.

**User journey:**
1. Land on `/teacher/review`. See the queue of `question_bank` rows with `status='pending'`.
2. Each row shows Bloom-verifier badges: ✓ Verified or ⚠ Disputed (with the verifier's inferred Bloom vs the requested one).
3. Approve, edit (open inline editor), or reject.

**AI involvement:** Bloom Verifier (`lib/bloomVerifier.ts`) reads each generated question and emits a verdict + actual-Bloom + dispute flag.

**Edge cases handled:** Disputed questions get a colored badge but are not auto-rejected — teacher decides.

#### 3.1.4 Exam Papers (`/teacher/papers`)

**Purpose:** Generate a full multi-section exam paper (heavier than a single quiz).

**Business value:** For board / school exam prep — produces a paper with sections, marking conventions, and structured answer keys.

**Tighter limits than `/api/generate`:** 3-per-burst / 6-per-hour rate limit; 15/day cap.

**Plan gating:** Requires an active plan with unlimited-practice-tests feature.

#### 3.1.5 Live Tests (`/teacher/live`)

**Purpose:** Run a synchronous, code-joined quiz with a leaderboard.

**Flow:** Teacher creates a live session via `/api/live/start`, shares the code, students join via `/api/live/[code]/join`, teacher advances questions via `/next`, leaderboard updates via `/leaderboard`.

#### 3.1.6 Analytics & Reports (`/teacher/analytics`, `/teacher/reports`)

**Purpose:** See per-class performance, per-Bloom mastery, per-topic gaps, and individual student trends.

**Charts:** Recharts-based — Bloom mix, attempt trends, score distributions.

**Note:** Charts are scoped to the teacher's classes only.

#### 3.1.7 Question Bank (`/teacher/bank`)

**Purpose:** Browse, filter, and lightly curate the teacher's existing approved questions outside the Build & Assign flow.

#### 3.1.8 Assign Flashcards / Practice (`/teacher/assign`, related API)

**Purpose:** Push flashcard sets and practice drills to specific class students.

**API:** `/api/teacher/assign-flashcards`, `/api/teacher/assign-practice`.

---

### 3.2 Student Modules

#### 3.2.1 Home / Dashboard (`/student`)

**Purpose:** Single entry point. Shows recent assignments, BloomIQ Score badge (top-right via `ZcoriqBloomScoreBadge`), and feature shortcuts.

**Calibration nudge:** First-time uncalibrated students see a "Discover your ZCORIQ Bloom Score" hero card. The nudge is opt-in (not a wall).

#### 3.2.2 Take a Test (`/student/quiz/[id]`)

**Purpose:** The actual test-taking interface. Hides the sidebar for distraction-free focus.

**Edge cases:**
- Mid-quiz tab-close = silent progress loss (documented as known limitation F114; resolution planned).
- Server-side `is_free_expired` gate on attempt-start (Finding #73 fix in Round 16) prevents starting an attempt when the trial is expired.

#### 3.2.3 BloomIQ Score (`/student/bloom-score`)

**Purpose:** Take the one-time calibration quiz to get a 3-digit (300-900) BloomIQ Score.

**Flow:**
1. Pick an exam goal (NEET / JEE / CAT / UPSC / Class 5-8 / Class 9 / Class 10 / Class 12 boards / Bank).
2. 12-question calibration generated by Groq, tailored to the picked goal.
3. Submit. Server computes score (`lib/zcoriqBloomScore.computeScore`) and stores in `bloomiq_scores` table.

**AI involvement:** Calibration generator (`lib/calibrationGenerator.ts`) tunes question difficulty per Bloom band.

#### 3.2.4 Future You (`/student/future`)

**Purpose:** Show the predicted exam-day rank + named target colleges based on the current BloomIQ Score.

**Layout:**
- Animated count-up reveal of the score.
- Predicted rank label (e.g. "Top 8% nationally").
- 3 named target colleges (mapped from score band + exam goal).
- "Best You" delta card — how much the score would lift if weakest Bloom levels are fixed.
- Per-Bloom mastery row with deep-linked drill buttons (to `/student/practice?bloom=...&topic=...`).
- Tier-aware bottom: personalised Premium pitch for free users; weekly active-path tracker for paid users.

#### 3.2.5 Adaptive Practice (`/student/practice`)

**Purpose:** Bot-picked 5-question practice on the student's WEAKEST Bloom level.

**API:** `POST /api/student/adaptive-practice` returns `{ quizCode, targetedLevel }` then redirects to `/student/quiz/[code]`.

**AI involvement:** Picks the lowest-mastery Bloom band from the last-30-day snapshot, generates 5 calibrated MCQs.

#### 3.2.6 Quick Test (`/student/tests`)

**Purpose:** Self-service generation: type a topic, get a quick test.

**API:** `/api/student/quick-test`.

#### 3.2.7 Library (`/student/library`)

**Purpose:** Browse the student's own approved/saved questions and past attempts.

#### 3.2.8 Speed Trainer (`/student/speed`)

**Purpose:** Time-pressured drill — fast questions, immediate feedback.

#### 3.2.9 Sprint / Climber / Drill / Memory / Traps (`/student/sprint`, `/student/climber`, `/student/drill`, `/student/memory`, `/student/traps`)

**Purpose:** Gamified daily-engagement features. Each surfaces a different micro-format (sprint = 60-second rapid-fire, climber = climbing difficulty curve, drill = specific weakness drill, memory = SRS spaced-repetition, traps = high-misconception items).

#### 3.2.10 Teach-Back (`/student/teach-back`)

**Purpose:** Student explains a concept; AI grades the explanation and asks targeted follow-ups.

**API:** `/api/teach-back/grade`, `/api/teach-back/follow-up`.

#### 3.2.11 Misconception Diagnose & Drill (`/student/misconceptions`, `/student/diagnose`)

**Purpose:** Identify root misconceptions from wrong answers; drill specifically against them.

**API:** `/api/misconception/diagnose`, `/api/misconception/drill`, `/api/misconception/resolve`.

#### 3.2.12 Concept Visualizer (`/student/visualizer`)

**Purpose:** Visual diagrams generated from prompts (Gemini-primary for spatial reasoning).

**API:** `/api/visualizer/create`.

#### 3.2.13 Tutor (`/student/tutor`)

**Purpose:** Conversational AI tutor.

**API:** `/api/tutor/chat`.

#### 3.2.14 Voice Teacher, Buddy, Coach (`/student/voice-teacher`, `/student/buddy`, `/student/coach`)

**Purpose:** Conversational AI variants — voice-driven and chat-driven companion modes.

#### 3.2.15 Daily Drill, Digest (`/student/digest`)

**Purpose:** Today's micro-task + a weekly digest of progress.

#### 3.2.16 Rank Predictor (`/student/rank`)

**Purpose:** Manual rank-prediction: type a score, see predicted rank band.

**API:** `/api/rank/predict`. Includes an eligibility classifier (`lib/rankPredictorEligibility.ts`) that refuses to predict non-competitive-exam quizzes.

#### 3.2.17 Results (`/student/results`)

**Purpose:** Detailed post-attempt review — every question, the student's answer, the correct answer, the explanation.

#### 3.2.18 Progress (`/student/progress`)

**Purpose:** Long-horizon trend charts (Bloom mastery over time, score trend).

#### 3.2.19 Certificate (`/student/certificate`)

**Purpose:** Issuable proof of completion for a course / score milestone.

#### 3.2.20 Independent Goal Picker (`/student/independent`)

**Purpose:** First-run flow for independent learners to set their exam_goal.

#### 3.2.21 Join Class (`/student/join`)

**Purpose:** Enter a class join code to attach to a school class.

**API:** `/api/student/join-class`.

#### 3.2.22 Settings (`/student/settings`)

Profile / appearance / security.

#### 3.2.23 Trial Expired Gate (`/student/expired`)

**Purpose:** Hard-stop page shown when the Free trial has ended. Shows Premium vs Premium-Plus side-by-side. The `/student/layout` redirects every other `/student/*` route here when `is_free_expired === true`.

---

### 3.3 School-Admin (Super-Teacher) Modules

#### 3.3.1 School Dashboard (`/school`)

Roll-up of school stats: total students, classes, active teachers, recent activity.

#### 3.3.2 Billing (`/school/billing`)

**Purpose:** Read-only view of the school's plan, expiry, contracted seats, invoice number, PO number, payment history. Past invoices shown for the last 20 cycles.

**Restrictions:** No Mark-Paid or Edit-Plan buttons. Admin uuids deliberately hidden — schools don't see which ZCORIQ staffer clicked Mark-Paid.

#### 3.3.3 Classes (`/school/classes`)

**Purpose:** Create / archive / activate classes. Assign primary / co / acting teachers per class.

#### 3.3.4 Students (`/school/students`)

**Purpose:** Roster + per-student score + attempt count + average score. Bulk-create students from a list (`/api/admin/students/bulk-create`, `/bulk-preview`).

#### 3.3.5 Teachers (`/school/teachers`)

**Purpose:** Invite teachers, manage their class assignments, deactivate.

#### 3.3.6 Reports (`/school/reports`)

**Purpose:** School-wide analytics — Bloom mix across classes, top + bottom performers, time-series engagement.

#### 3.3.7 Digest, Coach (`/school/digest`, `/school/coach`)

**Purpose:** Weekly summary surface for the Admin Head; coach UI for cross-class observations.

---

### 3.4 Platform-Admin Modules

#### 3.4.1 Dashboard (`/admin/dashboard`)

Roll-up: total schools, total subscriptions, MRR-ish indicators, recent onboardings, active plans.

#### 3.4.2 Onboard School (`/admin/onboard-school`)

**Purpose:** Create a school + invite the Admin Head in one click.

**Flow:**
1. Operator enters school name + admin email + admin name. Optionally selects an initial plan.
2. Server calls `inviteUserByEmail` — Admin Head gets an email with a link to set their password.
3. Schools row is inserted with a unique join code (10-attempt retry on collision).
4. Profile row mirrored with `school_id`.
5. Compensating rollback: if any of (auth-user-create / school-insert / profile-link) fails, all prior writes are undone.

#### 3.4.3 Plans (`/admin/plans`, `/admin/plans/new`, `/admin/plans/[id]/edit`)

**Purpose:** Manage the plans catalogue (Free / Premium / Premium Plus / school tiers / pilot).

**Two-eyes proposal queue:** Direct mutations are deprecated — every change flows through `/admin/plans/queue` proposals (`POST /api/admin/plan-proposals` creates; `[id]/approve` applies).

#### 3.4.4 Plan Proposal Queue (`/admin/plans/queue`)

**Purpose:** Review pending plan changes from other admins (or your own drafts). Approve / Edit-and-approve / Reject / Withdraw.

**Two-eyes rules:**
- Self-approval blocked unless bootstrap mode (1 admin total).
- "Edit on approve" is one-shot. Re-edit forces reject+resubmit so the original-submission snapshot is preserved as audit anchor.
- In-flight Razorpay-order warning surfaces if an "edit" proposal touches a plan with non-captured orders in the last hour.
- Stale-edit detection (Round 18 #79): re-fetches the proposal before approve/reject/withdraw and prompts on payload or status drift.

#### 3.4.5 Subscriptions (`/admin/schools/[id]` per-school detail)

**Purpose:** Mark Paid / Suspend / Reactivate / Set Plan / Start Renewal Cycle.

**Field separations:**
- Set Plan = sales event (what plan was sold).
- Start Renewal = cycle event (archives old cycle, opens new with fresh started_at + expires_at).
- Mark Paid = finance event (records when money landed; default DOES NOT touch expires_at unless operator uses the escape-hatch).

**Audit columns:** `payment_recorded_by`, `payment_recorded_at`, `suspended_by`, `suspended_at`, `reactivated_by`, `reactivated_at`.

#### 3.4.6 Users (`/admin/users`)

**Purpose:** Search / filter all users across the platform. Filter by sub-role chips (student / school student / primary teacher / co teacher / platform admin).

#### 3.4.7 Team (`/admin/team`)

**Purpose:** Manage ZCORIQ staff — add platform admins, deputize new ones, sign-in links.

#### 3.4.8 Feature Flags (`/admin/feature-flags`)

**Purpose:** Staged-launch tooling. Global default + per-school + per-user overrides. Audit log on every change.

**Backing:** `platform_flags`, `platform_flag_overrides`, `platform_flag_audit` tables.

**Eval helper:** `isFlagEnabledFor(name, { schoolId, userId })`.

**Starter flags:** `school_marketing_visible`, `school_signup_enabled`, `independent_signup_enabled`.

#### 3.4.9 Free-Tier Limits (`/admin/free-tier-limits`)

**Purpose:** Edit `subscription_limits.free_trial_days` (the time-boxed Free plan window for new independent students). 0 disables the auto-grant.

#### 3.4.10 Security, Settings (`/admin/security`, app-wide settings)

Platform-admin security console.

---

### 3.5 Parent Module

#### 3.5.1 Parent Dashboard (`/parent/[studentId]`)

**Access:** Magic-link only. No password. Single-student scope.

**Shows:** Recent attempts, BloomIQ Score, weak topics, a "your child's strongest area" callout.

**Invite flow:** `/api/parent/invite` is called from the student-side parent screen (`/student/parent`). Generates a Supabase magic link; student forwards it to the parent.

---

## 4. Workflow Documentation

### 4.1 Assessment creation (end-to-end)

**Step 1 — Teacher signs in** at `/login/school` (teacher tab). Layout retries `/api/auth/me` if Supabase auth-server lags (Round-8 fix).

**Step 2 — Teacher generates questions** at `/teacher/generate`. The cross-field validation banner fires if e.g. class grade × teaching context conflict. Teacher acknowledges blocking warnings via the override checkbox, then submits.

**Step 3 — Server runs the generation pipeline:**
- Resolves audience-level + topic-grounding context.
- For each Bloom level, calls `aiJSON` (Groq with Gemini fallback) with the source-specific prompt.
- Each response is validated structurally, deduplicated within-batch (Jaccard + cosine), checked for answer-leak (correct option's key terms must NOT appear in the stem).
- Bloom Verifier second-pass disputes mismatches.
- Survivors get inserted into `question_bank` with `status='pending'`.

**Step 4 — Teacher reviews** at `/teacher/review`. Approves / edits / rejects each.

**Step 5 — Teacher composes** at `/teacher/quizzes/new`. Picks from approved bank, optionally uses "Suggest a test" auto-pick, configures name/time/marking, saves. quiz_assignments row created if a class is selected.

**Step 6 — Students take the test.** `/api/student/attempt-start` enforces server-side `is_free_expired` gate (Round 16 #73), the daily-cap trigger fires for Free tier, and an attempt row is created.

**Step 7 — Student submits.** Score is computed, `bloomiq_scores` row inserted with `trigger_event='quiz'` (recompute path).

**Step 8 — Teacher reviews results** at `/teacher/reports` and `/teacher/analytics`.

### 4.2 Independent-student lifecycle

1. Visitor lands on `/pricing` or `/signup`.
2. Pays via `/api/signup-and-pay` (creates auth user + profile + signs in + creates Razorpay order in one server call).
3. Razorpay modal opens client-side; on success the page calls `/api/checkout/verify` which writes the subscription row.
4. `/api/razorpay/webhook` provides a server-side fallback for the same payment in case the browser tab closes mid-checkout (idempotent via `razorpay_payment_id` unique partial index).
5. Student lands on `/student`. First-time `/api/auth/me` auto-grants the time-boxed Free plan (if `subscription_limits.free_trial_days > 0` and Free is the picked tier) OR the paid plan is recorded with `expires_at = now + period_days`.
6. Student optionally takes the BloomIQ Score calibration.
7. Future-You page shows their predicted rank.
8. As trial nears expiry, the dashboard surfaces upgrade prompts. On expiry, `/student/*` redirects to `/student/expired`.

### 4.3 School onboarding

1. Platform admin at `/admin/onboard-school` enters school details + Admin Head email/name + optional initial plan.
2. Server invites the email via Supabase, creates the `schools` row with a unique join code, links the admin's profile to the school. Compensating rollback if any step fails.
3. Admin Head clicks the invite link → `/auth/set-password` → enters a password → lands at `/school`.
4. Admin Head creates classes, invites teachers (via `/api/admin/school/teachers`), bulk-creates students.
5. Each student gets a username — they sign in at `/login/school` (school tab) with `<username>` (server synthesizes the email).
6. Teachers invite to classes accept via `/api/teacher/invites/respond`.
7. Once onboarded, the school operates within its scope: classes, students, teachers, tests, reports.

### 4.4 Plan-change workflow (two-eyes)

1. Admin A drafts a proposal at `/admin/plans/queue` (kind=edit or kind=create).
2. Validation: slug regex, tier allowlist, currency, pricing model.
3. Saved with `status='open'`.
4. Admin B reviews at `/admin/plans/queue/[id]`. Sees a diff between target and proposed.
5. Three actions:
   - **Approve** — applies the payload to `plans` row. Stamps `approved_by/at` + (if applicable) `effective_from`.
   - **Edit and approve** — one-shot edit on top of A's payload; the original payload is snapshotted to `proposed_at_submit`.
   - **Reject** — `status='rejected'`, reason recorded.
6. Self-approval is blocked when ≥ 2 admins exist. Bootstrap mode (1 admin) allows self-approval with `bootstrap_self_approve=true` and `plans.approved_by=null`.
7. Stale-edit detection prevents a second admin from clobbering A's mid-review edits.
8. In-flight Razorpay-order warning surfaces during approve if an "edit" touches a plan with unverified orders in the last hour.

### 4.5 BloomIQ Score recompute

1. Triggered by quiz submission OR by an explicit `/api/student/score/recompute` call.
2. Server reads the student's calibration responses (anchor) and the most recent 100 attempt-answers (recency-weighted at 1.5x).
3. `computeScore` produces a 300-900 number + per-Bloom breakdown.
4. `predictRankAndColleges` maps the score + exam-goal to a predicted rank band + 3 named colleges.
5. Result is inserted into `bloomiq_scores` table.
6. The badge in `/student` layout refreshes on next page load.

---

## 5. AI Feature Documentation

### 5.1 The AI stack

**Primary:** Groq (`llama-3.3-70b-versatile` for text/JSON; `meta-llama/llama-4-scout-17b-16e-instruct` for vision).

**Fallback:** Gemini 2.5 Flash, falling back further to Gemini 2.0 Flash.

**Routing layer:** `lib/aiClient.ts` — Groq-primary with Gemini fallback on 429 (daily token cap exhaustion) or 5xx. Migration completed in Round 19 — every AI route now goes through this client.

**Reasoning:** Groq is fast and free up to 100k tokens/day. With 100+ pilot users on AI-heavy features (Teach-Back, Misconception, Generate, Tutor, Quick-Test, BloomIQ Score), the cap is reachable. Without the fallback every AI feature would silently fail mid-day.

### 5.2 Generation pipelines

**Question generation** (`/api/generate`, `/api/student/quick-test`):
- System prompt enforces: exactly 4 options, single correct answer, no answer-leak in the stem, no paraphrased duplicates within a batch, Bloom-level conformance, scenario-variance for deep-Bloom items.
- Topic-acronym disambiguation (Round 8 #54): short acronyms default to primary/secondary-education meaning, not exam-jargon meaning. Example: "LCM" in a JEE context → Least Common Multiple, not Linear/Circular Motion.
- Audience-prefix prepended when reading-level is picked.
- Topic-grounding block prepended (sub-areas, real-world anchors, common misconceptions).
- Per-Bloom-level call with shuffled misconception seeds.
- Bloom-Verifier second pass.
- Within-batch dedup + answer-leak detection + cosine similarity against the teacher's recent generations.

**Adaptive practice** (`/api/student/adaptive-practice`):
- Reads the student's 30-day Bloom-mastery snapshot.
- Picks the lowest-mastery band.
- Calls the same generation pipeline scoped to that single band.

**Calibration** (`/api/student/calibration/start` + `/submit`):
- Generates 12 questions tuned per Bloom level for the picked exam goal.
- Submit computes score + Bloom breakdown.

**Teach-Back, Misconception, Tutor:** Conversational LLM calls with feature-specific system prompts. All go through `aiClient` now.

**Concept Visualizer:** Gemini-primary (better spatial reasoning). Two-pass: prose plan → JSON keyframes.

### 5.3 Quality safeguards

| Mechanism | What it prevents |
|---|---|
| Bloom Verifier second pass | AI mislabeling a Remember question as Apply |
| Answer-leak detector | Stem accidentally containing the right answer's key terms |
| Within-batch Jaccard + cosine dedup | Paraphrased duplicates inside one batch |
| Topic-grounding primer | Hallucinated sub-areas / fabricated real-world anchors |
| Exam-mode few-shot examples (CAT/JEE/NEET/etc.) | Meta-questions ABOUT the exam instead of questions IN the exam style |
| Acronym disambiguation rule | "LCM" misread as physics in a JEE context |
| Numerical-content target conditional on topic | Shoehorning fake numbers into history/literature topics |
| Strict JSON parsing with `GroqParseError` / `GeminiParseError` | Silently returning empty payloads on malformed output |
| Per-stage telemetry (droppedLeak, droppedJaccard, droppedCosine, disputedAnswerKeys) | Hidden quality drops — surfaced in shortfall messages |

### 5.4 Hallucination prevention specifically for niche domains

The SYSTEM prompt has an explicit "GENERIC DOMAIN AWARENESS" rule: for specialized professional / technical / niche domains (payment switches, mainframe stack, networking protocols, cloud platforms, regulatory frameworks, etc.) — use REAL terminology. NEVER invent identifiers, opcodes, field bits, function names, or product features. If unsure, write a question that AVOIDS the aspect rather than fabricates.

### 5.5 Taxonomy handling

Every question carries a `bloom_level` enum: Remember / Understand / Apply / Analyze / Evaluate / Create. The verifier sometimes overrides the AI's self-label. Disputed questions get a colored badge in the review queue.

Exam metadata (`lib/examDetectors`) declares which Bloom levels each exam ACTUALLY tests — e.g. CAT tests Apply/Analyze/Evaluate; NEET tests Remember/Understand/Apply/Analyze. The generation pipeline filters requested levels through that list so a teacher can't ask for "Create-level CAT questions".

### 5.6 Syllabus alignment

When source = `topic_syllabus`, the prompt includes the class/grade + the syllabus/board string. When the topic-text matches an exam detector (CAT/JEE/NEET/etc.), the prompt switches to the exam-style mode with sample-question few-shots from canonical paper sections (e.g. JEE Physics/Chemistry/Mathematics).

The `/api/topic-validate` endpoint runs an LLM-side check: given a typed topic + a detected exam, does this topic actually fit the exam's syllabus? Fail-open on errors so the teacher's flow is never blocked by a validator hiccup.

---

## 6. Functional Rules & Validations

### 6.1 Cross-field validation (Generate form)

| Rule | Trigger | Severity |
|---|---|---|
| Class 5-8 × JEE/CAT/NEET teaching-context | Class grade + context picked together | Block + override required |
| Bloom level not supported by exam | e.g. "Create" filter + NEET context | Auto-disable level chip |
| Numerical % > 0 without Apply/Analyze/Evaluate level | Slider engagement | Disable slider with tooltip |
| Source = topic_syllabus without class | Source picked, fields empty | Pre-flight reason text |
| Notes source < 50 chars | Content too short | Pre-flight reason text |
| Image source without image file | File missing | Pre-flight reason text |
| Mode = custom with 0 Bloom levels | At submit | Error |
| Mode = custom > 5 Bloom levels | Toggle attempt | Capped at 5, chip disabled |

### 6.2 Cross-field validation (Build & Assign)

| Rule | Severity |
|---|---|
| Quiz name family ≠ subject family (Math/Science/etc. tokens) | Soft warn |
| Time-per-question < 45 s | Soft warn (rush risk) |
| Time-per-question > 300 s | Info (generous flag) |
| Marking penalty + ≥60% deep-Bloom mix | Soft warn (over-penalty) |
| bloomFilter not in teaching-context's supported set | Soft warn (bank likely empty) |
| Mixed-topics test save | Confirm dialog with counts |

### 6.3 Permission rules (server-side)

| Endpoint | Caller requirement |
|---|---|
| `/api/teacher/*` mutating routes | `requireAuthenticated` (single-session iat enforced) |
| `/api/admin/*` | `requirePlatformAdmin` (platform_admin=true) |
| `/api/admin/plan-proposals/[id]/approve` | Plus two-eyes (not creator, unless bootstrap mode) |
| `/api/student/attempt-start` | Plus server-side `is_free_expired` gate (Round 16 #73) |
| `/api/checkout` + `/verify` | Plus single-session enforcement |

### 6.4 Workflow restrictions

- Inactive (soft-deleted) classes cannot have new attempts started.
- A school's subscription set to `status='cancelled'` or `'suspended'` blocks the activation-pending flip (Round 3 #16).
- `tier='free'` + `is_trial=true` + (admin-blocked OR expires_at<now) → `is_free_expired=true` (Round 3 #15).
- Quizzes can only be assigned to classes the teacher is a member of.

### 6.5 Conditional logic

- **Auto-grant Free plan**: only when role=student AND `!is_school_student` AND `school_id=null` AND no existing subscription AND `subscription_limits.free_trial_days > 0`.
- **Activation-pending flip**: only for `role='super_teacher'` + non-null `school_id` + non-null `plan_id` + valid `period_days` + subscription status allows activation (Round 3 #14, #16).
- **ToS auto-update**: only for the recovery / invite / first-time session flow. Plain password sessions must use Supabase's AAL2 flow.

---

## 7. Cross-Module Relationships

### 7.1 Data dependencies

```
┌──────────────────────────────────────────────────────────────┐
│                       schools                                │
│  super_teacher_id, join_code, state, gstin, plan_*            │
└────────┬──────────────────────────────────────────┬──────────┘
         │                                          │
         ▼                                          ▼
   ┌──────────┐                                ┌──────────────┐
   │ classes  │── class_teachers ── teachers   │ subscriptions│
   │          │── class_members ── students    │  plan_id     │
   │  quiz_   │                                │  status      │
   │  assignments─┐                            └──────────────┘
   └──────────┘   │
                  ▼
            ┌───────────────┐
            │    quizzes    │── quiz_questions ──┐
            │  marking_     │                    │
            │  scheme       │                    ▼
            └───────┬───────┘             ┌──────────────┐
                    │                     │ question_bank │
                    ▼                     │  bloom_level  │
            ┌─────────────────┐           │  category     │
            │ quiz_attempts   │           │  class_id     │
            │  student_id     │           └──────────────┘
            └──────┬──────────┘
                   ▼
            ┌──────────────┐
            │ attempt_     │
            │   answers    │── bloomiq_scores
            └──────────────┘   (recency-weighted)
```

### 7.2 Cross-module workflow transitions

- **Generate → Review → Build & Assign → Take Test → Score Recompute → Future-You update** is the spine.
- **Plan proposal → Plans table → Razorpay order** is the billing spine.
- **School onboard → Admin Head set-password → school operates** is the B2B onboarding spine.

### 7.3 Synchronization concerns

- BloomIQ Score recompute runs synchronously inside the quiz-submission code path. A failed recompute does not block the submission — it logs and moves on.
- The `is_free_expired` flag is computed at every `/api/auth/me` call from the current `subscriptions` row. Stale tabs are caught on focus (debounced 5s, Round 16 #74).
- Two-eyes plan-proposal approval uses an `ensureFresh()` checkpoint to prevent two admins editing the same proposal from clobbering each other (Round 18 #79).

---

## 8. UX & Workflow Design Rationale

### 8.1 Why every cross-field validation is "soft-warn, never-block by default"

Teachers know their students. The platform's job is to surface mismatches, not block legitimate-but-unusual choices. So:
- Most cross-field issues raise an amber inline note that doesn't disable the Generate button.
- Only the most clearly-wrong combinations (e.g. JEE difficulty + Class 5-8) become "block + override checkbox" issues. The override is logged.

### 8.2 Why the Generate form has step-numbered colored circles

The page originally had stacked plain cards with no visual rhythm. Teachers reported it felt cluttered. Modern-app design pattern: numbered circles + accent colors create immediate visual hierarchy and signal the recommended flow without forcing a strict wizard. (Rounds 9 + 11.)

### 8.3 Why "Advanced" is a collapsible

80% of teachers don't need to touch audience-level, sub-topic chips, or numerical %. Hiding them behind a single click keeps the primary form clean. (Round 7.)

### 8.4 Why Build & Assign supports drag-drop reorder + live preview + AI-suggest

These are the three highest-leverage Build & Assign improvements. Drag-drop replaces fragile up/down chevrons. Live preview catches typos and weird ordering before save. AI-suggest reduces a 5-minute "click 10 questions" workflow to a single click. (Round 14.)

### 8.5 Why the Free trial is hard-gated, not silently downgraded

Earlier prototype let trial-expired users fall back to permanent Free. That made monetization invisible — users couldn't tell they'd lost anything. The hard gate at `/student/expired` with Premium + Premium-Plus side-by-side makes the upgrade decision unavoidable but explicit.

### 8.6 Why the BloomIQ Score is opt-in, not mandatory at first sign-in

Earlier prototype hard-redirected uncalibrated students to `/student/bloom-score` on every page load. It made calibration feel like a wall between login and the rest of the product. Now it's surfaced as a friendly card on the dashboard + a "Get your ZCORIQ →" CTA in the layout — keeps the value proposition visible without coercion.

### 8.7 Why plan changes go through a proposal queue, not direct edits

Plans control real money. A single admin shouldn't be able to drop the price of a Premium plan to ₹0 by accident. The two-eyes proposal queue forces a second admin to review every change. Bootstrap mode (1 admin) allows self-approval with a flag — once a second admin exists, the rule kicks in.

---

## 9. Error Handling & Fallbacks

### 9.1 AI errors

| Failure mode | Handling |
|---|---|
| Groq 429 (rate limit) | `aiClient` falls back to Gemini |
| Groq 5xx (server error) | Same as above |
| Groq parse error (`GroqParseError`) | Rethrow — Gemini won't help; surfaces as 502 |
| Gemini parse error (`GeminiParseError`) | Rethrow; same shape as Groq |
| Gemini hang (no response) | 30s timeout via Promise.race (Round 19 #87) |
| No GEMINI_API_KEY | Original Groq error rethrown with a warning log |

### 9.2 Generation shortfall

When the AI returns fewer questions than requested:
- Hard-fail (error toast) if delivered = 0.
- Soft-warn ("Generated X of Y") with per-Bloom-level breakdown otherwise.
- Probable causes listed in the toast: answer-leak detection, within-batch dedup, niche topic.

### 9.3 Validation failures (form)

- Pre-flight: Generate button shows the failure reason inline as amber text.
- Submit-time: red error banner below the form.
- Cross-field issues: dedicated banner above the Generate button. Block issues require checkbox override.

### 9.4 Network / API failures

- Layout auth checks: 3-attempt retry with 300ms backoff on `/api/auth/me` (Rounds 8, 16, 17, 20). Network blip ≠ kicked-out.
- claim-session: 1 retry with 400ms backoff (login page).
- Quiz attempt-start: 410 Gone with `code:"free_expired"` when trial expired (Round 16).

### 9.5 Payment failures

- Razorpay order create fails: client gets 502, retry button.
- Browser closes mid-checkout: server-side webhook handler (`/api/razorpay/webhook`) finishes the subscription bind. Idempotent via `razorpay_payment_id` unique partial index.
- Price changed mid-checkout: 409 Conflict with `code:"plan_price_changed_mid_checkout"` — Razorpay releases the hold; user retries from /pricing.
- Amount mismatch (captured ≠ plan price): 409 refusal in `/api/razorpay/webhook`.

### 9.6 Onboarding rollback

If school-onboard partway fails:
- Auth user create fails → return error.
- Schools row insert fails → delete the auth user.
- Profile link fails → delete the school + delete the auth user.

No orphan records left behind.

---

## 10. Reports & Analytics

### 10.1 Student-facing analytics

- **BloomIQ Score** — single 3-digit indicator (300-900) with per-Bloom breakdown.
- **Predicted Rank** — derived from score + exam goal.
- **Progress trend chart** — score over time.
- **Bloom mastery radar** — per-Bloom band performance.
- **Weakest topic** — surfaces in adaptive-practice and Future-You "Best You" delta.

### 10.2 Teacher-facing analytics

- **Per-class Bloom mix** — radar of class-wide Bloom mastery.
- **Top + bottom performers** — sorted by recent score.
- **Topic gap** — topics with low coverage in recent attempts.
- **Question quality view** — verified vs disputed badges in the review queue.

### 10.3 School-admin analytics

- **School-wide Bloom mix** across all classes.
- **Engagement trends** — daily/weekly attempt counts.
- **Active vs inactive students** by attempt count.

### 10.4 Platform-admin analytics

- **Schools + subscriptions roll-up** at `/admin/dashboard`.
- **Recent onboardings** + status (pending / accepted).
- **Plan distribution** — count per plan slug.

### 10.5 Key metrics

| Metric | Where surfaced |
|---|---|
| BloomIQ Score | Student layout badge + `/student/bloom-score` + `/student/future` |
| Class average score | `/teacher/reports` |
| Verified % | `/teacher/review` per batch |
| Daily attempt count | School + teacher dashboards |
| Razorpay order conversions | Platform admin dashboard |

---

## 11. Technical Architecture Summary

### 11.1 Frontend

- **Framework:** Next.js 16 (App Router).
- **Styling:** Tailwind utility classes + a small custom CSS layer (`app/globals.css`) defining `.card`, `.btn`, `.input`, `.label`, `.badge-*`, etc.
- **Icons:** lucide-react.
- **Charts:** Recharts.
- **State:** Local React state (useState/useReducer); no global store. Each page fetches what it needs.
- **Auth:** Supabase JS client (browser).

### 11.2 Backend

- **Runtime:** Next.js API routes running on Vercel (Node.js runtime).
- **Auth:** Supabase Auth (JWT bearer tokens). Single-session enforced via `iat` vs `profiles.session_iat`.
- **DB access:** Supabase JS — user-token client (RLS-respecting) for reads, service-role client (`supabaseAdmin()`) for cross-user / admin operations.
- **AI:** `lib/aiClient.ts` (Groq + Gemini fallback) + `lib/groq.ts` + `lib/gemini.ts`.
- **Payments:** Razorpay REST API + webhook handler.
- **Email:** Supabase Auth's transactional sender (invite links, magic links).

### 11.3 Database (PostgreSQL via Supabase)

Major tables:
- `profiles` (user metadata mirror)
- `schools`
- `classes` + `class_teachers` + `class_members`
- `subscriptions` + `subscription_invoice_archive`
- `plans` + `plan_change_proposals` + `plan_change_proposals_history`
- `quizzes` + `quiz_questions` + `quiz_assignments`
- `quiz_attempts` + `attempt_answers`
- `question_bank` (with `status` enum: pending / approved / rejected)
- `bloomiq_scores`
- `calibrations` + `calibration_responses`
- `razorpay_orders`
- `platform_flags` + `platform_flag_overrides` + `platform_flag_audit`
- `subscription_limits` (single row, id=1, holds `free_trial_days`)

### 11.4 Key APIs

~130 API routes. Most-trafficked:
- `/api/auth/me` — every page load
- `/api/auth/claim-session` — every sign-in
- `/api/generate`, `/api/student/quick-test`, `/api/student/adaptive-practice` — every AI call
- `/api/checkout`, `/verify`, `/api/razorpay/webhook` — every paid transaction
- `/api/student/attempt-start` — every test attempt
- `/api/student/score/recompute` — every score update

### 11.5 AI orchestration

```
caller route (e.g. /api/generate)
  └─→ lib/aiClient.aiJSON(systemPrompt, userPrompt)
       └─→ lib/groq.groqJSON  (primary; throws on 429/5xx)
            └─→ lib/aiClient catches; calls lib/gemini.geminiJSON (fallback)
                 ├─→ Gemini 2.5 Flash (primary model)
                 └─→ Gemini 2.0 Flash (fallback model, on 404)
```

Each call has a 30s timeout via Promise.race. Tokens capped at 4500 (JSON) / 1600 (text).

### 11.6 Integrations

| Integration | What it does |
|---|---|
| Supabase | Auth + DB + email + storage |
| Razorpay | Payment collection (B2C) |
| Groq | Primary LLM |
| Gemini | Fallback LLM + visualizer primary |
| Vercel | Hosting + serverless functions |
| PostHog | Analytics |

---

## 12. Production Readiness

### 12.1 Scalability

- **DB:** Supabase's managed Postgres scales with paid tiers; current bottleneck is likely AI tokens (Groq free-tier daily cap).
- **AI:** Groq + Gemini fallback together handle ~200k+ tokens/day for free; paid tiers if needed.
- **Vercel:** Serverless scales automatically; per-function maxDuration is the hard ceiling (60-90s).

### 12.2 Performance-sensitive workflows

- `/api/generate` — multi-LLM-call route. Rate-limited per user (5 burst, 10/hr, 30/day). Tight token caps prevent runaway responses.
- `/api/student/quick-test` — same shape.
- `/api/teacher/quiz-suggest` (Round 14) — pure server-side sampler, no LLM. Fast.
- `/api/auth/me` — every page load. Service-role profile lookup is the hot path.
- BloomIQ Score recompute — synchronous on quiz submit; could be moved to a queue if it becomes slow.

### 12.3 Security-sensitive areas

- **Single-session enforcement** — token `iat` vs `profiles.session_iat`. New sign-in elsewhere invalidates old tokens via `claim-session`.
- **Two-eyes plan approval** — server-side enforced; bootstrap-mode exception explicit.
- **Razorpay signature verification** — HMAC-SHA256 with timing-safe compare, strict hex shape check, replay protection via unique partial index.
- **Service-role usage** — only for cross-user / admin reads; never exposed to client.
- **ToS version allowlist** — server-side; client-supplied versions rejected (Round 3 #18).

### 12.4 Maintainability concerns

- **20-round audit closed ~89 findings.** Both CI invariants (tsc strict + ignoreBuildErrors:false) are locked in.
- **Codemod scripts (apply-*.mjs)** historically duplicated content. The audit cleaned three corrupted files (groq, bloomVerifier, schools-coming-soon). The pattern recurred in /teacher/quizzes/new (Round 6B). Recommendation: scripts that mutate source must run with an idempotency check + a babel-parse verifier before they're considered "applied".

### 12.5 Operational dependencies

| Dependency | What breaks if it's down |
|---|---|
| Supabase | Everything |
| Groq | AI features slower (Gemini fallback kicks in) |
| Gemini | If Groq is also at cap, AI features 502 with a clear message |
| Razorpay | New paid signups + renewals blocked; existing subscriptions unaffected |
| Vercel | Whole site down |

---

## 13. Feature Index

Alphabetical, with the surface where it lives.

| Feature | Surface |
|---|---|
| Adaptive Practice | `/student/practice` |
| AI question generation | `/teacher/generate`, `/student/tests` |
| AI-suggested test composition | `/teacher/quizzes/new` (Round 14) |
| Audit log (flags) | `/admin/feature-flags` |
| Auto-save composer draft | `/teacher/quizzes/new` |
| Bank filtering | `/teacher/bank`, `/teacher/quizzes/new` |
| Billing (school side) | `/school/billing` |
| BloomIQ Score | `/student/bloom-score`, layout badge |
| Bloom Verifier | `/teacher/review` |
| Build & Assign a test | `/teacher/quizzes/new` |
| Calibration | `/student/calibration`, `/student/bloom-score` |
| Certificate | `/student/certificate` |
| Class management | `/school/classes`, `/teacher/classes` |
| Climber, Sprint, Drill | `/student/climber`, `/sprint`, `/drill` |
| Composition templates | `/teacher/quizzes/new` (Round 15) |
| Concept Visualizer | `/student/visualizer` |
| Cron expiry job | `/api/cron/expire-subscriptions` |
| Daily attempt cap (Free) | Postgres trigger `check_attempt_quota` |
| Daily digest | `/teacher/digest`, `/school/digest`, `/student/digest` |
| Drag-drop question reorder | `/teacher/quizzes/new` |
| Exam papers generation | `/teacher/papers` |
| Feature flags (staged launch) | `/admin/feature-flags` |
| Filter pills | `/teacher/quizzes/new` |
| Flashcards (assign) | `/teacher/assign`, `/student/flashcards` |
| Free-trial expiry gate | `/student/expired`, `/api/auth/me` |
| Future-You rank prediction | `/student/future` |
| Generate questions (teacher) | `/teacher/generate` |
| Generate questions (student) | `/student/generate`, `/student/tests` |
| Independent learner sign-up + pay | `/signup`, `/api/signup-and-pay` |
| Intent chips (Generate) | `/teacher/generate` |
| Invoice (per subscription) | `/admin/subscriptions/[id]/invoice` |
| Join class | `/student/join`, `/api/student/join-class` |
| Live preview (student view) | `/teacher/quizzes/new` (Round 14) |
| Live test | `/teacher/live`, `/student/live` |
| Marking scheme picker | `/teacher/quizzes/new`, `/student/practice` |
| Misconception drill | `/student/misconceptions` |
| Onboard school | `/admin/onboard-school` |
| Parent dashboard | `/parent/[studentId]` |
| Plan change proposal queue | `/admin/plans/queue` |
| Plan management | `/admin/plans` |
| Quick mode (composer) | `/teacher/quizzes/new` (Round 14) |
| Quick test (student) | `/student/tests` |
| Rank predictor | `/student/rank` |
| Razorpay checkout | `/pricing` → `/api/checkout` |
| Razorpay webhook | `/api/razorpay/webhook` |
| Recent topics (composer) | `/teacher/quizzes/new` |
| Reports (per class) | `/teacher/reports` |
| Reports (school-wide) | `/school/reports` |
| Review pending questions | `/teacher/review` |
| Sign-in (school) | `/login/school` |
| Sign-in (student) | `/login/student` |
| Sign-in (staff) | `/staff` |
| Single-session enforcement | `/api/auth/me`, `/claim-session` |
| Speed Trainer | `/student/speed` |
| SRS (memory) | `/student/memory`, `/api/srs/*` |
| Stale-edit detection (plans) | `/admin/plans/queue/[id]` (Round 18) |
| Step indicators | Generate + Build & Assign hero rows |
| Student bulk-create | `/api/admin/students/bulk-create` |
| Student dashboard | `/student` |
| Subject filter (composer) | `/teacher/quizzes/new` |
| Subscription mark-paid | `/api/admin/subscriptions/[id]/mark-paid` |
| Subscription suspend / reactivate | `/api/admin/subscriptions/[id]/*` |
| Teach-Back | `/student/teach-back` |
| Teaching-context picker | `/teacher/generate`, `/teacher/quizzes/new` |
| Test name × subject warning | `/teacher/quizzes/new` |
| Time × question-count warning | `/teacher/quizzes/new` |
| Topic acronym disambiguation | SYSTEM prompt rule #7 |
| Topic disambiguation (LLM) | `/api/topic-validate` |
| Topic grounding | `lib/topicGrounding` |
| Topic suggestions | `lib/topicSuggestions` |
| Traps | `/student/traps` |
| Tutor (chat) | `/student/tutor`, `/api/tutor/chat` |
| Two-eyes plan approval | `/api/admin/plan-proposals/[id]/approve` |
| Uncovered class topics card | `/teacher/quizzes/new` (Round 15) |
| User search & filter | `/admin/users` |
| Vision generation (image source) | `/api/generate` (groqJSONVision) |
| Voice teacher | `/student/voice-teacher` |
| Weekly drill progress | `/student/digest` |
| X-ray | `/student/xray`, `/api/xray/*` |

---

## 14. Recommended Documentation Gaps

Areas worth documenting in a follow-up pass:

1. **Detailed migration history** — there are 94+ Supabase migrations referenced across audit notes; a single `MIGRATIONS.md` mapping migration number → purpose → introduced-by-feature would help operators.
2. **Per-role feature gating table** — which `plans.features` keys unlock which UI surfaces. Currently scattered across `lib/featureAccess.*`.
3. **API contract reference** — request/response schemas for all ~130 routes. OpenAPI / Swagger doc.
4. **Threat model** — explicit document of the security assumptions: what's trusted, what isn't, where service-role is used, why two-eyes exists, etc.
5. **Runbook** — what to do when Groq is fully down, when Razorpay webhook is dropping events, when Supabase is rate-limiting, when an expired-Free-trial student calls support.
6. **Schema reference** — every table, every column, with semantic meaning. Today the comments are inline in migrations; a synthesized doc would help new engineers.
7. **End-to-end test catalogue** — the existing `scripts/test-billing-logic.js` (41 unit tests) is excellent; document its coverage matrix + what's NOT covered.
8. **Brand-rename status** — the BloomIQ → ZCORIQ migration is mid-flight (some surfaces use the old name still). A checklist of remaining sites + a CI grep guard would close this out.

---

*This document was compiled from the live implementation as of 2026-05-17, drawing on 20 rounds of structured audit work covering ~89 distinct findings. Any feature described above is verified against the source code; any planned-but-not-shipped capability is called out explicitly in its module section.*
