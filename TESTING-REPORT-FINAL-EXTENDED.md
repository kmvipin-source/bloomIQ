# BloomIQ — Final Extended Testing Report (School Admin + Teacher)

**Environment:** Production — https://bloom-iq-umber.vercel.app
**Date:** 2026-05-04
**Tester:** QA via Claude in Chrome (live browser automation against the Vercel production build, with Supabase service-role REST queries used to confirm DB state).
**Scope:** Two-pass deep test of School Admin (Principal / `super_teacher`) and Teacher journeys, including the cross-role linkage, accept-invite flow, class detail, exam papers, transfer/unassign flows, and KPI tile interactivity. **This report supersedes and includes everything from `TESTING-REPORT-SCHOOL-ADMIN-AND-TEACHER.md`.**

---

## Test fixtures

| Role | Identifier | Password | School / Linkage |
|------|------------|----------|-------------------|
| School Admin (super_teacher / "Admin Head") | `saikamal4446@gmail.com` | `Freefire@4446` | Owns school **`test school-123`** (id `d7adc78f-fdf4-4620-956b-2c705485add4`, code **`WQMBGE`**) |
| Teacher (newly signed up this session) | `qa.tester.teacher@bloomiq.dev` | `QATest@2026` | Joined **`test school-123`** via code `WQMBGE`, then accepted PRIMARY invite for Grade LKG · Section Neon |

DB-confirmed teachers in this school: 5 (Rajesh, Padhy, Sagar, QA Test Teacher, saikamal=`super_teacher`).

---

## Section 1 — Pass/fail matrix

### School Admin

| Page / Action | URL or Trigger | Status | Notes |
|---|---|---|---|
| School Home | `/school` | PASS | Header, school code, KPIs, Teacher activity, Classes table. Header subtitle wrong: "0 teachers" — see Bug #15. |
| Teachers | `/school/teachers` | PARTIAL — Bug #15 | Page renders, "Current teachers (1)" while DB has 5. Deputy promotion / role actions cannot be tested because no other teachers are listed. |
| All Classes | `/school/classes` | PASS | KPIs (3 / 6 / —), New-class form, classes table with search + filters, "3 classes without a primary teacher" callout. Counter is wrong after assignment — see Bug #20. |
| All Classes → Assign primary by email | `/school/classes` row → "Assign primary" | PASS | Email invite path works. Posts invite, row flips to PENDING, banner shows "Invite sent…". Both Grade LKG and Grade 2 successfully invited QA Test Teacher this session. |
| All Classes → Unassign | `/school/classes` row → Assign primary → Unassign | **FAIL — Bug #21** | Wipes the teacher's `profiles.school_id` to `null`, evicting them from the school even though they joined via the school CODE (independent of any class assignment). Banner: "Class unassigned. The previous primary had no other classes in this school, so they were also removed from the school roster." |
| Top Students | `/school/top-students` | NOT RE-TESTED | Was PASS in earlier session. |
| Reports | `/school/reports` | PASS | Bloom Pulse + 4 tabs + PDF/Excel/Copy buttons. |
| School Coach | `/school/coach` | NOT RE-TESTED | — |
| This Week | `/school/digest` | NOT RE-TESTED | — |
| Transfer Admin Head | top-right "Transfer Admin Head" button | PASS (UI) | Reveals inline form with email input + Transfer button + Cancel link, plus the warning copy. Did NOT actually submit (would alter test environment irreversibly). |
| Manage teachers | top-right "Manage teachers" button | PASS | Routes to `/school/teachers`. Same view as sidebar Teachers link. |
| Bloom Pulse | top-right Bloom Pulse button | NOT RE-TESTED THIS PASS | Was PASS earlier. |
| KPI tile click — Teachers | `/school` Teachers card | **FAIL — Bug #22** | Click only highlights the tile visually; no navigation. The tile looks clickable (cursor pointer + hover state) but does nothing. Same observed for Classes / Tests / Attempts tiles. |

### Teacher (QA Test Teacher)

