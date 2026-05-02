-- =============================================================================
-- Migration 44 — fix Premium Plus + expired-subscription handling for both
--                attempts_remaining_today() AND check_attempt_quota trigger
-- -----------------------------------------------------------------------------
-- Bug: the original migration 10 used the same flawed CASE pattern in TWO
-- places: the read-side helper attempts_remaining_today() AND the
-- WRITE-side trigger check_attempt_quota that fires BEFORE INSERT on
-- quiz_attempts. Both enumerated only 'free' / 'individual' / 'premium'.
-- Any other tier (notably 'premium_plus') fell through to the else branch
-- and got the FREE cap of 3 attempts/day.
--
-- Symptoms:
--   1. Premium Plus subscribers saw "0 of 3 free attempts left today"
--      banner on /student — wrong messaging.
--   2. Premium Plus subscribers were HARD-BLOCKED at the database from
--      creating a 4th quiz attempt within 24h. The trigger raised
--      "Daily free-attempt limit reached" and rejected the insert. THIS
--      WAS THE ACTUAL HARD CAP — fixing only the helper would still leave
--      paying customers locked out.
--
-- Bug 2: neither function checked subscriptions.status or expires_at.
-- An expired paid subscription coincidentally hit the same else branch
-- (also wrong, but invisibly so). Once we add 'premium_plus' to the case,
-- that fallback evaporates, so we make the expiry check explicit too.
--
-- Fix: rewrite both functions with a single, explicit decision:
--   - Not a student / school student → uncapped
--   - No subscription / status != active / past expires_at → free cap
--   - tier = 'free' → free cap
--   - any active paid tier (premium / premium_plus / individual) → uncapped
--
-- Both functions share the same is_active_paid predicate so they cannot
-- drift out of sync again. The dashboard treats null from the helper as
-- "no banner". The trigger returns NEW (allowing the insert) for paid
-- users.
-- =============================================================================

-- =====================================================================
-- 1. Read-side helper — attempts_remaining_today()
-- =====================================================================

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
  sub_tier text;
  sub_status text;
  sub_expires_at timestamptz;
  cap int;
  used int;
  is_active_paid boolean;
begin
  -- Anonymous → no cap (the dashboard never calls this for anon, but
  -- defensive). Returning null also makes RLS / RPC clients happy.
  if auth.uid() is null then return null; end if;

  -- Pull the caller's role + school flag in one go.
  select role, coalesce(is_school_student, false)
    into user_role, is_school
    from public.profiles
    where id = auth.uid();

  -- Only independent students are subject to the daily cap. Everyone else
  -- (teachers, super_teachers, platform admins, school students) gets null.
  if user_role <> 'student' or is_school then
    return null;
  end if;

  -- Pull current subscription — at most one row per user_id (partial unique
  -- index in earlier migrations). NULL row means "never paid".
  select tier, status, expires_at
    into sub_tier, sub_status, sub_expires_at
    from public.subscriptions
    where user_id = auth.uid();

  -- Paid-tier check: the subscription must be (a) on a non-free tier,
  -- (b) status='active', and (c) not past expires_at. Any failure → free cap.
  is_active_paid :=
       sub_tier is not null
   and sub_tier <> 'free'
   and coalesce(sub_status, 'expired') = 'active'
   and (sub_expires_at is null or sub_expires_at > now());

  if is_active_paid then
    -- Paid + active + not expired → uncapped. Dashboard renders no banner.
    return null;
  end if;

  -- Free / expired / no-sub path: enforce the free daily cap.
  select free_daily_attempts into cap from public.subscription_limits where id = 1;
  if cap is null then return null; end if;

  select count(distinct quiz_id) into used
    from public.quiz_attempts
    where student_id = auth.uid()
      and started_at >= now() - interval '24 hours';

  return greatest(cap - used, 0);
end;
$$;

-- =====================================================================
-- 2. Write-side trigger — check_attempt_quota (fires BEFORE INSERT
--    on quiz_attempts). Same is_active_paid predicate as the helper.
--    Without this fix, a Premium Plus user gets a database-level
--    rejection on their 4th quiz attempt with "Daily free-attempt
--    limit reached".
-- =====================================================================

create or replace function public.check_attempt_quota()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  user_role text;
  is_school boolean;
  sub_tier text;
  sub_status text;
  sub_expires_at timestamptz;
  attempts_24h int;
  daily_cap int;
  is_active_paid boolean;
begin
  -- Only independent students are subject to the cap. Teachers,
  -- super_teachers, platform admins, school students are uncapped.
  select role, coalesce(is_school_student, false)
    into user_role, is_school
    from public.profiles
    where id = new.student_id;

  if user_role <> 'student' or is_school then
    return new;
  end if;

  select tier, status, expires_at
    into sub_tier, sub_status, sub_expires_at
    from public.subscriptions
    where user_id = new.student_id;

  -- Mirrors attempts_remaining_today's predicate exactly so the read
  -- and write paths can never drift apart.
  is_active_paid :=
       sub_tier is not null
   and sub_tier <> 'free'
   and coalesce(sub_status, 'expired') = 'active'
   and (sub_expires_at is null or sub_expires_at > now());

  if is_active_paid then
    -- Paid + active + not expired → no cap. Allow the insert.
    return new;
  end if;

  -- Free / expired / no-sub path: enforce the free daily cap.
  select free_daily_attempts into daily_cap
    from public.subscription_limits
    where id = 1;

  -- null cap = unlimited (config-level kill switch).
  if daily_cap is null then
    return new;
  end if;

  -- Count DISTINCT quizzes the student opened in the last 24h, excluding
  -- the current one (so a reload that creates a second attempt-row for
  -- the same quiz doesn't burn an extra cap slot).
  select count(distinct quiz_id) into attempts_24h
    from public.quiz_attempts
    where student_id = new.student_id
      and started_at >= now() - interval '24 hours'
      and quiz_id <> new.quiz_id;

  if attempts_24h >= daily_cap then
    raise exception 'Daily free-attempt limit reached (% / day on the free plan). Upgrade or come back tomorrow.', daily_cap
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- The trigger itself doesn't need recreating — it already points at the
-- function name and CREATE OR REPLACE FUNCTION updated the body in place.

notify pgrst, 'reload schema';
