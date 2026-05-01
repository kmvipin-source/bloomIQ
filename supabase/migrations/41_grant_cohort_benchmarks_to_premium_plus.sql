-- =============================================================================
-- Migration 41 — grant the new "cohort_benchmarks" feature to the right plans
-- -----------------------------------------------------------------------------
-- We're shipping per-question cohort-median pacing on the student results
-- page. Per the gating decision (premium-plus + school-plus only), append
-- the feature key to those three SKUs' features[] arrays.
--
-- Idempotent: only adds the key when it's not already present, so re-running
-- the migration is safe.
-- =============================================================================

update public.plans
   set features = features || to_jsonb('cohort_benchmarks'::text)
 where slug in ('premium_plus_monthly', 'premium_plus_annual', 'school_plus')
   and not (features ? 'cohort_benchmarks');

notify pgrst, 'reload schema';
