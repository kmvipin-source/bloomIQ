-- =============================================================================
-- 53_co_teacher_attempts_read.sql
-- -----------------------------------------------------------------------------
-- Co-teachers couldn't see attempts (or attempt_answers) on quizzes that were
-- assigned to a class they're on but owned by a different teacher.
--
-- Concretely: Mr. Raj is co-teacher on "Grade 7 - Biology B". Ms. Priya is
-- the primary, and she owns the Digestive System Quiz assigned to that
-- class. With pre-53 policies:
--   * "attempts quiz owner read" — passes only for Ms. Priya
--   * "attempts primary read"    — passes only for Ms. Priya (primary)
--   * No policy for co-teachers
-- Result: Mr. Raj's /teacher/reports filtered to Biology B showed 0 stats
-- because his query returned 0 attempt rows even though they exist.
--
-- Fix: add an RLS policy that lets ANY teacher on a class (primary or co)
-- read attempts on quizzes that were assigned to that class. We also mirror
-- the same policy onto attempt_answers so per-question/Bloom rollups work.
--
-- We use the existing public.is_class_teacher(cid) helper from migration 04
-- which checks auth.uid() against class_teachers (any role).
--
-- Additive — keeps the existing policies in place. SELECT is OR-merged across
-- all permissive policies, so adding this only opens reads, never closes them.
-- =============================================================================

drop policy if exists "attempts class co-teacher read" on public.quiz_attempts;
create policy "attempts class co-teacher read" on public.quiz_attempts
  for select using (
    exists (
      select 1
      from public.quiz_assignments qa
      where qa.quiz_id = quiz_attempts.quiz_id
        and qa.class_id is not null
        and public.is_class_teacher(qa.class_id)
    )
  );

drop policy if exists "ans class co-teacher read" on public.attempt_answers;
create policy "ans class co-teacher read" on public.attempt_answers
  for select using (
    exists (
      select 1
      from public.quiz_attempts a
      join public.quiz_assignments qa on qa.quiz_id = a.quiz_id
      where a.id = attempt_id
        and qa.class_id is not null
        and public.is_class_teacher(qa.class_id)
    )
  );

-- Reload the PostgREST schema cache so the next API call picks up the new
-- policy without a server restart.
notify pgrst, 'reload schema';
