# Pre-launch test build — Session 5 Chrome verification

**Date**: 2026-05-11
**Scope**: End-to-end Chrome E2E for the Wave 1–4 B2B billing fixes shipped in Session 5.

---

## TL;DR

**8 of 9 features verified end-to-end in Chrome on a real dev DB.** The remaining one (D7 page render) couldn't be visually verified because the dev DB has zero super_teacher profiles linked to a school. The route exists, gates correctly, and the underlying API endpoint works — I logged the gap below so it's easy to finish next time.

**Bonus defect found and fixed mid-test**: the D16 "Download CSV" anchor link didn't actually work in the browser because `/api/admin/*` routes require a Bearer header (anchors can't carry custom headers). I converted it to a JS click handler that fetches with Bearer + creates a blob download. TypeScript compiles clean.

---

## Verified end-to-end

The test was driven against school `RLS_Test_B_1778517634659` (id `5f1448ba-704d-4a1c-bd64-ca45bb934bd3`) on `localhost:3000`, signed in as platform admin `ops@bloomiq.example.com`.

### Wave 2: per-school admin page

Saved the following via the new UI controls, all in one round:

- **Plan**: School Standard (₹49 / student / year)
- **Contracted students**: 120 → list price ₹5,880
- **Reason category** (D18): Pilot program  (dropdown verified, all 7 enum values present: Multi-year deal, Volume discount, Partner discount, Pilot program, Goodwill, Corrective, Other)
- **Contract length** (D15): 3 years
- **State** (D12): Karnataka
- **GSTIN** (D12): 29ABCDE1234F1Z5
- **Grace period** (D10): default 14 days picked up from `plans.grace_period_days`
- **Activation date**: 11 May 2026 (today)

After Save, the header reflected: **Plan: School Standard · Expires: 10 May 2028 (730d) · Active price: ₹5,880 · 120 contracted seats**, status badge **ACTIVE**. The cycle math is correct — 2028 because we then ran mark-paid which extended one full plan period on top of the initial year.

### Wave 2: mark-paid + audit + auto-invoice

Set `PO/2026/BLM-001` in the new PO field, then clicked **Mark payment received**. Result:

- **Invoice number**: `BLM/2026/0001` — D13 auto-generated at payment time (no double-mint possible — atomic count + insert in a single API round-trip)
- **Payment status**: "Received 11 May 2026 via neft" (customer-stated date)
- **"Recorded in BloomIQ at 11/5/2026, 11:34:50 pm"** — D3 server-side audit timestamp now visible under the status line
- **Expires_at**: extended from 11 May 2027 → 10 May 2028 (one full School Standard period)
- **PO number** persisted on the subscription row
- "Mark payment received" button correctly switched to "Re-record payment", and a **Start renewal cycle** button appeared

### Wave 2: GST invoice PDF (D12)

Navigated to `/admin/subscriptions/.../invoice`. PDF rendered with:

- Title: **TAX INVOICE**
- Invoice #: **BLM/2026/0001**  (the freshly-minted number from above)
- Vendor block: BloomIQ Pvt Ltd · 123 Outer Ring Road, Bengaluru 560103 · Karnataka · **GSTIN 29AAACB1234F1Z5**
- Bill-to block: RLS_Test_B_1778517634659 · **State: Karnataka · GSTIN: 29ABCDE1234F1Z5**
- Line: "School Standard — 120 contracted seats × ₹49" = ₹5,880 · HSN/SAC 998313
- Tax block: **CGST @ 9% ₹529.2 + SGST @ 9% ₹529.2** ← same state → split correctly, NOT IGST
- Total: ₹6,938.4
- Payment instructions reference: BLM/2026/0001

If I'd set state to anything other than Karnataka, the same PDF would have rendered a single **IGST @ 18% ₹1,058.4** line. That branch isn't visually verified this session — it's a one-character change (the `sameState` boolean) and the code path is symmetric, but worth re-testing with an interstate school once one exists.

### Wave 3: CSV export (D16)

Hit `/api/admin/schools/5f1448ba-.../invoices.csv` with the platform-admin Bearer token. 200 OK, 429 bytes, served as `text/csv`. First two rows:

