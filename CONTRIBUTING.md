# Contributing to BloomIQ

This is the working agreement between the two collaborators on this repo. It
covers branching, preview deploys, schema migrations, QA on prod, and the
release flow. Read it once, refer back when in doubt.

---

## TL;DR — daily flow

1. `git checkout main && git pull`
2. Branch off main: `git checkout -b feature/<short-name>`
3. Build the feature locally (`npm run dev`).
4. Push the branch → open a PR. Vercel auto-builds a **preview deploy** at
   `https://bloom-iq-git-<branch>-<your-user>.vercel.app`.
5. Other collaborator reviews the PR + clicks the preview URL to test.
6. Merge to `main` → Vercel auto-deploys to prod.

---

## Branching

| Branch type            | Naming                          | Lifetime                  |
|------------------------|---------------------------------|---------------------------|
| Production             | `main`                          | Permanent                 |
| Feature                | `feature/<short-name>`          | Until merged              |
| Bug fix                | `fix/<short-name>`              | Until merged              |
| Throwaway exploration  | `spike/<short-name>`            | Delete after answering Q  |

- Never push directly to `main`. Always go through a PR.
- Keep branches short-lived (under a week) to minimise merge conflicts.
- One feature per branch. Don't mix unrelated changes.

---

## Pull request rules

Every PR description must answer:

1. **What** changed? (one paragraph, plain English)
2. **Why** does it change? (link to the user story / bug / report)
3. **How** can the reviewer test it? (preview URL + 3–5 clicks)
4. **Risks** + rollback plan if anything blows up in prod.

The PR template (`.github/pull_request_template.md`) prompts these. Don't
skip them.

A PR is mergeable when:

- Vercel preview deploy is `Ready` (green check).
- Local `npm run build` passes.
- Other collaborator has reviewed + approved.
- All migrations from `supabase/migrations/` are noted in the PR with an
  "applied to prod ✓" checkbox by the time of merge.

---

## Database migrations

Schema changes go through `supabase/migrations/<NN>_<name>.sql`, numbered
sequentially.

Workflow:

1. Write the migration locally + commit it on the feature branch.
2. Apply to **prod** via Supabase SQL Editor (or MCP) **before** merging
   the PR. The deployed code expects the new schema.
3. Tick the "applied to prod ✓" box in the PR template.
4. Merge the PR → Vercel deploys the matching code.

Why prod-first instead of branch-DB? We share one production Supabase
project today (single-DB setup). Once we move to per-branch DBs (Supabase
Branching, $25/mo), this changes.

**Migration safety rules:**

- Always `add column if not exists` / `create table if not exists` so reruns
  are idempotent.
- Avoid `drop column` on a live table without a feature-flagged release plan.
- New RLS policies need a `drop policy if exists … ; create policy …` pair.
- End every migration with `notify pgrst, 'reload schema';` so the PostgREST
  cache picks it up immediately.

---

## QA on production

We test on prod, not on a separate staging DB. The test cohort is isolated
via the `is_test_account` flag.

### Mark a tester

1. Go to `/admin/users`.
2. Find the tester → Edit → tick **🧪 Beta tester** → Save.
3. Their activity is now invisible to platform dashboards / revenue / top
   schools — but the app behaves identically for them.

### Tester accounts

The 40-tester cohort signs up through the public flow on prod. There's no
canonical seed script — each tester creates their own account, then a
platform admin marks them via the **🧪 Beta tester** toggle on
`/admin/users`. Once flagged, the account is invisible to dashboards but
otherwise behaves identically to a real user.

### Health monitoring

- `/api/healthz` — JSON heartbeat (for monitors).
- `/status` — human-friendly view (for operators).
- UptimeRobot pings `/api/healthz` every 5 minutes; emails on 2 consecutive
  failures.

---

## Release flow

| Step | Who | What |
|---|---|---|
| 1 | Author | Open PR with branch + filled-in template |
| 2 | Vercel | Auto-builds preview deploy, posts URL on the PR |
| 3 | Author | Click the preview URL, run through the test plan |
| 4 | Reviewer | Read the diff + click the preview URL |
| 5 | Author | If migration involved, apply to prod via SQL Editor |
| 6 | Reviewer | Approve PR (or request changes) |
| 7 | Author | Merge PR (squash-merge preferred for clean history) |
| 8 | Vercel | Auto-deploys main → prod |
| 9 | Author | Open `/status` to confirm green; eyeball `/api/healthz` |

If prod breaks after merge: revert the merge commit (`git revert -m 1
<sha>`), push to main → Vercel redeploys the last good build automatically.
Roll-forward fixes go through a fresh PR — never patch on main.

---

## Coding conventions

- TypeScript strict mode is on. Don't `// @ts-ignore` without a comment.
- Server routes that read user data: prefer the service-role
  `supabaseAdmin()` client + an explicit `auth.uid()` re-check. Avoid
  reading sensitive tables (`profiles`, `subscriptions`, `class_teachers`)
  with the user-token client — there's a known RLS edge race.
- Follow the existing `lib/` boundary conventions — keep helpers small,
  one job per file.
- Comments explain *why*, not *what*. The diff already shows what.

---

## When in doubt

- Match the pattern of the surrounding code.
- Prefer one extra commit + reviewer pass over a clever one-liner.
- If you're about to touch RLS, billing, or auth — drop a comment in the
  PR description explaining the blast radius.
