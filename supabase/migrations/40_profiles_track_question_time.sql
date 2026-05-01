-- =============================================================================
-- Migration 40 — student consent for per-question time tracking
-- -----------------------------------------------------------------------------
-- We're adding a "time per question + cohort comparison" feature. Even
-- though the data is the student's own (and the cohort comparison is
-- aggregated across many students with no PII), we want explicit consent
-- before recording per-question timing on a student's attempts.
--
-- Contract:
--   NULL  → student has never been asked. Quiz UI shows a one-time modal
--           on the first attempt and records the answer here.
--   TRUE  → tracking permitted. attempt_answers.time_taken_ms gets written.
--   FALSE → tracking declined. time_taken_ms stays NULL for this student's
--           future attempts; existing rows are not touched.
--
-- Students can flip this from /settings any time. School students inherit
-- the same default — schools that want a class-wide rule can update via
-- the platform-admin client.
-- =============================================================================

alter table public.profiles
  add column if not exists track_question_time boolean;

-- Default is intentionally NULL, not FALSE — that's how the quiz UI knows
-- whether to show the consent modal vs. silently respect a prior choice.
-- No backfill needed.

notify pgrst, 'reload schema';
