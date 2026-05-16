-- supabase/migrations/90_question_bank_category.sql
-- ==========================================================================
-- Question-bank teaching/learning context tagging.
--
-- Why
-- ---
-- Vipin's #4 (2026-05-15):
-- > "Question bank doesn't tell for which category questions are generated
-- >  — say Class 8, Class 12, JEE etc."
--
-- A teacher who teaches multiple categories (Class 8 maths + Class 12
-- physics + JEE coaching on weekends) accumulates questions in a single
-- question_bank pool. Without a category column, the assign-flow can't
-- filter "show me only Class 8 questions for tomorrow's class test" and
-- the variant-suggester can't avoid serving a JEE-difficulty question to
-- a Class-8 cohort.
--
-- Design
-- ------
-- One new column: `category` text NULL. Free-form text constrained
-- informally to the same slug vocabulary used in profiles.exam_goal
-- (e.g. 'class5_8', 'class_9', 'class_10_boards', 'class_12_boards',
-- 'jee_main', 'neet_prep', 'cat_prep', 'upsc_prep', 'gate_prep',
-- 'corporate'). NULL means "legacy row — generated before this migration".
--
-- We deliberately AVOID a CHECK constraint here:
--   1. The slug set grows over time (new exams added without a migration).
--   2. Custom corporate categories (e.g. 'aws_solutions_architect') break
--      a fixed enum.
--   3. The UI only ever writes from a known list of options, so we get
--      practical validation without locking ourselves out of new slugs.
--
-- A partial index keeps the common "filter by category for this owner"
-- query fast — the question_bank UI's category filter dropdown.
--
-- Backfill
-- --------
-- Existing rows get category=NULL. The question-bank UI displays
-- "Uncategorized" for NULL. Teachers can bulk-tag historical rows
-- through a future admin UI; for now NULL is acceptable since older
-- questions pre-date teaching-context capture.
-- ==========================================================================

ALTER TABLE question_bank
  ADD COLUMN IF NOT EXISTS category text;

CREATE INDEX IF NOT EXISTS question_bank_owner_category_idx
  ON question_bank (owner_id, category)
  WHERE category IS NOT NULL;

COMMENT ON COLUMN question_bank.category IS
  'Teaching/learning context this question was generated for (mirror of profiles.exam_goal slug — class5_8, class_10_boards, jee_main, neet_prep, etc.). NULL = legacy row from before migration 90. Used by the question-bank UI filter and the class-fit suggester.';
