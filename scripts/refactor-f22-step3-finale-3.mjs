// scripts/refactor-f22-step3-finale-3.mjs
// F22 Step 3 finale, second follow-up — handle multi-line imports +
// the school/transfer SCHOOL_STUDENT_DOMAIN + the generation-fit shape.

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
  // Routes with their own local auth helpers — leave for manual migration.
  path.join(ROOT, "app/api/admin/classes/[id]/co-teachers/route.ts"),
  path.join(ROOT, "app/api/student/share/route.ts"),
]);

const IMPORT_VARIANTS = [
  // Multi-line imports — full block.
  {
    find: `import {
  getBearer,
  supabaseServer,
  supabaseAdmin,
  usernameToSyntheticEmail,
} from "@/lib/supabase/server";`,
    replace: `import {
  supabaseAdmin,
  usernameToSyntheticEmail,
} from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";`,
  },
  // school/transfer specific (has SCHOOL_STUDENT_DOMAIN).
  {
    find: `import { getBearer, supabaseServer, supabaseAdmin, SCHOOL_STUDENT_DOMAIN } from "@/lib/supabase/server";`,
    replace: `import { supabaseAdmin, SCHOOL_STUDENT_DOMAIN } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";`,
  },
  // generation-fit (no admin).
  {
    find: `import { getBearer, supabaseServer } from "@/lib/supabase/server";`,
    replace: `import { supabaseServer } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";`,
  },
];

const REPLACE_4SP = `    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;`;

const AUTH_BLOCK_VARIANTS = [
  // Standard 4sp, single-line braces.
  {
    find: `    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });`,
    replace: REPLACE_4SP,
  },
  // 4sp + blank line before const sb.
  {
    find: `    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });`,
    replace: REPLACE_4SP,
  },
  // Multi-line braces (generation-fit shape).
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

const report = { fully_migrated: [], no_change: [] };

for (const f of files) {
  const before = fs.readFileSync(f, "utf8");
  if (!before.includes("getBearer(req)")) continue;
  if (before.includes("requireAuthenticated") || before.includes("requirePlatformAdmin")) continue;
  const imp = applyVariants(before, IMPORT_VARIANTS);
  const blk = applyVariants(imp.out, AUTH_BLOCK_VARIANTS);
  if (imp.changed && blk.changed) {
    fs.writeFileSync(f, blk.out, "utf8");
    report.fully_migrated.push(path.relative(ROOT, f));
  } else {
    report.no_change.push(path.relative(ROOT, f));
  }
}

console.log(`\n=== F22 Step 3 finale-3 summary ===`);
console.log(`Fully migrated: ${report.fully_migrated.length}`);
for (const f of report.fully_migrated) console.log(`  + ${f}`);
console.log(`\nStill on getBearer (skipped — local helper or non-standard): ${report.no_change.length}`);
for (const f of report.no_change) console.log(`  ? ${f}`);
