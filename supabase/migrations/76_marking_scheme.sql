-- =============================================================================
-- 76_marking_scheme.sql
-- -----------------------------------------------------------------------------
-- Per-test marking schemes (V1). Adds columns to support JEE / NEET / CAT /
-- boards-style scoring rules. Pre-existing data is fully preserved — every
-- new column is nullable and a NULL value means "use the legacy +1 / 0 / 0
-- default" everywhere it's consumed.
--
-- Architecture rationale:
--   - quizzes.marking_scheme            → the rule the teacher/student
--                                         chose when creating the test
--   - quiz_attempts.marking_scheme_snapshot → frozen-at-submit copy of the
--                                             rule, so admin edits to the
--                                             quiz cannot retroactively
--                                             change historical grades
--   - quiz_attempts.raw_score / max_score  → numeric (so we can support
--                                            negative raw scores and decimal
--                                            marks like 0.5 for partial)
--   - attempt_answers.marks_earned      → per-question marks computed at
--                                         submit time. NULL on legacy rows
--                                         (those use is_correct + flat +1/0)
--
-- Bloom mastery, BloomIQ Score, school-reports Bloom breakdowns are
-- intentionally UNAFFECTED — they all key off attempt_answers.is_correct,
-- which is scheme-independent and continues to be written on every attempt.
--
-- Run order: applies after migration 75 (subscription suspension audit).
-- Safe to re-run on partially-applied environments via the IF NOT EXISTS
-- guards. Reload PostgREST at the end so the new columns are visible to
-- the JS layer without a server restart.
-- =============================================================================

-- ─── quizzes.marking_scheme ──────────────────────────────────────────────────
-- The full rule lives in a single JSONB column. Shape:
--
--   {
--     "preset": "PRACTICE" | "BOARDS" | "JEE_MAIN" | "JEE_ADV" |
--               "NEET" | "CAT" | "CUSTOM",
--     "negative_marks_enabled": boolean,
--     "rules": {
--       "default": { "correct": <num>, "wrong": <num>, "unattempted": <num> }
--     }
--   }
--
-- NULL ⇒ treated as the implicit default: PRACTICE with negative marks off
-- (correct = 1, wrong = 0, unattempted = 0). All legacy quizzes keep
-- working without a backfill.
alter table public.quizzes
  add column if not exists marking_scheme jsonb;

comment on column public.quizzes.marking_scheme is
  'Per-test marking rule (JSONB). NULL means flat +1/0/0 (legacy default). '
  'Set by the creator (teacher OR independent student) at test build time. '
  'See lib/scoring.ts → DEFAULT_SCHEME for the NULL fallback shape. '
  'Migration 76.';

-- ─── quiz_attempts: raw_score / max_score / marking_scheme_snapshot ──────────
-- raw_score: numeric so it can hold negative values (e.g., JEE Main mock
-- with more wrong answers than correct) AND decimals (CUSTOM presets that
-- award 0.5 / 0.25).
--
-- max_score: numeric for symmetry. Always > 0 when populated.
--
-- marking_scheme_snapshot: the scheme as it was at the moment the student
-- hit submit. Defends against the platform admin editing a quiz's scheme
-- mid-flight or after the fact — historical attempts retain their original
-- grading basis.
alter table public.quiz_attempts
  add column if not exists raw_score              numeric,
  add column if not exists max_score              numeric,
  add column if not exists marking_scheme_snapshot jsonb;

comment on column public.quiz_attempts.raw_score is
  'Raw score in points (NOT correct-count). Can be negative when the '
  'attempt''s scheme has negative marks and the student got more wrong '
  'than correct. Display layer should show actual value but clamp '
  'percentage at 0. Existing rows pre-migration have NULL — those fall '
  'back to the legacy score / total columns. Migration 76.';

comment on column public.quiz_attempts.max_score is
  'Maximum possible score for this attempt given its marking scheme. '
  'For PRACTICE this equals total (question count). For JEE Main this '
  'is total × 4. NULL on pre-migration rows. Migration 76.';

comment on column public.quiz_attempts.marking_scheme_snapshot is
  'Frozen copy of the quiz''s marking_scheme at submission time. Prevents '
  'admin edits to the live quiz from retroactively re-grading old attempts. '
  'NULL means "use legacy +1/0/0 display." Migration 76.';

-- ─── attempt_answers.marks_earned ────────────────────────────────────────────
-- The marks this individual question earned for THIS attempt, computed at
-- submit time from the snapshotted scheme. For PRACTICE: 1 if is_correct
-- else 0. For JEE Main with negative on: 4 if correct, −1 if wrong,
-- 0 if unattempted (selected_index IS NULL).
--
-- NULL on pre-migration rows. Result-page renderer treats NULL as
-- "compute legacy score on the fly from is_correct."
alter table public.attempt_answers
  add column if not exists marks_earned numeric;

comment on column public.attempt_answers.marks_earned is
  'Marks earned by this single question on this attempt, given the '
  'attempt''s snapshotted marking scheme. NULL on pre-migration rows — '
  'those use is_correct + flat +1/0. Migration 76.';

-- ─── Index for "score across attempts" report queries ────────────────────────
-- Several aggregation paths (teacher reports, student trend) read
-- quiz_attempts.raw_score per (student_id, submitted_at). Partial index
-- only on non-NULL rows keeps the index small while pre-migration rows
-- exist.
create index if not exists quiz_attempts_raw_score_idx
  on public.quiz_attempts (student_id, submitted_at)
  where raw_score is not null;

-- ─── Reload PostgREST schema ─────────────────────────────────────────────────
notify pgrst, 'reload schema';
