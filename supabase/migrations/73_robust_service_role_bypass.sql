-- =============================================================================
-- 73_robust_service_role_bypass.sql
-- -----------------------------------------------------------------------------
-- Fix for D3/D4 root cause without re-opening D2.
--
-- The trigger from migrations 69 + 72 uses `auth.role() = 'service_role'`
-- as the bypass condition. On this project's Supabase config, that
-- function returns NULL or empty inside some BEFORE-UPDATE trigger
-- evaluation contexts, even when the caller IS using the service-role
-- key. As a result, legitimate admin code (test rig makeUser, the
-- platform-admin onboarding flow) gets blocked from setting school_id
-- on a freshly-created profile.
--
-- The robust detector: `auth.uid() IS NULL`. This is true if and only
-- if the caller has NO authenticated user identity. Three cases produce
-- this:
--   (1) Service-role JWT (legitimate admin code).
--   (2) Anonymous request (anon has no UPDATE policy on profiles, so
--       cannot reach this trigger anyway — no security risk).
--   (3) Server-side postgres maintenance (migrations, dashboard SQL —
--       legitimate, no security risk).
--
-- A real signed-in user ALWAYS has auth.uid() populated, so the trigger
-- still blocks them from changing platform_admin / role / school_id / id.
--
-- D2 (the critical fix) STAYS CLOSED. Verified by tracing every path
-- through the trigger:
--   - student JWT → auth.uid() = student.id → not NULL → enforce
--   - admin JWT → auth.uid() = NULL → bypass (correct, intended)
--   - platform_admin JWT → auth.uid() = admin.id → check
--     caller_is_admin → true → bypass (correct, intended)
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
  -- Bypass A: no authenticated user identity = service-role / anon / maintenance.
  -- Safe because: anon has no UPDATE policy on profiles (can't reach trigger),
  -- service-role is intentionally allowed, postgres maintenance is intentional.
  if auth.uid() is null then
    return new;
  end if;

  -- Bypass B: explicit platform admin can change anything on anyone.
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
  'Security trigger — blocks non-privileged callers from changing platform_admin/role/school_id/id. Bypasses for: (A) auth.uid() IS NULL (service-role / anon / maintenance — only the first can reach this trigger because anon lacks UPDATE policy on profiles), (B) existing platform admin. Migration 73 replaced fragile auth.role() check with auth.uid() IS NULL.';

notify pgrst, 'reload schema';
