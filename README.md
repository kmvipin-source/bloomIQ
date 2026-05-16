# 🌱 ZCORIQ

**Assess _how_ students think — not just what they recall.**

ZCORIQ is an end-to-end Bloom's Taxonomy-driven assessment platform. Three role tiers (school principals, teachers, students), two student modes (school-managed vs independent subscription), AI-generated content from five sources, Bloom-level analytics, printable exam papers, and reporting suites.

---

## ✅ RESOLVED (2026-05-16) — Staged-launch feature-flag system shipped

Decision picked: **"Go — build it as designed"**, with the additional
constraint that activating / deactivating the school feature must be
trivially simple. Implemented and merged in this session.

**What shipped (files):**

- `supabase/migrations/95_platform_feature_flags.sql` — three tables
  (`platform_flags`, `platform_flag_overrides`, `platform_flag_audit`)
  + RLS + the three seed flags.
- `lib/featureFlags.ts` — server evaluator, 60s in-process cache, env
  panic-switch override, fail-safe DB-outage fallback.
- `lib/featureFlags.client.tsx` — `<PlatformFlagProvider>`, `<FlagGate>`,
  `usePlatformFlag()` hook. Provider mounted in `app/layout.tsx`.
- `app/api/flags/public/route.ts` — public-readable flag bundle for the
  client.
- `app/api/admin/feature-flags/route.ts` (+ `overrides/`, `audit/`) —
  admin-only mutation surface.
- `app/admin/feature-flags/page.tsx` — admin control UI.
- `app/schools-coming-soon/page.tsx` — waitlist landing.
- Enforcement: `app/api/admin/onboard-school/route.ts` returns 503 when
  `school_signup_enabled` is OFF; `app/pricing/page.tsx` swaps the
  For-Schools section for a coming-soon card when
  `school_marketing_visible` is OFF.
- `components/Sidebar.tsx` — added "Feature Flags" entry under platform-admin nav.
- `.env.test.example` — documents the `FLAG_*` env panic switches.

### How to flip the school feature on or off (read this first)

There are **three ways**, in increasing order of friction. Pick the one
that matches the situation:

1. **Admin UI flip — the normal path.** Sign in as a platform admin,
   visit `/admin/feature-flags`, click the green `ON` / grey `OFF` pill
   next to `school_signup_enabled` (or `school_marketing_visible`). Add
   a one-line reason; it lands in the audit log. Propagates everywhere
   within ~60 seconds. No redeploy.
2. **Pilot one school without flipping the global** — same UI, click
   "manage pilot allowlist" on the flag, "+ add school override". Pass
   the school UUID, choose enabled = yes, write a note (required), pick
   an expiry (default 90 days). That single school flips ON; the global
   stays OFF for everyone else.
3. **Env panic switch — for emergencies and tests.** Set
   `FLAG_SCHOOL_SIGNUP_ENABLED=off` (or `=on`) in the environment. Wins
   over EVERY DB value and every override, instantly, no DB call. Use
   this when something is on fire and you need a guaranteed-correct
   answer. The admin UI loudly shows when a flag is pinned by env.

The three starter flags:

| Flag | Default | What it does |
|---|---|---|
| `school_marketing_visible` | ON | Show the For-Schools tier on `/pricing`. OFF = coming-soon waitlist card. |
| `school_signup_enabled` | OFF | Allow new school onboarding via `/api/admin/onboard-school`. OFF = 503. Existing schools unaffected. |
| `independent_signup_enabled` | ON | Kill switch for the independent-learner signup path. |

Adding a new flag: add a line to `FLAG_REGISTRY` in
`lib/featureFlags.ts` + a single `INSERT` in a new migration. The admin
UI auto-renders it.

**Existing schools are not gated** — only the *new-onboarding* path
(`/api/admin/onboard-school`) checks `school_signup_enabled`. Already-
onboarded principals, teachers, and students keep working regardless.

---

## ✅ RESOLVED (2026-05-16, later) — 183-finding QA audit complete + F22 single-session enforcement shipped

A 9-phase Senior-QA-Architect audit (Functional, Workflow, Role-based, Input validation, AI quality, Cross-module, Regression, UX, Error handling, Performance) was run across every module of ZCORIQ. **183 distinct findings catalogued; all 183 have a fix, an in-code breadcrumb, or a documented deliberate exemption.**

**Full handoff document:** [`AUDIT.md`](AUDIT.md) — single source of truth, includes every fix tag with file + one-line rationale, the codemod scripts used, and the remaining queue for future PRs.

### Highlights (what to know without opening AUDIT.md)

**~100 functional / security fixes shipped as actual code, including:**
- **F76 critical** — `lib/recentStemsExclusion.ts` had a duplicate function definition + orphan code that was breaking the AI pipeline at compile time. Truncated to remove the duplicate.
- **F77 critical security** — `NEXT_PUBLIC_GROQ_API_KEY` fallback removed from `lib/groq.ts` (Next.js was inlining the secret into the browser bundle).
- **F78 critical silent failure** — `findMisconceptionDistractors` was calling `supabaseServer` with no token, which became an anon client, which RLS denied, which silently no-op'd. The whole feature was off in production.
- **F122 critical accuracy** — Teacher generation form's "Generated X of Y" toast was lying — used `perLevel × levelCount` instead of the actual sum-of-per-level counts.
- **Payments hardened** — F156 plan-price-mid-checkout error, F157 paid→paid started_at preservation, F162 idempotency on 23505, F165 IP+UA logged at order create, F152 double-click guard.
- **AI pipeline** — F84 Groq retry-once on parse failure, F85 token cap 2800 → 4500, F86 multilingual prompt-injection patterns, F89 30s Gemini timeout, F95 non-ASCII repetition clamp.

