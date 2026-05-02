# BloomIQ — QA scenarios pending for next session

Scenarios queued from the dev sessions on 2026-05-02 that haven't yet
been exercised end-to-end. Run alongside the existing regression list
in `QA_REPORT_2026-05-02.md`.

---

## Scenario U — Subscription upgrade with extension (Model B)

**Why this matters.** `app/api/checkout/verify/route.ts` previously
overwrote `expires_at` to `now + new period_days` on every successful
payment, which meant a user upgrading mid-cycle forfeited any unused
time on their old plan. We just switched it to **Model B (extension)**:

```ts
const oldExpiresMs = existing?.expires_at ? new Date(existing.expires_at).getTime() : 0;
const anchorMs    = Math.max(Date.now(), oldExpiresMs);
const expires_at  = new Date(anchorMs + planRow.period_days * 86400000).toISOString();
```

The user pays the full new-plan price, but their unused time stacks on
top of the new term.

### Setup

1. Have a personal-tier user with an **active** subscription. Easiest
   way to seed:
   - Sign in as `kmvipin@gmail.com` (or any independent student).
   - Buy **Premium Monthly** through `/pricing`. Razorpay test card
     `4111 1111 1111 1111`, any future expiry, any CVV, OTP `1234`.
   - Confirm in `subscriptions` table: `tier = 'premium'`,
     `started_at = now`, `expires_at ≈ now + 30 days`,
     `price_paid_paise` matches the Premium Monthly SKU.
2. Note down the exact `expires_at` value. Call it **T_old**.

### Action

3. **Wait at least a few minutes** (so `now` advances measurably past
   the original `started_at` — the extension only matters when there's
   non-zero unused time, but even one minute is enough to validate).
4. From the same logged-in session, go to `/pricing` and **upgrade to
   Premium Plus Quarterly**. Pay through Razorpay test mode again.

### Expected

5. After `verify` completes, query `subscriptions` for that user. The
   row should now have:
   - `tier = 'premium_plus'` (legacy mapping for `premium_plus`).
   - `plan_id` = the Premium Plus Quarterly plan UUID.
   - `started_at = now` (the anchor for the row, not the term anchor).
   - **`expires_at ≈ T_old + 90 days`** — the key assertion. Prior to
     this fix it would have been `now + 90 days`, losing ~30 days.
   - `price_paid_paise` matches the Premium Plus Quarterly SKU price
     (full amount, not prorated).

### Variant U.1 — already expired

Same setup, but advance the system clock or just let the old sub
naturally expire (set `expires_at` to a past timestamp directly via
SQL for speed). Repeat the upgrade. Expected: anchor falls back to
`now`, `expires_at = now + 90 days`. No surprise rollback to the old
expired-in-the-past anchor.

### Variant U.2 — renewal of same plan

User on Premium Monthly that's still active buys Premium Monthly
again (same plan). Expected: `expires_at = T_old + 30 days` (stacks
cleanly, same as upgrade). Confirms the math doesn't only fire on
tier changes.

### Variant U.3 — fresh subscriber (no prior sub)

User with no row in `subscriptions` buys Premium Monthly. Expected:
`expires_at = now + 30 days` (anchor falls back to `now` because
`oldExpiresMs = 0`). Confirms the `Math.max` doesn't break the new-
subscriber path.

---

## Scenario T — Teacher feature gate behind school join

**Why.** A teacher with no `school_id` previously had full access to
every `/teacher/*` route — no plan check fires when there's no plan.
We just gated this at the layout level.

### Setup

1. Sign up a fresh teacher account via `/signup`. Don't paste a
   school code during onboarding (or skip the join card).

### Expected behaviour

2. `/teacher` (home) → renders ONLY the welcome strip + "Join your
   school" card. No focus card, no stats trio, no recent tests
   section.
3. Try to navigate directly to `/teacher/quizzes`,
   `/teacher/generate`, `/teacher/live`, `/teacher/coach`,
   `/teacher/digest`, `/teacher/analytics`, `/teacher/reports`,
   `/teacher/papers`, `/teacher/review` — every URL should
   immediately `router.replace("/teacher")`.
4. Sidebar still shows the full navigation, but every link except
   Home (and the bottom nav: Profile/Help/Sign out) bounces back.
