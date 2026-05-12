-- =============================================================================
-- 77_last_marking_scheme.sql
-- -----------------------------------------------------------------------------
-- Sticky per-user marking-scheme preference. Adds a single nullable JSONB
-- column to profiles that stores the most-recent marking_scheme the user
-- picked on any test surface (Speed Trainer, Sprint, Drill, Practice,
-- Generate, teacher quiz builder).
--
-- Read path (every test-creation surface):
--   1. Read profiles.last_marking_scheme.
--   2. If NULL → fall back to suggestPresetForGoal(profile.exam_goal).
--   3. Pre-fill the <MarkingSchemePicker /> with that value.
--
-- Write path (every successful test creation):
--   - Persist the chosen scheme to profiles.last_marking_scheme via
--     lib/markingSchemeMemory.ts → writeLastMarkingScheme(userId, scheme).
--
-- Shape mirrors the JSONB shape on quizzes.marking_scheme from migration 76
-- (see lib/scoring.ts → MarkingScheme):
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
-- NULL ⇒ user has never picked. UI falls back to the exam_goal-suggested
-- preset on first paint.
--
-- Posture:
--   * Additive only — adds a single column, no drops, no data rewrites.
--   * Nullable — every existing profile row stays untouched and valid.
--   * No backfill — NULL means "never picked yet" and that's the correct
--     semantic for current rows.
--   * Idempotent — IF NOT EXISTS guards make this safe to re-run.
--
-- Run order: applies after 76_marking_scheme.sql.
-- Reload PostgREST at the end so the new column is visible to the JS layer
-- without a server restart.
-- =============================================================================

alter table public.profiles
  add column if not exists last_marking_scheme jsonb;

comment on column public.profiles.last_marking_scheme is
  'Most recently used marking_scheme (JSONB) — pre-fills the picker on every '
  'test-creation surface so a CAT student stays on CAT, a JEE student stays '
  'on JEE Main, etc. NULL means "never picked" — UI falls back to '
  'suggestPresetForGoal(profile.exam_goal). Same shape as '
  'quizzes.marking_scheme from migration 76. Migration 77.';

-- ─── Reload PostgREST schema ─────────────────────────────────────────────────
notify pgrst, 'reload schema';
