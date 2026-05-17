// Round-4 QA fixes: 4 critical ReferenceErrors in admin routes + the
// webhook started_at preservation issue (R1 from today's Razorpay audit).
//
// Findings:
//   #19 CRITICAL  admin/subscriptions/[id]/mark-paid: `user` undefined (3 sites)
//   #20 CRITICAL  admin/schools/[id]/set-plan:        `user` undefined (2 sites)
//   #21 CRITICAL  admin/subscriptions/[id]/reactivate: `user` undefined (1 site)
//   #22 CRITICAL  admin/subscriptions/[id]/suspend:    `user` undefined (2 sites)
//   #23 HIGH      razorpay/webhook: started_at preserved on same-plan renewal
//
// All 4 admin-route fixes have the same shape: insert
// `    const { user } = auth;` immediately after the `if ("error" in auth)`
// early-return.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function patchNorm(file, find, replace, tag) {
  const abs = path.join(ROOT, file);
  const raw = fs.readFileSync(abs, "utf8");
  const crlf = raw.includes("\r\n");
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.includes(find)) throw new Error(`${tag}: anchor not found in ${file}`);
  if (text.indexOf(find) !== text.lastIndexOf(find)) throw new Error(`${tag}: anchor non-unique in ${file}`);
  const next = text.replace(find, replace);
  fs.writeFileSync(abs, crlf ? next.replace(/\n/g, "\r\n") : next, "utf8");
  console.log(`  ${tag}: applied`);
}

// ---------------------------------------------------------------------------
// FIX #19: mark-paid — destructure user from auth.
// The current code has `const auth = await requirePlatformAdmin(req);`
// followed by `if ("error" in auth) return auth.error;` but no
// `const { user } = auth;`. Add it.
// ---------------------------------------------------------------------------
patchNorm(
  "app/api/admin/subscriptions/[id]/mark-paid/route.ts",
  `    // F171 fix (QA): inline platform_admin check → shared helper.
    // F22 single-session iat enforcement comes along for free.
    const auth = await requirePlatformAdmin(req);
    if ("error" in auth) return auth.error;

    const { id: subscriptionId } = await ctx.params;`,
  `    // F171 fix (QA): inline platform_admin check → shared helper.
    // F22 single-session iat enforcement comes along for free.
    const auth = await requirePlatformAdmin(req);
    if ("error" in auth) return auth.error;
    // Finding #19 fix: the F171 codemod renamed the destructure to \`auth\`
    // but left bare \`user.id\` references at the audit-stamp sites. That's
    // ReferenceError at runtime — admin "Mark payment received" was 500ing.
    const { user } = auth;

    const { id: subscriptionId } = await ctx.params;`,
  "FIX#19 mark-paid",
);

// ---------------------------------------------------------------------------
// FIX #21: reactivate — same pattern.
// ---------------------------------------------------------------------------
{
  const file = "app/api/admin/subscriptions/[id]/reactivate/route.ts";
  const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
  const text = raw.replace(/\r\n/g, "\n");
  // Find the right anchor (the early-return after auth check).
  const anchor = text.match(/(\n    if \("error" in auth\) return auth\.error;\n)([^\n]*\n)/);
  if (!anchor) throw new Error("FIX#21: reactivate anchor not found");
  // Only proceed if user destructure isn't already present below the anchor.
  if (/\n\s*const \{ user \} = auth;\n/.test(text)) {
    console.log("  FIX#21 reactivate: already destructured, skipping");
  } else {
    patchNorm(
      file,
      `    if ("error" in auth) return auth.error;`,
      `    if ("error" in auth) return auth.error;
    // Finding #21 fix: same shape as #19 — destructure user.
    const { user } = auth;`,
      "FIX#21 reactivate",
    );
  }
}

