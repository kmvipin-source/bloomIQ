// scripts/refactor-f22-step3-finale.mjs
// F22 Step 3 finale — sweep every remaining route that still has the
// old `getBearer(req)` auth pattern. Tries known import + auth-block
// variants; reports per-route whether each landed.
//
// Deliberately EXCLUDED (auth-flow routes that need careful handling):
//   - app/api/auth/me/route.ts           — implements the iat check itself
//   - app/api/auth/claim-session/route.ts — SETS session_iat; cannot self-gate
//   - app/api/auth/set-password/route.ts  — called immediately after sign-in
//   - app/api/login-audit/route.ts        — fired at sign-in; pre-claim window
//   - app/api/flags/public/route.ts       — no auth: callable by anonymous

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Walk app/api/ and find every route.ts with getBearer.
function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (entry.isFile() && entry.name === "route.ts") acc.push(p);
  }
  return acc;
}

const SKIP_FILES = new Set([
  path.join(ROOT, "app/api/auth/me/route.ts"),
  path.join(ROOT, "app/api/auth/claim-session/route.ts"),
  path.join(ROOT, "app/api/auth/set-password/route.ts"),
  path.join(ROOT, "app/api/login-audit/route.ts"),
  path.join(ROOT, "app/api/flags/public/route.ts"),
]);

// Import variants to try. The replacement always adds the apiAuth import.
const IMPORT_VARIANTS = [
  {
    find: `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`,
    replace: `import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";`,
  },
  {
    find: `import { getBearer, supabaseServer } from "@/lib/supabase/server";`,
    replace: `import { supabaseServer } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";`,
  },
  {
    find: `import { supabaseAdmin, getBearer, supabaseServer } from "@/lib/supabase/server";`,
    replace: `import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";`,
  },
  {
    find: `import { getBearer, supabaseAdmin, supabaseServer } from "@/lib/supabase/server";`,
    replace: `import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";`,
  },
];

// Auth block variants. The codemod tries each; the FIRST match wins, and
// it does a replace-all (so multi-handler routes get migrated cleanly).
const AUTH_BLOCK_VARIANTS = [
  // 4-space indent, single-line braces, NextResponse short-form.
  {
    find: `    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });`,
    replace: `    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;`,
  },
  // 4-space indent, multi-line braces (curly on its own).
  {
    find: `    const token = getBearer(req);
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }`,
    replace: `    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;`,
  },
  // 4-space indent, multi-line destructure (the teacher/classes shape).
  {
    find: `    const token = getBearer(req);
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const sb = supabaseServer(token);
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }`,
    replace: `    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;`,
  },
  // 2-space indent (top-level handlers without try{}).
  {
    find: `  const token = getBearer(req);
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const sb = supabaseServer(token);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });`,
    replace: `  // F22 fix (QA): shared requireAuthenticated — single-session enforcement applied.
  const auth = await requireAuthenticated(req);
  if ("error" in auth) return auth.error;
  const { user, sb } = auth;`,
  },
];

function applyVariants(content, variants) {
  let changed = false;
  let s = content;
  for (const v of variants) {
    if (s.includes(v.find)) {
      // Replace ALL occurrences for auth blocks (multi-handler routes).
      while (s.includes(v.find)) s = s.replace(v.find, v.replace);
      changed = true;
    } else {
      // Try CRLF.
      const findCrlf = v.find.replace(/\r?\n/g, "\r\n");
      const replaceCrlf = v.replace.replace(/\r?\n/g, "\r\n");
      if (s.includes(findCrlf)) {
        while (s.includes(findCrlf)) s = s.replace(findCrlf, replaceCrlf);
        changed = true;
      }
    }
  }
  return { changed, out: s };
}

const apiRoot = path.join(ROOT, "app/api");
const files = walk(apiRoot).filter((f) => !SKIP_FILES.has(f));

const report = {
  fully_migrated: [],
  import_only: [],
  block_only: [],
  no_change: [],
  not_applicable: [],
};

for (const f of files) {
  const before = fs.readFileSync(f, "utf8");
  if (!before.includes("getBearer(req)") && !before.includes("getBearer(request)")) {
    report.not_applicable.push(path.relative(ROOT, f));
    continue;
  }
  // Already on the helper? Skip.
  if (before.includes("requireAuthenticated") || before.includes("requirePlatformAdmin")) {
    report.not_applicable.push(path.relative(ROOT, f));
    continue;
  }
  const imp = applyVariants(before, IMPORT_VARIANTS);
  const blk = applyVariants(imp.out, AUTH_BLOCK_VARIANTS);
  if (imp.changed && blk.changed) {
    fs.writeFileSync(f, blk.out, "utf8");
    report.fully_migrated.push(path.relative(ROOT, f));
  } else if (imp.changed && !blk.changed) {
    // Don't write — partial migration would break the file.
    report.import_only.push(path.relative(ROOT, f));
  } else if (!imp.changed && blk.changed) {
    report.block_only.push(path.relative(ROOT, f));
  } else {
    report.no_change.push(path.relative(ROOT, f));
  }
}

console.log(`\n=== F22 Step 3 finale summary ===`);
console.log(`Fully migrated: ${report.fully_migrated.length}`);
for (const f of report.fully_migrated) console.log(`  + ${f}`);
console.log(`\nNeeds manual review (non-standard auth pattern): ${report.no_change.length}`);
for (const f of report.no_change) console.log(`  ? ${f}`);
console.log(`\nImport matched but auth block didn't (skipped, not written): ${report.import_only.length}`);
for (const f of report.import_only) console.log(`  ! ${f}`);
console.log(`\nAlready on helper or no getBearer: ${report.not_applicable.length}`);
