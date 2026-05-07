# 🌱 BloomIQ

**Assess _how_ students think — not just what they recall.**

BloomIQ is an end-to-end Bloom's Taxonomy-driven assessment platform. Three role tiers (school principals, teachers, students), two student modes (school-managed vs independent subscription), AI-generated content from five sources, Bloom-level analytics, printable exam papers, and reporting suites.

---

## ⚠️ Important — Next.js 16

This project uses **Next.js 16** with breaking changes — APIs, conventions, and file structure may differ from older Next.js docs / training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing routing/data-fetching code. Heed deprecation notices.

---

## 👤 First-time account creation & login — by role

How a fresh account becomes a working account, for each of the five
roles BloomIQ supports. All flows go through the same Supabase Auth
backend; the differences are in what gets gated, what's required
before features unlock, and who can self-onboard vs needs admin
intervention.

The role-aware redirect happens via `app/login/page.tsx` after auth
returns. Profile rows (`public.profiles`) are auto-created via the
auth trigger from migration 02; role is set at signup or by an admin.

### 1. Independent student (self-serve)

| Step | Where | What happens |
|---|---|---|
| Sign up | `/signup?role=student` (default if no `?role=`) | Email + password. Optional: pick exam goal at this step or later. Profile row inserted with `role='student'`, `is_school_student=false`, `school_id=null`. |
| First login | `/login` | Redirected to `/student`. |
| First-run gating | `/student` dashboard | If `exam_goal` is null, the goal-picker card prompts them to choose (Class 10 boards, JEE prep, etc.). |
| Plan | `subscriptions.tier` defaults to `free` (no row required). They can upgrade at `/pricing` via Razorpay → goes through `/api/checkout` + `/api/checkout/verify`. |
| Locked features | Lock badges show **"Premium" / "Premium Plus"** (never "School Pilot" — fixed by lib/featureAccess `findUnlockingTier(key, "personal")`). Clicking opens `<PaywallModal>` with /pricing CTA. |

**No school involvement.** They own their data; can leave it inactive
forever; can delete their account; can upgrade/downgrade independently.

### 2. School student (admin-managed)

| Step | Where | What happens |
|---|---|---|
| Sign up | **Cannot self-sign-up as a school student.** Must be created by their school's Admin Head via `/school/students` bulk-create or `/api/admin/students/bulk-create`. Migration 02 sets `is_school_student=true` and `school_id` to the school. |
| First login | `/login` | Redirected to `/student`. Sidebar renders the school-student variant (Class / Live / Practice groups). |
| First-run gating | None — they land on the dashboard with whatever quizzes the teacher has assigned. |
| Plan | Inherits the school's plan (`subscriptions.tier` resolved with `source='school'` in `useFeatureAccess`). They can never upgrade themselves. |
| Locked features | Lock badges show their school tier ("School Pilot" / "School Standard" / "School Plus"). PaywallModal variant tells them "ask your school admin" — no /pricing link. |

**No self-enrol path.** The "Join class via code" feature exists in the
codebase but is intentionally NOT exposed in their UI; classes are
admin-rostered. Same logic for password resets — teacher administers.

### 3. Teacher (school code OR email invite)

| Step | Where | What happens |
|---|---|---|
| Sign up | `/signup?role=teacher` | Email + password. Profile row inserted with `role='teacher'`, `school_id=null`. |
| First login | `/login` | Redirected to `/teacher`. |
| **First-run gating — the big one** | `/teacher` layout | If `school_id` is null, every `/teacher/*` sub-route redirects back to `/teacher` home, which renders **only** the welcome strip + "Join your school" card. No focus card, no stats trio, no recent tests, no Generate / Tests / Live / Coach. Teachers MUST be in a school to use teacher features. |
| Two ways to join | (a) paste the 8-char school code from the Admin Head into the join form on `/teacher` home → POST `/api/school/join`. (b) Admin Head invites them by email from `/school/teachers` → invite email lands → first signup auto-claims via migration 09. |
| After join | `school_id` populates, layout gate releases, full dashboard reveals. |
| Plan | Inherits school's plan. No personal upgrade path. |

### 4. Super-teacher (Admin Head)

| Step | Where | What happens |
|---|---|---|
| Sign up | `/signup?role=teacher` initially. The Admin Head role is granted, not self-claimed. |
| Becoming Admin Head | One of: (a) bootstrap their school via `/api/admin/onboard-school` (platform-admin–driven), (b) the existing Admin Head transfers via the "Transfer Admin Head" UI on `/school` home, (c) explicit SQL flip on `profiles.role`. Migration 03 wires the trigger that promotes role to `super_teacher`. |
| First login as Admin Head | `/login` | Redirected to `/school`. Sidebar renders the super-teacher variant (Roster / Insights / Assist). |
| First-run gating | If their school has no `join_code`, one is auto-generated on first dashboard visit (handled in `/school/page.tsx` legacy-recovery path). |
| Plan | School plan; visible in the badge top-right. Plan changes go via support@bloomiq.app — not self-serve. |

### 5. Platform admin (BloomIQ internal staff)

| Step | Where | What happens |
|---|---|---|
| Bootstrap | The first admin is set via raw SQL: `update profiles set platform_admin=true where id='<user_uuid>'`. This is the chicken-and-egg case — there's nobody to grant it through the UI yet. |
| Login | `/staff` (hidden route, not linked from public pages) → standard email/password. Redirects to `/admin/onboard-school` (or the last visited admin path). |
| Sidebar | Renders the platform-admin variant of the shared Sidebar component (Dashboard / Onboard School / Plans / Admin Team), wired in via the Sidebar refactor in 2026-05-02. |
| Granting more admins | `/admin/team` → invite by email. Recipient signs up normally; the invite-claim mechanism flips `platform_admin` on first auth. Two-eyes rule for plan-proposal approval kicks in once a second admin exists. |
| Plan / school | Platform admins are exclusive — no school, no plan badge, no role-based dashboard ping-pong. They live in `/admin/*` only. |

### Bootstrapping a test Admin Head (dev only)

`/signup` intentionally does NOT expose the Admin Head role — production
Admin Heads are provisioned by platform admins via `/admin/onboard-school`
after the school's payment lands (which sends a Supabase invite email).
That's the right design for prod, but it makes local testing painful when
SMTP isn't wired up and the invite email never arrives.

For dev / staging only, use this SQL block in the Supabase SQL editor.
It (1) confirms the email so login works without clicking a link,
(2) creates a fresh school with a random join code, (3) promotes the user
to `super_teacher` and points `profiles.school_id` at the new school.
Idempotent on the email-confirm step; not idempotent on the school
creation (running twice creates two schools — clean up if needed).

```sql
-- Substitute the email and school name. The user must already exist in
-- auth.users (sign up first via /signup?role=teacher, or via Supabase
-- dashboard "Add user").
do $$
declare uid uuid; sid uuid;
begin
  select id into uid from auth.users where email = 'principal@test.com';
  if uid is null then
    raise exception 'No auth.users row for principal@test.com — sign up first.';
  end if;
  insert into public.schools (name, super_teacher_id, join_code)
    values ('Test School', uid, upper(substr(md5(random()::text), 1, 6)))
    returning id into sid;
  update public.profiles set role = 'super_teacher', school_id = sid where id = uid;
  update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()),
                        confirmed_at       = coalesce(confirmed_at,       now())
   where id = uid;
end $$;
```

After this, the user can sign in on the **Admin Head (Principal)** tab at
`/login` with their original password, lands on `/school`, and sees the
school admin sidebar. From there the same flows apply: invite teachers,
promote up to 2 deputies, set acting covers, etc.

**Forgot your test password?** One more SQL block, run in Supabase SQL
editor (the `crypt`/`gen_salt` extensions ship with Supabase):

```sql
update auth.users
   set encrypted_password = crypt('NewTempPassword123!', gen_salt('bf')),
       email_confirmed_at = coalesce(email_confirmed_at, now())
 where email = 'principal@test.com';
```

For prod, do not use either of these directly — go through the
platform-admin invite flow at `/admin/onboard-school` instead.

### Common edge cases to keep in mind

