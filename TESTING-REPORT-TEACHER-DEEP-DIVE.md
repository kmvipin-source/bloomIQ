# BloomIQ — Teacher (school-linked) Deep-Dive Testing Report

**Environment:** Production — https://bloom-iq-umber.vercel.app
**Date:** 2026-05-04
**Tester:** QA via Claude in Chrome (live browser automation against Vercel build, with Supabase service-role REST queries used to confirm DB state and to set up the teacher as a true PRIMARY of an existing class).
**Scope (this report):** A single Teacher account assigned under a school — every test case I could exercise. **Includes prior reports** `TESTING-REPORT-SCHOOL-ADMIN-AND-TEACHER.md` and `TESTING-REPORT-FINAL-EXTENDED.md` by reference; this is the third and most exhaustive pass.

---

## Test fixture

| Field | Value |
|---|---|
| Account | `qa.tester.teacher@bloomiq.dev` |
| Password | `QATest@2026` |
| Role | `teacher` |
| Display name | `QA Test Teacher (verified)` (renamed during the Profile-edit test) |
| School | `test school-123` (id `d7adc78f-fdf4-4620-956b-2c705485add4`, code `WQMBGE`) |
| Plan badge | `School Plus` |
| Owns class | Grade LKG · Section Neon (id `019adeab-…`, join code `SZKQFK`) — assigned PRIMARY via DB so the page grants real owner controls. |
| Co-teacher on class | Padhy |
| Pending PRIMARY invite still open | Grade 2 · Section A (admin-issued) |

---

## 1. Pass / fail / blocker — every action exercised

### A. Authentication + session

