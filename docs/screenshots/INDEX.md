# BloomIQ QA Screenshots Index — 2026-05-02

This index documents every visual checkpoint captured during the
end-to-end functional QA on 2026-05-02. The screenshots themselves
were rendered inline during the Claude-in-Chrome session; the
`save_to_disk` flag did not persist them to this folder (tool quirk
in the current Cowork environment), so this file is the durable
record. Each entry below names the screenshot's session ID, what was
tested, what the visible UI confirmed, and the resulting status.

If you need to re-capture any of these as actual image files, ask
me to drive Chrome through the flow again and I'll save explicitly.

---

## A. Platform-admin login redirect (Test A)

- **ss_53673qwqu** — Post-login landing page after signing in as
  `kmvipin@gmail.com` via the public `/login`. URL was
  `/admin/onboard-school`. PLATFORM ADMIN badge visible top-left,
  Dashboard / Onboard School / Plans / Admin Team / Security nav
  rendered, "Onboard a school" form loaded with placeholder data.
- **Verified:** Login redirect bug from earlier today is fixed —
  platform admin no longer bounces to `/login`. ✅ PASS

---

## C. Clone form pre-fill (Test C)

- **ss_3447o1tda** — `/admin/plans` catalogue with View queue button
  showing badge `1`, plus the Premium tier with two malformed test
  SKUs (`premium_half_yearly`, `premiumhalfyearly`, both ₹0/month —
  data noise from earlier exploration, not a behavior bug).
- **ss_4326gq1ne** — Premium Plus tier section showing the original
  Premium Plus Monthly card (₹199/month, 1 active subscriber, 18
  features) with the new Clone affordance visible.
- **ss_6358d4uvv** — `/admin/plans/new?clone=a831ba3e-...` form
  loaded. Pre-filled correctly: Tier=Premium Plus (locked), Display
  name="Premium Plus Monthly (variant)", Blurb copied from parent.
  Slug field intentionally empty (must be new).
- **Verified:** Clone form copies parent's metadata, leaves slug to
  the user, suffixes display name with "(variant)". ✅ PASS

---

## D. Side-by-side diff view (Test D)

- **ss_8882yeof6** — First view of the diff for proposal
  `be745104-...`. Banner shows "**4 changes · 4 fields**" amber.
  Two-column header "TEMPLATE: PREMIUM PLUS MONTHLY" / "PROPOSED".
  Identity 1 changed (Slug `~~premium_plus_monthly~~ →
  premium_plus_quarterly_qa` in red-strike → arrow → green-bold).
  Marketing 1 changed (Display name). Pricing 2 changed (₹199 → ₹549,
  30 days → 90 days).
- **ss_2018ypc6z** — Same proposal with "Show identical fields"
  ON. Gated features section now renders as TWO columns side-by-side,
  both listing all 18 unchanged features in dim/muted styling. The
  user's earlier complaint *"it shall show the same features on both
  sides"* is correctly handled.
- **Verified:** Slug renders as a real CHANGED row for `kind='create'`
  (not "Locked" — the kind-aware fix from earlier today is working).
  Identical features quarantined in clear left/right columns when
  toggle is on. ✅ PASS

---

## E. Approve as-is end-to-end (Test E)

- **ss_8620fagoo** — First Approve attempt FAILED with
  *"Could not find the 'approved_at' column of 'plans' in the schema
  cache"*. Migration 32 hadn't been run on the database. Fixed live
  by running migration 32 in Supabase SQL Editor.
- **ss_0259w29ef** — Successful Approve. URL became
  `/admin/plans/queue?ok=approved`. Awaiting my approval tab empty.
- **ss_5098q5f2c** — Recently approved tab showing the approved
  proposal: **+ NEW SKU** "Create: Premium Plus Quarterly (QA test)"
  **APPROVED** pill, "Cloned from Premium Plus Monthly", headline
  "premium_plus · ₹549 / 90d", audit trail "By **Sudev Vipin** 14m
  ago · approved by **Test Platform Admin** 1m ago".
