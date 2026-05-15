-- =============================================================================
-- 89_free_quota_atomic_rpcs.sql
-- -----------------------------------------------------------------------------
-- File mirror of two RPCs that were originally applied via Supabase MCP
-- during Phase F (audit cycle, 2026-05-14) under the name "80_free_quota
-- _atomic_rpcs" but never committed as a migration file. A subsequent
-- pull from a teammate added a different "80_question_bank_embedding.sql"
-- file. To prevent drift on fresh-clone deployments (supabase db push
-- would only run the embedding file and miss these RPCs), this migration
-- re-declares the functions idempotently via CREATE OR REPLACE.
--
-- Prod already has these — running this file is a no-op there.
--
-- Why these exist
-- ---------------
-- The original check_then_record pattern for free-tier quotas had a
-- TOCTOU race: two parallel callers both saw used=0 and both incremented.
-- These functions do count + increment under an atomic UPSERT with a
-- WHERE clause filtering on count < cap. Either we inserted/incremented
-- and returned the new count, or the WHERE filtered the UPDATE out and
-- count_returning is NULL — caller treats null as "already at cap".
-- =============================================================================

CREATE OR REPLACE FUNCTION public.check_and_log_daily_use(
  p_user_id uuid,
  p_surface text,
  p_cap integer,
  p_day_key text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
declare
  current_count int;
begin
  if p_cap is null or p_cap <= 0 then
    return false;
  end if;

  -- Try atomic upsert that claims the slot only if under-cap.
  insert into public.daily_ai_usage as t (user_id, surface, day_key, count, updated_at)
  values (p_user_id, p_surface, p_day_key, 1, now())
  on conflict (user_id, surface, day_key)
    do update set
      count = t.count + 1,
      updated_at = now()
    where t.count < p_cap
  returning count into current_count;

  -- Either we inserted (current_count=1) or the UPDATE WHERE matched
  -- (current_count is the new bumped value, <= cap). NULL means the
  -- update was filtered out because we were already at cap.
  return current_count is not null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.check_and_log_lifetime_use(
  p_user_id uuid,
  p_feature_key text,
  p_cap integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
declare
  current_count int;
begin
  if p_cap is null or p_cap <= 0 then
    return false;
  end if;

  insert into public.lifetime_feature_usage as t (user_id, feature_key, count, first_used_at, last_used_at)
  values (p_user_id, p_feature_key, 1, now(), now())
  on conflict (user_id, feature_key)
    do update set
      count = t.count + 1,
      last_used_at = now()
    where t.count < p_cap
  returning count into current_count;

  return current_count is not null;
end;
$function$;

notify pgrst, 'reload schema';
