-- BloomIQ migration 17:
--   1) X-Ray: store an AI-generated answer + explanation alongside each
--      tagged question so the student can study from the analyzed paper
--      directly, even when the input contained no answer key.
--   2) Quizzes: persist the recommended_minutes the AI suggested at quiz
--      generation time so the teacher's chosen time_limit can be compared
--      against the recommendation, and the recommendation re-shown on
--      edits. Pure metadata - the actual cap is still time_limit_minutes.
-- Additive and idempotent.

-- ============ 1) X-Ray per-question answer + explanation ============
alter table public.past_paper_xray_questions
  add column if not exists answer text,
  add column if not exists explanation text;

-- ============ 2) Quizzes: AI-recommended duration (minutes) ============
alter table public.quizzes
  add column if not exists recommended_minutes int;
