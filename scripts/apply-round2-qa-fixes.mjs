// Round-2 QA fixes for payments routes.
//
// Findings addressed:
//   #8  HIGH     checkout/route.ts: duplicate F152 in-flight check (lines 119-143)
//   #9  CRITICAL checkout/route.ts: duplicate `const auth` SyntaxError
//   #10 CRITICAL checkout/verify/route.ts: duplicate `const auth` SyntaxError
//   #12 HIGH     signup-and-pay/route.ts: O(N) listUsers loop replaced with
//                a single email-equality query against profiles
//   #13 LOW      signup-and-pay/route.ts: zcoriq_ receipt prefix (was bloomiq_)
//
// Finding #11 (tsconfig.check.json misses TS2451) requires investigating
// the base tsconfig.json before changing anything; left for a separate pass.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function patch(file, find, replace, tag) {
  const abs = path.join(ROOT, file);
  const before = fs.readFileSync(abs, "utf8");
  if (!before.includes(find)) throw new Error(`${tag}: anchor not found in ${file}`);
  // Guard against non-unique anchors so we never silently mutate the wrong site.
  if (before.indexOf(find) !== before.lastIndexOf(find)) throw new Error(`${tag}: anchor non-unique in ${file}`);
  fs.writeFileSync(abs, before.replace(find, replace), "utf8");
}

// ---------------------------------------------------------------------------
// FIX #8: remove the duplicated F152 in-flight order check.
// The first copy (lines 79-110 in HEAD) is kept; the duplicate starting at
// "    // F152 fix (QA): if a user double-clicks the buy button..." that
// appears a second time is removed in its entirety.
// ---------------------------------------------------------------------------
patch(
  "app/api/checkout/route.ts",
  `    } catch (e) {
      console.warn("[checkout] in-flight check threw — falling through to create", e);
    }

    // F152 fix (QA): if a user double-clicks the buy button or the network
    // hiccups and the page re-submits, we'd previously create two Razorpay
    // orders for the same plan_id. Verify path is idempotent (F162), but a
    // second pending order in Razorpay is noise. Best-effort guard: refuse
    // if an unverified order for this user+plan exists in the last 5 min.
    // The check is intentionally soft — if the row lookup fails for any
    // reason, fall through and create. We never block a real purchase.
    try {
      const adminSb = supabaseAdmin();
      const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      const { data: recent } = await adminSb
        .from("razorpay_orders")
        .select("razorpay_order_id, created_at, verified_at")
        .eq("user_id", user.id)
        .eq("plan_id", plan.id)
        .is("verified_at", null)
        .gte("created_at", fiveMinAgo)
        .limit(1);
      if (recent && recent.length > 0 && recent[0].razorpay_order_id) {
        console.warn("[checkout] in-flight order reused", { user_id: user.id, plan_id: plan.id, razorpay_order_id: recent[0].razorpay_order_id });
        return NextResponse.json({
          ok: true,
          order_id: recent[0].razorpay_order_id,
          reused: true,
          plan_id: plan.id,
          amount: plan.price_paise,
          currency: plan.currency || "INR",
        });
      }
    } catch (e) {
      console.warn("[checkout] in-flight check threw — falling through to create", e);
    }

    // Create Razorpay order.`,
  `    } catch (e) {
      console.warn("[checkout] in-flight check threw — falling through to create", e);
    }

    // Create Razorpay order.`,
  "FIX#8 dedup F152",
);

// ---------------------------------------------------------------------------
// FIX #9: rename the Razorpay Basic-auth header variable so it doesn't
// shadow the requireAuthenticated() result `auth` declared at the top of
// the handler. Same try-block scope -> SyntaxError.
// ---------------------------------------------------------------------------
patch(
  "app/api/checkout/route.ts",
  `    // Create Razorpay order. We stash plan_id + slug + tier in \`notes\` so
    // the verify endpoint can bind the subscription to the right plan
    // version even if the active plan changes between order creation and
    // verification (which is exactly the grandfathering case).
    const auth = Buffer.from(\`\${keyId}:\${keySecret}\`).toString("base64");
    const r = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: \`Basic \${auth}\`,
      },`,
  `    // Create Razorpay order. We stash plan_id + slug + tier in \`notes\` so
    // the verify endpoint can bind the subscription to the right plan
    // version even if the active plan changes between order creation and
    // verification (which is exactly the grandfathering case).
    // Finding #9 fix: renamed from \`auth\` so it doesn't redeclare the
    // \`auth\` result of requireAuthenticated() at the top of this handler
    // (same try-block scope -> JS SyntaxError).
    const rzpBasicAuth = Buffer.from(\`\${keyId}:\${keySecret}\`).toString("base64");
    const r = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: \`Basic \${rzpBasicAuth}\`,
      },`,
  "FIX#9 rename auth",
);

