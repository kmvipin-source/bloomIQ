// scripts/refactor-f22-step3-finale-2.mjs
// F22 Step 3 finale, follow-up — handle two more auth-block variants that
// the first finale missed:
//   - destructure with `error: userErr` (and `userErr || !user` check)
//   - blank line between `if (!token)` and `const sb = ...`

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
]);

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

const REPLACE_4SP = `    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;`;

const AUTH_BLOCK_VARIANTS = [
  // Variant: destructure includes error: userErr, plus `userErr || !user` check.
  {
    find: `    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user }, error: userErr } = await sb.auth.getUser();
    if (userErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });`,
    replace: REPLACE_4SP,
  },
  // Variant: blank line between if(!token) and const sb (single-line short).
  {
    find: `    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });`,
    replace: REPLACE_4SP,
  },
  // Variant: blank line + error: userErr destructure.
  {
    find: `    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = supabaseServer(token);
    const { data: { user }, error: userErr } = await sb.auth.getUser();
    if (userErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });`,
    replace: REPLACE_4SP,
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

const report = { fully_migrated: [], no_change: [], not_applicable: [] };

for (const f of files) {
  const before = fs.readFileSync(f, "utf8");
  if (!before.includes("getBearer(req)")) {
    report.not_applicable.push(path.relative(ROOT, f));
    continue;
  }
  if (before.includes("requireAuthenticated") || before.includes("requirePlatformAdmin")) {
    report.not_applicable.push(path.relative(ROOT, f));
    continue;
  }
  const imp = applyVariants(before, IMPORT_VARIANTS);
  const blk = applyVariants(imp.out, AUTH_BLOCK_VARIANTS);
  if (imp.changed && blk.changed) {
    fs.writeFileSync(f, blk.out, "utf8");
    report.fully_migrated.push(path.relative(ROOT, f));
  } else {
    report.no_change.push(path.relative(ROOT, f));
  }
}

console.log(`\n=== F22 Step 3 finale follow-up summary ===`);
console.log(`Fully migrated: ${report.fully_migrated.length}`);
for (const f of report.fully_migrated) console.log(`  + ${f}`);
console.log(`\nNon-standard auth pattern (still on getBearer): ${report.no_change.length}`);
for (const f of report.no_change) console.log(`  ? ${f}`);
