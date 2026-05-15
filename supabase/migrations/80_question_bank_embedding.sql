-- supabase/migrations/80_question_bank_embedding.sql
-- ==========================================================================
-- Vector-embedding column for question_bank + IVFFlat index for cosine
-- nearest-neighbour search. Powers semantic dedup that catches paraphrases
-- the existing Jaccard token-set filter can never see.
--
-- Why
-- ---
-- Jaccard on uppercased token sets misses real paraphrases:
--   "How does HCl ionise in water?" vs "What's the dissociation of HCl?"
--   → ~0.85 cosine on embeddings, ~0.10 Jaccard.
-- Result: students hit the same question rephrased and the dedup pipeline
-- waved it through. With this migration + lib/embeddings, the dedup
-- pre-filter catches the paraphrase before it reaches verifyAnswerKeys.
--
-- Embedding model
-- ---------------
-- Gemini text-embedding-004 → 768 dimensions (free tier on Google AI
-- Studio). The dimension is fixed in the schema; if you switch to OpenAI
-- text-embedding-3-small (1536) or another model, a follow-up migration
-- will need to widen the column.
--
-- Backfill
-- --------
-- Existing rows get stem_embedding=NULL. The dedup helper treats NULL as
-- "no embedding available, fall back to Jaccard". A background job (NOT
-- in this migration — it would block deployment) can backfill at leisure.
-- New questions inserted after this migration include the embedding on
-- write — no NULLs for fresh data.
-- ==========================================================================

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE question_bank
  ADD COLUMN IF NOT EXISTS stem_embedding vector(768);

-- IVFFlat index for cosine similarity. lists=100 is a starting point;
-- for >100k rows tune up to ~sqrt(rowcount). Cosine ops here match
-- pgvector's `<=>` operator (the cosine distance).
CREATE INDEX IF NOT EXISTS question_bank_stem_embedding_cos_idx
  ON question_bank
  USING ivfflat (stem_embedding vector_cosine_ops)
  WITH (lists = 100);

-- Helpful: a brief note that NULL embeddings are valid + how dedup behaves.
COMMENT ON COLUMN question_bank.stem_embedding IS
  'Gemini text-embedding-004 (768-dim) of stem. NULL = legacy row before migration 80; lib/embeddings falls back to token-Jaccard when NULL.';
