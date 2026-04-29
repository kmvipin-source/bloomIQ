-- BloomIQ: Subscription rows can also belong to a SCHOOL (not just a user).
-- Independent student subscriptions are keyed by user_id; school subscriptions
-- are keyed by school_id. Exactly one of the two is set per row.

alter table public.subscriptions
  add column if not exists school_id uuid references public.schools(id) on delete cascade;

-- Drop the old hard unique on user_id (since user_id can now be null for
-- school subscriptions). We replace it with two partial unique indexes.
alter table public.subscriptions drop constraint if exists subscriptions_user_id_key;
alter table public.subscriptions alter column user_id drop not null;

create unique index if not exists subs_one_per_user
  on public.subscriptions (user_id) where user_id is not null;
create unique index if not exists subs_one_per_school
  on public.subscriptions (school_id) where school_id is not null;

-- Exactly one of user_id / school_id is non-null. Idempotent guard so the
-- migration can be re-run safely.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'subs_owner_xor'
      and conrelid = 'public.subscriptions'::regclass
  ) then
    alter table public.subscriptions
      add constraint subs_owner_xor
      check ((user_id is not null) <> (school_id is not null));
  end if;
end $$;

create index if not exists subs_school_idx on public.subscriptions (school_id);

-- RLS: school subscriptions are readable by anyone in the school.
drop policy if exists "subs read school members" on public.subscriptions;
create policy "subs read school members" on public.subscriptions
  for select using (
    school_id is not null and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.school_id = subscriptions.school_id
    )
  );
