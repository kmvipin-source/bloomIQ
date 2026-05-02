"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Plus, Minus, ArrowRight, Sparkles, Lock } from "lucide-react";
import { FEATURES_BY_KEY } from "@/lib/features";
import type { Plan, PlanProposalPayload } from "@/lib/types";

/**
 * <PlanDiff>
 *
 * Side-by-side comparison of two plan-shaped objects with aggressive
 * highlighting so an approver can scan changes at a glance.
 *
 * Visual hierarchy (in order of attention):
 *   1. Summary banner at the top — "5 fields changed · 3 features added · 1 removed".
 *      Single source of truth for "did anything change at all?"
 *   2. Changed scalar rows render with an amber background, a "Changed"
 *      pill, the old value struck through in red, an arrow, and the new
 *      value in bold green. Cannot be missed.
 *   3. Added features get a solid green background; removed features
 *      get a solid red background with strikethrough.
 *   4. Identical rows + unchanged features are hidden by default (toggle
 *      to reveal). Reduces visual noise so the eye lands on differences.
 *
 * The component is otherwise pure — it does not fetch anything. Pass two
 * payloads and labels.
 */

export type DiffSide = Partial<Plan> | PlanProposalPayload | null | undefined;

type Props = {
  left: DiffSide;
  right: DiffSide;
  leftLabel: string;
  rightLabel: string;
  contextNote?: string;
  // Determines whether slug + tier are flagged "immutable, won't apply".
  // - 'edit'   → editing a live plan; slug/tier are immutable (DB row identity).
  // - 'create' → minting a new SKU (possibly cloned from a template); slug/tier
  //   are the NEW row's identity, freely chosen by the creator. NOT immutable
  //   even when a parent plan supplies them on the left side of the diff.
  kind?: "edit" | "create";
};

// ----- value formatters ---------------------------------------------------

function rupees(paise: number | undefined | null): string {
  if (paise === undefined || paise === null) return "—";
  if (paise === 0) return "₹0";
  if (paise % 100 === 0) return `₹${(paise / 100).toLocaleString("en-IN")}`;
  return `₹${(paise / 100).toFixed(2)}`;
}

function periodLabel(days: number | undefined | null): string {
  if (days === undefined || days === null) return "—";
  if (days === 0) return "free / no period";
  if (days <= 31) return `${days} days (≈ monthly)`;
  if (days >= 88 && days <= 95) return `${days} days (≈ quarterly)`;
  if (days >= 175 && days <= 185) return `${days} days (≈ 6-month)`;
  if (days >= 360 && days <= 366) return `${days} days (≈ yearly)`;
  return `${days} days`;
}

