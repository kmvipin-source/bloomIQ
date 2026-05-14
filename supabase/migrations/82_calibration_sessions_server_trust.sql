-- =============================================================================
-- 82_calibration_sessions_server_trust.sql
-- -----------------------------------------------------------------------------
-- Phase H critical fix: close the calibration self-score forge.
--
-- /api/student/calibration/start previously returned correct_index in the
-- response and trusted whatever the client POSTed back to /submit. A
-- tampered request could declare every answer correct and inflate the
-- bloomiq_score to 900 (max). The score is non-monetary but drives Premium
-- upsell narratives, the badge, and recommendations — so it has to be
-- honest.
--
-- This migration adds a short-lived `calibration_sessions` table that
-- stores the issued questions keyed by session_id + user_id. /submit
-- re-reads the server-trusted correct_indexes from this table and ignores
-- whatever the client sends. Row TTL is enforced at the application
-- layer (rows older than 6 hours are stale and rejected).
--
-- Re-runnable via IF NOT EXISTS.
-- =============================================================================

create table if not exists public.calibration_sessions (
  session_id  uuid        primary key,
  user_id     uuid        not null references auth.users(id) on delete cascade,
  exam_goal   text,
  groq_model  text,
  questions   jsonb       not null,
  created_at  timestamptz not null default now()
);

comment on table public.calibration_sessions is
  'Short-lived server-trusted record of calibration questions issued per start call. /submit re-reads correct_index from here. Migration 82.';

create index if not exists calibration_sessions_user_idx
  on public.calibration_sessions (user_id, created_at desc);

-- RLS: nobody reads this directly. Service-role only.
alter table public.calibration_sessions enable row level security;

-- No policies = no access for anon / authenticated. Service-role bypasses RLS.

notify pgrst, 'reload schema';
