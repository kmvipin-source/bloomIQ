-- supabase/migrations/92_question_bank_soft_delete_and_rejection.sql
-- ==========================================================================
-- Soft-delete + structured rejection reasons for question_bank (P2.9).
--
-- Why
-- ---
-- Today the review queue is a one-way street: a teacher rejects a question
-- and it disappears. Two things suffer:
--   1. Audit: a teacher who later wonders "why did I throw away that
--      photosynthesis question?" has no record.
--   2. Generation-quality learning loop: we can't aggregate "the most
--      common rejection reasons across the whole platform" to feed back
--      into prompt tuning.
--
-- This migration is purely additive:
--   - `deleted_at timestamptz` — set by future bulk-delete operations.
--     For now, hard-deletes continue to work as today; this column is
--     opt-in for callers that want safe-delete semantics.
--   - `rejection_reason text` — captured by the review UI when a teacher
--     rejects a row. Free-form text but the UI offers a chip-picker for
--     the dominant reasons (factually wrong / answer disputed / too easy /
--     too hard / off-topic / duplicate / poorly worded / other).
--
-- A view-level filter for "active" (= deleted_at IS NULL) is added as a
-- partial index so the common review-queue query stays fast.
-- ==========================================================================

ALTER TABLE question_bank
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason text;

-- Length cap on rejection_reason. Reasons should be one-line; the chip
-- picker writes ≤ 40 chars, and free-form "other" is capped at 280.
ALTER TABLE question_bank
  ADD CONSTRAINT question_bank_rejection_reason_len
    CHECK (rejection_reason IS NULL OR char_length(rejection_reason) <= 280);

-- Partial index for the active-row query (the hot path on review/list).
-- Existing indexes still serve broader filters; this one is specifically
-- for "give me everything not soft-deleted, newest first".
CREATE INDEX IF NOT EXISTS question_bank_active_idx
  ON question_bank (owner_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Partial index for analytics — group-by rejection_reason to power
-- "what are teachers rejecting most?" dashboards.
CREATE INDEX IF NOT EXISTS question_bank_rejection_reason_idx
  ON question_bank (rejection_reason)
  WHERE rejection_reason IS NOT NULL;

COMMENT ON COLUMN question_bank.deleted_at IS
  'Soft-delete timestamp. NULL = active row. Set by review/bulk-delete UI; existing hard-deletes continue to work. Queries that should hide deleted rows must filter WHERE deleted_at IS NULL.';

COMMENT ON COLUMN question_bank.rejection_reason IS
  'Free-text reason captured by /teacher/review when a teacher rejects. Chip-picker writes short slugs (factual / disputed / too_easy / too_hard / off_topic / duplicate / poorly_worded), "other" allows free text up to 280 chars. NULL until the question is rejected and the teacher provides a reason.';
