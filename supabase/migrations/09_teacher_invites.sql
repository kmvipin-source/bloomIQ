-- BloomIQ: Pending teacher-class invites by email.
-- A class can be assigned to a teacher by email even before they sign up.
-- When the teacher creates their account with that email, the pending
-- invite is auto-claimed into a real class_teachers row.

-- ============ class_teacher_invites ============
create table if not exists public.class_teacher_invites (
  class_id uuid not null references public.classes(id) on delete cascade,
  email text not null,
  role text not null default 'primary' check (role in ('primary','co')),
  subject text,
  invited_at timestamptz default now(),
  invited_by uuid references public.profiles(id) on delete set null,
  primary key (class_id, email)
);
create index if not exists cti_email_idx on public.class_teacher_invites (lower(email));
alter table public.class_teacher_invites enable row level security;

-- RLS: only the school's Admin Head can manage invites for classes in their school.
drop policy if exists "cti super manage" on public.class_teacher_invites;
create policy "cti super manage" on public.class_teacher_invites
  for all using (
    exists (select 1 from public.classes c
            where c.id = class_id and public.is_super_for_school(c.school_id))
  ) with check (
    exists (select 1 from public.classes c
            where c.id = class_id and public.is_super_for_school(c.school_id))
  );

-- The class's primary teacher can also read & manage invites for it
-- (this is what powers the pending-co-teacher list on /teacher/classes/[id]).
drop policy if exists "cti primary manage" on public.class_teacher_invites;
create policy "cti primary manage" on public.class_teacher_invites
  for all using (public.is_class_primary(class_id))
  with check (public.is_class_primary(class_id));

-- Any teacher of the class (primary or co) can SEE the pending invite list
-- so they have visibility into who has been invited but hasn't signed up yet.
drop policy if exists "cti class teacher read" on public.class_teacher_invites;
create policy "cti class teacher read" on public.class_teacher_invites
  for select using (public.is_class_teacher(class_id));

-- ============ Extend handle_new_user to auto-claim pending invites ============
-- When a new auth.users row appears and a profile is created, look up any
-- class_teacher_invites whose email matches and convert them to class_teachers
-- rows. Then delete the invites. The class.owner_id mirror is updated when
-- the role is 'primary' to keep legacy paths working.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  inv_email text;
  inv_role  text;
  inv_class uuid;
  inv_subject text;
begin
  insert into public.profiles (
    id, role, full_name, username, is_school_student, parent_email, parent_name
  ) values (
    new.id,
    coalesce(new.raw_user_meta_data->>'role', 'student'),
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    nullif(new.raw_user_meta_data->>'username', ''),
    coalesce((new.raw_user_meta_data->>'is_school_student')::boolean, false),
    nullif(new.raw_user_meta_data->>'parent_email', ''),
    nullif(new.raw_user_meta_data->>'parent_name', '')
  )
  on conflict (id) do nothing;

  -- Independent students get a free subscription record.
  if coalesce(new.raw_user_meta_data->>'role', 'student') = 'student'
     and not coalesce((new.raw_user_meta_data->>'is_school_student')::boolean, false) then
    -- The unique index on subscriptions.user_id is PARTIAL
    -- (where user_id is not null), so ON CONFLICT must include the same
    -- predicate or Postgres can't find a matching constraint and the trigger
    -- aborts with "no unique or exclusion constraint matching the ON CONFLICT
    -- specification" — which surfaces as "Database error saving new user".
    insert into public.subscriptions (user_id, tier, status)
    values (new.id, 'free', 'active')
    on conflict (user_id) where user_id is not null do nothing;
  end if;

  -- Auto-claim any pending teacher invites for this email. Only does anything
  -- if the new user is a teacher (or they got a teacher role assigned later).
  inv_email := lower(new.email);
  if inv_email is not null then
    -- Pull the new user into the school of their first invite, if no school yet.
    update public.profiles p
       set school_id = (
         select c.school_id from public.classes c
         join public.class_teacher_invites cti on cti.class_id = c.id
         where lower(cti.email) = inv_email
         limit 1
       )
     where p.id = new.id and p.school_id is null;

    -- For each invite for this email, demote the previous primary if needed,
    -- then upsert a class_teachers row.
    for inv_class, inv_role, inv_subject in
      select cti.class_id, cti.role, cti.subject
      from public.class_teacher_invites cti
      where lower(cti.email) = inv_email
    loop
      if inv_role = 'primary' then
        update public.class_teachers
           set role = 'co'
         where class_id = inv_class and role = 'primary';
      end if;

      insert into public.class_teachers (class_id, teacher_id, role, subject)
      values (inv_class, new.id, inv_role, inv_subject)
      on conflict (class_id, teacher_id)
        do update set role = excluded.role, subject = excluded.subject;

      if inv_role = 'primary' then
        update public.classes set owner_id = new.id where id = inv_class;
      end if;
    end loop;

    -- Drop the invites we just claimed.
    delete from public.class_teacher_invites
     where lower(email) = inv_email;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