| Page / Action | URL or Trigger | Status | Notes |
|---|---|---|---|
| `/signup?role=teacher` | Signup tile | PASS | Account created, redirected to `/login?signedup=1` with confirmation banner. |
| `/login` (Teacher tab) | post-signup | PASS | Lands on `/teacher` with onboarding banner + Join your school card. |
| Join school via code WQMBGE | `/teacher` Home → Join | PASS | Card disappears, "Leave" button appears, plan badge "test school-123: School Plus" shown. DB write confirmed (`profiles.school_id`). |
| Class invitations panel (Accept) | `/teacher` Home → Accept | PASS | Pending invite for Grade LKG · Section Neon · PRIMARY · invited by saikamal. Click Accept → invite resolves, panel disappears. Class then appears in `/teacher/classes`. |
| Home | `/teacher` | PASS | KPIs: 0 Approved / 12 Awaiting Review / 0 Tests Created / 0 Student Attempts. "12 questions are awaiting your review" banner with "Review now →" CTA. (KPIs not clickable — same Bug #22 pattern.) |
| Classes list | `/teacher/classes` | PASS | Shows joined class card: Grade LKG · Section Neon, PRIMARY badge, Join code SZKQFK, "6 students", "Created 5/4/2026". |
| Class detail | `/teacher/classes/<id>` | PARTIAL — Bug #18 | Loads with Join code, Members count, Teachers panel (QA Test Teacher = PRIMARY, Padhy = CO-TEACHER), Students table (6 students with usernames). **Bug:** Page shows "Co-teacher view — only the primary teacher can add or remove students" even though QA Test Teacher IS the primary. ACTIONS column is empty — no Add/Remove student controls — so primary can't manage roster. |
| Generate | `/teacher/generate` | PASS | All 4 source modes render. "Just a topic" → "Photosynthesis" → 2 questions per Bloom level → 12 questions persisted (DB confirmed). |
| Review queue | `/teacher/review` | **FAIL — Bug #14** | Empty state "Nothing to review" while dashboard KPI says 12 and DB has 12 with `status='pending'`. Approval flow inaccessible from UI. (Worked around by setting `status='approved'` via service-role.) |
| Compose a test | `/teacher/quizzes/new` | **FAIL — Bug #19 (BLOCKER)** | "Your library is empty / 0 approved questions in your library" even after 12 rows were set to `status='approved'` (DB-confirmed). Cannot create a quiz from this UI. Blocks Live class quiz, Reports rollup, Analytics, and Student Attempts flows. |
| Tests list | `/teacher/quizzes` | PASS | "0 total" empty state, "+ New test" / "Create your first test" CTAs. |
| Live class quiz | `/teacher/live` | PARTIAL | Page renders engagement-only callout, "Seconds per question" config, "Your quizzes" section. Empty because Bug #19 blocks quiz creation. |
| Exam Papers list | `/teacher/papers` | PASS | "+ New paper" + empty state CTA. |
| New exam paper | `/teacher/papers/new` | PASS | Full form (Paper details + Template chips Custom / Quick MCQ / Mixed test / CBSE Class 12 / 3 default sections A/B/C). Filled, hit Generate paper with Source = Just a topic = Photosynthesis. |
| Exam paper detail (DRAFT) | `/teacher/papers/<id>` | PASS | Generated 17 questions / 50 marks / 60 min. Section A — MCQ (10 × 1m), Section B — Short answer (5 × 4m), Section C — Long answer (2 × 10m). Per-question Edit + Delete actions. Print + Finalize buttons. |
| Exam paper print | `/teacher/papers/<id>/print` | PASS | Opens in new tab. Clean A4-style print preview. "Show answer key" toggle reveals correct answer + note inline per question. Browser Print dialog hand-off via Print button. |
| Analytics | `/teacher/analytics` | PASS (empty state) | Blocked from real data by Bug #19. |
| Reports | `/teacher/reports` | PASS (empty state) | Blocked from real data by Bug #19. |
| Teacher Coach | `/teacher/coach` | PASS | 4 starter prompts visible + chat composer + Reset button. |
| This Week | `/teacher/digest` | PASS | Headline + Issues to address (No classes / No students) + Wins to celebrate + Suggested actions + Refresh. |
| Profile | sidebar account → Profile → `/settings/profile` | PASS | Shows "QA Test Teacher · Teacher · Test School-123" + plan badge. |

### Cross-role flow

| Step | Result |
|---|---|
| Teacher joins via school code WQMBGE | DB updated `profiles.school_id`. Teacher home shows "Leave" + plan badge. **PASS.** |
| Admin assigns primary by email → Teacher receives invite on Home | Invite card "Class invitations · 1 pending" with PRIMARY badge + "invited by saikamal" + Accept/Decline. **PASS.** |
| Teacher Accept → Class appears in their `/teacher/classes` | Class card visible with Join code + 6 students. **PASS.** |
| Class detail shows both teachers | QA Test Teacher = PRIMARY, Padhy = CO-TEACHER. **PASS.** (But primary's Add Student controls are missing — Bug #18.) |
| Admin's `/school/teachers` shows the new teacher | **FAIL — Bug #15.** Roster always shows 1 (saikamal). |
| Admin's `/school/classes` shows the assigned PRIMARY TEACHER + status | **PARTIAL — Bug #20.** Email shows in PRIMARY TEACHER column but STATUS still says UNASSIGNED, and the "X classes without a primary teacher" callout still counts the row. |
| Admin Unassign primary | **FAIL — Bug #21.** Wipes teacher's `profiles.school_id` even though they joined via code, not via class. |

---

## Section 2 — Bug catalogue (cumulative this session)

| # | Severity | Area | Title | Repro / Evidence |
|---|---|---|---|---|
| **14** | HIGH | Teacher · Review | Pending question_bank rows don't surface in `/teacher/review` | KPI shows 12; DB has 12 with `status='pending'`; page says "Nothing to review". |
| **15** | CRITICAL | School Admin · Roster | Admin can only see themselves on `/school/teachers` and in the Assign-primary dropdown | DB: 5 teachers in school. UI: "Current teachers (1)". Likely missing same-school SELECT policy on `profiles` after migration 24 hardening, or a query that joins through a non-existent `school_members` table (REST 404 confirms `public.school_members` does not exist). |
| **16** | LOW | Teacher · Routing | Sidebar/URL drift | "Tests" link → `/teacher/quizzes`; typing `/teacher/tests` 404s. Same for `/teacher/exam-papers` vs `/teacher/papers`. |
| **17** | LOW | Teacher · Routing | No `/teacher/profile` or `/me` alias | Profile only reachable via account-menu → Profile → `/settings/profile`. Inconsistent with Independent Student `/me` pattern. |
| **18** | HIGH | Teacher · Class detail | Primary teacher sees "Co-teacher view" copy and gets no Add/Remove student actions | Class detail page for Grade LKG · Section Neon, viewer = PRIMARY (badge confirmed). Copy reads "Co-teacher view — only the primary teacher can add or remove students." ACTIONS column empty. So primary can't add students from the class detail at all. |
| **19** | CRITICAL (BLOCKER) | Teacher · Compose test / library | Approved questions don't appear in the test-composer library | After setting status='approved' on 12 rows for `owner_id = teacher` (DB-confirmed), `/teacher/quizzes/new` still says "Your library is empty / 0 approved questions in your library". Blocks Tests, Live class quiz, Analytics, Reports. Same root cause family as Bug #14 / #15 (RLS or role-scoped query is filtering out the teacher's own rows). |
| **20** | MED | School Admin · Classes table | Status column doesn't sync after assignment; "X without a primary teacher" callout doesn't decrement | After assigning email QA, Grade LKG row shows PRIMARY TEACHER = the email but STATUS still says UNASSIGNED. The "3 classes without a primary teacher" callout stays at 3 even with one assigned. |
| **21** | CRITICAL | School Admin · Unassign | Unassign wipes the teacher's school_id | After clicking Unassign on Grade LKG, DB shows `profiles.school_id = NULL` for QA Test Teacher, even though they originally joined via the school CODE and the unassign should only affect class membership. Banner explicitly says "they were also removed from the school roster." This is destructive: a single class unassign by the admin can silently evict a teacher from the entire school, including any pending invites or other future class work. |
| **22** | LOW | UI affordance | Dashboard KPI tiles look clickable but don't drill down | School Home tiles (Teachers / Classes / Tests made / Attempts) and Teacher Home tiles all only show a hover/active highlight on click; they don't navigate to a filtered view. |

Severity legend: CRITICAL = data-loss / blocker for a primary use case; HIGH = blocks a core workflow but has a workaround; MED = visible incorrect state but recoverable; LOW = polish / discoverability.

---

## Section 3 — What was tested this session that's worth keeping

### Worked well
- **Exam Papers end-to-end**: form → AI generation (17 Qs, 50 marks, ~10s) → DRAFT view with per-question Edit/Delete → Print preview with answer-key toggle → handoff to native browser print. This is the most polished flow tested today.
- **Teacher signup → school join via code → invite accept**: the happy path here works smoothly; the invite UI is well-designed (PRIMARY badge, "invited by", clean Accept/Decline).
- **Generate questions**: AI generation is fast (~5–10 s for 12 questions), persists to DB, is correctly scoped by `owner_id` and `bloom_level`.
- **Profile / Settings page**: shared `/settings/profile` works for both Teacher and School Admin, shows the school linkage in the subtitle and plan badge.

### Workarounds available
- **Class assignment**: even though the in-school dropdown is empty (Bug #15), the email-invite path on the Assign primary inline editor works.
- **Bug #14 mitigation**: Teacher Home shows a top banner "12 questions are awaiting your review — Review now →" CTA, which gives a partial visibility into the broken Review queue.

---

## Section 4 — Root-cause hypothesis (top priority)

**Bugs #14, #15, #19, #21 are almost certainly all the same RLS issue on `profiles` and/or `question_bank`.**

Migration `24_rls_hardening.sql` removed "read all auth" SELECT policies on these tables. If the replacement policies didn't include:
- `profiles`: a "user with role `super_teacher` or `principal` can SELECT any profile whose `school_id = auth.school_id()`" clause; and
- `question_bank`: a "owner can SELECT their own rows regardless of status" clause (or the policy is keyed on `school_id` join that requires the school link the unassign just wiped),

…then:
- Admin Head sees only their own profile row → "0 teachers" + "Current teachers (1)" + empty Assign dropdown (Bugs #15, #20 partially).
- Teacher cannot read their own pending OR approved question_bank rows in the app's queries (Bugs #14, #19).
- Unassign code path that decides "do they still belong to the school?" reads zero matching class rows (because of the same RLS gap), wrongly concludes the teacher has no school activity, and clears `school_id` (Bug #21).

**Recommended first fix:** add the two SELECT policies above (or whatever the replacement policy is missing) to migration 26. Re-run the same flows; expect Bugs #14, #15, #19, #21 to all clear together.

---

## Section 5 — Tests still pending human follow-up

* **Test #76 — Co-teacher invite from primary's class detail.** Cannot exercise: the class detail's ACTIONS column is empty (Bug #18) and there is no "+ Co-teacher" button when viewing as primary.
* **Live class quiz host run with student joiners.** Blocked by Bug #19 (no quiz to host).
* **Reports PDF/Excel from the teacher side.** Blocked by Bug #19.
* **Deputy Admin Head promotion.** Blocked by Bug #15 (no other teachers visible to promote).
* **Acceptance-flow on a 2nd PENDING class (Grade 2 · Section A invite still outstanding for QA Test Teacher).** Skipped because it would just retread the Grade LKG accept path that already passed.

---

## Sources

* App: https://bloom-iq-umber.vercel.app
* Supabase project: `vgmhqxzbhgoscuwwssoo`
* Earlier reports superseded: `TESTING-REPORT-SCHOOL-ADMIN-AND-TEACHER.md`
* Earlier reports referenced: `TESTING-REPORT-RETEST-VERIFICATION.md`, `TESTING-REPORT-INDEPENDENT-STUDENT-LIVE.md`