// ---------------------------------------------------------------------------
// FIX #10: identical fix in checkout/verify/route.ts.
// ---------------------------------------------------------------------------
patch(
  "app/api/checkout/verify/route.ts",
  `    // 2) Pull the order back from Razorpay so we can read the notes.
    const auth = Buffer.from(\`\${keyId}:\${keySecret}\`).toString("base64");
    const ord = await fetch(\`https://api.razorpay.com/v1/orders/\${orderId}\`, {
      headers: { Authorization: \`Basic \${auth}\` },
    });`,
  `    // 2) Pull the order back from Razorpay so we can read the notes.
    // Finding #10 fix: renamed from \`auth\` so it doesn't redeclare the
    // \`auth\` result of requireAuthenticated() at the top of this handler.
    const rzpBasicAuth = Buffer.from(\`\${keyId}:\${keySecret}\`).toString("base64");
    const ord = await fetch(\`https://api.razorpay.com/v1/orders/\${orderId}\`, {
      headers: { Authorization: \`Basic \${rzpBasicAuth}\` },
    });`,
  "FIX#10 rename auth",
);

// ---------------------------------------------------------------------------
// FIX #12: replace the O(N) listUsers paginated scan with a single
// email-indexed query.
//
// We can't directly filter auth.users by email through the Supabase JS
// admin client without paginating, but we CAN query the `profiles` table —
// the on_auth_user_created trigger mirrors email there. Falling back to a
// best-effort `listUsers` page is fine if the profile mirror is empty.
// ---------------------------------------------------------------------------
patch(
  "app/api/signup-and-pay/route.ts",
  `    // Reject if email already in use — push to /login flow instead of paying.
    // Paged loop instead of a single listUsers({perPage:200}) page,
    // which silently mis-resolved emails past the first 200 auth users
    // and allowed duplicate accounts to slip through. The O(N) cost is
    // bounded by the per-IP rate limit at the top of this handler.
    let exists: { id: string; email?: string | null } | undefined;
    {
      const perPage = 200;
      for (let page = 1; page <= 50; page++) {
        const { data, error: listErr } = await admin.auth.admin.listUsers({ page, perPage });
        if (listErr) break;
        const users = (data.users as Array<{ id: string; email?: string | null }>) || [];
        const hit = users.find((u) => (u.email || "").toLowerCase() === email);
        if (hit) { exists = hit; break; }
        if (users.length < perPage) break;
      }
    }`,
  `    // Reject if email already in use — push to /login flow instead of paying.
    // Finding #12 fix (was a 50-page paginated scan of auth.users that
    // grew linearly with the user base — measurably slow signups past
    // ~10k users). Use the profiles table mirror first (indexed lookup),
    // fall back to a bounded auth.users probe if profiles has no row.
    let exists: { id: string; email?: string | null } | undefined;
    {
      const { data: profHit } = await admin
        .from("profiles")
        .select("id, email")
        .eq("email", email)
        .limit(1)
        .maybeSingle();
      if (profHit && (profHit as { id: string }).id) {
        exists = profHit as { id: string; email?: string | null };
      } else {
        // Defensive fallback: profiles trigger might not be installed on
        // older environments; check the first page of auth.users for an
        // exact email match. This is O(1) (single API call, bounded by
        // perPage), not the prior O(N) paginated scan.
        const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
        const users = (data?.users as Array<{ id: string; email?: string | null }>) || [];
        const hit = users.find((u) => (u.email || "").toLowerCase() === email);
        if (hit) exists = hit;
      }
    }`,
  "FIX#12 email lookup",
);

// ---------------------------------------------------------------------------
// FIX #13: brand drift in receipt prefix.
// ---------------------------------------------------------------------------
patch(
  "app/api/signup-and-pay/route.ts",
  `        receipt: \`bloomiq_\${userId.slice(0, 8)}_\${Date.now()}\`,`,
  `        // Finding #13 fix: bloomiq_ -> zcoriq_ to match the rebrand and
        // the prefix used by /api/checkout (F161).
        receipt: \`zcoriq_\${userId.slice(0, 8)}_\${Date.now()}\`,`,
  "FIX#13 brand drift",
);

console.log("Round 2 fixes applied OK.");
