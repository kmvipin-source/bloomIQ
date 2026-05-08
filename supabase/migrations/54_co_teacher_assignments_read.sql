-- =============================================================================
-- 54_co_teacher_assignments_read.sql
-- -----------------------------------------------------------------------------
-- Sibling fix to migration 53. The previous migration opened up reads on
-- quiz_attempts and attempt_answers for co-teachers of the target class.
-- But /teacher/reports also reads quiz_assignments to map class → quizzes,
-- and that table had a parallel hole:
--
--   * "assign owner all"      — passes when auth.uid() owns the quiz
--   * "assign primary read"   — passes when auth.uid() is the class primary
--   * No co-teacher path
--
-- Net result: Mr. Raj (co-teacher on Biology B) couldn't even SEE the
-- assignments linking Ms. Priya's quizzes to his class, so the loader
-- correctly fetched zero quizzes for the Biology B filter — independent
-- of migration 53's attempts-read fix.
--
-- Fix: add a permissive SELECT policy that lets ANY class teacher
-- (primary or co) read assignments targeting their class, mirroring the
-- shape of migration 53. Uses the existing public.is_class_teacher
-- helper from migration 04.
--
-- Additive — does not alter existing policies. Pairs with migration 53.
-- =============================================================================

drop policy if exists "assign class co-teacher read" on public.quiz_assignments;
create policy "assign class co-teacher read" on public.quiz_assignments
  for select using (
    class_id is not null and public.is_class_teacher(class_id)
  );

notify pgrst, 'reload schema';