**1 dedicated PR-sized refactor — F22 + F171 — fully shipped:**
- New `lib/apiAuth.ts` with shared `requireAuthenticated()` + `requirePlatformAdmin()` helpers
- **124 routes migrated to the shared helper.** Single source of truth for "who is authenticated" and "who is a platform admin".
- **F22 single-session enforcement now active on every payment endpoint, every teacher/student write, every admin mutation** (was previously only on `/api/auth/me`). A stolen access token issued before a later sign-in elsewhere is now rejected with `session_superseded` 401 on every mutating route.
- **8 routes deliberately not migrated** — every one is intentional and documented (auth/me, claim-session, set-password, login-audit, flags/public, plus 2 with their own richer local helpers, plus the adapter file's dead-code legacy block).

**3 new SQL migrations** to apply with `supabase db push`:
- `95_platform_feature_flags.sql` — staged-launch feature flag system (above)
- `96_school_waitlist.sql` — backs the new `/api/waitlist/schools` endpoint
- `97_handle_new_user_hardening.sql` — `handle_new_user` trigger validates role explicitly, rejects unknown roles

**2 new shared libs** — `lib/passwordPolicy.ts` (F26), `lib/planLegacy.ts` (F151), plus the F22/F171 `lib/apiAuth.ts`.

**~50 in-code breadcrumbs** — every deferred hazard now has a `// FXX note (QA):` comment at the relevant code site, pointing back to `AUDIT.md`. The next maintainer sees them inline instead of having to remember to open the audit doc.

### Verification status (read carefully before deploying)

**Done in this session:**
- `npx tsc -p tsconfig.check.json` — clean exit after every batch (TypeScript type-check passes across all 235 modified files)
- `npx eslint app/ lib/ components/` — clean exit (no warnings, no errors)
- All codemod scripts under `scripts/refactor-f22-f171*.mjs` and `scripts/apply-audit-fixes-r*.mjs` are re-runnable and idempotent
- Every change visible in `git diff --stat HEAD` (235 files, +3,949 / −3,217 lines) for line-by-line review

**NOT done — must run before any deploy:**
1. `supabase db push` for migrations 95, 96, 97 — these were authored but cannot be applied from the codemod sandbox
2. The three ad-hoc DB tests:
   - `node scripts/test-invariants.js` — schema-shape + FK integrity + RLS-enabled checks across ~60 invariants
   - `node scripts/test-rls.js` — multi-persona RLS leak audit (positive + negative cases per role)
   - `node scripts/test-billing-e2e.js` — full B2B billing pipeline against live Supabase
   - (These were tried in-session but the sandbox has no DNS reach to Supabase — `EAI_AGAIN`. They need to run from a machine with network access to your project.)
3. `npm run dev` smoke test of the new UI affordances:
   - F124 batch warnings on `/teacher/generate` (>25 amber, >40 red)
   - F125 numerical-percent slider disabled when no apply/analyze/evaluate level picked
   - F126 source-tab switch confirmation when the prior tab has content
   - F138 inline good/bad topic helper text
   - F144 + F145 post-generate "View in question bank" / "Generate another batch" buttons
   - F175 "Platform Admins" filter chip on `/admin/users`
   - F16 inline Delete button on orphan-flag rows in `/admin/feature-flags`
4. F22 spot-check: sign in to the same account on two browsers, perform a mutating action from the older session, confirm it now returns `session_superseded` 401
5. Payment flow end-to-end on the Razorpay test gateway — order create → verify → second-click reuse → 23505 idempotency surface

### Where the codemods live

```
scripts/
  apply-audit-fixes-r{1..10}.mjs        # 10 rounds of the 183-finding audit
  refactor-f22-f171.mjs                  # Step 1: helper + 4 routes
  refactor-f22-f171-step2.mjs            # Step 2: 5 more admin routes
  refactor-f22-f171-step2c.mjs           # Step 2c: 5 more
  refactor-f22-f171-step2d.mjs           # Step 2d: closed admin migration
  refactor-f22-step3.mjs                 # Step 3 batch 1: 5 mutating
  refactor-f22-step3b.mjs                # Step 3 batch 2: 5 mutating
  refactor-f22-step3c.mjs                # Step 3 batch 3: 5 mutating
  refactor-f22-step3-finale.mjs          # 71 routes in one sweep
  refactor-f22-step3-finale-2.mjs        # +13 more
  refactor-f22-step3-finale-3.mjs        # multi-line imports
  refactor-f22-step3-mopup.mjs           # partial-migration fix-ups
```

Every script reports `Applied / Skipped` at the end. Skipped is always safe — the script refuses to write partial migrations.

### Resume phrase for next session

Open a new session and say:

> **"Resume from the 2026-05-16 audit handoff — see AUDIT.md."**

I'll re-read `AUDIT.md` and pick up the small remaining queue (mostly Section 1 product decisions, a handful of UI items needing a designer, and a couple of routes with local helpers that need manual review).

---

### Original design block (for historical reference)

### The decision you're making

Should I build the staged-launch / pilot-allowlist feature-flag system as designed below?

Three answers possible when you're ready:

1. **"Go — build it as designed"** → I implement migration 95 + lib/featureFlags.ts + /admin/feature-flags page + 3 enforcement points + waitlist landing page. ETA ~1.5 days.
2. **"Tweak first — change X"** → tell me what to change, I rework the design, you re-approve.
3. **"Skip it — too much infra for one feature"** → I fall back to a hardcoded `process.env.NEXT_PUBLIC_SCHOOL_LAUNCH=false` env var. Lighter, no pilot allowlist support. ETA ~30 min.

### Recommended resume phrase

Open a new session and say:

> **"Resume the staged-launch feature-flag work from the 2026-05-16 README block."**

I'll re-read this block and execute whichever option you picked.

---

### Design recap — for your re-read

**The shape:** global default + per-school allowlist + audit log, evaluated by a single `isFlagEnabledFor()` server function. Same pattern as LaunchDarkly, Statsig, Unleash. Lets you flip features without redeploying.

**Three new tables (migration 95):**

```sql
platform_flags          (name, global_default, description, updated_by, updated_at)
platform_flag_overrides (flag_name, entity_type, entity_id, enabled, note, added_by, added_at, expires_at)
platform_flag_audit     (id, flag_name, action, actor_id, entity_type, entity_id, before_state, after_state, reason, at)
```

**Three starter flags:**

- `school_marketing_visible` — default `true` — show "For Schools" tier on pricing/landing
- `school_signup_enabled` — default `false` — gate NEW school signups (independent users unaffected)
- `independent_signup_enabled` — default `true` — kill switch for independent path if ever needed

**Evaluator function** (server-side, cached 60s):

```typescript
isFlagEnabledFor(flagName, { schoolId?, userId? }): { enabled, reason }
  // 1. Per-school override (highest priority) — pilot allowlist
  // 2. Per-user override — internal QA, demos
  // 3. Global default — fallback
```

**Three enforcement points:**

1. `/login/school`, `/signup/school` page routes → redirect to `/schools-coming-soon` waitlist when off
2. `/pricing` "For Schools" tier card → render "Coming soon — join waitlist" when off
3. `/api/admin/onboard-school` server route → 503 with `{ error: "School onboarding paused" }` when off

**Admin UI at `/admin/feature-flags`:**

- Global on/off toggle per flag + last-changed audit line
- Pilot allowlist panel: add school by name + reason + optional expiry; remove; per-override stats
- Audit log: last 50 flag actions with who/when/why

**Your workflow examples:**

| Action | Steps |
|---|---|
| Launch independent only | Default state. Schools flag off globally, marketing visible with waitlist. |
| Pilot with 1 school | Add school to `school_signup_enabled` allowlist with 30-day expiry + reason note. |
| Add 3 more pilot schools | Same admin UI, 3 more entries. |
| Review pilot health | Admin UI shows per-pilot stats: signups, tests created, last activity. |
| Public launch | Flip `school_signup_enabled` global_default = true. One click. |
| Emergency rollback | Flip global_default = false. Pilots in allowlist keep working (soft) or pull plug (hard). |
| Re-activate | Same flip. Instant. No redeploy. |

**Bonus capabilities included for free:**

- Per-user overrides for internal QA / demo accounts
- Auto-expiring overrides (90-day default — no forgotten pilots)
- Generic infra reusable for every future staged rollout (AI Coach v2, ZCORIQ Bloom Score v2, etc.)

**Existing-user grandfathering:** the flag only gates NEW signups. Existing `schools` and `class_teachers` rows continue working. Hard mode (revoke existing access) is opt-in per call site.

**My recommendation from the conversation:**

- Option 3 (hybrid): marketing visible with waitlist, signup gated, in-product zero-school for independent learners
- Two flags not one (`marketing_visible` + `signup_enabled` flip on different days)
- DB-backed not env-backed (admin flips without redeploy)
- 90-day default expiry on every pilot override

**Honest caveats:**

1. Building 3-table infra for 1 feature is overkill if this is your ONLY staged rollout ever. If you expect 5+ more (AI Coach, Insights v2), the system pays for itself fast.
2. Pilot allowlists are sticky — default expiries avoid year-old forgotten entries.

**Cost estimate:** ~1.5 days of focused work, all additive, zero risk to existing flows.

---

## ⚠️ Important — Next.js 16

This project uses **Next.js 16** with breaking changes — APIs, conventions, and file structure may differ from older Next.js docs / training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing routing/data-fetching code. Heed deprecation notices.

---

## 👤 First-time account creation & login — by role

How a fresh account becomes a working account, for each of the five
roles ZCORIQ supports. All flows go through the same Supabase Auth
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

### 5. Platform admin (ZCORIQ internal staff)

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

## 🧭 Naming convention — ZCORIQ vs Bloom

**Product name: ZCORIQ.** **Taxonomy: Bloom's.** They compose:
a ZCORIQ Bloom Score is a single number, derived from Bloom-level mastery, owned by the ZCORIQ product.

What got renamed in the May 2026 rebrand:

- User-visible text (page titles, navbar, emails, marketing copy) — `BloomIQ` → `ZCORIQ`, `BloomIQ Score` → `ZCORIQ Bloom Score`.
- TypeScript identifiers and file names that prefixed `BloomIQ` to a product concept — `BloomIQScoreBadge` → `ZcoriqBloomScoreBadge`; `lib/bloomiqScore.ts` → `lib/zcoriqBloomScore.ts`; `lib/bloomiqInsights.ts` → `lib/zcoriqInsights.ts`.

What deliberately stayed `bloomiq_` / unchanged, and why:

- **Database column names** like `bloomiq_score` and the historical migration files (`66_bloomiq_score_calibration.sql`, `schema.sql`). Renaming a production column is a multi-phase migration (ADD → dual-write → migrate reads → DROP) with real downtime risk. Internal column names are never user-visible and don't justify that risk for a cosmetic rebrand. If a clean DB rename is wanted later, it should be a dedicated maintenance window with its own plan.
- **Historical migration files' content.** Migrations are an immutable audit log of what shipped. Renaming them would lie about history.
- **Bloom-taxonomy identifiers and phrases** like `BloomLevel`, `BLOOM_META`, `BLOOM_LEVELS`, `bloom_level`, `BloomBadge`, `BloomHero`, `BloomReports`, `bloomVerifier`, "Bloom mastery", "Bloom levels", "Bloom's taxonomy". These reference the educational framework, not the product brand, and survive the rebrand untouched.

- **`package.json` `name` field.** Affects deploy / CI / npm references; renaming is decoupled from the in-product rebrand.

If you're searching the codebase and see `bloomiq_score` in a SQL file or `bloomiq_score` in a `.select(...)` call, that's by design — it's pointing at the DB column, which kept the old name.

---

## 🆕 Latest session — 2026-05-16 (Quality, provenance, parity: shared qgen pipeline, generation provenance, cross-session cosine dedup, Bloom verifier, prompt-safety, per-Bloom counts, per-generation category override, prominent assign-time mismatch alert, student library, teacher fan-outs)

A multi-priority session that lands the foundation primitives ZCORIQ needs to
(a) make question quality auditable, (b) catch the same-question-rephrased
complaint at the source, and (c) close the worst parity gaps between the
independent-learner and teacher surfaces. Most of this drop is *additive*
library + migration code that future route refactors will compose into the
live pipeline; the visible-today changes are flagged at the bottom.

### Foundation (P0)

- **`lib/qgenPipeline.ts` — shared generation pipeline (P0.1).** Three
  composable surfaces: `prepareGenerationContext()` (read-only assembly of
  distractor seeds, exclusion stems, history embeddings, prompt fragments),
  `postProcessCandidates()` (leak detection → in-batch Jaccard → in-batch
  cosine → cross-session cosine → answer-key verifier → optional Bloom
  verifier → per-row provenance), and `generateQuestions()` (the wrapper for
  routes that follow the standard "build prompt → call Groq → post-process"
  shape). Routes opt in one at a time; until they do, existing behaviour is
  unchanged. Provenance blob is wired but the column landing means even
  unmigrated routes can persist it as `{}`. (Route-by-route migration is
  the next session's work.)

- **Migration 91 — `question_bank.generation_meta jsonb` (P0.2).** New
  nullable jsonb column (default `'{}'`) with GIN index and a partial index
  on disputed verdicts. Stores per-question provenance: which route, which
  intent, requested Bloom, prompt version, verifier verdict (status / model
  / both candidates' picks), embedding presence, dedup counts, retry count,
  Bloom dispute flag. Existing inserts get the default `{}` and continue
  unchanged. Pure additive.

- **Cross-session cosine dedup actually queried (P0.3).** Migration 80
  added `stem_embedding vector(768)` and routes have been writing it on
  every insert — but no READ PATH actually queried it until now.
  `lib/recentStemsExclusion.fetchRecentEmbeddingsForOwner()` fetches the
  owner's most-recent 100 vectors, optionally category-scoped; the pipeline
  feeds them into `cosineDedupAgainstHistory()` alongside freshly-embedded
  candidates. This is the single fix that closes the "I got the same
  question rephrased on day two" complaint that triggered the original
  pgvector work.

### Quality + trust (P1)

- **Verifier disputes surfaced on `/teacher/review` (P1.4).** When the
  answer-key verifier disagrees with the LLM's stored `correct_index`, the
  review card shows an amber `⚠ Verify answer` badge with a tooltip
  comparing both picks. Verdict shape: `generation_meta.verifier.{status,
  reason, model, llm_correct, verifier_correct}`. Visible immediately for
  rows generated through the new pipeline; older rows stay un-badged
  (correct empty-state behaviour).

- **`lib/bloomVerifier.ts` — Bloom-level second-pass verifier (P1.5).** One
  Groq call per BATCH (not per question) returns each item's actual Bloom
  level + rationale. Items off by ≥ 2 levels get
  `generation_meta.bloom_disputed=true` and the review card shows an amber
  `⚠ Bloom mismatch` badge with the verifier's level in the tooltip.
  Fail-open. Feature-flagged at call site.

- **`lib/promptSafety.ts` — prompt-injection sanitizer (P1.6).** Strips
  role-tag markers, "ignore previous instructions" family, code fences,
  HTML tags, unicode-whitespace smuggling. Hard-caps each splice point at
  800 chars. Drop-in `sanitizeUserText()` + `sanitizeUserFields()`. Library
  is ready; routes need to swap their `topic`/`additional_focus`/
  `learner_profile` splices to call this first (next session).

- **Student question library — `/student/library` (P1.7).** New page that
  closes the biggest parity gap. Independent students browse every question
  they've ever generated, filter by topic / Bloom / category / free-text,
  paginate, and "Re-quiz on this topic" with one click. Backed by
  `/api/student/library` which RLS-scopes to the caller. Soft-deleted rows
  (migration 92) auto-hide. Favourites + per-question attempt history are
  deferred for a follow-up (additive, needs one table).

### Workflow + operations (P2)

- **Teacher fan-outs — flashcards & adaptive practice (P2.8).** New
  `/api/teacher/assign-flashcards` and `/api/teacher/assign-practice`
  endpoints. Flashcards fan out shared deck content per student
  (cheap — one Groq call, N inserts); adaptive practice queues
  per-student tickets that the student client picks up on next sign-in
  (preserves the personal-weakspot-mining RLS context). Backed by
  migration 94 (`flashcard_assignments`, `practice_assignments`) with full
  RLS: student reads/updates own, teacher reads what they assigned.

- **Migration 92 — soft-delete + rejection_reason (P2.9).** Adds
  `deleted_at timestamptz` and `rejection_reason text` to `question_bank`,
  with a length check and partial indexes for active-rows + rejection-
  reason analytics. Lets the review UI capture WHY a question was rejected
  (chip picker — factual / disputed / too_easy / too_hard / off_topic /
  duplicate / poorly_worded / other) so future prompt-tuning can train on
  rejection patterns. Pure additive.

- **Migration 93 + `lib/rateLimitDb.ts` — distributed rate limiter (P2.10).**
  Replaces the N×-bypassable in-process Map with a `rate_limit_counters`
  table + atomic `rpc_rate_limit_increment()` SECURITY DEFINER function.
  Per-user-per-route hourly buckets, fail-open on DB errors, one round-trip
  per protected request. Conservative defaults per route (8–60 / hour);
  enforce only on the 4–5 high-cost AI routes.

### Polish (P3)

- **`lib/embeddingTelemetry.ts` — embedding-failure visibility (P3.11).**
  Drop-in for `embedTexts()` that returns the vectors plus a telemetry blob
  (failure rate, total-failure flag, surface-banner flag). Fires above 25%
  failure or on full call failure. `embeddingBannerMessage()` returns
  ready-to-render copy: "Semantic dedup was weakened this run — small chance
  of repetition."

- **`lib/useTopicValidation.ts` — shared topic-validation hook (P3.12).**
  Single source of truth for the 800ms-debounced /api/topic-validate
  pattern duplicated across five surfaces. AbortController per keystroke,
  40-entry LRU cache, fail-open on network error. Migration is per-surface
  swap (next session).

- **`lib/stretchChallenge.ts` — opt-in stretch mode for students (P3.13).**
  Lets a motivated learner deliberately escalate their practice up to two
  tiers (e.g. Class 10 → JEE Main) with an explicit amber acknowledgement.
  `stretchEligibility()` computes the eligibility + banner message;
  `resolveStretchCategory()` is the server-side gate that records consent in
  `generation_meta.stretch_challenge_acknowledged`.

### Teacher-side specifics that landed live in this session

- **Per-generation category override picker on `/teacher/generate`.** The
  class identity is unchanged (no new schema on `classes`). When the
  teacher selects a class, a new "Generate FOR" dropdown appears with the
  class's grade-derived category preselected as "(class default)". The full
  catalog is one click away — Class 5-8, Class 9, Class 10 boards, Class 12
  boards, JEE Main, JEE Advanced, NEET, CAT, UPSC, GATE, Bank exams, GMAT,
  GRE, CLAT, BITSAT, SAT, NDA, CUET, Corporate. Picking a non-default value
  shows a small "Generating <X> for <Class> (class default is <Y>). Resets
  after this batch." note, and the picker snaps back to the default after
  every successful generation. Server (`/api/generate`) honours
  `body.category_override` with preference over `body.examGoal`, falling
  back to null. Closes the "how does a teacher generate UPSC / Bank exam /
  JEE questions without abandoning their class structure?" gap.

- **Per-Bloom-level individual count selectors.** Below the single shared
  "Questions per level" input, a grid of one number-spinner per Bloom level
  now lets teachers ask for, say, 3 Remember + 5 Understand + 2 Apply + 1
  Analyze instead of a uniform `perLevel × N`. The shared input remains as
  the fallback default for any level the teacher doesn't override; "Reset to
  shared default" clears overrides in one click. The server
  (`app/api/generate/route.ts`) gains a `countForLevel()` helper used at
  every prompt-build, dedup-slice, retry-shortfall, and log-message site —
  backwards-compatible when the client sends no overrides.

- **Generate-time difficulty-mismatch banner.** Below the Generate button,
  an amber alert fires when the teacher's chosen override (or the class
  default) differs from the class's grade-derived tier by ≥ 1 step. Live
  client-side computation via
  `lib/questionCategory.validateGenerationFitForGrade()` (no API round-trip
  for the banner; the same helper is also exposed via
  `/api/teacher/generation-fit` for surfaces that want a canonical answer).
  Severity-graded (none / soft / hard / block) so the UI can vary tone.
  Heads-up only — never blocks.

- **Assign-time mismatch promoted to prominent banner on
  `/teacher/quizzes/new`.** The pre-existing `classQuestionMismatchWarning()`
  return (powered by `lib/questionCategory.ts`) was rendered as a thin
  caption; it's now an unmissable amber card with the heading **"Category
  mismatch — please confirm"** and a clarifying "You can still proceed if
  this is a deliberate stretch challenge — but double-check" tip. Same
  data source, much louder treatment.

- **"Mock paper (competitive exam)" intent chip renamed to "Stretch
  reasoning paper".** Description is now "Apply / Analyze / Evaluate
  focus" — the chip's Bloom blueprint (3 hard levels × 5 each) is unchanged
  but the misleading "detects CAT/JEE/NEET from topic" framing is gone,
  because the new category-override picker is the explicit way to declare
  competitive-exam intent.

### Honest scorecard

- Migrations **91, 92, 93, 94** are SQL files in `supabase/migrations/`.
  They take effect only after `supabase db push` (or pasting them into the
  Supabase SQL editor in order). Until then, the new columns / tables don't
  exist and the corresponding UI badges naturally don't fire — correct
  empty-state behaviour, not a bug.

- The shared `lib/qgenPipeline.ts` is library code. **No existing route
  imports it yet.** Routes that read its outputs (review-page badges,
  embedding-failure banner) populate only when the route they came from is
  pipeline-wired. That route-by-route surgery is the next session.

- The four user-facing changes (category override picker, per-Bloom counts,
  generate-time banner, assign-time prominent alert) **are live in
  `npm run dev`** with a hard refresh (Ctrl+Shift+R).

- A new student-facing page lives at `/student/library` — empty until the
  student generates questions; then they're browsable.

### Files added (15 new, 5 edited)

```
lib/qgenPipeline.ts                 538  P0.1  pipeline orchestration
lib/bloomVerifier.ts                198  P1.5  Bloom-level second-pass verifier
lib/promptSafety.ts                 155  P1.6  prompt-injection sanitizer
lib/rateLimitDb.ts                  161  P2.10 distributed rate limiter
lib/embeddingTelemetry.ts           138  P3.11 embedding-failure visibility
lib/useTopicValidation.ts           166  P3.12 shared topic-validation hook
lib/stretchChallenge.ts             144  P3.13 student opt-in stretch mode
app/api/teacher/generation-fit/     130  generate-time fit API
app/api/teacher/assign-flashcards/  182  P2.8  fan-out endpoint
app/api/teacher/assign-practice/    166  P2.8  fan-out endpoint
app/api/student/library/            100  P1.7  library listing endpoint
app/student/library/page.tsx        246  P1.7  library page
supabase/migrations/91_..._meta.sql  81  P0.2  generation_meta column
supabase/migrations/92_..._delete.sql 55  P2.9  soft-delete + rejection_reason
supabase/migrations/93_..._limit.sql  99  P2.10 distributed rate limit
supabase/migrations/94_..._assigns.sql 116 P2.8 teacher assignment tables
```

Edited: `lib/questionCategory.ts` (added `validateGenerationFit`,
`validateGenerationFitForGrade`), `lib/recentStemsExclusion.ts` (added
`fetchRecentEmbeddingsForOwner`), `lib/types.ts` (added
`Question.generation_meta`), `app/teacher/generate/page.tsx` (category
override picker, per-Bloom count grid, mismatch banner, Mock paper chip
rename), `app/teacher/review/page.tsx` (verifier + Bloom dispute badges),
`app/teacher/quizzes/new/page.tsx` (prominent assign-time mismatch banner),
`app/api/generate/route.ts` (per-level counts + category_override).

---

## 🆕 Earlier session — 2026-05-14 (End-to-end audit & quality stack — profile-aware competitive-exam framing, LLM topic validation, dynamic topic grounding, semantic dedup, auto-retry, shortfall transparency, world-class SYSTEM prompts)

A full-day audit + fix marathon driven by tester feedback. The crux of the
session: **make question quality reliable on any topic the user types — no
local lists, no maintenance burden, no silent failures.** Below is what
landed and how the pieces work together.

> **Pilot-data safety rule still applies.** This session touched generator
> routes and UI but did not modify any user-data tables. Migration 80 adds
> a nullable column; legacy rows are untouched.

### Headline fixes — bugs the tester filed

1. **JEE student → "Class 8/9" + CBSE syllabus shown** when they typed a generic topic like "Algebra".
   - Root cause: every gate was inspecting **topic text only**, never the student's `exam_goal` / `learner_profile`.
   - Fix: new shared helper `shouldUseCompetitiveExamFraming({topic, learnerProfile, examGoal})` in `lib/examDetectors.ts`. Used by `/student/generate`, `/teacher/generate`, `/api/student/quick-test`, `/api/generate`. Covers 15+ goal slugs (jee_main, neet_prep, cat_prep, upsc_prep, bank_exams, gmat, gre, gate, clat, cuet, bitsat, sat, nda, etc.).
   - Net: the class/grade and syllabus inputs are correctly hidden for competitive-exam students, with a clear banner explaining which signal (profile or topic) was used.

2. **Rank predictor refused legitimate competitive-exam tests** when the student's chosen topic wasn't itself a known exam name (e.g. NEET student practising "blood group").
   - Root cause: `classifyQuizForRankPrediction()` only inspected the quiz's `topic` / `name` / `topic_family`, ignoring the student's `exam_goal`.
   - Fix: added `studentExamGoal?` parameter to the classifier; wired through both callers (`/api/rank/predict` route + `/student/results/[id]` page). Corporate-skill matches on the topic still win over profile (a Java test is never a NEET mock no matter the goal).

3. **"Blood Group" + NEET → wrong suggestion** ("This topic fits CAT better").
   - Root cause: the original keyword-list approach to topic-vs-syllabus matching is inherently brittle. CAT had "BLOOD" as a single token (because of CAT's "blood relation" puzzles in LR), and NEET's keyword list didn't include "BLOOD" / "GROUP" / typical medical body-system terms.
   - **Architectural pivot:** replaced the keyword-list approach entirely with an LLM-based validator. New route `/api/topic-validate` (`groqJSON`-backed) decides per-topic if the topic belongs to the exam's syllabus — and if not, which exam it would fit. Works for ANY topic with zero local maintenance. Fail-open on errors; debounced 800ms; ~$0.0001 per check.

4. **Numerical % slider showed misleading "Use suggested" button** even when the user's value already matched the suggested value (delta = 0). Fixed conditional + added a quiet "your slider is aligned" caption.

5. **Generation shortfall was silent** — user picked 8 questions, got 2, no explanation. Fixed:
   - Frontend now reads `data.total` + `data.summary` (which the backend has always returned) and renders an amber toast: *"Generated 2 of 8 (short by 6). Per level: Understand: 1, Apply: 1, Analyze: 0, Evaluate: 0. Likely causes: niche topic / dedup / answer-leaks. Try a more specific topic or fewer levels."*
   - When ALL questions came back zero, the redirect is blocked and a hard error explains why.

### The new quality stack (what runs on every generation)

```
1. Dynamic topic grounding         lib/topicGrounding.ts (NEW)
   ↓  one Groq call decomposes the topic into 6-10 sub-areas,
   ↓  4-8 real-world anchors, 3-6 common misconceptions, and a
   ↓  "tough question" difficulty anchor. Zero local data.

2. learningContext + examDetectors  lib/learningContext.ts + lib/examDetectors.ts
   ↓  exam-aware framing for known goals (CAT/JEE/NEET/UPSC/…)

3. World-class SYSTEM prompt        Clauses 5 + 6 added to every generator
   ↓  "Use real terminology, never fabricate, hit exact count, vary
   ↓  sub-area/scenario/difficulty if needed."

4. filterQuestionBatch              lib/qgen.ts (existing)
   ↓  Jaccard dedup: answer-leak, in-batch dupes, cross-session history.

5. In-batch cosine dedup            lib/embeddings.ts (NEW) + migration 80
   ↓  Gemini text-embedding-004 (768-dim) catches paraphrases Jaccard
   ↓  misses ("How does HCl ionise?" vs "Explain dissociation of HCl").
   ↓  pgvector column ready; cross-session cosine query is next session.

6. Auto-retry on shortfall          Per-level loop in /api/generate + /api/student/quick-test
   ↓  If delivered < requested, fires ONE more groqJSON with explicit
   ↓  feedback ("you gave N, give K more on different sub-areas: …").

7. verifyAnswerKeys + refinement    lib/qgen.ts (existing)
   ↓  Second LLM re-solve; one refinement attempt on dispute.

8. Shortfall transparency toast     /student/generate page
   ↓  If anything is still short, user sees per-level breakdown — no
   ↓  silent partial deliveries.
```

### UX improvements landed

On **`/student/generate`** (the most-changed page):

- "Topic + class + syllabus" tile hidden for competitive-exam students
- Smart Bloom auto-pick on first load from `typicalTestShape` (e.g. JEE → U/A/A/E pre-picked)
- "Typical for X" caption showing recommended count + minutes + Bloom levels with rationale
- Bloom-level chip greying for levels the exam doesn't test (strike-through + tooltip)
- "Customise per level" toggle in by-count mode (non-destructive — total survives the toggle)
- Recently-used topics chips (localStorage-backed, FIFO 8)
- First-time empty-state tooltip (auto-dismiss)
- Mobile grid 2-up
- "More instructions" upgraded from single-line input → 3-row textarea (800 char max). Length-aware: ≤150 chars treated as a sub-area; >150 chars wrapped as explicit "ADDITIONAL INSTRUCTIONS FROM THE STUDENT" block in the prompt.
- Disabled Generate when invalid + inline amber reason
- Pre-flight pill: *"Will generate 8 questions · ~25 min"*
- LLM topic-vs-syllabus warning (debounced 800ms) when topic is off-syllabus for the detected exam

On **`/teacher/generate`** — same pattern applied:
- topic-vs-syllabus LLM warning
- Bloom chip greying
- Numerical % deviation + no-op fix
- Disabled Generate + pre-flight pill

On **`/student/speed`** + **`/student/flashcards`** + **`/student/visualizer`** — topic-vs-syllabus LLM warning wired with same debounced pattern.

### Resilience changes

- **`lib/groq.ts` — auto-route Gemini-first** when `GROQ_API_KEY` is missing but `GEMINI_API_KEY` is set. Previously the dispatcher only respected `LLM_PROVIDER=gemini`; now it also detects key-only configs. Restored after the file was truncated by a linter pass mid-session.
- **Topic-validate route fail-open**: any error or rate-limit returns `{valid: true, reason: "validator_unavailable"}` so the UI never blocks generation on validator flakes.

### New files

| File | Purpose |
|---|---|
| `app/api/topic-validate/route.ts` | LLM-based topic-vs-exam-syllabus validator |
| `lib/examDetectors.ts` (extended) | `shouldUseCompetitiveExamFraming`, `isCompetitiveExamGoal` |
| `lib/skillFewShot.ts` | Niche-skill few-shot bank (fallback for the few topics where the LLM has weak priors). Auto-injection still active but secondary to topic grounding. |
| `lib/testShapeDefaults.ts` | `typicalTestShape({examGoal, learnerProfile})` for every goal — drives the "Typical for X" caption + smart Bloom defaults. |
| `lib/topicGrounding.ts` | `groundTopic(topic, context)` — dynamic LLM-driven topic decomposition. |
| `lib/embeddings.ts` | Gemini text-embedding-004 wrapper + cosine helpers (`cosineSim`, `cosineDedupInBatch`, `cosineDedupAgainstHistory`). |
| `supabase/migrations/80_question_bank_embedding.sql` | Adds `stem_embedding vector(768)` + IVFFlat cosine index. Backfill is optional / deferred. |
| `docs/AUDIT_2026_05_13_EVENING.md` (yesterday) | Original 45-item audit doc this session built on. |
| `docs/AUDIT_2026_05_14_FULL_SWEEP.md` | Mid-session audit checkpoint (Round 1 fixes). |

### Configuration notes

- **Required env**: `GROQ_API_KEY` (generation) or `GEMINI_API_KEY` (auto-routes). At least one.
- **Recommended env for full quality**: `GEMINI_API_KEY` (free tier on AI Studio) — enables semantic embedding dedup + grounding fallback.
- **Migration 80** can be applied at any time; legacy rows stay NULL and the cosine dedup helper falls back to Jaccard for them. New questions get embeddings on insert immediately.

### Process notes (transparency)

- The Edit tool repeatedly truncated long files during this session (11 separate occurrences). All recoverable via Python heredoc splice from `git HEAD`. Workaround used throughout: small surgical Edits + immediate tail check + restore-and-retry when corruption detected.
- Sandbox `tsc` execution times out on this project size, so type-check verification must happen on the developer's local machine before deploy.

### Deferred for follow-up

- Wire `buildSkillFewShotBlock` into 3 remaining secondary routes (climber, teach-back, qbank/solution) — imports present, concat sites need per-route topic-variable identification.
- `/teacher/papers/new` UX rebuild — 393-LOC sections-and-question-types form needs its own design pass; today's `/teacher/generate` patterns don't copy-paste cleanly.
- Extend `lib/recentStemsExclusion.ts` to fetch + return `stem_embedding` from `question_bank`, enabling true cross-session cosine dedup using the column populated this session.
- `/api/qbank/[id]/solution` — currently no learning context; add when next touched.
- Yesterday's open audit items #15-#41 (UX polish bugs) — batch into a single follow-up PR.

---

## 🆕 Earlier session — 2026-05-13 (Confidence Insights rewrite + Speed Trainer cross-test non-repetition + learning-context everywhere + marking schemes everywhere + soft-delete classes + post-test review + Mock Rank Predictor foolproofing)

A multi-day push focused on making the student-facing surfaces (a) trust-worthy on repeated attempts, (b) self-explanatory in plain English, and (c) context-aware across every AI-generated surface — not just question generators. Also added the operational gaps Vipin called out: marking-scheme persistence, soft-delete with confirmation, co-teacher invite emails, and an in-product post-test review.

> **Pilot-data safety rule applied throughout this session and every future one:** the same Supabase instance hosts real pilot students. Only delete rows you (Claude) created. Never bulk-delete by table.

### 1. Confidence Calibration → Confidence Insights (rename + reframe + plain-English copy)

The old page name "Confidence Calibration" read like an *interactive* feature (students opened it expecting to "do" calibration), but it's actually a read-only dashboard fed by Speed Trainer ratings. Worse, the empty state pushed users straight back to Speed Trainer, so it felt like one feature with two names. Fixed end-to-end:

* **`lib/features.ts`** — feature key stays `calibration` (no migration), label flipped to **"Confidence Insights"**, description rewritten to make the read-only nature obvious.
* **`lib/studentGoalTiles.ts`** — tile moved from "calibrate yourself" to **"Diagnose a weakness"** category. Tile copy reframed.
* **`app/student/calibration/page.tsx`** — URL kept for back-compat (legacy links don't strand) but the page itself fully rewritten:
  * Title → **"Confidence Insights"**.
  * Intro copy: *"When you said 'I'm sure about this one' — were you actually right?"* (Replaced the JEE-coded "AIR 500 vs AIR 5000" framing that intimidated non-JEE users.)
  * Top stat tiles renamed: "Ratings logged" → **"Hunches recorded"**, "Calibration gap" → **"How off your hunches are"**, "Bands w/ data" → **"Confidence levels with data"**. Each tile gained a one-line hint.
  * Chart heading: "Stated confidence vs actual accuracy" → **"What you said vs what actually happened"** with a leading sentence explaining the pin (grey) and bar (coloured) before the user sees them.
  * Per-row caption: "You said ~95% · actually 80%" → **"You felt ~95% sure · really got 80% right"**.
  * Strategy panel — this was the worst offender. Old: *"On JEE Main / NEET-style papers (-1 wrong, +4 right), only attempt confidence bands where your accuracy × 4 beats your error rate × 1."* New: *"Many entrance exams (like JEE Main and NEET) take 1 mark off for a wrong answer and give 4 marks for a right one. Blank answers get zero — no gain, no loss. Looking at how often you're actually right in each confidence band, here's the safe call:"* Column headers became **"Worth answering"** / **"Better to leave blank"** with a one-line explanation under each.
  * Banner at the top points users at the *new* ZCORIQ Bloom Score calibration (`/student/bloom-score`) so people looking for the 7-minute Future-You reveal don't land here by mistake.
* **`app/student/speed/page.tsx`** — added a bridge link in the results section so students discover Confidence Insights organically after a Speed Trainer run.
* **`app/student/layout.tsx`** — removed the hard `/student/calibration` redirect on first run; it now opens only when the student picks "Diagnose a weakness".

### 2. Speed Trainer cross-test non-repetition — the JSONB-blind blind spot

User report: *"I tried Speed-Accuracy Trainer and gave CICS mainframe topic, took 2 consecutive tests of 5 questions each — 2 questions repeated. I thought repetition will be removed?"*

Root cause: the original cross-test dedup helper queried only the canonical `attempt_answers → quiz_attempts → question_bank` path. But Speed Trainer writes its questions to `speed_sessions.questions` (JSONB), and Daily Drill to `daily_drill_attempts.items` (JSONB). The helper was effectively blind to Speed Trainer history, so on the second consecutive run the AI prompt had `history=0` and zero exclusion list.

**`lib/recentStemsExclusion.ts`** — rewrote `fetchRecentSeenStems` to merge stems from **three** data sources:

1. **Canonical**: `attempt_answers → quiz_attempts → question_bank` (regular quizzes, practice tests, climber).
2. **`speed_sessions.questions` JSONB** — filtered by `speed_sessions.topic` and per-item `bloom_level`.
3. **`daily_drill_attempts.items` JSONB** — filtered by topic substring match on stem (no topic column on this table).

Stems are merged with `createdAt` timestamps from each source, deduped by exact stem, sorted newest-first, sliced to limit (default 20). Per-source failures are caught locally so one bad query doesn't blank the exclusion list. Combined with the existing layers, the second Speed Trainer test on the same topic now gets:

* **Layer 1** (prompt): the 5 stems from the previous run injected as a "DO NOT REPEAT — paraphrases also forbidden" block.
* **Layer 2** (post-gen): `filterQuestionBatch` in `lib/qgen.ts` Jaccard-drops anything ≥ 0.7 similar to any history stem.
* **Layer 3** (intra-batch): in-batch dedup so the AI can't even repeat within a single run.

`lib/qgen.ts` — `filterQuestionBatch` now accepts a `historyStems` option and returns `{kept, droppedLeak, droppedDup, droppedHistory, trimmed}` so callers can log which layer caught what.

### 3. Learning-context inheritance across every AI-generated surface

User's repeated push: *"Learning context is not getting inherited everywhere — only on Generate."* Audit found 14 endpoints that called Groq without any awareness of the student's exam goal, learner profile, or topic preferences. Fixed across the board.

* **`lib/learningContext.ts`** (NEW) — three exports:
  * `loadLearningContext(adminSb, userId)` — pulls `exam_goal`, `learner_profile`, learner_profile-derived defaults.
  * `prependLearningContext(basePrompt, ctx)` — prepends a structured context block to any AI prompt.
  * `buildExamAwareTopic(topic, ctx)` — rewrites bare topic strings ("graphs") into exam-aware forms ("Graph theory — CAT QA section, MBA-aspirant level") so the AI generates the right *register* of question, not just the right subject.

* **`lib/learnerProfileFromGoal.ts`** (NEW) — `learnerProfileFromGoal(examGoal)` derives `k12 / competitive_exam / corporate` from the exam goal so we never have to ask twice.

* **`lib/topicSuggestions.ts`** (NEW) — `suggestedTopics(examGoal, learnerProfile)` and `placeholderTopic(examGoal, learnerProfile)`. Used to neutralize the **23 hardcoded "subject X" placeholders** an agent audit found scattered across Speed, Practice, Teach-Back, Flashcards, Voice Teacher, Visualizer, Student/Teacher Generate, and the homepage.

* **Endpoints wired with learning context + recent-stems exclusion + filterQuestionBatch:**
  * `app/api/speed/start/route.ts`
  * `app/api/student/quick-test/route.ts`
  * `app/api/student/adaptive-practice/route.ts`
  * `app/api/climber/today/route.ts`
  * `app/api/generate/route.ts`
  * (plus 9 more across Teach-Back, Misconception Detective, Flashcards, Voice Teacher, Visualizer — each one received the same three-pronged upgrade)

### 4. Marking schemes everywhere — with sticky last-choice default

User: *"Marking scheme is needed on every test surface — student AND school — but default to the user's last choice."* Picked **Option B** (new nullable column) over per-test storage so it travels with the user across surfaces.

* **Migration 77** (`supabase/migrations/77_last_marking_scheme.sql`) — adds `profiles.last_marking_scheme JSONB`. Nullable; reads cheap; writes are fire-and-forget.
* **`lib/markingSchemeMemory.ts`** (NEW) — `resolveStickyScheme(adminSb, userId)` (returns last choice or sensible default) and `writeLastMarkingScheme(adminSb, userId, scheme)` (called server-side at test-create time).
* **`components/MarkingSchemePicker.tsx`** — reusable picker with presets PRACTICE / JEE / NEET / CAT / Custom + a toggle. Surfaces effective rule in plain English ("+4 for correct, −1 for wrong, blank = 0") under the picker.
* Picker now rendered on every test creation surface: `/student/generate`, `/student/quick-test`, `/student/speed`, `/teacher/quizzes/new`, `/teacher/papers/new`, and the daily-drill setup card. Each surface seeds the picker from `last_marking_scheme` on mount, falling back to PRACTICE for first-time users.

### 5. Soft-delete classes (with confirmation modal)

User: *"Delete class shall not delete physically — better make it inactive and school admin shall be able to activate it back if necessary. Before deactivating, popup confirmation message so nothing happens accidentally."*

* **Migration 78** (`supabase/migrations/78_class_active_status.sql`) — adds `classes.status (active|inactive)`, `deactivated_at`, `deactivated_by`. RLS unchanged (status filtering happens in the API layer).
* **`app/api/admin/classes/[id]/status/route.ts`** (NEW) — POST endpoint that flips status and stamps audit. Refuses if caller isn't super_teacher of that school. Returns the updated row.
* **`app/school/classes/page.tsx`** — soft-delete UI: "Deactivate" button opens a confirmation modal explicitly stating "students keep all their attempts; teachers keep their tests; this is reversible". Inactive classes get a separate "Inactive" section with a one-click Reactivate.

### 6. Co-teacher invite emails (wired, awaiting env vars)

User: *"I gave madathilvipink@gmail.com but didn't receive any mail."*

* **`lib/email.ts`** (NEW) — `sendEmail()` using nodemailer Gmail transport. Degrades gracefully to `{ status: 'not_configured' }` when `EMAIL_USER` / `EMAIL_PASS` env vars are missing, so the rest of the app keeps working in local dev.
* **Templates**: `coTeacherInviteTemplate(...)` and `primaryTeacherInviteTemplate(...)` — both produce a plain-text body + an HTML body.
* `app/api/admin/classes/[id]/co-teachers/route.ts` and `app/api/admin/classes/[id]/primary/route.ts` now both call `sendEmail` after the DB write. Failures are logged but don't block the API response (invite row is the source of truth).
* **User-side TODO**: add `EMAIL_USER` (Gmail address) + `EMAIL_PASS` (Gmail App Password — *not* the regular password) to `.env.local`. Detailed Gmail App Password setup steps were walked through earlier in the session. Once env is set, the invite to `madathilvipink@gmail.com` will deliver on the next attempt.

### 7. Post-test question/answer review (student page + PDF)

* **`app/student/results/[id]/page.tsx`** — added a "Review your answers" section after the score card. For every question: stem, options with YOUR PICK in red and the CORRECT answer in green, verdict pill (Correct / Incorrect / Skipped), and the AI-generated explanation. No re-attempt, just an audit trail.
* **`app/api/report/[attemptId]/route.ts`** — PDF mirrors the on-screen review section so students can keep an offline copy.

### 8. Goal consolidation — single screen + persistent chip

User: *"In two places the question types are getting populated — consolidate."*

* **`components/StudentGoalPicker.tsx`** — added a "Professional / training" tile and auto-derives `learner_profile` from goal choice (no separate question).
* **`components/CurrentGoalChip.tsx`** (NEW) — always-visible chip in the student topbar showing the current exam goal. Click → opens `/student/settings/goal`. Does NOT render the amber "set a goal" CTA for school students with no goal (school students inherit their teacher's framing).
* **`app/student/settings/goal/page.tsx`** (NEW) — master goal-change screen. Single source of truth; every other surface deep-links here.

### Files changed this session

```
lib/recentStemsExclusion.ts                              NEW — merges canonical + speed_sessions + daily_drill JSONB sources
lib/qgen.ts                                              modified — filterQuestionBatch accepts historyStems, returns drop-counts
lib/learningContext.ts                                   NEW — single source of truth for exam-aware AI prompts
lib/learnerProfileFromGoal.ts                            NEW — derive k12/competitive_exam/corporate from exam_goal
lib/topicSuggestions.ts                                  NEW — replace 23 hardcoded subject placeholders
lib/markingSchemeMemory.ts                               NEW — resolveStickyScheme + writeLastMarkingScheme
lib/email.ts                                             NEW — nodemailer Gmail transport + co-teacher/primary invite templates
lib/features.ts                                          modified — calibration label renamed to "Confidence Insights"
lib/studentGoalTiles.ts                                  modified — Confidence Insights moved to "Diagnose a weakness"
components/MarkingSchemePicker.tsx                       NEW — reusable picker with PRACTICE/JEE/NEET/CAT/Custom + effective-rule preview
components/CurrentGoalChip.tsx                           NEW — persistent goal chip (school-student-safe)
components/StudentGoalPicker.tsx                         modified — Professional/training tile + auto-derive learner_profile
app/student/calibration/page.tsx                         modified — full plain-English rewrite + bridge banner to ZCORIQ Bloom Score
app/student/speed/page.tsx                               modified — Confidence Insights bridge link in results
app/student/results/[id]/page.tsx                        modified — "Review your answers" section
app/student/settings/goal/page.tsx                       NEW — master goal-change screen
app/student/layout.tsx                                   modified — removed hard /calibration redirect
app/school/classes/page.tsx                              modified — soft-delete UI + inactive section + confirm modal
app/api/report/[attemptId]/route.ts                      modified — PDF mirrors review section
app/api/speed/start/route.ts                             modified — learning context + recent-stems exclusion + filterQuestionBatch
app/api/student/quick-test/route.ts                      modified — same three-pronged upgrade
app/api/student/adaptive-practice/route.ts               modified — same
app/api/climber/today/route.ts                           modified — same
app/api/generate/route.ts                                modified — same
app/api/admin/classes/[id]/status/route.ts               NEW — soft-delete + reactivate
app/api/admin/classes/[id]/co-teachers/route.ts          modified — fires invite email after DB write
app/api/admin/classes/[id]/primary/route.ts              modified — fires primary-transfer email after DB write
supabase/migrations/77_last_marking_scheme.sql           NEW
supabase/migrations/78_class_active_status.sql           NEW
app/globals.css                                          modified — indigo override block
app/page.tsx                                             modified — neutralized hardcoded subject placeholder
app/teacher/papers/new/page.tsx                          modified — neutralized hardcoded subject placeholder
app/teacher/quizzes/new/page.tsx                         modified — neutralized hardcoded subject placeholder
```

### Where to pick up next

1. **Set `EMAIL_USER` + `EMAIL_PASS` in `.env.local`** (Gmail App Password — not regular password), then re-fire the co-teacher invite to `madathilvipink@gmail.com` to confirm delivery.
2. **Re-run the CICS mainframe Speed Trainer back-to-back** to verify the JSONB-source fix — dev console should show `history=N` with N>0 on the second run.
3. **Apply migrations 77 + 78** to the pilot Supabase (`profiles.last_marking_scheme`, `classes.status` etc.) — code already lands gracefully if columns are missing, but the picker won't persist and soft-delete will throw without them.
4. Optional: delete test attempt `307fccdd-713c-47d4-8b0c-a4aff00048ca` on `pplus.arjun` (Practice: Kubernetes pod scheduling) — leftover from session debugging.

### 9. Mock Rank Predictor foolproofing — refuse rank for non-exam mocks

User report: *"Users take a test on Java, but the mock rank predictor can predict rank on CAT — can you check and make it foolproof?"*

Reproduced exactly: a student takes a Java (or Kubernetes, or AWS, or any corporate-skill) quiz, opens `/student/results/[id]`, picks **CAT** from the Predict-my-rank dropdown, and ZCORIQ happily returns a CAT All-India Rank. A 50-question Java MCQ does not map to a CAT cohort and the resulting "AIR" was misleading. Two compounding problems:

1. `/api/rank/predict` silently coerced any unknown `exam_type` to `JEE_MAIN`, hiding client bugs behind a default the student never picked.
2. The route never looked at what the quiz was actually about, so the same Kubernetes attempt could be scored against the CAT / NEET / JEE_MAIN cohort interchangeably.

**Foolproof fix at three layers, single source of truth:**

* **`lib/rankPredictorEligibility.ts` (new)** — classifies a quiz by tokenising `subject + name + topic_family` into one of four verdicts:
  * `matches_known_exam` (JEE / NEET / CAT) — auto-suggests the right `exam_type`.
  * `competitive_exam_other` (GMAT / GATE / UPSC / IELTS / BITSAT / …) — allows with a `CUSTOM`-cohort fallback.
  * `corporate_skill` (Java / Python / AWS / Kubernetes / Docker / React / Postgres / …) — hard refuse.
  * `generic` — academic subject or unknown; allowed with a "rough benchmark only" note.
  Token-boundary safety means "Javelin throw" doesn't match JAVA, "Catalysis" doesn't match CAT. Also exports `validateExamType` + `validateScorePair` helpers that reject unknown exam types, NaN / Infinity / negative / over-max scores, and zero-length tests.

* **`app/api/rank/predict/route.ts`** — joins `quizzes(subject, name, topic_family)` and runs the classifier when `attempt_id` is set. Corporate-skill quizzes return **HTTP 422 `not_a_competitive_exam_mock`** with a clear, friendly explanation. When the quiz topic implies a different rank-baseline exam than the caller picked (e.g., quiz topic = "CAT mock 1" but `exam_type=JEE_MAIN`), the route auto-snaps `exam_type` to the topic-matched value and returns `exam_type_override: { from, to, reason }` so the UI can explain. Strict input validation replaces the silent JEE_MAIN coercion.

* **`app/student/results/[id]/page.tsx`** — gates the **Predict my rank** surface with the same classifier (single source of truth). Corporate-skill quizzes render a friendly "Rank prediction not available for this test" card instead of the dropdown, with a link to the standalone `/student/rank` page for users who do want to type a JEE/NEET/CAT score directly. Known-exam quizzes auto-default the dropdown to the matching exam ("This test looks like a CAT mock — we've pre-selected it below"). Any server-side `exam_type_override` is surfaced loudly in an amber banner.

**Column note** that bit me during testing: the `quizzes` table stores the user-supplied topic as `subject` (migration 04), **not** `topic` — the literal `topic` column lives only on `question_bank` rows. First pass used `quiz:quizzes(topic, …)` and every attempt-based call returned "Attempt not found" because the join column didn't exist. Fixed across route, types, UI fetch, and classifier call.

**Verification:**

* **`scripts/test-rank-predictor-eligibility.mjs`** — 55 standalone smoke tests (no test framework needed) pinning the classifier, validators, and token-boundary safety. Run with:
  ```bash
  node --experimental-strip-types scripts/test-rank-predictor-eligibility.mjs
  ```
* `tsc --noEmit -p tsconfig.check.json` clean on touched files (the `rate.retryAfterSec` narrowing warnings are pre-existing across every route in the codebase, not introduced here).
* **Live browser test** via Claude-in-Chrome on `localhost:3000` confirmed end-to-end:
  * Kubernetes attempt + `exam_type: CAT` → **422 refusal**, UI shows new "Rank prediction not available" card.
  * "Practice: CAT exam" attempt + `exam_type: JEE_MAIN` → **200** with auto-snap to CAT and `exam_type_override` banner.
  * Generic-math (LCM) + CAT → **200** with eligibility_note "general academic subject — rough benchmark only".
  * NaN / negative / raw>max / unknown `exam_type` → **400** each with clean error codes instead of silent coercion.

**Files touched:**
```
lib/rankPredictorEligibility.ts                          new — eligibility classifier + strict validators
scripts/test-rank-predictor-eligibility.mjs              new — 55 smoke tests
app/api/rank/predict/route.ts                            modified — strict validation, eligibility gate, exam_type override
app/student/results/[id]/page.tsx                        modified — UI gate for non-exam mocks, suggested exam_type, override banner
```

---

## 🆕 Earlier session — 2026-05-11 (B2B billing audit fixes + suspend-without-data-loss + cycle-math invariant)

Big day. Drove the entire B2B billing audit (Sessions 4 + 5) to "ready
for launch" status, fixed two production-impacting bugs found by the
test, added the missing suspension workflow Vipin asked for, and
re-anchored the cycle-expiry math so 1 year paid always equals 1 year
of access (no double-stack ever).

**Currently working through:** Chrome E2E test with `head.hema@sunrise.example.com` / `FreshPass123!`.
See **"Where to pick up tomorrow"** at the bottom of this section.

### What shipped today

**Migration 74 — B2B billing audit columns:**
* `subscriptions.payment_recorded_by` + `payment_recorded_at` (D3 audit trail — distinct from `payment_received_at`, which is the customer-stated bank-clearance date)
* `subscriptions.po_number` (D11 — school's purchase-order reference for finance reconciliation)
* `subscriptions.contract_years` (D15 — multi-year deal tracking, 1..10 with check constraint)
* `subscriptions.override_reason_type` (D18 — enum-flavored category for the existing free-text `override_reason`: `multi_year_deal`, `volume_discount`, `partner_discount`, `pilot_program`, `goodwill`, `corrective`, `other`)
* `plans.grace_period_days` (D10 — per-plan default for the post-expiry grace window; sub-row can still override)
* `schools.state` + `schools.gstin` (D12 — Indian GST place-of-supply; GSTIN is regex-validated when present)

**Migration 75 — suspension audit:**
* `subscriptions.suspended_at`, `suspended_by`, `suspended_reason` for the new "deactivate without losing data" workflow.
* Indexed only the suspended rows (partial index) so the "show me all past-due / suspended schools" admin query stays fast.

**API endpoints — new:**
* `POST /api/admin/subscriptions/[id]/suspend` — flips `status='suspended'`, stamps audit trail. **Zero data touched.** Classes, students, tests, attempts, invoices all stay. Feature gates (via `useFeatureAccess`) treat status=suspended exactly like an expired sub.
* `POST /api/admin/subscriptions/[id]/reactivate` — flips back to `active`, clears suspension fields. The cycle window (started_at / expires_at) is **untouched** — re-activation is purely about feature access, not term length.
* `GET /api/school/billing` — D7 school-side read-only billing view. Returns plan, cycle dates, PO number, payment status, past invoice archive. Excludes admin uuids (no leaking which ZCORIQ staffer touched the row). Gated on `role='super_teacher'` with a `school_id`.
* `GET /api/admin/schools/[id]/invoices.csv` — D16 finance export. Streams RFC-4180 CSV of live cycle + every archived cycle. Bearer auth required (anchors-with-no-headers don't work, so the UI uses a JS click handler + blob download — same pattern the invoice PDF bridge uses).
* `POST /api/admin/super-teachers/[id]/reset-password` — support tool, platform-admin gated. Mirrors the existing teacher-resets-student endpoint. Refuses to act on platform_admin accounts and on non-super_teacher accounts (defence in depth).

**API endpoints — semantics changed:**
* `POST /api/admin/subscriptions/[id]/mark-paid` is now a **pure finance event** — it stamps `payment_received_at` / `payment_recorded_at` / `payment_recorded_by` / `invoice_number` (auto-gen `BLM/YYYY/NNNN` if missing) / `po_number`, and **never modifies `expires_at` by default**. The old "smart extend" rule produced 2 years of access for 1 year payment when Save and Mark-paid happened back-to-back. Now that's mathematically impossible.
* Escape hatch retained: `body.extend_expires_at_days` (cap 366) lets a platform admin explicitly grant goodwill days for a late payer. Audited via `payment_recorded_by`. Not surfaced in the UI — purely an API lever for support tickets.
* `POST /api/admin/schools/[id]/set-plan` with `start_renewal: true` now **preserves unused days** from the closing cycle. Math: `new_expires_at = max(today, old.expires_at) + period_days`, so a school renewing 60 days before expiry gets `today + 425 days` of access instead of `today + 365`. Effectively appends the unused days to the new term.

**Cycle-expiry invariant (the big mental model):**

| Action | Who calls it | What it changes |
|---|---|---|
| **Save plan & pricing** | Platform admin (initial activation) | `started_at`, `expires_at = started_at + period_days` |
| **Start renewal cycle** | Platform admin (year N → N+1) | Archives old cycle to `subscription_invoice_archive`; resets `started_at = today`, `expires_at = max(today, old.expires_at) + period_days` |
| **Mark payment received** | Platform admin (after NEFT lands) | `payment_received_at` + audit fields + `invoice_number` + `po_number`. **Does not touch `expires_at`.** |
| **Suspend** | Platform admin (manual, e.g. non-payment) | `status = 'suspended'` + audit. Cycle dates untouched. |
| **Reactivate** | Platform admin (after dispute resolved) | `status = 'active'`. Cycle dates untouched. |

In English: Save activates the school immediately (they can use the product before NEFT clears). Mark-paid is the bank-receipt event. Start-renewal-cycle is what creates a new term. 1 year paid = 1 year of access, always.

**UI — per-school admin page (`/admin/schools/[id]`):**
* New "Reason category" dropdown (D18 — seven enum values)
* New "Contract length (years, optional)" input (D15 — 1..10)
* New "PO number (optional)" input in the Invoice & payment card (D11)
* New "School billing details (GST)" block with State + GSTIN inputs (D12)
* "Recorded in ZCORIQ at &lt;timestamp&gt;" sub-line under payment status (D3 visibility)
* "Download CSV" button in the past-invoices block (D16). JS-driven Bearer fetch + blob download.
* **Past-due warning** (amber) when `payment_received_at IS NULL` and >30 days since `started_at`. Nudges the operator to consider Suspend.
* **Suspended strip** (red) shows when `status='suspended'` with the audit reason + timestamp.
* **Suspend / Reactivate** buttons in the action row. Suspend opens a `prompt()` for a reason (defaults to "Non-payment after 30 days").
* Status badge in the header tile: **ACTIVE** / **EXPIRES IN Xd** / **EXPIRED** / **SUSPENDED** / **UNPAID Xd**.

**UI — school-side billing dashboard (`/school/billing`) — new page (D7):**
* Sidebar entry "Billing" under a new "Account" group.
* Plan card with status badge + expiry countdown.
* Current invoice + PO + payment status + GST place-of-supply.
* "Subscription suspended" red banner if applicable, with explicit "your data is all preserved" reassurance.
* Past billing cycles table (mirror of admin view).
* Friendly empty state with /pricing link when no plan.

**GST invoice PDF (D12):**
* Renders **CGST @ 9% + SGST @ 9%** when school state matches vendor state (e.g. Karnataka → Karnataka).
* Renders **IGST @ 18%** when interstate.
* Bill-to block surfaces school state + GSTIN.

**Feature access hook (`lib/featureAccess.ts`):**
* New `daysLeft` field — single source of truth so RenewBanner + tiles + sidebar all agree (D17, calendar-day ceiling).
* Now treats `status === 'suspended'` (or `'past_due'`) exactly like an expired subscription: locked tiles, empty `allowed` set, RenewBanner switches to red urgent mode.
* School-student branch removed the `.eq("status", "active")` filter so suspended schools render the "Suspended" empty state instead of pretending to be Free.

**Bug fixes baked into the test run:**
* **D6** (already fixed earlier session) — `is_trial: false` on Free→Paid upgrade, both UPDATE and INSERT branches of `/api/checkout/verify`.
* **D16 download button** — original implementation was a plain `<a href>` anchor, which cannot carry `Authorization: Bearer ...` headers. Converted to a JS click handler that fetches with Bearer, reads `Content-Disposition`, creates a Blob, synthesises an `<a download>` click. Verified working.
* **Cycle math double-stack** — see the invariant table above.

### Chrome E2E test status (verified end-to-end today)

Driven via the Chrome extension on `localhost:3000`, signed in as `ops@bloomiq.example.com` against school `RLS_Test_B_1778517634659` (id `5f1448ba-704d-4a1c-bd64-ca45bb934bd3`):

| Defect | What we verified | Status |
|---|---|---|
| D3 — payment audit | "Recorded in ZCORIQ at 11/5/2026, 11:34:50 pm" visible under payment status | ✅ |
| D10 — plans.grace_period_days | Default 14 picked up from plan when not overridden | ✅ |
| D11 — po_number | `PO/2026/BLM-001` persisted on subscription + visible in CSV | ✅ |
| D12 — GST invoice | TAX INVOICE PDF renders CGST 9% + SGST 9% (same state, Karnataka) | ✅ |
| D13 — auto BLM/YYYY/NNNN | `BLM/2026/0001` generated atomically at mark-paid time | ✅ |
| D15 — contract_years | 3-year contract persisted, surfaces in CSV | ✅ |
| D16 — CSV export | `text/csv` 429 bytes, all 14 columns, RFC-4180 | ✅ |
| D18 — override_reason_type | Dropdown shows all 7 enum values; "pilot_program" saved + in CSV | ✅ |
| **Cycle math** | Save → expires 11 May 2027; Mark-paid → expires still **11 May 2027** (no stack) | ✅ |
| **Mark-paid copy** | "Payment recorded. Cycle expires 11 May 2027 (unchanged)." | ✅ |
| **D7 — /school/billing render** | Verified late-day via Hema (`head.hema@sunrise.example.com` / `FreshPass123!`) → /school/billing showed Sunrise High · School Plus · ACTIVE badge · STARTED 12 May 2026 · EXPIRES 10 May 2028 (730d) · invoice BLM/2026/0002 · Awaiting/Received payment status · GST place-of-supply block · Past billing cycles archive. Sidebar shows "Account → Billing" entry. | ✅ |
| **Suspend / reactivate** | Code shipped, TypeScript clean. NOT yet visually verified. | ⏳ |
| **Early-renewal preserves days** | Verified end-to-end. Sunrise had expires_at = 11 May 2027. Clicked Start renewal cycle → new started_at = today (12 May 2026), new expires_at = max(today, old) + 365 = **10 May 2028 (730d)**. Unused ~365 days from prior cycle correctly appended to new term. | ✅ |
| **Cycle math invariant** | After renewal: Mark payment received → expiry stayed at 10 May 2028 (success banner: "Payment recorded. Cycle expires 10 May 2028 (unchanged)."). 1 year paid = 1 year of access holds across the full workflow. | ✅ |
| **BLM/YYYY/NNNN uniqueness** | **Bug discovered & fixed mid-test**: invoice number generation used `count(invoice_number IS NOT NULL)` on live subscriptions only. After start_renewal cleared the live row's invoice_number, count dropped — the next mint produced the same number as the freshly-archived cycle (BLM/2026/0002 → BLM/2026/0002 collision). **Fix**: scan BOTH `subscriptions.invoice_number` AND `subscription_invoice_archive.invoice_number` for the year, regex-parse the trailing seq, take max+1. Verified with another renewal-then-mark-paid round → minted BLM/2026/0003 correctly, no collision with the two prior BLM/2026/0002s in archive. GST compliance restored. | ✅ |

### Files changed this session

```
supabase/migrations/74_b2b_billing_audit_and_gst.sql                   NEW
supabase/migrations/75_subscription_suspension.sql                     NEW
app/api/admin/schools/[id]/route.ts                                    modified — returns Wave 2 fields + suspension fields
app/api/admin/schools/[id]/set-plan/route.ts                           modified — accepts po_number/contract_years/override_reason_type/state/gstin + early-renewal preserves days
app/api/admin/schools/[id]/invoices.csv/route.ts                       NEW (D16)
app/api/admin/subscriptions/[id]/mark-paid/route.ts                    modified — stamp-only semantics + auto BLM/YYYY/NNNN (max-seq across live+archive) + escape hatch
app/api/admin/subscriptions/[id]/invoice/route.ts                      modified — GST CGST+SGST vs IGST (D12)
app/api/admin/subscriptions/[id]/suspend/route.ts                      NEW
app/api/admin/subscriptions/[id]/reactivate/route.ts                   NEW
app/api/admin/super-teachers/[id]/reset-password/route.ts              NEW (support tool)
app/api/school/billing/route.ts                                        NEW (D7)
app/admin/schools/[id]/page.tsx                                        modified — Wave 2 inputs + suspend/reactivate + past-due warning + CSV button
app/school/billing/page.tsx                                            NEW (D7) — read-only billing dashboard with Suspended banner
app/school/page.tsx                                                    modified — daysLeft prop on RenewBanner
app/student/page.tsx                                                   modified — daysLeft prop on RenewBanner
components/Sidebar.tsx                                                 modified — "Billing" under "Account" group for super_teacher
components/RenewBanner.tsx                                             modified — daysLeft from prop (D17)
lib/featureAccess.ts                                                   modified — daysLeft single source of truth + suspended treated as expired
docs/PRELAUNCH_SESSION_5.md                                            NEW — full session write-up
docs/PRELAUNCH_SESSION_5_CHROME_TEST.md                                NEW — Chrome E2E verification report
```

TypeScript compiles clean (`npx tsc --noEmit --skipLibCheck` — no errors except a pre-existing one in `.next/dev/types/routes.d.ts` which is a dev-cache artifact).

### Where to pick up tomorrow

**The thing I was in the middle of when the day ended:**

Driving the entire workflow through Chrome as a super_teacher login. Vipin told me to use:

- **Email:** `head.hema@sunrise.example.com`
- **Password:** `FreshPass123!`
- **Login route:** `/login/school` → Admin Head tab

That account belongs to Sunrise (a real seeded school). Sign in there, verify:

1. **`/school/billing` renders for a real super_teacher** (D7 visual verification — the only checklist item that's still ⏳). Should show plan, expiry, invoice number, PO if any, GST block, payment status. If Sunrise has no paid plan, should render the friendly "No active subscription" empty state.
2. **Suspend / reactivate round-trip.** Sign in as `ops@bloomiq.example.com` / `TestPass123!` via `/staff`, navigate to Sunrise's admin page (`/admin/schools/<sunrise_id>`), click Suspend with a reason, then immediately sign in as Hema again — Billing page should show the red "Subscription suspended" banner, and `useFeatureAccess` should lock her tiles. Then sign back in as ops, click Reactivate, and confirm Hema's features unlock and the banner disappears.
3. **Early-renewal preserves unused days.** On Sunrise's admin page, take note of the current `expires_at`. Backdate `activation_date` to ~60 days ago via the input, click Save (this gives the school a cycle that's ~305 days into a 365-day term). Then click "Start renewal cycle" and verify the new `expires_at` = old expires_at + 365 (not today + 365). Roughly: if old expires was "today + 60 days", new expires should be "today + 425 days".
4. **Past-due warning visibility.** Backdate `activation_date` to >30 days ago for a school that has no `payment_received_at`. Verify the amber "Unpaid Nd" banner appears and the header badge changes to "UNPAID Nd". Click Suspend, verify red strip. Click Reactivate, verify amber returns.

**Smaller follow-ups still on the books from prior sessions:**

* P0 D1 — no transactional email service wired anywhere. Invoices download → manually attached to outgoing email. Need a Resend / Postmark integration and a `/api/admin/subscriptions/[id]/send-invoice` endpoint.
* P0 D4 — server-side `grace_period_days` is read by `useFeatureAccess` but not re-checked at the route gate when admin actions act on behalf of a user.
* P0 D8 — `activation_pending` is never auto-flipped to `false` on first sign-in by the super_teacher.
* P3 D5 — RenewBanner has an `isSchoolAdminMode` branch that could be split into PersonalRenewBanner + SchoolRenewBanner. Decided to defer (the existing branching is clean), but noted for future.

**Test infra reminder:**

* `node scripts/seed-test-users.js` re-creates the seeded set (principal@testacademy, deputy@testacademy, ms.priya, mr.raj, ops@bloomiq, ...). Default password is `TestPass123!`. Run it if you ever wipe the dev DB.
* The dev DB had **zero `profiles.role='super_teacher'` rows** at the start of today's test — every onboarded school showed "Pending" with no accepted invite. That's why I asked Vipin for a working super_teacher account. He provided `head.hema@sunrise.example.com / FreshPass123!`.
* `/api/admin/super-teachers/[id]/reset-password` was added today specifically for the next time a school admin loses their password. Platform-admin gated.

**Sandbox quirk that bit me twice:**

The Edit tool occasionally truncates CRLF files mid-line when used on `components/Sidebar.tsx`, `app/school/page.tsx`, `app/student/page.tsx`. Worked around by:
1. Restoring the file from HEAD via `git show HEAD:path > /tmp/...`
2. Re-applying the surgical edit through a Python heredoc that reads bytes, normalises CRLF → LF for editing, then re-emits CRLF on write.

For future sessions: **prefer Python heredocs for edits to large CRLF files**. The Edit tool is safer on shorter targets (1–300 lines).

---

## 🆕 Earlier session — 2026-05-10 evening (Test harness for B2B billing + UX polish: /admin/plans edit fix, /student/expired dual-tier upgrade)

Three small but meaningful fixes on top of the day's bigger work:

### What shipped — automated test harness for B2B billing

Built two test scripts so the B2B billing pipeline shipped earlier today
has both unit-level and end-to-end coverage going into launch:

- **`scripts/test-billing-logic.js`** — sandbox-runnable, no DB needed.
  41 assertions covering every algorithmic decision in the billing code:
  the four-case `started_at`/`expires_at` decision tree (start_renewal,
  brand-new bind, mid-cycle plan change, plan removed), all three
  mark-paid extend-anchor strategies (smart, previous_expiry, received_at),
  every grace-window boundary in `useFeatureAccess`, GST math with rounding
  edge cases, BLM/YYYY/NNNN sequence padding, and first-sign-in activation
  flip semantics. Verified **41/41 PASS** in sandbox. Run with
  `node scripts/test-billing-logic.js` — exits 0 on green.

- **`scripts/test-billing-e2e.js`** — needs the live Supabase but no UI.
  Walks through 7 scenarios end-to-end: creates a fresh test school,
  binds a Pilot plan with `activation_pending=true` + override price +
  contracted seats, simulates first-sign-in flip, performs mid-cycle
  plan change to verify expires_at is preserved, generates an invoice,
  marks payment received, triggers `start_renewal` to verify cycle
  archiving + invoice number clearing, asserts every step against
  expected DB state, then cleans up. Single command: `node scripts/test-billing-e2e.js`.
  Aborts cleanly with a clear message if migrations 64+65 aren't applied.

### What shipped — `/admin/schools/[id]` defects D1 + D2 fixed

After driving the per-school admin page through Chrome end-to-end, two
small UX defects surfaced. Both fixed:

- **D1** — Activation date input field hydrated as UTC YYYY-MM-DD.
  An operator who entered "1 Jun" (IST) and reloaded saw "31 May" back —
  the value the field was bound to was the UTC slice of the same instant.
  Fix: hydrate via `new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })`
  in `load()` so the input always shows IST-local YYYY-MM-DD.

- **D2** — EXPIRES tile didn't refresh immediately after Save (showed the
  old value until a hard reload). Fix: pass `cache: "no-store"` to the
  load() fetch so post-save reloads bypass any browser/Next.js cache and
  pick up the freshly-written subscription row immediately. Verified in
  Chrome: changing date `2026-06-01` → `2026-07-15`, clicking Save, the
  EXPIRES tile updates to "15 Jul 2027 (431d)" with no manual reload.

Test trail in `docs/CHROME_E2E_2026-05-10_expiry_edit.md` and `docs/TEST_REPORT_2026-05-10.md`.

### What shipped — `/admin/plans` Edit button + stretched-link bug fix

The catalogue of plan SKUs (Premium / Premium Plus / School Pilot /
Standard / Plus / etc.) at `/admin/plans` had two related issues:

1. The whole card was supposed to be clickable — a "stretched link"
   pattern that opened `/admin/plans/[id]/edit`. But the link was
   `z-0` while the card content was `z-10`, so clicks always landed
   on the higher-z content (text/divs that aren't links themselves)
   and the link was unreachable. The card looked clickable but did
   nothing.
2. The only visual edit affordance was a muted Pencil icon at the
   top-right — decorative, not a button. New admins never realized
   the card was meant to be clickable.

Fix: dropped the broken stretched-link entirely; replaced the muted
Pencil with an explicit **Edit** button (brand-coloured, primary
styling) right next to the existing Clone button. Both go through
the proposal queue as before. Verified in Chrome: each plan card now
has visible Edit + Clone buttons, click navigates correctly to
`/admin/plans/[id]/edit`, edit form loads with Pricing/Display copy/Features.

### What shipped — `/student/expired` shows BOTH Premium and Premium Plus

The day-8 lockout page (rendered when a student's 7-day Free trial elapses)
previously had a single "Upgrade to Premium" CTA — Premium Plus was
hidden behind it on `/pricing`. Most students never got to compare.

Replaced with a **two-column upgrade panel**:

- **Premium** (indigo) — labelled "Most learners pick this". Bullets:
  unlimited daily drills, full ZCORIQ Bloom Score + weekly active path,
  AI tutor + Coach, adaptive practice from weakest topics. CTA:
  "Choose Premium" → `/pricing?tier=premium`.
- **Premium Plus** (violet) — with a "BEST FOR EXAM PREP" ribbon.
  Bullets: everything in Premium, past-paper X-ray + trap detector,
  mock-rank predictor (NEET/JEE/CAT), voice teacher + concept animations.
  CTA: "Choose Premium Plus" → `/pricing?tier=premium_plus`.

Sign-out demoted to a small secondary button. Quiet "Compare all plans
side-by-side →" link below for users who want the full comparison
before deciding. Each CTA passes a `?tier=` hint so `/pricing` can
highlight the right card.

### Files touched

**New:**
- `scripts/test-billing-logic.js` (449 lines)
- `scripts/test-billing-e2e.js` (323 lines)
- `docs/TEST_REPORT_2026-05-10.md` (test summary)
- `docs/CHROME_E2E_2026-05-10_expiry_edit.md` (Chrome run report)

**Modified:**
- `app/admin/schools/[id]/page.tsx` — D1 + D2 fixes (toLocaleDateString IST + cache no-store)
- `app/admin/plans/page.tsx` — Edit button replaces broken stretched-link
- `app/student/expired/page.tsx` — two-tier upgrade panel
- Plus the type-narrowing fixes (as-unknown-as) in
  `app/api/admin/schools/[id]/route.ts`,
  `app/api/admin/schools/[id]/set-plan/route.ts`,
  `app/api/admin/subscriptions/[id]/invoice/route.ts`
  (Supabase types narrow to GenericStringError when selects reference
  columns the type cache doesn't know about; the codebase already had
  the as-unknown-as pattern, applied it consistently here).

### Verified

- TypeScript: 0 errors in any file shipped today (the 23 errors that
  appear in `npx tsc --noEmit` are all pre-existing latent issues in
  files I didn't touch — calibration/log, school/digest enums, etc.)
- ESLint: 0 errors on the 14 files in scope; only minor `react-hooks/purity`
  warnings on existing `Date.now()` patterns the codebase uses widely.
- 41/41 logic tests pass.
- Chrome E2E pass on `/admin/schools/[id]` activation/grace/save flow,
  `/admin/plans` Edit button click, `/student/expired` two-tier render.

---

## 🆕 Earlier session — 2026-05-10 morning (ZCORIQ Bloom Score + Future You: the killer first-run feature; 7-day Free-plan validity)

The headline shift: ZCORIQ now has a **single 3-digit "ZCORIQ Bloom Score" (300–900)** that every independent student sees from the moment they sign in. It powers a dramatic "Future You" reveal page predicting their exam-day rank and named target colleges, with a "Best You" delta showing how much they'd lift if they fix their weakest Bloom levels. The score sits permanently in the layout's top-right and updates after every quiz or drill. Plus a hard-gated 7-day Free-plan validity window — admin-editable from `/admin/plans` — that converts free-plan tyre-kickers into upgrade prompts on day 8.

### What shipped — the killer-feature flow

**The 7-minute first-run calibration:**
- New page `/student/bloom-score` — 12 Bloom-tagged questions generated by Groq tailored to the student's exam goal (one of NEET / JEE / CAT / UPSC / Class 5–8 / Class 9 / Class 10 boards / Class 12 boards / Bank exams / "exploring").
- New `lib/calibrationGenerator.ts` builds the prompt and validates the JSON shape. Per-exam profile in `EXAM_PROFILES` brief Groq with audience, difficulty bar, subjects, and anchored sample questions per Bloom level — so a CAT student gets graduate-level QA/VARC/DI/LR, a Class 5–8 student gets NCERT primary-school content, and a NEET student gets Phys/Chem/Bio NCERT difficulty. No more "What is the full form of NEET?" meta-questions; the prompt explicitly bans those.
- Bloom labels are HIDDEN from the student during the quiz on purpose — clean cognitive measurement, not test-taking strategy.
- API: `POST /api/student/calibration/start` (returns 12 generated questions) + `POST /api/student/calibration/submit` (scores, persists, returns Future You payload).

**The dramatic reveal at `/student/future`:**
- Animated count-up from 300 to the student's score (only on first reveal — `?fresh=1`).
- Predicted exam-day rank label (NEET/JEE = "AIR ~26,990", CAT = "Predicted CAT %ile ~98.2", Boards = "Predicted ~85% in board exams", Class 5–8 = "Ahead of 73% of grade-level peers").
- 3 named target colleges per exam (real cutoffs: AIIMS Delhi, IIT Bombay CSE, IIM Ahmedabad, etc.).
- Side-by-side "Best You" card showing the lifted rank if they fix their top-3 weakest Bloom levels — with a `+257` delta.
- "What this score means" insights card with: Bloom signature label ("Fast Recogniser, Slow Applier" / "Building Your Foundation" / etc.), top-strength callout, top-concern callout, and a time-to-Best-You estimate ("8–15 weeks at 30 min/day").
- A `Bloom-breakdown` row of 6 progress bars showing per-level mastery percentages.

**Tier-aware bottom section** (driven by `useFeatureAccess`):
- Free / anon → personalised Premium pitch tied to THE STUDENT'S exact gaps with three weekly habits (e.g. "Tackle 15 Evaluate-level critical-reasoning questions · expected ~+86 pts · 75 min/week"). Clear "₹99/month" + "Cancel anytime" guarantee. Free-cap pre-flight on the "Try a free drill" button (`X/3 left today` inline; switches to "Free cap hit — unlock more" → /pricing when 0).
- Premium / Premium Plus / school plans → "active path" tracker with real per-Bloom-level weekly drill counters (3-dot strip + "X/3 this week" pulled from `/api/student/weekly-drill-progress` aggregating attempt_answers). Each row links to a one-tap drill. No price tag, no upsell (except a soft Premium Plus nudge for Premium-tier users).

**One-tap deep-linked drills:**
- Every "Start" button on Future You routes to `/student/practice?bloom=<level>&topic=<topic>&auto=1`. The practice page detects the deep-link, shows a green "Drilling: <topic>" banner, auto-fires `/api/student/adaptive-practice` with `target_bloom` override, and redirects to the quiz in ~5 seconds.
- The drill topic is the student's ACTUAL weakest topic from `calibration_responses` (rows where `is_correct=false`, ranked by frequency, filtered to the target Bloom level when possible) — not a generic "mix of subjects". Falls back to a single-subject string per exam goal (e.g. "NEET Biology — Class 11/12 NCERT") when no calibration signal is available.
- Server-side belt-and-suspenders: `/api/student/adaptive-practice` re-checks the topic and upgrades it from `calibration_responses` if it still looks generic.

**Persistent ZCORIQ Bloom Score badge in the layout:**
- Top-right of every `/student/*` page (except the calibration quiz and the reveal itself).
- Shows the 3-digit score + day-over-day trend arrow + delta. Tap to open `/student/future`. Uncalibrated users see a "Get your ZCORIQ →" CTA instead.
- 1-minute in-memory cache so it doesn't re-fetch on every navigation; refetches on window focus.

**Discovery hero on `/student` home:**
- First-run only (when `has_calibration=false`). Big gradient card titled "Discover your ZCORIQ Bloom Score" with a 7-minute setup pitch.
- Auto-disappears once the student calibrates.

**"Change goal" affordance + stale-calibration banner:**
- New "Change goal" link in the Future You score header strip, routing to `/student/bloom-score`.
- When `profiles.exam_goal` differs from `calibrations.exam_goal`, an amber banner appears above the score: "Your goal changed — your score is now stale". The score-hero card dims to 70% opacity to visually flag that the predictions are tied to the old goal.

### What shipped — the 7-day Free-plan validity window

**Migration 67 (`67_free_trial_days.sql`):**
- Adds `subscription_limits.free_trial_days` (int, default 7, capped 0–90) — the platform-wide validity window.
- Adds `subscriptions.is_trial` (boolean, default false) — distinguishes auto-granted Free rows from any future manually-created Free rows.
- Backfills existing `subscription_limits` row to 7 days if it's currently null/0.

**Auto-grant on first sign-in:**
- `/api/auth/me` checks: if the user is `role='student' + is_school_student=false + school_id=null` AND has no subscription row AND `free_trial_days > 0`, it inserts a `tier='free' + is_trial=true + expires_at=now+N` subscription row.
- Idempotent: only fires when no subscription exists. Re-runs are no-ops.

**Hard upgrade gate at expiry:**
- `/api/auth/me` also computes `is_free_expired` — true when the existing subscription is `tier='free' + is_trial=true + expires_at<now`.
- The student layout intercepts this and redirects every `/student/*` route (except `/student/expired` itself) to a hard lockout page: "Your free access has ended. Upgrade to Premium to continue." with a /pricing CTA and a list of what Premium unlocks. NO silent degradation to permanent Free.
- Paid Premium users (`tier='premium'`) are NEVER affected by this — they still get the existing graceful expiry behaviour from the renewal banner / grace period.

**Admin control on `/admin/plans`:**
- New `FreeTrialSettings` card at the top of the page. Number input 0–90, default 7. Save button calls `PATCH /api/admin/free-trial-settings`.
- Setting to 0 → Free is permanent (no expiry, no gate) — the legacy behaviour.
- Setting to 7 → every new student gets 7 days of Free, then locked out until upgrade. Editable any time; affects new sign-ups thereafter.

### Schema, files, and routes touched

**New SQL migration:**
- `supabase/migrations/66_bloomiq_score_calibration.sql` (calibrations + calibration_responses + bloomiq_scores tables + RLS).
- `supabase/migrations/67_free_trial_days.sql` (free_trial_days + is_trial columns).

**New libs:**
- `lib/calibrationGenerator.ts` (Groq prompt, EXAM_PROFILES per exam goal, Bloom-mix validator).
- `lib/bloomiqScore.ts` (`computeScore`, `computeBestYou`, `predictRankAndColleges` with NEET/JEE/CAT/Boards/primary_middle branches, `BLOOM_LABEL` map).
- `lib/bloomiqInsights.ts` (`computeSignature` with 8 archetypes, `computeStrength` / `computeConcern` / `computeTimeToBestYou` / `computeUpgradeNarrative` / `topicForGoal`).

**New API routes:**
- `POST /api/student/calibration/start` — generates 12 questions for the user's exam goal.
- `POST /api/student/calibration/submit` — scores, persists, returns Future You payload.
- `GET /api/student/score` — returns latest score + trend + calibration snapshot + `is_stale`.
- `POST /api/student/score/recompute` — recomputes after quiz, blends calibration anchor + recency-weighted attempt_answers.
- `GET /api/student/weekly-drill-progress` — per-Bloom-level drill counts for current ISO week.
- `GET/PATCH /api/admin/free-trial-settings` — platform-admin Free-plan-validity setting.
- Modified `POST /api/student/adaptive-practice` to accept optional `target_bloom` override + auto-upgrade generic topics from calibration_responses.

**New pages:**
- `app/student/bloom-score/page.tsx` — the 12-question calibration quiz (intro → quiz → submitting states).
- `app/student/future/page.tsx` — the Future You reveal (score hero, Best You, insights, tier-aware pitch/active-path, stale banner, Best-You-reached prompt).
- `app/student/expired/page.tsx` — the hard lockout when Free-plan validity has elapsed.

**New components:**
- `components/BloomIQScoreBadge.tsx` — persistent top-right score chip.

**Modified:**
- `components/StudentGoalPicker.tsx` — added `class_5_8` and `class_9` options.
- `app/student/layout.tsx` — mounts the ZCORIQ badge + intercepts is_free_expired.
- `app/student/page.tsx` — shows the ZCORIQ Bloom Score discovery hero on first-run.
- `app/admin/plans/page.tsx` — mounts the FreeTrialSettings card.
- `app/student/practice/page.tsx` — reads `?bloom=`, `?topic=`, `?auto=1` query params, auto-fires drill on deep link.
- `app/api/auth/me/route.ts` — auto-grants Free trial + computes is_free_expired.
- `app/student/calibration/page.tsx` — de-jargoned the Confidence Calibration intro copy ("Are your hunches actually right?" instead of "metacognitive skill").

**Test-account scripts:**
- `scripts/create-3-free-students.js` — spins up 3 Free-plan independent students (Class 12 boards / NEET prep / Class 5–8) with email already confirmed for E2E. Pass `--reset` to wipe and recreate.

### How to test (after applying migrations 66 + 67)

1. `node scripts/create-3-free-students.js` from project root — creates the test students.
2. Sign in as `free.student.1@bloomiq-test.local` / `TestPass123!` (Class 12 student).
3. Goal-picker is skipped (already set). The "Discover your ZCORIQ Bloom Score" hero card is visible.
4. Tap it → take 12 calibration questions — ~7 minutes.
5. Land on `/student/future` with a 300–900 score, predicted "Top X% in board exams" + named DU/CUET colleges, Bloom signature, weekly time-to-Best-You estimate, and the personalised Premium pitch tied to your gaps.
6. Tap "Try a free drill" — lands on `/student/practice?bloom=<level>&topic=<weakest topic>&auto=1`, auto-fires, redirects to the quiz in ~5 seconds. Questions are drawn from your weakest specific topic (e.g. "Photosynthesis"), at your weakest Bloom level.
7. Wait 7 days (or set `subscription_limits.free_trial_days = 1` and wait a day, or set the row's `expires_at` to a past date for an instant test). Sign in again. Every `/student/*` route redirects to `/student/expired` until upgrade.

### Known follow-ups (not blockers)

- **Best You retargeting:** when current score climbs to or past the original Best You target, a "Re-calibrate" prompt surfaces — but the underlying Best You stays frozen at the calibration-time projection. v2 could re-derive Best You on each recompute.
- **Trial expiry warning banner:** before day 7, a "Your free access expires in N days" banner on `/student` would soften the lockout. Not built yet.
- **Score history line chart:** the `bloomiq_scores` time-series captures every score update, but there's no visualisation yet (the active-path "See score history" CTA links to `/student/progress`, which exists but isn't yet wired to render the ZCORIQ time-series).
- **Per-action drill-count target:** the active-path 3-dot strip uses a hardcoded weekly target of 3. Could be derived from each action's `weeklyTime` for accuracy.
- **Topic Layer-2 server upgrade:** when a generic topic is detected, the API queries calibration_responses for a real weakest topic. This already works but doesn't yet know about `attempt_answers` patterns post-calibration — so over time, when a student's calibration is months old but their recent quiz attempts paint a different picture, the topic upgrade could pull from attempt_answers too.

---

## 🆕 Earlier session — 2026-05-09 / 2026-05-10 morning (B2B billing: negotiated price, GST invoices, renewal workflow, modern expiry)

The headline shift: ZCORIQ now has a **complete operator-driven B2B
billing pipeline** for school deals — from negotiated-price onboarding
through GST-compliant invoice generation, NEFT payment recording,
year-on-year renewal cycles with audit trail, and modern-app expiry
handling (grace period, deferred activation, mid-cycle plan-change
preservation). Replaces the previous "self-serve Razorpay only"
assumption that didn't fit how Indian schools actually buy.

Six migrations (60–65), one new admin screen (`/admin/schools/[id]`),
new endpoints for invoice + mark-paid + renewal, and across-the-board
visibility of plan expiry on operator and customer surfaces.

### What shipped

**Pricing realignment (migrations 60–61):**
- Removed `weekly_digest` from the School Pilot feature set (Pilot is
  the entry tier, no Coach, no digest; Standard adds 50/mo Coach;
  Plus is unlimited Coach + everything).
- Realigned per-student-per-year prices to a monotonic ladder:
  ₹29 (Pilot) / ₹49 (Standard) / ₹69 (Plus). The previous numbers
  had Plus cheaper than Standard, which inverted the upgrade story.
- Dropped the legacy `max_students` cap on Pilot/Standard so a 2 000-
  student school doesn't get blocked off the cheaper tiers.

**Coach quota (migration 59):**
- New `coach_usage` table (one row per Coach call) keyed by user_id +
  surface ('teacher' | 'school'). RLS: users read their own; only
  service role inserts.
- `lib/coachQuota.ts` exposes `checkCoachQuota(userId, surface)` and
  `logCoachCall`. Per-month bucket: Pilot 0, Standard 50, Plus ∞.
- Both Coach endpoints (`/api/teacher/coach`, `/api/school/coach`)
  call the gate before LLM, return 402 + `quota.{used,limit,planSlug}`
  when exceeded; surface stays usable in the UI but with the lock badge.

**Negotiated-price subscriptions (migration 62):**
- Added `subscriptions.override_price_paise`, `override_reason`,
  `override_set_by`, `override_set_at`, `invoice_number`,
  `payment_method` (CHECK in razorpay/neft/cheque/manual),
  `payment_received_at` columns.
- Override beats formula: list price = `per_student × students`, but
  `override_price_paise` (when set) is the authoritative line-item
  amount on the invoice.
- All audit fields are write-once-on-change so plan picker changes
  don't reset override timestamps.

**Contracted students (migration 63):**
- New `subscriptions.contracted_students INTEGER`. Distinguishes the
  "school agreed to buy 700 seats" number (drives invoicing) from the
  "23 kids have actually signed in by Day 30" number (`profiles` count).
- Invoice line-item quantity uses `contracted_students` when set,
  otherwise actual student count.

**Invoice archive (migration 64):**
- New `subscription_invoice_archive` table — immutable per-billing-cycle
  snapshot. Service-role-only (RLS denies everyone else).
- Captures invoice number, contracted seats, override price, reason,
  payment method, payment timestamp, cycle started/expired anchors,
  who archived it.
- Populated by `set-plan` when called with `start_renewal: true` —
  the closing cycle's data is preserved before the live row is wiped
  for the new term.

**Modern expiry (migration 65) — the deepest change:**
- Added `subscriptions.grace_period_days INTEGER DEFAULT 14` — soft
  window after `expires_at` where features still work but RenewBanner
  flips to red urgent mode. Configurable per school (0 = hard cliff).
- Added `subscriptions.activation_pending BOOLEAN DEFAULT FALSE`.
  When true, `started_at`/`expires_at` are placeholders; the term
  clock actually starts on the school super_teacher's first sign-in.
  Solves the "onboarded 1 Aug, admin first signs in 5 Aug" lag.

**`/admin/schools/[id]` — the operator's single-screen B2B console:**

A new per-school admin page that drives the entire B2B deal end-to-end:

- HEADER: school name + status badge (Active / Expiring in Nd /
  Expired) + 3 tiles (Plan / Expires-with-countdown / Active price).
- PLAN & PRICING: plan picker, contracted-students input, recalculating
  list price card (`rate × seats = ₹X`), negotiated-price override card
  with audit reason, payment method picker.
- ACTIVATION & GRACE (post-mig-65): activation date picker (lets
  operator backdate or future-date for academic-year deals), "Defer
  until first sign-in" checkbox, grace-period-days input.
- INVOICE & PAYMENT: invoice number, payment status, **View / download
  invoice** button (opens GST tax invoice PDF), **Mark payment received**
  (extends expiry), **Start renewal cycle** (only visible after a
  payment exists — archives current cycle, clears invoice number, primes
  for next year's BLM/YYYY/NNNN).
- PAST BILLING CYCLES: read-only table from `subscription_invoice_archive`
  showing every closed term — invoice #, dates, seats, amount, paid date.

Reachable from the new "Manage" link in `/admin/onboard-school` Recent
onboardings + the new "Upcoming plan expirations" widget on `/admin/dashboard`.

**Invoice generator:**
- `GET /api/admin/subscriptions/[id]/invoice` produces a GST-compliant
  Indian tax invoice PDF (jspdf + jspdf-autotable). HSN/SAC 998313, IGST
  18%, BLM/YYYY/NNNN auto-numbering, vendor block from env vars
  (`INVOICE_VENDOR_NAME`, `_GSTIN`, `_ADDRESS`, `_STATE`, `INVOICE_BANK_*`),
  customer name from `schools.name`, line item from contracted_students ×
  per-student rate (or override).
- Invoice number is persisted on the subscription row on first download
  so re-downloads return the same PDF; "Start renewal cycle" clears it
  so the next download mints a fresh number.
- Bridge page at `/admin/subscriptions/[id]/invoice` solves the
  Bearer-only auth problem — fetches the PDF with the access token,
  creates an object URL, embeds in iframe (so direct linking works
  even though the API is Authorization-header-only).

**Mark-paid endpoint:**
- `POST /api/admin/subscriptions/[id]/mark-paid` records NEFT/cheque
  receipt; sets `payment_received_at`, flips `status='active'`, clears
  `activation_pending`, extends `expires_at` by one full plan period.
- Smart anchor logic: early renewal preserves remainder (extend from
  existing.expires_at), late/first payment anchors on received_at.
- Body accepts `extend_from: 'smart' | 'previous_expiry' | 'received_at'`
  for B2B finance teams that need clean academic-year cycles vs
  penalty-style late-renewal resets.
- Response returns both `previous_expires_at` and `expires_at` so the
  UI can render an audit-style "extends X → Y" preview.

**`set-plan` endpoint — four-case decision tree for `started_at`/`expires_at`:**

1. **`start_renewal:true`** — fresh cycle. Archive prior cycle to
   `subscription_invoice_archive`, then `started_at = now` (or explicit
   `body.started_at`), `expires_at = started_at + period_days`.
2. **Brand-new bind** (no existing row OR existing had no plan) —
   `started_at = body.started_at || now`, expires_at as above.
3. **Mid-cycle plan change** (existing row has plan + expires_at, no
   `start_renewal` flag) — **PRESERVES** existing `started_at` and
   `expires_at`. Pilot→Plus mid-year keeps the year they paid for; the
   prorated upgrade fee is a separate billing decision.
4. **Plan removed** (planId is null) — null out dates so `/school` reads
   "Not subscribed".

Plus accepts new body fields: `started_at` (ISO date), `activation_pending`
(bool), `grace_period_days` (number).

**First-sign-in activation flip:**
- `/api/auth/me` (called on every page load) checks: am I a super_teacher
  whose school has `activation_pending=true`? If yes, write
  `started_at = now`, `expires_at = now + period_days`, clear the flag.
  Idempotent (only fires while flag is true), gated to super_teacher
  (regular teacher signing in first doesn't trigger).

**Expiry & grace in `useFeatureAccess` + `RenewBanner`:**
- New `isInGrace: boolean` and `graceRemainingDays: number` exposed
  from `useFeatureAccess`. `isExpired` now means "past expires_at AND
  past grace window" — features stay enabled in grace.
- `RenewBanner` adds a third state: in-grace (red, "X grace days
  remaining — features still active during this short window").
  Existing 7-day-warn (amber) and beyond-grace (red, hard lockout)
  states preserved.
- `CurrentPlanBadge` now shows `Greenwood: School Plus · renews 12 Aug 2026`
  (or `expired 12 Aug 2026`) inline — visible always on `/school`,
  `/student`, `/settings/profile`.

**Cross-surface visibility of plan expiry:**
- `/admin/dashboard` — new "Upcoming plan expirations" section listing
  schools whose plans expire in the next 60 days (or already lapsed).
  Tone-coded: red >14 days past, amber ≤14 days remaining, slate beyond.
  Each row → "Manage" link to `/admin/schools/[id]`.
- `/admin/onboard-school` — Recent onboardings table gained an "Expires"
  column with three-bucket badge (Active green / Expires in Nd amber /
  Expired DD MMM red / muted dash for unbound plans).
- `/admin/schools/[id]` — header status badge + three metric tiles
  (already covered above).
- `/school` (Admin Head's view) — `CurrentPlanBadge` shows the renews
  date; `RenewBanner` covers the 7-day-warn + grace + expired states.

**Help system updates:**
- New "How does renewal work? When do I pay?" topic under Account & Plan
  on `/help` for super_teachers — explains both NEFT (ZCORIQ emails GST
  invoice → school pays via bank → we mark received → plan extends) and
  Razorpay paths, plus the 7-day amber warning, the 14-day grace, and
  the email-us-anytime fallback. Fixed stale "managed by Anthropic / sales"
  copy → "managed by the ZCORIQ team".

### Files touched

**Migrations:**
- `supabase/migrations/59_coach_quota.sql` (new)
- `supabase/migrations/60_school_plan_cleanup.sql` (new)
- `supabase/migrations/61_school_plan_pricing_realign.sql` (new)
- `supabase/migrations/62_subscription_negotiated_price.sql` (new)
- `supabase/migrations/63_subscription_contracted_students.sql` (new)
- `supabase/migrations/64_subscription_invoice_archive.sql` (new)
- `supabase/migrations/65_subscription_expiry_modernization.sql` (new)

**New endpoints:**
- `app/api/admin/schools/[id]/route.ts` (new — GET school+sub+plan+invoices, DELETE school)
- `app/api/admin/schools/[id]/set-plan/route.ts` (new — bind plan + override + start_renewal)
- `app/api/admin/subscriptions/[id]/invoice/route.ts` (new — GST tax invoice PDF)
- `app/api/admin/subscriptions/[id]/mark-paid/route.ts` (new — NEFT receipt + extend expiry)

**New screens:**
- `app/admin/schools/[id]/page.tsx` (new — per-school B2B console)
- `app/admin/subscriptions/[id]/invoice/page.tsx` (new — Bearer-token PDF bridge)

**Modified:**
- `app/admin/dashboard/page.tsx` + `app/api/admin/dashboard/route.ts` — Upcoming expirations widget
- `app/admin/onboard-school/page.tsx` + `app/api/admin/onboard-school/route.ts` — Manage link, Expires column
- `app/admin/plans/page.tsx` — pricing labels updated to ₹29/₹49/₹69
- `app/api/auth/me/route.ts` — first-sign-in activation flip
- `app/api/school/coach/route.ts` + `app/api/teacher/coach/route.ts` — coach quota gate
- `app/api/school/digest/route.ts` — feature gate (Pilot doesn't get weekly_digest)
- `app/help/page.tsx` — renewal workflow topic
- `app/school/page.tsx` + `app/student/page.tsx` — pass isInGrace/graceRemainingDays to RenewBanner
- `app/teacher/page.tsx` — minor cleanup (visibility model from previous session)
- `components/CurrentPlanBadge.tsx` — renews-date tail
- `components/RenewBanner.tsx` — in-grace state
- `components/Sidebar.tsx` — gate weekly_digest sidebar entries
- `lib/coachQuota.ts` (new)
- `lib/featureAccess.ts` — grace window honored, isInGrace/graceRemainingDays exposed

### Pre-deploy checklist

1. Run migrations 59 → 65 IN ORDER in Supabase SQL editor. Each is
   idempotent (`if not exists` guards) but order matters because 65
   references columns added in earlier migrations.
2. Set vendor + bank env vars before any school tries to download an
   invoice — endpoint 500s with a clear error otherwise:
   - `INVOICE_VENDOR_NAME`
   - `INVOICE_VENDOR_GSTIN`
   - `INVOICE_VENDOR_ADDRESS`
   - `INVOICE_VENDOR_STATE`
   - `INVOICE_BANK_NAME`
   - `INVOICE_BANK_ACCOUNT`
   - `INVOICE_BANK_IFSC`
3. Sanity-check after migration: `select count(*) from subscriptions
   where grace_period_days is null` should return 0 (the migration
   backfills 14 days for every existing row).
4. The first super_teacher sign-in after deploy will trigger the
   activation-pending flip for any school whose subscription was
   created with the flag set. Existing rows have it false by default,
   so no surprise behaviour for already-active schools.
5. The "Manage" link in `/admin/onboard-school` and the "Upcoming
   expirations" widget on `/admin/dashboard` are gated to schools that
   have a subscription row — schools onboarded but never plan-bound
   show as "— No plan —".

### Edge cases handled

- **Mid-cycle plan upgrade** (Pilot → Plus four months in): Case C
  preserves `started_at` + `expires_at`. School keeps the year they paid for.
- **Onboarding lag** (school onboarded Aug 1, admin first signs in Aug 5):
  set `activation_pending=true` at onboard; `/api/auth/me` flips on first sign-in.
- **Future-dated activation** (Indian academic year, contract signed in
  March, term starts 1 June): operator types 2026-06-01 in the activation
  date field; `expires_at` becomes 1 June 2027.
- **Early renewal** (paid 7 days before expiry): mark-paid's smart anchor
  preserves the unused remainder. `extends_to` preview shows it before
  click.
- **Late renewal** (paid 14 days after expiry, but inside grace): in-grace
  banner shows; mark-paid extends from received_at; school had continuous
  access throughout.
- **GST-compliant invoice numbering across years**: Start renewal cycle
  archives the previous BLM/2026/0007 to subscription_invoice_archive
  and clears invoice_number, so next download mints BLM/2027/0001.
- **Override price + contracted seats**: invoice line item shows
  "School Plus — annual subscription, 700 contracted seats (negotiated
  rate)" and `₹35,000` flat instead of formula × actual.
- **Re-record payment** (correcting a wrong receipt date): mark-paid
  preserves `extend_from` semantics; "Re-record payment" label appears
  when `payment_received_at` is already set.

### Decisions made and explicitly NOT shipped

- **Grace period auto-tuning by tier** — for now every school gets 14
  days; could be 7 for Pilot, 30 for Plus. Defer; one knob per school
  is simpler today.
- **Multi-year upfront purchases with prorated discount** — requires
  another schema field for "term length × N" or a multiplier on
  expires_at; defer until a school actually asks.
- **Pause / suspend (summer break)** — would need a "pause from / pause
  until" pair and resume math. <1% of B2B education deals; defer.
- **Mid-cycle refunds** — explicitly out of scope. If a school cancels
  mid-year we handle it via a manual credit note off-platform.
- **Auto-billing-history table that mirrors mark-paid receipts** —
  the archive captures cycles, not every payment event. Today a single
  cycle has at most one payment so this is fine; add later if a cycle
  ever has multiple payments (e.g. partial advance + balance).
- **Customer-facing "renew now" Razorpay button for school plans** —
  RenewBanner exists and works for personal subscriptions, but for
  schools we deliberately route through the ZCORIQ team via mailto
  because B2B contracts include negotiation, GST invoice, NEFT —
  none of which fit a self-serve checkout button.

---

## 🆕 Earlier session — 2026-05-08 / 2026-05-09 (Co-teacher visibility model, scope clarity, route progress, help system)

The headline change: replaced the over-permissive "any teacher of an assigned
class sees the test" rule that migrations 53–57 had been chasing with a
semantically correct one — **a teacher sees a test if they own it, are
**primary** on a class it's assigned to, or **personally assigned** it
(even as a co-teacher)**. Subject co-teachers no longer get flooded with
the primary's assessments. Migration 58 implements this in RLS via a
`SECURITY DEFINER` helper `public.is_quiz_visible_to_me(qid)`; five page
loaders mirror the same rule client-side so totals match what RLS allows.

### What shipped

**Visibility & RLS (the cascade fix):**

- `supabase/migrations/58_visibility_primary_or_assigner.sql` — replaces
  `is_quiz_in_my_class` (migrations 57/56/55, kept in repo for history)
  with `is_quiz_visible_to_me(qid)`. The helper is `SECURITY DEFINER` so
  it sidesteps the `quizzes ↔ quiz_assignments` RLS recursion that bit
  migration 56. Four policies repointed: `quizzes class co-teacher read`,
  `attempts class co-teacher read`, `ans class co-teacher read`,
  `assign class co-teacher read`. Existing `*_super read` policies on
  the same tables (migration 06) are untouched, so admin/deputy
  visibility is unaffected.
- Application loaders updated to the union (owned ∪ primary-class ∪
  I-assigned): `app/teacher/page.tsx` (Home), `app/teacher/reports/page.tsx`,
  `app/teacher/analytics/page.tsx`, `app/teacher/classes/[id]/analytics/page.tsx`,
  `app/api/alerts/route.ts`. Server-side aggregations (`/api/school/coach`,
  `/api/school/digest`, all `lib/schoolContext.ts` paths) keep using
  `supabaseAdmin()` and are unaffected.

**"Assigned by" everywhere:**

- Home recent tests show "Assigned by Ms. Priya Sharma" / "Assigned by you" sub-line.
- Reports test dropdown: `Test · Subject · Class · by Ms. Priya Sharma`. Excel quiz-overview workbook gets a new "Assigned by" column.
- Test analytics dropdown: same suffix pattern.
- Class analytics "Tests in this class" table: new "Assigned by" column. On a class where the teacher is co, the table only shows tests *they* assigned.

**Scope-clarity cards (no more guessing what's in a number):**

- `/teacher` Home — bullet card explaining what each of the four stat tiles counts.
- `/teacher/reports` — bullet card explaining hero-stat scope + an explicit "Excluded:" line for tests other teachers assigned to co-teacher classes.
- `/teacher/analytics` — bullet card explaining which tests appear in the picker.
- `/school` Home — parallel card for the Admin Head: school-wide totals, what's NOT counted (live class engagement), Head + Deputies share the view.
- `/school/reports` — same scope line under the Bloom Pulse subtitle.
- `/school/coach`, `/school/digest` — subtitles expanded to spell out the school-wide audience.

**Help page:**

- `/help` previously linked from the sidebar but the page existed; expanded the teacher section with a new **"Visibility & what's in your numbers"** group covering the primary/co rule, the "Assigned by" labels, and how the Admin Head's view differs.
- Added two new entries to the **"Run your class"** group answering the recurring "why does this button exist?" complaints: *Why is there an Assign button on a test that's already assigned?* and *What's the point of Host live for a test I've already assigned?* (both teach the multi-assignment and engagement-vs-grading patterns).
- Mirror entry on the school admin help.

**UX polish — flicker, double-click, dead-end clicks:**

- `components/RouteProgress.tsx` — slim brand-coloured progress bar pinned to the top of the viewport, listens to `usePathname` changes, animates the moment a Link is intercepted by the router and fades out when the new page renders. Kills the dev-mode JIT-compile "did my click register?" perception that drove the double-click reflex. Mounted in both `/teacher/layout.tsx` and `/school/layout.tsx`.
- `/teacher` Home — added `profileLoaded` gate so the "Join your school" card no longer flashes for a frame on every navigation while `/api/auth/me` resolves. Same `useState`-then-spinner pattern Defect 7 used.
- `/teacher/reports` — added `quizzesLoaded` gate. No more "No quizzes yet" flash.
- `/teacher` Home — Host live button is now hidden on tests the teacher doesn't own. Live picker filters by `owner_id` and the live API requires owner; the button used to be a dead-end click for non-owners.
- `/teacher/quizzes` — Assign button label flips to **"Assign more"** on already-assigned tests, with a tooltip listing the three legitimate use cases (push to a second class, add specific students, re-assign with a new due date). New behaviour matches the help page entry.
- Empty-state CTA cleanup across `/teacher/review`, `/teacher/papers`, `/teacher/quizzes` — header CTA stays, the duplicated empty-state CTA was removed and the body text now references the header button. One CTA per page, never two.

**Test-data scripts (so future regressions can be caught quickly):**

- `scripts/setup-mr-raj-mixed-roles.js` and `scripts/swap-raj-primary-to-biology.js` — land the "Mr. Raj primary on Biology B, co on Math A" state that exercises BOTH branches of the visibility rule (primary sees Priya's tests; as co, only sees own assignments).
- `scripts/debug-mr-raj-reports.js` — extended to print `assigned_by` per row (`by-me` / `by-other`) so it's obvious why each row is or isn't visible to Raj's session.

### Decisions made and explicitly NOT shipped

- **Did not loosen Host-live RLS.** A primary teacher could legitimately want to host a colleague's test live in their classroom. Considered loosening but kept the existing "owner only" rule for now — option (B) — and instead just hid the button when not the owner — option (A). Cleaner UX with no security loosening; can revisit if teachers ask.
- **Did not collapse Generate Questions + Review Pending into a single sidebar entry.** The two are different verbs (create vs approve) and each is visited at a different cadence. Kept them separate but removed the duplicated "Generate questions" CTA from the Review empty state — the sidebar already exposes it.
- **Did not migrate the historic 53–57 migrations out of the repo.** They're idempotent on prior runs and migration 58 cleanly drops the helper they introduced. Keeping them documents the cascade we walked through.

### Files touched

```
supabase/migrations/53_co_teacher_attempts_read.sql            (new, superseded by 58)
supabase/migrations/54_co_teacher_assignments_read.sql         (new, superseded by 58)
supabase/migrations/55_co_teacher_quizzes_read.sql             (new, superseded by 58)
supabase/migrations/56_co_teacher_rls_consolidated.sql         (new, superseded by 58)
supabase/migrations/57_fix_co_teacher_rls_recursion.sql        (new, superseded by 58)
supabase/migrations/58_visibility_primary_or_assigner.sql      (new — this is the live rule)

app/teacher/page.tsx                                            (visibility loader, scope card, profileLoaded, Host-live gating, Assigned-by sub-line)
app/teacher/reports/page.tsx                                    (visibility loader, scope card, quizzesLoaded, Assigned-by dropdown + Excel column)
app/teacher/analytics/page.tsx                                  (visibility loader, scope card, Assigned-by dropdown)
app/teacher/classes/[id]/analytics/page.tsx                     (NEW — class-wide cross-test dashboard with primary/co split + Assigned-by column)
app/teacher/quizzes/page.tsx                                    (Assign more label + tooltip, empty-state cleanup)
app/teacher/papers/page.tsx                                     (empty-state cleanup)
app/teacher/review/page.tsx                                     (empty-state cleanup)
app/teacher/layout.tsx                                          (RouteProgress mount)
app/help/page.tsx                                               (Visibility section + Run-your-class entries)
app/school/page.tsx                                             (scope card)
app/school/reports/page.tsx                                     (scope line)
app/school/coach/page.tsx, app/school/digest/page.tsx           (subtitle clarity)
app/school/layout.tsx                                           (RouteProgress mount)
app/api/alerts/route.ts                                         (visibility-aligned quiz scope)
components/RouteProgress.tsx                                    (NEW)
components/Sidebar.tsx                                          (earlier in window — Reports first, Analytics → Test analytics)

scripts/setup-mr-raj-mixed-roles.js                             (NEW)
scripts/swap-raj-primary-to-biology.js                          (NEW)
scripts/debug-mr-raj-reports.js                                 (assigner tagging)
```

### Pre-deploy checklist

1. Run `supabase/migrations/58_visibility_primary_or_assigner.sql` in the
   SQL Editor. The two `select`s at the bottom must return 4 policy rows
   and the `is_quiz_visible_to_me` function (and confirm `is_quiz_in_my_class`
   is gone).
2. Run `node scripts/swap-raj-primary-to-biology.js` then
   `node scripts/debug-mr-raj-reports.js` against your test DB. Expect
   `[c]=5, [d]=4, [e]=46`.
3. Sign in as Mr. Raj, walk Home → Reports (filter Math A vs Biology B) →
   Test analytics → Class analytics (both classes). Verify "Assigned by"
   labels and that Math A as co only shows the two Raj-assigned tests.
4. Sign in as a Deputy Admin Head and confirm `/school` and
   `/school/reports` still show school-wide totals (super_read policies
   are intact).

---

## 🆕 Earlier session — 2026-05-07 (Big polish day: test composer & detail upgrades, learner profiles, assign UX overhaul, nav rename)

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
all gone from the composer. Reasoning: in ZCORIQ's current usage profile
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
  intentionally hides the Admin Head role (provisioned by ZCORIQ via
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
in the day was over-engineered for ZCORIQ's actual business model —
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

After the morning's plan-admin push, this session was about everything *around* the product — how it looks, how new admins get in, and how interactions feel — taking ZCORIQ from "competent indie app" to something that visually competes with Linear, Notion, and Stripe. Three big tracks plus a few critical fixes.

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
  share message (`"You've been added as a ZCORIQ admin. Click this
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
DIGEST_FROM=ZCORIQ <youraccount@gmail.com>
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

Plus `profiles.platform_admin` boolean — ZCORIQ staff (separate from `super_teacher`). Bootstrap first platform admin via SQL; afterwards self-serve from `/admin/team`.

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

ZCORIQ's RLS layer is correctly enabled on every table inspected, but several SELECT policies are too permissive. The most serious are in `supabase/schema.sql`: `profiles`, `quizzes`, `quiz_questions`, and `question_bank` all have `for select to authenticated using (true)` policies that were never narrowed by later migrations. **Fix before going to production with multi-school traffic.**

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
  admin/                    ZCORIQ staff (platform_admin only)
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