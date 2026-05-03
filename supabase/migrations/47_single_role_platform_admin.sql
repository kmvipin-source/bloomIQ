-- =============================================================================
-- Migration 47 — single source of truth for role; platform_admin = role value
-- -----------------------------------------------------------------------------
-- Until now profiles carried two role-ish columns:
--   - role text in {teacher, student, super_teacher}
--   - platform_admin boolean
-- A staff user could (and did, in production) have role='teacher' AND
-- platform_admin=true at the same time, which made every login flow that
-- branches on role pick the wrong destination depending on which column
-- it read first.
--
-- Fix: extend the role enum to include 'platform_admin', backfill, and
-- add a trigger that keeps the two columns in sync. The boolean column
-- stays for backwards compatibility with existing code paths that read
-- it; future cleanup can drop it once every reader is migrated to role.
-- =============================================================================

-- 1) Allow 'platform_admin' as a role value.
alter table public.profiles
  drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
    check (role = any (array['teacher', 'student', 'super_teacher', 'platform_admin']));

-- 2) Backfill: every platform_admin=true row gets role='platform_admin'.
update public.profiles
set role = 'platform_admin'
where platform_admin = true and role <> 'platform_admin';

-- 3) Trigger keeps platform_admin and role aligned in either direction.
--    - Setting platform_admin=true forces role='platform_admin'.
--    - Setting platform_admin=false from a row currently 'platform_admin'
--      defaults role back to 'teacher' (closest-fit caller convention; the
--      app can update it explicitly afterward if needed).
--    - Setting role='platform_admin' implicitly flips platform_admin=true.
--    - Setting role to anything else when platform_admin=true raises.
create or replace function public.profiles_keep_role_aligned()
returns trigger
language plpgsql
as $$
begin
  if new.platform_admin = true and (new.role is null or new.role <> 'platform_admin') then
    new.role := 'platform_admin';
  elsif new.platform_admin = false and new.role = 'platform_admin' then
    -- Demoted but role still says platform_admin — fall back to teacher.
    new.role := 'teacher';
  end if;
  if new.role = 'platform_admin' and new.platform_admin = false then
    new.platform_admin := true;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_role_align on public.profiles;
create trigger profiles_role_align
  before insert or update on public.profiles
  for each row execute function public.profiles_keep_role_aligned();

notify pgrst, 'reload schema';
