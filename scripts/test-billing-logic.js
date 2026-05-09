#!/usr/bin/env node
/**
 * test-billing-logic.js
 * ---------------------
 * Sandbox-runnable unit tests for the pure date / decision logic
 * shipped in migrations 62-65 + the set-plan / mark-paid endpoints.
 *
 * This file does NOT need network or a database. It re-implements the
 * algorithms as pure functions (mirroring the real endpoint code) and
 * asserts their outputs across every scenario I'm worried about:
 *
 *   - The four-case started_at/expires_at decision tree in set-plan
 *     (start_renewal, brand-new bind, mid-cycle plan change, plan removed)
 *   - mark-paid's three extend-anchor strategies (smart, previous_expiry,
 *     received_at) with both early- and late-renewal inputs
 *   - The grace-window math in useFeatureAccess (isExpired, isInGrace,
 *     graceRemainingDays) at every meaningful boundary
 *   - First-sign-in activation flip semantics
 *   - GST tax math on the invoice (₹14,500 × 18% IGST = ₹2,610 →
 *     ₹17,110 total) — caught a Math.round bug in an earlier attempt
 *   - BLM/YYYY/NNNN sequence padding (padStart to 4 digits)
 *
 * Run:    node scripts/test-billing-logic.js
 *
 * Exit codes:
 *   0  all pass
 *   1  one or more failures
 */

let pass = 0;
let fail = 0;
const failures = [];

