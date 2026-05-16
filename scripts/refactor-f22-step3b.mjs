// scripts/refactor-f22-step3b.mjs
// F22 Step 3 batch 2 — 5 more mutating non-admin routes.
//
// Routes covered:
//   1. /api/school/join/route.ts          (2 auth blocks: POST + DELETE)
//   2. /api/teacher/retake-requests/route.ts
//   3. /api/flashcards/route.ts
//   4. /api/generate/route.ts             (teacher question-bank writer)
//   5. /api/student/quick-test/route.ts

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Common patterns — defined once so the per-fix blocks read cleanly.
const STD_IMPORT = `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`;
const STD_IMPORT_REPLACE = `import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";`;

const STD_AUTH_BLOCK_4SP = `    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });`;

const STD_AUTH_BLOCK_REPLACE_4SP = `    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat ≥ profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;`;

const FIXES = [
  // ─── 1. school/join (POST) ──────────────────────────────────────────────
  {
    tag: "SchoolJoin_import",
    file: "app/api/school/join/route.ts",
    description: "Add helper import",
    find: STD_IMPORT,
    replace: STD_IMPORT_REPLACE,
  },
  // POST block (lines ~37-42) and DELETE block (lines ~104-109) are
  // byte-identical, so we need replace-all. Do it via post-step.

  // ─── 2. teacher/retake-requests ─────────────────────────────────────────
  {
    tag: "Retake_import",
    file: "app/api/teacher/retake-requests/route.ts",
    description: "Add helper import",
    find: STD_IMPORT,
    replace: STD_IMPORT_REPLACE,
  },
  {
    tag: "Retake_block",
    file: "app/api/teacher/retake-requests/route.ts",
    description: "Replace inline auth block",
    find: STD_AUTH_BLOCK_4SP,
    replace: STD_AUTH_BLOCK_REPLACE_4SP,
  },

  // ─── 3. flashcards ──────────────────────────────────────────────────────
  {
    tag: "Flashcards_import",
    file: "app/api/flashcards/route.ts",
    description: "Add helper import",
    find: STD_IMPORT,
    replace: STD_IMPORT_REPLACE,
  },
  {
    tag: "Flashcards_block",
    file: "app/api/flashcards/route.ts",
    description: "Replace inline auth block",
    find: STD_AUTH_BLOCK_4SP,
    replace: STD_AUTH_BLOCK_REPLACE_4SP,
  },

  // ─── 4. generate (teacher question-bank writer) ─────────────────────────
  {
    tag: "Generate_import",
    file: "app/api/generate/route.ts",
    description: "Add helper import",
    find: STD_IMPORT,
    replace: STD_IMPORT_REPLACE,
  },
  {
    tag: "Generate_block",
    file: "app/api/generate/route.ts",
    description: "Replace inline auth block",
    find: STD_AUTH_BLOCK_4SP,
    replace: STD_AUTH_BLOCK_REPLACE_4SP,
  },

  // ─── 5. student/quick-test ──────────────────────────────────────────────
  {
    tag: "QuickTest_import",
    file: "app/api/student/quick-test/route.ts",
    description: "Add helper import",
    find: STD_IMPORT,
    replace: STD_IMPORT_REPLACE,
  },
  {
    tag: "QuickTest_block",
    file: "app/api/student/quick-test/route.ts",
    description: "Replace inline auth block",
    find: STD_AUTH_BLOCK_4SP,
    replace: STD_AUTH_BLOCK_REPLACE_4SP,
  },
];

function tryReplace(content, find, replace) {
  if (content.includes(find)) {
    if (content.indexOf(find) !== content.lastIndexOf(find)) return { ok: false, reason: "find not unique (LF)" };
    return { ok: true, out: content.replace(find, replace) };
  }
  const findCrlf = find.replace(/\r?\n/g, "\r\n");
  const replaceCrlf = replace.replace(/\r?\n/g, "\r\n");
  if (content.includes(findCrlf)) {
    if (content.indexOf(findCrlf) !== content.lastIndexOf(findCrlf)) return { ok: false, reason: "find not unique (CRLF)" };
    return { ok: true, out: content.replace(findCrlf, replaceCrlf) };
  }
  return { ok: false, reason: "find pattern not present (LF or CRLF)" };
}

const applied = [];
const skipped = [];

for (const fx of FIXES) {
  const abs = path.join(ROOT, fx.file);
  if (!fs.existsSync(abs)) {
    skipped.push({ tag: fx.tag, reason: `file not found: ${fx.file}` });
    continue;
  }
  const before = fs.readFileSync(abs, "utf8");
  const r = tryReplace(before, fx.find, fx.replace);
  if (!r.ok) {
    skipped.push({ tag: fx.tag, reason: r.reason });
    continue;
  }
  fs.writeFileSync(abs, r.out, "utf8");
  applied.push(fx.tag);
}

// Post-step: school/join has TWO byte-identical auth blocks (POST + DELETE).
{
  const abs = path.join(ROOT, "app/api/school/join/route.ts");
  if (fs.existsSync(abs)) {
    let s = fs.readFileSync(abs, "utf8");
    const before = s;
    while (s.includes(STD_AUTH_BLOCK_4SP)) {
      s = s.replace(STD_AUTH_BLOCK_4SP, STD_AUTH_BLOCK_REPLACE_4SP);
    }
    if (s !== before) {
      fs.writeFileSync(abs, s, "utf8");
      applied.push("SchoolJoin_blocks_replace_all");
    } else {
      skipped.push({ tag: "SchoolJoin_blocks_replace_all", reason: "no occurrences (already migrated?)" });
    }
  }
}

console.log(`\n=== F22 Step 3 batch 2 summary ===`);
console.log(`Applied: ${applied.length}  →  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
