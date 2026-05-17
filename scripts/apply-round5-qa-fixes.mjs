// Round-5 QA fixes: the 6 critical bugs exposed by flipping
// tsconfig.check.json strict to true in Round 4, plus the two permanent
// CI hardening flips that close the meta-gap (Finding #25).
//
// Findings:
//   #26 CRITICAL admin/users/page.tsx: User type missing platform_admin field
//   #27 CRITICAL admin/plan-proposals/route.ts: legacy {err} narrowing on
//                requireAdmin (alias of requirePlatformAdmin which returns
//                {error}). 2 occurrences.
//   #28 CRITICAL admin/schools/[id]/route.ts: requireAuthenticated used but
//                not imported.
//   #29 CRITICAL api/generate/route.ts: token used in genFor() arrow but not
//                destructured from auth.
//   #30 CRITICAL api/papers/generate/route.ts: same pattern as #29.
//   #31 CRITICAL api/rank/predict/route.ts: dead-code else branch reads
//                .reason on `never` (the verdict union was exhausted by the
//                early-return guard + the two prior branches).
//   #11 (closure) tsconfig.check.json: re-flip strict to true PERMANENTLY.
//   #25 (closure) next.config.ts: flip ignoreBuildErrors to false PERMANENTLY.

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

function patchAll(file, find, replace, tag) {
  const abs = path.join(ROOT, file);
  const raw = fs.readFileSync(abs, "utf8");
  const crlf = raw.includes("\r\n");
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.includes(find)) throw new Error(`${tag}: anchor not found in ${file}`);
  const next = text.split(find).join(replace);
  fs.writeFileSync(abs, crlf ? next.replace(/\n/g, "\r\n") : next, "utf8");
  console.log(`  ${tag}: applied (replace-all)`);
}

// ---------------------------------------------------------------------------
// FIX #26: admin/users/page.tsx — add platform_admin to User type.
// ---------------------------------------------------------------------------
patchNorm(
  "app/admin/users/page.tsx",
  `type User = {
  id: string;
  full_name: string | null;
  email: string | null;
  role: "student" | "teacher" | null;
  is_school_student: boolean;
  is_test_account: boolean;
  sub_role: SubRole;
  school_id: string | null;
  school_name: string | null;
  created_at: string | null;
};`,
  `type User = {
  id: string;
  full_name: string | null;
  email: string | null;
  role: "student" | "teacher" | null;
  is_school_student: boolean;
  is_test_account: boolean;
  sub_role: SubRole;
  school_id: string | null;
  school_name: string | null;
  created_at: string | null;
  // Finding #26 fix: platform_admin is read at filter time (F175) but was
  // missing from the type. TS strict caught the property access.
  platform_admin: boolean;
};`,
  "FIX#26 admin/users User type",
);

// ---------------------------------------------------------------------------
// FIX #27: plan-proposals/route.ts — replace legacy {err} narrowing.
// requireAdmin is now an alias of requirePlatformAdmin which returns
// {error} on failure. The two callers still use the old {err} shape.
// ---------------------------------------------------------------------------
patchAll(
  "app/api/admin/plan-proposals/route.ts",
  `    if ("err" in auth) return auth.err;`,
  `    if ("error" in auth) return auth.error;`,
  "FIX#27 plan-proposals narrowing",
);

// ---------------------------------------------------------------------------
// FIX #28: admin/schools/[id]/route.ts — add requireAuthenticated import.
// ---------------------------------------------------------------------------
patchNorm(
  "app/api/admin/schools/[id]/route.ts",
  `import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/apiAuth";`,
  `import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
// Finding #28 fix: requireAuthenticated is used by the DELETE handler but
// the import line wasn't updated when F22 landed.
import { requirePlatformAdmin, requireAuthenticated } from "@/lib/apiAuth";`,
  "FIX#28 schools/[id] import",
);

