"use client";

import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  ArrowLeft, AlertCircle, CheckCircle2, XCircle, ShieldAlert, Pencil, Save,
  RotateCcw, MessageSquare, Trash2,
} from "lucide-react";
import {
  FEATURES_BY_CATEGORY,
  FEATURE_CATEGORY_ORDER,
  FEATURE_CATEGORY_LABELS,
} from "@/lib/features";
import PlanDiff from "@/components/PlanDiff";
import type { Plan, PlanChangeProposal, PlanProposalPayload } from "@/lib/types";

/**
 * /admin/plans/queue/[id]
 *
 * Single proposal detail. Three layout states driven by status + permission:
 *
 *   1. Open + I am the creator → "review your draft" mode. Edit / withdraw
 *      affordances at the top. In bootstrap mode, ALSO an Approve action
 *      since self-approval is permitted.
 *   2. Open + I am NOT the creator → "approve / reject" mode. Approve as-is
 *      / Edit and approve / Reject-with-reason. Two-eyes enforced server-side.
 *   3. Decided (approved/rejected/withdrawn) → audit-only view, no actions.
 *
 * The diff (parent/target on the left, proposed on the right) is always
 * rendered. When the approver clicks "Edit and approve", the right side
 * flips to a form where every editable field is mutable; saving from there
 * calls POST /approve with the override payload.
 */

type PageProps = { params: Promise<{ id: string }> };

type HydratedProposal = PlanChangeProposal & {
  target_plan: Plan | null;
  parent_plan: Plan | null;
  created_by_name: string | null;
  approved_by_name: string | null;
  rejected_by_name: string | null;
};

