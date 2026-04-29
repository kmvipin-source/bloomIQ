-- BloomIQ: Subscription enforcement for independent students.
-- Caps free-tier independent students to a small number of quiz attempts
-- started per 24 hours. School students and paid tiers (individual / premium)
-- are uncapped. The trigger fires BEFORE INSERT on quiz_attempts so an over-
-- limit insert is rejected at the database level — it cannot be bypassed by
-- direct DB calls or the supabase-js client.

-- ============ Per-tier daily caps ============
create table if not exists public.subscription_limits (
  id int primary key default 1,
  free_daily_attempts int not null default 3,
  individual_daily_attempts int,   -- null = uncapped
  premium_daily_attempts int,      -- null = uncapped
  updated_at timestamptz default now(),
  check (id = 1)
);
insert into public.subscription_limits (id, free_daily_attempts)
values (1, 3)
on conflict (id) do nothing;

alter table public.subscription_limits enable row level security;
drop policy if exists "subs_limits read all" on public.subscription_limits;
create policy "subs_limits read all" on public.subscription_limits
  for select to authenticated using (true);

-- ============ Quota check trigger on quiz_attempts ============
create or replace function public.check_attempt_quota()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  user_role text;
  is_school boolean;
  user_tier text;
  attempts_24h int;
  daily_cap int;
begin
  -- Independent students only; school students and teachers bypass.
  select role, coalesce(is_school_student, false)
    into user_role, is_school
    from public.profiles
    where id = new.student_id;

  if user_role <> 'student' or is_school then
    return new;
  end if;

  select tier into user_tier
    from public.subscriptions
    where user_id = new.student_id;

  -- Determine the cap for this tier.
  select case coalesce(user_tier, 'free')
           when 'free'       then free_daily_attempts
           when 'individual' then individual_daily_attempts
           when 'premium'    then premium_daily_attempts
           else free_daily_attempts
         end
    into daily_cap
    from public.subscription_limits
    where id = 1;

  -- null cap = unlimited.
  if daily_cap is null then
    return new;
  end if;

  -- Count DISTINCT quizzes the student opened in the last 24h.
  -- We count distinct quiz_ids (not rows) so a reload that creates a second
  -- attempt-row for the same quiz doesn't burn an extra cap slot. Allowing
  -- the same quiz to be retried within the 24-hour window is still subject
  -- to the cap, just that the SECOND open of an already-counted quiz is free.
  select count(distinct quiz_id) into attempts_24h
    from public.quiz_attempts
    where student_id = new.student_id
      and started_at >= now() - interval '24 hours'
      and quiz_id <> new.quiz_id;  -- the new attempt's quiz isn't counted; we check fresh slot

  if attempts_24h >= daily_cap then
    raise exception 'Daily free-attempt limit reached (% / day on the free plan). Upgrade or come back tomorrow.', daily_cap
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists check_attempt_quota_trigger on public.quiz_attempts;
create trigger check_attempt_quota_trigger
  before insert on public.quiz_attempts
  for each row execute function public.check_attempt_quota();

-- ============ Helper: how many free attempts does this user have left today? ============
create or replace function public.attempts_remaining_today()
returns integer
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  user_role text;
  is_school boolean;
  user_tier text;
  used int;
  cap int;
begin
  if auth.uid() is null then return null; end if;

  select role, coalesce(is_school_student, false)
    into user_role, is_school
    from public.profiles where id = auth.uid();

  if user_role <> 'student' or is_school then return null; end if;

  select tier into user_tier from public.subscriptions where user_id = auth.uid();

  select case coalesce(user_tier, 'free')
           when 'free'       then free_daily_attempts
           when 'individual' then individual_daily_attempts
           when 'premium'    then premium_daily_attempts
           else free_daily_attempts
         end
    into cap from public.subscription_limits where id = 1;

  if cap is null then return null; end if;

  select count(distinct quiz_id) into used
    from public.quiz_attempts
    where student_id = auth.uid()
      and started_at >= now() - interval '24 hours';

  return greatest(cap - used, 0);
end;
$$;
