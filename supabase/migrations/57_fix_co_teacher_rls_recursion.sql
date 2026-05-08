-- =============================================================================
-- 57_fix_co_teacher_rls_recursion.sql
-- -----------------------------------------------------------------------------
-- Migrations 53/55 (and the consolidated 56) installed permissive SELECT
-- policies on `quizzes`, `quiz_attempts`, and `attempt_answers` that
-- contained `EXISTS (SELECT FROM quiz_assignments ...)`. That subquery
-- triggers RLS on quiz_assignments, whose existing "assign owner all"
-- policy contains `EXISTS (SELECT FROM quizzes ...)`. Reading either
-- table from a co-teacher session fired the loop:
--
--     quizzes → quiz_assignments → quizzes → quiz_assignments → ...
--
-- Postgres detects this:
--     ERROR: 42P17: infinite recursion detected in policy for relation
--                   "quiz_assignments"
--
-- And the practical effect was that ALL three tables returned zero rows
-- to a co-teacher session — including their own owned data, because the
-- recursion error prevented any policy from evaluating successfully.
--
-- Fix: wrap the cross-table join in a SECURITY DEFINER helper. The inner
-- SELECTs in the helper run with the function owner's privileges, which
-- bypasses RLS — breaking the cycle. Same pattern migration 38 used for
-- is_quiz_assigned_to_me.
--
-- Three callers; one helper:
--   public.is_quiz_in_my_class(qid)  →  Used by all three rebuilt
--                                         policies. Returns true iff qid
--                                         is assigned to a class the
--                                         calling user (auth.uid()) is
--                                         on as primary or co.
--
-- The quiz_assignments policy already used is_class_teacher (SECURITY
-- DEFINER) and didn't recurse — left alone.
-- =============================================================================

begin;

create or replace function public.is_quiz_in_my_class(qid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.quiz_assignments qa
    join public.class_teachers ct on ct.class_id = qa.class_id
    where qa.quiz_id = qid
      and ct.teacher_id = auth.uid()
  );
$$;

drop policy if exists "quizzes class co-teacher read" on public.quizzes;
create policy "quizzes class co-teacher read" on public.quizzes
  for select using (public.is_quiz_in_my_class(id));

drop policy if exists "attempts class co-teacher read" on public.quiz_attempts;
create policy "attempts class co-teacher read" on public.quiz_attempts
  for select using (public.is_quiz_in_my_class(quiz_id));

drop policy if exists "ans class co-teacher read" on public.attempt_answers;
create policy "ans class co-teacher read" on public.attempt_answers
  for select using (
    exists (
      select 1
      from public.quiz_attempts a
      where a.id = attempt_id
        and public.is_quiz_in_my_class(a.quiz_id)
    )
  );

commit;

notify pgrst, 'reload schema';
