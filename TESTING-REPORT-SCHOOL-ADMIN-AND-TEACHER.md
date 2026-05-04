# BloomIQ — School Admin + Teacher Testing Report

**Environment:** Production — https://bloom-iq-umber.vercel.app
**Date:** 2026-05-04
**Testers:** QA via Claude in Chrome (live browser automation against Vercel production build)
**Scope:** School Admin (Principal / "super_teacher") and Teacher roles, with focus on the cross-role linkage (school code join, class assignment, roster visibility).

---

## Test fixtures

| Role | Identifier | Password | School / Linkage |
|------|------------|----------|-------------------|
| School Admin (super_teacher) | `saikamal4446@gmail.com` | `Freefire@4446` | Owns school **`test school-123`** (id `d7adc78f-fdf4-4620-956b-2c705485add4`, code **`WQMBGE`**) |
| Teacher (newly signed up this session) | `qa.tester.teacher@bloomiq.dev` | `QATest@2026` | Joined **`test school-123`** via code `WQMBGE` |

> Note on fixture creation: The teacher signup form ran successfully via the live `/signup?role=teacher` UI. Email confirmation is **enabled** for the project, but `bloomiq.dev` is accepted by Supabase as a valid TLD and the user record was provisioned with `email_confirmed_at` populated immediately (expected for projects in test mode without an explicit confirmation step). Login worked with the issued password right away.

---

## 1. School Admin — page-by-page

