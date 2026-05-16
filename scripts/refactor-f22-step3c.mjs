// scripts/refactor-f22-step3c.mjs
// F22 Step 3 batch 3 — 5 more mutating non-admin routes.
//
// Routes covered:
//   1. /api/student/srs-due/route.ts
//   2. /api/student/adaptive-practice/route.ts
//   3. /api/student/join-class/route.ts          (was speed-test on Vipin's
//                                                  list but speed-test
//                                                  doesn't exist; join-class
//                                                  is a clean replacement)
//   4. /api/papers/generate/route.ts
//   5. /api/teacher/classes/route.ts              (different brace style —
//                                                  has its own find pattern)

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const STD_IMPORT_WITH_ADMIN = `import { getBearer, supabaseServer, supabaseAdmin } from "@/lib/supabase/server";`;
const STD_IMPORT_NO_ADMIN = `import { getBearer, supabaseServer } from "@/lib/supabase/server";`;
const REPLACE_WITH_ADMIN = `import { supabaseAdmin } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";`;
const REPLACE_NO_ADMIN = `import { requireAuthenticated } from "@/lib/apiAuth";`;

const STD_AUTH_BLOCK_4SP = `    const token = getBearer(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = supabaseServer(token);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });`;

const STD_AUTH_BLOCK_REPLACE_4SP = `    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;`;

// teacher/classes uses a different multi-line brace style.
const TEACHER_CLASSES_BLOCK = `    const token = getBearer(req);
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const sb = supabaseServer(token);
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }`;
const TEACHER_CLASSES_REPLACE = `    // F22 fix (QA): shared requireAuthenticated — single-session
    // enforcement (token iat >= profiles.session_iat) now applied.
    const auth = await requireAuthenticated(req);
    if ("error" in auth) return auth.error;
    const { user, sb } = auth;`;

const FIXES = [
  // ─── 1. student/srs-due ─────────────────────────────────────────────────
  {
    tag: "Srs_import",
    file: "app/api/student/srs-due/route.ts",
    description: "Add helper import (this file imports only getBearer+supabaseServer)",
    find: STD_IMPORT_NO_ADMIN,
    replace: `import { supabaseServer } from "@/lib/supabase/server";
import { requireAuthenticated } from "@/lib/apiAuth";`,
  },
  {
    tag: "Srs_block",
    file: "app/api/student/srs-due/route.ts",
    description: "Replace inline auth block",
    find: STD_AUTH_BLOCK_4SP,
    replace: STD_AUTH_BLOCK_REPLACE_4SP,
  },

  // ─── 2. student/adaptive-practice ───────────────────────────────────────
  {
    tag: "Adaptive_import",
    file: "app/api/student/adaptive-practice/route.ts",
    description: "Add helper import",
    find: STD_IMPORT_WITH_ADMIN,
    replace: REPLACE_WITH_ADMIN,
  },
  {
    tag: "Adaptive_block",
    file: "app/api/student/adaptive-practice/route.ts",
    description: "Replace inline auth block",
    find: STD_AUTH_BLOCK_4SP,
    replace: STD_AUTH_BLOCK_REPLACE_4SP,
  },

  // ─── 3. student/join-class ──────────────────────────────────────────────
  {
    tag: "JoinClass_import",
    file: "app/api/student/join-class/route.ts",
    description: "Add helper import",
    find: STD_IMPORT_WITH_ADMIN,
    replace: REPLACE_WITH_ADMIN,
  },
  {
    tag: "JoinClass_block",
    file: "app/api/student/join-class/route.ts",
    description: "Replace inline auth block",
    find: STD_AUTH_BLOCK_4SP,
    replace: STD_AUTH_BLOCK_REPLACE_4SP,
  },

  // ─── 4. papers/generate ─────────────────────────────────────────────────
  {
    tag: "Papers_import",
    file: "app/api/papers/generate/route.ts",
    description: "Add helper import",
    find: STD_IMPORT_WITH_ADMIN,
    replace: REPLACE_WITH_ADMIN,
  },
  {
    tag: "Papers_block",
    file: "app/api/papers/generate/route.ts",
    description: "Replace inline auth block",
    find: STD_AUTH_BLOCK_4SP,
    replace: STD_AUTH_BLOCK_REPLACE_4SP,
  },

  // ─── 5. teacher/classes (different shape) ───────────────────────────────
  {
    tag: "TeacherClasses_import",
    file: "app/api/teacher/classes/route.ts",
    description: "Add helper import",
    find: STD_IMPORT_WITH_ADMIN,
    replace: REPLACE_WITH_ADMIN,
  },
  {
    tag: "TeacherClasses_block",
    file: "app/api/teacher/classes/route.ts",
    description: "Replace inline auth block (multi-line brace style)",
    find: TEACHER_CLASSES_BLOCK,
    replace: TEACHER_CLASSES_REPLACE,
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

console.log(`\n=== F22 Step 3 batch 3 summary ===`);
console.log(`Applied: ${applied.length}  →  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
