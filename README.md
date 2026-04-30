# 🌱 BloomIQ

**Assess _how_ students think — not just what they recall.**

BloomIQ is an end-to-end Bloom's Taxonomy-driven assessment platform.
Three role tiers (school principals, teachers, students), two student modes
(school-managed vs independent subscription), AI-generated content from five
sources, Bloom-level analytics, printable exam papers, and reporting suites.

---

## 🆕 Latest session — 2026-05-01 (Plan-Admin module, dashboard redesign, renewals)

A long, multi-track session that takes BloomIQ from "we have a hardcoded
pricing page" to "any platform admin can edit prices and feature buckets,
schools have per-student plans, students see locked tiles for what they
don't have, and renewals actually work." Versioned plans with full
grandfathering, school-student feature access via the school's plan,
visible-but-locked tile UX, and Path A renewal (expiry enforcement +
in-app banner + cron).

### 1. Independent-student dashboard redesign

Three coherent pieces. **Goal-based onboarding** (migration 24) — first
time an independent student lands on `/student`, a single-question card
asks "What are you preparing for?" with eight tiles: Class 10/12 boards,
JEE/NEET/CAT/UPSC prep, Bank exams, Just exploring. Choice persists to
`profiles.exam_goal` and drives the rest of the dashboard.

**Bloom heat-map hero** (`components/BloomHero.tsx`) — six horizontal
bars across the Bloom levels, coloured red/amber/green by mastery,
with strongest + weakest callouts. Replaces the bland "tests taken /
average score" stats card as the visual anchor. Empty state shows the
six grey bars with a single "Take your first practice test" CTA.

**Goal-aware tile regroup** (`lib/studentGoalTiles.ts` +
`components/StudentFeatureTile.tsx`) — replaces the previous three
themed tile sections with a single goal-driven layout: 4–5 priority
tiles for the student's exam goal, the rest collapsed under "More
tools". Same 14 features always present, just regrouped per goal.

### 2. Plan-Admin module (migrations 25, 26)

The `plans` table — versioned plan catalogue with grandfathering:
each row is one *version* of a plan (slug + status + effective dates).
`plan_audit` log captures every create/edit/submit/approve/reject with
actor + payload. `subscriptions.plan_id` foreign-keys to a specific
plan version, so payment locks the user to that snapshot for as long
as their subscription lasts.

Five seeded plans: Free, Premium Monthly (₹99), Premium Annual (₹999),
Premium Plus Monthly (₹199 placeholder), Premium Plus Annual (₹1999
placeholder). Backfills `subscriptions.plan_id` from the legacy `tier`
column.

**Feature registry** (`lib/features.ts`) — single source of truth for
21 gateable feature keys grouped into 8 categories. Adding a future
gateable feature is one row here.

**Internal `/admin/plans`** — list, detail, edit pages. Active plans
are immutable; "Edit" creates a new draft. Submit-for-review and
approve/reject workflow with two-eyes principle (approver must be a
different platform admin from the proposer; enforced at API and DB).
Approving a draft auto-archives the prior active version of the same
slug.

`Sidebar.tsx` and the `/admin` layout now both have "Plans" links
visible only to platform admins.

### 3. Visibility-but-lock UX + paywall modal

`lib/featureAccess.ts` — `useFeatureAccess()` hook loads the user's
plan and returns `{ allowed, planTier, planLabel, source, expiresAt,
planSlug, isExpired }`. `findUnlockingTier(key)` looks across active
plans for the cheapest tier that unlocks a given feature, used for
the lock badge label.

`StudentFeatureTile` is now lock-aware. When a tile's feature key
isn't in the user's `allowed` set, it renders dimmed with a tier
badge ("Premium" / "Premium Plus") and clicking opens a paywall
modal instead of navigating.

`components/PaywallModal.tsx` — standard modal for individual users
("See plans" → `/pricing`). Has an `isSchoolStudent` variant that
swaps the CTA for "Email my Admin Head" with a pre-filled mailto,
since school students can't self-upgrade.

### 4. Live `/pricing` + checkout binding

`/api/pricing/active-plans` (public) returns active plans grouped
sorted by tier rank. `/pricing` reads from this endpoint at mount
time — any platform-admin price change reflects on the page on next
load, no redeploy. Falls back to hardcoded plans if the fetch fails.

`/api/checkout` + `/api/checkout/verify` rewritten to read price + tier
from the active plan via slug, store `plan_id` in Razorpay order
notes, and bind the resulting `subscriptions.plan_id` to that exact
plan version. This is what makes grandfathering survive future
catalogue changes.

### 5. Per-student school pricing (migrations 27, 28)

`pricing_model` column on `plans`: `'fixed'` (Free / Premium /
Premium Plus) or `'per_student'` (school plans). Per-student plans
also store `per_student_price_paise`, `min_students`, `max_students`.
DB check constraint enforces "if per-student then price > 0."

Three seeded school plans, all per-student annual:
- **School Pilot** — ₹49 per student/year, 20–100 students
- **School Standard** — ₹39 per student/year, 100–500 students (+ Bloom Pulse, Principal Coach, priority support)
- **School Plus** — ₹29 per student/year, 500+ no upper limit (+ Voice Tutor, Concept Visualizer, dedicated CSM)

Teachers stay uncapped on every plan.

`/admin/plans/[id]/edit` shows a Pricing-Model toggle for school tiers,
with per-student rate / min / max fields. `/pricing` "For schools"
section renders three live cards plus an interactive headcount
calculator: type your student count, see which tier you fall into and
the projected annual cost.

### 6. School-student feature access via school's plan

`useFeatureAccess()` now branches on `profiles.is_school_student`. For
school students, it loads the *school's* active subscription (keyed
by `school_id`) instead of a personal one. The school's plan
determines what tiles unlock.

`/student` school-student branch replaces the previous hardcoded
3-tile "Boost your test-taking" section with the same 14-tile
catalogue used on the independent dashboard, gated by the school's
plan. Locked tiles open the school-student paywall variant.

### 7. Set school's plan inline

`POST /api/admin/schools/[id]/set-plan` upserts a `subscriptions` row
binding the school to a specific plan version (with mapped tier and
computed `expires_at`).

`/admin/onboard-school` adds:
- A "School plan" select on the **onboarding form** itself, so the
  platform admin picks the plan in the same step as creating the
  school. Optional — defaults to "— Pick later —".
- A **Plan column with inline dropdown** on the recent-onboardings
  list, so the platform admin can change a school's plan at any time
  (renewals, upgrades, downgrades).

### 8. Path A renewal (expiry enforcement + RenewBanner + cron)

`useFeatureAccess()` now checks `expires_at`. If a paid subscription's
expiry has passed, the user is treated as Free with empty allowed —
locked tiles render and access is gated. This single fix closes the
"buy-once, stay-forever" hole that existed before.

`components/RenewBanner.tsx` — three states. Hidden when more than 7
days remain. Amber strip when within the warning window. Red strip
when expired. Renew button calls `/api/checkout` with the user's
`plan_slug`, opens Razorpay, on success the page reloads with a
fresh `expires_at`.

`POST /api/cron/expire-subscriptions` — idempotent endpoint guarded
by `CRON_SECRET`. Flips `subscriptions.status` from 'active' to
'expired' for any row whose `expires_at < now()`. Wire to Supabase
pg_cron, Vercel Cron, GitHub Actions schedule, or external cron-job.
Sample SQL for Supabase pg_cron is in the route's docstring.

The user-facing gating is direct (the dashboard checks `expires_at`,
not just `status`), so the cron is mostly cosmetic for analytics —
the system stays correct even if the cron never runs.

### 9. Manual setup checklist before testing

1. Apply migrations **24, 25, 26, 27, 28** in Supabase SQL editor.
2. Add `CRON_SECRET=<random_string>` to `.env.local`.
3. Optional: wire the cron via Supabase pg_cron (sample in
   `app/api/cron/expire-subscriptions/route.ts`).
4. As platform admin, visit `/admin/plans` to see the seeded plans;
   `/admin/onboard-school` to see the new plan selector + dropdown.

### 10. Files added / touched

```
NEW (this session)
  supabase/migrations/24_student_exam_goal.sql
  supabase/migrations/25_plans_and_audit.sql
  supabase/migrations/26_seed_initial_plans.sql
  supabase/migrations/27_per_student_pricing.sql
  supabase/migrations/28_seed_school_plans.sql
  lib/features.ts
  lib/featureAccess.ts
  lib/studentGoalTiles.ts
  components/StudentGoalPicker.tsx
  components/StudentFeatureTile.tsx
  components/BloomHero.tsx
  components/PaywallModal.tsx
  components/RenewBanner.tsx
  app/admin/plans/page.tsx
  app/admin/plans/new/page.tsx
  app/admin/plans/[id]/edit/page.tsx
  app/api/admin/plans/route.ts
  app/api/admin/plans/[id]/route.ts
  app/api/admin/plans/[id]/transition/route.ts
  app/api/admin/schools/[id]/set-plan/route.ts
  app/api/pricing/active-plans/route.ts
  app/api/cron/expire-subscriptions/route.ts

MODIFIED
  lib/types.ts                       (Plan, PlanTier, PlanStatus,
                                      PlanAuditEvent, exam_goal,
                                      pricing_model fields)
  app/student/page.tsx               (goal picker + BloomHero +
                                      goal-aware tiles + lock states +
                                      paywall + renew banner; school
                                      branch rebuilt with same catalogue)
  app/admin/layout.tsx               (Plans tab in admin nav)
  app/admin/onboard-school/page.tsx  (plan select on form, plan
                                      dropdown column on list)
  app/api/admin/onboard-school/route.ts (plan_id on POST + plan join
                                         on GET, available_school_plans)
  app/api/checkout/route.ts          (DB-driven price, plan_id in notes)
  app/api/checkout/verify/route.ts   (binds subscription.plan_id from
                                      order notes)
  app/pricing/page.tsx               (live DB plans + Premium Plus
                                      section + per-student calculator
                                      for schools)
  components/Sidebar.tsx             (Plans link in PLATFORM ADMIN section)
  app/student/practice/page.js       (deleted — was a redirect stub)
```

