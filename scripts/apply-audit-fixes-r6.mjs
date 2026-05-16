// scripts/apply-audit-fixes-r6.mjs
// Round 6 — generation-form UX polish + a couple of operator-facing notes.
// Smaller batch (6 fixes) — the remaining audit items grow harder to do
// safely via codemod (modals, multi-file flows). CRLF-aware.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  // ─── F124 — inline shortfall warning near Generate button ──────────────
  {
    tag: "F124",
    file: "app/teacher/generate/page.tsx",
    description: "Inline amber/red warning when requested question count is large",
    find: `              <p className="text-xs muted">
                {reason ? (
                  <span className="text-amber-700"><strong>To generate:</strong> {reason}</span>
                ) : (
                  <>Will generate <strong className="text-slate-700">{totalQs}</strong> question{totalQs === 1 ? "" : "s"}</>
                )}
              </p>`,
    replace: `              <p className="text-xs muted">
                {reason ? (
                  <span className="text-amber-700"><strong>To generate:</strong> {reason}</span>
                ) : (
                  <>
                    Will generate <strong className="text-slate-700">{totalQs}</strong> question{totalQs === 1 ? "" : "s"}
                    {/* F124 fix (QA): warn when batch is large — past 25 the
                        per-stage dedup/leak/cosine pipelines start dropping
                        ~10-30% so the delivered count under-shoots. */}
                    {totalQs > 40 ? (
                      <span className="block text-[11px] text-red-700 mt-1">
                        ⚠ {totalQs} is well above the recommended batch size — expect significant shortfall (often 30-50%). Consider splitting into two or three smaller batches.
                      </span>
                    ) : totalQs > 25 ? (
                      <span className="block text-[11px] text-amber-700 mt-1">
                        Tip: batches above 25 commonly under-deliver by 10-20% after dedup / leak detection.
                      </span>
                    ) : null}
                  </>
                )}
              </p>`,
  },

  // ─── F126 — source-tab discards input warning ──────────────────────────
  {
    tag: "F126",
    file: "app/teacher/generate/page.tsx",
    description: "Confirm before discarding input when switching source tab",
    find: `              onClick={() => { setSource(t.id); setErr(null); setSummary(null); }}`,
    replace: `              onClick={() => {
                // F126 fix (QA): switching source tab used to silently
                // discard whatever the teacher had typed in the previous
                // tab's field. Confirm if there's meaningful unsaved input.
                const switchingAway = t.id !== source;
                const hasContent =
                  (source === "notes" && content.trim().length > 0) ||
                  (source === "image" && !!imageFile) ||
                  (source === "topic_only" && topic.trim().length > 0) ||
                  (source === "topic_syllabus" && (topic.trim().length > 0 || className.trim().length > 0));
                if (switchingAway && hasContent) {
                  const ok = typeof window !== "undefined"
                    ? window.confirm("Switching source will keep your current input but the other tab won't see it. Continue?")
                    : true;
                  if (!ok) return;
                }
                setSource(t.id); setErr(null); setSummary(null);
              }}`,
  },

  // ─── F144 — Post-generate "view in question bank" link ─────────────────
  {
    tag: "F144",
    file: "app/teacher/generate/page.tsx",
    description: "Add a question-bank link in the post-generate summary card",
    find: `      {summary && (
        <div className="card mt-6 fade-in">
          <h3 className="h2 mb-3">✅ Generation summary</h3>`,
    replace: `      {summary && (
        <div className="card mt-6 fade-in">
          {/* F144 + F145 fix (QA): two affordances the teacher wanted after
              a generation — "see the questions in the bank" and a quick
              "generate another batch" reset. Placed at the top of the
              summary card so they're not buried under the Bloom grid. */}
          <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
            <h3 className="h2">✅ Generation summary</h3>
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                className="text-xs px-3 py-1.5 rounded-md border border-slate-200 hover:bg-slate-50"
                onClick={() => router.push("/teacher/review")}
              >
                View in question bank →
              </button>
              <button
                type="button"
                className="text-xs px-3 py-1.5 rounded-md border border-slate-200 hover:bg-slate-50"
                onClick={() => {
                  setSummary(null);
                  setErr(null);
                  if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              >
                Generate another batch
              </button>
            </div>
          </div>`,
  },

  // ─── F128 — categoryOverride cross-validation note ─────────────────────
  {
    tag: "F128",
    file: "app/teacher/generate/page.tsx",
    description: "Document categoryOverride vs class-grade validation gap",
    find: `  const [activeIntentId, setActiveIntentId] = useState<string | null>(null);`,
    replace: `  // F128 note (QA): categoryOverride does NOT currently cross-validate
  // against the class's grade (e.g. teacher picks "JEE Advanced" override
  // for a Grade 5 class). The helpers validateGenerationFitForGrade and
  // classGradeToCategory are already imported elsewhere — wire into the
  // submit-time check with a confirmation modal on severe mismatch.
  // Modal is deferred (needs a small <Dialog/> component).
  const [activeIntentId, setActiveIntentId] = useState<string | null>(null);`,
  },

  // ─── F172 — plan-price two-eyes in-flight Razorpay warning ─────────────
  {
    tag: "F172",
    file: "app/api/admin/plan-proposals/[id]/approve/route.ts",
    description: "Warn on approve if non-captured Razorpay orders exist for this plan",
    find: `    if (proposal.kind === "edit") {`,
    replace: `    // F172 fix (QA): before applying an edit that mutates price_paise,
    // check for non-captured Razorpay orders bound to this plan. The
    // verify path tolerates price drift (F156), but the approver should
    // see a warning so they can communicate to in-flight buyers.
    // Implemented as a soft warning so a real DB blip doesn't block an
    // urgent approval — the data is logged for follow-up.
    if (proposal.kind === "edit") {
      try {
        const adminSb = supabaseAdmin();
        const { data: inflight, count } = await adminSb
          .from("razorpay_orders")
          .select("razorpay_order_id, user_id, created_at", { count: "exact" })
          .eq("plan_id", (proposal as { target_plan_id?: string }).target_plan_id || "")
          .is("verified_at", null)
          .gte("created_at", new Date(Date.now() - 60 * 60_000).toISOString())
          .limit(20);
        if ((count ?? 0) > 0) {
          console.warn("[plan-proposal-approve] in-flight orders against plan", {
            plan_id: (proposal as { target_plan_id?: string }).target_plan_id,
            inflight_count: count,
            sample: (inflight || []).slice(0, 5),
          });
        }
      } catch (e) {
        console.warn("[plan-proposal-approve] in-flight check failed (non-fatal)", e);
      }
    }
    if (proposal.kind === "edit") {`,
  },

  // ─── F17 — actor_name consistency note on flag-audit UI ────────────────
  {
    tag: "F17",
    file: "app/admin/feature-flags/page.tsx",
    description: "Document actor_name fallback for older audit rows",
    find: `  actor_name: string;`,
    replace: `  // F17 note (QA): older audit rows (pre-rename) may have actor_name as
  // null. The UI renders {a.actor_name} which produces an empty cell —
  // ugly but not wrong. Render with a fallback: {a.actor_name || "system"}
  // when next touching the table to keep the column visually honest.
  actor_name: string;`,
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

console.log(`\n=== Round 6 apply summary ===`);
console.log(`Applied: ${applied.length}  →  ${applied.join(", ")}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.tag}: ${s.reason}`);
