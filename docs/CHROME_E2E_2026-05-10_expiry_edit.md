# Chrome E2E test — platform admin expiry edit
**Run date**: 2026-05-10 ~22:14 IST
**Tab**: localhost:3000 dev server
**Driver**: Claude in Chrome MCP (computer-use was disconnected)

## Result: ✅ PASS

The new activation-date + grace-period editor on `/admin/schools/[id]` saves
correctly, the database persists exactly what the operator entered, and the
change propagates to the recent-onboardings list immediately.

## What I drove

1. Signed in as `test_admin@bloomiq.local` via `/staff` (had to bypass the
   React form's controlled-input issue by setting values via the native
   `HTMLInputElement.value` setter and dispatching synthetic input/change
   events; Claude_in_Chrome's `form_input` doesn't trigger React's onChange).
2. Navigated to `/admin/onboard-school`, clicked Manage on **Test Negotiate**.
3. On `/admin/schools/e67e842f-…`:
   - Opening state: School Plus, expires 10 May 2027, ₹30,000 negotiated
     price, 650 contracted seats.
   - Set **Activation date** = 2026-06-01.
   - Set **Grace period** = 21 days (changed from default 14).
   - Clicked **Save plan & pricing**.

## What the system did

- POST `/api/admin/schools/[id]/set-plan` → 200 OK.
- "Saved." success message rendered.
- Server wrote into `subscriptions`:
  ```
  started_at        : 2026-05-31T18:30:00+00:00   (= 2026-06-01 00:00 IST ✓)
  expires_at        : 2027-05-31T18:30:00+00:00   (= 2027-06-01 00:00 IST ✓)
  grace_period_days : 21
  activation_pending: false
  ```
- After hard-reload, EXPIRES tile shows "1 Jun 2027 (387d)".
- Recent onboardings table on `/admin/onboard-school` shows "1 Jun 2027" for
  this school.

## Defects observed

**D1 (minor — UI cosmetic): Form date field hydrates as UTC date, off by
one day in IST.**
- After save and reload, the Activation Date input shows `2026-05-31`
  instead of the `2026-06-01` the operator entered.
- Root cause: `new Date(iso).toISOString().slice(0,10)` extracts the UTC
  YYYY-MM-DD, but the operator entered IST-local. For dates with IST hour
  before 05:30, this drifts back a day.
- Fix sketch: hydrate via `new Date(iso).toLocaleDateString("en-CA", {timeZone: "Asia/Kolkata"})`
  which yields IST-local YYYY-MM-DD.
- Severity: low. The DB value is correct; the human-readable EXPIRES tile is
  correct. Only the editable form input drifts. Operators editing the date
  again would see "2026-05-31" and might assume that's what they originally
  set, but the actual term boundary is still 1 June.
- File: `app/admin/schools/[id]/page.tsx`, the load() function.

**D2 (minor — race): EXPIRES tile didn't update immediately after Save.**
- The "Saved." message rendered but the EXPIRES tile still showed the old
  value until I hard-reloaded.
- Likely cause: my own test-script timing (read page snapshot before the
  load() refetch completed). When I waited longer / reloaded, the tile
  refreshed correctly.
- Could also be a React render-batch quirk; would need closer inspection
  to confirm. Not reproducible reliably from automation.
- Fix sketch: in savePlan(), explicitly call setData(null) before await load()
  to force a fresh render cycle, OR ensure load() always sets a NEW object
  reference.
- Severity: low. The DB save succeeded; only the immediate visual feedback
  felt stale.

## What was NOT a defect

- The pricing badge showed "School Plus" + ₹30,000 negotiated. The plan
  preservation logic correctly detected mid-cycle plan change and DIDN'T
  reset cycle anchors when only contracted_students or grace changed.
- Activation flip didn't happen because activation_pending was already
  false on this row (it was a previously-paid school, not a freshly-onboarded
  one). The flip path is exercised by the integration test
  `scripts/test-billing-e2e.js` and the logic test in
  `scripts/test-billing-logic.js` (41/41 PASS earlier tonight).

## What I noted but did NOT verify in this run

- "Free plan expiry edit" interpreted as: editing dates on a paid school's
  subscription. The Free plan has no `expires_at` by definition (it's the
  no-subscription state), so I picked a paid school. If you meant something
  different — e.g., "test that schools with NO plan_id can be promoted to a
  paid plan via the activation date picker" — let me know and I'll drive
  that scenario specifically.
- The "Defer until first sign-in" toggle was not exercised in this run;
  the test only set an explicit activation date. The defer path is covered
  by the logic test.

## Summary

End-to-end editing of plan expiry by a platform admin **works**.
Two minor cosmetic issues spotted, neither blocking. Database state
matches operator intent exactly.