### 11. Backlog (multi-day track, parked for future sessions)

- Server-side `requireFeature(userId, key)` enforcement on the actual
  feature route handlers — closes curl-bypass on the dashboard's
  paywall modal.
- Per-subscription `extra_features` (give Alice a feature without
  raising her price). Design documented in chat — defer until needed.
- Email reminders before/at/after expiry. Plug into the cron once
  SMTP is wired (Resend recommended).
- True auto-renewal via Razorpay Subscriptions API (Path B). Path A
  in this session is buy-each-cycle; Path B is recurring with mandate.
- Audit-log UI on `/admin/plans/[id]` — the data is captured, just
  not surfaced in the UI yet.
- "Add only, never remove" enforcement on plan version transitions —
  warn or block if a new active version drops a feature key that the
  prior active version had.

---

## 🆕 Earlier session — 2026-04-30 (Platform Admin, school onboarding, ToS)

A focused round on **how a paying school actually gets onto BloomIQ**, plus
modern auth UX and legal acceptance. Every change is additive — no existing
flow was removed, only gated more cleanly.

### 1. Platform Admin role (BloomIQ staff, separate from school super_teacher)

A new `profiles.platform_admin` boolean flag identifies BloomIQ operators
(you and your colleagues). Distinct from `super_teacher`, which remains a
per-school admin role. Platform admins access an internal `/admin/*` area:

- **`/admin/onboard-school`** — form to provision a paying school. Takes
  school name + Admin Head full name + email; creates the `schools` row
  with a generated join code, then calls `supabase.auth.admin.inviteUserByEmail`
  on the Admin Head. Lists recent onboardings with pending / accepted status.
- **`/admin/team`** — manage the platform admin team itself. Grant the flag
  to a colleague by email (auto-invites them if they don't have an account
  yet). Revoke. Self-revoke and last-admin revoke are blocked server-side
  and client-side to prevent total lockout.

Bootstrap: the very first admin must be flipped on via SQL (chicken-and-egg);
after that, everything is self-serve from `/admin/team`.

```sql
update public.profiles
set platform_admin = true
where id = (select id from auth.users where email = 'YOUR@email.com');
```

### 2. School Admin Head onboarding flow

Admin Head signup is **invite-only** now — the role tile is gone from
`/signup` and a server-side check rejects `?role=super_teacher`. The
end-to-end flow:

1. School pays (offline today; payment-webhook hookup wired but not enabled).
2. You go to `/admin/onboard-school` and submit the form.
3. Supabase emails the Admin Head an invite link.
4. Clicking the link auto-authenticates them and lands them on
   `/auth/set-password` (NEW — see below).
5. They pick a password, then bounce to `/school` — already named, with the
   join code visible. No "Set up your school" screen.

### 3. `/auth/set-password` — universal password-set screen

The reason an earlier round of testing failed: Supabase invite links
auto-authenticate but don't set a password, so the invitee couldn't sign
in next time. Fixed by routing every invite **and** password reset
through `/auth/set-password`, which forces an explicit password choice.

Reused for the new **"Forgot password?"** link on `/login`, so anyone can
self-recover without needing the platform admin.

### 4. Modernised password UX

`/signup`, `/login`, `/auth/set-password`:

- Single password field (no "confirm password") — modern standard since
  show/hide is universal.
- Show/hide eye toggle.
- 8-character minimum (was 6).
- 3-segment strength meter on signup + set-password.
- Submit stays disabled until length + ToS conditions are met.

### 5. Auth-aware home navigation

New **`components/PublicNav.tsx`** drives the top bar on `/` and `/pricing`.
When logged out: Pricing | Sign in | Create account. When logged in:
Pricing | Dashboard | Sign out (Dashboard routes to the right home for
the user's role + platform_admin flag).

Fixes the "I clicked Create account and it took me to a super_teacher
page" confusion when a logged-in user lands on the home page.

### 6. Sidebar Platform Admin section

`components/Sidebar.tsx` now reads `profiles.platform_admin`. When true,
adds a small "PLATFORM ADMIN" section to the sidebar (under the role nav)
with links to `/admin/onboard-school` and `/admin/team`. Active state uses
slate-900 instead of emerald to make it visually distinct from the role
nav. Section is invisible to non-admin users.

### 7. Terms of Service + Privacy Policy

Real public pages at **`/terms`** and **`/privacy`**, linked from:

- Home + Pricing footers (Terms · Privacy · Pricing).
- Required click-wrap checkbox above the Submit button on `/signup`.
- Implicit-acceptance line on `/login` ("By signing in, you agree...").
- Implicit-acceptance line on `/auth/set-password` (this is the binding
  moment for invitees who never went through `/signup`).

ToS acceptance + version (`2026-04-30`) is stamped into Supabase
`user_metadata.tos_accepted_at` at signup AND at set-password completion,
so we have a clean audit record per user.

**Both pages are clearly marked as starting drafts**: an italic note at
the bottom flags that a qualified Indian SaaS lawyer needs to review
before BloomIQ's first paying customer (DPDP Act 2023, IT Act 2000,
Consumer Protection Act 2019).

### 8. Database migrations

- **`22_platform_admin_and_invite.sql`** — adds `profiles.platform_admin`,
  `schools.invited_admin_email / invited_at / onboarded_by`, the
  `is_platform_admin()` security-definer helper, and RLS policies that
  give platform admins read/write on schools + profiles for onboarding.
- **`23_platform_admin_provenance.sql`** — adds
  `profiles.platform_admin_granted_at / granted_by` so the team page can
  show "you were added by Vipin on 30 Apr".

Run both in Supabase SQL editor before testing the new flow.

### 9. Files added / modified — at a glance

```
NEW
  app/admin/layout.tsx
  app/admin/onboard-school/page.tsx
  app/admin/team/page.tsx
  app/api/admin/onboard-school/route.ts
  app/api/admin/team/route.ts
  app/auth/set-password/page.tsx
  app/terms/page.tsx
  app/privacy/page.tsx
  components/PublicNav.tsx
  supabase/migrations/22_platform_admin_and_invite.sql
  supabase/migrations/23_platform_admin_provenance.sql

MODIFIED
  app/page.tsx              (auth-aware nav, footer Terms/Privacy links)
  app/pricing/page.tsx      (footer Terms/Privacy links)
  app/signup/page.tsx       (super_teacher tile removed; password UX;
                             logged-in redirect; ToS checkbox)
  app/login/page.tsx        (Forgot password; show/hide; ToS line)
  components/Sidebar.tsx    (Platform Admin section for staff)
  lib/types.ts              (Profile.platform_admin; School.invited_*)
  .gitignore                (APIKey.txt, *.docx, Office temp files)
```

### 10. Manual setup checklist before first real test

1. Run migrations 22 + 23 in Supabase SQL editor.
2. Bootstrap your first platform admin via the SQL block in section 1.
3. In Supabase Dashboard → Authentication → URL Configuration, add the
   `/auth/set-password` URL to Redirect URLs (both dev and prod) so
   invite + reset emails land correctly.
4. Customise the Supabase invite + password-recovery email templates
   under Authentication → Email Templates so they read like BloomIQ.
5. Before going live to real customers: switch Supabase Auth → SMTP
   Settings to a real provider (Resend, Postmark, SES) — the default
   Supabase mail is rate-limited and marked test-only.
6. Have a lawyer review `/terms` and `/privacy`.

### 11. Known-not-yet-done

- Self-serve school payment + webhook (currently offline / "Talk to us").
- Database tracking of platform_admin grant audit trail beyond
  `granted_by`.
- Re-invite button on `/admin/onboard-school` for stuck pending invites.
- ToS acceptance backfill prompt for users created before this round.

---

## 🆕 Earlier session — 2026-04-29 (big feature push)

Major expansion across admin / teacher / student. Full breakdown in
**`SESSION_NOTES.md`**. Headlines:

**Three "Coach + Brief" surfaces.** AI chat + auto-summarised weekly digest
for each role, all gated to the right user via Supabase Auth + role check:

- Principal Coach + This Week → `/school/coach`, `/school/digest`
- Teacher Coach + This Week → `/teacher/coach`, `/teacher/digest`
- Student Performance Coach + This Week → `/student/coach`, `/student/digest`