export default function PlanProposalDetailPage(props: PageProps) {
  const { id } = usePromise(props.params);
  const router = useRouter();

  const [proposal, setProposal] = useState<HydratedProposal | null>(null);
  const [meId, setMeId] = useState<string | null>(null);
  const [bootstrapMode, setBootstrapMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Inline edit-form state.
  // - 'approver': non-creator approver editing before approving.
  //   Save calls POST /approve with overrides.
  // - 'creator-draft': creator iterating on their own open draft.
  //   Save calls PATCH on the proposal record (does NOT approve).
  // - null: not editing.
  const [editing, setEditing] = useState<"approver" | "creator-draft" | null>(null);
  const [editPayload, setEditPayload] = useState<PlanProposalPayload | null>(null);
  const [busy, setBusy] = useState<"approve" | "reject" | "withdraw" | "save-draft" | null>(null);

  // Reject confirmation modal.
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const sb = supabaseBrowser();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Not signed in.");
      const r = await fetch(`/api/admin/plan-proposals/${id}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Could not load proposal.");
      setProposal(j.proposal);
      setMeId(j.current_user_id || null);
      setBootstrapMode(!!j.bootstrap_mode);
      setEditPayload(j.proposal.proposed);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load proposal.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function bearer(): Promise<string> {
    const sb = supabaseBrowser();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw new Error("Not signed in.");
    return session.access_token;
  }

  async function approve(withEdits: boolean) {
    if (!proposal) return;
    setBusy("approve");
    setErr(null);
    try {
      const token = await bearer();
      const body = withEdits && editPayload ? { proposed: editPayload } : {};
      const r = await fetch(`/api/admin/plan-proposals/${proposal.id}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Approve failed.");
      // After approve, navigate back to the queue with a success hash so
      // the user sees confirmation. (We don't toast here to stay
      // dependency-light.)
      router.push("/admin/plans/queue?ok=approved");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Approve failed.");
      setBusy(null);
    }
  }

  async function reject() {
    if (!proposal) return;
    if (!rejectReason.trim()) {
      setErr("Rejection reason is required.");
      return;
    }
    setBusy("reject");
    setErr(null);
    try {
      const token = await bearer();
      const r = await fetch(`/api/admin/plan-proposals/${proposal.id}/reject`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ reason: rejectReason.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Reject failed.");
      router.push("/admin/plans/queue?ok=rejected");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Reject failed.");
      setBusy(null);
    }
  }

  async function withdraw() {
    if (!proposal) return;
    setBusy("withdraw");
    setErr(null);
    try {
      const token = await bearer();
      const r = await fetch(`/api/admin/plan-proposals/${proposal.id}/withdraw`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Withdraw failed.");
      router.push("/admin/plans/queue?ok=withdrawn");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Withdraw failed.");
      setBusy(null);
    }
  }

  // Creator-only: save edits to the open draft via PATCH. Doesn't approve.
  // Does NOT redirect — keeps the user on the detail page so they can keep
  // iterating, withdraw, or hand off to the approver.
  async function saveDraft() {
    if (!proposal || !editPayload) return;
    setBusy("save-draft");
    setErr(null);
    try {
      const token = await bearer();
      const r = await fetch(`/api/admin/plan-proposals/${proposal.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ proposed: editPayload }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Save failed.");
      // Re-load so the diff reflects the saved values, then collapse the form.
      await load();
      setEditing(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return <div className="grid place-items-center py-20"><div className="spinner" /></div>;
  }
  if (err && !proposal) {
    return (
      <div className="card text-sm text-red-700 bg-red-50 border-red-200 flex items-start gap-2">
        <AlertCircle size={16} className="mt-0.5 shrink-0" /> {err}
      </div>
    );
  }
  if (!proposal) return null;

  const isMine = meId && proposal.created_by === meId;
  const isOpen = proposal.status === "open";
  // Approve is permitted if either: (a) someone other than the creator
  // (two-eyes), or (b) bootstrap mode (single admin).
  const canApprove = isOpen && (!isMine || bootstrapMode);
  const canEdit = isOpen && isMine; // PATCH endpoint is creator-only.
  const canWithdraw = isOpen && isMine;

  // Left side of the diff:
  // - kind=edit  → target plan (the live row being modified)
  // - kind=create + parent → parent plan (template)
  // - kind=create no parent → null (renders "no template" baseline)
  const leftPlan: Plan | null = proposal.kind === "edit"
    ? proposal.target_plan
    : proposal.parent_plan;

  const leftLabel = proposal.kind === "edit"
    ? `Live: ${proposal.target_plan?.label || "—"}`
    : proposal.parent_plan
    ? `Template: ${proposal.parent_plan.label}`
    : "No template (from-scratch)";

  const rightLabel =
    editing === "approver" ? "Approver edits (will be applied)" :
    editing === "creator-draft" ? "Your draft edits (will be saved, not approved)" :
    "Proposed";

  return (
    <div className="fade-in">
      <div className="flex items-center gap-3 mb-2">
        <Link href="/admin/plans/queue" className="text-sm font-semibold inline-flex items-center gap-1" style={{ color: "var(--brand-700)" }}>
          <ArrowLeft size={14} /> Back to queue
        </Link>
      </div>

      <h1 className="h1 mb-1">
        {proposal.kind === "edit"
          ? `Edit proposal — ${proposal.target_plan?.label || "—"}`
          : `New SKU proposal — ${(proposal.proposed.label as string) || "(unnamed)"}`}
      </h1>
      <p className="muted text-sm mb-1">
        Submitted by <strong>{proposal.created_by_name || (isMine ? "you" : "another admin")}</strong> · {new Date(proposal.created_at).toLocaleString()}
      </p>
      <p className="muted text-xs mb-5">
        Proposal id <code className="text-[10px]">{proposal.id}</code>
      </p>

      {bootstrapMode && isMine && isOpen && (
        <div className="card mb-4 flex items-start gap-3" style={{ background: "color-mix(in oklab, #ffe 50%, transparent)", borderColor: "#e6c200" }}>
          <ShieldAlert size={18} className="mt-0.5 shrink-0" style={{ color: "#a07700" }} />
          <div className="text-sm">
            <strong>Bootstrap self-approval enabled</strong> — approving below will be flagged in the audit log.
          </div>
        </div>
      )}

      {/* Status banner for non-open proposals (audit-only view) */}
      {!isOpen && (
        <DecidedBanner proposal={proposal} />
      )}

      {/* Action bar (only for open proposals) */}
      {isOpen && (
        <div className="card mb-5 flex items-center gap-2 flex-wrap" style={{ background: "var(--color-bg-soft)" }}>
          {canApprove && editing === null && (
            <button
              type="button"
              className="btn btn-primary text-sm"
              disabled={busy !== null}
              onClick={() => approve(false)}
            >
              <CheckCircle2 size={14} /> Approve as-is
            </button>
          )}
          {canApprove && editing === null && (
            <button
              type="button"
              className="btn btn-secondary text-sm"
              disabled={busy !== null}
              onClick={() => setEditing("approver")}
            >
              <Pencil size={14} /> Edit and approve
            </button>
          )}
          {/* Creator-only: edit your own open draft. Visible regardless of
              canApprove (so it shows in bootstrap mode too). Saves via PATCH;
              does NOT approve. Replaces the previous 404-link Edit-draft
              affordance. */}
          {canEdit && editing === null && (
            <button
              type="button"
              className="btn btn-secondary text-sm"
              disabled={busy !== null}
              onClick={() => setEditing("creator-draft")}
            >
              <Pencil size={14} /> Edit draft
            </button>
          )}
          {editing === "approver" && (
            <>
              <button
                type="button"
                className="btn btn-primary text-sm"
                disabled={busy !== null}
                onClick={() => approve(true)}
              >
                <Save size={14} /> Save edits + approve
              </button>
              <button
                type="button"
                className="btn btn-secondary text-sm"
                disabled={busy !== null}
                onClick={() => { setEditing(null); setEditPayload(proposal.proposed); }}
              >
                <RotateCcw size={14} /> Discard edits
              </button>
            </>
          )}
          {editing === "creator-draft" && (
            <>
              <button
                type="button"
                className="btn btn-primary text-sm"
                disabled={busy !== null}
                onClick={saveDraft}
              >
                {busy === "save-draft" ? <span className="spinner" /> : <Save size={14} />} Save draft
              </button>
              <button
                type="button"
                className="btn btn-secondary text-sm"
                disabled={busy !== null}
                onClick={() => { setEditing(null); setEditPayload(proposal.proposed); }}
              >
                <RotateCcw size={14} /> Discard edits
              </button>
            </>
          )}
          {canApprove && editing === null && (
            <button
              type="button"
              className="btn btn-secondary text-sm"
              disabled={busy !== null}
              onClick={() => setShowReject(true)}
              style={{ color: "#a40000", borderColor: "#fcc" }}
            >
              <XCircle size={14} /> Reject…
            </button>
          )}
          {canWithdraw && editing === null && (
            <button
              type="button"
              className="btn btn-secondary text-sm ml-auto"
              disabled={busy !== null}
              onClick={withdraw}
              title="Withdraw your draft (no audit reason required)"
            >
              <Trash2 size={14} /> Withdraw
            </button>
          )}
        </div>
      )}

      {err && (
        <div className="card text-sm text-red-700 bg-red-50 border-red-200 flex items-start gap-2 mb-4">
          <AlertCircle size={16} className="mt-0.5 shrink-0" /> {err}
        </div>
      )}

      {/* Diff or edit form */}
      {editing && editPayload ? (
        <ApproverEditForm
          left={leftPlan}
          leftLabel={leftLabel}
          payload={editPayload}
          onChange={setEditPayload}
          mode={editing}
        />
      ) : (
        <PlanDiff
          left={leftPlan as unknown as Parameters<typeof PlanDiff>[0]["left"]}
          right={proposal.proposed}
          leftLabel={leftLabel}
          rightLabel={rightLabel}
          kind={proposal.kind}
          contextNote={
            proposal.kind === "create" && proposal.parent_plan
              ? `Cloned from ${proposal.parent_plan.label} as a template — every field below is editable independent of the parent.`
              : proposal.kind === "create" && !proposal.parent_plan
              ? "Created from scratch (no template). Left side shows the empty default."
              : undefined
          }
        />
      )}

      {/* Reject modal */}
      {showReject && (
        <RejectModal
          reason={rejectReason}
          setReason={setRejectReason}
          busy={busy === "reject"}
          onCancel={() => { setShowReject(false); setRejectReason(""); }}
          onConfirm={reject}
        />
      )}
    </div>
  );
}

// =====================================================================
// Audit-only banner for non-open proposals.
// =====================================================================

function DecidedBanner({ proposal }: { proposal: HydratedProposal }) {
  if (proposal.status === "approved") {
    return (
      <div className="card mb-5 flex items-start gap-3" style={{ background: "color-mix(in oklab, var(--brand-100) 35%, transparent)", borderColor: "var(--brand-300)" }}>
        <CheckCircle2 size={18} className="mt-0.5 shrink-0" style={{ color: "var(--brand-700)" }} />
        <div className="text-sm">
          <strong>Approved</strong> by {proposal.approved_by_name || "—"} on{" "}
          {proposal.approved_at ? new Date(proposal.approved_at).toLocaleString() : "—"}.
          {proposal.approved_with_edits && <span className="ml-1 italic">(approver edited the payload before approving — original creator submission is preserved in the diff history)</span>}
          {/* F177 note (QA): we say "preserved in the diff history" but
              don't actually RENDER a diff here. The data is on the
              proposal row (proposed_at_submit + proposed). Add a side-by-
              side diff view (e.g. JSON.stringify on each, react-diff-viewer
              or a tiny custom diff) under this header so the approver
              can see exactly what changed. Tracked in AUDIT.md Section 3. */}
          {/* F177 note (QA): we say "preserved in the diff history" but
              don't actually RENDER a diff here. The data is on the
              proposal row (proposed_at_submit + proposed). Add a side-by-
              side diff view (e.g. JSON.stringify on each, react-diff-viewer
              or a tiny custom diff) under this header so the approver
              can see exactly what changed. Tracked in AUDIT.md Section 3. */}
          {proposal.bootstrap_self_approve && <span className="ml-1 italic">Bootstrap self-approval flagged.</span>}
        </div>
      </div>
    );
  }
  if (proposal.status === "rejected") {
    return (
      <div className="card mb-5" style={{ background: "color-mix(in oklab, #fee 35%, transparent)", borderColor: "#fcc" }}>
        <div className="flex items-start gap-3">
          <XCircle size={18} className="mt-0.5 shrink-0 text-red-700" />
          <div className="text-sm">
            <strong>Rejected</strong> by {proposal.rejected_by_name || "—"} on{" "}
            {proposal.rejected_at ? new Date(proposal.rejected_at).toLocaleString() : "—"}.
            {proposal.rejection_reason && (
              <div className="mt-1 italic">&ldquo;{proposal.rejection_reason}&rdquo;</div>
            )}
          </div>
        </div>
      </div>
    );
  }
  if (proposal.status === "withdrawn") {
    return (
      <div className="card mb-5" style={{ background: "var(--color-bg-soft)" }}>
        <div className="flex items-start gap-3 text-sm">
          <Trash2 size={18} className="mt-0.5 shrink-0 muted" />
          <div>
            <strong>Withdrawn</strong> by the creator on{" "}
            {proposal.withdrawn_at ? new Date(proposal.withdrawn_at).toLocaleString() : "—"}.
          </div>
        </div>
      </div>
    );
  }
  return null;
}

// =====================================================================
// Reject confirmation modal.
// =====================================================================

function RejectModal({
  reason, setReason, busy, onCancel, onConfirm,
}: {
  reason: string;
  setReason: (s: string) => void;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-4"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onCancel}
    >
      <div
        className="card max-w-md w-full"
        style={{ background: "var(--color-card)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold mb-1 flex items-center gap-2">
          <XCircle size={18} className="text-red-700" /> Reject proposal
        </h2>
        <p className="text-sm muted mb-3">
          The creator will see your reason. Be specific about what needs to change.
        </p>
        <label className="label">
          <span className="inline-flex items-center gap-1"><MessageSquare size={12} /> Reason</span>
        </label>
        <textarea
          className="input"
          rows={4}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Price seems too low for this tier. Bump to ₹999 and resubmit."
          autoFocus
        />
        <div className="flex justify-end gap-2 mt-4">
          <button type="button" className="btn btn-secondary text-sm" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary text-sm"
            onClick={onConfirm}
            disabled={busy || !reason.trim()}
            style={{ background: "#a40000", borderColor: "#a40000" }}
          >
            {busy ? <span className="spinner" /> : <XCircle size={14} />} Reject
          </button>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// Approver edit form — pre-fills from the proposed payload, lets the
// approver tweak any field, saves via /approve with override body.
// =====================================================================

function ApproverEditForm({
  left, leftLabel, payload, onChange, mode,
}: {
  left: Plan | null;
  leftLabel: string;
  payload: PlanProposalPayload;
  onChange: (p: PlanProposalPayload) => void;
  // 'approver' or 'creator-draft' — only changes the right-column header.
  mode: "approver" | "creator-draft";
}) {
  function patch(updates: Partial<PlanProposalPayload>) {
    onChange({ ...payload, ...updates });
  }

  function toggleFeature(key: string) {
    const set = new Set(payload.features || []);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    patch({ features: Array.from(set) });
  }

  return (
    <div className="grid lg:grid-cols-2 gap-4">
      {/* Left side: read-only baseline */}
      <div className="card" style={{ background: "var(--color-bg-soft)" }}>
        <h3 className="text-xs uppercase tracking-wide font-bold mb-3" style={{ color: "var(--color-fg-soft)" }}>
          {leftLabel}
        </h3>
        {left ? (
          <ReadOnlyPlanSummary plan={left} />
        ) : (
          <div className="text-xs muted italic">No template — everything on the right is new.</div>
        )}
      </div>

      {/* Right side: editable form */}
      <div className="card">
        <h3 className="text-xs uppercase tracking-wide font-bold mb-3" style={{ color: "var(--brand-700)" }}>
          {mode === "approver" ? "Approver edits" : "Your draft (will be saved, not approved)"}
        </h3>

        <div className="space-y-3">
          <div>
            <label className="label">Display name</label>
            <input
              className="input"
              value={payload.label}
              onChange={(e) => patch({ label: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Blurb</label>
            <input
              className="input"
              value={payload.blurb || ""}
              onChange={(e) => patch({ blurb: e.target.value || null })}
            />
          </div>

          <div>
            <label className="label">Pricing model</label>
            <select
              className="input"
              value={payload.pricing_model}
              onChange={(e) => patch({ pricing_model: e.target.value as "fixed" | "per_student" })}
            >
              <option value="fixed">Fixed</option>
              <option value="per_student">Per-student</option>
            </select>
          </div>

          {payload.pricing_model === "fixed" && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">Price (₹)</label>
                <input
                  className="input tabular-nums"
                  type="number"
                  min={0}
                  value={payload.price_paise / 100}
                  onChange={(e) => patch({ price_paise: Math.round(parseFloat(e.target.value || "0") * 100) })}
                />
              </div>
              <div>
                <label className="label">Period (days)</label>
                <input
                  className="input tabular-nums"
                  type="number"
                  min={0}
                  value={payload.period_days}
                  onChange={(e) => patch({ period_days: parseInt(e.target.value || "0", 10) })}
                />
              </div>
            </div>
          )}

          {payload.pricing_model === "per_student" && (
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="label">Per-student (₹)</label>
                <input
                  className="input tabular-nums"
                  type="number"
                  min={0}
                  step="0.01"
                  value={payload.per_student_price_paise / 100}
                  onChange={(e) => patch({ per_student_price_paise: Math.round(parseFloat(e.target.value || "0") * 100) })}
                />
              </div>
              <div>
                <label className="label">Min students</label>
                <input
                  className="input tabular-nums"
                  type="number"
                  min={0}
                  value={payload.min_students}
                  onChange={(e) => patch({ min_students: parseInt(e.target.value || "0", 10) })}
                />
              </div>
              <div>
                <label className="label">Max students</label>
                <input
                  className="input tabular-nums"
                  type="number"
                  min={0}
                  value={payload.max_students ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    patch({ max_students: v === "" ? null : parseInt(v, 10) });
                  }}
                  placeholder="no cap"
                />
              </div>
            </div>
          )}

          <div>
            <label className="label">Razorpay plan id</label>
            <input
              className="input font-mono text-sm"
              value={payload.razorpay_plan_id || ""}
              onChange={(e) => patch({ razorpay_plan_id: e.target.value || null })}
              placeholder="plan_XXXXX (deferred — leave blank for now)"
            />
          </div>

          <div>
            <h4 className="label mb-2">Gated features</h4>
            <div className="space-y-3 max-h-96 overflow-y-auto pr-2">
              {FEATURE_CATEGORY_ORDER.map((cat) => {
                const inCat = FEATURES_BY_CATEGORY[cat] || [];
                if (inCat.length === 0) return null;
                return (
                  <div key={cat}>
                    <div className="text-[11px] uppercase tracking-wide font-bold mb-1" style={{ color: "var(--color-fg-soft)" }}>
                      {FEATURE_CATEGORY_LABELS[cat]}
                    </div>
                    <div className="grid grid-cols-1 gap-1">
                      {inCat.map((f) => {
                        const on = (payload.features || []).includes(f.key);
                        return (
                          <label key={f.key} className="flex items-start gap-2 text-xs cursor-pointer p-1 rounded hover:bg-slate-50">
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => toggleFeature(f.key)}
                              className="mt-0.5"
                            />
                            <span>
                              <strong>{f.label}</strong>{" "}
                              <span className="muted">— {f.description}</span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReadOnlyPlanSummary({ plan }: { plan: Plan }) {
  return (
    <div className="text-sm space-y-1">
      <div><span className="muted text-xs">Slug:</span> <code className="text-[11px]">{plan.slug}</code></div>
      <div><span className="muted text-xs">Tier:</span> {plan.tier}</div>
      <div><span className="muted text-xs">Label:</span> {plan.label}</div>
      <div><span className="muted text-xs">Pricing:</span> {plan.pricing_model}</div>
      <div><span className="muted text-xs">Price:</span> {plan.pricing_model === "fixed" ? `₹${(plan.price_paise / 100).toLocaleString("en-IN")} / ${plan.period_days}d` : `₹${(plan.per_student_price_paise / 100).toLocaleString("en-IN")} / student`}</div>
      <div><span className="muted text-xs">Features:</span> {plan.features?.length || 0}</div>
    </div>
  );
}
