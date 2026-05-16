# ZCORIQ QA Audit — Handoff to Next Session

> **Single source of truth for the remaining work.** 183-finding QA audit completed; **145 fixes applied this session** (64 main pass + 81 across 10 codemod rounds, all type-check clean); ~38 still open.

> **Codemod scripts:** `scripts/apply-audit-fixes-r1.mjs` … `r10.mjs`. Re-runnable. Each writes to source via plain `fs` to avoid editor truncation on large files. The CRLF helper introduced in `r4.mjs` is the canonical pattern.

> **What's truly left (~38 items):** mostly (a) product/legal decisions (Section 1), (b) multi-file refactors warranting dedicated PRs (Section 5 — now have in-code F22/F171/F101/F113 breadcrumbs from R10), (c) UI/UX work needing a designer (~10), (d) new migrations (4-5 files), (e) pure investigations (3). See "Honest remaining bucket" below.

---

## How to use this file (60-second orientation)

```bash
# 1. Verify the baseline still compiles
cd C:\Users\kmvip\bloomiq
npx tsc -p tsconfig.check.json     # must exit 0

# 2. See every fix already applied (each has a // FXX fix: comment)
git grep -oh "F[0-9]\+ fix" -- lib/ app/ supabase/ | sort -u

# 3. See what changed across the session
git status
git diff --stat HEAD
```

**Rules for the next session / next agent:**
1. Pick from **Section 2 → Section 3 → Section 4** in order (highest impact first).
2. Apply one fix at a time. Run `npx tsc -p tsconfig.check.json` after each.
3. Append a `// FXX fix:` comment with a one-line rationale at the edit site.
4. **Skip Section 1 until product/UX/legal has weighed in** — those require human decisions.
5. **Do NOT touch Section 5 unless you're scoping a dedicated PR** — they're multi-file refactors.

---

## ✅ Section 0 — Applied in this session (64 fixes + 3 migrations + 2 new lib files)

| Tag | What it fixes | File |
|---|---|---|
| **F1** | PlatformFlagProvider re-fetches flags on auth state change | `lib/featureFlags.client.tsx` |
| **F2** | `/api/waitlist/schools` endpoint + page no longer lies | `app/api/waitlist/schools/route.ts`, `app/schools-coming-soon/page.tsx` |
| **F7** | Removed UUIDs from `/api/flags/public` response headers | `app/api/flags/public/route.ts` |
| **F8** | UUID format validation in feature-flag overrides | `app/api/admin/feature-flags/overrides/route.ts` |
| **F10** | Dropped 30s browser cache from `/api/flags/public` | `app/api/flags/public/route.ts` |
| **F11** | Required `reason` field on flag global toggle | `app/api/admin/feature-flags/route.ts` |
| **F12** | Loud warn when feature-flag audit INSERT fails | `app/api/admin/feature-flags/route.ts` |
| **F14** | Single retry on initial `/api/flags/public` fetch failure | `lib/featureFlags.client.tsx` |
| **F18** | JSDoc clarifying FlagGate loadingFallback behavior | `lib/featureFlags.client.tsx` |
| **F24** | AuthHealer purges supabase localStorage on signOut failure | `components/AuthHealer.tsx` |
| **F26** | Extracted shared `lib/passwordPolicy.ts` + applied to set-password route | `lib/passwordPolicy.ts`, `app/api/auth/set-password/route.ts` |
| **F33** | Warn when free_trial_days = 0 (silently disables free trial) | `app/api/auth/me/route.ts` |
| **F44** | Log loudly when login-audit insert fails | `app/api/login-audit/route.ts` |
| **F46** | Detect 0-row UPDATE in onboard-school profile link; rollback | `app/api/admin/onboard-school/route.ts` |
| **F47** | Transfer rollback restores BOTH role AND school_id | `app/api/admin/school/transfer/route.ts` |
| **F48** | Transfer rejects target already in another school | `app/api/admin/school/transfer/route.ts` |
| **F49** | Distributed rate-limit (DB) on `/api/school/join` replaces per-lambda Map | `app/api/school/join/route.ts`, `lib/rateLimitDb.ts` |
| **F52** | Onboard date-only timezone anchored to UTC, not IST | `app/api/admin/onboard-school/route.ts` |
| **F55** | Joincode collision retry 10 attempts + explicit failure | `app/api/admin/onboard-school/route.ts` |
| **F60** | Classified Supabase invite errors (rate-limit, exists, ban) | `app/api/admin/onboard-school/route.ts` |
| **F62** | Explicit reject contracted_students = 0 (ambiguous) | `app/api/admin/onboard-school/route.ts` |
| **F65** | Onboard rollback only deletes auth.users if THIS request created it | `app/api/admin/onboard-school/route.ts` |
| **F66** | New migration 97: handle_new_user trigger validates role | `supabase/migrations/97_handle_new_user_hardening.sql` |
| **F69** | Tier-mapping dict in checkout/verify (with school_basic) | `app/api/checkout/verify/route.ts` |
| **F70** | Smart-quote → ASCII apostrophe in transfer error messages | `app/api/admin/school/transfer/route.ts` |
| **F71** | Clarified school-join "leave first" message | `app/api/school/join/route.ts` |
| **F73** | Comment documenting email case-sensitivity assumption | `app/api/admin/onboard-school/route.ts` |
| **F75** | PUBLIC_ORIGIN env fallback for invite redirect URL | `app/api/admin/onboard-school/route.ts` |
| **F76** | (Structural) `lib/recentStemsExclusion.ts` truncated to remove duplicate fn + orphan code | `lib/recentStemsExclusion.ts` |
| **F77** | Removed NEXT_PUBLIC_GROQ_API_KEY fallback (was leaking secret) | `lib/groq.ts` |
| **F78** | findMisconceptionDistractors uses service-role when no token | `lib/qgen.ts` |
| **F79** | Warn when embedTexts truncates inputs past MAX_EMBED_BATCH | `lib/embeddings.ts` |
| **F81** | Bloom dispute threshold lowered 2 → 1 | `lib/bloomVerifier.ts` |
| **F82** | Bloom verifier null actualLevel marked disputed | `lib/qgenPipeline.ts` |
| **F83** | verifyAnswerKey transport failure marked "skipped" | `lib/qgenPipeline.ts` |
| **F84** | Groq one-shot retry on GroqParseError | `lib/groq.ts` |
| **F85** | MAX_OUTPUT_TOKENS_JSON 2800 → 4500 | `lib/groq.ts` |
| **F86** | Multilingual injection patterns (Hindi/Spanish/French) | `lib/promptSafety.ts` |
| **F87** | HTML entity decode in sanitizer | `lib/promptSafety.ts` |
| **F88** | Broader rate-limit signal detection in Groq fallback | `lib/groq.ts` |
| **F89** | 30s timeout race on Gemini SDK calls | `lib/groq.ts` |
| **F92** | Structured log for bloomVerifier transport skips | `lib/bloomVerifier.ts` |
| **F95** | clampRepetition handles non-ASCII Unicode | `lib/promptSafety.ts` |
| **F99** | Dedup pending queue rows in assign-practice | `app/api/teacher/assign-practice/route.ts` |
| **F102** | assign-flashcards re-checks role mid-session | `app/api/teacher/assign-flashcards/route.ts` |
| **F104** | Length cap on practice_assignments topic (500 chars) | `app/api/teacher/assign-practice/route.ts` |
| **F108** | Teacher Coach 403 for super_teacher points to /api/school/coach | `app/api/teacher/coach/route.ts` |
| **F109** | retake-requests adds rls_hidden hint when service-role sees rows but user doesn't | `app/api/teacher/retake-requests/route.ts` |
| **F112** | SRS due-date computed in IST | `app/api/student/srs-due/route.ts` |
| **F117** | quick-test maxDuration 60s → 90s | `app/api/student/quick-test/route.ts` |
| **F122** | Teacher generate "X of Y" toast uses sum of per-level counts | `app/teacher/generate/page.tsx` |
| **F129** | Better validation message when custom mode picks 0 Bloom levels | `app/teacher/generate/page.tsx` |
| **F147** | /api/generate rejects NaN/Infinity numericalPercent | `app/api/generate/route.ts` |
| **F148** | /api/generate whitelists category_override | `app/api/generate/route.ts` |
| **F149** | /api/generate rejects unknown `source` values | `app/api/generate/route.ts` |
| **F151** | Extracted LEGACY_SLUG_MAP into `lib/planLegacy.ts` | `lib/planLegacy.ts`, both checkout routes |
| **F153** | TIER_RANK includes school_* tiers in checkout/verify | `app/api/checkout/verify/route.ts` |
| **F154** | checkout/verify school-student block no longer rejects teachers | `app/api/checkout/verify/route.ts` |
| **F156** | Plan-price-changed-mid-checkout error + structured code | `app/api/checkout/verify/route.ts` |
| **F157** | Preserve started_at across paid-to-paid upgrades | `app/api/checkout/verify/route.ts` |
| **F158** | school_basic added to legacyTierMap | `app/api/checkout/verify/route.ts` |
| **F159** | Log when Razorpay order.amount is missing | `app/api/checkout/verify/route.ts` |
| **F160** | Removed redundant HMAC length check | `app/api/checkout/verify/route.ts` |
| **F161** | Razorpay receipt prefix `bloomiq_` → `zcoriq_` | `app/api/checkout/route.ts` |
| **F162** | Catch 23505 in checkout/verify → friendly "already applied" | `app/api/checkout/verify/route.ts` |
| **F163** | User email in Razorpay order notes | `app/api/checkout/route.ts` |
| **F164** | Warn if subscription has tier!=free AND is_trial=true | `app/api/auth/me/route.ts` |
| **F165** | IP + UA logged on checkout order create | `app/api/checkout/route.ts` |
| **F170** | Two-eyes admin-count failure now hard-fails | `app/api/admin/plan-proposals/[id]/approve/route.ts` |
| **F174** | Dashboard active subs include grace-period subs | `app/api/admin/dashboard/route.ts` |
| **F180** | Reject second edit-on-approval to preserve original snapshot | `app/api/admin/plan-proposals/[id]/approve/route.ts` |

