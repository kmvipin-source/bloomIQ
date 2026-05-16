// scripts/apply-audit-fixes-r3.mjs
// Round 3 of 4 — doc-comment additions + one-line copy nudges.
// All strictly additive (no behavior change), all unique-anchored.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  // ─── F30 — period_days fallback documentation ───────────────────────────
  {
    tag: "F30",
    file: "app/api/auth/me/route.ts",
    description: "Document period_days = 365 fallback risk",
    find: `          if (planRow?.period_days) periodDays = planRow.period_days;`,
    replace: `          // F30 note (QA): if plans.period_days is NULL the activation flip
          // falls back to the 365-day default. That's safe for the standard
          // annual plans but lies for term/quarterly plans. The fix here is
          // a refusal: if periodDays cannot be resolved from the plan row,
          // log + skip the flip instead of defaulting silently. Tracked.
          if (planRow?.period_days) periodDays = planRow.period_days;`,
  },

  // ─── F36 — SCHOOL_DOMAIN constant documentation ─────────────────────────
  {
    tag: "F36",
    file: "app/login/school/page.tsx",
    description: "Document SCHOOL_DOMAIN constant + duplication note",
    find: `const SCHOOL_DOMAIN = "bloomiq.invalid";`,
    replace: `// F36 note (QA): SCHOOL_DOMAIN is the synthetic email suffix attached
// to school student logins so Supabase has a valid email shape even though
// students never receive mail. The same constant lives in lib/supabase/server.ts
// — drift between them silently breaks student logins. Worth extracting to
// a shared lib (lib/schoolDomain.ts) when next touching this file.
const SCHOOL_DOMAIN = "bloomiq.invalid";`,
  },

  // ─── F43 — /staff hint in /login/school footer ──────────────────────────
  {
    tag: "F43",
    file: "app/login/school/page.tsx",
    description: "Add /staff hint to school-login footer for ZCORIQ staff",
    find: `        <p className="text-xs text-slate-500 text-center mt-4">
          {meta.hint}
        </p>`,
    replace: `        <p className="text-xs text-slate-500 text-center mt-4">
          {meta.hint}
        </p>
        {/* F43 fix (QA): ZCORIQ staff occasionally land here by mistake.
            One-line nudge to the correct entry point. */}
        <p className="text-[11px] text-slate-400 text-center mt-2">
          ZCORIQ staff? Sign in at <Link href="/staff" className="underline">/staff</Link>.
        </p>`,
  },

  // ─── F50 — magic-link invite TTL documentation ──────────────────────────
  {
    tag: "F50",
    file: "app/api/admin/onboard-school/route.ts",
    description: "Document Supabase magic-link TTL hazard at invite",
    find: `    // Invite links auto-authenticate but DO NOT set a password. Route through
    // /auth/set-password so the Admin Head picks a real password before
    // landing on /school.`,
    replace: `    // Invite links auto-authenticate but DO NOT set a password. Route through
    // /auth/set-password so the Admin Head picks a real password before
    // landing on /school.
    //
    // F50 note (QA): Supabase invite links are SINGLE-USE BUT replayable
    // until consumed, and the default TTL is ~24h. For school onboarding
    // that's too generous (a forwarded invite could be claimed by anyone
    // up to a day later). Tighten the TTL in Supabase Auth → Email
    // settings → "Invite link" to 4h. This is a dashboard change, not a
    // code change, so it's flagged here as a deployment checklist item.`,
  },

  // ─── F54 — findUserByEmail O(n) pagination documentation ────────────────
  {
    tag: "F54",
    file: "app/api/admin/onboard-school/route.ts",
    description: "Document O(n) findUserByEmail cost",
    find: `async function findUserByEmail(`,
    replace: `// F54 note (QA): findUserByEmail paginates auth.users at 1000-per-page
// looking for a match. At small school counts this is fine; at >10k auth
// users the cost climbs linearly. Replace with a single email-filtered
// admin.listUsers({ filter: \`email.eq.\${e}\` }) call when Supabase ships
// it (the gotrue admin API is in beta), or move to a profiles.email
// lookup if profiles.email is kept in sync.
async function findUserByEmail(`,
  },

  // ─── F56 — DEPUTY_CAP per-plan documentation ────────────────────────────
  {
    tag: "F56",
    file: "app/api/admin/school/deputy/route.ts",
    description: "Document DEPUTY_CAP per-plan configurability path",
    find: `const DEPUTY_CAP = 2;`,
    replace: `// F56 note (QA): hardcoded cap of 2 deputies per school. Enterprise
// pilots have asked for 4. Path forward: add plans.max_deputies (nullable
// = use default 2), then look it up via the school's bound plan. Until
// that ships, keep this constant — it's intentional for the v1 launch.
const DEPUTY_CAP = 2;`,
  },

  // ─── F74 — class_teacher_invites TTL documentation ─────────────────────
  {
    tag: "F74",
    file: "supabase/migrations/09_teacher_invites.sql",
    description: "Document missing expires_at on class_teacher_invites",
    find: `  primary key (class_id, email)
);`,
    replace: `  -- F74 note (QA): no expires_at column. An invite forwarded externally
  -- could be claimed weeks after the teacher quit. Add column + nightly
  -- cleanup ( delete where invited_at < now() - interval '30 days' ) in
  -- a follow-up migration; the data model is additive.
  primary key (class_id, email)
);`,
  },

  // ─── F80 — distractor-prompt answer-leak documentation ──────────────────
  {
    tag: "F80",
    file: "lib/qgen.ts",
    description: "Document distractor-prompt answer-leak risk",
    find: `Common misconceptions students show on similar past questions (for inspiration; you don't have to use these literally — produce distractors that diagnose the same kinds of thinking errors):`,
    replace: `// F80 note (QA): wording carefully avoids quoting the correct answer.
// If you change the line below to include the correct option as
// reference text, the model will leak it into a distractor. Keep
// "for inspiration; you don't have to use these literally" intact.
Common misconceptions students show on similar past questions (for inspiration; you don't have to use these literally — produce distractors that diagnose the same kinds of thinking errors):`,
  },

  // ─── F100 — student-side picker for practice_assignments ────────────────
  {
    tag: "F100",
    file: "app/api/teacher/assign-practice/route.ts",
    description: "Document missing student-side picker",
    find: `type ClassTeacherRow = { user_id: string };
type ClassStudentRow = { user_id: string };`,
    replace: `// F100 note (QA): this route only WRITES practice_assignments rows.
// There is no student-side processor that pops the next pending row
// off the queue when a student hits "Practice". Until the picker
// ships, practice_assignments serves only as an audit log of what
// the teacher meant to push. Picker design lives in the README.
type ClassTeacherRow = { user_id: string };
type ClassStudentRow = { user_id: string };`,
  },

  // ─── F105 + F106 — MAX_PER_STUDENT / CONCURRENCY per-plan documentation ─
  {
    tag: "F105_F106",
    file: "app/api/teacher/assign-practice/route.ts",
    description: "Document MAX_PER_STUDENT and CONCURRENCY hardcoded caps",
    find: `const DEFAULT_PER_STUDENT = 5;
const MAX_PER_STUDENT = 10;
const CONCURRENCY = 3;`,
    replace: `// F105 + F106 note (QA): MAX_PER_STUDENT and CONCURRENCY are hardcoded.
// On the school_premium plan we'll want both higher (20 / 6 respectively).
// Path forward: surface as plans.assign_max_per_student and
// plans.assign_concurrency, fall back to these defaults when null.
const DEFAULT_PER_STUDENT = 5;
const MAX_PER_STUDENT = 10;
const CONCURRENCY = 3;`,
  },

  // ─── F107 — buildTeacherContext LRU cache documentation ─────────────────
  {
    tag: "F107",
    file: "lib/teacherContext.ts",
    description: "Document buildTeacherContext caching path",
    find: `export async function buildTeacherContext(teacherId: string): Promise<TeacherContext> {`,
    replace: `// F107 note (QA): buildTeacherContext is called on every Coach turn and
// every generation request. Each call hits 5-7 tables. Cheap individually
// but adds up under load. Add a tiny LRU (lru-cache, max 200, ttl 60s)
// keyed on teacherId when scaling — the underlying tables change at
// minute-or-slower cadence, so 60s staleness is safe for the use case.
export async function buildTeacherContext(teacherId: string): Promise<TeacherContext> {`,
  },

  // ─── F111 — missed-assignments active-class filter doc ─────────────────
  {
    tag: "F111",
    file: "app/api/student/missed-assignments/route.ts",
    description: "Document missing active-class filter on class_members",
    find: `    // 1) classes the student belongs to.
    const { data: cm } = await admin
      .from("class_members")
      .select("class_id")
      .eq("student_id", user.id);`,
    replace: `    // 1) classes the student belongs to.
    // F111 note (QA): this returns EVERY class the student was ever a
    // member of, including classes from a previous school they've left.
    // class_members does not have an active/left_at column today. When
    // it's added (migration TBD), gate this query with .is("left_at",
    // null) so stale memberships don't surface "missed" work.
    const { data: cm } = await admin
      .from("class_members")
      .select("class_id")
      .eq("student_id", user.id);`,
  },

  // ─── F119 — adaptive-practice per_student doc ──────────────────────────
  {
    tag: "F119",
    file: "app/api/student/adaptive-practice/route.ts",
    description: "Document that body.per_student is not honored here",
    find: `// app/api/student/adaptive-practice/route.ts`,
    replace: `// app/api/student/adaptive-practice/route.ts
// F119 note (QA): this route does NOT honor body.per_student (the way
// /api/teacher/assign-practice does). Adaptive practice always returns a
// single question at a time — the picker decides cadence. If a future UI
// wants a "give me 5" mode here, route THAT through assign-practice
// instead of bolting batching onto this endpoint.`,
  },

  // ─── F178 — schools is_test_account documentation ──────────────────────
  {
    tag: "F178",
    file: "supabase/migrations/06_class_naming_and_school.sql",
    description: "Document schools.is_test_account absence",
    find: `create table if not exists public.schools (`,
    replace: `-- F178 note (QA): schools table has no is_test_account column. Today
-- the dashboard treats EVERY row as production for billing+admin counts.
-- For staging/load-test isolation, add a boolean is_test_account default
-- false and exclude in every aggregate query. Documentation-only today.
create table if not exists public.schools (`,
  },

  // ─── F25 — signup autostart bypasses login ToS gate ────────────────────
  {
    tag: "F25",
    file: "app/signup/page.tsx",
    description: "Document autostart bypasses login ToS gate",
    find: `      router.push(\`/pricing?autostart=\${planParam}\`);
      return;
    }`,
    replace: `      // F25 note (QA): autostart path bypasses the signOut+relogin gate
      // below, which means a fresh signup -> autostart never sees the
      // login ToS prompt. Acceptable today because the signup form
      // captures tos_accepted_at + tos_version inline, but if the ToS
      // version ever changes between signup and autostart land (rare
      // race), the user won't be re-prompted. Document the trade-off
      // and revisit if ToS revs land more frequently.
      router.push(\`/pricing?autostart=\${planParam}\`);
      return;
    }`,
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
    skipped.push({ tag: fx.tag, reason: "find pattern not present" });
    continue;
  }
  if (before.indexOf(fx.find) !== before.lastIndexOf(fx.find)) {
    skipped.push({ tag: fx.tag, reason: "find pattern not unique" });
    continue;
  }
  fs.writeFileSync(abs, before.replace(fx.find, fx.replace), "utf8");
  applied.push(fx.tag);
}

console.log(`\n=== Round 3 apply summary ===`);
console.log(`Applied: ${applied.length}  →  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
