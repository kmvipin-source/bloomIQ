-- BloomIQ: Free-tier caps and per-user usage tracking
-- ==============================================================
-- Strategy: "Showcase Free" (Option A from docs/FREE_PLAN_AUDIT.md)
--
-- Adds two surfaces:
--   1) DAILY caps  — per-day usage counter on AI-burning routes
--                    (resets at midnight IST)
--   2) LIFETIME caps — one-shot taste of premium-plus features
--                      so the student can feel them once
--
-- Every cap is editable by platform admin at /admin/free-tier-limits.
-- Premium / Premium Plus subscribers are NEVER counted — caps apply
-- to the 'free' tier only.
--
-- Additive. Safe to run on a live database. All inserts / alters
-- are idempotent.
--
-- Adds:
--   subscription_limits.* (many new int columns, all nullable=NO,
--                          all with sensible defaults)
--   daily_ai_usage table
--   lifetime_feature_usage table
--   Helper SQL functions: free_daily_remaining, free_lifetime_used
--   RLS policies so a user can read their own counters

-- ===========================================================
-- 1) Extend subscription_limits with all new caps
-- ===========================================================
alter table public.subscription_limits
  -- DAILY caps for the Free tier (all int, NOT NULL, defaults match Option A)
  add column if not exists free_daily_tutor_turns      int not null default 5
    check (free_daily_tutor_turns >= 0 and free_daily_tutor_turns <= 1000),
  add column if not exists free_daily_teach_back       int not null default 1
    check (free_daily_teach_back >= 0 and free_daily_teach_back <= 1000),
  add column if not exists free_daily_speed_sessions   int not null default 1
    check (free_daily_speed_sessions >= 0 and free_daily_speed_sessions <= 1000),
  add column if not exists free_daily_flashcards       int not null default 5
    check (free_daily_flashcards >= 0 and free_daily_flashcards <= 1000),
  add column if not exists free_daily_coach_turns      int not null default 5
    check (free_daily_coach_turns >= 0 and free_daily_coach_turns <= 1000),
  add column if not exists free_daily_drill            int not null default 1
    check (free_daily_drill >= 0 and free_daily_drill <= 1000),
  -- LIFETIME caps for the Free tier (one-shot premium-plus tastes)
  add column if not exists free_lifetime_xray          int not null default 1
    check (free_lifetime_xray >= 0 and free_lifetime_xray <= 1000),
  add column if not exists free_lifetime_rank          int not null default 1
    check (free_lifetime_rank >= 0 and free_lifetime_rank <= 1000),
  add column if not exists free_lifetime_visualizer    int not null default 1
    check (free_lifetime_visualizer >= 0 and free_lifetime_visualizer <= 1000),
  add column if not exists free_lifetime_voice_teacher int not null default 1
    check (free_lifetime_voice_teacher >= 0 and free_lifetime_voice_teacher <= 1000),
  add column if not exists free_lifetime_trap_detector int not null default 1
    check (free_lifetime_trap_detector >= 0 and free_lifetime_trap_detector <= 1000),
  add column if not exists free_lifetime_knowledge_graph int not null default 1
    check (free_lifetime_knowledge_graph >= 0 and free_lifetime_knowledge_graph <= 1000),
  add column if not exists free_lifetime_bloom_score   int not null default 1
    check (free_lifetime_bloom_score >= 0 and free_lifetime_bloom_score <= 1000),
  -- Reset window. IANA timezone string. Daily counters reset at local
  -- midnight in this zone. Default Asia/Kolkata for the Indian market.
  add column if not exists daily_reset_timezone text not null default 'Asia/Kolkata';

comment on column public.subscription_limits.free_daily_tutor_turns is
  'Free-tier: tutor chat turns allowed per day (reset at daily_reset_timezone midnight).';
comment on column public.subscription_limits.free_lifetime_xray is
  'Free-tier: one-shot taste of Past-Paper X-Ray. Set to 0 to hard-lock.';
comment on column public.subscription_limits.daily_reset_timezone is
  'IANA tz used for the daily reset boundary. Default Asia/Kolkata.';

-- ===========================================================
-- 2) daily_ai_usage — one row per (user, surface, day)
-- ===========================================================
-- Surface = which AI route. day_key is YYYY-MM-DD in the reset
-- timezone. PK on (user_id, surface, day_key) so the increment can
-- be a clean upsert and the lookup is O(1).
create table if not exists public.daily_ai_usage (
  user_id    uuid not null references auth.users(id) on delete cascade,
  surface    text not null check (surface in (
               'tutor_chat',
               'teach_back',
               'speed_session',
               'flashcards',
               'student_coach',
               'daily_drill'
             )),
  day_key    text not null check (day_key ~ '^\d{4}-\d{2}-\d{2}$'),
  count      int  not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, surface, day_key)
);

create index if not exists daily_ai_usage_user_day_idx
  on public.daily_ai_usage (user_id, day_key desc);

alter table public.daily_ai_usage enable row level security;

drop policy if exists daily_ai_usage_select_own on public.daily_ai_usage;
create policy daily_ai_usage_select_own on public.daily_ai_usage
  for select using (auth.uid() = user_id);

-- No client INSERT/UPDATE/DELETE policies — only the server-side
-- helper (which uses the service role) writes here. Clients read
-- their own counts via /api/feature/usage.