// ---------------------------------------------------------------------------
// FIX #22: suspend — same pattern.
// ---------------------------------------------------------------------------
{
  const file = "app/api/admin/subscriptions/[id]/suspend/route.ts";
  if (/\n\s*const \{ user \} = auth;\n/.test(fs.readFileSync(path.join(ROOT, file), "utf8"))) {
    console.log("  FIX#22 suspend: already destructured, skipping");
  } else {
    patchNorm(
      file,
      `    if ("error" in auth) return auth.error;`,
      `    if ("error" in auth) return auth.error;
    // Finding #22 fix: same shape as #19/#21.
    const { user } = auth;`,
      "FIX#22 suspend",
    );
  }
}

// ---------------------------------------------------------------------------
// FIX #20: set-plan — same pattern. Has handler context, so anchor is unique.
// ---------------------------------------------------------------------------
{
  const file = "app/api/admin/schools/[id]/set-plan/route.ts";
  if (/\n\s*const \{ user \} = auth;\n/.test(fs.readFileSync(path.join(ROOT, file), "utf8"))) {
    console.log("  FIX#20 set-plan: already destructured, skipping");
  } else {
    patchNorm(
      file,
      `    if ("error" in auth) return auth.error;`,
      `    if ("error" in auth) return auth.error;
    // Finding #20 fix: same shape as #19 — destructure user.
    const { user } = auth;`,
      "FIX#20 set-plan",
    );
  }
}

// ---------------------------------------------------------------------------
// FIX #23: webhook started_at preservation on same-plan renewal.
// On UPDATE branch, only stamp started_at when the plan_id is changing.
// On true renewal (same plan_id), keep the original started_at so
// (expires_at - started_at) still equals one paid cycle, not the rollover
// total. Inserts a fresh started_at on a new subscription (existing branch
// of the if).
// ---------------------------------------------------------------------------
patchNorm(
  "app/api/razorpay/webhook/route.ts",
  `    if (existing?.id) {
      const { error: updErr } = await admin
        .from("subscriptions")
        .update({
          tier: legacyTier,
          plan_id: planRow.id,
          price_paid_paise: pricePaidPaise,
          status: "active",
          started_at: new Date().toISOString(),
          expires_at: expiresAt,
          razorpay_payment_id: paymentId,
          school_id: null,
        })
        .eq("id", existing.id);
      if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    } else {`,
  `    if (existing?.id) {
      // Finding #23 fix (R1 from today's Razorpay audit doc): on
      // SAME-plan renewals, preserve started_at so the cohort math
      // (expires_at - started_at = one paid cycle) stays accurate.
      // Bump it ONLY when the plan actually changed (upgrade/downgrade
      // is a logically new term).
      const existingRow = existing as { id: string; plan_id?: string | null; started_at?: string | null };
      const planChanged = (existingRow.plan_id ?? null) !== planRow.id;
      const updatePayload: Record<string, unknown> = {
        tier: legacyTier,
        plan_id: planRow.id,
        price_paid_paise: pricePaidPaise,
        status: "active",
        expires_at: expiresAt,
        razorpay_payment_id: paymentId,
        school_id: null,
      };
      if (planChanged || !existingRow.started_at) {
        updatePayload.started_at = new Date().toISOString();
      }
      const { error: updErr } = await admin
        .from("subscriptions")
        .update(updatePayload)
        .eq("id", existing.id);
      if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    } else {`,
  "FIX#23 webhook started_at",
);

// Also: the SELECT for existing must now include plan_id and started_at.
patchNorm(
  "app/api/razorpay/webhook/route.ts",
  `    const { data: existing } = await admin
      .from("subscriptions")
      .select("id, expires_at")
      .eq("user_id", userId)
      .maybeSingle();`,
  `    const { data: existing } = await admin
      .from("subscriptions")
      .select("id, expires_at, plan_id, started_at")
      .eq("user_id", userId)
      .maybeSingle();`,
  "FIX#23 webhook SELECT cols",
);

console.log("Round 4 fixes applied OK.");
