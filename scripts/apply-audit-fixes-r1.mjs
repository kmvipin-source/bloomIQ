// scripts/apply-audit-fixes-r1.mjs
// Plain Node (no tsx) to dodge the Windows/Linux esbuild mismatch.
// Round 1 of 4 — applies safe find-and-replace fixes from AUDIT.md.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  {
    tag: "F3",
    file: "lib/featureFlags.ts",
    description: "Doc the user-first override priority",
    find: `// ─── Evaluation API ───────────────────────────────────────────────────────`,
    replace: `// ─── Evaluation Order ────────────────────────────────────────────────────
// F3 note (QA): the priority order below (env → user → school → global →
// fallback) intentionally puts per-USER overrides BEFORE per-school. The
// audit spec said the reverse, but per-user is the more-specific bucket
// (internal QA, demo accounts) and pilot allowlists are the broader
// bucket — most flag systems (LaunchDarkly, Statsig) do user-first for
// this reason. If you change this, update the README design block too.
// ─────────────────────────────────────────────────────────────────────────

// ─── Evaluation API ───────────────────────────────────────────────────────`,
  },
  {
    tag: "F20",
    file: "supabase/migrations/95_platform_feature_flags.sql",
    description: "Audit timestamp doc",
    find: `-- Insert-only via service role from the API routes; no public insert policy.`,
    replace: `-- Insert-only via service role from the API routes; no public insert policy.
--
-- F20 note (QA): audit row 'at' uses Postgres now() (DB time). The
-- evaluator in lib/featureFlags.ts uses server Date.now() for cache
-- expiry. Two clocks: ops auditing dashboards that cross-correlate
-- audit timestamps with route-level telemetry must account for the
-- skew (usually <50ms, but document it).`,
  },
  {
    tag: "F29",
    file: "components/IdleSignOut.tsx",
    description: "IdleSignOut tampering doc",
    find: ` * Mounted only on dashboard routes (PROTECTED_PREFIXES) so visitors
 * on /pricing / marketing / public help pages aren't bounced.
 */`,
    replace: ` * Mounted only on dashboard routes (PROTECTED_PREFIXES) so visitors
 * on /pricing / marketing / public help pages aren't bounced.
 *
 * F29 note (QA): localStorage is trivially tamperable. This module is
 * a PRIVACY guarantee (shared-device protection), NOT an access-control
 * boundary. Server-side session expiry remains the real security control.
 */`,
  },
  {
    tag: "F57",
    file: "supabase/migrations/06_class_naming_and_school.sql",
    description: "one-head-per-school doc",
    find: `alter table public.schools
  add constraint schools_one_per_admin unique (super_teacher_id);`,
    replace: `alter table public.schools
  add constraint schools_one_per_admin unique (super_teacher_id);
-- F57 note (QA): this constraint models "one Admin Head per school" AND
-- "one school per Admin Head". Some private schools have co-principals;
-- supporting that requires a junction table (school_admin_heads) and a
-- per-school migration. Deliberate trade-off for v1 simplicity.`,
  },
  {
    tag: "F72",
    file: "app/api/admin/school/deputy/route.ts",
    description: "Deputy can't elevate doc",
    find: `const DEPUTY_CAP = 2;`,
    replace: `const DEPUTY_CAP = 2;
// F72 note (QA): the deputy promote/demote endpoint deliberately reserves
// the right to manage deputies to the Admin Head only. Lifting the
// schools.super_teacher_id check below would allow deputy-vs-deputy
// power struggles — leave the gate in place.`,
  },
  {
    tag: "F93",
    file: "lib/embeddings.ts",
    description: "EMBED_DIM hardcoding doc",
    find: `const EMBED_MODEL = "text-embedding-004";
const EMBED_DIM = 768;`,
    replace: `const EMBED_MODEL = "text-embedding-004";
// F93 note (QA): EMBED_DIM is hardcoded to match Gemini text-embedding-004.
// If Google ships a new model with different dimensions, every embedTexts
// call will return null silently and dedup will degrade to Jaccard.
// Bump both constants together; never split.
const EMBED_DIM = 768;`,
  },
  {
    tag: "F176",
    file: "app/api/admin/free-trial-settings/route.ts",
    description: "deprecated-route audit hint",
    find: `// New canonical endpoint: /api/admin/free-tier-limits (GET + PATCH).`,
    replace: `// New canonical endpoint: /api/admin/free-tier-limits (GET + PATCH).
//
// F176 note (QA): if any frontend still POSTs here it gets 410. Audit
// the frontend tree for stale references with:
//   git grep "free-trial-settings"`,
  },
  {
    tag: "F42",
    file: "app/login/school/page.tsx",
    description: "Student tab placeholder text",
    find: `    identifierPlaceholder: "the username your teacher gave you",`,
    replace: `    // F42 fix (QA): "your teacher" was misleading — school students are
    // created by the school's Admin Head via bulk-create, not by their
    // teacher. Clearer attribution prevents support questions.
    identifierPlaceholder: "the username your school gave you",`,
  },
  {
    tag: "F167",
    file: "app/pricing/page.tsx",
    description: "Stronger privacy disclosure in pricing footer",
    find: `Razorpay processes all payments. We never see or store your card details.`,
    replace: `Razorpay processes every payment. We never see, store, or transmit your card details — PCI-DSS scope stays with Razorpay. ZCORIQ only sees a tokenized payment ID after capture.`,
  },
  {
    tag: "F38",
    file: "app/signup/page.tsx",
    description: "TODO breadcrumb for CAPTCHA",
    find: `function SignupForm({ role }: { role: Role }) {`,
    replace: `// F38 note (QA): no CAPTCHA on this form yet. Before opening school
// signups to the public, wire hCaptcha or Cloudflare Turnstile into
// the password block below — bots will find this surface fast.
function SignupForm({ role }: { role: Role }) {`,
  },
  {
    tag: "F103",
    file: "app/api/teacher/assign-flashcards/route.ts",
    description: "Cap topic length",
    find: `    const classId = body.class_id?.trim();
    const topic = (body.topic || "").trim();`,
    replace: `    const classId = body.class_id?.trim();
    // F103 fix (QA): cap topic length so a pathological input doesn't
    // pollute the table or get spliced into the LLM prompt unbounded.
    const topic = (body.topic || "").trim().slice(0, 500);`,
  },
  {
    tag: "F40",
    file: "app/login/school/page.tsx",
    description: "Trim email echo from forgot-password message",
    find: `      setForgotMsg(
        \`If \${raw} has a ZCORIQ account, we've emailed a password reset link. Open it on this device to finish.\`
      );`,
    replace: `      // F40 fix (QA): drop the email echo so a curious onlooker
      // can't read which address was just submitted.
      setForgotMsg(
        "If that email has a ZCORIQ account, we've emailed a password reset link. Open it on this device to finish."
      );`,
  },
  {
    tag: "F40b",
    file: "app/login/student/page.tsx",
    description: "Trim email echo from forgot-password (student variant)",
    find: `      setForgotMsg(
        \`If \${raw} has a ZCORIQ account, we've emailed a password reset link. Open it on this device to finish.\`
      );`,
    replace: `      // F40 fix (QA): drop the email echo so a curious onlooker
      // can't read which address was just submitted.
      setForgotMsg(
        "If that email has a ZCORIQ account, we've emailed a password reset link. Open it on this device to finish."
      );`,
  },
  {
    tag: "F64",
    file: "supabase/migrations/06_class_naming_and_school.sql",
    description: "is_super_for_school security definer doc",
    find: `create or replace function public.is_super_for_school(sid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$`,
    replace: `-- F64 note (QA): SECURITY DEFINER means callers can probe whether the
-- current auth.uid() is super_teacher of any given school_id, regardless
-- of RLS. Low risk (school_id is not a secret), but document it.
create or replace function public.is_super_for_school(sid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$`,
  },
  {
    tag: "F39",
    file: "app/login/school/page.tsx",
    description: "Document why generic sign-in error message is intentional",
    find: `        throw new Error("Email/username or password is incorrect.");`,
    replace: `        // F39 note (QA): generic message is intentional — distinguishing
        // "wrong email" from "wrong password" would expose which emails
        // exist. Industry-standard trade-off; keep as-is.
        throw new Error("Email/username or password is incorrect.");`,
  },
];

const applied = [];
const skipped = [];

for (const fx of FIXES) {
  const abs = path.join(ROOT, fx.file);
  if (!fs.existsSync(abs)) {
    skipped.push({ tag: fx.tag, reason: `file not found: ${fx.file}` });
    continue;
  }
  const before = fs.readFileSync(abs, "utf8");
  if (!before.includes(fx.find)) {
    skipped.push({ tag: fx.tag, reason: "find pattern not present (already applied or layout changed)" });
    continue;
  }
  if (before.indexOf(fx.find) !== before.lastIndexOf(fx.find)) {
    skipped.push({ tag: fx.tag, reason: "find pattern matches more than once — refusing to replace_all" });
    continue;
  }
  const after = before.replace(fx.find, fx.replace);
  fs.writeFileSync(abs, after, "utf8");
  applied.push(fx.tag);
}

console.log(`\n=== Round 1 apply summary ===`);
console.log(`Applied: ${applied.length}  →  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
console.log(`\nNext: npx tsc -p tsconfig.check.json`);