5. Paste a valid school code into the join card. The page reloads,
   `school_id` is set, and the full dashboard reveals itself with
   focus card, stats trio, recent tests. Direct URL navigation now
   works for all teacher routes.

---

## Scenario L — Lock-badge tier label by ladder

**Why.** Independent students were previously seeing "School Pilot"
labels on lock badges because `findUnlockingTier` searched all plan
rows. We just filtered by ladder (personal vs school).

### Setup

1. Sign up a fresh independent student. Don't pay; stay on free.
2. Go through onboarding (pick an exam goal — e.g., Class 10 boards).
3. Land on `/student`.

### Expected

4. Locked tiles like Misconception Detective, Past-Paper X-Ray,
   Trap Detector, Rank Predictor, Knowledge Graph, Concept Visualizer,
   Memory Tune-Up, Teach-Back, AI Tutor → **all show "Premium" or
   "Premium Plus"**. None should say "School Pilot" or any school-tier
   variant.
5. Repeat on `/student/train` and `/student/diagnose`. Same expectation.
6. (Inverse check) Sign in as a school student belonging to a school
   on the **School Pilot** plan. Their lock badges should say "School
   Standard" or "School Plus" for any feature their plan doesn't
   include — never "Premium" or "Premium Plus".

---

## Scenario S — School admin scope (no personal-practice leak)

**Why.** Five queries on `/school/*` previously fetched
`quiz_attempts.in("student_id", students)` without scoping by
quiz_id, so a school student's personal-practice attempts inflated
the school admin's roll-ups. Patched (Task #29 / #34).

### Setup

1. Have a school student (school plan = School Pilot). Have them
   submit:
   - **One class-assigned quiz** their teacher pushed.
   - **One personal-practice test** they generated themselves at
     `/student/generate`.
2. Note the score on each.

### Expected on the school admin views

Sign in as the school's super-teacher. Verify:

3. `/school` home → `Attempts` count = **1** (only the class quiz).
   `Avg ${stats.avgScore}%` = the class-quiz score, not a blend.
4. `/school/students` → that student's row shows `attemptCount = 1`,
   `avgScore` = class-quiz score.
5. `/school/classes` → the class row's `avgScore` = class-quiz score.
6. `/school/reports` → Bloom analysis / engagement / at-risk views
   contain ONLY the class-quiz attempt.
7. The student's own `/student/tests` (My Practice) still shows
   their personal-practice test (no leak in the other direction).

---

## Quick-fire smoke checks (do at the end if time permits)

- **Help page** loads at `/help`, role-aware content renders. Topics
  are collapsible. "Back to dashboard" link routes to the right home
  per role.
- **Profile page** at `/settings/profile`. Independent student can
  edit name + exam goal and Save. Teacher can edit name. Super-
  teacher can copy the school join code; uploading a logo replaces
  the avatar circle in the hero.
- **Sidebar single-click** — every nav link in the teacher /
  super-teacher / school-student sidebars should navigate on a single
  click (no double-click required). Hover state should appear / clear
  cleanly without flashing.
- **Live class quiz** — teacher hosts via `/teacher/live`, gets a
  6-char code, student types it on `/student/live`, plays through.
  Verify no live-quiz answer rows ever appear in `quiz_attempts` —
  they live in `live_session_answers` only.
- **School logo** — super-teacher uploads via `/settings/profile` →
  surfaces in profile hero. (Sidebar / school home logo placement is
  a future enhancement, not yet wired.)

---

## Test data quick-seed (PostgreSQL)

If you want to skip Razorpay entirely and just test Scenario U's
math, seed an existing subscription row directly:

```sql
-- Pretend the user bought Premium Monthly 12 days ago.
update public.subscriptions
set tier = 'premium',
    plan_id = (select id from public.plans where slug = 'premium-monthly'),
    started_at = now() - interval '12 days',
    expires_at = now() + interval '18 days',
    status = 'active',
    price_paid_paise = 19900   -- adjust to your real Premium Monthly price
where user_id = '<user_uuid>';
```

Then trigger the verify flow with a fake order. The expected
post-state: `expires_at` ≈ `(now + 18 days) + 90 days` ≈ `now + 108
days`.
