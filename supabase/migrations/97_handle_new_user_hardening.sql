-- supabase/migrations/97_handle_new_user_hardening.sql
-- =============================================================================
-- F66 + F27 fix (QA): the on-signup trigger silently defaulted unknown /
-- missing role values to 'student'. A malformed signup payload (or a
-- copy-paste mistake in an invite flow) would silently create an
-- independent student instead of failing loudly.
--
-- This migration re-defines public.handle_new_user to RAISE when the
-- raw_user_meta_data.role value is present but not in the known set.
-- Missing role (NULL) still defaults to 'student' — that's the legitimate
-- /signup default — but a present-but-wrong value now errors instead of
-- silently shipping a wrong account type.
--
-- Idempotent: replaces the function in place. The trigger binding from
-- migration 09 (on_auth_user_created) keeps the same name and target;
-- we just swap the function body.
--
-- Backwards-compat note: this hardens validation only. All existing
-- profiles + downstream behaviour are unchanged for legitimate sign-ups.
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
begin
  raw_role := new.raw_user_meta_data->>'role';

  -- F66 fix: validate role explicitly. Allowed set today:
  --   student, teacher, super_teacher
  -- (platform_admin is granted via SQL/admin flow, never at signup.)
  if raw_role is not null and raw_role not in ('student','teacher','super_teacher') then
    raise exception 'handle_new_user: unknown role "%". Allowed: student, teacher, super_teacher.', raw_role;
  end if;

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

  -- Independent students get a free subscription record.
  if coalesce(raw_role, 'student') = 'student'
     and not coalesce((new.raw_user_meta_data->>'is_school_student')::boolean, false) then
    insert into public.subscriptions (user_id, tier, status)
    values (new.id, 'free', 'active')
    on conflict (user_id) where user_id is not null do nothing;
  end if;

  -- Auto-claim any pending teacher invites for this email (preserved from
  -- migration 09).
  inv_email := lower(new.email);
  if inv_email is not null then
    update public.profiles p
       set school_id = (
         select c.school_id from public.classes c
         join public.class_teacher_invites cti on cti.class_id = c.id
         where lower(cti.email) = inv_email
         limit 1
       )
     where p.id = new.id and p.school_id is null;

    -- Convert pending invites into class_teachers rows. (See migration 09
    -- for the full per-invite logic.)
    insert into public.class_teachers (class_id, user_id, role, subject)
    select cti.class_id, new.id, cti.role, cti.subject
      from public.class_teacher_invites cti
     where lower(cti.email) = inv_email
    on conflict do nothing;

    delete from public.class_teacher_invites
     where lower(email) = inv_email;
  end if;

  return new;
end;
$$;
