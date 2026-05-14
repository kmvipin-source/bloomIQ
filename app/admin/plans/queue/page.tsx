"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { ArrowLeft, GitBranch, Pencil, Plus, Clock, CheckCircle2, XCircle, AlertCircle, ShieldAlert, Trash2 } from "lucide-react";
import type {
  PlanChangeProposal,
  PlanProposalKind,
  PlanProposalStatus,
} from "@/lib/types";
import { formatPaise } from "@/lib/money";

/**
 * /admin/plans/queue
 *
 * The plan-proposal queue. Five tabs:
 *
 *   Awaiting my approval — open proposals NOT created by me. The only tab
 *     where Approve / Reject are first-class actions. In bootstrap mode
 *     (single platform admin) this tab is empty by definition; the UI
 *     surfaces a notice routing the admin to "My drafts" with self-approve.
 *   My drafts — open proposals I created. Edit / withdraw actions, plus
 *     bootstrap-mode self-approve.
 *   All open — every open proposal regardless of author. Useful when more
 *     than one creator is in flight.
 *   Recently approved — last 50 approved, newest first. Audit reference.
 *   Rejected — rejected proposals with reasons. Audit reference.
 *
 * Each card surfaces enough context to triage at a glance: kind badge,
 * target/parent slug, who created it + when, headline diff (price /
 * feature counts), and the action affordance.
 */

type Tab = "for_me" | "mine" | "all_open" | "approved" | "rejected" | "withdrawn";

type HydratedProposal = PlanChangeProposal & {
  target_plan: { id: string; slug: string; label: string; tier: string } | null;
  parent_plan: { id: string; slug: string; label: string; tier: string } | null;
  created_by_name: string | null;
  approved_by_name: string | null;
  rejected_by_name: string | null;
};

const TAB_DEFS: Array<{ id: Tab; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { id: "for_me",    label: "Awaiting my approval", icon: ShieldAlert },
  { id: "mine",      label: "My drafts",            icon: Pencil },
  { id: "all_open",  label: "All open",             icon: Clock },
  { id: "approved",  label: "Recently approved",    icon: CheckCircle2 },
  { id: "rejected",  label: "Rejected",             icon: XCircle },
  { id: "withdrawn", label: "Withdrawn",            icon: Trash2 },
];

function tabQuery(tab: Tab): string {
  if (tab === "for_me")    return "?scope=for_me";
  if (tab === "mine")      return "?scope=mine";
  if (tab === "all_open")  return "?status=open";
  if (tab === "approved")  return "?status=approved";
  if (tab === "rejected")  return "?status=rejected";
  return "?status=withdrawn";
}