Each has its own server-side context summariser
(`lib/{school,teacher,student}Context.ts`) that builds a compact JSON
snapshot — totals, per-class avg, Bloom mastery, top performers, at-risk
list, 7d-vs-prior-7d engagement. Coach uses `groqText` for free-form
answers; Brief uses `groqJSON` with a strict shape (`headline`, `issues`,
`wins`, `actions`).

**Admin /school/reports tab bar.** Four tabs: Overview (existing) /
At-risk (auto-flags students with declining trend, low avg, or 14d
inactive) / Compare (class × Bloom heatmap) / Engagement (30-day
sparklines + last-7-vs-prior-7 deltas). URL-driven tab state so a
Principal can bookmark `?tab=at-risk` as their Monday-morning page.

**Question-generation upgrades** wired into every MCQ-emitting route
(`/api/generate`, `/api/student/quick-test`, `/api/papers/generate`):

- *Misconception-aware distractors* — mines past `attempt_answers` for
  the topic + Bloom level to seed wrong options grounded in real
  student errors.
- *Self-verifying answer keys* — every generated question is re-solved
  in a second Groq call before save; mismatch triggers one regeneration.
- *Empirical difficulty + discrimination (light IRT)* — once a question
  has ≥20 attempts, calibrated_difficulty (% correct) and
  calibrated_discrimination (point-biserial vs. student ability) get
  computed. UI badges Easy/Medium/Hard + Good/Weak/Broken on every
  question card. Calibrate via "Calibrate now" button.

**Adaptive personalised practice** at `/student/practice`. Student types
a topic, system reads their last-30-day Bloom mastery, picks the weakest
level, generates 5 questions there via Groq + verify, redirects into the
existing `/student/quiz/[code]` flow.

**Daily smart drill + SRS surfacing** at `/student/drill`. Five questions
each morning: 2-3 from yesterday's wrong answers + 2-3 from the student's
two weakest Bloom levels (last 14 days). Inline take-and-grade UX. The
existing `srs_reviews` table from migration 15 now surfaces a
"X reviews due today" card on `/student` home when count > 0.

**Question variants + worked solutions.** Wand-icon button on every
library question in `/teacher/quizzes/new` opens a modal: AI generates 3
isomorphic variants (same Bloom level, same concept, different numbers /
wording), each verified, "Save to bank" picks the keepers. Plus
`/api/qbank/[id]/solution` generates a step-by-step worked solution on
demand.

**Live class quiz mode (Kahoot-style).** Teacher visits `/teacher/live`,
picks a quiz, hosts it. 6-char join code. Students join at
`/student/live/[code]`. Lobby → running → ended states. Time-decayed
scoring (1000 max per question, 0 for wrong). 2s polling for the live
state. Top-3 podium + leaderboard at the end. Tables in migration 21.

**End-to-end Playwright suite.** 130 tests across 6 spec files covering
public + auth, super_teacher, teacher, student, parent, and cross-role
authorisation. Seed/cleanup scripts produce a deterministic
`test_*`-prefixed fixture set (2 schools, 3 teachers, 4 students). All
npm `test:e2e:*` scripts wired. See `tests/e2e/README.md` and
`tests/e2e/CREDENTIALS.md`.

**RLS audit.** `RLS_AUDIT.md` at project root flags **4 HIGH-severity**
findings — `profiles`, `quizzes`, `quiz_questions`, `question_bank` all
have `to authenticated using (true)` SELECT policies that let any logged-
in user read across schools. Fix sketches included; turn into
`22_rls_hardening.sql` next session.

**Naming convention.** `CONVENTIONS.md`: Test = formal graded paper,
Quiz = quick interactive online MCQ session, Practice = ungraded
self-paced. DB columns stay (`quizzes`, `exam_papers`); only UI labels
follow the rule.

### Migrations to apply this session

