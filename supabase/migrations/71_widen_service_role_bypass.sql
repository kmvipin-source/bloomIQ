-- =============================================================================
-- 71_widen_service_role_bypass.sql
-- -----------------------------------------------------------------------------
-- Cascading fix for D3/D4 follow-ups discovered by scripts/test-rls.js
-- on 2026-05-11.
--
-- Migration 69's profiles_block_self_escalation trigger checks
--   if auth.role() = 'service_role' then return new; end if;
-- to let server-side admin code bypass. That works when PostgREST sets the
-- JWT claim correctly, but in some session contexts auth.role() returns
-- NULL or empty even when the caller IS using the service-role key. In
-- those cases the trigger falsely blocks legit setup writes (e.g. the
-- `admin.from("profiles").update({school_id, role, ...})` calls in test
-- rigs and the platform-admin onboarding flow).
--
-- Fix: ADD a second bypass clause that also checks the postgres `session_user`
-- and `current_user`. PostgREST runs as the `service_role` postgres user
-- when invoked with a service-role key, regardless of how JWT claims got
-- propagated. Either condition is sufficient to bypass.
--
-- This does NOT weaken security — a non-privileged user cannot reach this
-- trigger as the `service_role` postgres role. They run as `authenticated`.
-- =============================================================================

create or replace function public.profiles_block_self_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_is_admin boolean;
  jwt_role text;
begin
  -- Bypass #1 (preferred): JWT claim says service_role.
  jwt_role := coalesce(auth.role(), '');
  if jwt_role = 'service_role' then
    return new;
  end if;

  -- Bypass #2 (resilient): postgres session role IS service_role.
  -- PostgREST does `SET ROLE service_role` for service-key callers; even
  -- if request.jwt.claim.role isn't visible inside this trigger, the
  -- postgres role definitely is. session_user is the original login;
  -- current_user reflects any SET ROLE in effect.
  if session_user = 'service_role' or current_user = 'service_role' or current_user = 'postgres' then
    return new;
  end if;

  -- Bypass #3: existing platform admin can change anything.
  select coalesce(p.platform_admin, false) into caller_is_admin
    from public.profiles p
   where p.id = auth.uid();

  if caller_is_admin then
    return new;
  end if;

  -- Non-privileged caller — block sensitive column changes.
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
  'Security trigger — blocks non-privileged callers from changing platform_admin/role/school_id/id. Bypasses for: (1) JWT role=service_role, (2) postgres role=service_role/postgres, (3) existing platform admin. Hardened in migration 71 after test-rig calls were observed mis-blocked.';

notify pgrst, 'reload schema';
