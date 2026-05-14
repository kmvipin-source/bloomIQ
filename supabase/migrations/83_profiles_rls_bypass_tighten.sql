-- =============================================================================
-- 83_profiles_rls_bypass_tighten.sql
-- -----------------------------------------------------------------------------
-- Phase H critical: tighten the profiles_block_self_escalation bypass.
--
-- Migration 73 replaced `auth.role()='service_role'` with `auth.uid() IS NULL`
-- as the bypass condition because the former returned NULL inside some
-- BEFORE-UPDATE evaluation contexts. The audit flagged the new condition
-- as too broad: ANY non-auth path (table-owner trigger chains, pg_cron
-- jobs, SET ROLE postgres sessions, server-side dashboard SQL) silently
-- bypasses the policy. As long as no such path mutates profiles, this is
-- safe in practice — but it's a footgun waiting for the first cron job
-- or trigger that does. Tighten to the smallest legitimate bypass set:
--
--   (a) the service_role JWT, detected via two complementary checks
--       (current_setting on the request claim + the role() function) so a
--       failure of one doesn't lose the bypass; AND
--   (b) explicit superuser maintenance (postgres / supabase_admin
--       session_user).
--
-- Same closure on D2 — a signed-in user JWT can never satisfy either.
-- =============================================================================

create or replace function public.profiles_block_self_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_is_admin boolean;
  is_service      boolean;
  is_maintenance  boolean;
begin
  -- Service-role detection — two independent signals, accept either.
  -- The role()-function variant has historically returned NULL in some
  -- trigger contexts (the reason migration 73 existed), so we also
  -- look at the raw JWT claim via current_setting.
  is_service := (auth.role() = 'service_role')
             OR (current_setting('request.jwt.claim.role', true) = 'service_role');

  -- Maintenance bypass — Supabase dashboard SQL, migrations, and pg_cron
  -- run as the postgres or supabase_admin role. Limiting the bypass to
  -- these named sessions avoids the previous overly-broad
  -- "auth.uid() IS NULL implies safe" leak.
  is_maintenance := session_user IN ('postgres', 'supabase_admin');

  if is_service or is_maintenance then
    return new;
  end if;

  -- Bypass for an explicit platform admin signed in via JWT.
  select coalesce(p.platform_admin, false) into caller_is_admin
    from public.profiles p
   where p.id = auth.uid();

  if caller_is_admin then
    return new;
  end if;

  -- Non-privileged signed-in caller: block changes to sensitive columns.
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
  'Security trigger — blocks non-privileged callers from changing platform_admin/role/school_id/id. Bypasses for: (A) service_role JWT (auth.role or request.jwt.claim.role), (B) postgres/supabase_admin session_user (migrations + dashboard SQL), (C) existing platform admin. Migration 83 tightened from auth.uid() IS NULL after audit flagged that as too broad.';

notify pgrst, 'reload schema';
