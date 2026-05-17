# Razorpay Webhook + Checkout Security Audit
**Date:** 2026-05-17
**File audited:** `app/api/razorpay/webhook/route.ts`
**Auditor:** Claude (Senior Production Support Engineer hat)

## Verdict: Well-implemented for the common case. No CRITICAL vulnerability found.

The critical security primitives are correctly in place:
- HMAC-SHA256 signature verification with timing-safe comparison (line 70-76)
- Idempotency via unique partial index on `razorpay_payment_id` (migration 68)
- Amount-mismatch detection (line 153-165) — refuses if captured amount ≠ plan price
- Event filtering — only acts on `payment.captured` / `order.paid` (line 86)
- Race-safe DB insert that swallows unique-violation 23505 (line 213)
- `school_id` explicitly nulled on B2C subscription path (line 194, 203)

## Findings

### R1 — `started_at` bumped to today on every renewal UPDATE
**Severity:** 🟡 Medium (data integrity)
**Location:** Line 191
**Issue:** Even on a renewal that preserves unused-days from prior cycle (`expires_at = max(today, old_expires) + period_days`), `started_at` is reset to today. Result: queries computing `(expires_at - started_at)` will return >365 days for a renewal that preserves 60 unused days. Audit reports / cohort analytics may misread this.
**Fix:** On UPDATE branch, preserve `started_at` unless plan changed. OR introduce a separate `current_cycle_started_at` column.

### R2 — `notes.user_id` trusted without cross-verification
**Severity:** 🟢 Low (mitigated)
**Location:** Line 113-118
**Issue:** Webhook trusts `notes.user_id` to identify the subscriber. Mitigated because notes are set server-side at `/api/checkout` order creation, and signature verification proves the webhook came from Razorpay. But there's no second-source verification (e.g., an `orders` table storing user_id at order time, cross-checked at webhook time).
**Theoretical attack:** None practical — would require both forging signature AND injecting notes. Both blocked.
**Fix (defense in depth):** Maintain `razorpay_orders` table with `(order_id, user_id)` at /api/checkout time; verify match here.

### R3 — Plan not re-validated as active at webhook time
**Severity:** 🟡 Medium
**Location:** Line 137-151
**Issue:** Webhook resolves the plan by `notes.plan_id` / `notes.plan_slug` but doesn't check `plans.is_active` (or equivalent). If a plan is deactivated between order placement and payment capture, the subscription is granted anyway.
**Fix:** Add `.eq("is_active", true)` to the plan lookup, OR check after fetch and reject with structured "plan no longer active — refund issued" code.

### R4 — Webhook secret missing returns 503 silently
**Severity:** 🟡 Medium (operational)
**Location:** Line 64-67
**Issue:** If `RAZORPAY_WEBHOOK_SECRET` is not configured (e.g., env var lost during deploy), every webhook returns 503. Razorpay will retry but webhooks pile up unbounded. No alert fires.
**Fix:** Log to error monitoring (Sentry) on first 503; emit Slack alert.

### R5 — No webhook event audit log
**Severity:** 🟡 Medium (debuggability)
**Issue:** When a payment goes wrong, there's no record of what Razorpay sent.
**Fix:** Insert into a `razorpay_webhooks_received` table at handler entry — `(received_at, event, signature_valid, payment_id, raw_body)`. RLS service-role-only.

### R6 — Webhook endpoint has no rate limiting
**Severity:** 🟢 Low
**Issue:** Attacker can DOS by hammering signature-failing webhooks (each costs an HMAC). Razorpay-only callers in practice — add WAF rule for `/api/razorpay/webhook` source IP allowlist if going to scale.
**Fix:** Cloudflare / Vercel rate limit by IP.

### R7 — Signature mismatch returns 400, not 401
**Severity:** 🟢 Low
**Issue:** Cosmetic. Razorpay won't retry 4xx so 400 is functionally correct.
**Fix:** Optional — 401 is more semantically correct.

### R8 — Multi-tab race between browser /verify and webhook
**Severity:** 🟢 Resolved
**Note:** Comment "Ignore unique-violation: the browser verify path landed first" (line 212) demonstrates the race is understood and handled by the unique partial index. Verified safe.

## Defense-in-depth checklist

- [x] HMAC signature verification (timing-safe)
- [x] Idempotency via unique partial index on payment_id
- [x] Event type allowlist
- [x] Amount mismatch detection
- [x] school_id nulled for B2C
- [ ] Plan still-active check at webhook time (R3)
- [ ] Webhook event audit log (R5)
- [ ] Orders table cross-verification (R2 defense-in-depth)
- [ ] Sentry alert on missing webhook secret (R4)
- [ ] Rate limit / IP allowlist (R6)

## Summary

**Pre-launch must-fix:** R3 (plan active check), R4 (alerting on missing secret), R5 (audit log).
**Post-launch nice-to-have:** R2 (orders table), R6 (rate limit), R7 (status code).
**Cosmetic:** R1 (started_at semantics — document the renewal behavior in audit reports).

No vulnerability allows forged subscriptions, double-spend, or wrong-amount activation. The webhook is production-acceptable for soft launch; the medium-severity findings should be addressed within first 2-3 weeks of accepting real customer payments.