- **A user upgrading from teacher → super_teacher** keeps the same auth user and profile row; only `role` flips. Their school_id stays.
- **Email change** is not self-serve in the UI; users must contact support. The auth row's email is the source of truth — `profiles` doesn't store email separately.
- **Password reset** lives at `/auth/set-password` for everyone except school students (their teacher resets via `/school/students` action).
- **2FA** is opt-in for everyone except school students (we don't expect 8-year-olds to manage TOTP). Enable at `/settings/security`.
- **Email confirmation on signup** is currently DISABLED in Supabase (Auth → Providers → Email → uncheck "Confirm email"). Switch to real transactional email before production.

---

## 🆕 Latest session — 2026-05-07 (Big polish day: test composer & detail upgrades, learner profiles, assign UX overhaul, nav rename)

A long session. The dominant themes: make the teacher's "compose → assign" loop
feel obvious instead of hidden, introduce per-user learning context so corporate
trainees stop seeing K-12 examples, and fix nav labels that read like jargon.

### What shipped

**1. Test detail page (`/teacher/quizzes/[id]`) — preview + top CTA + edit-questions**

Previously the page loaded only a count of questions ("13 questions") and never
the questions themselves — there was no way to inspect what you'd built before
sending it out. Now:

- A **Preview test** section between the metadata cards and the Assignments
  list. Renders all questions in the order students will see them, with the
  correct option highlighted, Bloom badge, topic, explanation. Toggle to hide
  answers. Print button. Collapsible.
- **Top-of-page "Assign to class"** primary CTA right next to the title — the
  dominant action on this page. The existing button next to the Assignments
  section header stays for the "I'm scrolling through" mental moment.
- **Edit questions** link that opens `/teacher/quizzes/new?ids=...` with the
  current selection pre-loaded so you can swap or reorder without starting over.

**2. Tests list (`/teacher/quizzes`) — status pills + inline Assign + prominent CTA**

- Each row now carries a status pill: amber **Unassigned** or emerald **Assigned · N**.
  The teacher's eye lands on tests that still need to go out.
- Inline **Assign** button per row, opens the shared `AssignTestModal` in
  place — no need to drill into the detail page just to assign.
- Title upgraded "Your tests" → "**Build & assign tests**" with a descriptive
  subtitle. The "+ New test" link is now a prominent **Create new test** CTA
  (text-base, px-5, shadow) so it doesn't blend into the header.
- Top-of-page caption shows total + unassigned count ("12 tests so far · 3 unassigned").

**3. Shared `<AssignTestModal>` component**

The Assign-test modal lived inline on the detail page. Extracted to `components/AssignTestModal.tsx` and reused on both the detail page and the list-page inline button. Same behaviour (mandatory future due-date, whole-class vs. specific-students, duplicate-assignment confirm); single source of truth.

**4. Generate page — outcome-chip intent picker (`/teacher/generate`)**

Six outcome-shaped chips at the top, K-12 set:

- Quick formative check (Remember + Understand)
- Chapter-end test (Understand + Apply + Analyze)
- Diagnostic (all six Bloom levels evenly)
- Mock paper (Apply + Analyze + Evaluate; pairs with the existing exam-detector)
- Homework set (Apply + Analyze)
- Re-teach / remediation (Remember + Understand)

Click a chip → form pre-fills (Bloom mode, picked levels, per-level count) →
green "Why this setup:" caption explains the rationale → all dials still
editable. Soft narrowing, not a hard gate.

**5. Class scope on `/teacher/generate` (Q1 V1)**

Optional **"Which class is this for?"** dropdown above the intent picker. Lists
classes the teacher is assigned to (primary / co / acting). When picked, shows
a green focus-reminder banner. Topic suggestions from class history + Generate-
and-assign combo are V2 (deferred).

**6. Learner profile system (Q2) — non-invasive corporate readiness**

The most strategic change in the session. Adds a `learner_profile` field to
`profiles` with three values (`k12` default, `competitive_exam`, `corporate`)
that drives content suggestions WITHOUT changing any vocabulary. A corporate
trainee is still called a "student" in the UI; they just see Java / AWS /
mainframe examples instead of Photosynthesis.

Components:

- **Migration 52** — adds `learner_profile` text column with a check constraint
  on the three enum values; default `'k12'` so every existing user is unaffected.
- **`<LearnerProfilePrompt>`** — first-time inline card on the generate pages
  asking *"Quick question — what are you here to learn?"*. After first interaction
  it collapses to a **persistent compact chip row** at the top so users can
  switch context any time without leaving the page. Selected chip rendered in
  solid emerald-600 with white text + ring for unmistakable "this is on" feel.
- **`lib/skillDetectors.ts`** — corporate skill detection table (Java, Python,
  TypeScript, Go, COBOL, JCL, Mainframe, DB2, CICS, React, Spring, Django, Node,
  AWS, GCP, Azure, Kubernetes, Docker, Terraform, SQL, Postgres, SAP, ServiceNow,
  Salesforce — 24 entries). When a corporate user types one of these in the
  topic field, a green "Detected: …" banner appears and the prompt switches to
  skill-assessment style.
- **Profile-aware intent chips** on `/teacher/generate`:
  - Corporate: Onboarding skill check / Certification prep / Code review drill /
    Architecture scenario / Hands-on debugging
  - Competitive exam: Mock paper first, then Diagnostic / Formative / Re-teach
  - K-12: existing six chips
- **Profile-aware topic placeholders** on `/teacher/generate` AND `/student/generate` —
  three helper functions per page swap example text:
  - K-12 (default): *Photosynthesis / Newton's Laws of Motion / Mitochondria*
  - Competitive exam: *CAT Quantitative Aptitude / JEE Mechanics / NEET Biology*
  - Corporate: *Java Streams / Spring Boot security / Kubernetes pod scheduling*
- **Editable from `/settings/profile`** — dropdown visible to all roles.
- **`/api/auth/me`** extended to expose `learner_profile` so the profile page can hydrate it.
- A comment in the student-side code explicitly notes that `is_school_student`
  is **intentionally** not consulted — a corporate trainee enrolled by their
  L&D logs in as a school student in our schema, but their `learner_profile`
  is the source of truth for what they're studying.

**7. Source-tab reorder on `/student/generate`**

Past question paper demoted from position 1 to position 4. Most school students
aren't doing exam prep day-one; the curriculum-driven path is the natural
landing. New order: Topic+syllabus → Just a topic → From your notes → Past
paper → From image. Past paper kept in the list (still useful for indie exam
aspirants), just no longer the front-page lead.

**8. Self-explanatory nav labels**

Sidebar + MobileNav teacher entries renamed:

- "Generate" → **"Generate Questions"**
- "Review" → **"Review Pending"**
- "Tests" → **"Build & Assign Tests"**

The nav now reads as a workflow: *Generate Questions → Review Pending → Build &
Assign Tests*. Page subtitles re-explain this pipeline so a new teacher
understands what each destination does.

**9. Login picker — single-line buttons**

The cards on `/login` were wrapping their CTAs onto two lines on tablet
viewports. Shortened labels (the card heading already contextualizes — no need
to repeat "School" / "Student" in every button) and added `whitespace-nowrap`.
Now: *Sign in* / *Create account* / *Talk to us* — all single-line at any
viewport ≥ 320 px.

**10. Auth-token guard (`purgeStaleAuthBlob` in `lib/supabase/client.ts`)**

Layered defense in depth on top of the 05-06 interceptor. `supabaseBrowser()`
now scrubs localStorage of definitely-dead session blobs (corrupted JSON,
missing refresh token, access-token expired > 7 days ago) BEFORE supabase-js
gets a chance to read them and emit the noisy `console.error("Invalid Refresh
Token: Refresh Token Not Found")`. Also-ran `purgeStaleSession()` only kills
pathological data; valid sessions stay intact.

### Decisions made and explicitly NOT shipped

- **Quick-assign sidebar entry + `/teacher/assign` page** — built and removed
  in the same session. Redundant with the inline Assign button on the
  list page. The directory now contains a redirect-only stub so stale bookmarks
  don't 404.
- **Question-calibration UI** — removed earlier (logged in 05-06). Underlying
  `/api/qbank/calibrate` endpoint and DB columns left intact in case we revive.
- **`org_type` column on schools** — discussed and **deferred**. Premature for
  current scale (no corporate customers yet); user-level `learner_profile` covers
  the realistic scenarios. Revisit after 3+ corporate customers signed.
- **`is_school_student` gating of corporate option** — explicitly avoided. A
  corporate L&D logs trainees in as school students in our schema; gating
  would hide the right option for the right people.
- **Live test stats card** — built earlier today, then removed when we
  pulled out the question-calibration surface (it was calibration-driven and
  became redundant once that data wasn't surfaced).

### Hosting cost impact

Negligible. New `/api/teacher/class-fit` endpoint is one Supabase call per
class+selection change (debounced 400 ms). New profile fetch on generate-page
mount adds one row read per session. Auth-guard runs entirely client-side, no
server cost. The new migration adds one nullable text column with a check
constraint — no row-level cost.

### Files touched

| File | Change |
|---|---|
| `supabase/migrations/52_profiles_learner_profile.sql` | NEW migration |
| `components/AssignTestModal.tsx` | NEW shared modal |
| `components/LearnerProfilePrompt.tsx` | NEW first-time + chip-row prompt |
| `lib/skillDetectors.ts` | NEW skill-detector table |
| `app/teacher/quizzes/[id]/page.tsx` | Preview, top CTA, edit link, shared modal |
| `app/teacher/quizzes/page.tsx` | Status pills, inline Assign, prominent CTA, subtitle |
| `app/teacher/generate/page.tsx` | Intent picker, class picker, profile-aware intents + placeholders, skill banner |
| `app/student/generate/page.tsx` | Profile prompt, skill banner, profile-aware placeholders, tab reorder |
| `app/settings/profile/page.tsx` | learner_profile dropdown |
| `app/login/page.tsx` | Single-line buttons, shorter labels |
| `components/Sidebar.tsx` | Self-explanatory teacher nav labels |
| `components/MobileNav.tsx` | Self-explanatory teacher nav labels |
| `lib/supabase/client.ts` | `purgeStaleAuthBlob` guard |
| `app/api/auth/me/route.ts` | Expose `learner_profile` |
| `app/teacher/assign/page.tsx` | NEW redirect-only stub (page was built then removed) |

### Pre-deploy checklist

Apply migration 52 in Supabase SQL editor BEFORE the new build goes live —
otherwise the `learner_profile` column doesn't exist and the profile page
+ generate prompt will silently fail on writes:

```sql
-- Run the contents of supabase/migrations/52_profiles_learner_profile.sql
notify pgrst, 'reload schema';
```

### Test plan (manual, next session)

1. **Migration 52 applied** — `select learner_profile from profiles limit 1;` returns `'k12'` for everyone
2. **First-time prompt** — fresh K-12 user lands on `/teacher/generate` and sees the rich card; pick "Professional / training"; reload page → compact chip row only, with "Professional" highlighted in solid emerald
3. **Profile cascade** — switch to corporate; intent chips swap to Onboarding skill check / Cert prep / etc.; topic placeholders swap to "e.g. Java Streams"
4. **Skill detection** — type "Java Streams" with corporate profile; green "Detected: Java" banner appears
5. **Test detail preview** — open `/teacher/quizzes/[id]` for an existing test; see the new Preview section with all questions; toggle Show correct answers; click Print
6. **Inline Assign** — on `/teacher/quizzes` list, an Unassigned row's button opens the shared modal; assign; row repaints with emerald "Assigned · 1"
7. **Top-of-page Assign CTA** — on `/teacher/quizzes/[id]`, the "Assign to class" button next to the title opens the same modal
8. **Edit questions** — on `/teacher/quizzes/[id]`, click "Edit questions"; lands on composer with ids pre-selected
9. **Sidebar labels** — "Generate Questions / Review Pending / Build & Assign Tests" visible
10. **Login picker** — `/login` cards show single-line "Sign in / Create account / Talk to us" at viewport widths 360 / 768 / 1280
11. **Auth guard** — sign in, manually corrupt localStorage `sb-*-auth-token` value, refresh; no console error; page redirects to `/login`
12. **Class picker** — on `/teacher/generate`, pick a class from the dropdown; green focus banner appears; refresh page; selection persists across that session

---

## 🆕 Earlier session — 2026-05-06 (Compose-a-test: Class-fit suggestion + question-calibration UI removed)

The teacher Compose-a-test page (`/teacher/quizzes/new`) gained one new affordance and lost a complex one. Net effect: a simpler, more useful composer.

### What shipped

**Class-fit suggestion (new) — "Will this fit a class?"**

Optional dropdown above the Create button on the right sidebar. When the
teacher picks one of their classes, a debounced fetch hits a new
`/api/teacher/class-fit` endpoint and reports:

- "8 of 15 selected questions have prior attempts in Class 9-A. Average there: 67% across 142 attempts."
- Or, if no overlap: "This class hasn't seen any of the 15 selected questions yet — fresh territory."

It's a planning aid, not a predictor — it surfaces whether the draft test
recycles material the class has drilled (and how well they did), or
breaks new ground. Hides cleanly when the teacher has no classes
assigned, no class is picked, or no questions are selected.

The endpoint joins `attempt_answers` × `quiz_attempts.student_id ∈ class_members(class_id)` × `question_id ∈ requested ids`,
gated by an upstream `class_teachers` membership check on the calling
teacher (any role: primary / acting / co). Service-role read; teacher
cannot fish for data outside their own class.

**Question-calibration UI removed (deletion)**

The Calibrate now button, the difficulty / discrimination pills next to
every question in the library, the calibrating progress badges, and a
live test-stats card that briefly shipped earlier in the same session —
all gone from the composer. Reasoning: in BloomIQ's current usage profile
(typical teacher: ~30 questions × ~4 students), calibration almost never
reaches the 20-attempts-per-question threshold needed for statistical
signal, so the UI was pure cost. The genuinely useful signal it captured
(broken-question detection via negative discrimination) wasn't worth the
surface-area tax for the small fraction of teachers who'd see it.

### What was deliberately NOT removed

- `/api/qbank/calibrate` endpoint — orphaned but intact, in case we revive
- `lib/calibration.ts` and `lib/calibrationView.ts` — still used internally by `/api/rank/predict` and `/api/papers/generate` (no teacher UI)
- The `calibrated_*` columns in `question_bank` — left intact
- `/student/calibration/*` — completely separate feature (student ability estimation), unrelated to question calibration

So if we ever want to revive question calibration, the math, storage, and
endpoint are all still there — only the UI was peeled off.

### Hosting cost impact

Zero. The class-fit endpoint is one Supabase call per change of class /
selection (debounced 400 ms). Removing calibration UI also removes a
query (calibration map fetch) on every composer page load, so the page
gets marginally lighter at runtime.

### Files touched

- `app/api/teacher/class-fit/route.ts` (NEW, 161 lines) — service-role endpoint with `class_teachers` membership check.
- `app/teacher/quizzes/new/page.tsx` — added ClassFit state / effects / card; removed all question-calibration UI (Calibrate button, badges, TestStatsCard, related state and imports). File: 1284 → 989 lines (−11 KB).

### Catch-up since 2026-05-03 (not yet broken out into per-session entries)

A lot shipped between the 05-03 login split and today. Brief enumeration
so the log isn't missing context:

- **Exam-style generation** (`/api/student/quick-test`, `/api/generate`, `/student/generate`, `/teacher/generate`) — competitive-exam topic detection (CAT, JEE, NEET, GMAT, GRE, UPSC, IELTS, TOEFL, CLAT, BITSAT, SAT, GATE, NDA, CUET) with per-exam Bloom-level allowlist, a disambiguation banner ("CAT = Common Admission Test, NOT cat the animal"), section-grouped ordering for multi-section exams, and exam-aware numerical-percentage default.
- **Pick-how-many vs Pick-how-long** mode toggle on student + teacher generate pages, with non-uniform per-Bloom-level question counts derived from the time budget.
- **Auth-state-change interceptor** (`lib/supabase/client.ts`) — graceful handling of refresh-token failures + cross-device sign-out, redirects to `/login?reason=elsewhere&next=...` instead of leaving the user on a half-broken page with a console error.
- **Review-page textarea sizing** (`app/teacher/review/page.tsx`) — `rows=2` → `rows=6` / `rows=4` plus `field-sizing: content` so long question stems are readable in a single view.
- **Test-account seeding** — `scripts/seed-test-users.js` extended with platform admin (`ops@bloomiq.example.com`) and a pre-promoted Deputy Admin Head (`deputy@testacademy.example.com`).

### Test plan (manual, next session)

1. **Class-fit happy path** — pick a class with prior attempts on selected questions; expect "X of N have prior attempts here. Average: Y%."
2. **Class-fit fresh territory** — pick a class with no prior attempts; expect the "fresh territory" message.
3. **Class-fit auth gate** — confirm `403` when calling the API for a class the teacher isn't assigned to.
4. **Composer simplicity** — verify Calibrate button, badges, and the live stats card are all gone; only ClassFit card + existing flow remain.
5. **Variants modal still works** — open variants on a question, generate, save to bank.
6. **URL hydration still works** — `/teacher/quizzes/new?ids=...&topic=...&bloom=...` preselects correctly from `/teacher/generate`.

---

## 🆕 Earlier session — 2026-05-03 evening (Login flow split: /login/school vs /login/student)

Public sign-in surface separated by audience to stop the 5-tab login from
confusing both school people and indie learners. Modeled on Slack / Notion /
Linear's split between workspace and personal sign-in.

### What shipped

- **`/login` is now a picker** — two cards: *For schools* (links to
  `/login/school`) and *For independent learners* (links to
  `/login/student`). Each card has its own sub-CTA (school: "Talk to us"
  mailto, student: "Create an account" → `/signup?role=student`). The
  picker page is ~106 lines, no auth logic — pure routing.
- **`/login/school`** — three tabs (Admin Head, Teacher, School student),
  each with its own identifier label (work email vs. username), heading,
  and post-signin role gate. Honors a `?tab=` query hint so the
  post-signup teacher redirect can land them directly on the Teacher tab.
  School students skip MFA (kids without authenticator apps); Admin Head
  + Teacher tabs prompt for TOTP if the account has it.
- **`/login/student`** — single form for the indie self-pay learner.
  No tabs, email-only identifier (no username path — that's school-only).
  Role gate enforces `role==='student' && !is_school_student`. School
  students mistakenly typing here get a clear "use /login/school instead"
  error.
- **Post-signup redirect upgraded** — `/signup` now sends the user to the
  specialised login that matches their role:
  - Teacher signup → `/login/school?signedup=1&tab=teacher`
  - Student signup → `/login/student?signedup=1`
  - (Admin Head still invite-only via `/admin/onboard-school`.)
- **Platform admin (`/staff`) unchanged** — separate route, separate
  surface; staff never come through the public login flow.

### Why a picker instead of forcing one default

A redirect from `/login` → `/login/school` would have been one less click
but worse for indie students (who'd have to back out and click into
`/login/student`). The picker spends one click to put each user on the
right specialised page; that page is then narrow and unambiguous, with
context-correct footer copy and no confusing tabs.

### Hosting cost impact

Zero. Each new login page bundle is smaller than the old combined
`/login` (fewer tabs, less conditional logic). No new API endpoints, no
new database queries — same single Supabase `signInWithPassword` call as
before. Build time +1-2 s. Static-rendered, so production traffic hits
the CDN edge cache with no per-request function cost.

### Files touched

- `app/login/page.tsx` — converted from 672-line multi-tab form to a
  106-line picker.
- `app/login/school/page.tsx` (NEW, 605 lines) — three-tab school login.
- `app/login/student/page.tsx` (NEW, 442 lines) — single-form indie
  student login.
- `app/signup/page.tsx` — post-signup redirect now per-role.

Anything else in the codebase still pointing at `/login` (PublicNav, auth
gates in `/teacher` / `/school` / `/student` layouts, set-password page,
service-worker precache) keeps working — they all land on the picker
which routes them through.

### Test plan (manual, next session)

1. **Picker** — visit `/login` while signed out. See two cards. Each
   navigates to its specialised page.
2. **Indie student happy path** — `/login/student`, email + password,
   role gate accepts `role=student && !is_school_student`, lands on
   `/student`.
3. **Indie student wrong page** — try a school student account on
   `/login/student`. Expect "use /login/school instead" error.
4. **School Admin Head + Deputy** — both work on the Admin Head tab of
   `/login/school` (same `role=super_teacher`).
5. **School student** — username (no @) on the School student tab; no
   email format required; "Forgot password" hidden, replaced by "Ask
   your teacher" hint.
6. **Wrong tab** — try a teacher account on the Admin Head tab. Expect
   "this tab is for X only" error and signed-out state.
7. **Post-signup redirect** — sign up as Teacher, complete; expect
   redirect to `/login/school?signedup=1&tab=teacher` with the Teacher
   tab pre-selected and a green "Account created" banner.
8. **Post-signup redirect — student** — sign up as Independent Student,
   complete; expect `/login/student?signedup=1` with the green banner.
9. **Platform admin** — try a platform_admin account on either public
   login page. Expect "use /staff" error.

---

## 🆕 Earlier session — 2026-05-03 (Business continuity: Deputy Admin Heads + immediate primary reassignment)

The first hour of the session shipped Option 1 (school-plan renewal banner
for super-teachers — see the section below). The rest tackled a real
operational gap surfaced by the user: every school had exactly one Admin
Head and every class had exactly one primary teacher. If either went on
unplanned leave, that school or class was effectively frozen.

The fix is two complementary mechanisms — A1 + B3 — chosen over the heavier
options because they preserve the single-Head accountability model while
adding redundancy where it actually matters.

### A1: Deputy Admin Head

- **Migration `47_deputy_admin_head.sql`**:
  - Loosens `schools update` RLS so any super_teacher whose `school_id`
    matches the row can update — Deputies can now rename the school,
    upload the logo, edit settings.
  - Adds two SECURITY DEFINER helpers: `count_school_deputies(sid)` and
    `is_school_admin(sid)` for use by API and future RLS rules.
- **API `POST /api/admin/school/deputy`**:
  - Body `{ teacher_id, action: "promote" | "demote" }`.
  - Auth: caller must be the Head (the profile referenced by
    `schools.super_teacher_id`). Deputies cannot promote/demote each
    other — by design, to keep accountability clean.
  - Promote: target must currently be `role='teacher'` in the same
    school. Cap is 2 deputies per school, enforced in API.
  - Demote: target must currently be a Deputy (super_teacher in school
    AND not the Head). Reverts to `role='teacher'`; classes/quizzes
    intact.
- **API `GET /api/admin/school/deputy`**: returns Head + Deputies for
  any super_teacher in the school. Used by future UI surfaces.
- **`/school/teachers` UI rewrite**:
  - Lists Head + Deputies + regular teachers in one table with
    "Admin Head" / "Deputy" / "Primary" / "Co-teacher" badges.
  - Head sees "Make deputy" / "Step down" buttons (gated client-side
    too); Deputies don't.
  - "Business continuity" explainer card at the top with the cap
    (currently {N} of 2 deputies appointed).
  - Confirmation modal explains the implications of each action.
- **`/school` home**: hides the "Transfer Admin Head" button for
  Deputies (only the Head can name a successor; this isn't gating
  Deputy reach, just preventing a no-op flow). The `RenewBanner` and
  every other surface continues to render identically.

Permissions matrix:
- **Head**: full powers, including promote/demote deputies, transfer Head.
- **Deputy**: full powers EXCEPT promote/demote deputies and transfer Head.

Cap of 2 was a deliberate choice — more deputies dilute accountability,
and 2 is enough redundancy in any normally-staffed school. Easy to bump
later if needed.

### B3: Immediate primary-teacher reassignment

The `/school/classes` page already had primary-reassign UI, but it always
ran through the invite/accept flow — fine for normal onboarding, broken
for "Mr Sharma is unreachable for 6 weeks, I need Ms Patel running 9-A
right now."

- **API `POST /api/admin/classes/[id]/primary`** gained an `immediate: true`
  flag. When set:
  - Caller must be the Admin Head or a Deputy (super_teacher in the same
    school).
  - `teacher_id` is required (not email — the target must already be
    in-school for safety).
  - Demotes any existing primary to `role='co'` so they keep class
    access for when they return.
  - Upserts target into `class_teachers` with `role='primary'`.
  - Mirrors `classes.owner_id` to target.
  - Clears any pending primary invite.
- **`/school/classes` UI**: picking from the in-school dropdown now uses
  `immediate: true` automatically and triggers a confirm dialog with
  copy that explicitly mentions unplanned-leave coverage. Typing an
  email of someone outside the school still uses the gentler invite
  flow. Helper text spells out the difference.

Effect on a continuity scenario:

> Friday afternoon: primary teacher Mr Sharma calls in for an
> indefinite medical leave. Admin Head opens `/school/classes`,
> clicks **Change** on each of Mr Sharma's classes, picks Ms Patel
> from the in-school dropdown, confirms. Ms Patel is the primary on
> Monday morning; Mr Sharma is auto-demoted to co-teacher and keeps
> his data when he returns.

### Option B follow-up: Acting primary cover (migration 48)

User pushback on the original immediate-reassign behavior was sharp:
*"shouldn't the previous primary remain with primary privileges, he might
be back very soon within a week or so… it becomes administrative overhead
to keep reassigning."* Right call — demoting the canonical primary all the
way to co-teacher on every leave was too heavy.

Replaced the demote-to-co semantics with a third role on `class_teachers`:
**`'acting'`**. Migration 48 widens the role enum, adds a `ct_one_acting_per_class`
unique partial index, and updates `is_class_primary()` /
`is_primary_for_student()` to accept both `'primary'` and `'acting'` —
which means the 30+ RLS policies that gate class-management actions Just
Work for acting cover with zero per-policy edits. A new
`is_class_canonical_primary()` helper is available for the rare UI cases
that need to distinguish title-holder from cover.

API shape on `POST /api/admin/classes/[id]/primary`:
- `{ teacher_id, immediate: true }` now sets up an **acting cover** rather
  than a hard reassign. Canonical primary stays untouched (keeps title +
  `owner_id`); the picked teacher gets `role='acting'`.
- New `{ end_acting: true }` mode deletes any acting row for the class.
  Idempotent. Reserved to school admins (Head + Deputies).

UI on `/school/classes`:
- The primary-teacher cell now stacks the canonical primary on top and the
  "🛡 Acting cover" pill below when one is active.
- The picker confirm dialog explains the cover semantics: *"Mr Sharma stays
  as the primary teacher and keeps full access. Ms Patel gets equivalent
  privileges as a temporary cover. When Mr Sharma returns, click 'End
  acting cover' — no need to re-assign anyone."*
- An **End cover** button appears next to the row when an acting row exists.
  One click ends the cover; the canonical primary is unaffected.

Net effect on the leave scenario: Mr Sharma → leave → admin picks Ms Patel
from dropdown (one click per class, sets acting cover) → Ms Patel runs the
class with full primary-level powers → Mr Sharma returns → admin clicks
**End cover** (one click per class) → state restored to exactly what it was
before. No demotion, no re-promotion, no privilege churn for Mr Sharma
between leave and return.

### File-tool divergence regression

Same disk-vs-cache issue as 2026-05-02 evening reappeared: several
`Edit` calls succeeded according to the tool but truncated the file
on disk halfway through. The recovery pattern (read full intended
state via `Read`, rewrite the disk file in one shot via bash heredoc)
is becoming the routine fallback. Files repaired this way today:
`primary/route.ts`, `school/page.tsx`, `school/teachers/page.tsx`,
`school/classes/page.tsx`. New files (`deputy/route.ts`,
`migration 47`) landed cleanly via `Write`.

### Polish + follow-ups (shipped same session, after main push)

Small refinements that surfaced from manual exercise of the just-shipped
Deputy + acting-cover features:

- **`/api/admin/school/transfer` tightened** — was previously satisfied by
  any super_teacher, which meant a Deputy could curl-bypass the hidden UI
  and seize the Head role. Now does a second check against
  `schools.super_teacher_id === user.id` in addition to
  `role === 'super_teacher'`, with a Deputy-specific 403 message.
  Closes the gap parked at first ship of A1.

- **Login page Admin Head footer fixed** — the "New here? Create an
  account" link previously pointed every tab at `/signup`, but `/signup`
  intentionally hides the Admin Head role (provisioned by BloomIQ via
  `/admin/onboard-school`). Replaced with a "Talk to us" mailto on the
  Admin Head tab, "Platform admin accounts are invite-only" line on the
  platform tab, and the original signup link kept on Teacher / Student
  tabs. Removes the dead-end click that was confusing test users.

- **`/school/classes` action button — state-aware copy** — "Change" was
  vague; admins didn't know it could either add an acting cover or
  initiate a permanent replacement. Now the button reads:
  - **Assign primary** (no primary, no invite)
  - **Re-invite** (pending invite outstanding)
  - **Cover** (primary set, no acting cover)
  - **Change cover** (acting cover already in place; paired with a red
    "End cover" button on the same row)

- **`scripts/seed-test-users.js` extended** — was producing 6 test users
  (school admin, primary, co, 3 students, indie students). Now seeds
  10 users covering every role surface added today:
  - Platform admin (`ops@bloomiq.example.com`) — logs in at `/staff`
  - Admin Head + pre-promoted Deputy (`deputy@testacademy.example.com`)
    so the user can log in as a Deputy out of the gate without first
    clicking through the promote flow
  - The seed script's credentials table at the end now lists all 10 with
    role, login surface, and landing page. `--reset` wipes everything
    cleanly for repeat runs.

- **Bootstrapping a test Admin Head** — added a "First-time account
  creation & login — by role" subsection with two SQL blocks for dev:
  one that promotes any user to super_teacher of a fresh school
  (confirms email, generates a join code, sets `school_id` + role), one
  that resets a forgotten password via `crypt(...)`. Production path
  (the platform-admin invite flow) is unchanged.

### Test plan (manual, next session)

1. **Promote / demote happy path** — Head promotes T1; T1 sees the
   Admin sidebar; T1 cannot see "Transfer Admin Head" or "Make
   deputy" controls; Head demotes T1; T1's classes intact.
2. **Cap enforcement** — Head promotes T1, T2; "Make deputy" disabled
   on row T3 with the title tooltip explaining the cap.
3. **Deputy can rename school + upload logo** — RLS loosening verified.
4. **Deputy cannot transfer Head** — the button is hidden, AND the
   server-side check now verifies `schools.super_teacher_id === auth.uid()`
   in addition to `role === 'super_teacher'`. A Deputy who curl-POSTs the
   transfer endpoint gets a 403 with a Deputy-specific message.
5. **Acting cover (Option B)** — Head clicks **Cover** on Ms Patel's row
   on a Mr Sharma class; confirm dialog explains canonical primary stays
   primary; Ms Patel appears with the "🛡 Acting cover" pill below Mr
   Sharma's name; both can act (RLS via widened `is_class_primary`).
6. **End acting cover** — Head clicks **End cover**; the acting pill
   vanishes; Mr Sharma is the only entry, unchanged from before the cover.
7. **Email path still invite-based** — typing a non-school email still
   creates a pending invite; confirm copy explains the gentler path.
8. **Login Admin Head footer** — on the Admin Head login tab, the footer
   reads "Setting up a new school? Talk to us..." with a mailto, not a
   "Create an account" link to `/signup`.

---

## 🆕 Earlier session — 2026-05-03 morning (School-plan renewal banner for super-teachers)

Small but important follow-up to yesterday's billing pipeline work.
Independent paying students already saw a 7-day-warning + post-expiry
banner on `/student` (driven by `RenewBanner` and `useFeatureAccess`).
Super-teachers had no equivalent surface, which meant a school plan
could lapse silently while the admin head sat on the dashboard.

### What changed

- **`components/RenewBanner.tsx`** — added an optional `schoolName?: string | null`
  prop that flips the banner into "school-admin mode":
  - Copy switches to "Your school's plan expires/expired …" instead of
    "Your subscription …".
  - The Razorpay "Renew now" button is replaced by a `mailto:support@bloomiq.app`
    link with subject `Renew school plan — {schoolName}` and a pre-filled
    body containing the plan slug + expiry date. School plans are billed
    offline so this is the renewal path that actually works.
  - Without `schoolName`, a `source === "school"` subscription is still
    suppressed (school students never see the banner — they have nothing
    to do about renewal).
- **`app/school/page.tsx`** — imports `RenewBanner` and `useFeatureAccess`,
  renders the banner immediately under the school header (above the join
  code card) once `access` finishes loading, passing `schoolName={school?.name}`.

### Why a banner and not an email cron (Options 2/3 deferred)

Option 1 (this banner) was the cheapest and most visible surface — every
super-teacher visit to `/school` either sees it or doesn't, which is enough
to prevent silent lapses. Two heavier options were considered and parked:

- **Option 2** — reminder email cron (T-7 / T-1 / T+0). Requires an
  outbound email lane we don't have wired yet.
- **Option 3** — mid-session expiry toast for users whose plan crosses
  `expires_at` while they're on a page. Needs a global listener that
  re-runs the real-time expiry check on a timer; not worth it until we
  see a real complaint.

Real-time expiry gating already happens in `useFeatureAccess` (compares
`expires_at` to `Date.now()` on every load) and in `requireFeature()`
server-side, so feature access flips off the moment a plan expires —
the new banner only adds visibility, not enforcement.

---

## 🆕 Earlier session — 2026-05-02 evening (Role-aware shells, scope separation, Quiz→Test rename, upgrade-extension billing, retake/extension flow)

A long session. Touched almost every dashboard, every sidebar, the
billing pipeline, RLS-adjacent admin queries, and added two new
multi-role pages plus a major UI rename.

### What shipped (high-level)

1. **Role-aware Sidebar** for all five role surfaces — teacher / school
   student / independent student / super-teacher / **platform admin** —
   with grouped headers (Class / Live / Practice; Roster / Insights /
   Assist; Classes / Content / Insights / Assist; Do / Look back).
   Platform admin moved off its old top-bar layout onto the same
   left-sidebar shell. Each role's home, profile, help, and security
   are reachable identically.

2. **`/help` page (role-aware)** — collapsible FAQ-style layout, native
   `<details>` elements, role-tailored topics for teacher and
   super-teacher, placeholder for student. Accessible via "Help" link
   in every sidebar bottom nav.

3. **`/settings/profile` page (role-aware)** — universal profile with
   sections per role: name + exam goal (independent student); name +
   classes-taught (teacher); school identity + join code copy + logo
   upload (super-teacher); read-only roster (school student).
   Back-to-dashboard link routes per role. Initial-letter avatar
   replaced by school logo for super-teacher when one is uploaded.

4. **Class scope vs personal practice — strictly separated**:
   - `lib/studentScope.ts` (new): `loadClassQuizIds()` and
     `loadClassQuizIdsForClasses()` are the single source of truth for
     "what counts as class scope".
   - School student dashboard: stats trio + BloomHero now class-only;
     personal practice has its own home at `/student/tests`.
   - `/student/progress`: school-student variant filters to class
     attempts only. Title flips to "My Class Progress".
   - **Five school admin queries patched** (`/school/page.tsx`,
     `/school/students/page.tsx`, `/school/classes/page.tsx`,
     `/school/reports/page.tsx`) — each now scopes attempts by
     class-assigned quiz_ids, so personal-practice attempts no longer
     inflate roll-ups.

5. **Quiz → Test rename across UI** (URL slugs and DB unchanged):
   teacher sidebar item, recent-tests card, stats labels, focus card
   copy, `/teacher/quizzes` page title and buttons, `/teacher/quizzes/new`,
   `/teacher/quizzes/[id]` (assign-test modal), analytics column
   header, reports card titles + descriptions + button labels, school
   admin column headers, school student "Class quizzes taken" stat,
   school coach blurb. **Live Quiz / Live class quiz preserved** per
   product call (it's quiz-flavoured by nature).

6. **Lock-badge tier label leak fixed**: `findUnlockingTier(featureKey,
   ladder?)` now takes a ladder filter so independent students never see
   "School Pilot" labels and school students never see "Premium" labels.
   Three call sites updated to pass `isSchool ? "school" : "personal"`.

7. **Sidebar single-click bug fix**: replaced JS `onMouseEnter`/`onMouseLeave`
   that mutated `e.currentTarget.style.background` with a pure CSS
   `.sidebar-link` class in globals.css. Cleaner, faster, no double-click
   needed.

8. **Teacher feature gate behind school**: layout-level redirect — every
   `/teacher/*` sub-route bounces back to `/teacher` until the teacher
   joins a school. Home itself shows ONLY the welcome strip + Join card
   when `school_id` is null.

9. **Subscription upgrade — Model B (extension)**:
   `app/api/checkout/verify/route.ts` now anchors the new term off
   `max(now, oldExpiresAt)` instead of always `now`. Pay full new-plan
   price, keep unused time. No schema change.

10. **Pre-due-date extension request** (Scenario 2 of the missed-quiz
    flow): new `<ExtensionRequestButton />` on each upcoming assigned
    card on the school student dashboard. Reuses
    `quiz_retake_requests` table. Teacher decides via existing
    `<TeacherRetakeRequests />`.

11. **Retake/extension approval — custom date+time**: decision endpoint
    accepts optional `new_due_at`. Teacher's panel now has a
    `<datetime-local>` input pre-filled with +7 days, fully editable
    before approve.

12. **Assign-test UX polish on `/teacher/quizzes/[id]`**: due date+time
    is mandatory now (no more optional), duplicate-assignment guard
    asks for confirmation before inserting a second `(quiz, class)` or
    `(quiz, student)` row, modal is `max-h:calc(100vh-2rem)` with
    `overflow-y-auto` so the date picker no longer hides the Assign
    button.

13. **Retake/extension surfacing in focus card**: `stats.retakePending`
    now feeds the focus card priority (rose tone, top of list above
    review queue). The TeacherRetakeRequests panel moved lower with
    `id="retake-requests"` anchor for the focus-card scroll-to.

14. **Live class quiz** moved out of the assignment dashboard into a
    dedicated sidebar destination at `/student/live` for school
    students; teacher live-host page got an "Engagement-only — does
    NOT count toward class stats" notice.

15. **School logo upload** for super-teachers — migration 46
    (`schools.logo_url`, public `school-logos` bucket, RLS policies
    scoped by school_id path prefix). Surfaces in profile hero now;
    sidebar header / school home pending.

16. **Per-teacher email column** on `/school/teachers` — new GET
    handler on `/api/admin/school/teachers` resolves email via the
    service-role admin client (auth.users), merged into the roster
    table.

### Migrations to apply (in order)

| File | Purpose |
|---|---|
| `46_schools_logo_url.sql` | Adds `schools.logo_url` text column + creates public `school-logos` storage bucket + RLS policies (super-teacher of THIS school can write to `<school_id>/...` only) |

(No other migrations from this session.)

### Files added this session

- `lib/studentScope.ts` — class-scope helpers
- `app/help/page.tsx` — role-aware help center
- `app/settings/profile/page.tsx` — universal profile with role-tailored sections
- `app/student/live/page.tsx` — sidebar destination for Live Quiz join
- `app/student/train/page.tsx` — Train index for independent students
- `app/student/diagnose/page.tsx` — Diagnose index for independent students
- `components/LiveJoinCard.tsx` — 6-char code entry card
- `components/ExtensionRequestButton.tsx` — pre-due-date extension request UI
- `supabase/migrations/46_schools_logo_url.sql`
- `docs/QA_SCENARIOS_PENDING.md` — extension/upgrade test scenarios for next session

### Files heavily modified

- `components/Sidebar.tsx` — five-role union, role→home + role→label maps, grouped nav for all roles, CSS hover, Profile/Help/Security/Sign out bottom nav
- `app/teacher/page.tsx` — friendly first-name helper, focus card with retake-priority, stats include retakePending, school-gate render
- `app/teacher/layout.tsx` — school-membership gate redirects sub-routes
- `app/admin/layout.tsx` — slimmed down to use Sidebar component
- `app/teacher/quizzes/[id]/page.tsx` — mandatory due, duplicate confirm, scrollable modal
- `app/teacher/reports/page.tsx` — Quiz→Test labels (including the StatCard `label="Tests"` prop fix)
- `app/student/page.tsx` — class-scope filter, BloomHero compute path, AssignedRow extension state, pre-due extension button render
- `app/student/progress/page.tsx` — class-scope filter, "My Class Progress" title
- `app/student/tests/page.tsx` — practice stats trio + BloomHero header, no class-quiz mixing
- `app/settings/profile/page.tsx` — extended with logo upload + back link
- `app/school/page.tsx`, `/school/students/page.tsx`, `/school/classes/page.tsx`, `/school/teachers/page.tsx`, `/school/reports/page.tsx` — class-quiz scope filter on five attempts queries
- `app/api/admin/school/teachers/route.ts` — added GET handler for emails
- `app/api/checkout/verify/route.ts` — Model B extension expiry
- `app/api/teacher/retake-requests/[id]/decision/route.ts` — accepts custom `new_due_at`
- `components/TeacherRetakeRequests.tsx` — date+time picker per request
- `lib/featureAccess.ts` — `findUnlockingTier(key, ladder?)` filter
- `app/globals.css` — added `.sidebar-link` / `.sidebar-link--active` rules
- `README.md` — added "First-time account creation & login — by role" section

### Resume tomorrow — pickup checklist

1. **Run migration 46** on Supabase (`supabase/migrations/46_schools_logo_url.sql`) — schools.logo_url column + storage bucket + RLS policies.
2. **Run `npm install`** locally — `package.json` had to be restored from git after a truncation; `exceljs` and other deps are listed but might not be in `node_modules` until install.
3. **Open `docs/QA_SCENARIOS_PENDING.md`** — five scenarios queued for testing: subscription upgrade extension (U + 3 variants), teacher gate (T), lock-badge ladder (L), school admin scope (S), plus smoke checks. Includes a SQL quick-seed for skipping Razorpay if you want to test just the upgrade math.
4. **Open `app/teacher/page.tsx.tmp` and `*.tsx.__rewrite` files**: 0-byte residue from the safe_write helper. Filesystem won't let me unlink them inside the sandbox, but on Windows you can `Remove-Item *.tsx.__rewrite, *.tsx.tmp` to clean the tree.
5. **Future enhancements parked but not started**:
   - Email-notification (option C) for retake/extension requests — needs SMTP/Resend wiring
   - School logo on sidebar branding row + parent-share pages (currently only renders in profile hero)
   - Auto-detect active live session for student's class (currently manual code entry only)
   - `/help` topics for student / platform admin (placeholders today)
   - Plan badge with "Renews in N days" copy
6. **Pending before this session that's still pending**: Phase 4b (parent-email monthly digest cron) — deferred from much earlier; needs email-infra decision.

### Patterns documented for future maintainers

- **File-tool / Python `open(p,"w").write()` truncation in this workspace**: silent data loss on large writes. Workarounds that consistently work: (a) bash heredoc for fresh files, (b) `sed -i` for surgical in-place edits, (c) Python `safe_write(path, content)` helper that stages to `path.__rewrite` then `cat tmp > path` and verifies the read-back matches. The helper is reproduced inline in any session that needs it.
- **Verification step**: `tail -c 5 file | od -c` after every write — confirms file ends with `}` / `);` rather than mid-content. Caught multiple truncations this session.
- **Class-scope rule** (codified across the app now): a school student's official numbers live in `quiz_attempts` filtered by `loadClassQuizIds()`. Personal practice is everything else. Teachers and school admins see only the class side; students see both, kept in physically separate UI surfaces.

---

## 🕘 Earlier session — 2026-05-01 evening (Cohort pacing benchmarks + rank-prediction disclaimers + RLS recursion fix + test-user seed)

A wide-ranging session covering one student-facing feature (Premium Plus only),
one product-honesty pass, one production bug fix, and one developer tool.

### What shipped

**1. Per-question pacing + cohort benchmarks (new feature, gated to Premium Plus + School Plus).**

After a quiz, the results page now shows a per-question table: your time
per question, plus — for entitled students — the **cohort median** for
that exact question and a **fast / on-pace / slow** chip. Free/Premium
students see their own times; the cohort column is locked with a clear
upgrade CTA. This is the third "metacognition" feature alongside
Misconception Detective and Confidence Calibration.

Three render modes on the results page:

  - **Opted out of tracking** → friendly opt-in CTA pointing at Settings.
  - **Tracking + entitled** → full table with cohort median + speed chips.
  - **Tracking + not entitled** → own-time table, cohort column shows a
    🔒 chip that links to /pricing.

Outlier guards baked into the cohort baseline:

  - Per-question time capped at 10 minutes on submit (single-question
    "left tab open" sessions can't poison the cohort).
  - Aggregation query filters to `1s ≤ time ≤ 10min` — drops misclicks
    and tab-switches.
  - Median (not mean) so a few inflated outliers can't move the baseline.
  - Minimum 5 cohort samples before the median is shown (below that the
    UI says "need N more samples"). Avoids early-stage noise on questions
    only one student has answered.

**2. Consent-based tracking.**

A one-time modal at the start of a quiz asks "Track your time per question?"
with **Yes / Not now**. Both buttons persist to a new `profiles.track_question_time`
column so we never ask twice. Students who decline get NULL written to
`time_taken_ms` on every row — they don't see their own pacing data, AND
they don't pollute the cohort baseline. The CTA in the results page links
to `/settings` for later flip (the actual toggle UI on /settings is a
follow-up — see backlog).

**3. Tab-visibility pause + back-button revisit accumulation.**

The quiz page now uses the Page Visibility API. Alt-tab / minimize /
device-sleep flushes the running question's elapsed time and stops counting;
returning starts the timer fresh on whatever question is now visible.
Back-button navigation within the quiz is also handled — revisits ACCUMULATE
onto a question's total (cognitive time across all visits, not just the
first reading). Forward navigation, in-app Previous, submit, and time-out
auto-submit all flush correctly. The one residual gap is a full page
refresh mid-quiz losing the in-memory tracker — deferred to a v2 with
server-side periodic persistence.

**4. Rank predictor — honest disclaimers + confidence band.**

The `/student/rank` page used to present the Predicted AIR as a precise
number (e.g. "~242,000"). It now shows a **confidence band** (e.g.
"180,000 – 290,000") computed by combining binomial sampling error of the
test score with a small ±2pp baseline-drift allowance — about a 95% band.
Three new disclosure layers:

  - **Test-length confidence chip** (red/amber/yellow/green) that adapts
    to the number of questions: <20 questions = "Low confidence — midpoint
    should not be taken seriously"; 120+ = "Higher confidence — band is
    tight."
  - **Symmetric warnings** so neither direction inflates the student:
    "If the number looks great" (don't celebrate yet) and "If it looks
    rough" (a single mock isn't your ceiling).
  - **Collapsible "How this is calculated"** with three sub-sections:
    The model, What we assume, and **What this number does NOT account for**
    (paper difficulty, section normalization, negative marking, tie-breaking,
    cohort variance, mock question quality, test-day form).

The API also returns the model name + assumptions + score margin so the
UI can render them honestly. Cohort baselines are still rough order-of-
magnitude figures — explicitly called out in the UI now.

**5. RLS infinite-recursion fix on quizzes / quiz_assignments.**

Migration 35 had introduced a `quizzes read for assigned` policy whose
EXISTS clause queried `quiz_assignments`. Migration 31's `assign select`
policy on `quiz_assignments` queried `quizzes` right back. Postgres
detected the cycle and threw `infinite recursion detected in policy for
relation "quizzes"` on any flow that touched quizzes — including
`/student/adaptive-practice` ("Could not save questions: infinite
recursion..."). Fixed by encapsulating the cross-table membership check
in a `SECURITY DEFINER` helper (`is_quiz_assigned_to_me(qid)`) — same
pattern migration 04 already uses for `is_class_teacher`,
`is_class_primary`, `is_super_for_school`. Standard RLS-cycle break.

**6. Lock-stealing noise on the Supabase auth client.**

Replaced `@supabase/auth-js`'s navigator-lock with a tiny in-process
promise-chain mutex in `lib/supabase/client.ts`. React Strict Mode in
dev double-fires effects; two `getUser()` calls would race for the lock
and one would log `"Lock '...' was released because another request stole
it"`. Harmless in behaviour (the inner promise still resolves) but it
surfaces in Next.js's dev overlay as a "Runtime Error". The new
`processLock` serializes auth calls within the tab — same effective
behaviour as the navigator lock for this app, no cross-tab fanciness,
no noisy logs. Production isn't affected (Strict Mode doesn't double-fire
there), but dev is now quiet.

**7. Test-user seed script — `scripts/seed-test-users.js`.**

Creates a complete, ready-to-test org tree in one command:

  - 1 school (`Test Academy`) + 1 admin (`super_teacher`)
  - 1 primary teacher + 1 co-teacher, both attached to a class
  - 1 class with a `class_teachers` row each for primary + co
  - 3 school students (`ananya`, `kabir`, `diya`) enrolled in the class
  - 2 free independent students
  - 1 Premium independent student (subscription bound to `premium_monthly`)
  - 1 Premium Plus independent student (subscription bound to `premium_plus_monthly`)

All accounts use password `TestPass123!`, all skip Supabase email
confirmation. Idempotent — `--reset` wipes prior runs. Prints a
credentials table at the end. The paid-tier subscriptions get a 1-year
`expires_at` so they don't expire mid-test. Override that with
`SEED_PAID_DAYS=30` if you want to actually test renewal flows.

The script intentionally uses `upsert` for `class_teachers` (a DB trigger
auto-inserts the primary row from `classes.owner_id`, so a plain insert
would hit a duplicate-key error) and a fall-back UPDATE-then-INSERT for
`subscriptions` (PostgREST can't always see the inline UNIQUE on
`subscriptions.user_id` for ON CONFLICT to work). Both quirks are
documented inline in the script.

### Migrations to apply (in order)

  - `38_fix_quizzes_rls_recursion.sql` — `is_quiz_assigned_to_me()` helper, replace recursive policy
  - `39_attempt_answers_time_taken_ms.sql` — per-question timing column + partial index
  - `40_profiles_track_question_time.sql` — student consent flag (NULL/TRUE/FALSE)
  - `41_grant_cohort_benchmarks_to_premium_plus.sql` — append `cohort_benchmarks` to `premium_plus_monthly`, `premium_plus_annual`, `school_plus`

Apply via Supabase Dashboard → SQL Editor (paste each file, run) or
`supabase db push` if you have the CLI linked.

### Files added / changed

**New:**

  - `app/api/student/question-benchmarks/route.ts` — cohort-median API,
    server-side feature gate, only computes aggregation when entitled
  - `lib/featureAccess.server.ts` — server-side `requireFeature(userId, key)`
    (the docstring in `lib/featureAccess.ts` had referenced this for
    months but it had never been written — now it exists)
  - `scripts/seed-test-users.js` — see §7
  - 4 migration files listed above

**Changed:**

  - `app/api/rank/predict/route.ts` — `airBand()` helper + model metadata in the response
  - `app/student/rank/page.tsx` — confidence chip, symmetric warnings, "what we don't account for" disclosure
  - `app/student/quiz/[code]/page.tsx` — per-question timing refs, consent modal, tab-visibility pause, idx-change flush effect
  - `app/student/results/[id]/page.tsx` — new "Per-question pacing" section, three render modes
  - `lib/features.ts` — added `cohort_benchmarks` (category: metacognition)
  - `lib/supabase/client.ts` — `processLock` replaces navigator lock

### Gating recap

| Tier | Sees own time | Sees cohort median |
| --- | --- | --- |
| Free / anon | If consented | 🔒 (Premium Plus CTA) |
| Premium | If consented | 🔒 (Premium Plus CTA) |
| **Premium Plus** | If consented | ✅ |
| School Pilot / Standard | If consented | 🔒 (Premium Plus CTA) |
| **School Plus** | If consented | ✅ |
| Declined consent | — | — (Settings opt-in CTA) |

### Open follow-ups

  - **Settings toggle for `track_question_time`.** The CTA on results
    page links to `/settings`, but the toggle UI itself isn't there
    yet. ~30 lines.
  - **Server-side periodic timing persistence.** Page-refresh mid-quiz
    loses the in-memory tracker. Acceptable for v1 (95th-percentile case),
    but worth a v2 that pre-creates `attempt_answers` rows at quiz start
    and upserts `time_taken_ms` every 30 seconds.
  - **Premium Plus prices are still placeholders** (₹199 / ₹1999 from
    migration 26). Platform admin should confirm before shipping the
    cohort-benchmarks feature publicly.
  - **Cohort baseline seeding.** Until 5+ Premium Plus students attempt
    the same question, the cohort median doesn't render. The UI shows
    "need N more samples" — fine messaging, but the feature gets
    meaningfully better as the cohort fills out.

### Resume tomorrow — pick-up checklist

When you sit back down, work through these in order:

**Verify last session landed correctly**

  - [ ] `git pull origin main` (in case any collaborator commits arrived overnight).
  - [ ] `git log --oneline -3` should show `51ac8d9` or its successor at the
        top (the cohort-benchmarks + rank-disclaimers + RLS-recursion-fix
        commit pushed at end of last session).

**Apply pending migrations to Supabase** *(this is the gating step — none of the new features will work until this runs)*

  - [ ] Open Supabase Dashboard → SQL Editor → run, in order:
        - `supabase/migrations/38_fix_quizzes_rls_recursion.sql`
        - `supabase/migrations/39_attempt_answers_time_taken_ms.sql`
        - `supabase/migrations/40_profiles_track_question_time.sql`
        - `supabase/migrations/41_grant_cohort_benchmarks_to_premium_plus.sql`
  - [ ] *Or* run `supabase db push` if the CLI is linked to the project.
  - [ ] After applying 38, the "Could not save questions: infinite
        recursion" error on `/student/adaptive-practice` should be gone —
        smoke-test by trying to generate one practice set.

**Test the new features end-to-end**

  - [ ] `node scripts/seed-test-users.js --reset` (regenerates the org tree
        with all 8 personas).
  - [ ] Sign in as `premium.student@example.com` → take a short quiz →
        consent modal appears → answer "Yes, track" → submit → results
        page shows your per-question times + locked cohort column with
        Premium Plus CTA.
  - [ ] Sign in as `premiumplus.student@example.com` → same flow → results
        page shows full cohort columns. Median will say
        "need N more samples" until 5+ different students attempt the
        same questions; that's expected.
  - [ ] Click "Not now" on the modal as a fresh user → verify the
        results page shows the opt-in CTA card instead of the table.
  - [ ] Take a quiz, then alt-tab for ~30s → return → submit. Verify
        the alt-tab time didn't get counted on the question that was
        visible (visibility pause).

**Optional fast-follows (any of these is a good ~30-min standalone task)**

  - [ ] Build the `/settings` toggle for `track_question_time` so
        students can flip without re-prompting via a quiz.
  - [ ] Have `seed-test-users.js` optionally bind the seeded school to
        `school_plus` (one extra subscription update + flag) so the
        school-tier cohort path can be tested without manual SQL.
  - [ ] Confirm Premium Plus pricing with whoever's on the business
        side; replace the ₹199/₹1999 placeholders in the active plan
        rows via the platform-admin UI.

**Big-rock items still parked**

  - 2FA / TOTP enrollment for `platform_admin` accounts (from the
    earlier 2026-05-01 login-loop session — not started).
  - Server-side periodic timing persistence to survive mid-quiz page
    refreshes (this session, deferred).
  - `lib/auth/landingFor.ts` central helper to prevent future "we
    forgot platform_admin in this redirect" bugs (from the login-loop
    session).

---

## 🆕 Earlier session — 2026-05-01 (Login loop hotfix: platform-admin redirect)

A short, focused hotfix session prompted by a real-user complaint —
Vipin couldn't log in with `kmvipin@gmail.com` even after resetting
his password. The screen kept bouncing back to `/login`. He'd seen
this multiple times, which is a signal we should have caught earlier.

### Symptom

Sign-in form submits successfully, then the user is dumped back on
`/login`. Password reset doesn't help because the password was never
the problem.

### Root cause

`app/login/page.tsx` resolved the post-login landing page from
`profiles.role` only:

```ts
const home =
  prof?.role === "teacher"       ? "/teacher" :
  prof?.role === "super_teacher" ? "/school"  :
                                   "/student";
```

`platform_admin` is a **flag**, not a role. Internal-staff accounts
(including the bootstrap admin) often have `role = null` and
`platform_admin = true`. The code's catch-all sent them to `/student`,
where `app/student/layout.tsx` re-fetched the profile, saw
`role !== "student"`, and redirected back to `/login`. Loop.

The signup page (`app/signup/page.tsx`) and the set-password page
(`app/auth/set-password/page.tsx`) both check `platform_admin`
correctly. **Login** was the one place that didn't — easy to miss
because internal staff are a single-digit population and the bug
doesn't surface until exactly that user tries to log in.

### Fix

`app/login/page.tsx`:

  - Added `platform_admin` to the `profiles` select.
  - Reordered the home resolution so `platform_admin` is checked
    first → `/admin/onboard-school`, then `super_teacher` → `/school`,
    then `teacher` → `/teacher`, then `student` → `/student`.
  - Added an explicit error path for "signed in but no recognised
    role and no admin flag" — surfaces a clear message instead of
    silently bouncing forever. Most likely cause: a missing `profiles`
    row.

### Conversation note — separate hidden admin login?

Vipin asked whether platform admins should have a non-public login
page. Short answer parked in this README so it doesn't get lost:

  - **Today:** one shared `/login`, role-based redirect. Standard for
    GitHub / Stripe / Linear / Vercel — security through obscurity
    isn't security.
  - **What a hidden admin URL actually buys:** keeps admin auth
    attempts out of the same form bots are scanning, and gives a
    clean place to layer in extra friction (longer 2FA window, IP
    allowlist warning, captcha). Defense-in-depth, not security.
  - **What actually protects the platform admin:** strong password,
    2FA/MFA, IP allowlisting, audit logs. Park "hidden admin URL"
    behind those — it's cosmetic until 2FA is wired up.

### Backlog from this session

  - Wire up 2FA / TOTP enrollment for `platform_admin = true`
    accounts (Supabase has MFA primitives; we just don't surface
    them yet).
  - Once 2FA is in, optionally add a `/staff` (or similar
    non-obvious path) admin login and have public `/login` refuse
    platform-admin accounts with a generic "incorrect credentials"
    so existence isn't leaked.
  - Audit other "redirect after auth" surfaces (`signup`,
    `set-password`, sidebar logout flows) for any other role
    branch that forgets `platform_admin`. The current set is
    consistent post-fix, but adding a new role tier in the
    future is a regression risk — consider a single
    `lib/auth/landingFor.ts` helper used everywhere.

---

## 🆕 Earlier session — 2026-05-01 late night (Plans simplification: drop versioning, edit-in-place catalogue)

A focused architectural refactor. The Plan-Admin module shipped earlier
in the day was over-engineered for BloomIQ's actual business model —
versioned rows with grandfathering snapshots, draft → submit → approve
workflow, plan_audit log. Realistic operational consequence: every
price tweak created a new plan row, the table grew without bound, and
the admin would soon be staring at 20+ rows trying to figure out which
was current vs legacy.

Caught at design review by Vipin: *"will create utter confusion."*
Yes. Better to fix now than after 30 plan rows.

### What changed conceptually

The plans table is now a **flat, stable catalogue of SKUs**. One row
per product (Free + Premium Monthly/Annual + Premium Plus Monthly/Annual
+ 3 school tiers = 8 rows, ever). You **edit in place** — no drafts,
no submit, no approve, no versions.

What gets locked vs live for existing subscribers:

  - **Price** — locked at purchase. The new
    `subscriptions.price_paid_paise` column captures what the customer
    paid for THIS term. Their price stays put till `expires_at`. On
    renewal, a new subscription gets the then-current price.
  - **Features** — always live. If you add a feature to Premium today,
    every Premium subscriber sees it on next page load. This matches
    Spotify / Netflix / Notion behavior — every consumer SaaS works
    this way and customers expect it.

Removing a feature is the dangerous direction (existing subs lose access
the moment you save). The edit page warns when there are active
subscribers; the right way to "remove" something is to add it to a new
SKU and let users migrate, not yank it from under their feet.

### Migration 30 — what it actually does

  1. Repoints any subscription on a non-active plan version to the
     surviving 'active' version with the same slug.
  2. Deletes archived/draft/pending plan rows — they're no longer needed.
  3. Drops the `plan_audit` table and all the workflow infrastructure
     columns from `plans`: `status`, `effective_from`, `effective_to`,
     `created_by`, `approved_by`, `approved_at`. Drops `plans_two_eyes`
     check + the `plans_one_active_per_slug` partial index.
  4. Adds plain `UNIQUE(slug)` — exactly one row per SKU.
  5. Adds `subscriptions.price_paid_paise integer NOT NULL DEFAULT 0`
     and backfills from each subscriber's current plan price.
  6. Replaces the public-read RLS policy with one that exposes every
     row (no more `status='active'` filter).

### Code refactored

  - `app/api/admin/plans/route.ts` — GET returns flat catalogue with
    subscriber counts; POST creates a brand-new SKU (rare). No status,
    no clone_from, no audit writes.
  - `app/api/admin/plans/[id]/route.ts` — PUT edits in place (no
    "draft only" guard); DELETE refuses if any subscription points at
    the SKU.
  - `app/api/admin/plans/[id]/transition/route.ts` — stubbed to return
    410 Gone so any caller surfaces loudly.
  - `app/api/checkout/route.ts` + `app/api/checkout/verify/route.ts` —
    no more `.eq("status", "active")` lookup; verify route locks
    `subscriptions.price_paid_paise = order.amount` at purchase.
  - `app/api/pricing/active-plans/route.ts` and
    `app/api/admin/onboard-school/route.ts` and
    `app/api/admin/schools/[id]/set-plan/route.ts` — drop status filter.
  - `app/admin/plans/page.tsx` — clean catalogue: tier-grouped cards,
    edit-on-click, subscriber count badge, "edit-in-place" guidance.
  - `app/admin/plans/[id]/edit/page.tsx` — single-form editor with one
    Save button + one Delete button. No submit/approve/reject. Clear
    "X active subscribers will see your change" warning.
  - `app/admin/plans/new/page.tsx` — minimal form for the rare case of
    adding a brand-new SKU. Framed as the exception, not the default.
  - `lib/types.ts` — drops `Plan.status`, `effective_from`, `effective_to`,
    `created_by`, `approved_by`, `approved_at`. Drops `PlanStatus` and
    `PlanAuditEvent` types entirely.

### Migration to run

```sql
-- supabase/migrations/30_simplify_plans_drop_versioning.sql
-- (full file in repo; don't paste this snippet alone — the full
--  migration handles the repoint-then-delete sequence safely)
```

After running it: `NOTIFY pgrst, 'reload schema';` to refresh PostgREST.

### What was deliberately preserved

  - Plan slugs + tier values stay the same — no client code knows the
    table changed.
  - `subscriptions.plan_id` still exists and is still set on new
    subscriptions; we just don't pin to specific snapshots anymore.
    `useFeatureAccess` reads features from the live plan via that FK.
  - Razorpay checkout flow unchanged from the customer's perspective.
  - All 8 seeded SKUs from migrations 26 + 28 stay (price + features
    intact).

### Backlog notes

The deleted `plan_audit` table did one valuable thing — give a
"who changed Premium's price last Tuesday?" trail. If you ever want
that back, the cleanest way is a `plan_change_log` table written by
the PUT handler with `before` / `after` JSON snapshots — but it's a
separate concern from grandfathering, and I haven't built it. Park
until needed.

---

## 🆕 Earlier session — 2026-05-01 evening (Theme system, admin invite overhaul, world-class aesthetics pass)

After the morning's plan-admin push, this session was about everything *around* the product — how it looks, how new admins get in, and how interactions feel — taking BloomIQ from "competent indie app" to something that visually competes with Linear, Notion, and Stripe. Three big tracks plus a few critical fixes.

### 1. Theme system — 5 themes × 2 modes

Built a fully variable-driven theme engine in `app/globals.css` with 10
hand-tuned palettes (Emerald, Indigo, Rose, Amber, Slate × light + dark).
Every color, shadow, and gradient flows through CSS variables; nothing
is hardcoded.

**Token discipline.** Semantic tokens are the only thing components
reference: `--color-bg`, `--color-surface-1/2/3`, `--color-fg/-soft/-muted`,
`--color-border-subtle/default/strong`, `--color-accent`, `--color-on-brand`,
`--color-on-accent-soft`. Each theme overrides these values, so the
page reskins instantly without touching component code.

**Interaction tokens computed via `color-mix()`.** Hover, pressed, and
selected backgrounds aren't fixed colors — they're the active brand
mixed *into* the page bg at 4–24% depending on state. This guarantees
text contrast against the new bg stays mathematically identical to
the original bg, so text can never wash out on hover. Solves the
"text not visible when I mouse over" issue once and for all.

**Pre-hydration init script.** A 12-line inline script in `<head>`
reads `localStorage` and sets `data-theme` + `data-mode` on `<html>`
*before* React paints, so there's no flash of unthemed content.
Defaults to **Light Emerald** for everyone — we deliberately don't
auto-pick dark from `prefers-color-scheme: dark` because most users
inherit dark from their OS without ever choosing it, and an
unexpectedly dark education app is jarring.

**Persistence.** `migration 29` adds `profiles.theme` and
`profiles.color_mode` columns. The `/settings/appearance` page
reconciles localStorage ↔ profile on mount and writes through both,
so the choice follows the user across devices.

### 2. The theme picker UX

**`/settings/appearance`** — a full picker with a sun/moon mode toggle,
a 5-card theme grid where each card shows the actual palette colors
as a stripe + 4-dot swatch, and a live preview that re-renders with
the selected theme (gradient buttons, mock dashboard hero, three
Bloom progress tiles).

**Sidebar quick-toggle** (`components/ThemeQuickToggle.tsx`) — compact
panel at the bottom of `Sidebar.tsx` with 5 theme dots + a Light/Dark
button + a gear link to the full appearance settings page. Always
accessible from any logged-in role page.

**`/admin/*` shell upgraded.** `app/admin/layout.tsx` now uses theme
tokens, hosts the same `ThemeQuickToggle` in its top bar, and has a
"Platform Admin" badge in the active brand color. Admin pages used to
be stuck on hardcoded `bg-slate-50` / `bg-white`; they now match
whatever theme the user has picked.

### 3. World-class aesthetic refinement

The first pass of themes had legibility bugs (text washing out on hover)
and the palettes felt like raw hex codes. Second pass — a disciplined
rewrite of `globals.css`:

- **Buttons rebuilt.** Primary uses solid `--brand-600` not gradient
  (gradient was loud); hover deepens to `--brand-700`, active to
  `--brand-800`. Gradient lives only in `.btn-cta` for marketing
  surfaces (hero / pricing). Every state defined explicitly with a
  visible focus ring (`var(--shadow-focus)` = 3px translucent brand).
- **Cards no longer move on hover.** Position-shifts caused micro-jumps
  that read as "broken UI". Now hover only changes `box-shadow` and
  border tint — feels deliberate.
- **Inputs** have visible-but-subtle hover states on the border, a
  prominent focus ring, and `--color-fg-muted` placeholder that never
  disappears.
- **Hover safety net.** Dark-mode + theme-aware overrides retarget
  common Tailwind utilities (`bg-slate-50`, `text-slate-600`,
  `hover:bg-slate-50`, `text-emerald-700`, etc.) to theme tokens, so
  pages still using raw Tailwind utility classes adapt without needing
  a per-file refactor.
- **Premium palette tweaks.** Bg colors picked up subtle theme tinting
  (Emerald bg = `#f7faf8`, Rose = `#fdf7f8`, Slate hero gradient mixes
  in indigo for life). Inter loaded via `next/font` with weights
  400–800, `font-feature-settings` for stylistic alternates,
  `tabular-nums` on tables.
- **Home page redone.** `app/page.tsx` now has a sticky translucent
  nav with backdrop-blur, decorative blurred orbs in the hero,
  gradient-text headline, eyebrow chip, 3-stat credibility strip,
  and 6 feature cards with gradient-icon tiles + animated brand glow
  on hover (`.card-feature::before` overlay).

### 4. Admin invite UX — total overhaul

**Two real bugs caught and fixed.** The original magic-link-by-email
flow was unreliable — emails hit spam, links expired, sessions got
lost in different browsers. Then I (mistakenly) replaced it with a
temp-password-via-Slack flow, which the user correctly flagged as a
security regression: plaintext passwords sitting in chat history
forever. Both flows replaced with the right answer:

**`auth.admin.generateLink()` returns a one-time signed URL to the
server**, never via email. The granting admin shares the URL through
Slack/WhatsApp; the recipient clicks once, lands on `/auth/set-password`,
and chooses their own password. **The granting admin never knows the
password.** The link is single-use and expires in ~1 hour, so even if
the chat is screenshotted later, the URL is already dead.

**`/api/admin/team/sign-in-link`** — new endpoint. Lets any platform
admin issue a fresh single-use link to any other platform admin on
demand. Solves the "zombie confirmed" case where an admin exists in
`auth.users` but has no working password (leftover from the old
broken flow), and gives a clean recovery path for "they forgot their
password too".

**`/admin/team` UI** now shows:
- After a new grant: a green panel with the sign-in link, a copy
  button for just the link, and a copy button for a ready-to-paste
  share message (`"You've been added as a BloomIQ admin. Click this
  link to sign in (single-use, expires ~1hr)..."`).
- A **"Send link"** button on every admin row, alongside Revoke. One
  click = fresh link in the same panel, smooth-scrolled into view.
- An amber security callout reminding admins not to post links in
  public channels.

### 5. Migrations to run

If you're pulling this branch fresh, run these in order in the Supabase SQL editor:

```sql
-- (already covered in the previous session)
-- migration 22 .. 28

-- new this session:
-- supabase/migrations/29_user_theme_preferences.sql
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS theme       text NOT NULL DEFAULT 'emerald',
  ADD COLUMN IF NOT EXISTS color_mode  text NOT NULL DEFAULT 'light';
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_theme_known
  CHECK (theme IN ('emerald', 'indigo', 'rose', 'amber', 'slate'));
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_color_mode_known
  CHECK (color_mode IN ('light', 'dark'));

NOTIFY pgrst, 'reload schema';
```

### 6. New files this session

- `lib/theme.ts` — types, theme metadata, inline init script
- `components/ThemeProvider.tsx` — React context, localStorage sync, cross-tab listening
- `components/ThemeQuickToggle.tsx` — sidebar/admin compact picker
- `app/settings/appearance/page.tsx` — full picker with live preview
- `app/api/admin/team/sign-in-link/route.ts` — generate fresh link for existing admin
- `supabase/migrations/29_user_theme_preferences.sql`

### 7. Modified files this session

- `app/globals.css` — full rewrite around tokens
- `app/layout.tsx` — Inter font, ThemeProvider, init script
- `app/page.tsx` — refined home page
- `app/admin/layout.tsx` — themed top bar + quick-toggle
- `app/admin/team/page.tsx` — sign-in-link panel + per-row Send link
- `app/api/admin/team/route.ts` — generateLink replaces inviteUserByEmail
- `components/Sidebar.tsx` — themed active states + quick-toggle slot
- `lib/types.ts` — `Profile.theme` + `Profile.color_mode`

---

## 🆕 Earlier on 2026-05-01 (Plan-Admin module, dashboard redesign, renewals)

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
    reports/          