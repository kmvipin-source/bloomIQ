-- =============================================================================
-- 69_lock_profile_self_update.sql
-- -----------------------------------------------------------------------------
-- CRITICAL SECURITY FIX — D2 (caught by scripts/test-rls.js on 2026-05-11):
--
--   Any signed-in student could escalate to platform_admin by issuing:
--     UPDATE profiles SET platform_admin = true WHERE id = (auth.uid());
--
-- Root cause: profiles had SELECT policies but NO UPDATE policy. With RLS
-- enabled, that should DENY updates, but in this deployment some legacy
-- permissive policy (likely a dashboard-created "auth users update own
-- profile" rule) was letting it through. Verified via service-role
-- read-back after the write — platform_admin was actually flipped to true.
--
-- This migration:
--   1) Drops every existing UPDATE/INSERT/ALL policy on profiles (clean slate).
--   2) Adds an INSERT policy: a user can insert ONLY their own profile row
--      (id = auth.uid()) with platform_admin=false and role in
--      ('student','teacher','super_teacher'). Platform admins can insert
--      anything.
--   3) Adds an UPDATE policy: a user can update their own row, BUT a
--      BEFORE-UPDATE trigger blocks changes to security-sensitive columns
--      (platform_admin, role, school_id, id) unless the caller is the
--      service role or an existing platform_admin.
--   4) Super-teachers can update profiles within their school (for student
--      management), but they still can't grant platform_admin.
--   5) Platform admins can update anything (unrestricted, by virtue of
--      the trigger short-circuiting for platform_admin callers).
--
-- This migration is additive + idempotent. Safe to run on production.
-- After applying:  re-run  node scripts/test-rls.js  →  D2 should now PASS.
-- =============================================================================

-- 0) Ensure RLS is enabled on profiles. (Defensive — should already be on.)
alter table public.profiles enable row level security;

-- 1) Drop every existing UPDATE / INSERT / ALL policy on profiles.
--    (We deliberately keep the SELECT policy "profiles select" from
--    migration 50 — it's correct and well-tested.)
do $$
declare r record;
begin
  for r in
    select polname from pg_policy
     where polrelid = 'public.profiles'::regclass
       and polcmd in ('a', 'w', '*')  -- INSERT, UPDATE, ALL
  loop
    execute format('drop policy if exists %I on public.profiles', r.polname);
  end loop;
end $$;

-- 2) INSERT policy — users can only insert their own row, with platform_admin=false.
create policy "profiles insert self" on public.profiles
  for insert
  with check (
    id = (select auth.uid())
    and coalesce(platform_admin, false) = false
  );

-- 2b) Platform admins can insert any profile (used by admin/onboard-school).
create policy "profiles insert by platform admin" on public.profiles
  for insert
  with check (public.is_platform_admin());

-- 3) UPDATE policy — users can target their own row. Sensitive column
--    changes are caught by the trigger below.
create policy "profiles update self" on public.profiles
  for update
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- 3b) Super teachers can update profiles within their school (so they can
--     edit student names, reset passwords, etc.). The trigger still blocks
--     them from granting platform_admin.
create policy "profiles update by super_teacher" on public.profiles
  for update
  using (public.is_super_for_user(id))
  with check (public.is_super_for_user(id));

-- 3c) Platform admins can update any profile.
create policy "profiles update by platform admin" on public.profiles
  for update
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- 4) Security trigger — the actual column-level lock.
--    For every UPDATE that's NOT from a platform_admin or service_role,
--    reject changes to security-sensitive columns. We compare NEW vs OLD
--    and raise if any protected column changed.
create or replace function public.profiles_block_self_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_is_admin boolean;
begin
  -- Service-role bypass (the dashboard, server-side admin code, migrations).
  -- auth.role() returns 'service_role' for service-key callers and
  -- 'authenticated' for JWT-bearing callers. When run from within a
  -- security-definer function this is reliable.
  if auth.role() = 'service_role' then
    return new;
  end if;

  -- Platform admin bypass — they're allowed to change anything on anyone
  -- (subject to the RLS policies above).
  select coalesce(p.platform_admin, false) into caller_is_admin
    from public.profiles p
   where p.id = auth.uid();

  if caller_is_admin then
    return new;
  end if;

  -- Non-privileged caller — block changes to security-sensitive columns.
  if new.platform_admin is distinct from old.platform_admin then
    raise exception 'permission denied: platform_admin can only be changed by an existing platform admin'
      using errcode = '42501';
  end if;
  if new.role is distinct from old.role then
    raise exception 'permission denied: role can only be changed by a platform admin'
      using errcode = '42501';
  end if;
  if new.school_id is distinct from old.school_id then
    raise exception 'permission denied: school_id can only be changed by a platform admin or school admin'
      using errcode = '42501';
  end if;
  if new.id is distinct from old.id then
    raise exception 'permission denied: id is immutable'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_block_self_escalation on public.profiles;
create trigger profiles_block_self_escalation
  before update on public.profiles
  for each row execute function public.profiles_block_self_escalation();

comment on function public.profiles_block_self_escalation() is
  'Security trigger: blocks non-privileged callers from changing platform_admin, role, school_id, or id on profiles. The corresponding RLS UPDATE policies allow the row-level target but this function enforces COLUMN-level rules because postgres RLS does not natively support column-grain WITH CHECK comparisons. Migration 69, 2026-05-11.';

-- 5) Reload PostgREST schema so the new policies + trigger take effect.
notify pgrst, 'reload schema';