function eq(label, got, want) {
  const okJson = JSON.stringify(got) === JSON.stringify(want);
  if (okJson) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    fail++;
    failures.push(`${label}\n      got : ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
    console.log(`  \x1b[31m✗\x1b[0m ${label}\n      got : ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
  }
}

function section(name) {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

const DAY = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────
// PURE LOGIC RE-IMPLEMENTATIONS
// (mirror the real endpoint code so divergence is caught by review)
// ─────────────────────────────────────────────────────────────────────

/**
 * Mirrors the started_at/expires_at decision tree from
 * app/api/admin/schools/[id]/set-plan/route.ts (post-migration-65).
 *
 * Returns { startedAt, expiresAt } as ISO strings (or nulls when the
 * plan is removed). `now` is injectable for deterministic tests.
 */
function decideExpiryAnchors({ existing, body, plan, now }) {
  const startedAtIso =
    typeof body.started_at === "string" && !Number.isNaN(Date.parse(body.started_at))
      ? new Date(body.started_at).toISOString()
      : null;

  if (!plan) {
    // Case D — no plan now.
    return { startedAt: null, expiresAt: null };
  }

  const isRenewal = body.start_renewal === true;
  const isMidCycle =
    !isRenewal &&
    !!existing?.expires_at &&
    !!existing?.plan_id;

  if (isMidCycle && !startedAtIso) {
    // Case C — preserve cycle anchors.
    return {
      startedAt: existing.started_at ?? new Date(now).toISOString(),
      expiresAt: existing.expires_at,
    };
  }

  // Cases A + B — fresh period.
  const anchor = startedAtIso ? Date.parse(startedAtIso) : now;
  return {
    startedAt: new Date(anchor).toISOString(),
    expiresAt: new Date(anchor + plan.period_days * DAY).toISOString(),
  };
}

/**
 * Mirrors the extend-anchor logic from
 * app/api/admin/subscriptions/[id]/mark-paid/route.ts.
 */
function computeNewExpiresAt({ subExpiresAt, receivedAt, periodDays, extendFrom }) {
  if (!subExpiresAt) {
    return new Date(Date.parse(receivedAt) + periodDays * DAY).toISOString();
  }
  let baseTime;
  if (extendFrom === "previous_expiry") {
    baseTime = Date.parse(subExpiresAt);
  } else if (extendFrom === "received_at") {
    baseTime = Date.parse(receivedAt);
  } else {
    // smart
    baseTime = Date.parse(subExpiresAt) > Date.parse(receivedAt)
      ? Date.parse(subExpiresAt)
      : Date.parse(receivedAt);
  }
  return new Date(baseTime + periodDays * DAY).toISOString();
}

/**
 * Mirrors useFeatureAccess grace math (lib/featureAccess.ts post-mig-65).
 */
function graceState({ expiresAtMs, graceDays, now }) {
  const graceMs = (graceDays || 0) * DAY;
  const inGracePast = expiresAtMs !== null && expiresAtMs < now;
  const beyondGrace = expiresAtMs !== null && expiresAtMs + graceMs < now;
  const isExpired = beyondGrace;
  const isInGrace = inGracePast && !beyondGrace;
  const graceRemainingDays = isInGrace
    ? Math.max(0, Math.ceil((expiresAtMs + graceMs - now) / DAY))
    : 0;
  return { isExpired, isInGrace, graceRemainingDays };
}

/**
 * Mirrors GST math from the invoice generator
 * (app/api/admin/subscriptions/[id]/invoice/route.ts).
 */
function gstMath({ subtotalPaise }) {
  const taxPaise = Math.round(subtotalPaise * 0.18);
  return { subtotalPaise, taxPaise, totalPaise: subtotalPaise + taxPaise };
}

/**
 * Mirrors BLM/YYYY/NNNN numbering format.
 */
function makeInvoiceNumber({ year, priorCount }) {
  const seq = String((priorCount ?? 0) + 1).padStart(4, "0");
  return `BLM/${year}/${seq}`;
}

// ─────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-08-05T10:00:00+05:30"); // Greenwood onboarding day
const PLAN_PILOT     = { id: "p-pilot",    period_days: 365 };
const PLAN_STANDARD  = { id: "p-std",      period_days: 365 };

section("set-plan: started_at / expires_at decision tree");

// Case B — brand-new bind, no existing row.
{
  const r = decideExpiryAnchors({
    existing: null,
    body: { plan_id: PLAN_PILOT.id },
    plan: PLAN_PILOT,
    now: NOW,
  });
  eq("Case B: brand-new bind anchors at now()",
    r.startedAt, new Date(NOW).toISOString());
  eq("Case B: expires_at = now + 365d",
    r.expiresAt, new Date(NOW + 365 * DAY).toISOString());
}

// Case B with explicit started_at — academic-year deal (1 Jun 2027).
{
  const r = decideExpiryAnchors({
    existing: null,
    body: { plan_id: PLAN_PILOT.id, started_at: "2027-06-01T00:00:00+05:30" },
    plan: PLAN_PILOT,
    now: NOW,
  });
  eq("Case B w/ started_at: backdate honoured",
    r.startedAt, new Date("2027-06-01T00:00:00+05:30").toISOString());
  eq("Case B w/ started_at: expires_at = started + 365d",
    r.expiresAt, new Date(Date.parse("2027-06-01T00:00:00+05:30") + 365 * DAY).toISOString());
}

// Case C — mid-cycle plan change. The big one.
{
  const greenwoodStart = new Date("2026-08-05T10:00:00+05:30").toISOString();
  const greenwoodEnd   = new Date("2027-08-05T10:00:00+05:30").toISOString();
  const r = decideExpiryAnchors({
    existing: {
      plan_id: PLAN_PILOT.id,
      started_at: greenwoodStart,
      expires_at: greenwoodEnd,
    },
    body: { plan_id: PLAN_STANDARD.id }, // upgrading mid-year
    plan: PLAN_STANDARD,
    now: Date.parse("2026-12-12T10:00:00+05:30"), // 4 months into the cycle
  });
  eq("Case C: started_at preserved on mid-cycle plan change",
    r.startedAt, greenwoodStart);
  eq("Case C: expires_at preserved on mid-cycle plan change (Pilot→Plus keeps the year)",
    r.expiresAt, greenwoodEnd);
}

// Case A — explicit renewal. Body says start_renewal:true, expiry resets.
{
  const greenwoodEnd = new Date("2027-08-05T10:00:00+05:30").toISOString();
  const renewalDate  = Date.parse("2027-07-25T10:00:00+05:30"); // renewing 11d early
  const r = decideExpiryAnchors({
    existing: {
      plan_id: PLAN_PILOT.id,
      started_at: new Date("2026-08-05T10:00:00+05:30").toISOString(),
      expires_at: greenwoodEnd,
    },
    body: { plan_id: PLAN_PILOT.id, start_renewal: true },
    plan: PLAN_PILOT,
    now: renewalDate,
  });
  eq("Case A: renewal anchors started_at to now() (not preserved)",
    r.startedAt, new Date(renewalDate).toISOString());
  eq("Case A: renewal expires_at = now + 365d (not previous + 365d — that's mark-paid's job)",
    r.expiresAt, new Date(renewalDate + 365 * DAY).toISOString());
}

// Case D — plan removed.
{
  const r = decideExpiryAnchors({
    existing: { plan_id: PLAN_PILOT.id, expires_at: "2027-08-05" },
    body: {},
    plan: null,
    now: NOW,
  });
  eq("Case D: plan removed → startedAt null", r.startedAt, null);
  eq("Case D: plan removed → expiresAt null", r.expiresAt, null);
}

// Case C edge: existing has expires_at but NO plan_id (legacy data) → treat as Case B.
{
  const r = decideExpiryAnchors({
    existing: { plan_id: null, expires_at: "2027-08-05" },
    body: { plan_id: PLAN_PILOT.id },
    plan: PLAN_PILOT,
    now: NOW,
  });
  eq("Case B (not C): existing has expiry but no plan → treat as fresh bind",
    r.startedAt, new Date(NOW).toISOString());
}

section("mark-paid: extend-anchor strategies");

// Early renewal (paid Jul 25, expires Aug 5 — 11 days early)
{
  const subExp = "2027-08-05T10:00:00+05:30";
  const recv   = "2027-07-25T10:00:00+05:30";
  const smart = computeNewExpiresAt({ subExpiresAt: subExp, receivedAt: recv, periodDays: 365, extendFrom: "smart" });
  eq("Early renewal smart: extends from previous expiry (preserves remainder)",
    smart, new Date(Date.parse(subExp) + 365 * DAY).toISOString());
  const prev = computeNewExpiresAt({ subExpiresAt: subExp, receivedAt: recv, periodDays: 365, extendFrom: "previous_expiry" });
  eq("Early renewal previous_expiry: same as smart for early case", prev, smart);
  const recvAt = computeNewExpiresAt({ subExpiresAt: subExp, receivedAt: recv, periodDays: 365, extendFrom: "received_at" });
  eq("Early renewal received_at: anchors on payment date (loses 11 days)",
    recvAt, new Date(Date.parse(recv) + 365 * DAY).toISOString());
}

// Late renewal (paid Aug 19, expires Aug 5 — 14 days late, inside grace)
{
  const subExp = "2027-08-05T10:00:00+05:30";
  const recv   = "2027-08-19T10:00:00+05:30";
  const smart = computeNewExpiresAt({ subExpiresAt: subExp, receivedAt: recv, periodDays: 365, extendFrom: "smart" });
  eq("Late renewal smart: anchors on receivedAt (school doesn't get free days)",
    smart, new Date(Date.parse(recv) + 365 * DAY).toISOString());
  const prev = computeNewExpiresAt({ subExpiresAt: subExp, receivedAt: recv, periodDays: 365, extendFrom: "previous_expiry" });
  eq("Late renewal previous_expiry: clean academic-year anchor (school loses 14d)",
    prev, new Date(Date.parse(subExp) + 365 * DAY).toISOString());
}

// First payment (no prior expiry).
{
  const recv = "2026-08-12T10:00:00+05:30";
  const smart = computeNewExpiresAt({ subExpiresAt: null, receivedAt: recv, periodDays: 365, extendFrom: "smart" });
  eq("First payment smart: anchors on receivedAt",
    smart, new Date(Date.parse(recv) + 365 * DAY).toISOString());
}

section("grace-period state machine (useFeatureAccess)");

const expiresAtMs = Date.parse("2027-08-05T00:00:00Z");

// Active — well before expiry.
{
  const r = graceState({ expiresAtMs, graceDays: 14, now: expiresAtMs - 30 * DAY });
  eq("Active 30d before expiry: not expired, not in grace",
    r, { isExpired: false, isInGrace: false, graceRemainingDays: 0 });
}

// Active — exactly at expiry minute.
{
  const r = graceState({ expiresAtMs, graceDays: 14, now: expiresAtMs });
  eq("At expiry minute: not yet in grace (expiresAt < now is strict)",
    r, { isExpired: false, isInGrace: false, graceRemainingDays: 0 });
}

// In grace — 1 day past expiry, 14-day grace.
{
  const r = graceState({ expiresAtMs, graceDays: 14, now: expiresAtMs + 1 * DAY });
  eq("1 day past expiry: in grace, 13 days remaining",
    r, { isExpired: false, isInGrace: true, graceRemainingDays: 13 });
}

// In grace — 14 days past, exactly at end of grace window.
{
  const r = graceState({ expiresAtMs, graceDays: 14, now: expiresAtMs + 14 * DAY });
  eq("14 days past with 14-day grace: still in grace (boundary inclusive)",
    r, { isExpired: false, isInGrace: true, graceRemainingDays: 0 });
}

// Beyond grace — 15 days past.
{
  const r = graceState({ expiresAtMs, graceDays: 14, now: expiresAtMs + 15 * DAY });
  eq("15 days past with 14-day grace: hard expired",
    r, { isExpired: true, isInGrace: false, graceRemainingDays: 0 });
}

// Zero grace — hard cliff at expires_at.
{
  const r = graceState({ expiresAtMs, graceDays: 0, now: expiresAtMs + 1 * DAY });
  eq("Grace=0: hard expired at +1d (no grace window)",
    r, { isExpired: true, isInGrace: false, graceRemainingDays: 0 });
}

// Null expires_at (free user).
{
  const r = graceState({ expiresAtMs: null, graceDays: 14, now: NOW });
  eq("Null expires_at: never expired, never in grace",
    r, { isExpired: false, isInGrace: false, graceRemainingDays: 0 });
}

section("GST math (invoice generator)");

// 500 students × ₹29 = ₹14,500. IGST 18% = ₹2,610. Total ₹17,110.
{
  const subtotal = 500 * 2900; // paise: 500 × 2900p = 14,50,000p = ₹14,500
  const r = gstMath({ subtotalPaise: subtotal });
  eq("Pilot 500-seat: subtotal ₹14,500", r.subtotalPaise, 1450000);
  eq("Pilot 500-seat: IGST 18% = ₹2,610",  r.taxPaise,    261000);
  eq("Pilot 500-seat: total ₹17,110",       r.totalPaise,  1711000);
}

// Negotiated price ₹35,000 flat → IGST ₹6,300 → total ₹41,300.
{
  const r = gstMath({ subtotalPaise: 3500000 });
  eq("Negotiated ₹35,000: IGST ₹6,300", r.taxPaise,   630000);
  eq("Negotiated ₹35,000: total ₹41,300", r.totalPaise, 4130000);
}

// Edge: subtotal that produces a fractional tax (rounding check).
{
  const r = gstMath({ subtotalPaise: 1000003 });
  // 1000003 * 0.18 = 180000.54 → Math.round → 180001
  eq("Rounding: ₹10,000.03 IGST = ₹1,800.01 (Math.round)",
    r.taxPaise, 180001);
}

section("BLM invoice number formatting");

eq("First invoice of 2026", makeInvoiceNumber({ year: 2026, priorCount: 0 }), "BLM/2026/0001");
eq("Tenth invoice of 2026", makeInvoiceNumber({ year: 2026, priorCount: 9 }), "BLM/2026/0010");
eq("100th invoice of 2026", makeInvoiceNumber({ year: 2026, priorCount: 99 }), "BLM/2026/0100");
eq("1000th invoice of 2026", makeInvoiceNumber({ year: 2026, priorCount: 999 }), "BLM/2026/1000");
eq("Year boundary: first of 2027", makeInvoiceNumber({ year: 2027, priorCount: 0 }), "BLM/2027/0001");

section("First-sign-in activation flip semantics");

// Simulating /api/auth/me. School onboarded with activation_pending=true,
// placeholder expiry of now+period. Super-teacher signs in 5 days later.
function simulateActivationFlip({ subActivationPending, subPlanPeriodDays, role, signinTime }) {
  // Mirrors the post-migration-65 logic in app/api/auth/me/route.ts.
  if (role !== "super_teacher") return { flipped: false };
  if (!subActivationPending) return { flipped: false };
  return {
    flipped: true,
    started_at: new Date(signinTime).toISOString(),
    expires_at: new Date(signinTime + subPlanPeriodDays * DAY).toISOString(),
  };
}

{
  const onboard = Date.parse("2026-08-01T10:00:00+05:30");
  const signin  = Date.parse("2026-08-05T14:00:00+05:30");
  const r = simulateActivationFlip({
    subActivationPending: true,
    subPlanPeriodDays: 365,
    role: "super_teacher",
    signinTime: signin,
  });
  eq("Super-teacher first sign-in: flip happens", r.flipped, true);
  eq("Flip: started_at = sign-in moment (not onboard moment)",
    r.started_at, new Date(signin).toISOString());
  eq("Flip: expires_at = signin + 365d (so school gets full year from real Day 0)",
    r.expires_at, new Date(signin + 365 * DAY).toISOString());
  // Sanity: school gained 4 days vs naive onboard-anchored expiry.
  const onboardAnchored = new Date(onboard + 365 * DAY).toISOString();
  const flipAnchored    = r.expires_at;
  eq("Flip recovered the 4 onboarding-lag days",
    Date.parse(flipAnchored) - Date.parse(onboardAnchored), 4 * DAY + 4 * 60 * 60 * 1000);
}

{
  // Regular teacher signing in first should NOT trigger the flip.
  const r = simulateActivationFlip({
    subActivationPending: true,
    subPlanPeriodDays: 365,
    role: "teacher",
    signinTime: NOW,
  });
  eq("Regular teacher first sign-in: NO flip (super-teacher gated)",
    r.flipped, false);
}

{
  // Already-flipped sub: idempotent no-op.
  const r = simulateActivationFlip({
    subActivationPending: false,
    subPlanPeriodDays: 365,
    role: "super_teacher",
    signinTime: NOW,
  });
  eq("Already-activated sub: flip is idempotent (no-op)", r.flipped, false);
}

// ─────────────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────────────
console.log("\n────────────────────────────────────────");
console.log(`\x1b[1mTotal: ${pass} passed, ${fail} failed\x1b[0m`);
if (fail > 0) {
  console.log("\n\x1b[31mFailures:\x1b[0m");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
} else {
  console.log("\x1b[32mAll logic tests pass.\x1b[0m");
  process.exit(0);
}