function rupees(paise: number): string {
  return formatPaise(paise);
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function PlanQueuePage() {
  const [tab, setTab] = useState<Tab>("for_me");
  const [rows, setRows] = useState<HydratedProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [meId, setMeId] = useState<string | null>(null);
  const [bootstrapMode, setBootstrapMode] = useState<boolean | null>(null);
  // Per-tab counts for the tab-bar badges. Computed on each load by firing
  // small parallel HEAD-style fetches; cheap because the queue is small.
  const [counts, setCounts] = useState<Record<Tab, number>>({
    for_me: 0, mine: 0, all_open: 0, approved: 0, rejected: 0, withdrawn: 0,
  });

  async function load(targetTab: Tab) {
    setLoading(true);
    setErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const headers = { Authorization: `Bearer ${session.access_token}` };

      // Main fetch for the active tab.
      const r = await fetch(`/api/admin/plan-proposals${tabQuery(targetTab)}`, { headers });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Could not load proposals.");
      setRows(j.proposals || []);
      setMeId(j.current_user_id || null);

      // Detect bootstrap mode by counting platform admins via the helper
      // baked into the single-proposal endpoint. We only need it once on
      // first load — it doesn't change between tabs.
      if (bootstrapMode === null && (j.proposals || []).length > 0) {
        const first = j.proposals[0];
        const r2 = await fetch(`/api/admin/plan-proposals/${first.id}`, { headers });
        const j2 = await r2.json();
        if (r2.ok) setBootstrapMode(!!j2.bootstrap_mode);
      }

      // Tab counts in parallel (best-effort; failures don't block).
      const tabsToCount: Tab[] = ["for_me", "mine", "all_open", "approved", "rejected", "withdrawn"];
      const countResults = await Promise.allSettled(
        tabsToCount.map((t) =>
          fetch(`/api/admin/plan-proposals${tabQuery(t)}`, { headers })
            .then((rr) => rr.ok ? rr.json() : { proposals: [] })
            .then((jj) => ({ t, n: (jj.proposals || []).length })),
        ),
      );
      const next: Record<Tab, number> = { for_me: 0, mine: 0, all_open: 0, approved: 0, rejected: 0, withdrawn: 0 };
      for (const cr of countResults) {
        if (cr.status === "fulfilled") next[cr.value.t] = cr.value.n;
      }
      setCounts(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load proposals.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(tab); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hint banner shown only on the empty "Awaiting my approval" tab in
  // bootstrap mode — guides the solo admin to where the action actually is.
  const showBootstrapHint =
    tab === "for_me" && bootstrapMode === true && rows.length === 0;

  return (
    <div className="fade-in">
      <div className="flex items-center gap-3 mb-1">
        <Link href="/admin/plans" className="text-sm font-semibold inline-flex items-center gap-1" style={{ color: "var(--brand-700)" }}>
          <ArrowLeft size={14} /> Catalogue
        </Link>
      </div>
      <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
        <h1 className="h1 flex items-center gap-2"><GitBranch size={28} /> Proposal queue</h1>
      </div>
      <p className="muted text-sm mb-5 max-w-2xl">
        Every change to a plan flows through here — drafts, side-by-side reviews, approver edits,
        rejections. Nothing lands on the live catalogue without two-eyes (or self-approve in bootstrap mode).
      </p>

      {bootstrapMode && (
        <div className="card mb-5 flex items-start gap-3" style={{ background: "color-mix(in oklab, #ffe 50%, transparent)", borderColor: "#e6c200" }}>
          <AlertCircle size={18} className="mt-0.5 shrink-0" style={{ color: "#a07700" }} />
          <div className="text-sm">
            <strong>Bootstrap mode</strong> — you&apos;re the only platform admin. Self-approval is
            permitted but every such approval is flagged in the audit log. Add a second platform
            admin via <Link href="/admin/team" className="font-semibold underline">Admin Team</Link> to
            switch to strict two-eyes.
          </div>
        </div>
      )}

      {/* Tab bar */}
      <div className="flex flex-wrap gap-1 border-b mb-4" style={{ borderColor: "var(--color-border)" }}>
        {TAB_DEFS.map((t) => {
          const Icon = t.icon;
          const active = t.id === tab;
          const count = counts[t.id];
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className="px-3 py-2 text-sm font-medium inline-flex items-center gap-2 -mb-px border-b-2 transition"
              style={{
                borderColor: active ? "var(--brand-600)" : "transparent",
                color: active ? "var(--color-fg)" : "var(--color-fg-soft)",
              }}
            >
              <Icon size={14} />
              {t.label}
              {count > 0 && (
                <span
                  className="text-[10px] font-bold rounded-full px-1.5 py-0.5"
                  style={{
                    background: active ? "var(--brand-600)" : "var(--color-bg-soft)",
                    color: active ? "white" : "var(--color-fg-soft)",
                  }}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="card text-center py-8"><span className="spinner" /></div>
      ) : err ? (
        <div className="card text-sm text-red-700 bg-red-50 border-red-200 flex items-start gap-2">
          <AlertCircle size={16} className="mt-0.5 shrink-0" /> {err}
        </div>
      ) : rows.length === 0 ? (
        <div className="card text-center py-10 muted text-sm">
          {showBootstrapHint ? (
            <>
              Nothing to approve here — in bootstrap mode no one but you can submit proposals,
              and approving your own draft happens on{" "}
              <button
                type="button"
                className="font-semibold underline"
                onClick={() => setTab("mine")}
                style={{ color: "var(--brand-700)" }}
              >
                My drafts
              </button>.
            </>
          ) : (
            <>Nothing in this tab.</>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <ProposalCard key={r.id} row={r} meId={meId} />
          ))}
        </div>
      )}
    </div>
  );
}

// ----- card ----------------------------------------------------------------

function ProposalCard({ row, meId }: { row: HydratedProposal; meId: string | null }) {
  const isMine = meId && row.created_by === meId;
  const subjectLabel = useMemo(() => {
    if (row.kind === "edit") {
      return `Edit: ${row.target_plan?.label || row.target_plan?.slug || "unknown plan"}`;
    }
    const proposed = row.proposed as { slug?: string; label?: string };
    return `Create: ${proposed.label || proposed.slug || "(unnamed SKU)"}`;
  }, [row]);

  const headline = headlineFor(row);

  return (
    <Link
      href={`/admin/plans/queue/${row.id}`}
      className="card card-hover flex items-start gap-3 flex-wrap block"
    >
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <KindBadge kind={row.kind} />
          <span className="font-bold text-base">{subjectLabel}</span>
          <StatusPill status={row.status} bootstrapSelfApprove={row.bootstrap_self_approve} />
        </div>
        {row.parent_plan && row.kind === "create" && (
          <div className="text-xs muted">
            Cloned from <strong>{row.parent_plan.label}</strong> (<code className="text-[10px]">{row.parent_plan.slug}</code>)
          </div>
        )}
        {headline && <div className="text-xs">{headline}</div>}
        <div className="text-[11px] muted">
          By <strong>{row.created_by_name || (isMine ? "you" : "another admin")}</strong>{" "}
          · {relativeTime(row.created_at)}
          {row.status === "approved" && row.approved_at && (
            <>
              {" "}· approved by{" "}
              <strong>{row.approved_by_name || "—"}</strong>
              {" "}{relativeTime(row.approved_at)}
              {row.approved_with_edits && <span className="ml-1 italic">(with edits)</span>}
            </>
          )}
          {row.status === "rejected" && row.rejected_at && (
            <>
              {" "}· rejected by <strong>{row.rejected_by_name || "—"}</strong>{" "}
              {relativeTime(row.rejected_at)}
            </>
          )}
          {row.status === "withdrawn" && row.withdrawn_at && (
            <> · withdrawn {relativeTime(row.withdrawn_at)}</>
          )}
        </div>
        {row.status === "rejected" && row.rejection_reason && (
          <div className="text-xs italic" style={{ color: "var(--color-fg-soft)" }}>
            &ldquo;{row.rejection_reason}&rdquo;
          </div>
        )}
      </div>
    </Link>
  );
}

function KindBadge({ kind }: { kind: PlanProposalKind }) {
  const isEdit = kind === "edit";
  return (
    <span
      className="text-[10px] uppercase tracking-wide font-bold rounded-full px-2 py-0.5 inline-flex items-center gap-1"
      style={{
        background: isEdit ? "var(--color-bg-soft)" : "color-mix(in oklab, var(--brand-100) 60%, transparent)",
        color: isEdit ? "var(--color-fg-soft)" : "var(--brand-700)",
        border: "1px solid var(--color-border)",
      }}
    >
      {isEdit ? <Pencil size={10} /> : <Plus size={10} />}
      {isEdit ? "Edit" : "New SKU"}
    </span>
  );
}

function StatusPill({ status, bootstrapSelfApprove }: { status: PlanProposalStatus; bootstrapSelfApprove: boolean }) {
  const map: Record<PlanProposalStatus, { label: string; bg: string; fg: string }> = {
    open:      { label: "Open",      bg: "color-mix(in oklab, #ffe 50%, transparent)", fg: "#a07700" },
    approved:  { label: "Approved",  bg: "color-mix(in oklab, var(--brand-100) 50%, transparent)", fg: "var(--brand-700)" },
    rejected:  { label: "Rejected",  bg: "#fee", fg: "#a40000" },
    withdrawn: { label: "Withdrawn", bg: "var(--color-bg-soft)", fg: "var(--color-fg-soft)" },
  };
  const m = map[status];
  return (
    <>
      <span
        className="text-[10px] uppercase tracking-wide font-bold rounded-full px-2 py-0.5"
        style={{ background: m.bg, color: m.fg, border: "1px solid var(--color-border)" }}
      >
        {m.label}
      </span>
      {bootstrapSelfApprove && status === "approved" && (
        <span
          className="text-[10px] uppercase tracking-wide font-bold rounded-full px-2 py-0.5"
          style={{
            background: "color-mix(in oklab, #fed 50%, transparent)",
            color: "#a05500",
            border: "1px solid var(--color-border)",
          }}
          title="Self-approved in bootstrap mode (single platform admin)"
        >
          Self-approve
        </span>
      )}
    </>
  );
}

function headlineFor(row: HydratedProposal): string | null {
  if (row.kind === "edit" && row.target_plan) {
    // Compare a few headline fields; spell out the diff.
    // We only have the proposed payload here; the target's full row isn't
    // hydrated on the list endpoint. Show a kind/edit hint instead.
    return "Tap to view changes →";
  }
  if (row.kind === "create") {
    const p = row.proposed as { tier?: string; price_paise?: number; period_days?: number };
    if (p.tier && p.price_paise !== undefined) {
      return `${p.tier} · ${rupees(p.price_paise)}${p.period_days ? ` / ${p.period_days}d` : ""}`;
    }
  }
  return null;
}
