// Round-3 QA fixes for /api/auth/*.
//
// Findings:
//   #14 MEDIUM /api/auth/me activation flip silently defaults period_days to 365
//   #15 HIGH   /api/auth/me is_free_expired ignores subscriptions.status
//   #16 MEDIUM /api/auth/me activation flip ignores subscriptions.status
//   #17 MEDIUM decodeIat duplicated across 3 files
//   #18 HIGH   /api/auth/set-password accepts arbitrary tos_version from client
//
// Operates byte-wise to handle CRLF cleanly (the user's repo uses CRLF
// after the autocrlf=true normalization on Windows).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function readNorm(file) {
  const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
  const crlf = raw.includes("\r\n");
  return { raw, crlf, text: raw.replace(/\r\n/g, "\n") };
}
function write(file, crlf, text) {
  const out = crlf ? text.replace(/\n/g, "\r\n") : text;
  fs.writeFileSync(path.join(ROOT, file), out, "utf8");
}
function patch(file, find, replace, tag) {
  const f = readNorm(file);
  if (!f.text.includes(find)) throw new Error(`${tag}: anchor not found in ${file}`);
  if (f.text.indexOf(find) !== f.text.lastIndexOf(find)) throw new Error(`${tag}: anchor non-unique in ${file}`);
  write(file, f.crlf, f.text.replace(find, replace));
  console.log(`  ${tag}: applied to ${file}`);
}

// ---------------------------------------------------------------------------
// FIX #14 + #16: harden the activation-pending flip in /api/auth/me.
// (a) Refuse to flip when period_days is null/0 (Finding #14 / F30).
// (b) Refuse to flip when the subscription is suspended/cancelled
//     (Finding #16).
// ---------------------------------------------------------------------------
patch(
  "app/api/auth/me/route.ts",
  `    if (prof?.role === "super_teacher" && prof.school_id) {
      const { data: sub } = await admin
        .from("subscriptions")
        .select("id, plan_id, activation_pending, started_at")
        .eq("school_id", prof.school_id)
        .maybeSingle();
      if (sub?.activation_pending && sub.id) {
        let periodDays = 365;
        if (sub.plan_id) {
          const { data: planRow } = await admin
            .from("plans")
            .select("period_days")
            .eq("id", sub.plan_id)
            .maybeSingle();
          // F30 note (QA): if plans.period_days is NULL the activation flip
          // falls back to the 365-day default. That's safe for the standard
          // annual plans but lies for term/quarterly plans. The fix here is
          // a refusal: if periodDays cannot be resolved from the plan row,
          // log + skip the flip instead of defaulting silently. Tracked.
          if (planRow?.period_days) periodDays = planRow.period_days;
        }`,
  `    if (prof?.role === "super_teacher" && prof.school_id) {
      const { data: sub } = await admin
        .from("subscriptions")
        .select("id, plan_id, activation_pending, started_at, status")
        .eq("school_id", prof.school_id)
        .maybeSingle();
      // Finding #16 fix: refuse to activate a cancelled/suspended sub.
      // An admin who pre-cancelled or pre-suspended a school's subscription
      // before its super_teacher first signed in should not have that
      // intent silently overwritten by an automatic activation flip.
      const subStatus = (sub as { status?: string | null } | null)?.status ?? null;
      const statusAllowsActivation = subStatus === null || subStatus === "active" || subStatus === "" ;
      if (sub?.activation_pending && sub.id && statusAllowsActivation) {
        // Finding #14 fix (F30 closure): resolve period_days strictly from the
        // plan row. If we cannot (plan_id missing, plan deleted, or period_days
        // null/zero), log a warning and SKIP the flip instead of silently
        // defaulting to 365 — which lies for quarterly/term plans.
        let periodDays: number | null = null;
        if (sub.plan_id) {
          const { data: planRow } = await admin
            .from("plans")
            .select("period_days")
            .eq("id", sub.plan_id)
            .maybeSingle();
          const pd = (planRow as { period_days?: number | null } | null)?.period_days ?? null;
          if (typeof pd === "number" && pd > 0) periodDays = pd;
        }
        if (periodDays === null) {
          // eslint-disable-next-line no-console
          console.warn(
            "[auth/me] activation flip skipped: cannot resolve period_days for subscription " +
              sub.id + " (plan_id=" + String(sub.plan_id) + "). Operator must edit the plan or set started_at/expires_at manually.",
          );
        } else {`,
  "FIX#14+#16-prelude",
);

