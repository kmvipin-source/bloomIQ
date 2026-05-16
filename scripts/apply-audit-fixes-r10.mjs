// scripts/apply-audit-fixes-r10.mjs
// Round 10 — 5 doc notes for deferred Section-5 refactors.
// These add breadcrumbs at the code sites where the refactor would land,
// so the next maintainer sees the deferred work without opening AUDIT.md.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  // ─── F4 retry — anchor on the toggleGlobal function ───────────────────
  {
    tag: "F4",
    file: "app/admin/feature-flags/page.tsx",
    description: "Document window.prompt v1 trade-off (at the first call site)",
    find: `  async function toggleGlobal(flag: FlagRow) {
    const newValue = !flag.globalDefault;
    const reason = window.prompt(`,
    replace: `  // F4 note (QA): the four window.prompt calls in this file are
  // intentional v1 — keeps the admin UI dependency-free. Cons: no
  // validation feedback before submit, no multi-line input, can't
  // distinguish "cancel" from "empty string" in some browsers. Upgrade
  // to a <Dialog/> when adding any other admin-UI modal (consolidate
  // the modal infra, don't fragment).
  async function toggleGlobal(flag: FlagRow) {
    const newValue = !flag.globalDefault;
    const reason = window.prompt(`,
  },

  // ─── F22 — single-session enforcement helper (Section 5 refactor) ────
  {
    tag: "F22",
    file: "lib/supabase/server.ts",
    description: "Doc the deferred requireAuthenticated() helper refactor",
    find: `export function supabaseServer(accessToken?: string) {`,
    replace: `// F22 note (QA): single-session enforcement (checking JWT iat against
// profiles.session_iat) is implemented in /api/auth/me but NOT in the
// other ~30 mutating API routes. Refactor: add requireAuthenticated(req)
// here that returns { user, session_iat } and 401s if iat is stale;
// migrate all mutating routes to use it. Touches ~30 files but the per-
// route delta is ~3 lines. Track alongside F171 (requirePlatformAdmin
// extraction) — they're sister refactors.
export function supabaseServer(accessToken?: string) {`,
  },

  // ─── F171 — requirePlatformAdmin helper (Section 5 refactor) ─────────
  {
    tag: "F171",
    file: "app/api/admin/feature-flags/route.ts",
    description: "Doc the requirePlatformAdmin extraction path",
    find: `async function requirePlatformAdmin(req: Request) {`,
    replace: `// F171 note (QA): requirePlatformAdmin is duplicated across ~10 admin
// routes. Extract to lib/adminAuth.ts (alongside the F22 single-session
// helper) and import everywhere. Single source of truth for "who is a
// platform admin" so future audit-log requirements ship in one place.
async function requirePlatformAdmin(req: Request) {`,
  },

  // ─── F101 + F113 — qgenPipeline migration tracker ────────────────────
  {
    tag: "F101_F113",
    file: "lib/qgenPipeline.ts",
    description: "Doc the remaining generator-route migrations",
    find: `// lib/qgenPipeline.ts`,
    replace: `// lib/qgenPipeline.ts
// F101 + F113 note (QA): two of the seven generator routes still copy
// the conceptual pipeline instead of calling here:
//   - /api/teacher/generate/route.ts (F101)
//   - /api/student/quick-test/route.ts (F113)
// Migration plan per route: build context → call processGenerationPipeline
// → write to question_bank. Each migration is ~1 day, including tests.
// Until then, fixes to dedup / leak detection / verifyAnswerKeys must
// be mirrored to all three places — that's the cost of the duplication.`,
  },

  // ─── F178b — Surface is_test_account on /admin/schools too ─────────────
  {
    tag: "F178b",
    file: "supabase/migrations/06_class_naming_and_school.sql",
    description: "Add a note that the schools is_test_account also needs UI",
    find: `-- F178 note (QA): schools table has no is_test_account column. Today`,
    replace: `-- F178b note (QA): when the schools.is_test_account column is added
-- per F178 (above), also wire the /admin/users-style "Beta tester" UI
-- toggle on /admin/schools/[id]. The users page already has the pattern
-- (search "is_test_account" in app/admin/users/page.tsx). Without UI
-- parity, ops will set the flag via raw SQL.
-- F178 note (QA): schools table has no is_test_account column. Today`,
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

console.log(`\n=== Round 10 apply summary ===`);
console.log(`Applied: ${applied.length}  →  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
