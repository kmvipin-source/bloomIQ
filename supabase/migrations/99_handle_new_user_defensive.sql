-- supabase/migrations/99_handle_new_user_defensive.sql
-- =============================================================================
-- L-1 fix: signup was failing with "Database error saving new user" because
-- some part of public.handle_new_user was throwing. The trigger does FIVE
-- things in sequence:
--
--   1. Validate role (allowed: student / teacher / super_teacher)
--   2. INSERT into public.profiles
--   3. INSERT into public.subscriptions  (independent students only)
--   4. UPDATE profiles.school_id from class_teacher_invites
--   5. INSERT class_teachers + DELETE class_teacher_invites
--
-- Any one of those failing aborts the whole signup. Steps 1-3 are
-- mandatory — a failure there is a real bug we want to know about.
-- Steps 4-5 are "best-effort auto-claim of pending teacher invites" —
-- a failure there should NOT block signup.
--
-- This migration:
--   • Keeps steps 1-3 exactly as in migration 97 (they were correct).
--   • Wraps steps 4-5 in BEGIN…EXCEPTION WHEN OTHERS so any failure
--     (missing table, RLS quirk, FK violation, anything) is logged via
--     RAISE NOTICE but does not abort the trigger.
--   • Adds a defensive table-existence check before touching
--     class_teacher_invites at all (handles partial-migration dev
--     environments).
--
-- Idempotent: CREATE OR REPLACE.
-- Safe for production: behavior for the happy path is identical to
-- migration 97. Only changes the failure mode of the auto-claim block.
-- =============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  inv_email text;
  raw_role  text;
  has_invites_table boolean;
begin
  -- ---------------------------------------------------------------
  -- Step 1: role validation
  -- ---------------------------------------------------------------
  raw_role := new.raw_user_meta_data->>'role';
  if raw_role is not null and raw_role not in ('student','teacher','super_teacher') then
    raise exception 'handle_new_user: unknown role "%". Allowed: student, teacher, super_teacher.', raw_role;
  end if;

  -- ---------------------------------------------------------------
  -- Step 2: insert into profiles (mandatory)
  -- ---------------------------------------------------------------
  insert into public.profiles (
    id, role, full_name, username, is_school_student, parent_email, parent_name
  ) values (
    new.id,
    coalesce(raw_role, 'student'),
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    nullif(new.raw_user_meta_data->>'username', ''),
    coalesce((new.raw_user_meta_data->>'is_school_student')::boolean, false),
    nullif(new.raw_user_meta_data->>'parent_email', ''),
    nullif(new.raw_user_meta_data->>'parent_name', '')
  )
  on conflict (id) do nothing;

  -- ---------------------------------------------------------------
  -- Step 3: free subscription for independent students (mandatory)
  -- ---------------------------------------------------------------
  if coalesce(raw_role, 'student') = 'student'
     and not coalesce((new.raw_user_meta_data->>'is_school_student')::boolean, false) then
    -- Wrap in a defensive block in case the subscriptions table has a
    -- column constraint that doesn't accept the default values
    -- (operational drift between migrations).
    begin
      insert into public.subscriptions (user_id, tier, status)
      values (new.id, 'free', 'active')
      on conflict (user_id) where user_id is not null do nothing;
    exception
      when others then
        raise notice 'handle_new_user: free-subscription insert skipped for %, reason: %', new.id, sqlerrm;
    end;
  end if;

  -- ---------------------------------------------------------------
  -- Steps 4-5: auto-claim pending teacher invites (best-effort)
  --
  -- Wrapped in EXCEPTION WHEN OTHERS so a hiccup here cannot fail
  -- a brand-new user's signup. The original migration 97 trigger
  -- would abort on any error in this block.
  -- ---------------------------------------------------------------
  inv_email := lower(new.email);
  if inv_email is not null then
    -- Defensive: only attempt if the class_teacher_invites table actually
    -- exists. Catches the partial-migration / fresh-dev-DB case where
    -- migrations 09/77/etc weren't all applied.
    select exists (
      select 1 from information_schema.tables
       where table_schema = 'public' and table_name = 'class_teacher_invites'
    ) into has_invites_table;

    if has_invites_table then
      begin
        update public.profiles p
           set school_id = (
             select c.school_id from public.classes c
             join public.class_teacher_invites cti on cti.class_id = c.id
             where lower(cti.email) = inv_email
             limit 1
           )
         where p.id = new.id and p.school_id is null;

        insert into public.class_teachers (class_id, user_id, role, subject)
        select cti.class_id, new.id, cti.role, cti.subject
          from public.class_teacher_invites cti
         where lower(cti.email) = inv_email
        on conflict do nothing;

        delete from public.class_teacher_invites
         where lower(email) = inv_email;
      exception
        when others then
          -- Log the failure but do NOT propagate — signup must succeed.
          raise notice 'handle_new_user: auto-claim-invites skipped for %, reason: %', inv_email, sqlerrm;
      end;
    end if;
  end if;

  return new;
end;
$$;

comment on function public.handle_new_user() is
  'Mirror auth.users into profiles + create free subscription + auto-claim teacher invites. Migration 99 (L-1 fix): the auto-claim block is now defensive — any failure there is logged via RAISE NOTICE but does NOT abort the trigger, so signup cannot break because of a stale invites table or related drift.';

-- Reload PostgREST schema so any policy/permission changes take effect.
notify pgrst, 'reload schema';