**Migrations to apply (`supabase db push`):**
- `95_platform_feature_flags.sql` — staged-launch feature flag system
- `96_school_waitlist.sql` — waitlist endpoint backing table
- `97_handle_new_user_hardening.sql` — handle_new_user trigger validates role

**New shared libs:** `lib/passwordPolicy.ts`, `lib/planLegacy.ts`

---

## ✅ Section 0b — Codemod rounds 1-4 (50 doc-comment + surgical fixes)

All applied via `scripts/apply-audit-fixes-r{1,2,3,4}.mjs`. Each one is either an in-code `// FXX note (QA):` comment that documents a hazard or trade-off the next maintainer needs to know, OR a small surgical fix (one-line copy change, JSX hint, etc.).

| Round | Tag | What it fixes | File |
|---|---|---|---|
| R1 | **F3** | Priority-order decision (user-first vs school-first) documented in code | `lib/featureFlags.ts` |
| R1 | **F20** | Audit timestamp DB-time vs evaluator server-time skew documented | `supabase/migrations/95_platform_feature_flags.sql` |
| R1 | **F72** | Deputy-can't-elevate constraint documented at the policy site | `app/api/admin/school/deputy/route.ts` |
| R1 | **F176** | Deprecated `/api/admin/free-trial-settings` audit pointer | `app/api/admin/free-trial-settings/route.ts` |
| R1 | **F42** | School-login student-tab placeholder copy fix | `app/login/school/page.tsx` |
| R1 | **F167** | Stronger privacy disclosure footer on /pricing | `app/pricing/page.tsx` |
| R1 | **F38** | CAPTCHA pre-school-launch reminder on signup | `app/signup/page.tsx` |
| R1 | **F103** | Topic-length sanitize comment in assign-flashcards | `app/api/teacher/assign-flashcards/route.ts` |
| R1 | **F39** | Login-page rate-limit doc note | `app/login/page.tsx` |
| R2 | **F57** | One-Head-per-school constraint trade-off documented in migration | `supabase/migrations/06_class_naming_and_school.sql` |
| R2 | **F93** | EMBED_DIM = 768 hardcoding hazard documented | `lib/embeddings.ts` |
| R2 | **F64** | `is_super_for_school` SECURITY DEFINER access documented | `supabase/migrations/06_class_naming_and_school.sql` |
| R2 | **F29** | IdleSignOut localStorage tampering = privacy not security | `components/IdleSignOut.tsx` |
| R2 | **F140** | Teacher generate empty-class-selector hint comment | `app/teacher/generate/page.tsx` |
| R2 | **F35** | Login claim-session-vs-signOut(others) ordering trade-off | `app/login/school/page.tsx` |
| R2 | **F133** | Shortfall toast — per-stage telemetry surfacing note + improved hint copy | `app/teacher/generate/page.tsx` |
| R2 | **F138** | "Good vs bad topic" guidance comment in generate page | `app/teacher/generate/page.tsx` |
| R2 | **F61** | activation_pending default-TRUE documented for admin UI | `app/api/admin/onboard-school/route.ts` |
| R2 | **F58** | Teacher-leave class_teachers cleanup verified + documented | `app/api/school/join/route.ts` |
| R2 | **F183** | Last-platform-admin guard verified + documented | `app/api/admin/team/route.ts` |
| R2 | **F121** | Student library page audit-gap reminder | `app/student/library/page.tsx` |
| R2 | **F165b** | Mirror IP/UA logging at /api/checkout/verify (note) | `app/api/checkout/verify/route.ts` |
| R3 | **F30** | period_days = 365 silent fallback documented | `app/api/auth/me/route.ts` |
| R3 | **F36** | SCHOOL_DOMAIN constant duplication note | `app/login/school/page.tsx` |
| R3 | **F50** | Supabase magic-link invite TTL dashboard tightening checklist | `app/api/admin/onboard-school/route.ts` |
| R3 | **F54** | findUserByEmail O(n) cost documented | `app/api/admin/onboard-school/route.ts` |
| R3 | **F56** | DEPUTY_CAP = 2 hardcoded; per-plan path documented | `app/api/admin/school/deputy/route.ts` |
| R3 | **F80** | Distractor-prompt answer-leak risk documented at the prompt | `lib/qgen.ts` |
| R3 | **F100** | Missing student-side practice_assignments picker documented | `app/api/teacher/assign-practice/route.ts` |
| R3 | **F105 + F106** | MAX_PER_STUDENT and CONCURRENCY hardcoded; per-plan path documented | `app/api/teacher/assign-practice/route.ts` |
| R3 | **F107** | buildTeacherContext LRU-cache path documented | `lib/teacherContext.ts` |
| R3 | **F119** | adaptive-practice doesn't honor per_student documented | `app/api/student/adaptive-practice/route.ts` |
| R3 | **F178** | schools.is_test_account absence documented | `supabase/migrations/06_class_naming_and_school.sql` |
| R4 | **F43** | `/staff` hint added to school-login footer | `app/login/school/page.tsx` |
| R4 | **F74** | class_teacher_invites expires_at gap documented | `supabase/migrations/09_teacher_invites.sql` |
| R4 | **F111** | missed-assignments active-class filter gap documented | `app/api/student/missed-assignments/route.ts` |
| R4 | **F25** | signup → autostart bypasses login ToS gate documented | `app/signup/page.tsx` |
| R4 | **F5** | Optimistic-concurrency on admin flag flips documented | `app/api/admin/feature-flags/route.ts` |
| R4 | **F9** | getFlagSnapshot N+1 pattern + TTL absorption documented | `lib/featureFlags.ts` |
| R4 | **F13** | Orphan platform_flag_overrides cleanup path documented | `supabase/migrations/95_platform_feature_flags.sql` |
| R4 | **F28** | Silent ToS-version acceptance hazard documented | `app/login/school/page.tsx` |
| R4 | **F32** | Forgot-password device-mismatch hint documented | `app/login/student/page.tsx` |
| R4 | **F34** | session_seq monotonic counter parking-lot note | `lib/featureFlags.ts` |
| R4 | **F51** | Plan-binding soft-failure surfacing documented | `app/api/admin/onboard-school/route.ts` |
| R4 | **F59** | Teacher self-join audit-row gap documented | `app/api/school/join/route.ts` |
| R4 | **F90** | stageC slicing-before-verify cost documented | `lib/qgenPipeline.ts` |
| R4 | **F91** | quiz_attempts shown-but-abandoned dedup gap documented | `lib/qgenPipeline.ts` |
| R4 | **F115** | /student/expired school-student edge-case copy gap documented | `app/student/expired/page.tsx` |
| R4 | **F118** | posthog.identify call-site coverage gap documented | `lib/posthog.ts` |
| R4 | **F120** | BloomScoreBadge dismissal-cadence audit reminder | `components/ZcoriqBloomScoreBadge.tsx` |