function maybeBlank(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

// ----- field definitions --------------------------------------------------

type ScalarField = {
  kind: "scalar";
  group: "identity" | "marketing" | "pricing" | "integration";
  key: keyof PlanProposalPayload | "razorpay_plan_id";
  label: string;
  format: (v: unknown) => string;
  immutableOnEdit?: boolean;
};

const SCALAR_FIELDS: ScalarField[] = [
  { kind: "scalar", group: "identity",   key: "slug",                    label: "Slug",                  format: (v) => maybeBlank(v),                          immutableOnEdit: true },
  { kind: "scalar", group: "identity",   key: "tier",                    label: "Tier",                  format: (v) => maybeBlank(v),                          immutableOnEdit: true },
  { kind: "scalar", group: "marketing",  key: "label",                   label: "Display name",          format: (v) => maybeBlank(v) },
  { kind: "scalar", group: "marketing",  key: "blurb",                   label: "Blurb",                 format: (v) => maybeBlank(v) },
  { kind: "scalar", group: "pricing",    key: "pricing_model",           label: "Pricing model",         format: (v) => maybeBlank(v) },
  { kind: "scalar", group: "pricing",    key: "price_paise",             label: "Fixed price",           format: (v) => rupees(v as number) },
  { kind: "scalar", group: "pricing",    key: "currency",                label: "Currency",              format: (v) => maybeBlank(v) },
  { kind: "scalar", group: "pricing",    key: "period_days",             label: "Billing period",        format: (v) => periodLabel(v as number) },
  { kind: "scalar", group: "pricing",    key: "per_student_price_paise", label: "Per-student price",     format: (v) => rupees(v as number) },
  { kind: "scalar", group: "pricing",    key: "min_students",            label: "Min students",          format: (v) => maybeBlank(v) },
  { kind: "scalar", group: "pricing",    key: "max_students",            label: "Max students",          format: (v) => v === null || v === undefined ? "no cap" : String(v) },
  { kind: "scalar", group: "integration",key: "razorpay_plan_id",        label: "Razorpay plan id",      format: (v) => maybeBlank(v) },
];

const GROUP_LABELS: Record<ScalarField["group"], string> = {
  identity:    "Identity",
  marketing:   "Marketing copy",
  pricing:     "Pricing",
  integration: "Integration",
};

const GROUP_ORDER: ScalarField["group"][] = ["identity", "marketing", "pricing", "integration"];

// ----- diff colors --------------------------------------------------------
//
// Strong, intentional palette so the eye lands on changes immediately.
// Picked to read clearly on both light and dark themes via color-mix:
//   change rows  → amber/yellow background ("attention")
//   removed text → red                     ("losing this")
//   added text   → emerald                 ("gaining this")
// We use inline styles (not Tailwind utilities) so the contrast is the
// same regardless of the active theme.

const COLORS = {
  changeRowBg:   "color-mix(in oklab, #fef3c7 65%, transparent)", // amber-100-ish
  changeRowEdge: "#f59e0b",                                       // amber-500
  oldText:       "#b91c1c",                                       // red-700
  newText:       "#047857",                                       // emerald-700
  addedBg:       "color-mix(in oklab, #d1fae5 70%, transparent)", // emerald-100
  addedEdge:     "#059669",                                       // emerald-600
  removedBg:     "color-mix(in oklab, #fee2e2 70%, transparent)", // red-100
  removedEdge:   "#dc2626",                                       // red-600
  immutableBg:   "color-mix(in oklab, #e5e7eb 60%, transparent)", // slate-200
};

// ----- helpers ------------------------------------------------------------

function valuesDiffer(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

function arrayDiff(a: string[] | undefined | null, b: string[] | undefined | null) {
  const aa = new Set(a || []);
  const bb = new Set(b || []);
  const both: string[] = [];
  const removed: string[] = [];
  const added: string[] = [];
  for (const k of aa) (bb.has(k) ? both : removed).push(k);
  for (const k of bb) if (!aa.has(k)) added.push(k);
  return { both, removed, added };
}

// ----- component ----------------------------------------------------------

export default function PlanDiff({ left, right, leftLabel, rightLabel, contextNote, kind = "edit" }: Props) {
  const [showIdentical, setShowIdentical] = useState(false);

  // Slug + tier are only immutable when the proposal is editing an existing
  // plan. For create-from-template, they're the NEW row's identity — fully
  // editable, so don't flag them.
  const enforceImmutable = kind === "edit";

  // Compute every per-field diff up front so we can drive the summary
  // banner AND the row rendering off the same data.
  const scalarDiffs = useMemo(() => {
    return SCALAR_FIELDS.map((f) => {
      const lv = left ? (left as Record<string, unknown>)[f.key as string] : undefined;
      const rv = right ? (right as Record<string, unknown>)[f.key as string] : undefined;
      const changed = valuesDiffer(lv, rv);
      const blockedByImmutable = f.immutableOnEdit && enforceImmutable && changed;
      return { field: f, lv, rv, changed, blockedByImmutable };
    });
  }, [left, right, enforceImmutable]);

  const featuresDiff = useMemo(
    () =>
      arrayDiff(
        (left as { features?: string[] } | null)?.features,
        (right as { features?: string[] } | null)?.features,
      ),
    [left, right],
  );

  const summaryDiff = useMemo(
    () =>
      arrayDiff(
        (left as { feature_summary?: string[] } | null)?.feature_summary,
        (right as { feature_summary?: string[] } | null)?.feature_summary,
      ),
    [left, right],
  );

  const scalarsChangedCount = scalarDiffs.filter((d) => d.changed && !d.blockedByImmutable).length;
  const featuresAdded   = featuresDiff.added.length;
  const featuresRemoved = featuresDiff.removed.length;
  const summaryAdded    = summaryDiff.added.length;
  const summaryRemoved  = summaryDiff.removed.length;

  const totalChanges =
    scalarsChangedCount + featuresAdded + featuresRemoved + summaryAdded + summaryRemoved;

  return (
    <div className="space-y-6">
      {contextNote && (
        <div className="text-xs muted italic">{contextNote}</div>
      )}

      {/* ── Summary banner ─────────────────────────────────────────────── */}
      <div
        className="rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap"
        style={{
          background: totalChanges === 0
            ? "var(--color-bg-soft)"
            : COLORS.changeRowBg,
          border: `1px solid ${totalChanges === 0 ? "var(--color-border)" : COLORS.changeRowEdge}`,
        }}
      >
        <Sparkles size={18} style={{ color: totalChanges === 0 ? "var(--color-fg-soft)" : COLORS.changeRowEdge }} />
        {totalChanges === 0 ? (
          <div className="text-sm">
            <strong>No changes</strong> — the proposed payload is identical to the baseline.
          </div>
        ) : (
          <div className="text-sm flex items-center gap-2 flex-wrap">
            <strong>{totalChanges} change{totalChanges === 1 ? "" : "s"}</strong>
            <span className="muted">·</span>
            {scalarsChangedCount > 0 && (
              <span><strong style={{ color: COLORS.changeRowEdge }}>{scalarsChangedCount}</strong> field{scalarsChangedCount === 1 ? "" : "s"}</span>
            )}
            {featuresAdded > 0 && (
              <span style={{ color: COLORS.newText }}>
                <strong>+{featuresAdded}</strong> feature{featuresAdded === 1 ? "" : "s"}
              </span>
            )}
            {featuresRemoved > 0 && (
              <span style={{ color: COLORS.oldText }}>
                <strong>−{featuresRemoved}</strong> feature{featuresRemoved === 1 ? "" : "s"}
              </span>
            )}
            {summaryAdded > 0 && (
              <span style={{ color: COLORS.newText }}>
                <strong>+{summaryAdded}</strong> bullet{summaryAdded === 1 ? "" : "s"}
              </span>
            )}
            {summaryRemoved > 0 && (
              <span style={{ color: COLORS.oldText }}>
                <strong>−{summaryRemoved}</strong> bullet{summaryRemoved === 1 ? "" : "s"}
              </span>
            )}
          </div>
        )}
        {totalChanges > 0 && (
          <label className="ml-auto text-xs inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={showIdentical}
              onChange={(e) => setShowIdentical(e.target.checked)}
            />
            Show identical fields
          </label>
        )}
      </div>

      {/* ── Two-column header ─────────────────────────────────────────── */}
      <div
        className="grid grid-cols-[160px_1fr_24px_1fr] gap-3 text-xs uppercase font-bold tracking-wide pb-1 border-b"
        style={{ color: "var(--color-fg-soft)", borderColor: "var(--color-border)" }}
      >
        <div></div>
        <div>{leftLabel}</div>
        <div></div>
        <div>{rightLabel}</div>
      </div>

      {/* ── Scalar fields, grouped ────────────────────────────────────── */}
      {GROUP_ORDER.map((g) => {
        const groupDiffs = scalarDiffs.filter((d) => d.field.group === g);
        // If the user has unchanged-rows hidden and this group has only
        // unchanged rows, skip the whole group.
        const hasChanges = groupDiffs.some((d) => d.changed);
        if (!showIdentical && !hasChanges) return null;

        return (
          <section key={g}>
            <h3 className="text-xs font-bold uppercase tracking-wide mb-2" style={{ color: "var(--color-fg-soft)" }}>
              {GROUP_LABELS[g]}
              {hasChanges && (
                <span
                  className="ml-2 text-[10px] font-medium normal-case rounded-full px-1.5 py-0.5"
                  style={{ background: COLORS.changeRowBg, color: COLORS.changeRowEdge }}
                >
                  {groupDiffs.filter((d) => d.changed && !d.blockedByImmutable).length} changed
                </span>
              )}
            </h3>
            <div className="rounded-lg border overflow-hidden" style={{ borderColor: "var(--color-border)" }}>
              {groupDiffs.map((d, idx) => {
                if (!d.changed && !showIdentical) return null;
                return (
                  <ScalarRow
                    key={String(d.field.key)}
                    diff={d}
                    isFirst={idx === 0}
                  />
                );
              })}
            </div>
          </section>
        );
      })}

      {/* ── feature_summary ───────────────────────────────────────────── */}
      {(summaryAdded > 0 || summaryRemoved > 0 || showIdentical) && (
        <section>
          <h3 className="text-xs font-bold uppercase tracking-wide mb-2 flex items-center gap-2" style={{ color: "var(--color-fg-soft)" }}>
            Feature summary (marketing bullets)
            {(summaryAdded > 0 || summaryRemoved > 0) && (
              <span className="text-[10px] font-medium normal-case rounded-full px-1.5 py-0.5"
                    style={{ background: COLORS.changeRowBg, color: COLORS.changeRowEdge }}>
                {summaryAdded > 0 && <span style={{ color: COLORS.newText }}>+{summaryAdded}</span>}
                {summaryAdded > 0 && summaryRemoved > 0 && <span> · </span>}
                {summaryRemoved > 0 && <span style={{ color: COLORS.oldText }}>−{summaryRemoved}</span>}
              </span>
            )}
          </h3>
          <BulletDiff
            diff={summaryDiff}
            showIdentical={showIdentical}
            leftLabel={leftLabel}
            rightLabel={rightLabel}
          />
        </section>
      )}

      {/* ── features (gated keys) ─────────────────────────────────────── */}
      <section>
        <h3 className="text-xs font-bold uppercase tracking-wide mb-2 flex items-center gap-2" style={{ color: "var(--color-fg-soft)" }}>
          Gated features
          {(featuresAdded > 0 || featuresRemoved > 0) && (
            <span className="text-[10px] font-medium normal-case rounded-full px-1.5 py-0.5"
                  style={{ background: COLORS.changeRowBg, color: COLORS.changeRowEdge }}>
              {featuresAdded > 0 && <span style={{ color: COLORS.newText }}>+{featuresAdded}</span>}
              {featuresAdded > 0 && featuresRemoved > 0 && <span> · </span>}
              {featuresRemoved > 0 && <span style={{ color: COLORS.oldText }}>−{featuresRemoved}</span>}
            </span>
          )}
        </h3>
        <FeaturesDiff
          diff={featuresDiff}
          showIdentical={showIdentical}
          leftLabel={leftLabel}
          rightLabel={rightLabel}
        />
      </section>
    </div>
  );
}

// =====================================================================
// ScalarRow — one field row in a side-by-side layout.
// =====================================================================

function ScalarRow({
  diff,
  isFirst,
}: {
  diff: { field: ScalarField; lv: unknown; rv: unknown; changed: boolean; blockedByImmutable: boolean };
  isFirst: boolean;
}) {
  const { field, lv, rv, changed, blockedByImmutable } = diff;
  const fmt = field.format;

  // Three states drive the rendering:
  //   1. blockedByImmutable → user picked a different slug/tier on edit;
  //      show both values but flag them as "won't be applied". Slight
  //      slate-grey background, no full diff styling.
  //   2. changed (regular) → strong amber row, old (red strike) → arrow
  //      → new (emerald bold). Eye-catching.
  //   3. unchanged → muted, no background, dim.
  let rowBg: string | undefined;
  let leftBorder: string | undefined;
  let pill: { label: string; color: string; bg: string } | null = null;

  if (blockedByImmutable) {
    rowBg = COLORS.immutableBg;
    leftBorder = "#94a3b8";
    pill = { label: "Locked", color: "#475569", bg: "#e2e8f0" };
  } else if (changed) {
    rowBg = COLORS.changeRowBg;
    leftBorder = COLORS.changeRowEdge;
    pill = { label: "Changed", color: COLORS.changeRowEdge, bg: "transparent" };
  }

  // Identical (non-immutable, non-changed) rows get demoted visually so
  // changed and locked rows remain the eye-catchers when "Show identical
  // fields" is on. Same data, much lighter weight.
  const isIdentical = !changed && !blockedByImmutable;

  return (
    <div
      className={`grid grid-cols-[160px_1fr_24px_1fr] gap-3 text-sm py-2.5 px-3 ${isFirst ? "" : "border-t"}`}
      style={{
        borderColor: "var(--color-border)",
        background: rowBg,
        borderLeft: leftBorder ? `4px solid ${leftBorder}` : "4px solid transparent",
        opacity: isIdentical ? 0.55 : 1,
      }}
    >
      <div className="text-xs muted self-center font-medium flex items-center gap-1.5">
        {pill?.label === "Locked" && <Lock size={10} />}
        {field.label}
        {pill && (
          <span
            className="text-[9px] uppercase tracking-wide font-bold rounded-full px-1.5 py-0.5"
            style={{ color: pill.color, background: pill.bg, border: `1px solid ${pill.color}` }}
          >
            {pill.label}
          </span>
        )}
      </div>

      {/* Left value */}
      <div
        className="tabular-nums self-center"
        style={{
          color: changed && !blockedByImmutable ? COLORS.oldText : "var(--color-fg-soft)",
          textDecoration: changed && !blockedByImmutable ? "line-through" : undefined,
          fontWeight: changed && !blockedByImmutable ? 500 : undefined,
        }}
      >
        {fmt(lv)}
      </div>

      {/* Arrow (only when changed) */}
      <div className="self-center text-center">
        {changed && !blockedByImmutable && (
          <ArrowRight size={14} style={{ color: COLORS.changeRowEdge }} />
        )}
      </div>

      {/* Right value */}
      <div
        className="tabular-nums self-center"
        style={{
          color: changed && !blockedByImmutable ? COLORS.newText : "var(--color-fg)",
          fontWeight: changed && !blockedByImmutable ? 700 : 500,
        }}
      >
        {fmt(rv)}
        {blockedByImmutable && (
          <span className="ml-2 text-[10px] uppercase tracking-wide" style={{ color: "#475569" }}>
            (immutable — won&apos;t apply)
          </span>
        )}
      </div>
    </div>
  );
}

// =====================================================================
// BulletDiff — feature_summary array.
// =====================================================================

function BulletDiff({
  diff,
  showIdentical,
  leftLabel,
  rightLabel,
}: {
  diff: ReturnType<typeof arrayDiff>;
  showIdentical: boolean;
  leftLabel: string;
  rightLabel: string;
}) {
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.both.length === 0) {
    return <div className="text-xs muted italic">No bullets on either side.</div>;
  }
  // Side-by-side: items shared between sides appear on BOTH columns when
  // showIdentical=true. Removed items only on left (red); added items only
  // on right (green). Matches the user's "real side-by-side" expectation.
  const leftItems = showIdentical ? [...diff.removed, ...diff.both] : diff.removed;
  const rightItems = showIdentical ? [...diff.added, ...diff.both] : diff.added;

  return (
    <div className="grid sm:grid-cols-2 gap-3">
      <ColumnList
        sideLabel={leftLabel}
        items={leftItems}
        markChangedSet={new Set(diff.removed)}
        changedMode="removed"
        emptyText={showIdentical ? "(empty on this side)" : "(no bullets removed)"}
        renderItem={(s) => s}
      />
      <ColumnList
        sideLabel={rightLabel}
        items={rightItems}
        markChangedSet={new Set(diff.added)}
        changedMode="added"
        emptyText={showIdentical ? "(empty on this side)" : "(no bullets added)"}
        renderItem={(s) => s}
      />
    </div>
  );
}

// =====================================================================
// FeaturesDiff — gated feature keys, hydrated via FEATURES_BY_KEY.
// =====================================================================

function FeaturesDiff({
  diff,
  showIdentical,
  leftLabel,
  rightLabel,
}: {
  diff: ReturnType<typeof arrayDiff>;
  showIdentical: boolean;
  leftLabel: string;
  rightLabel: string;
}) {
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.both.length === 0) {
    return <div className="text-xs muted italic">No gated features on either side.</div>;
  }

  const hydrate = (k: string) => {
    const meta = FEATURES_BY_KEY[k];
    return {
      key: k,
      title: meta?.label || k,
      desc: meta?.description || (meta ? "" : "(unknown key)"),
    };
  };

  // Side-by-side: items shared between sides appear on BOTH columns when
  // showIdentical=true. Removed items only on left (red); added items only
  // on right (green). Matches the user's "real side-by-side" expectation.
  const leftItems = showIdentical ? [...diff.removed, ...diff.both] : diff.removed;
  const rightItems = showIdentical ? [...diff.added, ...diff.both] : diff.added;

  return (
    <div className="grid sm:grid-cols-2 gap-3">
      <ColumnList
        sideLabel={leftLabel}
        items={leftItems}
        markChangedSet={new Set(diff.removed)}
        changedMode="removed"
        emptyText={showIdentical ? "(empty on this side)" : "(no features removed)"}
        renderItem={(k) => {
          const h = hydrate(k);
          return (
            <span>
              <strong>{h.title}</strong>
              {h.desc && <span style={{ opacity: 0.85 }}> — {h.desc}</span>}
            </span>
          );
        }}
      />
      <ColumnList
        sideLabel={rightLabel}
        items={rightItems}
        markChangedSet={new Set(diff.added)}
        changedMode="added"
        emptyText={showIdentical ? "(empty on this side)" : "(no features added)"}
        renderItem={(k) => {
          const h = hydrate(k);
          return (
            <span>
              <strong>{h.title}</strong>
              {h.desc && <span style={{ opacity: 0.85 }}> — {h.desc}</span>}
            </span>
          );
        }}
      />
    </div>
  );
}