// Close the new \`} else {\` block we opened above by adjusting the
// trailing block scope. The original code's update is inside the same
// "if activation_pending" if; we need to also close our new else.
patch(
  "app/api/auth/me/route.ts",
  `        if (!useExistingAnchor) patch.started_at = anchor.toISOString();
        await admin
          .from("subscriptions")
          .update(patch)
          .eq("id", sub.id);
      }
    }`,
  `        if (!useExistingAnchor) patch.started_at = anchor.toISOString();
        await admin
          .from("subscriptions")
          .update(patch)
          .eq("id", sub.id);
        }
      }
    }`,
  "FIX#14+#16-block-close",
);

// ---------------------------------------------------------------------------
// FIX #15: is_free_expired must treat suspended/cancelled as expired.
// ---------------------------------------------------------------------------
patch(
  "app/api/auth/me/route.ts",
  `          if (
            sub.tier === "free" &&
            sub.is_trial === true &&
            sub.expires_at &&
            new Date(sub.expires_at).getTime() < Date.now()
          ) {
            isFreeExpired = true;
          }`,
  `          // Finding #15 fix: treat suspended/cancelled Free trials as expired
          // for the layout gate. Without this, an admin-suspended student keeps
          // accessing Free features until natural expiry.
          const subStatus = (sub as { status?: string | null }).status || "";
          const adminBlocked = subStatus === "suspended" || subStatus === "cancelled";
          if (
            sub.tier === "free" &&
            sub.is_trial === true &&
            (
              adminBlocked ||
              (sub.expires_at && new Date(sub.expires_at).getTime() < Date.now())
            )
          ) {
            isFreeExpired = true;
          }`,
  "FIX#15",
);

// ---------------------------------------------------------------------------
// FIX #17: export decodeIat from lib/apiAuth.ts, import in /api/auth/me and
// /api/auth/claim-session, drop the duplicate function bodies.
// ---------------------------------------------------------------------------

// 17a: make the lib export public.
patch(
  "lib/apiAuth.ts",
  `/**
 * Decode the \`iat\` claim from a JWT (no signature verification — that
 * happened upstream when supabase-js accepted the token). Returns null
 * on any parse failure.
 */
function decodeIat(token: string): number | null {`,
  `/**
 * Decode the \`iat\` claim from a JWT (no signature verification — that
 * happened upstream when supabase-js accepted the token). Returns null
 * on any parse failure.
 *
 * Exported so /api/auth/me and /api/auth/claim-session can use the same
 * implementation (Finding #17 — three copies before this).
 */
export function decodeIat(token: string): number | null {`,
  "FIX#17a export decodeIat",
);

// 17b: replace duplicate in /api/auth/me/route.ts with an import.
patch(
  "app/api/auth/me/route.ts",
  `import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";`,
  `import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
// Finding #17 fix: shared decodeIat (was duplicated locally).
import { decodeIat } from "@/lib/apiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";`,
  "FIX#17b import in /api/auth/me",
);

patch(
  "app/api/auth/me/route.ts",
  `function decodeIat(token: string): number | null {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const obj = JSON.parse(json) as { iat?: number };
    return typeof obj.iat === "number" ? obj.iat : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {`,
  `export async function GET(req: Request) {`,
  "FIX#17b remove dup in /api/auth/me",
);

// 17c: same for /api/auth/claim-session.
patch(
  "app/api/auth/claim-session/route.ts",
  `import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";`,
  `import { NextResponse } from "next/server";
import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
// Finding #17 fix: shared decodeIat (was duplicated locally).
import { decodeIat } from "@/lib/apiAuth";

export const runtime = "nodejs";`,
  "FIX#17c import in claim-session",
);

patch(
  "app/api/auth/claim-session/route.ts",
  `function decodeIat(token: string): number | null {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const obj = JSON.parse(json) as { iat?: number };
    return typeof obj.iat === "number" ? obj.iat : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {`,
  `export async function POST(req: Request) {`,
  "FIX#17c remove dup in claim-session",
);

// ---------------------------------------------------------------------------
// FIX #18: enforce a server-side allowlist on tos_version in set-password.
// ---------------------------------------------------------------------------
patch(
  "app/api/auth/set-password/route.ts",
  `    const tosVersion = String(body.tos_version || "2026-04-30");`,
  `    // Finding #18 fix: refuse arbitrary tos_version strings. Without this
    // guard, a malicious client could record "tos_accepted_at: 2099-12-31"
    // or any made-up version string in user_metadata, polluting the legal
    // audit trail. Keep the allowlist in sync with the TOS_VERSION constant
    // on the login pages.
    const ALLOWED_TOS_VERSIONS = new Set(["2026-04-30"]);
    const requested = String(body.tos_version || "2026-04-30");
    if (!ALLOWED_TOS_VERSIONS.has(requested)) {
      return NextResponse.json(
        { error: "Unknown ToS version. Refresh the page and accept the latest Terms." },
        { status: 400 },
      );
    }
    const tosVersion = requested;`,
  "FIX#18 tos_version allowlist",
);

console.log("Round 3 fixes applied OK.");