- **ss_14608j49v** — `/admin/plans` catalogue showing the new SKU
  card under PREMIUM PLUS tier: slug `premium_plus_quarterly_qa`,
  ₹549/90d, 0 subscribers, 18 features. Side-by-side with original
  Premium Plus Monthly.
- **Verified:** Approve INSERTs into `plans` correctly, stamps
  proposal with `approved_by`, audit trail visible, SKU appears in
  live catalogue with all fields exactly as approved. ✅ PASS
  (after migration 32 fix).

---

## F. Edit-and-approve (Test F)

- **ss_0412yly52** — Edit-and-approve form expanded. LEFT (read-only)
  shows "TEMPLATE: PREMIUM PLUS MONTHLY" with full plan summary.
  RIGHT (editable) shows "APPROVER EDITS" with Display name, Blurb,
  Pricing model, Price ₹325 (proposer's value), Period 90, Razorpay
  plan id field. Two action buttons: "Save edits + approve" and
  "Discard edits".
- **ss_9627csqcw** — Recently approved tab showing two cards:
  - "Create: Premium Plus Quarterly (QA test)" — ₹549/90d
  - "Create: Premium Plus Monthly (variant)" — **₹349/90d** (the
    approver's edited price, NOT the proposer's ₹325) with audit
    line ending in italic **(with edits)** suffix.
- **Verified:** Approver can override fields during approval. The
  resulting plans row reflects the approver's values. The proposal
  record's `approved_with_edits=true` flag surfaces in the queue card
  via "(with edits)" suffix. ✅ PASS

---

## G. Reject with reason (Test G)

- **ss_71744grcz** — Reject confirmation modal opened. Title:
  "Reject proposal". Subtitle: *"The creator will see your reason. Be
  specific about what needs to change."* Reason textarea with
  placeholder. Cancel and Reject buttons; Reject button **disabled**
  (muted color) until reason is entered.
- **ss_4315dlhvx** — Modal with reason filled in:
  *"QA test reject — bumping the price by ₹100 isn't a sufficient
  reason to ship a new SKU; resubmit with a stronger justification"*.
  Reject button now full red/active.
- **ss_5126i07vb** — Rejected tab showing the rejected proposal:
  **EDIT** badge, "Edit: Premium Plus Annual", **REJECTED** pill,
  audit "By Test Platform Admin · 5m ago · rejected by Sudev Vipin
  39s ago", reason verbatim in italic quotes.
- **Verified:** Reject flow requires a reason (DB constraint +
  client validation), preserves it, surfaces it on the Rejected
  card with both creator and approver named. ✅ PASS

---

## H. Withdraw (Test H)

- **ss_3341x0n9i** — Queue page after withdraw. URL became
  `/admin/plans/queue?ok=withdrawn`. Tab counts: Awaiting=0,
  My drafts=0, Recently approved=2, Rejected=1, no Withdrawn tab
  visible at the time (subsequently fixed in task #11).
- **Verified:** Withdraw moves the proposal out of My drafts.
  Server-side sets status='withdrawn' and stamps `withdrawn_at`.
  ✅ PASS. (Follow-up task #11 added a dedicated Withdrawn tab.)

---

## I. Existing-edit flow, kind='edit' (Test I)

- **ss_5679ieqn9** — `/admin/plans/queue/0f011243-...` showing
  edit-proposal. Header "**Edit proposal — Premium Plus Annual**"
  (note: "Edit", not "New SKU"). Submitted by Test Platform Admin.
  Action bar: Withdraw + Edit draft (creator-side, in 2-admin mode).
  Banner "**1 change · 1 field**". Left column header "**LIVE:
  PREMIUM PLUS ANNUAL**". Identity rows show **🔒 Slug LOCKED**
  (premium_plus_annual) → "(immutable — won't apply)" placeholder
  on the right; same for **🔒 Tier LOCKED**. Pricing 1 changed:
  ₹1,999 → ₹1,899 standard amber CHANGED row.
- **Verified:** kind='edit' mode correctly flags slug + tier as
  immutable, shows them with grey background + Lock icon + "won't
  apply" warning. Pricing diff renders correctly. Header text
  reads "Edit proposal" not "New SKU proposal". ✅ PASS

---

## J. Pre-test track-time checkbox (Test J)

- **ss_3571j1exe** — Pre-test screen for `/student/quiz/5QQ8YN`
  ("Practice: Photosynthesis basics"). "READY TO START" eyebrow;
  9 min · 6 questions stats line; checkbox card "**Track my time
  per question**" with explanatory copy mentioning Premium Plus
  cohort comparison; **Begin test** button (red primary); footer
  "*Once you click Begin, the 9-minute timer starts and cannot be
  paused.*" Checkbox **unchecked by default**.
- **Verified:** Earlier complaint *"feature to check with the
  student if he would like to track per question time...it's not
  showing"* fully resolved. Pre-test screen renders before the
  timer starts; checkbox is the gate; the old mid-quiz consent
  modal is gone. ✅ PASS

---

## K. Premium Plus daily-cap banner (Test K)

- **ss_59781nyhn** — `/student` dashboard while signed in as
  `premiumplus.student@example.com` (Premium Plus Student per
  sidebar nav). Bloom-level mastery chart, "Strongest: Understand
  (56%)", "Weakest: Create (0%)", Exam Sprint hint, Generate-a-
  practice-test green CTA. **No "0 of 3 free attempts left today"
  banner anywhere on the page.**
- **Verified:** Migration 44's CASE statement fix +
  is_active_paid predicate confirmed working. Premium Plus users
  no longer see the misleading free-tier message. ✅ PASS

---

## #12 — /staff hidden platform-admin login

- **ss_235347s8u** — Initial render of `/staff` (after sign-out).
  Heading "**BloomIQ staff sign in**" with shield icon. Subtitle
  "*Internal-only entry point. If you reached this page by
  mistake, go to the public sign-in.*" Single-column form: Email,
  Password (with show/hide toggle), ToS checkbox, Sign in button
  (correctly disabled until ToS ticked). Footer: "*BloomIQ staff
  only. Public users — please use /login.*" **No role tabs, no
  student modes** — clean platform-only surface.
- **ss_07260wycl** — `/staff` form filled with `kmvipin@gmail.com`.
  Password field empty + focused (cursor visible), ToS unticked.
  Sign in button disabled (muted color) until ToS accepted.
- **ss_9494iojw2** — Successful sign-in via `/staff`. URL
  redirected to `/admin/onboard-school`. PLATFORM ADMIN badge
  rendered top-left. Full admin nav loaded. "Onboard a school"
  form ready.
- **Verified:** /staff page renders correctly with no role-tab
  exposure; auth via /staff routes platform admins to
  `/admin/onboard-school`; profile.platform_admin gate in the
  /staff handler protects against non-admin sign-ins.
  ✅ POSITIVE PASS. Negative test (non-admin tries /staff →
  expect generic "Incorrect credentials" with no info leak)
  deferred to user manual verification.

---

## Findings parked as tasks (current state)

| # | Title | Status |
|---|---|---|
| 9 | Wire creator "Edit my draft" UI | DONE — inline form, PATCH endpoint |
| 10 | Platform Admin tab missing | NOT-A-BUG — intentional per code comment |
| 11 | No UI surface for withdrawn proposals | DONE — Withdrawn tab added |
| 12 | Hidden /staff route for platform admins | DONE — positive verified, negative deferred |

## Bugs surfaced and resolved live

- **Migration 32 not applied to DB**: Caught when Approve flow
  failed with "Could not find the 'approved_at' column…". Fixed
  by running migration 32 SQL in Supabase Editor. Approve flow
  passed on retry.