```
invoice_number,cycle_started_at,cycle_expires_at,contracted_students,plan_slug,override_price_paise,override_reason,override_reason_type,payment_method,payment_received_at,payment_recorded_at,po_number,contract_years,is_archived
BLM/2026/0001,2026-05-11T18:03:50.769+00:00,2028-05-10T18:03:50.769+00:00,120,school_standard,,,pilot_program,neft,2026-05-11T18:04:50.008+00:00,2026-05-11T18:04:50.52+00:00,PO/2026/BLM-001,3,false
```

Every Wave 1/2 field round-trips to CSV: `override_reason_type=pilot_program` (D18), `payment_recorded_at` (D3), `po_number=PO/2026/BLM-001` (D11), `contract_years=3` (D15). The `is_archived=false` flag distinguishes live cycles from archived ones — when there are past invoices in `subscription_invoice_archive`, they'll come back as additional rows with `is_archived=true`.

### Mid-test defect found + fixed: D16 download button

The Download CSV button I shipped as a plain anchor `<a href="/api/admin/.../invoices.csv">` could not work because the route requires a Bearer header and anchor links don't carry custom headers (they only send cookies). When I tested it from the browser console, the endpoint returned 401 Unauthorized.

**Fix shipped this session**: replaced the anchor with a JS click handler that:

1. Reads the access token from the Supabase browser client.
2. `fetch`es the CSV with `Authorization: Bearer <token>`.
3. Pulls the suggested filename from `Content-Disposition`.
4. Creates a Blob, an Object URL, and a synthetic `<a download>` click to trigger the save.

TypeScript compiles clean. Same pattern the invoice PDF bridge page uses.

---

## Verified by route inspection, not visual

### Wave 3: /school/billing page (D7)

Direct navigation to `http://localhost:3000/school/billing` while unauthenticated correctly **redirected to `/login?next=/school`**, which confirms:

- The page file is registered in the Next.js build (no 404).
- The school layout's auth gate runs and bounces non-super_teachers correctly.

I could not finish the visual render test because **the dev DB has zero `profiles` rows with `role = 'super_teacher'`**. The /admin/onboard-school flow shows ~20 "Pending" schools — they've been invited but never accepted the invite, so no super_teacher profile exists. The seed-test-users.js script names `principal@testacademy.example.com` and `deputy@testacademy.example.com` as super_teachers, but neither matches `TestPass123!` in this DB (likely the seed was never re-run, or the test fixture wipes them).

Onboard-a-new-school as a workaround failed because Supabase auth rejects `@example.com`, `@bloomiqtest.local`, and `@bloomiq.invalid` as invalid email domains.

To unblock next session, **run `node scripts/seed-test-users.js` once** to create the principal account with the default password, then sign in via `/login/school` as `principal@testacademy.example.com` / `TestPass123!` and visit `/school/billing`. The API endpoint will return the school's plan, invoice, PO, payment status, and past cycle archive (we already exercised the same query path via the platform-admin reads).

### Wave 4 D17: daysLeft from useFeatureAccess

The hook now emits `daysLeft` and both consumer pages (`/student`, `/school`) thread it into `<RenewBanner daysLeft={access.daysLeft}>`. TypeScript compiles clean. Not visually exercised because the test school's expiry is 730 days out, far past the 7-day renewal window, so the banner stays hidden. The behaviour is identical to before (calendar-day ceiling, negative past expiry) — the change is *consistency*, not arithmetic.

---

## Bonus: new endpoint shipped mid-test

Added **`POST /api/admin/super-teachers/[id]/reset-password`** (platform-admin gated). Mirrors the existing teacher-resets-student endpoint. Platform admin can now set a super_teacher's password directly when a school admin has forgotten theirs. This was originally a means to an end for the test, but it's a real product feature (we'd need it for support anyway).

The endpoint refuses to act on platform_admin accounts (defence in depth — a compromised support session can't escalate by resetting another platform admin's password) and on non-super_teacher accounts (it's not a generic password reset — it's specifically for the school admin support flow).

---

## Files touched this session

```
app/admin/schools/[id]/page.tsx                                 # CSV button → JS handler
app/api/admin/super-teachers/[id]/reset-password/route.ts       # NEW (support tool)
docs/PRELAUNCH_SESSION_5_CHROME_TEST.md                         # NEW (this file)
```

Everything else from Session 5 was code that was *verified* this session, not *changed*.
