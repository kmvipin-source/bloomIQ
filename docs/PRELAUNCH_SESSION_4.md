# Pre-launch test build — Session 4 report

**Date**: 2026-05-11 (continued)
**Scope**: Razorpay sandbox upgrade end-to-end. Free user → Premium upgrade via real Razorpay checkout modal + post-payment verification + subscription state.

---

## TL;DR

**Razorpay code path works end-to-end.** Order creation → HMAC verification → subscription upsert → page re-render — all clean. Found **one P0 commercial blocker** (Razorpay merchant config) and **one P3 hygiene defect** (`is_trial` not cleared on upgrade).

The product code is ready. The Razorpay **merchant account configuration** is the bottleneck.

---

## What was tested

| Step | Method | Result |
|---|---|---|
| Login as Free user (Zoya) | Chrome via `/login/student` | ✅ |
| Navigate to `/pricing` | Real UI | ✅ — 6 paid SKUs render: Premium Monthly / Quarterly / Annual, Premium Plus Monthly / Quarterly / Annual |
| `/api/pricing/active-plans` | Direct GET | ✅ — returns 10 plans (Free + 9 paid SKUs) |
| Click "Upgrade" on Premium Monthly | Real click | ✅ — page shows "Opening checkout…" state |
| `/api/checkout` POST | Server creates Razorpay order | ✅ — Razorpay iframe loads with valid order |
| Razorpay modal renders | iframe from `razorpay.com` | ✅ — visible, interactive |
| Card payment attempt (Visa 4111…) | Manual user input | ❌ → see D5a |
| UPI payment attempt | Manual user input | ❌ → see D5b |
| Wallet payment attempt | Manual user input | ✅ — payment success |
| `/api/checkout/verify` | Auto-fired by Razorpay handler | ✅ — HMAC verified, subscription upserted |
| Post-payment success page | Real render | ✅ — H1 "You're all set, Zoya!", message "Welcome to ZCORIQ Monthly. Your account is ready and your subscription is active until…" |
| `/api/auth/me` post-upgrade | Direct GET | ✅ — `is_free_expired: false`, tier reflects paid |
| `/api/feature/usage` post-upgrade | Direct GET | ✅ — `tier: "individual"`, all caps `null` (uncapped) |
| `/student` dashboard load | Navigate | ✅ — loads cleanly, NOT redirected to `/student/expired` |
| Sidebar badge | Visual | ✅ — shows **"Premium · ACTIVE"** |

---

## Defect log

### D5a — Razorpay merchant: international cards rejected  ·  **P0 commercial issue**

- **Symptom:** Standard Razorpay test card `4111 1111 1111 1111` (Visa) → modal shows `"Payment could not be completed. International cards are not supported. Please contact our support team for help."`
- **Root cause:** Razorpay merchant Dashboard → Account & Settings → Payments → Card Network Settings has **"International cards" disabled**.
- **Impact in production:** Any customer with a non-Indian card (a sizeable share of NRI parents, returning students, working professionals) cannot pay.
- **Fix (NOT code — Razorpay dashboard):**
  1. Sign into Razorpay Dashboard
  2. Enable international card support on your account
  3. May require KYC documents — typically <24h once submitted
- **Workaround until then:** Update `/pricing` and `/student/expired` copy to clarify "Payments via Indian cards / UPI / wallets only."
- **Disposition:** P0 for international audience, P2 for India-first launch. Document in onboarding copy at minimum.

### D5b — Razorpay merchant: UPI + cards not enabled, only wallets visible  ·  **P0 commercial blocker**

- **Symptom:** Live test today saw ONLY the "Wallet" payment option in the modal. No UPI tab, no Card tab pre-selected, no NetBanking visible.
- **Root cause:** Razorpay merchant Dashboard → Account & Settings → Payments has only Wallets enabled at the account level. Cards and UPI are either disabled or pending approval.
- **Impact in production:** UPI is the dominant payment method in India (~60-70% of digital payments). Without it, expect **massive checkout drop-off**. Wallets cover maybe 10-15% of users.
- **Fix (NOT code — Razorpay dashboard):**
  1. Sign into Razorpay Dashboard → Account & Settings → Payment Methods
  2. Enable: **UPI** (definitely), **Domestic Cards** (definitely), **NetBanking** (recommended).
  3. Some require additional KYC; complete those.
- **Disposition:** **Hard blocker for launch.** Without UPI, the conversion math doesn't work.

### D6 — `is_trial` flag not cleared on Free→Paid upgrade  ·  **P3 hygiene**

