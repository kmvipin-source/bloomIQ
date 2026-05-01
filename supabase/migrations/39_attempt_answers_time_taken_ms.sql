-- =============================================================================
-- Migration 39 — per-question timing on attempt_answers
-- -----------------------------------------------------------------------------
-- Adds the column that powers the "time per question + cohort benchmark"
-- view on the student results page. Existing rows stay NULL — older
-- attempts simply won't show timing data, which the UI handles gracefully.
--
-- Why ms (not seconds): for stats (median, percentiles) and outlier
-- thresholds (e.g. >10 min == probably a tab switch) we want sub-second
-- resolution.
-- =============================================================================

alter table public.attempt_answers
  add column if not exists time_taken_ms int;

-- Partial index so cohort-benchmark queries (group-by question_id with
-- a NOT NULL filter) stay fast even as the table grows. Older rows with
-- time_taken_ms IS NULL aren't indexed.
create index if not exists attempt_answers_question_time_idx
  on public.attempt_answers (question_id)
  where time_taken_ms is not null;

notify pgrst, 'reload schema';
