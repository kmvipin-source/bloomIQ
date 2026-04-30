-- BloomIQ: Plan-Admin foundation.
--
-- Creates the schema for versioned subscription plans with grandfathering:
-- when a platform admin changes pricing or feature buckets, the change
-- creates a NEW plan version. Existing subscribers stay bound to whatever
-- plan version they signed up under; new subscribers from the effective
-- date forward get the new version. This is the "add only, never remove"
-- guarantee discussed with Vipin in the 2026-04-30 strategy session.
--
-- Additive. Run after migration 24.

-- ========================================================================
-- 1) plans — versioned plan catalogue
-- ========================================================================
-- Each row is one *version* of a plan. The same logical plan (e.g.
-- "premium_monthly") can have many versions over time, distinguished by
-- effective_from. Only one version per slug should be 'active' at any
-- given moment; the others are 'draft', 'pending_review', or 'archived'.
create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),

  -- Stable slug like 'free', 'premium_monthly', 'premium_plus_monthly',
  -- 'school_per_student_year'. Multiple rows can share a slug across
  -- versions; the (slug, status='active') combination is unique by partial
  -- index below.
  slug text not null,

  -- High-level tier — used by the /pricing page to pick the right card.
  -- Free maps to no upgrade, premium / premium_plus to the two paid tiers.
  -- 'school_*' tiers cover institutional plans.
  tier text not null check (tier in (
    'free', 'premium', 'premium_plus',
    'school_pilot', 'school_standard', 'school_plus'
  )),

  -- Display copy.
  label text not null,
  blurb text,                             -- short tagline for /pricing card
  feature_summary text[] default '{}',    -- bulleted feature list copy

  -- Money — Razorpay convention is INR paise.
  price_paise integer not null default 0,
  currency text not null default 'INR',
  period_days integer not null default 30,  -- 30 monthly, 365 annual, 0 free

  -- The actual feature gate — array of feature keys from lib/features.ts.
  features jsonb not null default '[]'::jsonb,

  -- Versioning + workflow state.
  status text not null default 'draft' check (status in (
    'draft',           -- being authored, only visible to creator + admins
    'pending_review',  -- submitted, awaiting another admin's approval
    'active',          -- approved, current version for its slug
    'archived'         -- superseded by a newer version OR rejected
  )),

  -- Effective dates. effective_from is the timestamp at which the plan
  -- first becomes purchasable for new subscribers. effective_to is set
  -- when a successor takes over (so we can tell "what was active on date X").
  effective_from timestamptz,
  effective_to timestamptz,

  -- Audit trail on the row.
  created_by uuid references public.profiles(id) on delete set null,
  approved_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  approved_at timestamptz,

  -- Two-eyes principle: approver must be different from creator.
  constraint plans_two_eyes check (approved_by is null or approved_by <> created_by)
);

create index if not exists plans_slug_idx on public.plans (slug);
create index if not exists plans_tier_idx on public.plans (tier);
create index if not exists plans_status_idx on public.plans (status);

-- Only one active version per slug at a time. New active version = old
-- active version flipped to 'archived' first.
create unique index if not exists plans_one_active_per_slug
  on public.plans (slug)
  where status = 'active';

alter table public.plans enable row level security;

-- ========================================================================
-- 2) plan_audit — change log
-- ========================================================================
create table if not exists public.plan_audit (
  id bigserial primary key,
  plan_id uuid not null references public.plans(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  -- 'created', 'edited', 'submitted', 'approved', 'rejected', 'archived',
  -- 'price_change', 'features_change', etc.
  action text not null,
  -- Free-form JSON describing the change (before/after, reason, etc.).
  payload jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists plan_audit_plan_idx on public.plan_audit (plan_id, created_at desc);
create index if not exists plan_audit_actor_idx on public.plan_audit (actor_id);

alter table public.plan_audit enable row level security;

-- ========================================================================
-- 3) subscriptions.plan_id — bind subscriptions to a plan version
-- ========================================================================
-- Existing subscriptions have a `tier` text column (e.g. 'free',
-- 'individual', 'premium'). We're keeping that column for backward
-- compatibility but adding plan_id as the new authoritative link.
-- Migration 26 backfills plan_id from tier.
alter table public.subscriptions
  add column if not exists plan_id uuid references public.plans(id) on delete set null;

create index if not exists subscriptions_plan_idx on public.subscriptions (plan_id);

-- ========================================================================
-- 4) RLS policies
-- ========================================================================

-- Anyone (including anon visitors on /pricing) can read ACTIVE plans.
drop policy if exists "plans read active public" on public.plans;
create policy "plans read active public" on public.plans
  for select using (status = 'active');

-- Platform admins can read every plan regardless of status.
drop policy if exists "plans read by platform admin" on public.plans;
create policy "plans read by platform admin" on public.plans
  for select using (public.is_platform_admin());

-- Platform admins can insert / update / delete plans (writes are also
-- guarded by service-role admin client server-side; this is defense in
-- depth for any future direct UI write).
drop policy if exists "plans write by platform admin" on public.plans;
create policy "plans write by platform admin" on public.plans
  for all using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- Platform admins read the full audit log.
drop policy if exists "plan_audit read by platform admin" on public.plan_audit;
create policy "plan_audit read by platform admin" on public.plan_audit
  for select using (public.is_platform_admin());

-- Platform admins can insert audit entries (writes go through the service
-- role, but this is the safety net).
drop policy if exists "plan_audit insert by platform admin" on public.plan_audit;
create policy "plan_audit insert by platform admin" on public.plan_audit
  for insert with check (public.is_platform_admin());

-- Reload PostgREST so the new tables are visible to the API.
notify pgrst, 'reload schema';
