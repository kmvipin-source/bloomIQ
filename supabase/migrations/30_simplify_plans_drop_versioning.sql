-- =============================================================================
-- Migration 30 — Drop plan versioning, switch to a stable SKU catalogue
-- -----------------------------------------------------------------------------
-- Why this exists
-- ---------------
-- Migration 25 modeled plans as VERSIONED rows: every price or feature
-- change created a new row, and subscriptions were pinned to a specific
-- version via subscriptions.plan_id. This was over-engineered for
-- BloomIQ's actual business model:
--
--   - All BloomIQ subscriptions are annual (or shorter) terms with explicit
--     renewal. There's no perpetual "buy once, keep forever" SKU.
--   - The only thing that genuinely needs to be locked-in for an existing
--     customer is the PRICE for their current term. Features are fine to
--     update live (this matches Spotify, Netflix, Notion — every consumer
--     SaaS works this way).
--   - Versioning made /admin/plans grow forever, mixing "what we're
--     selling now" with "old snapshots we're honoring." After 6 months
--     of price tweaks, the page becomes unmanageable and the admin can
--     accidentally edit the wrong version.
--
-- New mental model
-- ----------------
-- One row per SKU. Forever. Editable in place.
--   - Free
--   - Premium Monthly / Premium Annual
--   - Premium Plus Monthly / Premium Plus Annual
--   - School Pilot / School Standard / School Plus
--   = 8 stable rows; the catalogue.
--
-- Subscriptions pin price_paid_paise at purchase time. That number stays
-- fixed for the rest of the term (until expires_at). On renewal, a new
-- subscription row is created with the current plan price. Features are
-- always read from the live plan, no snapshot lookup.
--
-- What this migration does
-- ------------------------
--   1. Repoint any subscription on a non-active plan version to the
--      surviving 'active' version with the same slug. (Should rarely
--      apply; most subscribers are on active versions.)
--   2. Delete archived/draft/pending plan rows — they're no longer needed.
--   3. Drop the plan_audit table — no more workflow events to record.
--   4. Drop the workflow columns: status, effective_from, effective_to,
--      created_by, approved_by. Drop plans_two_eyes constraint and the
--      partial unique index that enforced one-active-per-slug.
--   5. Add a plain UNIQUE(slug) — exactly one row per SKU now.
--   6. Add subscriptions.price_paid_paise integer NOT NULL DEFAULT 0
--      and backfill from the current plan price.
--   7. Update the public-read RLS policy on plans to allow reading every
--      row (no more 'status=active' filter — every row IS active now).
--
-- Safety: this migration is destructive of plan_audit and any non-active
-- plan rows. Run it in a project where you've already inspected the
-- plans table for anything you want to keep. No customer data is lost —
-- subscriptions are repointed before any rows are removed.
-- =============================================================================

-- 0. Drop dependent RLS policies that reference 'status' before we drop the column
drop policy if exists "plans read active public" on public.plans;

-- 1. Repoint subscriptions on non-active versions to the surviving active row
update public.subscriptions s
set plan_id = active_p.id
from public.plans old_p
join public.plans active_p
  on active_p.slug = old_p.slug
 and active_p.status = 'active'
where s.plan_id = old_p.id
  and old_p.status <> 'active';

-- 2. Delete the now-orphan non-active plan rows
delete from public.plans where status <> 'active';

-- 3. Drop the audit table — the workflow it logged no longer exists
drop table if exists public.plan_audit cascade;

-- 4. Drop workflow infrastructure
alter table public.plans
  drop constraint if exists plans_two_eyes;

drop index if exists public.plans_one_active_per_slug;
drop index if exists public.plans_status_idx;

alter table public.plans
  drop column if exists status,
  drop column if exists effective_from,
  drop column if exists effective_to,
  drop column if exists created_by,
  drop column if exists approved_by,
  drop column if exists approved_at;

-- 5. One row per slug, period
alter table public.plans
  drop constraint if exists plans_slug_unique;
alter table public.plans
  add constraint plans_slug_unique unique (slug);

-- 6. Lock the price the customer actually paid for THIS term.
-- This is the only piece of grandfathering we keep: their price doesn't
-- change mid-term. On renewal, a new subscription row gets the live price.
alter table public.subscriptions
  add column if not exists price_paid_paise integer not null default 0;

-- Backfill from the current plan price. For per-student school plans we
-- have no school_size column on subscriptions (the per-student math
-- happens at checkout); legacy rows just store 0 and that's fine for
-- historical accuracy — we don't need to retroactively reconstruct them.
update public.subscriptions s
set price_paid_paise = coalesce(p.price_paise, 0)
from public.plans p
where s.plan_id = p.id
  and s.price_paid_paise = 0
  and coalesce(p.price_paise, 0) > 0;

-- 7. Replace the now-broken RLS policy with one that reads every plan
-- (every row IS sellable now).
drop policy if exists "plans read active public" on public.plans;
create policy "plans read public" on public.plans
  for select using (true);

-- platform-admin read + write policies created by migration 25 are still
-- valid (they don't reference 'status'). Leave them as-is.

-- Reload PostgREST so the schema cache picks up the new + dropped columns.
notify pgrst, 'reload schema';
