-- =============================================================================
-- 88_phase_k_indexes.sql
-- -----------------------------------------------------------------------------
-- Phase K perf indexes. Small batch.
--
-- (a) classes_inactive_school_idx — admin "show archived classes" view
--     currently scans on (school_id) and filters status='inactive' in
--     application code. A partial index on the inactive set keeps the
--     scan O(log N) when archived classes accumulate.
--
-- (b) subscriptions_school_reactivated_idx — finance ops query
--     "who reactivated School X and when?" by (school_id, reactivated_at
--     desc). Existing reactivated_at index is global; add a compound
--     for the per-school lookup.
-- =============================================================================

create index if not exists classes_inactive_school_idx
  on public.classes (school_id, created_at desc)
  where status = 'inactive';

create index if not exists subscriptions_school_reactivated_idx
  on public.subscriptions (school_id, reactivated_at desc)
  where reactivated_at is not null and school_id is not null;

notify pgrst, 'reload schema';