| File | Required for |
|---|---|
| `supabase/migrations/18_question_calibration.sql` | Empirical difficulty/discrimination badges |
| `supabase/migrations/20_daily_drill_attempts.sql` | Daily-drill analytics (drill works without it but doesn't log) |
| `supabase/migrations/21_live_quiz_sessions.sql` | Live class quiz mode (required) |

All idempotent. Paste into Supabase SQL editor.

### Reverted mid-session

Online mock exam mode + photo-upload auto-grading were built then rolled
back at user direction (descriptive exams stay physical). Migration 19
deleted; `lib/types.ts` and `app/teacher/papers/[id]/page.tsx` restored.

### Edit-tool note

Several files were truncated by the `Edit` tool at ~38 KB during this
session and recovered via bash heredoc rewrites. **For files > 30 KB,
use `cat > file <<'TAG'` patterns going forward.**

---

## 📜 Earlier on — 2026-04-29

Bug-fix and polish session focused on the school-side onboarding rough
edges plus a few quality-of-life features. Full per-issue breakdown lives
in **`SESSION_NOTES.md`** (newer, session-scoped). Headlines:

**Class assignment now works end-to-end.** Admin assigns a teacher as
primary on `/school/classes`; the teacher sees the class on
`/teacher/classes` reliably, regardless of RLS state. Fixed by routing the
teacher's read through a new server endpoint `app/api/teacher/classes/route.ts`
that authenticates the user but reads `class_teachers + classes` with the
service-role key. RLS gaps can no longer hide an assignment from the
assigned teacher.

**Bulk-add students** — paste a list of names, get a per-row preview with
auto-generated usernames + passwords + dup-checks (school-wide + within-
paste), commit, then download a CSV / print 2-up cut-line cards / copy all.
Smart defaults: ready→create, already-enrolled→skip, paste-dup→skip.
Three-stage dialog (`components/BulkAddStudents.tsx`); two new endpoints
`bulk-preview` and `bulk-create` under `app/api/admin/students/`. Max 200
names per batch. Fixed a subtle unmount bug where the parent's `load()`
spinner wiped the results-stage state mid-flow — `onCreated()` is now
deferred to the **Done** click so the credentials stay on screen.

**Soft-remove + Undo banner.** Removing a student now only deletes the
`class_members` row; the auth user, profile, password, and quiz history
are preserved. An amber Undo banner appears at the top of the class page
right after a removal — one click puts them back with the original
`joined_at`. Endpoints: `app/api/admin/students/[id]/remove-from-class`
and `restore-to-class`.

**Duplicate-name detection no longer false-positives** on short labels
("S1" vs "S3" stopped triggering) and now ignores orphan profiles (zero
class memberships) so previously-removed students don't trip warnings on
re-add. Fix in `app/api/admin/students/route.ts`.

**X-Ray gets answers + explanations.** Per question the AI now produces
the correct answer (MCQ letter+text, numerical with units, model short-
answer) plus a 1–3 sentence "why" reasoning trail. Detail page renders
them per-row with Show/Hide and "Show all answers". Print button opens a
clean printable view (Bloom badge + answer + explanation). Save-as-paper
copies the X-Ray into `exam_papers` + `exam_paper_questions` preserving
bloom_level + answer + explanation; the post-save banner is now big and
**role-aware** — teachers see "Open this paper →" and "All saved papers"
linking into `/teacher/papers`, students get "See all my X-Rayed papers"
linking to `/student/xray`.

**Quiz time recommendation.** New `recommendedQuizMinutes()` helper in
`lib/bloom.ts` budgets per-Bloom-level seconds (30s remember up to 120s
create) plus a 15% review buffer. Both `/teacher/quizzes/new` and
`/student/generate` auto-sync the time-limit field with the recommendation
until the user manually edits, then offer a "Use suggested" snap-back.
Teachers' create-quiz path persists the recommendation to
`quizzes.recommended_minutes` for later analytics.

**Concept Visualizer animation upgrade.** The AI prompt now demands
embedded SMIL animations inside each frame (`<animate>`,
`<animateTransform>`, `<animateMotion>`), so motion happens INSIDE the SVG
— orbiting electrons, pulsing hearts, flowing currents — not just
cross-fades between static slides. Player adds Ken-Burns pan/zoom for a
cinematic feel. Newer animations get the upgrade automatically; older
saved ones still play (just without the embedded SMIL motion).

**One database migration to apply** before the X-Ray answers persist and
the quiz-time recommendation gets stored:

```sql
-- supabase/migrations/17_xray_answers_and_quiz_time.sql
alter table public.past_paper_xray_questions
  add column if not exists answer text,
  add column if not exists explanation text;
alter table public.quizzes
  add column if not exists recommended_minutes int;
```

Without it the UI still works — the X-Ray detail page shows a yellow
fallback banner explaining how to enable answers, and the time
recommendation displays but isn't written to the row.

**Pending decision** (not yet built): whether to add a destructive
"Permanently delete student" button (school-admin-only) that fully
removes the auth user and frees the username. Current soft-remove keeps
data forever; the username stays locked to the orphan account. Parked
in `SESSION_NOTES.md` task #10.

---

## 🗂️ Previous session — 2026-04-28
**(See full notes below — kept for context.)**

_Original heading was: Latest session — 2026-04-28_

Two big landings this session:

**Paid-subscription flow** — End-to-end Razorpay test-mode is live, `/pricing`
is now public (no auth wall), and a friend can be sent a pricing link and
pay-and-go in one continuous flow. Two `ON CONFLICT` bugs caused by the
partial unique index on `subscriptions.user_id` were fixed — they had been
masquerading as the dreaded "Database error saving new user".

**Four killer features for independent students** — features that are uniquely
ours because they sit on top of Bloom-level data nothing else has:

1. **Teach-Back** (`/student/teach-back`) — Feynman-style. Student explains a
   topic in their own words; AI grades on Bloom's rubric (0–5 per level) and
   asks one Socratic follow-up question.
2. **Misconception Detective** (`/student/misconceptions`) — every wrong MCQ
   answer is diagnosed into a *specific* mental error, logged in a personal
   ledger with strike counts, and a one-click "Drill this" generates a
   3-question micro-quiz built to break the misconception.
3. **Bloom Climber** (`/student/climber`) — daily 5-min streak. 3 questions all
   at one Bloom level on one topic; nail 2/3 to master that rung and unlock
   the next. Streak resets if you skip a day.
4. **Past-Paper X-Ray** (`/student/xray`) — upload last year's paper as text or
   image; AI tags every question by Bloom level + topic, returns a heatmap
   plus 5 directive study targets ("Drill applying X to Y problems").

All four are gated behind a single new migration (`12_killer_features.sql`)
that creates the supporting tables with proper RLS.

**Four competitive-exam features for JEE/NEET/CAT-style aspirants** — added
in a second pass the same day after realizing Teach-Back is foundation-level
work, not exam-prep. Competitive aspirants need different things:

1. **Speed-Accuracy Trainer** (`/student/speed`) — Bloom-level target time per
   question. End-of-session 4-quadrant verdict (Fast+Right is exam-ready;
   Slow+Right means you need pace work).
2. **Distractor Trap Detector** (`/student/traps`) — classifies each wrong
   pick into one of 9 examiner-trap patterns. Pairs with Misconception
   Detective on the results page.
3. **Mock Rank Predictor** (`/student/rank`) — score → percentile → AIR
   estimate with per-exam Normal-CDF baselines for JEE Main, NEET, CAT.
   Independent-students-only.
4. **Doubt-Clearing AI Tutor** (`/student/tutor`) — Socratic chat, stateless,
   optionally deep-linked to a specific question via `?question_id=`.

Three of the four (Speed-Accuracy, Trap Detector, Tutor) are also wired into
the school-student dashboard. Schema additions live in
`13_competitive_exam_features.sql`.

**Exam Sprint Mode** — countdown + adaptive daily mission. Student picks an
exam date; dashboard shows a colour-tiered countdown banner; the sprint page
surfaces a 3-task daily mission whose composition shifts by phase
(Foundation → Practice → Sprint → Final week). Schema in
`14_exam_sprint.sql`.

**Three retention features (Concept Visualizer, Memory Tune-Up, Confidence
Calibration)** — visual learning + spaced repetition + metacognitive
calibration. Visualizer is an animated SVG-frame slideshow (cross-fade
between AI-generated frames feels animated without the fragility of asking
AI for a single complex animated SVG). Memory Tune-Up implements SM-2
spaced repetition keyed on `question_id`; one-click "add my mistakes to
memory" on the results page. Confidence Calibration captures pre-answer
self-ratings in the Speed-Accuracy Trainer and renders a stated-vs-actual
chart with negative-marking strategy. Schema in
`15_visualizer_srs_calibration.sql`.

**Three commercial-unlock features + a consolidation:**
1. **Parent Dashboard** at `/parent/[token]` — token-based read-only view of
   the student's progress that parents open without ever creating an
   account. Student manages links at `/student/parent`; can revoke any
   link instantly. Designed deliberately to NOT touch the auth surface.
2. **Voice AI Teacher** at `/student/voice-teacher` — speak doubt → hear
   answer back. Voice in/out via Web Speech API (browser-native, free, no
   extra AI cost). Reuses `/api/tutor/chat`. Animation panel on the side
   reuses Concept Visualizer.
3. **Concept Knowledge Graph** at `/student/graph` — visual map of every
   topic studied, mastery-coloured, with AI-inferred prerequisite arrows.
   Hand-rolled SVG layout (no graph-library deps). Cached for 24h to save
   Groq tokens.
4. **Bloom Climber → Memory Tune-Up.** Climber and Memory were both daily
   rituals; merged into one. The streak counter from `bloom_climber_streaks`
   now appears on the Memory page. `/student/climber` is now a redirect
   stub for back-compat. Schema additions in `16_parent_links_and_graph.sql`.

See **CONTEXT.md** in the project root for the working notes I keep between
sessions; this README captures the durable changes.

---

## 🌅 Start here tomorrow morning

If you're picking up where we left off and login was misbehaving, do this **in this exact order** before anything else:

### 1. Reset the dev environment cleanly

```powershell
# In project root, dev server stopped (Ctrl+C in its terminal)
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item -Recurse -Force .next -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force node_modules\.cache -ErrorAction SilentlyContinue
npm run dev
```

### 2. Clear the browser's stale auth tokens

Open `http://localhost:3000` in an **incognito / InPrivate** window. Or in your normal window:
- Press `F12` → **Console** tab
- Run: `localStorage.clear(); sessionStorage.clear(); location.reload();`

The `<AuthHealer />` component (in `components/AuthHealer.tsx`, mounted in `app/layout.tsx`) should now also do this automatically on app boot when it detects a stale refresh token.

### 3. Recreate test accounts via the script (bypasses email confirmation)

```powershell
node scripts/create-test-account.js teacher    test.teacher@example.com    TestPass123! "Test Teacher"    --reset
node scripts/create-test-account.js student    test.student@example.com    TestPass123! "Test Student"    --reset
node scripts/create-super-teacher.js           test.principal@example.com  TestPass123! "Test Principal"  --reset
```

**Then sign in at `/login`** with any of those emails and `TestPass123!`. They should all work without email confirmation.

### 4. If still broken — diagnostic order

1. **Browser DevTools → Console** — look for red errors. Most useful clues:
   - `Refresh Token Not Found` → run the localStorage snippet from step 2
   - `Could not find the 'X' column of 'Y' in the schema cache` → migration X not applied; run it in Supabase SQL Editor + `notify pgrst, 'reload schema';`
   - Any other red error → paste it for diagnosis
2. **Dev-server terminal** — same, look for red error text. Compile errors live here.
3. **Supabase dashboard → Authentication → Providers → Email** — make sure `Confirm email` is **OFF** (otherwise signup-form accounts can't sign in until they click an email link).

---

## 📦 Tech stack

| Part | Tool |
|------|------|
| Framework | Next.js 16 (App Router, **webpack — Turbopack disabled**) + React 19 + TypeScript |
| Styling | Tailwind CSS v4 |
| Database + Auth | Supabase (Postgres, RLS, email/password) |
| AI text | Groq (Llama 3.3 70B versatile) |
| AI vision | Groq (Llama 4 Scout multimodal) — for past-paper / image generation |
| Charts | Recharts |
| Excel | SheetJS (xlsx) |
| PDFs (per-student reports) | jsPDF + jspdf-autotable |
| PDFs (exam papers) | Browser print → Save as PDF |
| Email | Nodemailer (Gmail SMTP) |
| Payments | **Razorpay** (orders + HMAC verify, INR / UPI / cards / netbanking) |

---

## 🔐 Environment variables (`.env.local`)

```
NEXT_PUBLIC_SUPABASE_URL=https://vgmhqxzbhgoscuwwssoo.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJh...
NEXT_PUBLIC_GROQ_API_KEY=gsk_...
SUPABASE_SERVICE_ROLE_KEY=eyJh...      # service-role — admin ops only, server-side only
```

Optional (weekly digest email):
```
EMAIL=youraccount@gmail.com
PASS=your_gmail_app_password
DIGEST_FROM=BloomIQ <youraccount@gmail.com>
```

Razorpay (test or live mode — the code is mode-agnostic, just swap keys):
```
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
```

`SUPABASE_SERVICE_ROLE_KEY` is required for the Add Student / Reset Password / Co-teacher invite flows. Get it from Supabase dashboard → Settings → API → service_role.

---

## 🗄️ Database migrations — must run in order

All migrations live in `supabase/migrations/`. Run each one in the **Supabase SQL Editor** (web UI). They are additive and idempotent — re-running them is safe.

| File | What it adds |
|---|---|
| `supabase/schema.sql` | Original tables: profiles, question_bank, quizzes, quiz_questions, quiz_attempts, attempt_answers, alerts |
| `01_classes_and_assignments.sql` | classes, class_members, quiz_assignments + RLS |
| `02_student_modes_and_subs.sql` | profiles.username, is_school_student, parent_email; subscriptions table; handle_new_user trigger |
| `03_governance_and_audit.sql` | student_logins, student_password_resets, attempt IP/UA columns |
| `04_multi_teacher_classes.sql` | class_teachers table (primary + co-teacher), is_class_teacher / is_class_primary helpers, RLS rewrite |
| `05_topic_family.sql` | quizzes.topic_family for similar-topic grouping in progress reports |
| `06_class_naming_and_school.sql` | classes.subject + section, schools table, profiles.school_id, super_teacher role + RLS |
| `07_school_join_code.sql` | schools.join_code so teachers can self-join via a code |
| `08_exam_papers.sql` | exam_papers + exam_paper_questions (separate from quizzes — printable, multi-type) |
| `09_teacher_invites.sql` | `class_teacher_invites` table; extended `handle_new_user` trigger auto-claims invites by email match on signup |
| `10_subscription_limits.sql` | `subscription_limits` table; `check_attempt_quota` trigger (3 distinct quizzes/24h on free); `attempts_remaining_today` RPC |
| `11_school_subscriptions.sql` | `subscriptions.school_id`, **partial unique indexes** (`subs_one_per_user where user_id is not null`, `subs_one_per_school where school_id is not null`), `subs_owner_xor` CHECK |
| `12_killer_features.sql` | Foundation for the four killer features: `teach_back_sessions`, `misconceptions` (with partial unique on `user_id, label`), `bloom_climber_state`, `bloom_climber_streaks`, `past_paper_xrays`, `past_paper_xray_questions`. All RLS-scoped to `auth.uid()`. |
| `13_competitive_exam_features.sql` | Foundation for the four competitive-exam features: `speed_sessions` (per-question timing as jsonb), `distractor_traps` (event log keyed by trap_type), `mock_rank_predictions` (score → AIR history). Doubt-Tutor is intentionally stateless (no table). All RLS-scoped to `auth.uid()`. |
| `14_exam_sprint.sql` | `exam_sprint_settings` — one row per user with exam_type, exam_date, target_air. Drives the dashboard countdown banner and the daily 3-task mission. RLS-scoped to `auth.uid()`. |
| `15_visualizer_srs_calibration.sql` | Three more retention features: `concept_animations` (jsonb frame-by-frame SVG slideshows), `srs_reviews` (SM-2 spaced-repetition queue keyed by question_id, partial unique on `(user_id, question_id)`), `confidence_calibrations` (per-event log of self-rated confidence + outcome). All RLS-scoped to `auth.uid()`. |
| `16_parent_links_and_graph.sql` | `parent_invites` (token-based read-only parent dashboard links — no parent auth account needed) + `knowledge_graphs` (cached AI-inferred concept graph per user). RLS-scoped where it matters; the parent endpoint deliberately uses the service-role client + token validation to bypass RLS. |
| `17_xray_answers_and_quiz_time.sql` | Two additive columns: `past_paper_xray_questions.answer` + `.explanation` (so X-Rays carry the AI-generated answer key + reasoning trail per question) and `quizzes.recommended_minutes` (so the time-limit suggestion shown at quiz-creation can be persisted alongside the teacher's chosen `time_limit_minutes` for later analytics). Idempotent — safe to re-run. |

> ⚠️ **Partial-index gotcha.** Migration 11 makes the unique on `subscriptions.user_id`
> partial. Postgres can't match a partial index from a bare `ON CONFLICT (user_id)`
> clause — any code that does so aborts the txn with *"no unique or exclusion
> constraint matching the ON CONFLICT specification"*, which Supabase Auth then
> re-surfaces as the misleading *"Database error saving new user"*. Two places
> are already patched: the `handle_new_user` trigger uses
> `on conflict (user_id) where user_id is not null do nothing`, and
> `/api/checkout/verify` does a SELECT → UPDATE/INSERT instead of `.upsert(...)`.
> If you add another writer to `subscriptions`, follow the same rule.

After running migrations, also run once: `notify pgrst, 'reload schema';` to refresh the API cache.

---

## 👥 The role model

There are now **three roles** + **two student modes**:

```
Profiles.role:
  ├── teacher              — manages classes, generates quizzes, grades
  ├── super_teacher        — Admin Head (typically Principal); sees everyone in their school
  └── student
       ├── is_school_student=true  — created by a teacher; logs in with USERNAME (no email needed)
       └── is_school_student=false — independent learner with a subscription; logs in with EMAIL
```

> Note: the **internal role name** stays `super_teacher` for backwards
> compatibility, but the user-facing label everywhere in the UI is **Admin Head**.
> One school has exactly one Admin Head (enforced by a partial unique index on
> `schools.super_teacher_id`); ownership can be transferred via
> `/api/admin/school/transfer`.

**Routes by role on login:**
- teacher → `/teacher`
- super_teacher → `/school`
- student → `/student` (the home page detects `is_school_student` and shows different UI)
- anyone (including logged-out visitors) → `/pricing`

**School student auth:** synthetic email `<username>@bloomiq.invalid`, never delivered to. The login page auto-detects: any input without `@` is treated as a username and synthesised before being sent to Supabase.

---

## ✅ What's built (status as of last working session)

### Authentication
- ✅ Single-input login (email or username, auto-detect)
- ✅ Three-role signup with role picker step (`/signup` → pick → `/signup?role=X`)
- ✅ Signup also accepts `?intent=pro&plan=<id>` so a logged-out visitor on `/pricing` can pay-and-go in one continuous flow
- ✅ School-student accounts created by teacher (no email)
- ✅ Login audit (IP + user-agent) on every signin — best-effort, can never block sign-in
- ✅ `student_logins.user_id` FK now references `auth.users(id)` (was `profiles(id)`) so it's resilient to profile-creation order
- ✅ Single-session enforcement for **independent students only** (teachers and Admin Heads stay multi-device)
- ✅ Password-reset by primary teacher for school students
- ✅ AuthHealer component clears stale tokens automatically
- ⚠️ **Known issue**: brittle when local storage has old tokens after a DB wipe. Solution = AuthHealer + the localStorage clear snippet. If you wipe the DB while logged in, refresh the browser.

### Payments & subscriptions (added 2026-04-28)
- ✅ **Public `/pricing`** — sticky top bar with Sign in / Create account, hero, plan cards (Free / Monthly ₹99 / Annual ₹999), school block, FAQ
- ✅ **Cold-visitor pay flow** — `/pricing` → "Get this plan" → `/signup?intent=pro&plan=<id>` → Razorpay opens automatically via `?autostart=<id>` → full "you're all set" success screen with name, email, expiry, and "Start practicing" CTA into `/student`
- ✅ **Logged-in upgrade** — same `/pricing` page; "Upgrade" opens Razorpay directly
- ✅ Plan-aware CTAs ("Current plan" / "Upgrade" / "Get this plan") based on auth state and current tier
- ✅ `POST /api/checkout` — server-side Razorpay order creation, plan catalog, INR paise conversion
- ✅ `POST /api/checkout/verify` — HMAC-SHA256 signature check + order-notes cross-check + SELECT-then-UPDATE/INSERT into `subscriptions` (avoids the partial-index `ON CONFLICT` trap)
- ✅ Free-tier daily cap (3 distinct quizzes / 24h) — independent students only, enforced by `check_attempt_quota` trigger
- ⚠️ Razorpay test cards `4111…` will fail with "International cards not supported" by default — use UPI ID `success@razorpay`, or a domestic card (e.g. `5267 3181 8797 5449`), or enable International payments in Razorpay dashboard

### Teacher
- ✅ `/teacher` home — quick stats, recent quizzes, school-membership card with join-by-code
- ✅ `/teacher/generate` — 4-source question generation (Topic / Topic+Syllabus / Notes / Image), Bloom level picker (all 6 OR up to 5 custom), questions-per-level, numerical-questions %
- ✅ `/teacher/review` — edit / approve / reject; bulk select for batch approve/reject
- ✅ `/teacher/quizzes` — list of quizzes
- ✅ `/teacher/quizzes/new` — Quiz Composer (two-pane, library + composition with reorder), shows full question content (stem + options + explanation), mixed-topics warning, auto-classify into topic_family
- ✅ `/teacher/quizzes/[id]` — assignment system: assign to entire class OR specific students, with optional due date
- ✅ `/teacher/classes` — list with role pills (Primary / Co-teacher), structured class naming (Grade · Subject · Section), duplicate prevention
- ✅ `/teacher/classes/[id]` — manage roster, primary-only Add Student with duplicate-detection panel and "use existing" path, co-teacher invites by email, last-login + IP-anomaly governance
- ✅ `/teacher/analytics` — quiz dropdown, action-items card (auto-computed: submission gaps, at-risk students, misconceptions, Bloom-level gaps, quality flags), problem-questions filter (default <70%), score distribution, time analysis, expandable per-student rows with answer drill-down
- ✅ `/teacher/reports` — period + class filters; **By quiz** (class summary Excel, per-student PDFs), **Term-wide** (term summary 6-sheet workbook, topic mastery matrix, question quality audit), **Communications** (weekly digest)
- ✅ `/teacher/papers` — Exam Paper Generator (separate from online quizzes)
- ✅ `/teacher/papers/new` — template-driven (presets or custom sections), six question types, marks per question, source picker incl. past-paper
- ✅ `/teacher/papers/[id]` — review / edit / reorder / finalize, danger-zone delete
- ✅ `/teacher/papers/[id]/print` — browser-print-ready, with toggleable answer key

### Admin Head (super_teacher / Principal)
- ✅ `/school` — set-up flow (name school → get join code), school-wide stats, per-teacher activity, classes table, **inline rename school** + **Transfer Admin Head card** (atomic via `/api/admin/school/transfer`)
- ✅ `/school/teachers` — invite by email OR share school code, manage list
- ✅ `/school/classes` — **Admin Head creates classes here**, independent of teacher assignment; standardised `Grade {N} · Section {X}` template with Other-specify dropdowns, optional primary teacher by email (auto-claims via `class_teacher_invites` if teacher signs up later)
- ✅ `/school/students` — top performers, at-risk, full searchable list
- ✅ `/school/reports` — **Bloom Pulse** school-wide report: PieChart by Bloom level, BarChart by class, teacher activity, class leaderboard, at-risk students; PDF / Excel / Copy export
- ✅ Cross-school RLS so the Admin Head sees everything in their school via `is_super_for_school` helper
- ✅ One-school-per-Admin-Head enforced by partial unique index on `schools.super_teacher_id`

### School student
- ✅ `/student` — home with assigned-quiz list (urgency-coloured cards: red overdue, amber due-soon, slate normal), full timing info (date, time, relative countdown, time limit, question count, subject)
- ✅ `/student/join` — enter quiz code
- ✅ `/student/classes` — join classes by code, leave class
- ✅ `/student/quiz/[code]` — distraction-free quiz interface

### Independent student
- ✅ `/student` — home detects `is_school_student=false`, shows different UI: big "Generate test" CTA, exam-prep hook, **"Boost your learning" tile grid** (the four features below), Bloom mastery preview, recent tests
- ✅ `/student/generate` — same 4 sources as teacher PLUS a 5th highlighted "Past question paper" tile (badge: "🎯 Exam prep")
- ✅ `/student/tests` — list of self-generated tests with retake button
- ✅ `/student/progress` — **redesigned**: radar chart of Bloom mastery, focus-area pills, per-topic bar charts with %, timeline bar chart with % labels (no overlapping numbers)
- ✅ `/student/flashcards` — AI-generated flashcards on weak Bloom levels / topics, card-flip UI with "Got it / Need more practice"

### Independent student — killer features (added 2026-04-28)

These four are unique to BloomIQ because they sit on top of Bloom-level data.
All four reuse the existing Groq wrapper (`lib/groq.ts`) and the bearer-token
auth pattern.

- ✅ **Teach-Back** (`/student/teach-back`)
  - `POST /api/teach-back/grade` — accepts `{topic, explanation}` and returns
    `bloom_scores` (0–5 per level), `overall_score` (0–100, weighted toward
    higher Bloom levels), `strengths`, `gaps`, and a Socratic `follow_up_q`.
  - `POST /api/teach-back/follow-up` — student answers the follow-up; AI gives
    a short verdict and persists it on the same `teach_back_sessions` row.
  - Page shows the Bloom scorecard, strengths/gaps split, the follow-up panel,
    and a history table of past attempts.

- ✅ **Misconception Detective** (`/student/misconceptions`)
  - `POST /api/misconception/diagnose` — given an `attempt_id`, walks every
    wrong answer, asks Groq to infer the *specific* mental error per question,
    and upserts each unique misconception (de-duped by `label`). Repeat
    misconceptions bump `strikes` instead of inserting duplicates. Done in a
    SELECT → UPDATE-or-INSERT loop because PostgREST can't `onConflict` against
    the partial unique on `(user_id, label) where user_id is not null`.
  - `POST /api/misconception/drill` — given a `misconception_id`, generates 3
    targeted MCQs, inserts them into `question_bank`, creates a `quizzes` row,
    and returns the quiz code so the student is redirected straight into the
    standard quiz UI at `/student/quiz/[code]`.
  - `POST /api/misconception/resolve` — toggle resolved state (manual; we
    don't auto-resolve on a passed drill).
  - Wired into `/student/results/[id]`: a "Diagnose my mistakes" panel appears
    on completed attempts that have at least one wrong answer.

- ✅ **Bloom Climber** (`/student/climber`)
  - `POST /api/climber/today` — picks the student's most-recent topic (or an
    explicit override), looks up which Bloom levels are already mastered for
    that topic, and generates 3 MCQs all at the *next un-mastered* rung.
  - `POST /api/climber/complete` — records score; a 2/3 ratio masters that
    rung. Streak math: same-day repeats keep streak, next-day continues
    streak, missed day resets streak to 1. UTC calendar dates.
  - Page shows current/longest streak, total climbs, the per-topic Bloom
    ladder with locked rungs above today's, and a real-time graded view of
    the 3 questions.

- ✅ **Past-Paper X-Ray** (`/student/xray`, detail at `/student/xray/[id]`)
  - `POST /api/xray/analyze` — accepts either pasted text (up to 30k chars)
    or a base64 image data URL (up to ~6 MB). For images, uses
    `groqJSONVision` against Llama 4 Scout. AI tags each question by Bloom
    level + topic, returns `paper_title`, the per-question list, a Bloom
    breakdown, a topic breakdown, and exactly 5 directive recommendations.
  - Detail page shows a Bloom heatmap, topic pills, the recommendations as a
    numbered list, and a per-question table with badge-coded Bloom levels.

### Independent student — competitive-exam features (added 2026-04-28, second pass)

These four target JEE / NEET / CAT-style aspirants. The first three are also
exposed to school students (in a slim 3-tile strip on `/student`); Mock Rank
Predictor is independent-only.

- ✅ **Speed-Accuracy Trainer** (`/student/speed`) — Bloom-level-driven target
  times per question (Remember 30s, Understand 45s, Apply 75s, Analyze/Evaluate
  90s, Create 120s). End-of-session 4-quadrant verdict: Fast+Right (exam-ready),
  Slow+Right (pace work), Fast+Wrong (impulsive), Slow+Wrong (study more).
  - `POST /api/speed/start` — generates 5–15 mixed-Bloom MCQs weighted toward
    Apply/Analyze (the levels JEE/NEET test most).
  - `POST /api/speed/submit` — server-recomputes the quadrant counts (so
    leaderboards can't be faked client-side) and persists.

- ✅ **Distractor Trap Detector** (`/student/traps`) — classifies each wrong
  pick into one of nine examiner-trap types (`unit_confusion`, `sign_error`,
  `not_misread`, `off_by_one`, `plausible_formula`, `partial_application`,
  `mismatched_units`, `distractor_close_value`, `definition_swap`).
  - `POST /api/traps/diagnose` — same surface as `misconception/diagnose`.
    Wired into the results page via a "Find my traps" panel that sits next
    to the Misconception Detective panel.
  - Page shows per-type counts plus a recent-traps log.

- ✅ **Mock Rank Predictor** (`/student/rank`) — score → percentile → AIR
  estimate against per-exam baselines (JEE Main, NEET, CAT, Custom). Uses a
  Normal-CDF approximation tuned with per-exam mean/stddev percent of max.
  - `POST /api/rank/predict` — accepts either `attempt_id` (auto-pulls
    score) or raw `raw_score`+`max_score`. Best-effort calls Groq for 3
    high-leverage study directives based on the per-Bloom-level breakdown.
    AIR persistence is best-effort — if the insert fails, the prediction is
    still returned to the user.
  - School students see a friendly "Mock Rank Predictor is for exam aspirants"
    notice instead of the form.

- ✅ **Doubt-Clearing AI Tutor** (`/student/tutor`) — Socratic chat. Stateless
  on the server (each turn re-sends history). Optionally anchored to a
  specific `?question_id=` for deep-linking from any quiz UI.
  - `POST /api/tutor/chat` — uses `groqText` (plain completion). System
    prompt enforces "ask before answering, walk through in steps, no answer
    dumps." Hard cap at 20 turns of history per call so prompts can't balloon.
  - v1 keeps no DB rows. Adding `tutor_sessions`/`tutor_messages` is on the
    backlog for when persistence proves useful.

- ✅ **Concept Visualizer** (`/student/visualizer`) — animated SVG-frame
  slideshow. The "animation" is a cross-fade between 3–5 AI-generated
  labeled SVG frames + per-frame caption + auto-advance. More reliable than
  asking AI for a single complex animated SVG (which often breaks).
  - `POST /api/visualizer/create` — Groq returns `{title, summary, frames}`;
    server sanitises each SVG (strips `<script>`, `<foreignObject>`, on*
    handlers, javascript: URLs) before persisting to `concept_animations`.
  - Page renders frames via `dangerouslySetInnerHTML` (safe because of the
    sanitiser) inside an aspect-ratio container, with prev/play/next/restart
    controls and a per-frame progress bar.

- ✅ **Memory Tune-Up** (`/student/memory`) — spaced repetition (SM-2
  algorithm) on wrong answers from any quiz. Anki-style 4-button rating
  (Again / Hard / Good / Easy). Re-clicking enqueue is idempotent.
  - `POST /api/srs/enqueue` — accepts an `attempt_id` (auto-extracts every
    wrong question) or an explicit `question_ids[]`. Uses SELECT → INSERT
    pattern so we never trip the partial-unique ON CONFLICT trap.
  - `GET /api/srs/due?limit=` — returns due-today cards with question payload
    joined from `question_bank`, plus queue stats (total + due_today).
  - `POST /api/srs/review` — applies SM-2: rating <3 resets reps and pushes
    interval to 1 day; rating ≥3 advances reps and multiplies interval by
    easiness factor. Easiness floors at 1.3, interval caps at 365 days.
  - The results page now has an "Add my mistakes to memory" button that
    bulk-enqueues every wrong answer from the just-completed attempt.

- ✅ **Confidence Calibration** (`/student/calibration`) — track how well your
  gut matches reality. Currently captured from the Speed-Accuracy Trainer
  (one-tap pre-answer rating: Guess / Probably not / Probably / Sure).
  - `POST /api/calibration/log` — bulk insert of events at end of session.
    Events carry source ('speed' | 'quiz' | 'srs'), confidence 1–4,
    was_correct, optional bloom_level + topic.
  - Profile page renders a stated-vs-actual chart per band, an overall
    calibration gap, and a negative-marking strategy ("attempt only Sure
    picks on -1/+4 papers").
  - Speed-Accuracy session UI now shows a 4-button confidence picker above
    the answer options. Optional — students who skip it just don't log
    calibration data for that question.

- ✅ **Exam Sprint Mode** (`/student/sprint`) — countdown + adaptive daily
  mission. The student picks an exam (JEE Main / NEET / CAT / Custom) and a
  date. The dashboard then shows a colour-tiered countdown banner (emerald
  >30 days, orange <30, red <7) and the sprint page surfaces a 3-task
  mission whose composition shifts by phase:
  - **Foundation (>60d):** Teach-Back · Bloom Climb · Past-Paper X-Ray
  - **Practice (30–60d):** Speed-Accuracy · Mock Rank Predictor · Misconception drill
  - **Sprint (7–29d):** Speed-Accuracy (intense) · Trap Detector review · Climb 1 rung
  - **Final week (<7d):** Misconceptions resolution · Trap profile review · Doubt Tutor
  - `POST /api/sprint/save` — upsert (or clear) the user's exam settings.
    Uses SELECT → UPDATE/INSERT pattern for consistency with the rest of
    the writers, so future copies of this code don't trip the partial-index
    ON CONFLICT trap.
  - `GET /api/sprint/today` — returns settings + days_remaining + phase +
    mission. Each task carries a `done` flag computed from real activity in
    the existing feature tables today (no new completion table needed).
  - The dashboard reads `exam_sprint_settings` directly client-side with a
    try/catch fallback, so a missing migration 14 silently degrades to "no
    sprint" rather than breaking the dashboard.

### Cross-cutting
- ✅ Topic-family classifier (`lib/classifier.ts`) — LLM-grounded with user's existing families to keep names consistent
- ✅ Numerical-questions % slider (auto-ignored for non-numerical topics)
- ✅ Anti-abuse: login audit, IP/UA tracking, "3+ IPs in 7d" suspicious flag
- ✅ Class naming standards: `Grade {N} · Section {X}` with Other-specify dropdowns; subject lives on `class_teachers` (per-teacher, not per-class) so a single class can be team-taught
- ✅ Past-paper handling: mixed format input (MCQ / essay / short-answer) collapses to MCQ output preserving topic + difficulty
- ✅ PWA manifest + service worker (installable on mobile)

---

## 🐛 Known issues

| Issue | Workaround | Permanent fix |
|---|---|---|
| Login fails after DB wipe — stale localStorage | Run `localStorage.clear(); location.reload();` in DevTools console | AuthHealer component (already added — verify it's in `app/layout.tsx`) |
| `Refresh Token Not Found` console error | Same as above — clear localStorage | Same |
| `Could not find 'X' column in schema cache` | Run the relevant migration in Supabase SQL Editor + `notify pgrst, 'reload schema';` | One-time setup |
| `there is no unique or exclusion constraint matching the ON CONFLICT specification` | The unique on `subscriptions.user_id` is partial — never write `on conflict (user_id)` against this table. Use SELECT → UPDATE/INSERT or add the matching `where user_id is not null` predicate. | Already fixed in trigger + verify endpoint |
| `insert or update on table "student_logins" violates foreign key constraint` | FK now points to `auth.users(id)` on delete cascade; login-audit endpoint also wrapped in try/catch and never 500s | Already fixed |
| `International cards are not supported` in Razorpay | Use UPI ID `success@razorpay`, or a domestic Indian test card | Toggle "International payments" in Razorpay dashboard if you actually want to accept them |
| Email-confirmation block on signup-form accounts | Disable in Supabase: Auth → Providers → Email → uncheck "Confirm email" | Switch to a real transactional email provider |
| Next.js dev "Rendering" / "Building" pill | `devIndicators: false` in `next.config.ts` (already set; restart dev server to pick up) | Already fixed |
| Click-then-blank-then-loads in dev | Switched dev script from Turbopack to **webpack** in `package.json` (`"dev": "next dev --webpack"`); React Compiler **off** in `next.config.ts`; service worker proactively unregistered in dev by `components/PWARegister.tsx` | Already fixed |
| React Strict Mode lock contention on quiz page | Currently no special handling. If `Lock was released` errors return, options: disable Strict Mode, or revisit the no-op lock approach |  |
| Some teachers' classes not seen in /school | Ensure they joined the school (entered the code from /teacher home, or were invited by email from /school/teachers) | UX improvement: prompt unjoined teachers |

---

## 🧪 Test scripts

`scripts/` directory:

```bash
# Independent student (or any role-specific student)
node scripts/create-test-account.js student   email   password   "Name"   [--reset]
node scripts/create-test-account.js teacher   email   password   "Name"   [--reset]

# Super-teacher (principal)
node scripts/create-super-teacher.js          email   password   "Name"   [--reset]
```

`--reset` deletes the existing user with that email before recreating, so you always end up with the credentials you typed. All accounts created this way bypass email confirmation (`email_confirm: true`).

---

## 🗑️ Wipe and start fresh

In Supabase SQL Editor:

```sql
delete from auth.users;       -- cascades to almost everything
delete from public.schools;   -- not auto-deleted (super_teacher_id is SET NULL)

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

Then **clear browser localStorage** (Console: `localStorage.clear()`) and run the test scripts above to recreate accounts.

---

## 📁 File map (current)

```
app/
  page.tsx                        landing
  login/, signup/                 auth (signup is two-state: role picker → form)
  teacher/
    page.tsx                      home — stats, recent quizzes, school join card
    generate/                     paste/topic/syllabus/notes/image → questions
    review/                       bulk edit / approve / reject
    quizzes/                      list + new (composer) + [id] (detail w/ assignments)
    classes/                      list + [id] (members + co-teachers)
    analytics/                    action-items + problem questions + drilldowns
    reports/                      filtered Excel reports + digest
    papers/                       exam paper generator (template-driven, printable)
      new/, [id]/, [id]/print/
  school/                         super-teacher (principal) area
    page.tsx                      home + setup
    teachers/, classes/, students/  management surfaces
  student/
    page.tsx                      branches by is_school_student; "Boost your learning" tile grid
    generate/, tests/, progress/  independent-student area
    teach-back/                   ★ Feynman-style explain-the-topic grader
    misconceptions/               ★ personal misconception ledger w/ "Drill this"
    climber/                      ★ daily 5-min Bloom Climber streak
    xray/, xray/[id]/             ★ past-paper upload + heatmap detail
    speed/                        ★ Speed-Accuracy Trainer (timed by Bloom level)
    traps/                        ★ Distractor Trap profile
    rank/                         ★ Mock Rank Predictor (independent-only)
    tutor/                        ★ Doubt-Clearing AI Tutor (Socratic chat)
    sprint/                       ★ Exam Sprint Mode — countdown + daily mission
    visualizer/                   ★ AI Concept Visualizer (animated SVG slideshow)
    memory/                       ★ Memory Tune-Up (SM-2 spaced repetition; absorbed Bloom Climber's daily streak)
    calibration/                  ★ Confidence Calibration profile
    voice-teacher/                ★ Voice AI Teacher (Web Speech API + animated explainer)
    graph/                        ★ Concept Knowledge Graph (mastery-coloured + prerequisite arrows)
    parent/                       ★ Parent magic-link manager (student side)
    climber/                      stub redirect to /student/memory (folded in)
    join/, classes/                school-student area
    quiz/[code]/                  test interface (also handles drill quizzes)
    results/[id]/                 results page; "Diagnose my mistakes" panel
  pricing/                        public pricing page; Razorpay autostart on ?autostart=
  api/
    generate/                     teacher question generation (review queue)
    student/quick-test/           student instant test (auto-approved)
    flashcards/                   Groq-generated flashcards by Bloom level + topic
    teach-back/grade/             ★ grade an explanation on Bloom rubric
    teach-back/follow-up/         ★ grade the answer to the Socratic follow-up
    misconception/diagnose/       ★ per-attempt diagnosis loop
    misconception/drill/          ★ generate 3-question micro-quiz
    misconception/resolve/        ★ toggle resolved state
    climber/today/                ★ generate today's 3-question climb
    climber/complete/             ★ record result + advance streak/mastery
    xray/analyze/                 ★ tag every question on a past paper
    speed/start/, speed/submit/   ★ generate timed batch + persist quadrant counts
    traps/diagnose/               ★ classify wrong picks into examiner-trap types
    rank/predict/                 ★ score → percentile → AIR estimate
    tutor/chat/                   ★ stateless Socratic chat completion
    sprint/save/, sprint/today/   ★ exam settings + adaptive mission compute
    visualizer/create/            ★ generate animated SVG-frame slideshow
    srs/enqueue/, srs/due/, srs/review/  ★ SM-2 spaced repetition queue
    calibration/log/              ★ confidence-event bulk insert
    parent/invite/, parent/data/  ★ parent magic-link CRUD + token-authed dashboard
    graph/build/                  ★ AI-inferred concept graph w/ 24h cache
    papers/generate/              exam paper generation
    quizzes/[id]/classify/        topic-family classifier endpoint
    checkout/                     Razorpay order creation (POST /api/checkout)
    checkout/verify/              HMAC verify + flip subscription tier
    admin/students/               teacher creates school-student account
    admin/students/[id]/reset-password/
    admin/students/add-existing/  reuse student instead of duplicate
    admin/classes/                Admin Head class CRUD
    admin/classes/[id]/primary/   primary teacher (by id or email — pending invite)
    admin/classes/[id]/co-teachers/
    admin/school/teachers/        Admin Head invites teachers
    admin/school/transfer/        atomic Admin Head transfer
    school/join/                  teacher self-joins school by code
    login-audit/                  IP/UA capture on signin (best-effort, never 500s)
    report/[attemptId]/           per-attempt PDF
    digest/                       weekly email digest
    recommendations/, commentary/, alerts/

components/
  AuthHealer.tsx                  ← clears stale tokens on app boot
  PWARegister.tsx                 service worker registration
  Sidebar.tsx                     role-aware navigation
  BloomBadge.tsx, BloomChart.tsx, Empty.tsx

lib/
  supabase/client.ts              browser supabase singleton (no fancy config)
  supabase/server.ts              server + admin (service-role) clients
  groq.ts                         Groq SDK + JSON + vision wrappers
  bloom.ts                        Bloom levels metadata
  classifier.ts                   topic-family classifier (LLM-grounded)
  types.ts                        TypeScript types
  utils.ts                        helpers

supabase/
  schema.sql                      original schema (run first)
  migrations/01-16                additive migrations (run in order)
  RESET_AND_REBUILD.sql           concatenated drop+rebuild script

scripts/
  create-test-account.js
  create-super-teacher.js
```

---

## 🔮 Backlog / what to build next

In rough priority:

1. **Razorpay live-mode cutover** — code is mode-agnostic; only env vars change. Need real KYC + bank account on Razorpay first.
2. **Subscription cancel / manage UI** for the student (today: only the verify endpoint writes to `subscriptions`; no self-service cancel)
3. **School-plan purchase UI** — schema is ready (partial unique on `school_id`, `subs_owner_xor` CHECK), but currently "Talk to us" only on `/pricing`
4. **Razorpay webhook** at `/api/checkout/webhook` for resilience (independent of the verify path; same SELECT → UPDATE/INSERT pattern, never `onConflict`)
5. **Branded receipt email** via nodemailer in the verify endpoint (Razorpay sends its own receipt today)
6. Per-attempt **IP capture** on quiz submissions (schema ready: `quiz_attempts.ip` + `.user_agent`)
7. **Parent reports** for independent students (`profiles.parent_email` is ready)
8. **Mock-test mode** for independent students (timed, exam-style)
9. **Resend / SendGrid** instead of Gmail SMTP for digest reliability
10. **Cron-scheduled weekly digest** (Vercel Cron)
11. **PDF export** for exam papers (currently browser print only)
12. **Inline question edit** from the question bank (today: edit happens in Review only)
13. **Multi-page past-paper upload** (currently one image at a time)

---

## 📝 Notes

- The `_archive/` folder contains stale `.js` page files moved out of the route tree — safe to delete.
- The original `/teacher/bank` page was removed and now redirects to `/teacher/quizzes/new` (the Composer absorbed its purpose).
- The original `/student/independent` page was removed and now redirects to `/student`.
- Quiz codes and class codes use the same `generateQuizCode()` helper — a 6-char unambiguous code (no I/O/L/0/1).
- Synthetic email domain for school students: `bloomiq.invalid` (RFC reserved, never deliverable).

---

## 💤 Goodnight!

You've built a lot. Sleep well. The first thing to do tomorrow is the four steps under **🌅 Start here tomorrow morning** at the top — restart the dev server, clear browser storage, recreate test accounts, sign in. If anything still breaks, check Console + terminal and we'll trace it from there.
                tap-fast practice
    rank/                         ★ mock-exam rank predictor
    traps/                        ★ trap-detector (ETS-style distractor warnings)
    sprint/                       ★ exam-week 7-day sprint plan
    flashcards/                   AI flashcards on weak topics
    parent/                       parent dashboard hub
  parent/[studentId]/             public parent view of a student
  pricing/                        public pricing + Razorpay checkout
  terms/                          ★ Terms of Service (NEW)
  privacy/                        ★ Privacy Policy (NEW)
  auth/set-password/              ★ universal set-password screen (NEW)
  admin/                          ★ BloomIQ staff area (NEW)
    onboard-school/               provision a paying school by inviting its Admin Head
    team/                         manage who has platform_admin
  api/
    admin/                        admin RPCs (teachers, classes, transfer, ★ onboard-school, ★ team)
    school/                       super_teacher RPCs (join, digest, etc.)
    quizzes/, generate/, ...      teacher + student RPCs
    checkout/, checkout/verify/   Razorpay flow
components/
  Sidebar.tsx                     role-aware nav + ★ Platform Admin section for staff
  PublicNav.tsx                   ★ auth-aware top nav for / and /pricing
  AuthHealer.tsx                  best-effort recovery from broken sessions
  BloomBadge.tsx, BloomChart.tsx, BulkAddStudents.tsx, ...
lib/
  supabase/{client,server}.ts     Supabase clients (incl. service-role admin client)
  bloom.ts, bloomScore.ts         Bloom-level helpers
  groq.ts, gemini.js              AI provider wrappers
  exam/{scoring,code}.ts          exam scoring + join-code helpers
  utils.ts, types.ts              shared helpers + DB row types
supabase/migrations/              numbered SQL migrations (run in order in SQL editor)
tests/e2e/                        Playwright tests (auth helpers + per-role specs)
```

---

## 🤝 Contributing

This is a private project — see SESSION_NOTES.md for the working log,
CONTEXT.md for the architectural overview, and AGENTS.md for AI-agent
guidance when using Claude Code or similar tools to extend it.
 misconception buckets
    rank/predict/                 ★ predict mock-exam rank from past attempts
    sprint/today/, sprint/save/   ★ daily slice of the 7-day sprint plan
    flashcards/                   AI flashcards on weak topics
    parent/invite/, parent/data/  parent invite + read-only digest API
    checkout/, checkout/verify/   Razorpay flow
components/
  Sidebar.tsx                     role-aware nav + ★ Platform Admin section
  PublicNav.tsx                   ★ auth-aware top nav for / and /pricing
  AuthHealer.tsx, BloomBadge.tsx, BloomChart.tsx, BulkAddStudents.tsx, ...
lib/
  supabase/{client,server}.ts     Supabase clients (incl. service-role admin client)
  bloom.ts, bloomScore.ts         Bloom-level helpers
  groq.ts, gemini.js              AI provider wrappers
  exam/{scoring,code}.ts          exam scoring + join-code helpers
  utils.ts, types.ts              shared helpers + DB row types
supabase/migrations/              numbered SQL migrations (run in order in SQL editor)
tests/e2e/                        Playwright tests (auth helpers + per-role specs)
```

---

## 🤝 Contributing

Private project — see `SESSION_NOTES.md` for the working log,
`CONTEXT.md` for the architectural overview, and `AGENTS.md` for
AI-agent guidance when extending the codebase with Claude Code or
similar tools.
ansfer/    Admin Head transfer flow
    admin/onboard-school/         ★ NEW — platform admin provisions a school
    admin/team/                   ★ NEW — manage platform_admin team
components/
  Sidebar.tsx                     role-aware nav + ★ Platform Admin section
  PublicNav.tsx                   ★ NEW — auth-aware top nav (/ and /pricing)
  AuthHealer.tsx, BloomBadge.tsx, BloomChart.tsx, BulkAddStudents.tsx, ...
lib/
  supabase/{client,server}.ts     Supabase clients (incl. service-role admin)
  bloom.ts, bloomScore.ts         Bloom-level helpers
  groq.ts, gemini.js              AI provider wrappers
  exam/{scoring,code}.ts          exam scoring + join-code helpers
  utils.ts, types.ts              shared helpers + DB row types
supabase/migrations/              numbered SQL migrations (run in order)
tests/e2e/                        Playwright tests (auth helpers + role specs)
```

---

## 🤝 Contributing

Private project — see `SESSION_NOTES.md` for the working log,
`CONTEXT.md` for the architectural overview, and `AGENTS.md` for
AI-agent guidance when extending the codebase with Claude Code or
similar tools.
tions (run in order)
  RESET_AND_REBUILD.sql           concatenated drop+rebuild script
```

---

## 🤝 Contributing

Private project. See `SESSION_NOTES.md` for the working log,
`CONTEXT.md` for the architectural overview, and `AGENTS.md` for
guidance when extending the codebase with AI agents.
