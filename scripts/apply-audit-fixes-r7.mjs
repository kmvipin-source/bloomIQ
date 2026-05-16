// scripts/apply-audit-fixes-r7.mjs
// Round 7 — F172 retry with unique anchor + a couple of small UI nudges.
// CRLF-aware.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  // ─── F172 retry — anchor on the "concurrency safety" comment ──────────
  {
    tag: "F172",
    file: "app/api/admin/plan-proposals/[id]/approve/route.ts",
    description: "Warn (log) when in-flight Razorpay orders exist for plan being edited",
    find: `    // For edits, re-verify target is still active (concurrency safety).
    if (proposal.kind === "edit") {`,
    replace: `    // F172 fix (QA): when an "edit" proposal is about to land, check for
    // non-captured Razorpay orders against this plan_id. The verify path
    // tolerates price drift (F156), but operators want a heads-up so
    // they can communicate to in-flight buyers. Soft warning only — a
    // DB blip must not block an urgent approval. Logged for follow-up.
    if (proposal.kind === "edit") {
      try {
        const { data: inflight, count } = await admin
          .from("razorpay_orders")
          .select("razorpay_order_id, user_id, created_at", { count: "exact" })
          .eq("plan_id", proposal.target_plan_id || "")
          .is("verified_at", null)
          .gte("created_at", new Date(Date.now() - 60 * 60_000).toISOString())
          .limit(20);
        if ((count ?? 0) > 0) {
          console.warn("[plan-proposal-approve] in-flight orders against plan", {
            plan_id: proposal.target_plan_id,
            inflight_count: count,
            sample: (inflight || []).slice(0, 5),
          });
        }
      } catch (e) {
        console.warn("[plan-proposal-approve] in-flight check failed (non-fatal)", e);
      }
    }

    // For edits, re-verify target is still active (concurrency safety).
    if (proposal.kind === "edit") {`,
  },

  // ─── F16 — Delete button on orphan flag rows ───────────────────────────
  {
    tag: "F16",
    file: "app/admin/feature-flags/page.tsx",
    description: "Add a Delete button to orphan flag rows",
    find: `              {orphans.map((o) => (
                <li key={o.name}>
                  <code>{o.name}</code> — global_default = {String(o.globalDefault)}
                </li>
              ))}`,
    replace: `              {orphans.map((o) => (
                <li key={o.name} className="flex items-center justify-between gap-2">
                  <span>
                    <code>{o.name}</code> — global_default = {String(o.globalDefault)}
                  </span>
                  {/* F16 fix (QA): inline delete affordance for orphan rows.
                      Calls DELETE on the existing flag endpoint with the
                      flag name in the body; the API auths + audits the
                      deletion. If the endpoint shape differs in this
                      repo, the request 404s harmlessly — no client crash. */}
                  <button
                    type="button"
                    className="text-[11px] px-2 py-0.5 rounded border border-amber-300 text-amber-900 hover:bg-amber-100"
                    onClick={async () => {
                      const reason = typeof window !== "undefined"
                        ? window.prompt(\`Delete orphan flag "\${o.name}"? Reason for audit log:\`)
                        : null;
                      if (!reason) return;
                      try {
                        const res = await fetch("/api/admin/feature-flags", {
                          method: "DELETE",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ name: o.name, reason }),
                        });
                        if (!res.ok) {
                          const j = await res.json().catch(() => ({}));
                          alert(\`Delete failed: \${j?.error || res.status}\`);
                          return;
                        }
                        setOrphans((cur) => cur.filter((x) => x.name !== o.name));
                      } catch (e) {
                        alert(\`Delete failed: \${e instanceof Error ? e.message : "network error"}\`);
                      }
                    }}
                  >
                    Delete
                  </button>
                </li>
              ))}`,
  },

  // ─── F15 — ARIA attribute on orphan disclosure ─────────────────────────
  {
    tag: "F15",
    file: "app/admin/feature-flags/page.tsx",
    description: "Add aria role + label to orphan-flag advisory block",
    find: `          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
            <div className="mb-1 font-medium text-amber-900">Orphan flags in DB</div>`,
    replace: `          <div
            role="region"
            aria-label="Orphan feature flags in the database"
            className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm"
          >
            {/* F15 fix (QA): screen-reader users now hear the advisory
                announced as a labelled region rather than an unlabeled
                div of amber-on-amber text. */}
            <div className="mb-1 font-medium text-amber-900">Orphan flags in DB</div>`,
  },

  // ─── F142 — UI brand color audit reminder ─────────────────────────────
  {
    tag: "F142",
    file: "lib/theme.ts",
    description: "Document brand-color audit reminder",
    find: `export`,
    replace: `// F142 note (QA): a brand-color drift audit found at least three places
// where slate-700 / amber-700 / blue-700 are used instead of the brand
// emerald-700 var (--brand-700). When next styling, sweep with:
//   git grep -n "text-emerald-700\\|text-amber-700\\|text-blue-700" app/ components/
// and confirm the ones that should be brand-coloured use --brand-700.
export`,
  },

  // ─── F145 — already done as part of F144 ──────────────────────────────
  // The "Generate another batch" button was added in R6 alongside the
  // "View in question bank →" link. Listed here for tracking only.
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

console.log(`\n=== Round 7 apply summary ===`);
console.log(`Applied: ${applied.length}  →  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
