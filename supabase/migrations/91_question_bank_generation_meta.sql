-- supabase/migrations/91_question_bank_generation_meta.sql
-- ==========================================================================
-- Question-generation provenance metadata.
--
-- Why
-- ---
-- Today every question in question_bank is anonymous about HOW it was made:
-- which route generated it, what Bloom level was requested vs. what landed,
-- whether the answer-key verifier agreed with the LLM, whether the cross-
-- session cosine dedup actually ran, how many retries it took. We compute
-- all of this during generation and then throw it away on insert.
--
-- That hurts us three ways:
--   1. Review UX. A teacher can't see "the verifier disputed this answer
--      key" because we never persisted the verdict.
--   2. Debugging. When a student complains "I got the same question twice",
--      we can't tell whether dedup was bypassed, the embedding was NULL,
--      or two different routes generated overlapping content.
--   3. Prompt-quality regression detection. Without prompt_version per
--      question we can't bisect a quality regression to a prompt change.
--
-- Design
-- ------
-- Single nullable jsonb column with default '{}'::jsonb. The column is
-- written opportunistically by lib/qgenPipeline (P0.1) but every existing
-- insert path continues to work unchanged — they just leave the column
-- as the default {}.
--
-- Shape (NOT enforced by a CHECK — jsonb is schema-on-read by design,
-- and we want to evolve fields without migrations):
--   {
--     route: string,                  -- 'student.generate', 'teacher.generate', 'speed', 'flashcards', 'practice'
--     intent: string,                 -- 'quiz' | 'practice' | 'flashcards' | 'speed' | 'teach-back'
--     requested_bloom: string,        -- 'apply' etc.
--     prompt_version: string,         -- 'qgen.v3.2026-05-16' — bump on prompt edits
--     verifier: {
--       status: 'agreed' | 'disputed' | 'skipped',
--       reason?: string,              -- one-line explanation when disputed
--       model: string,                -- e.g. 'groq:llama-3.3-70b'
--       llm_correct?: string,         -- LLM's stated correct option
--       verifier_correct?: string,    -- verifier's stated correct option
--     },
--     embedding_present: boolean,     -- true if stem_embedding was computed
--     dedup: {
--       jaccard_filtered: number,     -- count filtered at jaccard stage
--       cosine_in_batch_filtered: number,
--       cosine_history_filtered: number
--     },
--     retry_count: number,
--     generated_at: string,           -- ISO timestamp
--     bloom_disputed?: boolean        -- set by P1.5 bloom verifier
--   }
--
-- A GIN index on the jsonb column powers future analytics queries
-- ("how many disputed answer-key verdicts last week?", "average retry
-- count by route"). Cost is negligible at our row volume.
--
-- Backfill
-- --------
-- Existing rows get generation_meta = '{}'::jsonb (the default). The
-- review UI treats missing keys as "unknown" and renders no badge.
-- ==========================================================================

ALTER TABLE question_bank
  ADD COLUMN IF NOT EXISTS generation_meta jsonb NOT NULL DEFAULT '{}'::jsonb;

-- GIN index for ad-hoc analytics on the meta blob. Cheap to maintain;
-- the column is small (<2 KB typical) and writes are append-only.
CREATE INDEX IF NOT EXISTS question_bank_generation_meta_gin_idx
  ON question_bank
  USING gin (generation_meta);

-- Partial index that powers the review-side "show me anything the
-- verifier disputed" filter — this is the most common operational query
-- we expect once P1.4 lands.
CREATE INDEX IF NOT EXISTS question_bank_disputed_idx
  ON question_bank (owner_id, created_at DESC)
  WHERE (generation_meta->'verifier'->>'status') = 'disputed';

COMMENT ON COLUMN question_bank.generation_meta IS
  'Provenance blob written by lib/qgenPipeline. See migration 91 for the shape. NULL/{} = legacy row from before migration 91 (treat all fields as unknown).';
