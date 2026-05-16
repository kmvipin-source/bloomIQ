// scripts/apply-audit-fixes-r8.mjs
// Round 8 — 5 fixes (per Vipin's request, batches of 5 from here on).
// Pool narrowing — pick high-confidence anchors over speculative ones.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  // ─── F138-followup — concrete helper text under the topic input ────────
  {
    tag: "F138_followup",
    file: "app/teacher/generate/page.tsx",
    description: "Add good/bad topic helper text JSX below topic-only input",
    find: `            <div>
              <label className="label">Topic (optional)</label>
              <input className="input" placeholder={topicPlaceholder()}
                     value={topic} onChange={(e) => setTopic(e.target.value)} />
            </div>`,
    replace: `            <div>
              <label className="label">Topic (optional)</label>
              <input className="input" placeholder={topicPlaceholder()}
                     value={topic} onChange={(e) => setTopic(e.target.value)} />
              {/* F138 follow-up (QA): R2 added a code comment with the
                  good/bad examples; this surfaces them in the UI so
                  first-time teachers see them BEFORE they hit Generate. */}
              <p className="text-[11px] text-slate-400 mt-1">
                <strong className="text-slate-500">Good:</strong> "Algebra — quadratic equations", "Photosynthesis — light reactions".{" "}
                <strong className="text-slate-500">Avoid:</strong> "Maths", "Science", "Chapter 4".
              </p>
            </div>`,
  },

  // ─── F142 — brand-color sweep audit reminder in lib/theme.ts ──────────
  {
    tag: "F142",
    file: "lib/theme.ts",
    description: "Document brand-color drift audit",
    find: `export type ThemeName = "emerald" | "indigo" | "rose" | "amber" | "slate";`,
    replace: `// F142 note (QA): brand-color drift audit found ~3 places where
// text-amber-700 / text-blue-700 are used in lieu of --brand-700.
// Sweep with:
//   git grep -nE "text-(amber|blue|rose|indigo)-(600|700|800)" app/ components/
// and confirm the ones that should be brand-coloured switch to
// "text-[color:var(--brand-700)]" so they re-theme with the picker.
export type ThemeName = "emerald" | "indigo" | "rose" | "amber" | "slate";`,
  },

  // ─── F175 — Platform Admin filter chip on /admin/users ────────────────
  {
    tag: "F175",
    file: "app/admin/users/page.tsx",
    description: "Add platform_admin filter chip to /admin/users",
    find: `type RoleFilter = "all" | SubRole | "all_teachers";`,
    replace: `// F175 note (QA): "platform_admin" is a flag on profiles, not a
// sub_role. We expose it here as a synthetic RoleFilter value so the
// chip list can include a one-click "show admins only" filter.
type RoleFilter = "all" | SubRole | "all_teachers" | "platform_admins";`,
  },
  {
    tag: "F175b_chip",
    file: "app/admin/users/page.tsx",
    description: "Render platform_admins chip + count + filter behavior",
    find: `            ["co_teacher", \`Co-Teachers (\${counts.co_teacher})\`],
          ] as Array<[RoleFilter, string]>).map(([key, label]) => (`,
    replace: `            ["co_teacher", \`Co-Teachers (\${counts.co_teacher})\`],
            // F175 fix (QA): show-admins chip — convenience for ops.
            ["platform_admins", \`Platform Admins (\${users.filter((u) => u.platform_admin).length})\`],
          ] as Array<[RoleFilter, string]>).map(([key, label]) => (`,
  },
  {
    tag: "F175c_filter",
    file: "app/admin/users/page.tsx",
    description: "Filter users when platform_admins chip is active",
    find: `      if (roleFilter === "all_teachers") {
        if (u.role !== "teacher") return false;
      } else if (roleFilter !== "all") {
        if (u.sub_role !== roleFilter) return false;
      }`,
    replace: `      if (roleFilter === "all_teachers") {
        if (u.role !== "teacher") return false;
      } else if (roleFilter === "platform_admins") {
        // F175 fix (QA): synthetic filter — platform_admin is on profiles,
        // not in sub_role, so it needs its own branch.
        if (!u.platform_admin) return false;
      } else if (roleFilter !== "all") {
        if (u.sub_role !== roleFilter) return false;
      }`,
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

console.log(`\n=== Round 8 apply summary ===`);
console.log(`Applied: ${applied.length}  →  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