| Page | URL | Status | Evidence |
|------|-----|--------|----------|
| School Home | `/school` | PASS | Header reads "test school-123 · School-wide overview · 0 teachers · 6 students". KPIs render: Teachers=0, Classes=3, Tests made=0, Attempts=0. School code `WQMBGE` is displayed and copy-able. (See Bug #15 — the "0 teachers" KPI is wrong; actual DB count is 5.) |
| Teachers | `/school/teachers` | PARTIAL — see Bug #15 | Page loads. Business-continuity (deputies) panel, school code panel, and roster table all render. Header reads "Current teachers (1)" but the DB has 5 teacher profiles attached to this school. |
| All Classes | `/school/classes` | PASS | KPIs (3 classes, 6 total students), New-class form (Grade + Section dropdowns + preview + Create button), classes table with search + teacher filter + grade filter, "3 classes without a primary teacher" callout, and per-row "Assign primary" action all working. |
| All Classes → Assign primary by email | `/school/classes` | PASS | Clicking "Assign primary" reveals an inline email input, Save / Unassign / Cancel buttons. Submitting `qa.tester.teacher@bloomiq.dev` posted successfully and the row flipped to STATUS=`PENDING` with PRIMARY TEACHER showing the email and Copy invite / Re-invite actions appearing. |
| Top Students | `/school/top-students` | NOT TESTED THIS PASS (was tested in earlier session — passed) | — |
| Reports | `/school/reports` | PASS (already verified earlier this session) | Bloom Pulse with PDF / Excel / Copy-summary buttons + 4 tabs (Overview / At-risk / Compare / Engagement). |
| School Coach | `/school/coach` | NOT TESTED THIS PASS | — |
| This Week | `/school/digest` | NOT TESTED THIS PASS | — |
| Profile | sidebar Profile link → `/settings/profile` | PASS (same component as Teacher path; verified there) | — |

---

## 2. Teacher — full sweep

Test teacher: **QA Test Teacher** (`qa.tester.teacher@bloomiq.dev`).

### 2.1 Sign-up + login

| Step | Result |
|------|--------|
| `/signup` → "Teacher" tile | Loads `/signup?role=teacher` with full form (name, optional school, email, password with strength meter, ToS) |
| Submit signup | Redirects to `/login?signedup=1` with "Account created. Please sign in to continue." banner |
| Sign-in with the new email + password | Lands on `/teacher` dashboard with onboarding: "Welcome back, QA" + "Join your school" card |

### 2.2 Joining the school

| Step | Result |
|------|--------|
| Enter school code `WQMBGE` and click Join | Card disappears, `Leave` button appears top-right of welcome banner, dashboard reflows to full Teacher KPI panel: Approved=0, Awaiting Review=0, Tests Created=0, Student Attempts=0. |
| DB verification | `profiles.school_id` for the teacher updated to `d7adc78f-fdf4-4620-956b-2c705485add4` (matches school). |

### 2.3 Page-by-page

| Page | URL | Status | Notes |
|------|-----|--------|-------|
| Home | `/teacher` | PASS | KPIs + "Let's get your first test going" CTA + "Recent tests" empty state + "Create a test" CTA. |
| Classes | `/teacher/classes` | PASS | Empty state "No classes yet" with correct guidance: "Classes are now created by your school Admin Head…". |
| Generate | `/teacher/generate` | PASS | All 4 source tiles (From notes / From an image / Topic + class + syllabus / Just a topic) render. Generated 12 questions on topic "Photosynthesis" via "Just a topic" with All-6-Bloom-levels × 2 questions per level. Generation summary card rendered with Remember/Understand/Apply/Analyze/Evaluate/Create counts. Persistence confirmed via Supabase REST: 12 rows in `question_bank` with `owner_id = <teacher>`, `status = "pending"`. |
| Review | `/teacher/review` | **FAIL — Bug #14** | Page renders "Nothing to review" empty state immediately after generating 12 pending questions. Dashboard's "AWAITING REVIEW" KPI tile correctly says **12**, but the Review page does not list any of the 12 pending rows. |
| Tests | `/teacher/quizzes` | PASS | Empty state with "Create your first test" CTA, "0 total" header, "+ New test" button. |
| Live class quiz | `/teacher/live` | PASS | Engagement-only callout, "Seconds per question: 30" config, "Your quizzes" section with empty state + "Compose a quiz" CTA. |
| Exam Papers | `/teacher/papers` | PASS | "+ New paper" button + "Create paper" CTA in empty state. **Note:** sidebar label is "Exam Papers" but URL is `/teacher/papers`, not `/teacher/exam-papers` (which 404s if typed). Bug #16 below. |
| Analytics | `/teacher/analytics` | PASS | Empty state "No quizzes yet — Create a quiz first, then come back here for analytics." |
| Reports | `/teacher/reports` | PASS | Empty state "No quizzes yet — Create a quiz to start generating reports." |
| Teacher Coach | `/teacher/coach` | PASS | Co-pilot intro + 4 starter prompts ("Which student should I worry about?", "What's my class's weakest Bloom level?", "Suggest a question for tomorrow's lesson", "Where am I making good progress?") + chat composer with Send button. Reset action top-right. |
| This Week | `/teacher/digest` | PASS | Briefing renders with Headline ("No classes or students this week"), Issues to address (High: No classes, High: No students), Wins to celebrate (empty), Suggested actions, Refresh button + "Last refreshed just now" timestamp. |
| Profile | sidebar account → Profile → `/settings/profile` | PASS | Header reads "QA Test Teacher · Teacher · Test School-123". Plan badge "test school-123: School Plus". Personal details (Full name editable, Email read-only with helper "Email is read-only here. Contact support to change it."). Account & security (Change password, 2FA). Appearance (Theme & mode). |
| `/teacher/profile` (direct URL) | `/teacher/profile` | **FAIL — Bug #17** | 404. The profile is at `/settings/profile`, not under the teacher namespace, so this URL — which is the natural guess and matches the Independent Student `/me` pattern — is dead. |
| `/me` (direct URL) | `/me` | FAIL — Bug #17 cont. | 404. No alias exists. |

### 2.4 404 sweep

| URL typed | Result | Comment |
|-----------|--------|---------|
| `/teacher/tests` | 404 | Sidebar's "Tests" link uses `/teacher/quizzes`. No alias from `/teacher/tests`. Cosmetic but trips up support / docs. |
| `/teacher/exam-papers` | 404 | Sidebar's "Exam Papers" link uses `/teacher/papers`. Same as above. |
| `/teacher/profile` | 404 | See Bug #17. |
| `/me` | 404 | See Bug #17. |

---

## 3. Cross-role linkage verification

### 3.1 What works

* Teacher signup → sign-in → enter school code → DB write of `profiles.school_id` → "Leave" button appears on Teacher home. **End-to-end: PASS.**
* School Admin → Classes → Assign primary by typing teacher email → invite recorded, class flips to PENDING with the teacher's email shown. **End-to-end: PASS.**
* Profile page on Teacher side correctly shows "Teacher · Test School-123" subtitle and "test school-123: School Plus" plan badge — i.e. the school relationship is **read** correctly from the teacher side.

### 3.2 What's broken — the central bug

**Bug #15 (CRITICAL).** The School Admin's Teachers page and the School Home KPI both query the school's teacher roster and return only the Admin Head themselves, even when other teachers in the DB have the matching `profiles.school_id`.

Evidence (raw service-role REST query against `profiles`):

```
school_id = d7adc78f-fdf4-4620-956b-2c705485add4
  → 5 rows:
     - QA Test Teacher  (role=teacher,        joined this session via WQMBGE)
     - Rajesh           (role=teacher)
     - Padhy            (role=teacher)
     - Sagar            (role=teacher)
     - saikamal         (role=super_teacher,  the Admin Head)
```

UI surfaces:

* `/school` Home → "0 teachers" in subtitle and Teachers KPI tile.
* `/school/teachers` → "Current teachers (1)" with only saikamal listed as ADMIN HEAD.
* `/school/classes` → "Assign primary" inline editor → empty state "No teachers in this school yet — the dropdown of in-school teachers will appear here once they accept their invite."

Likely root causes (ordered by likelihood):
1. The school-side teacher-roster query joins through a missing/stale `school_members` table (the DB does **not** have a `public.school_members` table — REST query 404s with hint "Perhaps you meant the table `public.class_members`"). If the API route was written against `school_members` it would always return zero rows except the admin themselves (who likely gets surfaced via a different code path, e.g. the school's `admin_id` FK).
2. RLS on `profiles` is filtering out the other teachers when read as the Admin Head. The earlier RLS hardening (`24_rls_hardening.sql`) tightened "read all auth" — if the new policy didn't add a "same-school" exception for Admin Heads, the Head would only see their own row.

The `migration 24` hardening was specifically called out for closing "read all auth" on `profiles`, so #2 is the most plausible. **Recommended check first:** look at the SELECT policies on `public.profiles` and add (if missing) a policy of the form "user with role super_teacher or principal can read any profile whose school_id equals their own school_id".

Until this is fixed:
* Admin Heads cannot see the teachers in their school in any UI list.
* Class-assignment from the dropdown is impossible (the dropdown is empty); only the email-invite fallback works.
* Teacher activity, Top Students by teacher, and any Reports that aggregate per-teacher cannot work end-to-end.

### 3.3 Workaround that does work

Email-invite path is functional. Even though the teacher already has an account in the school, typing their email into the "Assign primary" input and clicking Save:
* sends an invite (UI confirmation: "Invite sent. The class will show as Pending until the teacher accepts it from their dashboard. Use 'Copy invite' to share the sign-in link.")
* updates the class row to PENDING with the email visible
* exposes Copy-invite / Re-invite actions

So the school admin can bootstrap class assignments without the teacher dropdown — but the dropdown itself stays empty, and the Teachers page roster stays at 1.

---

## 4. Bugs found this session

| # | Severity | Area | Summary | Repro |
|---|----------|------|---------|-------|
| **14** | HIGH | Teacher · Review | Newly generated questions (status=`pending`) are persisted to `question_bank` and counted in the dashboard "AWAITING REVIEW" KPI (which correctly showed **12**), but the `/teacher/review` page renders "Nothing to review" empty state. | As QA Test Teacher: Generate → Just a topic → "Photosynthesis" → Generate. Open `/teacher/review`. |
| **15** | CRITICAL | School Admin · Teachers / Classes / Home | School Admin sees only themselves in any list of "teachers in this school". DB has 4 other teachers with matching `school_id`. The Assign-primary dropdown is permanently empty; the Teachers KPI shows 0; the Teachers page header reads "Current teachers (1)". | As saikamal: open `/school`, `/school/teachers`, or `/school/classes` → click any "Assign primary". |
| **16** | LOW | Teacher · routing | Sidebar labels don't match URLs: "Tests" → `/teacher/quizzes`, "Exam Papers" → `/teacher/papers`. Direct guesses (`/teacher/tests`, `/teacher/exam-papers`) 404 instead of redirecting. Trips up users and docs. | Type either guessed URL while signed in as a Teacher. |
| **17** | LOW | Teacher · routing | No `/teacher/profile` or `/me` alias. Profile is reachable only via account-menu → Profile → `/settings/profile`. The Independent Student journey uses `/me`, so behavior is inconsistent across roles. | Type `/teacher/profile` or `/me` while signed in as a Teacher. |

---

## 5. What still needs human verification

* Acceptance flow on the Teacher side for the PENDING class assignment (login back as QA Test Teacher and confirm the class shows up under `/teacher/classes` with an Accept action).
* Whether fixing Bug #15 retroactively heals the Reports/Analytics rollups (those are blocked by the missing roster).
* Confirm Bug #14's "Approved Questions = 0 / Awaiting Review = 12" KPIs against the Question Bank UI once the Review queue renders correctly.

---

## Sources

* App: https://bloom-iq-umber.vercel.app
* Supabase project: `vgmhqxzbhgoscuwwssoo` (REST queries used the service-role key from `.env` to verify DB state during the test).
* Earlier reports referenced: `TESTING-REPORT-RETEST-VERIFICATION.md`, `TESTING-REPORT-INDEPENDENT-STUDENT-LIVE.md`.
