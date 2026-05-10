<!--
  PR template — fill in every section. See CONTRIBUTING.md for the full
  workflow. Sections marked (required) MUST be answered before requesting
  review; (optional) only if relevant to this PR.
-->

## What changed (required)

<!-- One paragraph, plain English. What does this PR do for the end user
or the operator? Avoid implementation jargon — describe the user-facing
effect, then mention the mechanism in one sentence. -->

## Why (required)

<!-- Link to the bug report, user request, or design decision driving this
change. If it's a regression fix, name the symptom and the root cause. -->

## How to test (required)

Preview URL: <!-- Vercel will fill this in via the bot comment; copy the
URL into here too so reviewers don't have to scroll. -->

Test accounts (already seeded; password `QATest@2026`):
- `qa.indep.student@bloomiq.test`
- `qa.school.student@bloomiq.test`
- `qa.teacher@bloomiq.test`
- `qa.school.admin@bloomiq.test`

Click-through:
1. <!-- step 1 -->
2. <!-- step 2 -->
3. <!-- step 3 -->

Expected: <!-- what the reviewer should see -->

## Migrations (required if any new SQL files)

- [ ] Migration file added under `supabase/migrations/`
- [ ] Applied to prod via SQL Editor / Supabase MCP **before** merge
- [ ] Schema reload (`notify pgrst, 'reload schema';`) included in the migration

## Risk + rollback (required)

Blast radius: <!-- e.g. "only affects /admin/users page" or
"changes RLS on profiles — every authenticated read goes through this
policy" -->

Rollback plan: <!-- usually "revert this commit on main; Vercel
auto-redeploys"; flag if the migration also needs reversing -->

## Screenshots (optional)

<!-- Drop before/after for any UI change so the reviewer doesn't have to
guess. -->

## Reviewer checklist (filled by reviewer)

- [ ] Vercel preview deploy is `Ready` (green check)
- [ ] Diff makes sense without surprise side-effects
- [ ] Preview URL passes the test steps above
- [ ] If migration: confirmed applied to prod
- [ ] No console.log / debug code left behind
- [ ] No real user emails / secrets in the diff
