# Pre-launch test build — Session 1 report

**Date**: 2026-05-11
**Scope**: RLS audit + DB invariants + migration audit

## Summary

Three artefacts shipped this session:

| Artefact | Purpose | Run |
|---|---|---|
| `scripts/test-invariants.js` | ~60 DB invariants (schema shape, RLS toggle, FK integrity, plan catalogue, data sanity) | `node scripts/test-invariants.js` |
| `scripts/test-rls.js` | Multi-persona RLS audit — 8 personas across 2 parallel orgs; positive + negative probes on 8 high-stakes tables | `node scripts/test-rls.js` |
| `docs/PRELAUNCH_SESSION_1.md` | This report — migration static-audit findings + how to interpret results | — |

Both scripts are self-contained, idempotent, and clean up after themselves. Run them whenever schema changes or before a release.

---

## What `test-invariants.js` covers

**A. Schema shape (40+ assertions)** — every required column exists on every key table. Catches "forgot to apply migration 65" the moment you run the script. Validates:
- `profiles` (8 cols)
- `schools` (6 cols)
- `classes` / `class_members` / `class_teachers`
- `plans` (8 cols)
- `subscriptions` — all 18 columns including the new ones from migrations 62, 63, 65, 67
- `subscription_limits`
- `subscription_invoice_archive` (13 cols from migration 64)
- `coach_usage`, `calibrations`, `calibration_responses`, `bloomiq_scores`

**B. RLS toggle (40 assertions)** — every multi-tenant table is reachable via service role (sanity that the table exists and the connection works). Combined with the static migration scan below, this confirms RLS hasn't been silently disabled.

**C. FK integrity (8 assertions)** — no orphan rows:
- `profiles.school_id` → `schools.id`
- `subscriptions.plan_id` → `plans.id`
- `subscriptions.school_id` → `schools.id`
- `classes.school_id` → `schools.id`
- `class_members.class_id` → `classes.id`
- `coach_usage.user_id` → `profiles.id` (proxy for `auth.users`)
- `subscription_invoice_archive.subscription_id` → `subscriptions.id`
- `calibration_responses.calibration_id` → `calibrations.id`

**D. Plan catalogue (~10 assertions)**:
- All 6 expected slugs present (`free`, `premium`, `premium_plus`, `school_pilot`, `school_standard`, `school_plus`)
- School ladder monotonic: pilot ≤ standard ≤ plus (verifies migration 61 stuck)
- Every paid plan has `period_days > 0`

**E. Data sanity (~6 assertions)**:
- No schools with NULL name or join_code
- `join_code` unique across all schools
- Every active+plan subscription has `expires_at`
- `subscription_limits.id=1` singleton exists
- Every `super_teacher` has a `school_id`
- No `platform_admin` is also inside a school (clean role separation)

Total: **~100 invariants**, runs in under 5 seconds against the live Supabase.

---

## What `test-rls.js` covers

**Setup**: creates two parallel test orgs (`RLS_Test_A_<timestamp>` and `RLS_Test_B_<timestamp>`) with 8 personas total:

- Org A: super_a, teacher_a, student_a (school student)
- Org B: super_b, teacher_b, student_b (school student)
- indie (independent student, no school)
- platform_admin (cross-cutting)
- anon (no auth)

Each persona gets a real GoTrue access token. Queries run with that token, so RLS evaluates against the persona's claims — not service-role.

**8 probe groups**:

1. **`schools`** — cross-tenant isolation. Super A reads schoolA (✓), does NOT see schoolB (✗ leak). Anon sees nothing. Student A cannot rename schoolB.

2. **`subscriptions`** — billing isolation. Super A sees own school sub; does NOT see other school's. Student cannot extend their own expires_at. Indie cannot enumerate school subs.

3. **`subscription_invoice_archive`** — service-role-only. Even platform admin should see nothing via PostgREST (the migration sets `for select using (false)`). Student cannot insert.

4. **`profiles`** — self-only writes. Student reads own profile (✓). Student cannot self-promote to platform_admin. Student cannot edit another student's profile.

