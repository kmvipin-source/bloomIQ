-- =============================================================================
-- 64_subscription_invoice_archive.sql
-- -----------------------------------------------------------------------------
-- Past-billing-cycle archive for B2B school subscriptions.
--
-- Today the `subscriptions` row stores ONE billing cycle:
--    invoice_number, payment_received_at, expires_at, override_price_paise,
--    contracted_students, payment_method.
--
-- That works for a brand-new sale, but breaks for renewals:
--   1. Each new financial year needs a FRESH GST-compliant invoice number
--      (BLM/2027/0001, not the previous BLM/2026/0007 reused).
--   2. Finance + auditors need to see "this school paid X for term Y, then
--      paid Z for term Y+1" — a per-cycle history.
--
-- This migration adds an archive table that captures each closed billing
-- cycle when the platform admin clicks "Start renewal cycle" on the
-- per-school page. The subscription row keeps representing the CURRENT
-- cycle; the archive captures everything previous, immutably.
--
-- Rows are inserted by the set-plan endpoint when `start_renewal: true`
-- is passed; never updated, never deleted. Service-role only — RLS
-- denies everyone else (platform admin reads via API endpoints, never
-- direct PostgREST).
-- =============================================================================

create table if not exists public.subscription_invoice_archive (
  id                       uuid primary key default gen_random_uuid(),
  subscription_id          uuid not null references public.subscriptions(id) on delete cascade,
  school_id                uuid not null references public.schools(id) on delete cascade,
  -- The closed cycle's snapshot. All fields nullable because legacy rows
  -- might not have every field set.
  plan_id                  uuid references public.plans(id) on delete set null,
  invoice_number           text,
  contracted_students      integer,
  override_price_paise     integer,
  override_reason          text,
  payment_method           text,
  payment_received_at      timestamptz,
  cycle_started_at         timestamptz,
  cycle_expires_at         timestamptz,
  -- Audit: who archived this cycle (clicked "Start renewal cycle") + when.
  archived_by              uuid references auth.users(id) on delete set null,
  archived_at              timestamptz not null default now()
);

create index if not exists subscription_invoice_archive_subscription_idx
  on public.subscription_invoice_archive (subscription_id, archived_at desc);

create index if not exists subscription_invoice_archive_school_idx
  on public.subscription_invoice_archive (school_id, archived_at desc);

-- RLS: locked down. All reads + writes go through service-role API
-- endpoints that re-check platform_admin. We do not give platform_admins
-- direct PostgREST access here — that's the same pattern as
-- `subscriptions` (see migration 62).
alter table public.subscription_invoice_archive enable row level security;

-- Drop any prior versions of these policies so the migration is rerunnable.
drop policy if exists subscription_invoice_archive_select on public.subscription_invoice_archive;
drop policy if exists subscription_invoice_archive_insert on public.subscription_invoice_archive;

-- No-op policies (deny everyone) — service role bypasses RLS, so the
-- API still reads/writes; everyone else gets nothing.
create policy subscription_invoice_archive_select
  on public.subscription_invoice_archive
  for select using (false);

create policy subscription_invoice_archive_insert
  on public.subscription_invoice_archive
  for insert with check (false);

comment on table public.subscription_invoice_archive is
  'Immutable per-billing-cycle snapshot. Populated by set-plan when start_renewal:true is passed; the live subscriptions row then represents only the new cycle. Service-role-only access.';

notify pgrst, 'reload schema';
