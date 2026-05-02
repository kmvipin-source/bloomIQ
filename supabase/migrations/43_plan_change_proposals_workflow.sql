-- =============================================================================
-- Migration 43 — Plan-change proposal workflow
-- -----------------------------------------------------------------------------
-- Adds a side table that captures every proposed change to a plan as a
-- self-contained payload. Drafts, in-flight reviews, approver-edits and
-- rejections all live here; the `public.plans` table stays as the live
-- catalogue (status='active' rows only). On approval the proposal's
-- payload is applied — INSERT for kind='create', UPDATE for kind='edit' —
-- and the proposal row is retained as the audit record.
--
-- Reconciles with migration 30 (drop versioning) and migration 32 (restore
-- workflow columns): the columns on `plans` from 32 (`status`, `created_by`,
-- `approved_by`, `approved_at`, `effective_from`, `effective_to`) become
-- audit-metadata about the live row. We never put draft rows in `plans`,
-- so no row bloat — every SKU has exactly one row, ever.
--
-- Bootstrap rule (per design discussion):
--   While exactly one `profiles.platform_admin = true` user exists, that
--   user is allowed to self-approve their own proposal — the proposal row
--   is stamped `bootstrap_self_approve = true`, and on apply we write
--   `plans.approved_by = NULL` to satisfy the existing `plans_two_eyes`
--   CHECK constraint. Once a second platform admin exists, self-approval
--   is hard-blocked at the API layer.
--
-- See README "Plan inheritance + approval workflow — design phase" entry.
-- =============================================================================

create table public.plan_change_proposals (
  id           uuid primary key default gen_random_uuid(),

  -- 'edit' modifies an existing live plan; 'create' mints a brand-new SKU.
  kind         text not null check (kind in ('edit', 'create')),

  -- For kind='edit', the live plan being modified.
  -- For kind='create', NULL.
  target_plan_id uuid references public.plans(id) on delete cascade,

  -- Informational only — which plan the proposer cloned from as a template.
  -- Has no operational meaning post-approval. Vipin's spec: "all existing
  -- plans can be used as a model"; this column just records which one was.
  parent_plan_id uuid references public.plans(id) on delete set null,

  -- The full proposed payload — every Plan field the proposer wants for
  -- the post-approval row. JSONB so the Plan shape can evolve without
  -- breaking historical proposals. Validated/cast at the API layer.
  proposed     jsonb not null,

  status       text not null default 'open'
               check (status in ('open', 'approved', 'rejected', 'withdrawn')),

  -- Audit: who proposed it, who approved/rejected, when.
  created_by   uuid not null references public.profiles(id) on delete restrict,
  created_at   timestamptz not null default now(),

  approved_by  uuid references public.profiles(id) on delete set null,
  approved_at  timestamptz,

  -- True when the approver edited the payload before approving — so the
  -- 'proposed' field reflects the approver's final version, not the
  -- creator's submission. The original submission is preserved in a
  -- snapshot column for diff-vs-original views.
  approved_with_edits boolean not null default false,

  -- Snapshot of `proposed` at submit-time. Null until the approver edits
  -- before approving (in which case `proposed` is overwritten with the
  -- approver's edits and this column captures what the creator originally
  -- submitted). Lets the diff view show creator-submitted vs approved.
  proposed_at_submit jsonb,

  -- True when self-approval was permitted because exactly one platform
  -- admin existed at approval time. Audit-only — surfaces in the queue UI
  -- so future admins can see which approvals weren't real two-eyes events.
  bootstrap_self_approve boolean not null default false,

  rejected_by  uuid references public.profiles(id) on delete set null,
  rejected_at  timestamptz,
  rejection_reason text,

  withdrawn_at timestamptz,

  -- Required-reason rule (per design): rejection without reason is forbidden.
  constraint proposals_rejected_needs_reason
    check (status <> 'rejected' or (rejection_reason is not null and length(trim(rejection_reason)) > 0)),

  -- Internal consistency: state ↔ stamp columns must agree.
  constraint proposals_approved_consistency
    check ((status = 'approved') = (approved_by is not null and approved_at is not null)),

  constraint proposals_rejected_consistency
    check ((status = 'rejected') = (rejected_by is not null and rejected_at is not null)),

  constraint proposals_withdrawn_consistency
    check ((status = 'withdrawn') = (withdrawn_at is not null)),

  -- kind ↔ target_plan_id must agree: edits must target an existing plan,
  -- creates must not.
  constraint proposals_target_matches_kind
    check (
      (kind = 'edit'   and target_plan_id is not null) or
      (kind = 'create' and target_plan_id is null)
    )
);

-- At most one OPEN edit-proposal per target. Prevents two admins racing
-- to draft conflicting edits on the same SKU; they collaborate on the
-- single draft (or the second admin withdraws/rejects the first).
create unique index proposals_one_open_edit_per_target
  on public.plan_change_proposals (target_plan_id)
  where status = 'open' and kind = 'edit';

-- Hot indexes for the queue UI's tab queries.
create index proposals_status_idx
  on public.plan_change_proposals (status);

create index proposals_created_by_idx
  on public.plan_change_proposals (created_by);

create index proposals_status_created_at_idx
  on public.plan_change_proposals (status, created_at desc);

-- RLS: only platform admins read or write. Service-role API routes bypass
-- RLS via supabaseAdmin(), but defense-in-depth here protects against
-- any future surface that uses an anon/user-token client.
alter table public.plan_change_proposals enable row level security;

create policy proposals_admin_read on public.plan_change_proposals
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_admin = true
  ));

create policy proposals_admin_write on public.plan_change_proposals
  for all to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_admin = true
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_admin = true
  ));

-- -------------------------------------------------------------------------
-- Razorpay sync placeholder.
--
-- Vipin chose to defer Razorpay subscription-plan sync to a follow-up
-- session (design Q3 = (c)). Adding the column now so the schema is
-- ready when that work lands. SKUs with razorpay_plan_id IS NULL are
-- admin-visible but not purchasable — the checkout API can guard on this.
-- -------------------------------------------------------------------------

alter table public.plans
  add column if not exists razorpay_plan_id text;

create unique index if not exists plans_razorpay_plan_id_idx
  on public.plans (razorpay_plan_id)
  where razorpay_plan_id is not null;

notify pgrst, 'reload schema';
