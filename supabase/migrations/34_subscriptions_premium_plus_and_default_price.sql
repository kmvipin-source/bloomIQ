-- =============================================================================
-- Migration 34 — subscriptions.price_paid_paise default + premium_plus tier
-- -----------------------------------------------------------------------------
-- /api/admin/schools/[id]/set-plan was 500ing for two reasons:
--
-- 1. `subscriptions.price_paid_paise` is NOT NULL but the route inserts/
--    updates a row without supplying a value (no payment yet for a fresh
--    plan assignment). Set DEFAULT 0 so the column accepts the row.
--
-- 2. `subscriptions_tier_check` only permitted ('free','individual','premium').
--    The set-plan route maps the new 'school_plus' plan tier to a legacy
--    'premium_plus' value, which violated the CHECK. Widen the CHECK to
--    include 'premium_plus'.
-- =============================================================================

alter table public.subscriptions alter column price_paid_paise set default 0;
update public.subscriptions set price_paid_paise = 0 where price_paid_paise is null;

alter table public.subscriptions drop constraint if exists subscriptions_tier_check;
alter table public.subscriptions
  add constraint subscriptions_tier_check
  check (tier = any (array['free','individual','premium','premium_plus']));

notify pgrst, 'reload schema';