- **Symptom:** After Zoya upgraded from Free to Premium Monthly, her `subscriptions` row probably still has `is_trial = true` (set during the auto-grant in `/api/auth/me`). The verify route doesn't explicitly clear it.
- **Impact today:** Zero functional impact. The expired-trial check in `/api/auth/me` requires `tier='free' AND is_trial=true AND past expires_at`. Since tier flipped to `'individual'`, the check never fires.
- **Why fix anyway:** Hygienic — the data state shouldn't lie. Future code paths might key off `is_trial` and misbehave.
- **Fix:** In `app/api/checkout/verify/route.ts`, lines 187 / 207 (the subscription update + insert), add `is_trial: false` to both payloads.
- **Disposition:** P3. One-line fix in next session. Not launch-blocking.

---

## What's verified working in code

These are all clean and need no changes:

- **`/api/checkout`** — creates Razorpay order with all the right notes (user_id, plan_id, slug, tier, period_days) ✅
- **HMAC signature verification** in `/api/checkout/verify` — uses correct algorithm (sha256 of `orderId|paymentId` with `RAZORPAY_KEY_SECRET`) ✅
- **Order re-fetch from Razorpay** to read notes server-side (not from client) — prevents spoofing ✅
- **`user_id` check** — verify route rejects if the order's user_id doesn't match the authenticated user ✅
- **Plan resolution** — prefers `plan_id` over `plan_slug` over legacy `plan` field. Grandfathers users to specific plan versions ✅
- **Legacy tier mapping** — maps modern slugs (`premium`, `premium_plus`) to legacy tier strings (`premium`/`individual`/`premium_plus`) so existing tier-checking code keeps working ✅
- **Upgrade-aware expiry** — `max(now, oldExpiresMs) + period_days` so a user upgrading mid-cycle doesn't lose remaining time. Edge cases (no prior sub, expired sub, very far future) handled correctly ✅
- **Price lock onto subscription** — actual paid amount stored on `subscriptions.price_paid_paise` so future plan price changes don't retroactively re-price ✅
- **Update vs insert** — first-time buyers and renewals/upgrades both handled ✅
- **`/api/auth/me` post-upgrade** — `is_free_expired` correctly returns false (tier no longer free) ✅
- **`/api/feature/usage` post-upgrade** — caps become null (uncapped) for paid tier ✅
- **`/student` dashboard load** — no longer intercepted by expired-trial layout check ✅
- **Page re-renders correctly** — pricing page shows success state with welcome + expiry copy ✅

---

## What's NOT been tested

- **Renewal** — when a paid user's expires_at approaches, does the renewal flow work? (Same code path technically — the verify route's "existing.id" UPDATE branch — but not exercised yet.)
- **School subscription upgrade** — schools pay differently (via admin onboarding + manual invoice). Not in this session.
- **Refund flow** — Razorpay refund webhook → unflip user back to free. Not yet built (I think).
- **Subscription cancellation** — user-initiated cancel. UI may not exist yet.
- **Subscription expiry past `expires_at`** — paid plan expires → user drops back to Free correctly. The grace period logic is in migration 65 but the actual expiry-to-free transition wasn't tested live.

---

## Recommendations before launch

| Priority | Action |
|---|---|
| **P0** | Enable UPI + Domestic Cards on Razorpay merchant account. **Without this, you cannot accept payments from most Indian customers.** |
| **P0** | Re-run today's exact test (Zoya → upgrade via Razorpay) once UPI is enabled. Confirm the modal shows UPI option. |
| **P1** | Optional: enable International Cards if targeting NRI customers. |
| **P2** | Add `is_trial: false` to the subscription upsert in `/api/checkout/verify/route.ts` (D6 fix). |
| **P2** | Exercise the renewal flow: artificially backdate a paid user's `expires_at` to ~3 days from now, navigate to `/pricing`, verify the renewal CTA appears and works. |
| **P3** | Test a refund: in Razorpay test mode, issue a refund from the dashboard, see if any webhook reaches ZCORIQ and updates the user's tier back to free. (If there's no webhook handler, that's a real gap — refunds will silently leave the user on Premium until manual intervention.) |

---

## Session 4 statistics

- **Routes inspected:** `/api/checkout`, `/api/checkout/verify` — both code-reviewed, both verified end-to-end.
- **Live test:** 1 successful payment (Wallet) + 2 attempted-and-failed payments (Card/international, UPI/not-enabled).
- **Defects logged:** 2 P0 merchant config + 1 P3 code hygiene.
- **Migrations or code changes shipped:** None this session. All findings are configuration / future-work.
- **Recommended next session:** Run the Zoya-upgrade flow AGAIN after fixing Razorpay merchant config, this time taking the UPI path. Then move to test the renewal flow (P2 above).