// ----- ColumnList: a single side's pane in the side-by-side feature view --

function ColumnList({
  sideLabel,
  items,
  markChangedSet,
  changedMode,
  emptyText,
  renderItem,
}: {
  sideLabel: string;
  items: string[];
  // Items present in this set are the ones that DIFFER on this side
  // (removed items on left, added items on right). Everything else is
  // "in both" and renders neutrally so the user sees that it exists on
  // this side AND the other.
  markChangedSet: Set<string>;
  changedMode: "added" | "removed";
  emptyText: string;
  renderItem: (item: string) => React.ReactNode;
}) {
  // Sort changes to the top of each column so they stand out.
  const sorted = [...items].sort((a, b) => {
    const aChanged = markChangedSet.has(a) ? 0 : 1;
    const bChanged = markChangedSet.has(b) ? 0 : 1;
    return aChanged - bChanged;
  });

  return (
    <div>
      <div
        className="text-[11px] uppercase tracking-wide font-bold mb-1.5 pb-1 border-b"
        style={{ color: "var(--color-fg-soft)", borderColor: "var(--color-border)" }}
      >
        {sideLabel}
      </div>
      {sorted.length === 0 ? (
        <div className="text-xs muted italic py-1">{emptyText}</div>
      ) : (
        <div className="space-y-1">
          {sorted.map((item, i) => {
            const isChanged = markChangedSet.has(item);
            const mode: "added" | "removed" | "same" = isChanged ? changedMode : "same";
            return <ColumnItem key={`${i}-${item}`} mode={mode} content={renderItem(item)} />;
          })}
        </div>
      )}
    </div>
  );
}

