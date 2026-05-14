-- =============================================================================
-- 85_free_tier_active_filter.sql
-- -----------------------------------------------------------------------------
-- Tighten free_daily_remaining / free_lifetime_used so they only treat an
-- ACTIVE non-expired subscription as paid. The previous version sorted
-- subscriptions by created_at desc with no status / expires_at filter; a
-- user with a stale `cancelled` or `expired` row newer than their last
-- active one was silently treated as paid and skipped the cap. Adds the
-- s.status='active' AND (expires_at is null or expires_at > now())
-- filter to both helpers.
-- =============================================================================

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
  select coalesce(s.tier, 'free')
    into v_tier
    from public.subscriptions s
   where s.user_id = p_user_id
     and (s.status is null or s.status = 'active')
     and (s.expires_at is null or s.expires_at > now())
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
     and (s.status is null or s.status = 'active')
     and (s.expires_at is null or s.expires_at > now())
   order by s.created_at desc
   limit 1;

  if v_tier <> 'free' and v_tier is not null then
    return false;
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

notify pgrst, 'reload schema';
