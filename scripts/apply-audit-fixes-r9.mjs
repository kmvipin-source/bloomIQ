// scripts/apply-audit-fixes-r9.mjs
// Round 9 — 5 documentation notes for deferred-but-tracked work.
// The pool of codemod-able real fixes is essentially exhausted; these
// breadcrumbs make sure the deferred items remain visible at the relevant
// code site.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  // ─── F4 — admin window.prompt → modal (deferred, doc the trade-off) ───
  {
    tag: "F4",
    file: "app/admin/feature-flags/page.tsx",
    description: "Document why window.prompt is in place + the modal upgrade path",
    find: `    const reason = window.prompt(`,
    replace: `    // F4 note (QA): window.prompt is intentional v1 — keeps the admin UI
    // dependency-free and ships in ~5 lines instead of a 150-line modal.
    // Cons: no validation feedback before submit, no multi-line input,
    // no cancel-vs-empty distinction. Upgrade to a <Dialog/> when adding
    // any other admin-UI modal (consolidate, don't fragment).
    const reason = window.prompt(`,
  },

  // ─── F177 — Plan-proposal approve UI diff display (deferred, doc it) ──
  {
    tag: "F177",
    file: "app/admin/plans/queue/[id]/page.tsx",
    description: "Document the diff-display deferred work",
    find: `          {proposal.approved_with_edits && <span className="ml-1 italic">(approver edited the payload before approving — original creator submission is preserved in the diff history)</span>}`,
    replace: `          {proposal.approved_with_edits && <span className="ml-1 italic">(approver edited the payload before approving — original creator submission is preserved in the diff history)</span>}
          {/* F177 note (QA): we say "preserved in the diff history" but
              don't actually RENDER a diff here. The data is on the
              proposal row (proposed_at_submit + proposed). Add a side-by-
              side diff view (e.g. JSON.stringify on each, react-diff-viewer
              or a tiny custom diff) under this header so the approver
              can see exactly what changed. Tracked in AUDIT.md Section 3. */}`,
  },

  // ─── F141 — Category catalog grouping doc ──────────────────────────────
  {
    tag: "F141",
    file: "app/api/generate/route.ts",
    description: "Document category-catalog grouping path",
    find: `    // Preference order: client-supplied category_override → bodyExamGoal → null.`,
    replace: `    // F141 note (QA): the picker that drives category_override on the
    // client renders one flat list. For learner_profile=competitive_exam
    // teachers, the list is long (~20 items) and scanning is hard.
    // Group the catalog by learner_profile in the UI (sections: "K-12",
    // "Competitive", "Professional") so the picker is scannable. Server
    // side stays the same — this is purely a UI grouping.
    //
    // Preference order: client-supplied category_override → bodyExamGoal → null.`,
  },

  // ─── F143 — Advanced disclosure section title ──────────────────────────
  {
    tag: "F143",
    file: "app/teacher/generate/page.tsx",
    description: "Audit reminder to title the Advanced disclosure section",
    find: `// 2026-05-13 evening: audience-level is fully optional (no profile-driven default).`,
    replace: `// 2026-05-13 evening: audience-level is fully optional (no profile-driven default).
// F143 note (QA): the "Advanced" disclosure (numerical %, intent presets,
// per-level overrides) used to be untitled — first-time teachers thought
// the page was simpler than it is. When next touching the disclosure JSX,
// add a heading like "Advanced — fine-tune the mix" and a one-line
// description so it's discoverable without being intimidating.`,
  },

  // ─── F166 — /settings/billing page (deferred, doc the gap) ────────────
  {
    tag: "F166",
    file: "app/settings/profile/page.tsx",
    description: "Document /settings/billing absence at the nearby surface",
    find: `"use client";`,
    replace: `"use client";
// F166 note (QA): users have no surfaced page to view past payments
// (subscription_payments rows exist in DB but the UI doesn't render
// them). New page /settings/billing — table of date / plan / amount /
// status with download-invoice link (existing /admin/subscriptions/[id]/
// invoice route already produces a PDF; mirror it for self-serve).
// Belongs in the settings sidebar between "profile" and "security".`,
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

console.log(`\n=== Round 9 apply summary ===`);
console.log(`Applied: ${applied.length}  →  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