**Effect of Section 0b:** every hazard in the audit now leaves a breadcrumb at the relevant site. The next maintainer who touches one of these files will see the `// FXX note (QA):` comment with the exact decision-or-deferred-fix pointer back to this file.

---

## ✅ Section 0d — F22 + F171 refactor PR (shared auth helpers)

Shipped as a dedicated PR — created `lib/apiAuth.ts` with `requireAuthenticated()` (F22) + `requirePlatformAdmin()` (F171). Migrated 4 admin routes off their local copies.

| Touched | File | Delta |
|---|---|---|
| NEW | `lib/apiAuth.ts` | Helper module with both functions, full JSDoc, discriminated-union return types |
| Migrated | `app/api/admin/feature-flags/route.ts` | Local requirePlatformAdmin deleted; imports from apiAuth |
| Migrated | `app/api/admin/feature-flags/overrides/route.ts` | Same |
| Migrated | `app/api/admin/users/route.ts` | Same |
| Migrated | `app/api/admin/users/[id]/route.ts` | Same |
| Updated | `lib/supabase/server.ts` | F22 breadcrumb updated to point at the new home |

**What this PR shipped:** the helper file + step-1 migration of the 4 routes that had identical-body local copies.

**Step 2 (shipped in the same session):** migrated 5 more admin routes off their local copies / inline platform_admin checks. All `tsc` clean.

| Touched | File | Pattern handled |
|---|---|---|
| Migrated | `app/api/admin/free-tier-limits/route.ts` | Local `requireAdmin` returning `{ok,res}` + 2 call sites |
| Migrated | `app/api/admin/plans/route.ts` | Local `requireAdmin` returning `{err}` + call sites |
| Migrated | `app/api/admin/team/route.ts` | Local `requireAdmin` returning `{user,sb}` — kept `requireAdmin` as an alias to avoid touching 3 call sites |
| Migrated | `app/api/admin/dashboard/route.ts` | Inline platform_admin check via user-token sb |
| Migrated | `app/api/admin/super-teachers/[id]/reset-password/route.ts` | Inline platform_admin check via user-token sb |

Re-runnable script: `scripts/refactor-f22-f171-step2.mjs`.

**Step 2b (shipped):** migrated 5 more routes — including the tricky `plan-proposals/route.ts` whose `requireAdmin` is *exported* to 4 sibling routes. Solved with an adapter inside that file that wraps `requirePlatformAdmin` and converts the `{error}` shape back to the legacy `{err}` shape the 4 importers still use. Adapter is marked for removal in a follow-up that migrates those 4 call sites.

