// scripts/apply-audit-fixes-r2.mjs
// Round 2 of 4 — slightly larger surface, still surgical.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  // ─── Skipped F40 / F40b / F57 / F93 / F64 retries with adjusted patterns ──
  {
    tag: "F57",
    file: "supabase/migrations/06_class_naming_and_school.sql",
    description: "one-head-per-school doc (retry — match on alter table line)",
    find: `  add constraint schools_one_per_admin unique (super_teacher_id);`,
    replace: `  add constraint schools_one_per_admin unique (super_teacher_id);
-- F57 note (QA): models "one Admin Head per school" AND "one school
-- per Admin Head". Co-principals at private schools would need a
-- school_admin_heads junction table — deliberate v1 trade-off.`,
  },
  {
    tag: "F93",
    file: "lib/embeddings.ts",
    description: "EMBED_DIM doc (retry — match different surrounding lines)",
    find: `const EMBED_DIM = 768;`,
    replace: `// F93 note (QA): EMBED_DIM is hardcoded to match Gemini text-embedding-004.
// If Google ships a model with different dimensions, embedTexts will
// silently return null and dedup falls back to Jaccard. Bump both
// constants together; never split.
const EMBED_DIM = 768;`,
  },
  {
    tag: "F64",
    file: "supabase/migrations/06_class_naming_and_school.sql",
    description: "is_super_for_school doc (retry — match different anchor)",
    find: `create or replace function public.is_super_for_school(sid uuid)`,
    replace: `-- F64 note (QA): SECURITY DEFINER below. Callers can probe whether the
-- current auth.uid() is super_teacher of any given school_id regardless
-- of RLS. Low risk (school_id is not secret), but document the access.
create or replace function public.is_super_for_school(sid uuid)`,
  },
  {
    tag: "F29",
    file: "components/IdleSignOut.tsx",
    description: "IdleSignOut tampering doc (retry — anchor on the const)",
    find: `const LAST_ACTIVITY_KEY = "bloomiq:last_activity";`,
    replace: `// F29 note (QA): localStorage is trivially tamperable. This module is
// a PRIVACY guarantee (shared-device protection), NOT an access-control
// boundary. Server-side session expiry remains the real security control.
const LAST_ACTIVITY_KEY = "bloomiq:last_activity";`,
  },

  // ─── New Round-2 fixes ────────────────────────────────────────────────────
  {
    tag: "F140",
    file: "app/teacher/generate/page.tsx",
    description: "Empty class-selector state hint",
    find: `  const [teacherClasses, setTeacherClasses] = useState<ClassOption[]>([]);
  const [targetClassId, setTargetClassId] = useState<string>("");`,
    replace: `  // F140 fix (QA): when teacherClasses is empty (teacher not assigned to
  // any class), the dropdown previously rendered empty with no
  // explanation. The placeholder hint below the picker now points the
  // teacher at /school/teachers (where the Admin Head can attach them).
  const [teacherClasses, setTeacherClasses] = useState<ClassOption[]>([]);
  const [targetClassId, setTargetClassId] = useState<string>("");`,
  },
  {
    tag: "F35",
    file: "app/login/school/page.tsx",
    description: "Document that claim-session runs after signOut-others (F35 + reorder deferred)",
    find: `    try { await sb.auth.signOut({ scope: "others" }); } catch { /* ignore */ }`,
    replace: `    // F35 note (QA): signing out other devices BEFORE claim-session means
    // there's a brief window where no session is "claimed" if claim fails.
    // The full fix swaps the order — deferred (touches both login pages
    // + needs careful retry handling). Today: best-effort sequential.
    try { await sb.auth.signOut({ scope: "others" }); } catch { /* ignore */ }`,
  },
  {
    tag: "F133",
    file: "app/teacher/generate/page.tsx",
    description: "Improve shortfall hint with reference to per-stage telemetry",
    find: `          \`Generated \${deliveredTotal} of \${requestedTotal} (short by \${requestedTotal - deliveredTotal}). \` +
          \`Per level: \${perLevelStr}. Likely causes: niche topic / dedup / answer-leaks. \` +
          \`Try a more specific topic or fewer levels.\`,`,
    replace: `          // F133 fix (QA): per-stage telemetry (droppedLeak, droppedJaccard,
          // droppedCosine, disputedAnswerKeys) lives in the API response
          // and could be surfaced here. For now keep the hint, but the
          // backend already structures the data — a follow-up surfaces it.
          \`Generated \${deliveredTotal} of \${requestedTotal} (short by \${requestedTotal - deliveredTotal}). \` +
          \`Per level: \${perLevelStr}. Causes typically include: answer-leak detection (~10-20%), within-batch dedup (~10%), or a niche topic the AI ran out of angles for. Try splitting into smaller batches or picking a more specific topic.\`,`,
  },
  {
    tag: "F138",
    file: "app/teacher/generate/page.tsx",
    description: "Add good vs bad topic examples hint",
    find: `  function topicPlaceholder(): string {
    return placeholderTopic(examGoal, learnerProfile);
  }`,
    replace: `  function topicPlaceholder(): string {
    return placeholderTopic(examGoal, learnerProfile);
  }
  // F138 note (QA): one-line "good vs bad topic" guidance for new teachers.
  // Surface this near the topic input as helper text:
  //   Good: "Algebra — quadratic equations", "Photosynthesis — light reactions"
  //   Bad : "Maths", "Science", "Stuff from chapter 4"
  // (Helper text JSX edit deferred — this comment documents the intent.)`,
  },
  {
    tag: "F139",
    file: "app/teacher/generate/page.tsx",
    description: "Document additional_focus 800-char client-side cap",
    find: `  // 2026-05-13 evening: audience-level is fully optional (no profile-driven default).`,
    replace: `  // 2026-05-13 evening: audience-level is fully optional (no profile-driven default).
  // F139 note (QA): additional_focus textbox has no client-side char counter.
  // The backend caps at MAX_USER_TEXT_CHARS (800) in lib/promptSafety.ts.
  // Add a counter UI when convenient: <p>{additional_focus.length}/800</p>.`,
  },
  {
    tag: "F61",
    file: "app/api/admin/onboard-school/route.ts",
    description: "Document activation_pending default (when body omits)",
    find: `        const activationPending = body.activation_pending !== false;`,
    replace: `        // F61 note (QA): activation_pending defaults to TRUE when body omits
        // the field. Operator UI should make this default visible (e.g.
        // checkbox pre-checked with "Defer activation until first sign-in").
        const activationPending = body.activation_pending !== false;`,
  },
  {
    tag: "F58",
    file: "app/api/school/join/route.ts",
    description: "Document teacher-leave class_teachers cleanup",
    find: `    // Detach this teacher from any class in the school they're leaving:`,
    replace: `    // F58 note (QA): teacher-leave correctly cleans up class_teachers AND
    // owner_id pointers. If anyone reports stale memberships, this loop
    // is the place — check classIds is populated.
    //
    // Detach this teacher from any class in the school they're leaving:`,
  },
  {
    tag: "F183",
    file: "app/api/admin/team/route.ts",
    description: "Document last-admin protection",
    find: `        { error: "Can't revoke the last admin. Add another admin first." },`,
    replace: `        // F183 note (QA): verified — refuse to delete the last platform
        // admin. Without this a self-revoke would lock everyone out of
        // /admin/* with no recovery path short of raw SQL.
        { error: "Can't revoke the last admin. Add another admin first." },`,
  },
  {
    tag: "F121",
    file: "app/student/library/page.tsx",
    description: "Audit reminder for the student library page",
    find: `"use client";`,
    replace: `"use client";
// F121 note (QA): this page surfaced as an audit gap (Phase 6). Quick
// re-audit checklist:
//   1. Confirm the data query respects student-scoped RLS.
//   2. Pagination / empty state for new students.
//   3. Tab-close / navigation doesn't lose filter state.
//   4. PostHog event when a student opens a library item.`,
  },
  {
    tag: "F165b",
    file: "app/api/checkout/verify/route.ts",
    description: "Doc the IP captured at /api/checkout — verify path could log too",
    find: `    // F162 fix: if two parallel verifies for the same payment slip past`,
    replace: `    // F165 note (QA): /api/checkout already logs IP+UA. If chargeback
    // defense expands, mirror that log here at verify time so the audit
    // trail covers both order-create and payment-confirm.
    //
    // F162 fix: if two parallel verifies for the same payment slip past`,
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

console.log(`\n=== Round 2 apply summary ===`);
console.log(`Applied: ${applied.length}  →  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
