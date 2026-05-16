// scripts/refactor-f22-step3-mopup.mjs
// F22 mop-up — handles routes that were PARTIALLY migrated in earlier
// finale passes (first handler migrated, second handler skipped because
// "requireAuthenticated already present" check exited early).
//
// Also handles parent/invite which uses `bearer` instead of `token`.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

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
  path.join(ROOT, "app/api/admin/classes/[id]/co-teachers/route.ts"),
  path.join(ROOT, "app/api/student/share/route.ts"),
  // The plan-proposals adapter file has getBearer in dead-code legacy fn;
  // leaving as-is per its in-file annotation.
  path.join(ROOT, "app/api/admin/plan-proposals/route.ts"),
]);

const REPLACE_4SP = `    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;`;

// All known auth-block patterns. Try each; replace-all.
const AUTH_BLOCK_VARIANTS = [
  // Standard 4sp + blank line (the deputy/schools[id]-second-handler case).
  {
    find: `    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });`,
    replace: REPLACE_4SP,
  },
  // Standard 4sp single-line.
  {
    find: `    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });`,
    replace: REPLACE_4SP,
  },
  // parent/invite uses `bearer` variable name.
  {
    find: `    const bearer = getBearer(req);
    if (!bearer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(bearer);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });`,
    replace: REPLACE_4SP,
  },
];

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
];

function applyVariants(content, variants) {
  let changed = false;
  let s = content;
  for (const v of variants) {
    if (s.includes(v.find)) {
      while (s.includes(v.find)) s = s.replace(v.find, v.replace);
      changed = true;
    } else {
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

const report = { migrated: [], still_on_getBearer: [], import_added: [] };

for (const f of files) {
  const before = fs.readFileSync(f, "utf8");
  if (!before.includes("getBearer(req)")) continue;

  // Apply auth-block first (this is the key change from earlier finales —
  // we don't bail out on "already has requireAuthenticated" because the
  // file might be PARTIALLY migrated and still need the second handler).
  const blk = applyVariants(before, AUTH_BLOCK_VARIANTS);
  let next = blk.out;
  let importChanged = false;
  // If the file doesn't yet import requireAuthenticated, add it now.
  if (blk.changed && !next.includes("requireAuthenticated")) {
    const imp = applyVariants(next, IMPORT_VARIANTS);
    next = imp.out;
    importChanged = imp.changed;
    if (!importChanged) {
      report.still_on_getBearer.push(path.relative(ROOT, f) + " (block matched but import didn't)");
      continue;
    }
  }
  if (blk.changed) {
    fs.writeFileSync(f, next, "utf8");
    report.migrated.push(path.relative(ROOT, f));
  } else {
    report.still_on_getBearer.push(path.relative(ROOT, f));
  }
}

console.log(`\n=== F22 Step 3 mop-up summary ===`);
console.log(`Migrated: ${report.migrated.length}`);
for (const f of report.migrated) console.log(`  + ${f}`);
console.log(`\nStill on getBearer (manual review): ${report.still_on_getBearer.length}`);
for (const f of report.still_on_getBearer) console.log(`  ? ${f}`);