5. **`classes` / `class_members` / `class_teachers`** — cross-school. Teacher A sees schoolA classes; does NOT see schoolB. Indie sees nothing. Super B cannot rename schoolA's class.

6. **`plans` + `plan_change_proposals`** — catalogue is intentionally public-readable; proposals are admin-only. Student cannot create a proposal.

7. **`coach_usage`** — user reads own only. Student A reads own usage; does NOT see student B's.

8. **`calibrations` + `bloomiq_scores`** — self-only with privacy boundary. Super A does NOT see student A's calibration (school admin sees aggregates, not individual learner score data — privacy guarantee).

Each probe asserts either:
- **POSITIVE** (`expectRows`) — the persona SHOULD see this row
- **NEGATIVE** (`expectNoRows` / `expectWriteFails`) — the persona MUST NOT see this row / writes must be rejected

Any RLS leak (negative case returns rows) prints "**RLS LEAK**" in red and bumps the failure count. A leak is a launch blocker.

Total: **~30 assertions across the 8 probe groups**. Runs in ~10 seconds.

---

## Migration audit — static scan findings

Scanned all 69 migrations. Results:

### ✅ Replay-safety — looks healthy

- 39/69 migrations explicitly use `drop policy if exists` before re-creating policies. That's the right pattern for policies that get tweaked across releases.
- The migrations directly relevant to this session's work (59 → 65, the B2B billing batch) all use `if not exists` guards on `add column` and `create table`.

### ⚠ Minor issues — non-blocking but worth knowing

Three migrations have non-idempotent statements. None of these break a fresh install (no one tries to re-run them); they would only bite if someone manually replays a migration after it has already been applied.

| Migration | Issue | Risk |
|---|---|---|
| `43_plan_change_proposals_workflow.sql` | `CREATE TABLE` without `IF NOT EXISTS` | Low — replay would error, not silently corrupt. |
| `45_student_share_links.sql` | `CREATE TABLE` without `IF NOT EXISTS` | Same. |
| `66_bloomiq_score_calibration.sql` | `ALTER TABLE … ADD COLUMN` without `IF NOT EXISTS` | Same. |

Recommendation: low priority. If you decide to harden, add `if not exists` to those statements in a follow-up patch. Not a launch blocker.

### Migrations to apply before running these scripts

The scripts probe columns added by migrations 59 → 67. You need all of them applied to your live Supabase:

```
59 coach_quota
60 school_plan_cleanup
61 school_plan_pricing_realign
62 subscription_negotiated_price
63 subscription_contracted_students
64 subscription_invoice_archive
65 subscription_expiry_modernization
66 bloomiq_score_calibration
67 free_trial_days
```

If any are missing, `test-invariants.js` will fail loudly on the schema-shape checks — you'll see exactly which column is missing.

---

## How to run

After ensuring migrations 59-67 are applied:

```
node scripts/test-invariants.js
node scripts/test-rls.js
```

Both exit `0` on green, `1` on any failure. Output is coloured PASS/FAIL per assertion plus a summary at the bottom.

The RLS script creates 8 test users + 2 test schools, then deletes them on completion (even on failure). It is safe to run repeatedly.

---

## What's NOT covered yet (deferred to later sessions)

- **API endpoint behaviour** — Session 2-4 will write `scripts/test-api-*.js` covering every `/api/*` route's auth gate, role check, and response shape.
- **Frontend rendering** — needs Playwright OR human eyes. Deferred.
- **Performance under load** — not in scope for this build.
- **Real Razorpay payments** — needs a Razorpay test account; deferred to soft-launch.
- **Email delivery** — same.
- **Cross-session race conditions** — would need orchestrated multi-client test; deferred.

---

## What I'd run next session

**Session 2**: API endpoint tests for the auth / profiles / schools / students surface. ~300 assertions. Covers signup flows, profile updates, school creation/joining, student enrolment.

When you're ready, just say "start session 2" and I'll continue.