-- ===========================================================
-- 3) lifetime_feature_usage — one row per (user, feature_key)
-- ===========================================================
-- Records the first time a Free user "tasted" each premium-plus
-- feature. The row's existence means "this user has used their
-- one shot already". `count` exists for future flexibility
-- (admin could raise the lifetime limit to 2 or 3 without
-- migrating data).
create table if not exists public.lifetime_feature_usage (
  user_id      uuid not null references auth.users(id) on delete cascade,
  feature_key  text not null check (feature_key in (
                 'xray',
                 'rank',
                 'visualizer',
                 'voice_teacher',
                 'trap_detector',
                 'knowledge_graph',
                 'bloom_score'
               )),
  count        int  not null default 1 check (count >= 0),
  first_used_at timestamptz not null default now(),
  last_used_at  timestamptz not null default now(),
  primary key (user_id, feature_key)
);

create index if not exists lifetime_feature_usage_user_idx
  on public.lifetime_feature_usage (user_id);

alter table public.lifetime_feature_usage enable row level security;

drop policy if exists lifetime_feature_usage_select_own on public.lifetime_feature_usage;
create policy lifetime_feature_usage_select_own on public.lifetime_feature_usage
  for select using (auth.uid() = user_id);

-- ===========================================================
-- 4) Helper: free_daily_remaining(user_id, surface)
-- ===========================================================
-- Returns null when the surface isn't capped (paid user OR cap=null
-- in the admin settings). Returns 0 if the cap has been hit.
-- Otherwise returns (cap - used_today) — never negative.
--
-- DEFINER: reads subscription_limits + daily_ai_usage without
-- relying on the user's RLS context (the user's own rows are
-- readable to them anyway but service-role tables need this).
create or replace function public.free_daily_remaining(
  p_user_id uuid,
  p_surface text
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier      text;
  v_tz        text;
  v_day       text;
  v_cap       int;
  v_used      int;
begin
  -- Paid users are uncapped.
  select coalesce(s.tier, 'free')
    into v_tier
    from public.subscriptions s
   where s.user_id = p_user_id
   order by s.created_at desc
   limit 1;

  if v_tier <> 'free' and v_tier is not null then
    return null;
  end if;

  select daily_reset_timezone,
         case p_surface
           when 'tutor_chat'    then free_daily_tutor_turns
           when 'teach_back'    then free_daily_teach_back
           when 'speed_session' then free_daily_speed_sessions
           when 'flashcards'    then free_daily_flashcards
           when 'student_coach' then free_daily_coach_turns
           when 'daily_drill'   then free_daily_drill
           else null
         end
    into v_tz, v_cap
    from public.subscription_limits
   where id = 1;

  if v_cap is null then
    return null;
  end if;

  v_day := to_char((now() at time zone coalesce(v_tz, 'Asia/Kolkata'))::date, 'YYYY-MM-DD');

  select coalesce(count, 0)
    into v_used
    from public.daily_ai_usage
   where user_id = p_user_id
     and surface = p_surface
     and day_key = v_day;

  return greatest(0, v_cap - coalesce(v_used, 0));
end;
$$;

grant execute on function public.free_daily_remaining(uuid, text) to authenticated, anon;

-- ===========================================================
-- 5) Helper: free_lifetime_used(user_id, feature_key)
-- ===========================================================
-- Returns true if the user has already used their lifetime quota.
-- Returns false for paid users (uncapped) or for Free users who
-- still have a shot left.
create or replace function public.free_lifetime_used(
  p_user_id uuid,
  p_feature_key text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier text;
  v_cap  int;
  v_used int;
begin
  select coalesce(s.tier, 'free')
    into v_tier
    from public.subscriptions s
   where s.user_id = p_user_id
   order by s.created_at desc
   limit 1;

  if v_tier <> 'free' and v_tier is not null then
    return false;  -- paid: no limit
  end if;

  select case p_feature_key
           when 'xray'             then free_lifetime_xray
           when 'rank'             then free_lifetime_rank
           when 'visualizer'       then free_lifetime_visualizer
           when 'voice_teacher'    then free_lifetime_voice_teacher
           when 'trap_detector'    then free_lifetime_trap_detector
           when 'knowledge_graph'  then free_lifetime_knowledge_graph
           when 'bloom_score'      then free_lifetime_bloom_score
           else null
         end
    into v_cap
    from public.subscription_limits
   where id = 1;

  if v_cap is null then
    return false;
  end if;

  select coalesce(count, 0)
    into v_used
    from public.lifetime_feature_usage
   where user_id = p_user_id
     and feature_key = p_feature_key;

  return coalesce(v_used, 0) >= v_cap;
end;
$$;

grant execute on function public.free_lifetime_used(uuid, text) to authenticated, anon;

-- ===========================================================
-- 6) Update the Free plan's feature_summary to match Option A
--    (Showcase Free). This is the marketing copy shown on the
--    dashboard / pricing page. The actual entitlements come from
--    plans.features + subscription_limits — this is just labels.
-- ===========================================================
update public.plans
   set feature_summary = array[
         '3 quizzes per day + 1 Daily Drill',
         'BloomIQ Score (once) + basic Bloom report',
         'AI Tutor: 5 turns/day',
         'Performance Coach: 5 turns/day',
         '1 Speed-Accuracy session/day',
         '1 Teach-Back/day',
         'Flashcards: 5/day',
         'One free taste of X-Ray, Trap Detector, Rank Predictor,'
           || ' Visualizer, Voice Teacher & Knowledge Graph',
         'Memory Tune-Up: review only (paid to add cards)',
         'Single device only'
       ]::text[]
 where slug = 'free' and status = 'active';

-- ===========================================================
-- 7) Reload PostgREST so the new columns / functions appear
-- ===========================================================
notify pgrst, 'reload schema';
