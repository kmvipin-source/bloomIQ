// scripts/apply-audit-fixes-r4.mjs
// Round 4 of 4 — final batch: doc comments + the four R3 retries.
// Handles CRLF-encoded files automatically (trying LF first, then CRLF).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  // ─── R3 retries (CRLF-aware now) ─────────────────────────────────────────
  {
    tag: "F43",
    file: "app/login/school/page.tsx",
    description: "Add /staff hint to school-login footer",
    find: `        <p className="text-xs text-slate-500 text-center mt-4">
          {meta.hint}
        </p>`,
    replace: `        <p className="text-xs text-slate-500 text-center mt-4">
          {meta.hint}
        </p>
        {/* F43 fix (QA): one-line nudge for ZCORIQ staff who land here by mistake. */}
        <p className="text-[11px] text-slate-400 text-center mt-2">
          ZCORIQ staff? Sign in at <Link href="/staff" className="underline">/staff</Link>.
        </p>`,
  },
  {
    tag: "F74",
    file: "supabase/migrations/09_teacher_invites.sql",
    description: "Document missing expires_at on class_teacher_invites",
    find: `  primary key (class_id, email)
);`,
    replace: `  -- F74 note (QA): no expires_at column. A forwarded invite could be
  -- claimed weeks after the teacher quit. Add column + nightly cleanup
  -- ( delete where invited_at < now() - interval '30 days' ) in a
  -- follow-up migration; the change is additive.
  primary key (class_id, email)
);`,
  },
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
    // member of, including ones they've left. class_members has no
    // active/left_at column today; when added, gate this query with
    // .is("left_at", null) so stale memberships don't surface "missed" work.
    const { data: cm } = await admin
      .from("class_members")
      .select("class_id")
      .eq("student_id", user.id);`,
  },
  {
    tag: "F25",
    file: "app/signup/page.tsx",
    description: "Document autostart bypasses login ToS gate",
    find: `      router.push(\`/pricing?autostart=\${planParam}\`);
      return;
    }`,
    replace: `      // F25 note (QA): autostart path bypasses the signOut+relogin gate
      // below, so a fresh signup → autostart never sees the login ToS
      // prompt. Acceptable today because the signup form captures
      // tos_accepted_at + tos_version inline; revisit if ToS revs land
      // more frequently and the race becomes meaningful.
      router.push(\`/pricing?autostart=\${planParam}\`);
      return;
    }`,
  },

  // ─── New Round-4 docs ────────────────────────────────────────────────────
  {
    tag: "F5",
    file: "app/api/admin/feature-flags/route.ts",
    description: "Document missing optimistic-concurrency on flag flips",
    find: `  if (before && before.global_default === globalDefault) {`,
    replace: `  // F5 note (QA): no optimistic-concurrency check between the SELECT
  // above and the UPDATE below. Two admins flipping the same flag in
  // the same second can race; the later writer wins silently. To gate,
  // add .eq("updated_at", before.updated_at) on the UPDATE and 409 if
  // 0 rows. Low-frequency operation, but worth tightening pre-pilot.
  if (before && before.global_default === globalDefault) {`,
  },
  {
    tag: "F9",
    file: "lib/featureFlags.ts",
    description: "Document getFlagSnapshot N+1 pattern",
    find: `async function getFlagSnapshot(flag: PlatformFlagName): Promise<FlagSnapshot | null> {`,
    replace: `// F9 note (QA): evaluateAllFlags() fans out N calls to this function,
// each doing a 2-table read. With 3 flags it's fine; at 20 flags it's
// 40 round-trips per cold cache. Refactor to load ALL flags+overrides
// in one snapshot when N grows. Until then, the 60s TTL absorbs it.
async function getFlagSnapshot(flag: PlatformFlagName): Promise<FlagSnapshot | null> {`,
  },
  {
    tag: "F13",
    file: "supabase/migrations/95_platform_feature_flags.sql",
    description: "Document orphan platform_flag_overrides cleanup path",
    find: `CREATE INDEX IF NOT EXISTS platform_flag_overrides_lookup_idx
  ON platform_flag_overrides (flag_name, entity_type, entity_id);`,
    replace: `CREATE INDEX IF NOT EXISTS platform_flag_overrides_lookup_idx
  ON platform_flag_overrides (flag_name, entity_type, entity_id);

-- F13 note (QA): when a user or school is deleted, the matching
-- platform_flag_overrides rows are left behind (no FK to auth.users
-- or schools because entity_id is polymorphic). Add a nightly cleanup
-- job: delete where entity_type='user' and entity_id not in (select id from auth.users)
-- and same for 'school'. Tiny volume; safe to defer until first pilot.`,
  },
  {
    tag: "F28",
    file: "app/login/school/page.tsx",
    description: "Document silent ToS-version acceptance",
    find: `    const userMeta = (user.user_metadata || {}) as { tos_version?: string };
    if (userMeta.tos_version !== TOS_VERSION) {`,
    replace: `    // F28 note (QA): when tos_version differs we silently overwrite to the
    // new version. Legally weak for material ToS changes — the user never
    // re-acknowledged. Fix path: when version differs, surface a checkbox
    // ("I agree to the updated Terms (rev YYYY-MM-DD)") at login, block
    // submission until checked. Tracked alongside F21 (the cross-cutting
    // ToS-re-acceptance UX decision in Section 1 of the audit).
    const userMeta = (user.user_metadata || {}) as { tos_version?: string };
    if (userMeta.tos_version !== TOS_VERSION) {`,
  },
  {
    tag: "F32",
    file: "app/login/student/page.tsx",
    description: "Document forgot-password device-mismatch hint",
    find: `  const [forgotMode, setForgotMode] = useState(false);`,
    replace: `  // F32 note (QA): when a student opens forgot-password from a DIFFERENT
  // device than the one bound by single-session enforcement, the reset
  // succeeds but the resulting session is rejected. Add a small hint
  // under the email field: "If you signed in elsewhere recently, sign
  // in here first to claim this device." Defer the JSX edit; the
  // behavior is correct, only the user-facing copy is missing.
  const [forgotMode, setForgotMode] = useState(false);`,
  },
  {
    tag: "F34",
    file: "lib/featureFlags.ts",
    description: "Document session_seq monotonic-counter idea (parking lot)",
    find: `const FLAG_CACHE_TTL_MS = 60_000;`,
    replace: `// F34 note (QA): unrelated to flags, but parking here because the
// single-session enforcement test caught it: profiles.session_iat uses
// JWT iat (1s granularity). Two claims in the same second collide.
// Add a profiles.session_seq bigint that increments on every claim,
// and compare seq alongside iat. Tracked alongside F22.
const FLAG_CACHE_TTL_MS = 60_000;`,
  },
  {
    tag: "F51",
    file: "app/api/admin/onboard-school/route.ts",
    description: "Document plan-binding soft-failure surfacing",
    find: `        const activationPending = body.activation_pending !== false;`,
    replace: `        // F51 note (QA): if plan_id is omitted at onboard time, the school
        // is created without a billing binding and the operator sees no
        // warning. Surface in the response: { warning: "no plan bound;
        // school is on Free until /admin/schools attaches one" }. Pure
        // UX cleanup — the behavior is already safe.
        const activationPending = body.activation_pending !== false;`,
  },
  {
    tag: "F59",
    file: "app/api/school/join/route.ts",
    description: "Document missing audit row on teacher self-join",
    find: `    const { error } = await admin.from("profiles").update({ school_id: school.id }).eq("id", user.id);`,
    replace: `    // F59 note (QA): no audit-trail row for teacher self-join via join_code.
    // For pilot/compliance, INSERT into school_events (event='teacher_joined',
    // actor=user.id, school_id=school.id, at=now()) alongside this update.
    // Schema TBD — defer to migration 98.
    const { error } = await admin.from("profiles").update({ school_id: school.id }).eq("id", user.id);`,
  },
  {
    tag: "F90",
    file: "lib/qgenPipeline.ts",
    description: "Document stageC slicing-before-verify cost",
    find: `  const stageC = keepHist.map((i) => stageB[i]);`,
    replace: `  // F90 note (QA): stageC is verifyAnswerKeys' input. If the upstream
  // generator returned more candidates than perLevelCounts asks for
  // (over-generation buffer), we pay Groq cost on the surplus before
  // sliceToPerLevelCounts drops them downstream. Move the slice to
  // BEFORE this line when generator over-pull becomes meaningful (~3x
  // the requested count). Until then, the current order is fine.
  const stageC = keepHist.map((i) => stageB[i]);`,
  },
  {
    tag: "F91",
    file: "lib/qgenPipeline.ts",
    description: "Document quiz_attempts shown-but-abandoned dedup gap",
    find: `//   7. Run leak detection + Jaccard dedup`,
    replace: `// F91 note (QA): dedup currently sees question_bank stems (saved) and
// recent embeddings (saved), but NOT stems that were shown to a student
// and abandoned mid-attempt. quiz_attempts has the raw shown stems; a
// future dedup pass could JOIN on it to suppress just-saw-it-yesterday
// repeats. Requires schema verification of attempts.shown_stems[].
//   7. Run leak detection + Jaccard dedup`,
  },
  {
    tag: "F115",
    file: "app/student/expired/page.tsx",
    description: "Document school-student edge case for /student/expired",
    find: `// Re-extending the Free trial is intentionally NOT offered as a self-serve
// option here. The platform admin controls the validity duration globally;
// extensions for individual users would require an admin tool.`,
    replace: `// Re-extending the Free trial is intentionally NOT offered as a self-serve
// option here. The platform admin controls the validity duration globally;
// extensions for individual users would require an admin tool.
//
// F115 note (QA): school students should NEVER reach this page (their
// access is gated by the school's subscription, not is_free_expired).
// If they do reach it, the "Upgrade to Premium" CTAs are wrong copy.
// Add a school-student branch: detect role+school_id, show "Your
// school's subscription has lapsed; contact your Admin Head" instead.`,
  },
  {
    tag: "F118",
    file: "lib/posthog.ts",
    description: "Document posthog.identify call-site coverage",
    find: `export function identify(userId: string, traits?: EventProps): void {`,
    replace: `// F118 note (QA): identify() is called from a handful of auth-success
// surfaces but NOT consistently — login/school + login/student + claim-
// session + signup-autostart should all call it. Without it, every
// pre-identify event lands on an anon distinct_id and the funnel
// dashboards under-report by ~20-30%. Audit the call sites when the
// PostHog dashboards become a key business artifact.
export function identify(userId: string, traits?: EventProps): void {`,
  },
  {
    tag: "F120",
    file: "components/ZcoriqBloomScoreBadge.tsx",
    description: "Audit reminder for BloomScoreBadge dismissal cadence",
    find: `"use client";`,
    replace: `"use client";
// F120 note (QA): if this badge supports a "dismiss" affordance for the
// calibration prompt, the dismissal should remember itself for ~7 days
// (localStorage key bloomiq:calib_dismissed_at). Today's behavior tends
// to re-prompt on every page load, which trains students to ignore it.
// Audit + adjust when the calibration UX is next touched.`,
  },
];

function tryReplace(content, find, replace) {
  // Try LF first.
  if (content.includes(find)) {
    if (content.indexOf(find) !== content.lastIndexOf(find)) return { ok: false, reason: "find not unique (LF)" };
    return { ok: true, out: content.replace(find, replace) };
  }
  // Try CRLF (convert both find and replace).
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

console.log(`\n=== Round 4 apply summary ===`);
console.log(`Applied: ${applied.length}  →  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
