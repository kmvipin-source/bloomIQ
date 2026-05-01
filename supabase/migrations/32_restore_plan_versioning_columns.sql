-- =============================================================================
-- Migration 32 — restore plan versioning columns
-- -----------------------------------------------------------------------------
-- Commit `1d5282e` ("Plan simplification: drop versioning, edit-in-place SKU
-- catalogue") removed columns from `public.plans` directly via the SQL editor
-- but did NOT update the routes / pages that read them. Result: every call to
-- `/api/admin/plans`, `/api/pricing/active-plans`, the checkout flow, and the
-- /admin/plans pages 500'd with a schema-cache miss on `status`,
-- `effective_from`, `created_by`, etc.
--
-- This migration restores the dropped columns, backfills sensible defaults
-- for the 8 existing seeded plans, and re-creates the partial unique index
-- + two-eyes CHECK that the original schema (migration 25) had. After this
-- runs, all plan-admin / pricing / checkout routes work again.
--
-- If the simplification is still desired, do it as a follow-up that ALSO
-- updates every route + page that reads the dropped columns, NOT a column
-- drop alone.
-- =============================================================================

alter table public.plans
  add column if not exists status         text,
  add column if not exists effective_from timestamptz,
  add column if not exists effective_to   timestamptz,
  add column if not exists created_by     uuid references public.profiles(id) on delete set null,
  add column if not exists approved_by    uuid references public.profiles(id) on delete set null,
  add column if not exists approved_at    timestamptz;

-- Re-add CHECK constraints (idempotent: drop if previously present).
alter table public.plans drop constraint if exists plans_status_check;
alter table public.plans
  add constraint plans_status_check
  check (status in ('draft','pending_review','active','archived'));

alter table public.plans drop constraint if exists plans_two_eyes;
alter table public.plans
  add constraint plans_two_eyes
  check (approved_by is null or approved_by <> created_by);

-- Backfill existing rows so they're all considered the active version.
update public.plans set status = 'active' where status is null;
update public.plans set effective_from = coalesce(created_at, now()) where effective_from is null;

alter table public.plans alter column status set default 'active';
alter table public.plans alter column status set not null;

create unique index if not exists plans_one_active_per_slug
  on public.plans (slug)
  where status = 'active';

notify pgrst, 'reload schema';
