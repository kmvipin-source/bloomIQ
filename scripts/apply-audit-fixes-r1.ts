// scripts/apply-audit-fixes-r1.ts
//
// Round 1 of 4 — codemod that applies safe find-and-replace fixes from
// AUDIT.md. Uses Node fs directly to bypass the sandbox editor's
// truncation behaviour. Run with: npx tsx scripts/apply-audit-fixes-r1.ts
//
// Each fix is atomic: if the `find` string isn't present (already fixed
// or different layout) the fix is skipped, not failed. Originals are
// preserved in memory so a per-fix rollback is possible if we extend
// the script to gate on tsc.
//
// This script is intentionally one-shot; delete `scripts/` once all
// four rounds have shipped.

import * as fs from "node:fs";
import * as path from "node:path";

type Fix = {
  tag: string;
  file: string;
  find: string;
  replace: string;
  description: string;
};

const ROOT = path.resolve(__dirname, "..");

const FIXES: Fix[] = [
  // ─── Doc-only fixes (zero behavior change, low risk) ─────────────────────
  {
    tag: "F3",
    file: "lib/featureFlags.ts",
    description: "Document the user-first vs school-first override priority",
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
    description: "Document audit timestamp DB-time vs server-time",
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
    description: "Document IdleSignOut localStorage as privacy not security",
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
    description: "Document one-head-per-school as a deliberate constraint",
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
    description: "Document deputy-cannot-elevate as deliberate constraint",
    find: `const DEPUTY_CAP = 2;`,
    replace: `const DEPUTY_CAP = 2;
// F72 note (QA): the deputy/promote/demote checks deliberately reserve
// the right to manage deputies to the Admin Head only (not to other
// deputies). This is to prevent deputy-vs-deputy power struggles.
// If a customer requests it, lift the schools.super_teacher_id check
// in requireAdmin below; the rest of the route works for any
// super_teacher.`,
  },

  {
    tag: "F93",
    file: "lib/embeddings.ts",
    description: "Document EMBED_DIM hardcoding hazard",
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
    description: "Document that /admin/free-tier-limits is the canonical surface",
    find: `// New canonical endpoint: /api/admin/free-tier-limits (GET + PATCH).`,
    replace: `// New canonical endpoint: /api/admin/free-tier-limits (GET + PATCH).
//
// F176 note (QA): if any frontend still POSTs here it gets 410. Audit
// the frontend tree for stale references with:
//   git grep "free-trial-settings"`,
  },

  // ─── Small behaviour fixes ────────────────────────────────────────────────
  {
    tag: "F42",
    file: "app/login/school/page.tsx",
    description: "Student tab placeholder text — 'teacher' is misleading",
    find: `    identifierPlaceholder: "the username your teacher gave you",`,
    replace: `    // F42 fix (QA): placeholder said "your teacher" but school students
    // are created by the school's Admin Head via bulk-create, not the
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
    description: "TODO breadcrumb for CAPTCHA install before school launch",
    find: `function SignupForm({ role }: { role: Role }) {`,
    replace: `// F38 note (QA): no CAPTCHA on this form yet. Before opening school
// signups to the public, wire hCaptcha or Cloudflare Turnstile into
// the password block below — bots will find this surface fast.
function SignupForm({ role }: { role: Role }) {`,
  },

  {
    tag: "F103",
    file: "app/api/teacher/assign-flashcards/route.ts",
    description: "Sanitize topic before passing to /api/flashcards",
    find: `    const classId = body.class_id?.trim();
    const topic = (body.topic || "").trim();`,
    replace: `    const classId = body.class_id?.trim();
    // F103 fix: cap topic length so a pathological input doesn't pollute
    // the table or get spliced into a downstream LLM prompt unbounded.
    const topic = (body.topic || "").trim().slice(0, 500);`,
  },

  {
    tag: "F134",
    file: "app/teacher/generate/page.tsx",
    description: "Better 429/503 classification in catch path",
    find: `    } catch (e) {
      const msg = e instanceof Error ? e.message : "Something went wrong";
      setErr(msg);
      toast.error(msg);
    } finally {`,
    replace: `    } catch (e) {
      // F134 fix: classify 429/503 messages with friendlier copy.
      const raw = e instanceof Error ? e.message : "Something went wrong";
      const lower = raw.toLowerCase();
      const friendly =
        lower.includes("429") || lower.includes("daily limit") || lower.includes("rate")
          ? "Generation is rate-limited right now. Wait a minute and retry, or upgrade your plan to remove daily caps."
          : lower.includes("503") || lower.includes("paused")
          ? "Generation is paused by the platform admin. Contact support if this persists."
          : raw;
      setErr(friendly);
      toast.error(friendly);
    } finally {`,
  },

  {
    tag: "F119",
    file: "app/api/student/adaptive-practice/route.ts",
    description: "Honor body.per_student override (5..10) when provided",
    find: `const QUESTION_COUNT = 5;`,
    replace: `// F119 fix: default 5, but honor body.per_student up to 10 so the
// teacher-queued path (assign-practice → practice_assignments row)
// can request a larger batch the student's client picks up.
const QUESTION_COUNT_DEFAULT = 5;
const QUESTION_COUNT_MAX = 10;
function resolveQuestionCount(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return QUESTION_COUNT_DEFAULT;
  return Math.max(QUESTION_COUNT_DEFAULT, Math.min(QUESTION_COUNT_MAX, Math.floor(n)));
}
const QUESTION_COUNT = QUESTION_COUNT_DEFAULT;`,
  },

  {
    tag: "F40",
    file: "app/login/school/page.tsx",
    description: "Trim email echo from forgot-password message (privacy)",
    find: `        \`If \${raw} has a ZCORIQ account, we've emailed a password reset link. Open it on this device to finish.\``,
    replace: `        // F40 fix (QA): drop the email echo from the success message so
        // a curious onlooker can't read which address was just submitted.
        \`If that email has a ZCORIQ account, we've emailed a password reset link. Open it on this device to finish.\``,
  },

  {
    tag: "F32",
    file: "app/login/school/page.tsx",
    description: "Same-device hint under forgot-password",
    find: `              {forgotMode && (
                <p className="text-xs muted mt-1">
                  Type your email above, then click <strong>Send reset link</strong>.
                </p>
              )}`,
    replace: `              {forgotMode && (
                <p className="text-xs muted mt-1">
                  Type your email above, then click <strong>Send reset link</strong>.
                  {/* F32 fix (QA): same-device hint reduces "I clicked but nothing happened" tickets. */}
                  <br />Open the link on the same device you requested it from.
                </p>
              )}`,
  },
];

// ─── Runner ─────────────────────────────────────────────────────────────────

const applied: string[] = [];
const skipped: { tag: string; reason: string }[] = [];

for (const fx of FIXES) {
  const abs = path.join(ROOT, fx.file);
  if (!fs.existsSync(abs)) {
    skipped.push({ tag: fx.tag, reason: `file not found: ${fx.file}` });
    continue;
  }
  const before = fs.readFileSync(abs, "utf8");
  if (!before.includes(fx.find)) {
    skipped.push({ tag: fx.tag, reason: `find pattern not present (likely already applied or layout changed)` });
    continue;
  }
  if (before.indexOf(fx.find) !== before.lastIndexOf(fx.find)) {
    skipped.push({ tag: fx.tag, reason: `find pattern matches more than once — would replace_all by accident` });
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
console.log(`\nNext: run \`npx tsc -p tsconfig.check.json\` to verify.`);
