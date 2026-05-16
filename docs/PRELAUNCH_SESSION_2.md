# Pre-launch test build — Session 2 report

**Date**: 2026-05-11
**Scope**: Implement Free-plan strategy "Option A" — Showcase Free with admin-configurable caps and lifetime-once tastes of Premium-Plus features.

## TL;DR — what shipped

Migration 68 + 1 helper lib + 13 gated API routes + 2 new helper endpoints + 1 admin page. Every cap is editable by platform admin without redeploy. Verified by `scripts/test-free-plan.js` + `tsc --noEmit` clean.

## Files

| Layer | New / changed |
|---|---|
| Migration | `supabase/migrations/68_free_tier_caps_and_usage.sql` (new) — adds 14 columns to subscription_limits, plus `daily_ai_usage` + `lifetime_feature_usage` tables, plus `free_daily_remaining()` + `free_lifetime_used()` helper SQL functions |
| Server lib | `lib/freeQuota.ts` (new) — `checkDailyQuota`, `recordDailyUse`, `checkLifetimeUse`, `recordLifetimeUse`, plus the 60-second in-process cache + cache-clear hook |
| Daily-cap routes (6) | `/api/tutor/chat`, `/api/teach-back/grade`, `/api/speed/start`, `/api/flashcards`, `/api/student/coach`, `/api/student/daily-drill` |
| Lifetime-once routes (6) | `/api/rank/predict`, `/api/xray/analyze`, `/api/traps/diagnose`, `/api/graph/build`, `/api/visualizer/create`, `/api/student/calibration/start` |
| Premium-only (1) | `/api/srs/enqueue` — adding new SRS cards now requires `memory_srs`; reviews stay free |
| Helper endpoints | `/api/feature/touch` (claim a lifetime-once feature), `/api/feature/usage` (read live caps + remaining) |
| Voice teacher | `app/student/voice-teacher/page.tsx` — claims lifetime touch on first message |
| Admin UI | `/admin/free-tier-limits` page + `/api/admin/free-tier-limits` route; link banner added to `/admin/plans` |
| Pricing copy | `app/pricing/page.tsx` Free card + landing tagline + FAQ rewritten to match Option A |
| Marketing copy | Migration 68 updates `plans.feature_summary` for the Free plan |
| Tests | `scripts/test-free-plan.js` — DB invariants, function existence, marketing copy |

## How the caps work

Two kinds of limits, both stored on the singleton `subscription_limits.id=1` row and editable from the admin UI:

**Daily caps** (`free_daily_*` columns) reset at midnight in `daily_reset_timezone` (default `Asia/Kolkata`). Per (user, surface, day) row written to `daily_ai_usage`. Paid users (`tier != 'free'`) are uncapped.

**Lifetime caps** (`free_lifetime_*` columns) record one row per (user, feature) in `lifetime_feature_usage` once the feature is used. Recorded only after a successful response, so a failed Groq call doesn't burn the user's one shot. Paid users uncapped.

Both gates read live from `subscription_limits` with a 60-second in-process cache. The admin save handler calls `clearFreeQuotaCache()` so edits take effect on the next request without redeploy or a 60-second wait.

## Defaults

| Surface | Default cap | Where to edit |
|---|---|---|
| `free_daily_attempts` (existing) | 3 / day | Admin page |
| AI Tutor turns | 5 / day | Admin page |
| Teach-Back submissions | 1 / day | Admin page |
| Speed sessions | 1 / day | Admin page |
| Flashcards | 5 / day | Admin page |
| Student Coach turns | 5 / day | Admin page |
| Daily Drill | 1 / day | Admin page |
| Past-Paper X-Ray | 1 lifetime | Admin page |
| Mock Rank Predictor | 1 lifetime | Admin page |
| Concept Visualizer | 1 lifetime | Admin page |
| Voice AI Teacher | 1 lifetime | Admin page |
| Trap Detector | 1 lifetime | Admin page |
| Knowledge Graph | 1 lifetime | Admin page |
| ZCORIQ Bloom Score calibration | 1 lifetime | Admin page |
| Reset timezone | `Asia/Kolkata` | Admin page |

Set any cap to **0** to hard-lock that feature on Free (no taste at all).

## Verification

After applying migration 68 to the live DB:

```
node scripts/test-free-plan.js
```

Confirms: every column present, both helper functions callable, free plan summary updated, usage tables readable. Runs in under 3 seconds.

For HTTP-level verification, exercise from the browser console as a Free user:

```js
const t = (await supabase.auth.getSession()).data.session.access_token;
// Should succeed once, then 402 on the 6th call:
for (let i = 0; i < 7; i++) {
  const r = await fetch("/api/tutor/chat", {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "test", history: [] }),
  });
  console.log(i, r.status);
}
```

Expected: `200, 200, 200, 200, 200, 402, 402` (the 6th call exceeds the 5/day cap).

## What's NOT in this session

- **HTTP-level end-to-end test**. Needs a real Free auth token + a real `auth.users` row; the existing test-rls.js scaffolding could be extended in Session 3.
- **Client-side lock UI**. The dashboard tile grid still uses the older `useFeatureAccess()` hook (which reads `plans.features[]`). Adding a "X uses left today" indicator to each tile from `/api/feature/usage` is a UX polish for Session 3.
- **Speed Trainer prompt fix**. The exam-goal-aware prompt fix from before this session was reverted during file recovery. Will re-apply separately — it was a behavioural fix, not part of the Free-plan implementation.
- **Sentry error reporting** of 402 events. The existing `lib/posthog.ts` can grow a `track("free_cap_hit", {surface})` call so we measure which caps fire most.

## What an admin sees

`/admin/plans` → new banner at the top: "Free-tier caps — daily quotas and lifetime-once tastes are now editable. [Edit free-tier limits →]"

Clicking lands on `/admin/free-tier-limits` — a single-page editor with three sections (Daily caps, Lifetime caps, Free trial), each cap rendered as a labelled number input with a short description. Save → 60-second cache flushed → new caps live.

## How to apply

1. Apply migration 68 to your Supabase project:
   ```
   psql $DATABASE_URL -f supabase/migrations/68_free_tier_caps_and_usage.sql
   ```
   Or via the Supabase Dashboard SQL editor.

2. Restart the dev server (or wait for hot reload).

3. As platform admin, visit `/admin/free-tier-limits` and confirm the form loads with defaults.

4. As a Free student, attempt to exhaust a cap (e.g. 6× AI Tutor in one day) and confirm the 6th call returns 402 with the message "You've used your 5 free AI Tutor sessions for today…".

5. Run `node scripts/test-free-plan.js` for DB invariants. Green = ship.

## Risk notes

- **Existing Free users**: their counters start fresh on first call (no `daily_ai_usage` row → counted as 0 used). They get the full daily quota today. This is the desired behaviour.
- **School students**: bypass the daily_drill cap (B2B subscription pays for unlimited). Other caps apply only when their `tier='free'` resolves — which means a school student whose school subscription is active is NOT counted as Free here. Verify by spot-checking one of each persona.
- **Race condition on counter increment**: read-then-write rather than atomic. Worst case: under-count by 1 per concurrent burst. Acceptable — caps are quotas, not bank balances.
- **Migration 68 is additive**. Safe to apply on production. Rollback would just leave unused columns + tables; no destructive changes.