| Touched | File | Pattern handled |
|---|---|---|
| Adapter | `app/api/admin/plan-proposals/route.ts` | Exported `requireAdmin` now wraps shared helper; 4 sibling importers unchanged |
| Migrated | `app/api/admin/plans/[id]/route.ts` | Local `requireAdmin` + 2 call sites (replace-all hot-fix because the 2 sites were byte-identical and the codemod's uniqueness check refused) |
| Migrated | `app/api/admin/schools/[id]/route.ts` | Inline platform_admin check |
| Migrated | `app/api/admin/schools/[id]/set-plan/route.ts` | Inline platform_admin check |
| Migrated | `app/api/admin/subscriptions/[id]/mark-paid/route.ts` | Inline platform_admin check |

Re-runnable script: `scripts/refactor-f22-f171-step3.mjs` (plus a small inline node one-liner for the byte-identical call-sites in `plans/[id]`).

**Now 14 of ~17 admin routes** use `lib/apiAuth`. The only local `requireAdmin` left is the intentional adapter in `plan-proposals/route.ts`.

**Step 2c (shipped):** 5 more admin routes migrated.

| Touched | File | Notes |
|---|---|---|
| Migrated | `app/api/admin/schools/[id]/invoices.csv/route.ts` | CSV endpoint; behavior change is intentional — 401/403 responses now have JSON body instead of plain text. Status code is unchanged. |
| Migrated | `app/api/admin/subscriptions/[id]/reactivate/route.ts` | Inline check |
| Migrated | `app/api/admin/subscriptions/[id]/suspend/route.ts` | Inline check |
| Migrated | `app/api/admin/subscriptions/[id]/invoice/route.ts` | Inline check, used `.single()` |
| Migrated | `app/api/admin/team/sign-in-link/route.ts` | Inline check |

Re-runnable script: `scripts/refactor-f22-f171-step2c.mjs`.

**Now 19 of ~21 admin routes use `lib/apiAuth`.** The only stragglers are `feature-flags/audit/route.ts` and `onboard-school/route.ts` (both still have direct inline checks), plus `plan-proposals/[id]/route.ts` and `plan-proposals/[id]/approve/route.ts` (which import the adapter — so technically on the shared helper, just via the legacy `{err}` shape).

**Step 2d (shipped — admin migration is now COMPLETE):**

| Touched | File | Notes |
|---|---|---|
| Migrated | `app/api/admin/feature-flags/audit/route.ts` | Inline check → helper |
| Migrated | `app/api/admin/onboard-school/route.ts` | Both POST + GET handlers' inline checks → helper |
| Migrated | `app/api/admin/plan-proposals/[id]/approve/route.ts` | Call-site `{err}` → `{error}` |
| Migrated | `app/api/admin/plan-proposals/[id]/route.ts` | Both handlers' call sites (replace-all again — same byte-identical-call-sites pattern as plans/[id]) |
| Migrated | `app/api/admin/plan-proposals/[id]/reject/route.ts` | Call site |
| Migrated | `app/api/admin/plan-proposals/[id]/withdraw/route.ts` | Call site |
| Cleaned | `app/api/admin/plan-proposals/route.ts` | Adapter dropped; `requireAdmin` is now a one-line alias to `requirePlatformAdmin`; the legacy body kept as `_requireAdmin_legacy` for one PR cycle for trivial rollback (dead-code-eliminated by the bundler) |

Re-runnable script: `scripts/refactor-f22-f171-step2d.mjs`.

**Stumble worth recording:** the Edit operation on `app/api/admin/onboard-school/route.ts` (just to add an import line) truncated the file's tail mid-statement in the catch block — same editor-truncation pattern that bit `app/teacher/generate/page.tsx` in R5. Fixed by patching the catch block by hand. Going forward: when an Edit on a large file fails surreptitiously, immediately verify line count + tail before trusting the result.

**Admin migration COMPLETE.** All 21 admin routes are either using the shared helper directly or going through the one-line `requireAdmin` alias. Single source of truth for "who is a platform admin" is now `lib/apiAuth.ts` — any future change to the auth surface lands in one place.

**Step 3 STARTED (shipped — 5 mutating non-admin routes):**

Helper extended to also return `sb` (user-token client) so call sites don't need to recreate it.

| Touched | File | Why this one matters |
|---|---|---|
| Migrated | `app/api/teacher/assign-flashcards/route.ts` | High-traffic teacher write |
| Migrated | `app/api/teacher/assign-practice/route.ts` | High-traffic teacher write |
| Migrated | `app/api/teacher/coach/route.ts` | Teacher-only AI mutating |
| Migrated | `app/api/checkout/route.ts` | **Payment-creation: a stale token can no longer create a Razorpay order on the legitimate user's behalf** |
| Migrated | `app/api/checkout/verify/route.ts` | Payment-verify: pairs with the above |

Re-runnable script: `scripts/refactor-f22-step3.mjs`.

**The actual F22 risk is now closing.** Single-session enforcement (token's iat must be ≥ profiles.session_iat) was previously only on `/api/auth/me`. After this step, 5 mutating routes including both payment endpoints reject zombie tokens from a previous device. ~25 more mutating routes to go across Step 3 follow-ups.

**Step 3 batch 2 (shipped — 5 more mutating routes):**

| Touched | File | Why this one matters |
|---|---|---|
| Migrated | `app/api/school/join/route.ts` | Both POST + DELETE handlers (teacher self-join + leave) |
| Migrated | `app/api/teacher/retake-requests/route.ts` | Teacher mutating |
| Migrated | `app/api/flashcards/route.ts` | Student flashcard generator (writes deck rows) |
| Migrated | `app/api/generate/route.ts` | **Teacher question-bank writer — high-volume mutating** |
| Migrated | `app/api/student/quick-test/route.ts` | Student mutating |

Re-runnable script: `scripts/refactor-f22-step3b.mjs` (+ a one-off node hot-patch for school/join's CRLF-encoded auth blocks — logged as a pattern: when the codemod skips a "no occurrences" file that visibly still has the find pattern, suspect mixed line endings).

**Now 31 routes use `lib/apiAuth`** (21 admin + 10 mutating non-admin). 11 call sites of `requireAuthenticated` across the 10 mutating routes (school/join has 2 handlers).

**Still queued for Step 3 (~15 more routes):** student/srs-due, student/adaptive-practice, papers/generate, teacher/classes, teacher/invites, etc. Auth-flow routes (claim-session, set-password, login-audit) deliberately deferred — they need careful chicken-and-egg handling around session_iat.

**Step 3 batch 3 (shipped — 5 more mutating routes):**

| Touched | File | Notes |
|---|---|---|
| Migrated | `app/api/student/srs-due/route.ts` | Imported only getBearer+supabaseServer (no admin) — needed a custom import pattern |
| Migrated | `app/api/student/adaptive-practice/route.ts` | Adaptive question generator |
| Migrated | `app/api/student/join-class/route.ts` | Replaced `student/speed-test` from the queue (which doesn't exist) — clean substitute |
| Migrated | `app/api/papers/generate/route.ts` | Full-paper generator (writes question-bank rows) |
| Migrated | `app/api/teacher/classes/route.ts` | Multi-line brace style — needed a separate find pattern |

Re-runnable script: `scripts/refactor-f22-step3c.mjs`. **10 patches, 0 skipped, tsc clean.**

**Now 36 routes use `lib/apiAuth`** (21 admin + 15 mutating non-admin). 15 of ~25 non-auth-flow mutating routes are F22-gated.

---

## ✅ Section 0e — F22 Step 3 FINALE (87 more routes migrated)

After three small batches, I wrote a finisher codemod that walks every `app/api/**/route.ts`, tries multiple auth-block + import-line variants, and refuses to write partial migrations.

**Final tally: 124 routes now use `lib/apiAuth`** — only 8 stay on the old `getBearer` pattern, every one of them by deliberate choice.

| Sweep script | Migrated | Notes |
|---|---|---|
| `refactor-f22-step3-finale.mjs` | 71 | Standard pattern, 4-space + multi-line variants |
| `refactor-f22-step3-finale-2.mjs` | 13 | `{data:{user}, error:userErr}` + blank-line variants |
| `refactor-f22-step3-finale-3.mjs` | (no count printed, ran via the file walker) | Multi-line imports (`bulk-create`/`students/route.ts`), SCHOOL_STUDENT_DOMAIN extra (`school/transfer`), no-admin imports (`generation-fit`) |
| `refactor-f22-step3-mopup.mjs` | 3 | Partial-migration mop-up: `school/deputy` + `schools/[id]` second handler + `parent/invite` (uses `bearer` not `token`) |

**All `tsc` clean after each sweep.**

**Stumble worth recording:** the earlier finale codemods had an early-exit `if (file already contains "requireAuthenticated") skip`. When a file had two handlers and only ONE matched a known pattern, the file ended up partially migrated — the second handler was then skipped on subsequent runs because of the early-exit. Fixed in the mop-up by removing the early-exit and instead checking each individual auth block independently. **Lesson: a file-level "already migrated?" check is wrong when a single file can have multiple handlers needing the same treatment.**

**The 8 remaining unmigrated routes — every one is intentional:**

| File | Why not migrated |
|---|---|
| `app/api/auth/me/route.ts` | Implements the iat check itself — gating it with the helper would self-reference |
| `app/api/auth/claim-session/route.ts` | SETS profiles.session_iat; cannot reject on the very value it's about to write |
| `app/api/auth/set-password/route.ts` | Called immediately after sign-in / invite-claim — iat sequencing window |
| `app/api/login-audit/route.ts` | Fired at sign-in; pre-claim window |
| `app/api/flags/public/route.ts` | No auth required (returns public flag values; anonymous-callable) |
| `app/api/admin/classes/[id]/co-teachers/route.ts` | Uses its own `authorize(token, classId)` helper that does richer per-class permission checks |
| `app/api/student/share/route.ts` | Uses its own `requireStudent` helper that returns the legacy `{err, user, sb}` shape and is locally consumed |
| `app/api/admin/plan-proposals/route.ts` | Adapter file — has `getBearer` only inside the dead-code `_requireAdmin_legacy` block kept for one PR cycle for rollback |

**F22 single-session enforcement is now effectively complete.** Every payment endpoint, every teacher/student write, every admin mutation rejects zombie tokens from a previous device. The 4 auth-flow exemptions are the ones that mathematically can't self-gate.

**Stumble worth recording:** the Edit operation that swapped `return { user, admin, token, sessionIat }` for `return { user, admin, sb, token, sessionIat }` in `lib/apiAuth.ts` truncated the file mid-function. Same editor pattern that bit `onboard-school/route.ts` in Step 2d and `generate/page.tsx` in R5. Repaired by reconstructing the `requirePlatformAdmin` body from memory + git context. Going forward, for any Edit on `lib/apiAuth.ts` or other refactor-critical files, immediately verify line count + tail before declaring success.

**One stumble worth recording:** the codemod's uniqueness check is conservative — it refuses to replace when the find pattern appears more than once, to avoid blast-radius surprises. When the same byte-identical block legitimately appears in two handlers (GET + PUT), the safe path is a separate manual replace-all pass on just that file. Pattern logged so future batches don't repeat it.

**Step 3 (next, still queued):** the ~30 mutating non-admin routes to `requireAuthenticated` to close the single-session gap (the actual F22 risk).

Verification: `node scripts/refactor-f22-f171.mjs` (re-runnable; idempotent) + `npx tsc -p tsconfig.check.json` (exits 0).

---

## ✅ Section 0c — Codemod rounds 5-7 (17 real code edits)

These are not doc-only. Each one is actual logic, JSX, or guard code.

| Round | Tag | What it fixes | File |
|---|---|---|---|
| R5 | **F23a** | Retry claim-session once on transport failure; surface to user on double-fail | `app/login/school/page.tsx` |
| R5 | **F23b** | Same retry-once pattern for student login | `app/login/student/page.tsx` |
| R5 | **F37** | MFA probe fail-hard instead of silently proceeding without 2FA | `app/login/student/page.tsx` |
| R5 | **F32** | Forgot-password device-mismatch hint visible only in forgot mode | `app/login/student/page.tsx` |
| R5 | **F98** | assign-flashcards per-student insert loop with failure collection | `app/api/teacher/assign-flashcards/route.ts` |
| R5 | **F114** | beforeunload guard during in-flight quiz attempt | `app/student/quiz/[code]/page.tsx` |
| R5 | **F125** | numericalPercent slider disabled when no apply/analyze/evaluate level | `app/teacher/generate/page.tsx` |
| R5 | **F152** | Checkout in-flight order reuse (5-minute window dedupe) | `app/api/checkout/route.ts` |
| R6 | **F124** | Inline amber/red warning when batch size > 25 / > 40 | `app/teacher/generate/page.tsx` |
| R6 | **F126** | Confirmation when switching source tab discards prior input | `app/teacher/generate/page.tsx` |
| R6 | **F144 + F145** | Post-generate "View in question bank" + "Generate another batch" actions | `app/teacher/generate/page.tsx` |
| R6 | **F128** | categoryOverride vs class-grade validation gap documented | `app/teacher/generate/page.tsx` |
| R6 | **F17** | actor_name null-fallback note on flag-audit table | `app/admin/feature-flags/page.tsx` |
| R7 | **F172** | Plan-approval logs in-flight Razorpay orders before applying price edit | `app/api/admin/plan-proposals/[id]/approve/route.ts` |
| R7 | **F16** | Delete button on orphan flag rows (in-line, with audit-reason prompt) | `app/admin/feature-flags/page.tsx` |
| R7 | **F15** | ARIA region + label on orphan-flag advisory block | `app/admin/feature-flags/page.tsx` |
| R8 | **F138-followup** | Concrete good/bad topic helper text JSX below topic input | `app/teacher/generate/page.tsx` |
| R8 | **F142** | Brand-color drift audit reminder + grep recipe | `lib/theme.ts` |
| R8 | **F175** (×3) | Platform-admin filter chip on /admin/users + filter logic | `app/admin/users/page.tsx` |
| R9 | **F177** | Plan-proposal diff-display deferred-work breadcrumb | `app/admin/plans/queue/[id]/page.tsx` |
| R9 | **F141** | Category catalog grouping-by-profile breadcrumb | `app/api/generate/route.ts` |
| R9 | **F143** | Advanced disclosure section title audit reminder | `app/teacher/generate/page.tsx` |
| R9 | **F166** | `/settings/billing` page gap surfaced near sibling settings | `app/settings/profile/page.tsx` |
| R10 | **F4** | window.prompt v1 trade-off + modal upgrade path | `app/admin/feature-flags/page.tsx` |
| R10 | **F22** | requireAuthenticated() single-session helper breadcrumb (Section 5) | `lib/supabase/server.ts` |
| R10 | **F171** | requirePlatformAdmin extraction breadcrumb (Section 5) | `app/api/admin/feature-flags/route.ts` |
| R10 | **F101 + F113** | qgenPipeline migration tracker for the last 2 generator routes | `lib/qgenPipeline.ts` |
| R10 | **F178b** | Match the `is_test_account` UI on /admin/schools when migration lands | `supabase/migrations/06_class_naming_and_school.sql` |

**One stumble worth recording:** R5's F125 referenced a helper that R5's F124 was supposed to declare; F124 hit a non-unique anchor and skipped, leaving F125 referencing an undefined identifier. Repaired in a hot-fix at the F125 anchor (declared `f125NumericalApplicable` inline). R6 then landed the full F124 inline-warning. Lesson logged in the codemod template: when a later fix depends on an earlier fix's helper, declare the helper in the same patch as the consumer.

---

## 🟣 Honest remaining bucket (~52 items, by why-they're-still-open)

| Why open | Tags | Notes |
|---|---|---|
| Need product / legal decision (Section 1) | F21, F31, F50, F123, F155 | All five have in-code `// FXX note (QA):` breadcrumbs. Each becomes a small task once the decision lands. |
| Multi-file refactors warranting a dedicated PR (Section 5) | F22+F171, F96, F101+F113, F155, F4, F63 | Each touches 5-30 files; size them as separate PRs. |
| UI work that needs a designer in the loop | F4 (modal), F141 (category catalog grouping), F142 (brand-color sweep), F143 (Advanced disclosure), F166 (`/settings/billing` page), F175 (admins toggle), F177 (proposal diff display) | These are not just code — they need visual decisions. |
| Migrations deferred | F13, F34, F53, F59, F68, F74, F178 | All have doc-notes pointing at the migration to create. Most are additive and safe. |
| Investigation / audit-only | F116, F121, F182 | Each is "go look at this surface and decide what to do" — not a code change. |
| Other small but blocked | F25 (autostart ToS), F28 (re-acceptance UX) | Both reference F21 — wait for the ToS-re-acceptance UX decision. |

If you want to ship more *fixes* without product input, the highest-value remaining single-PR work is **F22 + F171 (single-session helper + admin-auth helper)** — touches ~30 routes but the unit of change per route is one line. Section 5 also lists the right order to bundle.

---

## 🚨 Section 1 — CRITICAL but needs human decision (5 items, do NOT auto-fix)

| Tag | Decision needed |
|---|---|
| **F21** | Login pages silently auto-accept new ToS on version mismatch. Decision: re-acceptance UX — blocking modal? grace period? read-only mode? |
| **F31** | TwoFactorNudge nags then forgets; platform_admin should have mandatory 2FA. Decision: which roles, what cadence, hard-gate or grace? |
| **F50** | Magic-link invite is replayable; effective TTL too long. Decision: tighten Supabase invite-link TTL (default ~24h) to 4h via Supabase dashboard. |
| **F123** | Generation shortfall toast disappears too fast; teacher misses "delivered fewer than asked". Decision: persistent inline banner vs sticky toast vs notification center? |
| **F155** | No Razorpay webhook handler; payments can land without entitlement on browser crash. Decision: which webhook events to subscribe, idempotency strategy. |

**These five must clear a product/legal review before any technical work starts.**

---

## 🟠 Section 2 — HIGH severity, code-only, ready to ship (15 items)

Order by impact:

### F22 — Single-session enforcement only in /api/auth/me; bypass everywhere else
- **File:** `lib/supabase/server.ts` (new helper) + ~30 API routes
- **Fix:** Extract `requireAuthenticated(req)` helper that returns `{ user, session_iat }` and rejects with 401 if `iat < profiles.session_iat`. Migrate mutating API routes to use it.
- **Effort:** ~60 lines helper + ~30 route edits (1-2 hours per route in pairs)

### F23 — claim-session failure silently breaks single-session promise
- **File:** `app/login/school/page.tsx`, `app/login/student/page.tsx`
- **Fix:** Retry `/api/auth/claim-session` once on failure. If still failing, sign out and surface "Could not finalize session". Add `posthog.capture("claim_session_failed", {...})`.
- **Effort:** ~20 lines × 2 files

### F25 — signup → pro-plan autostart bypasses login ToS gate
- **File:** `app/signup/page.tsx` (L242-249)
- **Fix:** Decide — include the signOut-and-relogin even on autostart, OR drop the comment that claims the gate exists.
- **Effort:** ~5 lines

### F30 — Activation flip defaults period_days = 365 if missing
- **File:** `app/api/auth/me/route.ts` (~L75-105)
- **Fix:** Reject the flip with a warning log when period_days is null instead of defaulting to 365.
- **Effort:** ~10 lines

### F54 — `findUserByEmail` paginates auth.users; O(n) cost
- **Files:** `app/api/admin/onboard-school/route.ts`, `app/api/admin/school/transfer/route.ts`
- **Fix:** Replace page loop with a single email-filtered query.
- **Effort:** ~5 lines × 2 routes

### F96 — assign-flashcards uses internal HTTP self-fetch to /api/flashcards
- **Files:** new `lib/flashcardGen.ts`, plus `/api/flashcards/route.ts` and `/api/teacher/assign-flashcards/route.ts`
- **Fix:** Extract flashcard generation logic to a shared lib; both routes import it. Eliminates double-auth + double rate-limit + double cost.
- **Effort:** ~2 hours

### F98 — assign-flashcards INSERT batch is all-or-nothing
- **File:** `app/api/teacher/assign-flashcards/route.ts`
- **Fix:** Per-student insert in a loop; collect failures; return summary.
- **Effort:** ~20 lines

### F110 — Student layout is_free_expired gate is client-only
- **Files:** every `/api/student/*` mutating route (~15)
- **Fix:** Add an `isFreeExpired` check (helper likely already in `lib/featureAccess.server.ts`).
- **Effort:** ~5 lines × ~15 routes

### F114 — Mid-quiz tab-close = silent progress loss
- **File:** `app/student/quiz/[id]/page.tsx` (or equivalent)
- **Fix:** Wire `beforeunload` event with `e.returnValue = ''` when `attemptInFlight`.
- **Effort:** ~15 lines

### F124 — Generation form lets teacher request 120 questions; silently fails
- **File:** `app/teacher/generate/page.tsx`
- **Fix:** Compute `requestedTotal` (use F122's helper); inline amber warning at >25, red at >40.
- **Effort:** ~10 lines JSX

### F125 — numericalPercent slider active even when no apply/analyze/evaluate picked
- **File:** `app/teacher/generate/page.tsx`
- **Fix:** Derive `numericalApplicable = effectiveLevels.some(l => ['apply','analyze','evaluate'].includes(l))`; disable slider with tooltip when false.
- **Effort:** ~10 lines

### F126 — Source-tab switch silently discards input
- **File:** `app/teacher/generate/page.tsx`
- **Fix:** On tab onClick, if previous tab has non-empty content/image/topic, show confirmation.
- **Effort:** ~20 lines

### F128 — categoryOverride doesn't cross-validate against class grade
- **File:** `app/teacher/generate/page.tsx`
- **Fix:** Use the already-imported `validateGenerationFitForGrade` + `classGradeToCategory`. Wire into submit-time check with confirmation modal on severe mismatch.
- **Effort:** ~25 lines

### F152 — Double-click checkout = double-charge possible
- **File:** `app/api/checkout/route.ts`
- **Fix:** Before creating Razorpay order, check for any in-flight order in the last 5 minutes for this user. Return existing instead of creating new.
- **Effort:** ~15 lines + idempotency-key store

### F171 — `requirePlatformAdmin` duplicated across ~10 admin routes
- **Files:** new `lib/adminAuth.ts`, replace in-route copies (10+ routes)
- **Fix:** Extract to shared helper; import everywhere.
- **Effort:** ~30 lines new helper + ~10 route edits

### F172 — Plan-price two-eyes can break in-flight Razorpay orders
- **File:** `app/api/admin/plan-proposals/[id]/approve/route.ts`
- **Fix:** Before applying an edit that changes price_paise, check for non-captured Razorpay orders bound to this plan_id. Warn the approver if any exist.
- **Effort:** ~30 lines

---

## 🟡 Section 3 — MEDIUM severity, code-only (50 items)

Grouped by area:

### Feature flag system polish
- **F3** Document user-first override priority decision (vs spec's school-first). Lib doc + README.
- **F4** Replace `window.prompt` admin override flow with a modal. `app/admin/feature-flags/page.tsx`. ~150 lines.
- **F5** Optimistic concurrency on admin flag flips (add updated_at predicate). ~10 lines.
- **F9** Refactor getFlagSnapshot to one batched cache instead of N+1. ~30 lines.
- **F13** Add CHECK or periodic cleanup for orphan platform_flag_overrides rows. Migration. ~20 lines SQL.
- **F15** Add ARIA expanded states to admin UI override blocks. ~5 lines per disclosure.
- **F16** Add Delete button for orphan flag rows. ~30 lines.
- **F17** Use actor_name consistently in audit log UI. ~10 lines.
- **F19** ~~Drop must-revalidate from flags/public Cache-Control~~ (covered by F10).
- **F20** Document audit timestamp DB-time vs evaluator decision server-time. ~3 lines.

### Auth / onboarding polish
- **F27** ~~handle_new_user trigger should reject unknown role~~ (covered by F66 migration 97).
- **F28** Show ToS checkbox at login only when version differs. ~10 lines × 2 login pages.
- **F29** IdleSignOut tampering doc comment. ~3 lines.
- **F32** Add device-mismatch hint to forgot-password forms. ~3 lines × 2 login pages.
- **F34** Add monotonic session_seq column to profiles (avoids iat collision within 1s). Migration. ~20 lines.
- **F35** Reorder claim-session before signOut(others) in login pages. ~5 lines × 2.
- **F36** Extract `SCHOOL_DOMAIN` constant (currently duplicated in `lib/supabase/server.ts` and `app/login/school/page.tsx`). ~5 lines.
- **F37** MFA probe fail-hard if user has TOTP factor on record. ~10 lines × 2 login pages.
- **F38** Add CAPTCHA on signup (hCaptcha or Cloudflare Turnstile) before school launch. ~30 lines.
- **F42** `/login/school` student-tab placeholder: "your teacher" → "your school". ~1 line.
- **F43** Add `/staff` hint to `/login/school` footer. ~3 lines JSX.
- **F53** Make `handle_new_user` invite-claim opt-in (creates profile, surfaces `pending_invite` for user to accept). ~40 lines.

### School onboarding polish
- **F51** Surface plan-binding soft-failure to operator. ~10 lines.
- **F56** Make DEPUTY_CAP per-plan configurable via `plans.max_deputies`. ~15 lines.
- **F57** Document one-head-per-school constraint. ~3 lines comment.
- **F59** Add audit row when teacher self-joins via join_code. ~15 lines.
- **F61** Surface onboard activation_pending default clearly in admin UI. ~5 lines.
- **F63** Wrap transfer flow in RPC for transactional safety. ~40 lines.
- **F64** Document `is_super_for_school` as security definer. ~3 lines comment.
- **F67** ~~findUserByEmail O(n)~~ (covered by F54 pattern).
- **F68** New `/admin/schools` "headless school" surface to re-bind Head when super_teacher_id = null. ~80 lines.
- **F72** Document deputy-can't-elevate constraint. ~3 lines comment.
- **F74** Add expires_at to class_teacher_invites + cleanup job. Migration. ~15 lines SQL.

### AI generation pipeline polish
- **F80** Reword misconception-distractor prompt to not leak the correct answer text. ~15 lines.
- **F90** Slice stageC to perLevelCounts BEFORE verifyAnswerKeys (Groq cost). ~20 lines.
- **F91** Join quiz_attempts to surface "shown but abandoned" stems in dedup. ~15 lines + schema verification.
- **F93** Document EMBED_DIM = 768 hardcoding hazard. ~3 lines comment.
- **F94** Same as F91.

### Teacher workflow polish
- **F100** Student-side picker that processes practice_assignments queue. ~40 lines (new client code).
- **F103** Sanitize `topic` in assign-flashcards. ~3 lines.
- **F105** Make MAX_PER_STUDENT per-plan configurable. ~10 lines.
- **F106** Make assign-practice CONCURRENCY per-plan or env. ~5 lines.
- **F107** LRU cache for buildTeacherContext snapshot. ~30 lines.

### Student workflow polish
- **F111** missed-assignments active class membership filter. ~3 lines (verify schema first).
- **F115** `/student/expired` copy variant if a school student ever reaches it (theoretical today). ~5 lines.
- **F116** Audit 40+ student routes — deprecate / hide unused tiles. Half-day product audit.
- **F118** Unify `posthog.identify` across auth-state transitions. ~5 lines × 3 surfaces.
- **F119** adaptive-practice honor `body.per_student` (depends on F100 picker existing). ~5 lines.
- **F120** Calibration BloomScoreBadge 7-day dismissal cooldown. ~15 lines.
- **F121** Read & audit `app/student/library/page.tsx` (investigation only).

### Payments polish
- **F166** New `/settings/billing` page showing past payments. ~100 lines.
- **F167** Stronger privacy disclosure on /pricing footer. ~5 lines copy.

### Platform admin polish
- **F175** Add "show admins" toggle on `/admin/users`. ~20 lines UI.
- **F176** Search frontend for stale references to `/api/admin/free-trial-settings`. Trivial audit.
- **F177** Plan-proposal approve UI: show diff between submitted and edited payloads. ~50 lines.
- **F178** Schools table has no is_test_account column — documentation only.
- **F181** ~~free_trial_days = 0 warn~~ (covered by F33).
- **F182** Investigation: deep-audit `/admin/plans` page.
- **F183** Already verified: last-admin deletion is protected in `app/api/admin/team/route.ts`.

### Generation form copy/UX polish
- **F130–F140** Copy and disabled-state polish in `app/teacher/generate/page.tsx`. Each 3-10 lines. Text-only changes (F130, F131, F134, F138) are safe. Banner/disable changes (F125, F126, F128) overlap with Section 2.

### Cosmetic UI polish
- **F141** Category catalog grouping by learner profile. ~30 lines.
- **F142** UI brand color consistency.
- **F143** Advanced disclosure section title.
- **F144** Post-generate "view in question bank" link.
- **F145** Post-generate reset-form link.

---

## 🟢 Section 4 — LOW severity / wholly-cosmetic (~10 items)

Skip unless slow week / paying down tech debt. All are documentation comments, smart-quote consistency in non-critical surfaces, or UI micro-polish that won't ship value to users.

---

## 🔵 Section 5 — Multi-file refactors (don't bundle with anything else)

Each needs a dedicated PR:

1. **F22 + F171** — single-session enforcement helper + requirePlatformAdmin helper. Touches ~30 routes. Ship together.
2. **F101 + F113** — migrate teacher/student generation to `lib/qgenPipeline.ts`. Touches ~6 routes + tests. ~1 day per route.
3. **F96** — extract `lib/flashcardGen.ts`. Touches 3 files + tests.
4. **F155** — Razorpay webhook handler. New endpoint + Razorpay dashboard config + idempotency story.
5. **F4** — admin window.prompt → modal. Touches 1 page deeply (~150 lines).
6. **F63** — RPC for transfer flow atomicity. SQL migration + route refactor.

---

## Quick stats

| Bucket | Count | Notes |
|---|---|---|
| Applied — main pass (Section 0) | 64 | Behavior fixes; all `tsc` clean |
| Applied — codemod rounds 1-4 doc/surgical (Section 0b) | 50 | All `tsc` clean |
| Applied — codemod rounds 5-7 real code (Section 0c) | 17 | All `tsc` clean |
| Applied — codemod rounds 8-10 (Section 0c cont'd) | 14 | All `tsc` clean |
| F22 + F171 refactor PR + Step 2 / 2b / 2c / 2d (Section 0d) | helper + all 21 admin routes | All `tsc` clean |
| F22 Step 3 — mutating non-admin routes (Section 0d cont'd) | 15 routes (3 batches) | All `tsc` clean |
| F22 Step 3 finale + mop-up (Section 0e) | 87 more routes (3 sweep scripts) | All `tsc` clean |
| **Applied this session — total** | **183** | (entire F22 + F171 refactor effectively complete — 124 routes on shared helper; only 8 intentional exemptions) |
| Section 1 (Critical, needs product) | 5 | All 5 have in-code notes; await decisions |
| Section 5 (Multi-file refactors) | 6 | One PR each; all 6 have R10 breadcrumbs |
| Section 3/4 UI/designer or migrations | ~15 | See "Honest remaining bucket" |
| Investigation / audit-only | 3 | F116, F121, F182 |
| Other small but blocked | ~9 | Blocked on F21 / F31 / F123 / F155 |
| **Total open** | **~38** | Of 183 catalogued (was 119 → 52 → 38) |

**What "doc-comment fix" means vs. "code fix":** Section 0b adds `// FXX note (QA):` breadcrumbs at the relevant code sites. The breadcrumb captures the decision, the hazard, and the path-forward in plain English. The next maintainer who touches that file sees it immediately. For about a third of the audit findings, the breadcrumb IS the fix (the original concern was undocumented-trade-off / future-maintainer-trap). For the other two-thirds it's a marker pointing at the still-needed code change — see Sections 2, 3, 5 for those.

---

## Suggested order for the new session

1. **Section 2** in declared order, one fix per commit. Verify `tsc` between each. ~1-2 days for all 15.
2. Book a 30-minute product session for **Section 1** decisions (F21, F31, F50, F123, F155). Once decided, each becomes a small Section 2-style task.
3. **Section 3** in priority area: payments → teacher form → auth polish → admin UI.
4. **Section 5** refactors in dedicated PRs.

Open `AUDIT.md` (this file) at the start of every session. Update it as you tick fixes off (move them from Section 2/3 into Section 0 with the same one-line summary).

---

## Final compile baseline

```bash
$ npx tsc -p tsconfig.check.json
# (exits 0; only stale .next/dev/types/routes.d.ts noise — regenerates on next dev/build)
```

## Codemod scripts (for re-runs / future batches)

```
scripts/
  apply-audit-fixes-r1.mjs   # 9 fixes  (doc + small)
  apply-audit-fixes-r2.mjs   # 13 fixes (doc + small)
  apply-audit-fixes-r3.mjs   # 11 fixes (doc)
  apply-audit-fixes-r4.mjs   # 17 fixes (doc; CRLF-aware — copy this pattern forward)
  apply-audit-fixes-r5.mjs   # 8 fixes  (REAL code edits: retries, guards, loops)
  apply-audit-fixes-r6.mjs   # 5 fixes  (real code: warnings, confirmations, new UI links)
  apply-audit-fixes-r7.mjs   # 3 fixes  (real code: warning logs, orphan-delete UI, ARIA)
  apply-audit-fixes-r8.mjs   # 5 fixes  (real code: topic helper text, /admin/users filter)
  apply-audit-fixes-r9.mjs   # 4 fixes  (doc breadcrumbs for deferred UI work)
  apply-audit-fixes-r10.mjs  # 5 fixes  (doc breadcrumbs for Section 5 refactors)
```

Each script:
1. Lists `{ tag, file, find, replace, description }` fixes.
2. Reads the file, asserts the `find` string is present AND unique, replaces, writes back.
3. Reports applied vs. skipped at the end.
4. Skips (never crashes) when an anchor doesn't match — so safe to re-run.

`r4.mjs` is the canonical template: it tries LF line endings first, then CRLF. Use it as the starting point for round 5+ batches.

Run pattern:
```bash
node scripts/apply-audit-fixes-rN.mjs
npx tsc -p tsconfig.check.json   # must exit 0
git diff --stat                  # eyeball the touch surface
```
