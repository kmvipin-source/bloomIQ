-- =============================================================================
-- 72_revert_71_bad_bypass.sql
-- -----------------------------------------------------------------------------
-- URGENT REVERT of migration 71.
--
-- Migration 71 tried to widen the service-role bypass in
-- profiles_block_self_escalation by also checking current_user.
-- BUT inside a SECURITY DEFINER function, current_user returns the
-- FUNCTION'S OWNER (postgres), NOT the actual caller. So
-- `current_user = 'postgres'` was ALWAYS true → the trigger silently
-- bypassed for everyone → D2 reopened (students could self-promote
-- to platform_admin again).
--
-- This migration restores the original migration-69 logic: JWT
-- claim role is the only programmatic bypass. Platform admins are
-- still allowed via the profiles lookup. Service-role JWTs hit
-- this trigger via real PostgREST flows and auth.role() works
-- correctly for those.
--
-- If a legitimate test rig STILL hits this trigger and can't
-- update profile.school_id, that's a separate issue to debug —
-- but it does NOT justify weakening the security trigger.
--
-- Apply this immediately. Re-running scripts/test-rls.js after
-- this migration should restore D2 PASS.
-- =============================================================================

create or replace function public.profiles_block_self_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_is_admin boolean;
begin
  -- Service-role JWT bypass — ONLY safe bypass for a SECURITY DEFINER trigger.
  -- (We do NOT check current_user here because under SECURITY DEFINER it
  -- reflects the function owner, not the caller.)
  if auth.role() = 'service_role' then
    return new;
  end if;

  -- Platform admin bypass — they can change anything on anyone.
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

comment on function public.profiles_block_self_escalation() is
  'Security trigger: blocks non-privileged callers from changing platform_admin/role/school_id/id. Migration 72 reverted migration 71''s unsafe current_user bypass. Only JWT auth.role()=service_role and platform_admin profile entries are allowed through.';

notify pgrst, 'reload schema';
