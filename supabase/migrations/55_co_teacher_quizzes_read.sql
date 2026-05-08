-- =============================================================================
-- 55_co_teacher_quizzes_read.sql
-- -----------------------------------------------------------------------------
-- Final piece in the co-teacher reporting fix trilogy (53 → 54 → 55).
-- The diagnostic showed Mr. Raj could now see:
--   * class_teachers rows for his classes (already worked)
--   * quiz_assignments for his classes (migration 54)
--   * quiz_attempts on those assignments' quizzes (migration 53)
--
-- But /teacher/reports STILL showed only 2 of his 4 in-scope quizzes —
-- because reading the quiz_attempts row is not enough; the page also
-- needs to read the quizzes table to display name, code, subject,
-- topic_family. The pre-55 quizzes RLS only allowed:
--   * "quizzes owner all"        — passes when auth.uid() owns the quiz
--   * "quizzes read for assigned" — passes via is_quiz_assigned_to_me,
--                                   which checks class MEMBERS (students)
--                                   only, not teachers.
--
-- So a co-teacher's GET on /quizzes returned only quizzes they personally
-- own, leaving Ms. Priya's Digestive / Respiratory rows invisible to
-- Mr. Raj even though he co-teaches the class they're assigned to.
--
-- Fix: add a permissive SELECT policy that lets ANY class teacher
-- (primary or co) read quizzes that are assigned to a class they teach.
-- Uses public.is_class_teacher (defined in migration 04, SECURITY DEFINER,
-- so no RLS recursion when it queries class_teachers internally).
--
-- Additive — keeps existing policies. Closes the last gap surfaced by
-- scripts/debug-mr-raj-reports.js.
-- =============================================================================

drop policy if exists "quizzes class co-teacher read" on public.quizzes;
create policy "quizzes class co-teacher read" on public.quizzes
  for select using (
    exists (
      select 1
      from public.quiz_assignments qa
      where qa.quiz_id = quizzes.id
        and qa.class_id is not null
        and public.is_class_teacher(qa.class_id)
    )
  );

notify pgrst, 'reload schema';