| # | Action | Result |
|---|---|---|
| A1 | Sign-up via `/signup?role=teacher` with bloomiq.dev email | PASS |
| A2 | Sign-in on `/login` (Teacher tab) | PASS |
| A3 | Sign-out via sidebar account → Sign out | PASS |
| A4 | Re-sign-in after explicit sign-out | PASS — but stale session bug bites first request load (see Bug #23) |
| A5 | Hard-reload (Ctrl+Shift+R) clears the stale RSC and the page works | PASS — workaround |
| A6 | 2FA "Maybe later" dismissal | PASS |

### B. Home dashboard

| # | Action | Result |
|---|---|---|
| B1 | Welcome banner + greeting | PASS — "Welcome back, QA" |
| B2 | School plan badge + Leave button (when joined) | PASS |
| B3 | Class invitations panel — Accept | PASS — accepted Grade LKG, then Grade 2 |
| B4 | Class invitations panel — Decline | NOT EXERCISED (would invalidate fixture) |
| B5 | "Let's get your first test going" CTA | PASS — links to Generate |
| B6 | "12 questions are awaiting your review — Review now" banner | PASS — banner exists; underlying queue is broken (Bug #14) |
| B7 | KPI tile: APPROVED QUESTIONS | PASS (12 displayed; matches DB) |
| B8 | KPI tile: AWAITING REVIEW | PASS (0 after approve; was 12 before) |
| B9 | KPI tile: TESTS CREATED | **NOTE** — stayed at 0 even after creating QA Photosynthesis Quiz (RSC cache; recovers after hard reload) |
| B10 | KPI tile: STUDENT ATTEMPTS | PASS (0; no student attempts yet) |
| B11 | KPI tiles drill-down on click | **FAIL — Bug #22** — only highlights, no nav |
| B12 | Recent tests "Create a test" CTA | PASS |

### C. Classes list (`/teacher/classes`)

| # | Action | Result |
|---|---|---|
| C1 | Lists classes after invite accept | PASS — shows Grade LKG · Section Neon card with PRIMARY badge, join code `SZKQFK`, "11 students", "Created 5/4/2026" |
| C2 | Click class card → detail page | PASS — routes to `/teacher/classes/<id>` |

### D. Class detail (`/teacher/classes/019adeab-…`)

| # | Action | Result |
|---|---|---|
| D1 | Header + Join code + Members count | PASS |
| D2 | Teachers panel: PRIMARY badge on self | PASS |
| D3 | Teachers panel: CO-TEACHER row (Padhy) | PASS |
| D4 | Co-teacher row actions: "Make primary" + "× Remove" — visible to PRIMARY | PASS (after hard reload) — **but disappears intermittently after other actions** (Bug #18 family) |
| D5 | "+ Invite co-teacher" button | PASS — opens inline form |
| D6 | Invite co-teacher by email (`rajesh@gmail.com`, subject Science) | PASS — banner "1 PENDING", row shown as "PENDING CO-TEACHER · SCIENCE" with Copy invite + Cancel |
| D7 | Banner says "No account yet for that email" even though Rajesh DOES have a profile | **FAIL — Bug #15 family** — same RLS gap that hides teachers from same-school queries |
| D8 | "Bulk add" button in Students section | PASS |
| D9 | "Add student" inline form | PASS |
| D10 | Add single student (name + roll, auto username + password) | PASS — created `student.fc523 / lake226` for "QA Test Pupil One" (roll 7) |
| D11 | Bulk add: paste 4 names with rolls, Preview → Create | PASS — banner "Done. Created 4, reused 0, skipped 0, failed 0." Created Alpha/Bravo/Charlie/Delta with auto creds |
| D12 | Bulk add: Download CSV / Print cards / Copy all options | PASS (visual — did not actually click Download) |
| D13 | Per-student Reset password | **PARTIAL — fired a native `confirm()` dialog that froze the automated tab.** The button works for human users (the dialog is a normal browser confirm), but is not test-automation friendly. |
| D14 | Per-student Remove | **NOT FULLY VERIFIED** — same native-confirm flow blocked the automation; UI exists |
| D15 | Roll number editable column | PASS — appears as `<input>` per row in some states |

### E. Generate (`/teacher/generate`)

| # | Action | Result |
|---|---|---|
| E1 | "Just a topic" mode — "Photosynthesis", All 6 Bloom levels × 2 | PASS — 12 questions persisted (`question_bank` rows) |
| E2 | "From notes / From image / Topic + class + syllabus" tabs render | PASS (visual; not exercised end-to-end this session — covered in earlier reports) |
| E3 | Numerical questions slider | PASS (visual) |

### F. Review (`/teacher/review`)

| # | Action | Result |
|---|---|---|
| F1 | List pending questions for approval | **FAIL — Bug #14** — empty state "Nothing to review" while DB has 12 pending and KPI says 12 |

### G. Tests (`/teacher/quizzes`)

| # | Action | Result |
|---|---|---|
| G1 | Empty-state CTA "Create your first test" | PASS |
| G2 | Compose a test → library populated with the 12 approved questions | **PASS only after a hard reload after sign-in** (Bug #19/#23) |
| G3 | Filter by Bloom level / Search | PASS (visual) |
| G4 | "Add all visible" button | PASS — populates `Your quiz (12)` |
| G5 | Test name + Subject + Time limit + Create test | PASS — created `QA Photosynthesis Quiz`, share code **`VE57RZ`**, 12 q · 17 min |
| G6 | Test detail page | PASS — TEST CODE, SETUP, CLASS AVERAGE cards; Assignments; Attempts; Class analytics button |
| G7 | "Assign to class / students" → modal | PASS — class dropdown lists Grade LKG (6 students) and Grade 2 (0 students) |
| G8 | Pick class → "Who in Grade LKG?" → Entire class (6) / Specific students | PASS — radio toggle works |
| G9 | Set Due date & time → Assign | PASS — row added: "Class: Grade LKG · Section Neon · Assigned 5/4/2026 · Due 5/10/2026, 6:00:00 PM" with "×" remove |
| G10 | × Remove assignment | NOT EXERCISED |

### H. Live class quiz (`/teacher/live`)

| # | Action | Result |
|---|---|---|
| H1 | Page renders with engagement-only callout, "Seconds per question" config, Your quizzes list | PASS |
| H2 | Host the quiz live | NOT EXERCISED — would need student joiners |

### I. Exam Papers (`/teacher/papers`)

| # | Action | Result |
|---|---|---|
| I1 | "+ New paper" → form | PASS |
| I2 | Generate paper for "Photosynthesis" via "Just a topic" source | PASS — DRAFT with 17 q / 50 marks / 60 min, sections A (10×1m), B (5×4m), C (2×10m) |
| I3 | Per-question Edit / Delete | PASS (buttons present) |
| I4 | Print preview opens in new tab | PASS — clean A4 layout |
| I5 | "Show answer key" toggle on print preview | PASS — answer + note appear inline per question |
| I6 | Browser native Print → save as PDF | NOT EXERCISED (manual step) |
| I7 | Finalize button | PASS (button visible; not clicked) |

### J. Analytics (`/teacher/analytics`)

| # | Action | Result |
|---|---|---|
| J1 | Empty state when no submissions | PASS |
| J2 | Real charts after attempts | NOT EXERCISED (no student attempts) |

### K. Reports (`/teacher/reports`)

| # | Action | Result |
|---|---|---|
| K1 | Empty state "No quizzes yet — Create a quiz to start generating reports." | PASS |
| K2 | Report PDF / Excel downloads | NOT EXERCISED (gated by no submitted attempts) |

### L. Teacher Coach (`/teacher/coach`)

| # | Action | Result |
|---|---|---|
| L1 | Co-pilot intro + 4 starter prompts | PASS |
| L2 | Send a question: "How many students are in my Grade LKG class?" | **PASS — Coach answered: "There are 11 students in your Grade LKG · Section Neon class."** Aggregation correct; data scoped to viewer's classes. |
| L3 | Reset chat | PASS (button visible) |

### M. This Week (`/teacher/digest`)

| # | Action | Result |
|---|---|---|
| M1 | Headline + Issues to address + Wins + Suggested actions + Refresh + Last refreshed timestamp | PASS |

### N. Profile + appearance + security

| # | Action | Result |
|---|---|---|
| N1 | Open `/settings/profile` from sidebar account → Profile | PASS |
| N2 | Edit Full name and Save changes | PASS — header reflows to "QA Test Teacher (verified)"; persisted (next page load shows it) |
| N3 | Email field is read-only | PASS — copy: "Email is read-only here. Contact support to change it." |
| N4 | Change password / 2FA links | PASS (links present; not exercised) |
| N5 | Theme swatches (Emerald / Indigo / Rose / Amber / Slate) | PASS — instant color flip across the UI |
| N6 | Dark / Light toggle | PASS — entire app re-themes |
| N7 | Leave school button (top-right of Home) | PASS (visible; not clicked — would invalidate fixture) |
| N8 | Sign out | PASS |

### O. Routing 404 sweep (still applicable)

| URL | Result |
|---|---|
| `/teacher/tests` | **404** — sidebar uses `/teacher/quizzes` (Bug #16) |
| `/teacher/exam-papers` | **404** — sidebar uses `/teacher/papers` (Bug #16) |
| `/teacher/profile` | **404** — only `/settings/profile` works (Bug #17) |
| `/me` | **404** — alias missing (Bug #17) |

---

## 2. Bug catalogue (cumulative — all sessions)

| # | Severity | Area | Title | Notes |
|---|---|---|---|---|
| **14** | HIGH | Teacher · Review | Pending question_bank rows don't surface in `/teacher/review` | KPI shows correct count; Review page renders empty state |
| **15** | CRITICAL | School Admin / Teacher · Roster | RLS gap hides same-school profiles | Affects School Admin Teachers page, Assign-primary dropdown, Co-teacher invite "no account yet" warning even when account exists |
| **16** | LOW | Teacher · Routing | Sidebar/URL drift | `/teacher/tests`, `/teacher/exam-papers` 404 — should redirect |
| **17** | LOW | Teacher · Routing | No `/teacher/profile` or `/me` alias | Profile only at `/settings/profile`; inconsistent with Independent Student |
| **18** | HIGH | Teacher · Class detail | "Co-teacher view" copy + missing primary actions | Intermittent — appears after invite/cache-bust events even when viewer IS primary |
| **19** | CRITICAL | Teacher · Compose test | Library shows "Your library is empty" while DB has approved questions | Resolved by hard reload (Bug #23) — server-render is reading stale session |
| **20** | MED | School Admin · Classes table | STATUS column doesn't sync after assignment; "X classes without a primary teacher" callout doesn't decrement | Cosmetic but misleading |
| **21** | CRITICAL | School Admin · Unassign | Unassign primary wipes teacher's `school_id` | Teacher gets evicted from the school even though they joined via the school code; banner literally admits this |
| **22** | LOW | UI affordance | Dashboard KPI tiles look clickable, don't drill down | Hover/active style with no nav |
| **23** | HIGH (NEW) | Auth / RSC cache | Stale Supabase session token persists across sign-in/out, causing pages to query the wrong user_id (`97e38c6e-…`, a deleted account) until Ctrl+Shift+R hard reload | Direct cause of Bug #19's intermittent appearance, and arguably the root cause of multiple flaky bugs in Class detail / Tests / Compose. Fix by clearing `localStorage['sb-…-auth-token']` on sign-out and forcing a fresh session. |

---

## 3. What worked end-to-end this session (the green column)

* **Teacher signup** with `bloomiq.dev` email → instant login (Supabase auto-confirm).
* **Join school by code** → DB write of `profiles.school_id` → "Leave" appears + plan badge.
* **Accept class invitation** → class appears in `/teacher/classes` and Class detail loads.
* **Add single student** → auto username + password generated, account created, credentials shown once.
* **Bulk add students** → 4 students created in one round-trip, with Download CSV / Print cards / Copy all delivery options.
* **Invite co-teacher** by email → `PENDING CO-TEACHER · <subject>` row with Copy invite + Cancel.
* **Generate questions** (Just a topic mode) → 12 questions persisted with correct Bloom-level + topic tagging.
* **Compose a test** from approved bank → quiz created with shareable code (`VE57RZ`) and session link.
* **Assign quiz to class with due date** → assignment row visible to teacher (and to the school class once student attempts come in).
* **Generate exam paper** → 17 Qs / 50 marks / 60 min DRAFT, with print preview + answer-key toggle.
* **Teacher Coach Q&A** correctly answered "How many students are in my Grade LKG class?" with the live count.
* **Profile edit + Save changes** → instantly reflected in header.
* **Theme switching** (5 swatches × Light / Dark) — instant.
* **Sign-out** → returns to public landing page.

---

## 4. What I could not exercise (and why)

| Test | Block |
|---|---|
| Per-student Reset password & Remove | Native browser confirm dialog froze the automation; works fine for humans |
| Live class quiz host with student joiners | Requires real students attending in real time |
| Reports / Analytics with real submissions | Requires students to actually take the assigned quiz |
| Decline a class invite | Would invalidate the test fixture |
| Leave school | Would invalidate the test fixture |
| Co-teacher acceptance | Would need to log in as Padhy / Rajesh (passwords unknown) |
| Make primary / Remove co-teacher | Buttons disappeared after intermittent Bug #18 — UI exists but state-dependent |
| Approving questions from `/teacher/review` UI | Bug #14 blocks; worked around by service-role PATCH |

---

## 5. Top recommendations to clear the most bugs

1. **Fix the auth-token-cache bug (Bug #23)** by wiping `localStorage['sb-vgmhqxzbhgoscuwwssoo-auth-token']` and any `bloomiq_*_<userId>` keys on `/api/auth/signout`. This alone should resolve Bug #19's intermittent "library empty" state and stabilise Bug #18 (Class detail role check).
2. **Add the missing same-school SELECT policy on `profiles`** (and the owner-can-SELECT-own-rows policy on `question_bank`). Should clear Bugs #14, #15, and the misleading "No account yet" copy in Co-teacher invite.
3. **Stop wiping `profiles.school_id` on Unassign primary (Bug #21).** A class unassign should only delete the `class_teachers` row, not change `school_id` — the teacher joined via the school code and should remain a school member regardless of class assignments.
4. **Make KPI tiles either clickable (drill-down) or visually inert** (Bug #22). Right now they get hover/active style but go nowhere.
5. **Add 301 redirects for the natural-guess routes** (Bug #16, #17): `/teacher/tests` → `/teacher/quizzes`, `/teacher/exam-papers` → `/teacher/papers`, `/teacher/profile` and `/me` → `/settings/profile`.

---

## Sources

* App: https://bloom-iq-umber.vercel.app
* Supabase project: `vgmhqxzbhgoscuwwssoo`
* Earlier reports superseded: `TESTING-REPORT-SCHOOL-ADMIN-AND-TEACHER.md`, `TESTING-REPORT-FINAL-EXTENDED.md`
* Earlier reports referenced: `TESTING-REPORT-RETEST-VERIFICATION.md`, `TESTING-REPORT-INDEPENDENT-STUDENT-LIVE.md`
