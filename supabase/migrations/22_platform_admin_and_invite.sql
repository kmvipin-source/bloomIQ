-- BloomIQ: Platform admin role + school invite tracking.
-- Lets the BloomIQ founder/operator (separate from a school's super_teacher)
-- provision new schools after payment lands. This is the back-end half of
-- the manual onboarding admin page at /admin/onboard-school.
-- Additive. Run after migration 21.

-- ========================================================================
-- 1) Platform admin flag
-- ========================================================================
-- A platform admin is BloomIQ staff, NOT a school super_teacher. They use
-- /admin/onboard-school to create a school + invite its Admin Head by email.
-- Default false. Toggle it to true manually in the SQL editor for trusted
-- accounts (there is no UI for this; it is bootstrap-only).
alter table public.profiles
  add column if not exists platform_admin boolean not null default false;

create index if not exists profiles_platform_admin_idx
  on public.profiles (platform_admin)
  where platform_admin = true;

-- ========================================================================
-- 2) School invite tracking columns
-- ========================================================================
-- When a platform admin onboards a paying school, we pre-create the school
-- row and call supabase.auth.admin.inviteUserByEmail on the Admin Head's
-- address. These columns let the admin page show pending vs accepted
-- invites without duplicating data into a separate invites table.
alter table public.schools
  add column if not exists invited_admin_email text,
  add column if not exists invited_at timestamptz,
  add column if not exists onboarded_by uuid
    references public.profiles(id) on delete set null;

create index if not exists schools_onboarded_by_idx
  on public.schools (onboarded_by);

-- ========================================================================
-- 3) Helper: am I a platform admin?
-- ========================================================================
-- Wrapped as security-definer so policies that reference profiles do not
-- recurse into RLS evaluation on the same table.
create or replace function public.is_platform_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and platform_admin = true
  );
$$;

-- ========================================================================
-- 4) RLS — platform admin can read and write what they need
-- ========================================================================
-- Most onboarding writes flow through the service-role admin client in
-- /api/admin/onboard-school (which bypasses RLS entirely). These policies
-- exist so the admin page itself, using the user's own session, can list
-- and inspect schools it has onboarded.

-- Platform admin can read every school
drop policy if exists "schools read by platform admin" on public.schools;
create policy "schools read by platform admin" on public.schools
  for select using (public.is_platform_admin());

-- Platform admin can read every profile (to display invited Admin Heads
-- and their acceptance state)
drop policy if exists "profiles read by platform admin" on public.profiles;
create policy "profiles read by platform admin" on public.profiles
  for select using (public.is_platform_admin());

-- Platform admin can update schools they onboarded (e.g. cancel a pending
-- invite, fix a typo in the school name before the admin head logs in)
drop policy if exists "schools update by platform admin" on public.schools;
create policy "schools update by platform admin" on public.schools
  for update using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- Platform admin can insert new schools. The service-role client is what
-- actually does this in production; this policy is a safety net for any
-- future admin-page direct write.
drop policy if exists "schools insert by platform admin" on public.schools;
create policy "schools insert by platform admin" on public.schools
  for insert with check (public.is_platform_admin());

-- Reload PostgREST schema so the new columns are visible to the API
notify pgrst, 'reload schema';