// ---------------------------------------------------------------------------
// FIX #29: api/generate/route.ts — destructure token from auth.
// ---------------------------------------------------------------------------
patchNorm(
  "app/api/generate/route.ts",
  `    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat ≥ profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;`,
  `    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat ≥ profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    // Finding #29 fix: token was destructured implicitly via the legacy
    // \`getBearer(req)\` call, then F22 removed that line but didn't
    // add token to this destructure. genFor() below uses token to forward
    // to findMisconceptionDistractors.
    const { user, sb, token } = auth;`,
  "FIX#29 generate token destructure",
);

// ---------------------------------------------------------------------------
// FIX #30: api/papers/generate/route.ts — same pattern.
// ---------------------------------------------------------------------------
patchNorm(
  "app/api/papers/generate/route.ts",
  `    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;`,
  `    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    // Finding #30 fix: same shape as #29 — token used downstream by
    // findMisconceptionDistractors but was missing from the destructure.
    const { user, sb, token } = auth;`,
  "FIX#30 papers/generate token destructure",
);

// ---------------------------------------------------------------------------
// FIX #31: rank/predict/route.ts — the else branch at line 269 is provably
// unreachable. After the isExamMock guard at line 230-232, eligibility.verdict
// can only be matches_known_exam | competitive_exam_other. Both are handled
// by the if + else-if above, so TS narrows eligibility to `never` in the
// final else. Replace the bad property access with a defensive static
// string (kept as a safety net in case the type ever broadens).
// ---------------------------------------------------------------------------
patchNorm(
  "app/api/rank/predict/route.ts",
  `      } else {
        // generic / academic-subject / unknown — allow with the user's pick.
        eligibility_note = eligibility.reason;
      }`,
  `      } else {
        // Finding #31 fix: this branch is unreachable after the isExamMock
        // guard above (the verdict union is narrowed to two cases that the
        // if + else-if exhaust). TS proves \`eligibility\` is \`never\` here.
        // Keep a defensive fallback string so behaviour stays safe if the
        // upstream type or guard ever changes.
        eligibility_note = "Eligibility could not be classified.";
      }`,
  "FIX#31 rank/predict dead else",
);

// ---------------------------------------------------------------------------
// FIX #11 closure: tsconfig.check.json — flip strict to true PERMANENTLY.
// ---------------------------------------------------------------------------
{
  const file = "tsconfig.check.json";
  const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
  const crlf = raw.includes("\r\n");
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.includes(`"strict": false`)) {
    console.log("  FIX#11: tsconfig.check.json already strict:true (skipping)");
  } else {
    const next = text.replace(`"strict": false`, `"strict": true`);
    fs.writeFileSync(path.join(ROOT, file), crlf ? next.replace(/\n/g, "\r\n") : next, "utf8");
    console.log("  FIX#11: tsconfig.check.json strict:false -> strict:true (permanent)");
  }
}

// ---------------------------------------------------------------------------
// FIX #25 closure: next.config.ts — flip ignoreBuildErrors to false
// PERMANENTLY. With all of #1-#31 fixed and strict:true on the check
// config, the build is now the source of truth.
// ---------------------------------------------------------------------------
patchNorm(
  "next.config.ts",
  `  // Pre-existing TS errors in non-critical paths (calibration log,
  // school digest, recharts tooltip Formatter signatures, etc.) block
  // production builds. Skip them so Vercel can deploy; clean them up
  // incrementally in follow-up PRs. Next 16 dropped the eslint key here
  // — lint runs separately via \`next lint\` / CI now.
  typescript: { ignoreBuildErrors: true },`,
  `  // Finding #25 fix: all known TS errors were closed in the May-17 QA
  // sweep (rounds 1-5 of the audit). Build-time type-checking is now an
  // invariant — flipping this back to true silently re-allows the entire
  // class of bugs that sweep caught (4 SyntaxErrors, 8 ReferenceErrors,
  // 3 corrupted files, plus type-narrowing gaps). If you genuinely need
  // to unblock a hot fix, isolate the TS error and disable just that
  // file via an \`@ts-expect-error\` line — never globally.
  typescript: { ignoreBuildErrors: false },`,
  "FIX#25 next.config ignoreBuildErrors",
);

console.log("Round 5 fixes applied OK.");
