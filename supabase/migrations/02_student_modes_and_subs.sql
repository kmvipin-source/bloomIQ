-- BloomIQ: School-student usernames + Independent-student subscriptions
-- Additive. Run after migration 01.

-- ============ PROFILES extensions ============
alter table public.profiles
  add column if not exists username text unique,
  add column if not exists is_school_student boolean not null default false,
  add column if not exists parent_email text,
  add column if not exists parent_name text;

create index if not exists profiles_username_idx on public.profiles (username);

-- ============ SUBSCRIPTIONS (independent students) ============
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles(id) on delete cascade,
  tier text not null default 'free' check (tier in ('free','individual','premium')),
  status text not null default 'active' check (status in ('active','cancelled','expired')),
  started_at timestamptz default now(),
  expires_at timestamptz,
  created_at timestamptz default now()
);
create index if not exists subs_user_idx on public.subscriptions (user_id);
alter table public.subscriptions enable row level security;

drop policy if exists "subs read self" on public.subscriptions;
create policy "subs read self" on public.subscriptions
  for select using (auth.uid() = user_id);

-- Inserts/updates happen via the service-role admin client, which bypasses RLS.

-- ============ NEW-USER TRIGGER (refreshed) ============
-- Honors role, full_name, username, is_school_student, parent_email, parent_name
-- coming through user metadata at signup / admin-create time.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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

  -- Independent students get a free subscription record so we have something to upgrade later.
  if coalesce(new.raw_user_meta_data->>'role', 'student') = 'student'
     and not coalesce((new.raw_user_meta_data->>'is_school_student')::boolean, false) then
    insert into public.subscriptions (user_id, tier, status)
    values (new.id, 'free', 'active')
    on conflict (user_id) where user_id is not null do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