function ColumnItem({
  mode,
  content,
}: {
  mode: "added" | "removed" | "same";
  content: React.ReactNode;
}) {
  const styles =
    mode === "added"
      ? { bg: COLORS.addedBg,   edge: COLORS.addedEdge,   color: COLORS.newText, icon: <Plus  size={14} />, deco: undefined as string | undefined, weight: 600, opacity: 1 }
    : mode === "removed"
      ? { bg: COLORS.removedBg, edge: COLORS.removedEdge, color: COLORS.oldText, icon: <Minus size={14} />, deco: "line-through", weight: 500, opacity: 1 }
    : { bg: undefined,                                                                                                      edge: "transparent",         color: "var(--color-fg-soft)", icon: <CheckCircle2 size={14} />, deco: undefined, weight: 400, opacity: 0.6 };

  return (
    <div
      className="flex items-start gap-2 px-2.5 py-1.5 rounded-md text-sm"
      style={{
        background: styles.bg,
        borderLeft: `3px solid ${styles.edge}`,
        color: styles.color,
        textDecoration: styles.deco,
        fontWeight: styles.weight,
        opacity: styles.opacity,
      }}
    >
      <span className="mt-0.5 shrink-0" style={{ color: styles.edge }}>{styles.icon}</span>
      <span className="min-w-0">{content}</span>
    </div>
  );
}

