-- 52_profiles_learner_profile.sql
-- Adds an optional `learner_profile` column to profiles, used to tune
-- generation suggestions on a per-user basis.
--
-- Why: BloomIQ's content (intent chips, topic detectors, prompt style)
-- is currently optimized for K-12. Different audiences want different
-- defaults — a CAT aspirant wants exam-style depth, a corporate Java
-- trainee wants code-completion + scenarios. We capture this once,
-- non-invasively, and let the UI swap chip sets / detector tables based
-- on the value. Vocabulary stays the same ("student", "teacher", "test")
-- across all profiles — only suggested CONTENT changes.
--
-- Default 'k12' for every existing user. Backfilled trivially via the
-- DEFAULT clause; no rebackfill needed.
--
-- The first-time inline prompt on /teacher/generate and /student/generate
-- writes to this column. Users can also edit it from /settings/profile.
-- Auto-promoted to 'competitive_exam' when a student sets an exam goal
-- in their existing onboarding (separate code path).

alter table public.profiles
  add column if not exists learner_profile text not null default 'k12'
  check (learner_profile in ('k12', 'competitive_exam', 'corporate'));

-- No new RLS policy needed — profiles already has owner-can-read-and-
-- update policies that cover this column.

notify pgrst, 'reload schema';
